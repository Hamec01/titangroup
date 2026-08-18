import { prisma } from '../lib/prisma';
import { runAttendanceAutoSubmitTick } from '../lib/attendance-auto-submit';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10A" §E — one-shot CLI, runs
// exactly one tick and exits. No cron/systemd/Compose scheduler wiring in this slice (T7A.10B) —
// this is the entry point a future scheduler would invoke, unchanged.
//
// Never accepts actorUserId, DATABASE_URL, or a `now` override from argv/env — production always
// uses real system time; SYSTEM actor is resolved internally (§13); DATABASE_URL is read the same
// way Prisma always reads it (process.env, no CLI flag). stdout prints only the aggregated counts
// below — never employee names, UUIDs, GPS, payload, cookies, or secrets.

async function main(): Promise<void> {
  const result = await runAttendanceAutoSubmitTick({ now: new Date() });
  console.log(
    JSON.stringify(
      {
        scanned: result.scanned,
        due: result.due,
        submittedClean: result.submittedClean,
        submittedWithExceptions: result.submittedWithExceptions,
        skippedAlreadySubmitted: result.skippedAlreadySubmitted,
        skippedNotActionable: result.skippedNotActionable,
        noop: result.noop,
        failed: result.failed
      },
      null,
      2
    )
  );
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

// Only run as a side effect when executed directly (`npm run attendance:auto-submit` /
// `tsx scripts/attendance-auto-submit-tick.ts`) — never as a side effect of importing this file.
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error('Auto-submit tick failed to run.');
      process.exitCode = 1;
      void error; // never printed — stdout/stderr PII contract (§E); the real detail stays server-side only for now.
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
