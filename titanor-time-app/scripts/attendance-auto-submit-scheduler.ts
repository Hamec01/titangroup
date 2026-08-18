import { prisma } from '../lib/prisma';
import { runAttendanceAutoSubmitTick } from '../lib/attendance-auto-submit';
import { runAttendanceLocationRetention } from '../lib/attendance-location-retention';
import { writeHeartbeat } from '../lib/attendance-scheduler-heartbeat';
import { resolveIntervalSecondsOrExit, sleep, logSafe, runOneTickCore, maybeRunRetentionCore } from '../lib/attendance-scheduler-runtime';

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

  while (!shuttingDown) {
    await runOneTickCore((now) => runAttendanceAutoSubmitTick({ now }), writeHeartbeat, logSafe);
    if (shuttingDown) {
      break;
    }

    const retentionStep = await maybeRunRetentionCore(lastRetentionSuccessAt, new Date(), runAttendanceLocationRetention, logSafe);
    lastRetentionSuccessAt = retentionStep.lastSuccessAt;
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
