import { prisma } from '../lib/prisma';
import { runAttendanceAutoSubmitTick } from '../lib/attendance-auto-submit';
import { writeHeartbeat } from '../lib/attendance-scheduler-heartbeat';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §1-§6 — permanent scheduler
// process. Not the CLI one-shot `attendance-auto-submit-tick.ts` (T7A.10A, unchanged, still the
// entry point a future EXTERNAL scheduler could invoke) — this is a long-lived Node process meant
// to run forever inside its own Compose service (`scheduler`), calling the exact same
// runAttendanceAutoSubmitTick core on an interval. Never accepts `now`/`actorUserId` overrides from
// argv or env, at startup or per-tick — production always uses real system time; SYSTEM actor is
// resolved internally by the core (§13). No HTTP routes/servers of any kind.

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 3600;

function resolveIntervalSecondsOrExit(): number {
  const raw = process.env.ATTENDANCE_SCHEDULER_INTERVAL_SECONDS;
  if (raw === undefined || raw === '') {
    return DEFAULT_INTERVAL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_SECONDS || parsed > MAX_INTERVAL_SECONDS) {
    // Fail-fast, before any DB access — a configuration error, not a runtime/DB error. Never
    // silently clamped or defaulted (§2 of the addendum).
    process.stderr.write(
      `FATAL: ATTENDANCE_SCHEDULER_INTERVAL_SECONDS must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} (got: ${JSON.stringify(raw)}).\n`
    );
    process.exit(1);
  }
  return parsed;
}

function logSafe(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n');
}

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

// One tick cycle — never lets an exception (top-level DB failure, or any other bug) escape and
// crash the process. A per-candidate `failed` count inside a resolved result is an expected,
// retryable degradation of the tick itself, not a runner-level failure — the heartbeat still
// updates. A REJECTED runAttendanceAutoSubmitTick call (DB unreachable, etc.) does not update the
// heartbeat — that is what should eventually make the container unhealthy if it keeps happening,
// never masked as a successful tick (§6 of the addendum).
async function runOneTickSafely(): Promise<void> {
  const startedAt = new Date();
  const startTime = performance.now();
  try {
    const result = await runAttendanceAutoSubmitTick({ now: new Date() });
    const durationMs = Math.round(performance.now() - startTime);
    await writeHeartbeat(startedAt);
    logSafe({
      event: 'attendance_auto_submit_tick',
      startedAt: startedAt.toISOString(),
      durationMs,
      runnerOutcome: 'ok',
      scanned: result.scanned,
      due: result.due,
      submittedClean: result.submittedClean,
      submittedWithExceptions: result.submittedWithExceptions,
      skippedAlreadySubmitted: result.skippedAlreadySubmitted,
      skippedNotActionable: result.skippedNotActionable,
      noop: result.noop,
      failed: result.failed
    });
  } catch {
    // Never logs the raw Error/message/stack — it may contain DB connection details or SQL
    // fragments. A single stable code is enough for operators to know a tick failed at the top
    // level; real diagnosis happens by inspecting the database/infra directly, not by leaking
    // arbitrary error content into logs.
    const durationMs = Math.round(performance.now() - startTime);
    logSafe({
      event: 'attendance_auto_submit_tick',
      startedAt: startedAt.toISOString(),
      durationMs,
      runnerOutcome: 'top_level_error',
      errorCode: 'SCHEDULER_TICK_TOP_LEVEL_ERROR'
    });
  }
}

async function main(): Promise<void> {
  const intervalSeconds = resolveIntervalSecondsOrExit();
  const intervalMs = intervalSeconds * 1000;
  logSafe({ event: 'attendance_scheduler_started', intervalSeconds });

  while (!shuttingDown) {
    await runOneTickSafely();
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
    // Should be unreachable — runOneTickSafely never throws and main()'s own control flow has no
    // other awaited call that can reject. If it ever happens anyway, this is a genuine programming
    // error, not a tick/DB failure — exit non-zero rather than looping on a broken process.
    process.stderr.write('FATAL: attendance scheduler crashed outside the tick loop.\n');
    process.exit(1);
  });
}
