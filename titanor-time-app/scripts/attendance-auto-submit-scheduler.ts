import { prisma } from '../lib/prisma';
import { runAttendanceAutoSubmitTick } from '../lib/attendance-auto-submit';
import { runAbandonedShiftAutoCloseTick } from '../lib/attendance-abandoned-shift';
import { runAttendanceLocationRetention } from '../lib/attendance-location-retention';
import {
  newHeartbeat,
  writeHeartbeatRecord,
  type HeartbeatContent,
  type TickOutcomeCategory
} from '../lib/attendance-scheduler-heartbeat';
import { resolveIntervalSecondsOrExit, sleep, logSafe, runOneTickCore, maybeRunRetentionCore } from '../lib/attendance-scheduler-runtime';
import { ensureSubmissionScheduleHorizon } from '../lib/timesheet-submission-schedules';
import { checkSchemaReadiness } from '../lib/schema-readiness';
import { acquireOrRenewLease, releaseLease, newHolderId } from '../lib/scheduler-lease';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B"/"T7A.10C.1" + R06-A.
// Permanent scheduler process. One immutable image, run with a different command from the web
// container. Never accepts `now`/`actorUserId` overrides. No HTTP routes/servers.
//
// R06-A adds: a startup schema-compatibility check, an enriched heartbeat (so the Docker
// healthcheck can distinguish healthy / stale / db-down / schema-mismatch / tick-failing /
// overlapping / process-stopped), and a single-writer lease that makes a second scheduler
// container skip its work instead of double-running ticks.

const PROCESS_STARTED_AT = new Date();
const HOLDER_ID = newHolderId();

let heartbeat: HeartbeatContent = newHeartbeat(process.pid, PROCESS_STARTED_AT);

let shuttingDown = false;
const shutdownController = new AbortController();

function requestShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logSafe({ event: 'attendance_scheduler_shutdown_requested', signal });
  shutdownController.abort();
}
process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

async function persistHeartbeat(): Promise<void> {
  try {
    await writeHeartbeatRecord(heartbeat);
  } catch {
    logSafe({ event: 'attendance_scheduler_heartbeat_write_failed', errorCode: 'HEARTBEAT_WRITE_FAILED' });
  }
}

function recordTick(outcome: TickOutcomeCategory, errorCode: string | null): void {
  const at = new Date().toISOString();
  heartbeat.lastTickAt = at;
  heartbeat.lastOutcome = outcome;
  heartbeat.lastErrorCode = errorCode;
  if (outcome === 'ok') {
    heartbeat.lastTickCompletedAt = at;
    heartbeat.consecutiveFailures = 0;
  } else {
    heartbeat.consecutiveFailures += 1;
  }
}

async function main(): Promise<void> {
  const intervalSeconds = resolveIntervalSecondsOrExit();
  const intervalMs = intervalSeconds * 1000;
  logSafe({ event: 'attendance_scheduler_started', intervalSeconds, holderId: HOLDER_ID });

  // Fast, explicit signal at startup — do not wait for the first tick to fail to learn the schema
  // is wrong. Not fatal: keep the loop running so the healthcheck surfaces the state; a fixed DB
  // (e.g. migrations applied by a rolling deploy) is picked up on the next iteration.
  // checkSchemaReadiness() handles all its own errors and always resolves to a SchemaReadiness.
  const startupSchema = await checkSchemaReadiness();
  if (!startupSchema.ok) {
    const category: TickOutcomeCategory = startupSchema.reason === 'DB_UNAVAILABLE' ? 'db_unavailable' : 'schema_incompatible';
    recordTick(category, `SCHEDULER_STARTUP_${startupSchema.reason}`);
    logSafe({ event: 'attendance_scheduler_schema_check', outcome: 'incompatible', reason: startupSchema.reason });
  } else {
    logSafe({ event: 'attendance_scheduler_schema_check', outcome: 'ok', schema: startupSchema.state });
  }
  await persistHeartbeat();

  let lastRetentionSuccessAt: Date | null = null;
  let lastPeriodGenerationSuccessAt: Date | null = null;

  while (!shuttingDown) {
    // Single-writer guard — another live scheduler holding the lease means we skip this iteration's
    // work rather than double-running the ticks.
    let leaseHeld = false;
    try {
      const lease = await acquireOrRenewLease(HOLDER_ID);
      leaseHeld = lease !== 'held_by_another';
      if (!leaseHeld) {
        heartbeat.lastOverlapAt = new Date().toISOString();
        logSafe({ event: 'attendance_scheduler_overlap', outcome: 'skipped', errorCode: 'SCHEDULER_LEASE_HELD_BY_ANOTHER' });
        await persistHeartbeat();
      }
    } catch {
      // The lease query itself failed — treat like a DB problem for this iteration.
      recordTick('db_unavailable', 'SCHEDULER_LEASE_QUERY_FAILED');
      await persistHeartbeat();
    }

    if (leaseHeld) {
      const tickOutcome = await runOneTickCore((now) => runAttendanceAutoSubmitTick({ now }), logSafe);
      if (tickOutcome.kind === 'ok') {
        recordTick('ok', null);
      } else {
        const category: TickOutcomeCategory =
          tickOutcome.errorClass === 'db_unavailable' ? 'db_unavailable'
          : tickOutcome.errorClass === 'schema_incompatible' ? 'schema_incompatible'
          : 'tick_error';
        recordTick(category, 'SCHEDULER_TICK_TOP_LEVEL_ERROR');
      }
      await persistHeartbeat();

      if (!shuttingDown) {
        try {
          const closeResult = await runAbandonedShiftAutoCloseTick({ now: new Date() });
          logSafe({ event: 'abandoned_shift_auto_close', outcome: 'ok', scanned: closeResult.scanned, closed: closeResult.closed, closedFromTemplate: closeResult.closedFromTemplate, closedFromFallback: closeResult.closedFromFallback, skipped: closeResult.skippedNoLongerEligible, failed: closeResult.failed });
        } catch {
          logSafe({ event: 'abandoned_shift_auto_close', outcome: 'top_level_error', errorCode: 'ABANDONED_SHIFT_AUTO_CLOSE_TOP_LEVEL_ERROR' });
        }
      }

      if (!shuttingDown) {
        const retentionStep = await maybeRunRetentionCore(lastRetentionSuccessAt, new Date(), runAttendanceLocationRetention, logSafe);
        lastRetentionSuccessAt = retentionStep.lastSuccessAt;
      }

      if (!shuttingDown) {
        const generationNow = new Date();
        if (lastPeriodGenerationSuccessAt === null || generationNow.getTime() - lastPeriodGenerationSuccessAt.getTime() >= 6 * 60 * 60 * 1000) {
          try {
            const result = await ensureSubmissionScheduleHorizon(generationNow);
            lastPeriodGenerationSuccessAt = new Date();
            logSafe({ event: 'timesheet_period_generation', outcome: 'ok', ...result });
          } catch {
            logSafe({ event: 'timesheet_period_generation', outcome: 'top_level_error', errorCode: 'PERIOD_GENERATION_TOP_LEVEL_ERROR' });
          }
        }
      }
    }

    if (shuttingDown) break;
    await sleep(intervalMs, shutdownController.signal);
  }

  await releaseLease(HOLDER_ID).catch(() => undefined);
  await prisma.$disconnect();
  logSafe({ event: 'attendance_scheduler_stopped' });
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('FATAL: attendance scheduler crashed outside the tick loop.\n');
    process.exit(1);
  });
}
