import { prisma } from '../lib/prisma';
import { runAttendanceAutoSubmitTick } from '../lib/attendance-auto-submit';
import { runAbandonedShiftAutoCloseTick } from '../lib/attendance-abandoned-shift';
import { runAttendanceLocationRetention } from '../lib/attendance-location-retention';
import { writeHeartbeat } from '../lib/attendance-scheduler-heartbeat';
import { resolveIntervalSecondsOrExit, sleep, logSafe, runOneTickCore, maybeRunRetentionCore } from '../lib/attendance-scheduler-runtime';
import { ensureSubmissionScheduleHorizon } from '../lib/timesheet-submission-schedules';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §1-§6 + "T7A.10C.1" §B —
// permanent scheduler process. Not the CLI one-shot `attendance-auto-submit-tick.ts` (T7A.10A,
// unchanged, still the entry point a future EXTERNAL scheduler could invoke) — this is a
// long-lived Node process meant to run forever inside its own Compose service (`scheduler`),
// calling the exact same runAttendanceAutoSubmitTick core on an interval, plus (T7A.10C.1) a
// once-per-24h raw GPS retention pass in the same loop. Never accepts `now`/`actorUserId`
// overrides from argv or env, at startup or per-tick — production always uses real system time;
// SYSTEM actor is resolved internally by the core (§13). No HTTP routes/servers of any kind.
//
// This file is now a thin wiring layer — the actual lifecycle primitives (interval parsing,
// abort-aware sleep, one-tick execution/heartbeat/logging, retention pacing) live in
// lib/attendance-scheduler-runtime.ts, where they are directly unit-testable without a real
// database or a real 30s+/24h wait.

let shuttingDown = false;
const shutdownController = new AbortController();

function requestShutdown(signal: string): void {
  if (shuttingDown) {
    return; // idempotent — a second signal during an already-in-progress shutdown is a no-op.
  }
  shuttingDown = true;
  logSafe({ event: 'attendance_scheduler_shutdown_requested', signal });
  shutdownController.abort();
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

async function main(): Promise<void> {
  const intervalSeconds = resolveIntervalSecondsOrExit();
  const intervalMs = intervalSeconds * 1000;
  logSafe({ event: 'attendance_scheduler_started', intervalSeconds });

  let lastRetentionSuccessAt: Date | null = null;
  let lastPeriodGenerationSuccessAt: Date | null = null;

  while (!shuttingDown) {
    await runOneTickCore((now) => runAttendanceAutoSubmitTick({ now }), writeHeartbeat, logSafe);
    if (shuttingDown) {
      break;
    }

    // Auto-close abandoned shifts — one independent try/catch'd step per iteration, never sharing a
    // transaction with the auto-submit tick. Never logs the raw Error (same PII/secret reasoning).
    try {
      const closeResult = await runAbandonedShiftAutoCloseTick({ now: new Date() });
      logSafe({ event: 'abandoned_shift_auto_close', outcome: 'ok', scanned: closeResult.scanned, closed: closeResult.closed, closedFromTemplate: closeResult.closedFromTemplate, closedFromFallback: closeResult.closedFromFallback, skipped: closeResult.skippedNoLongerEligible, failed: closeResult.failed });
    } catch {
      logSafe({ event: 'abandoned_shift_auto_close', outcome: 'top_level_error', errorCode: 'ABANDONED_SHIFT_AUTO_CLOSE_TOP_LEVEL_ERROR' });
    }
    if (shuttingDown) {
      break;
    }

    const retentionStep = await maybeRunRetentionCore(lastRetentionSuccessAt, new Date(), runAttendanceLocationRetention, logSafe);
    lastRetentionSuccessAt = retentionStep.lastSuccessAt;
    if (shuttingDown) {
      break;
    }

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
    if (shuttingDown) {
      break;
    }

    await sleep(intervalMs, shutdownController.signal);
  }

  await prisma.$disconnect();
  logSafe({ event: 'attendance_scheduler_stopped' });
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => {
    // Should be unreachable — runOneTickCore never throws and main()'s own control flow has no
    // other awaited call that can reject. If it ever happens anyway, this is a genuine programming
    // error, not a tick/DB failure — exit non-zero rather than looping on a broken process.
    process.stderr.write('FATAL: attendance scheduler crashed outside the tick loop.\n');
    process.exit(1);
  });
}
