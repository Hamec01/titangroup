import { maybeRunRetentionCore, RETENTION_MIN_INTERVAL_MS } from '../lib/attendance-scheduler-runtime';

// T7A.10C.1 FOLLOW-UP §4 — proves maybeRunRetentionCore now paces the 24h gate from the actual
// completion time of a successful pass, not from the pre-call `now` used for the due-check. Pure
// function, no DB/browser — plain assertions, tsx-run, not a persistent framework.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
}

const noopLog = () => {};

async function main() {
  const T0 = new Date('2026-01-01T00:00:00.000Z');
  const completedAt = new Date(T0.getTime() + 10 * 60 * 1000); // T0 + 10m
  let getNowCallCount = 0;

  // First pass: due (lastSuccessAt=null), long-running (simulated by returning a distinct
  // getNow() value from the pre-call `now`), succeeds.
  const first = await maybeRunRetentionCore(
    null,
    T0,
    async () => ({ deletedCount: 3 }),
    noopLog,
    () => {
      getNowCallCount++;
      return completedAt;
    }
  );
  assert(first.outcome.kind === 'ran_ok', 'first pass should run (lastSuccessAt was null)');
  assert(getNowCallCount === 1, 'getNow should be called exactly once, after runRetention resolves');
  assert(first.lastSuccessAt !== null && first.lastSuccessAt.getTime() === completedAt.getTime(), `lastSuccessAt must be the post-completion timestamp (T0+10m), not T0 — got ${first.lastSuccessAt?.toISOString()}`);

  const lastSuccessAt = first.lastSuccessAt as Date;

  // T0 + 24h - 1s: trivially not due under any interpretation.
  const justUnder24hFromStart = new Date(T0.getTime() + RETENTION_MIN_INTERVAL_MS - 1000);
  const stillSkippedTrivial = await maybeRunRetentionCore(lastSuccessAt, justUnder24hFromStart, async () => ({ deletedCount: 0 }), noopLog);
  assert(stillSkippedTrivial.outcome.kind === 'skipped', 'T0+24h-1s must still be skipped');

  // Discriminating boundary: completedAt + 24h - 1s. Under the OLD (buggy) pacing-from-start
  // behavior this would already be due (T0+24h was already due 9m59s earlier) — under the FIXED
  // completion-time pacing it must still be skipped, since only 23h59m59s have passed since the
  // real completion at T0+10m.
  const justUnder24hFromCompletion = new Date(completedAt.getTime() + RETENTION_MIN_INTERVAL_MS - 1000);
  const stillSkippedDiscriminating = await maybeRunRetentionCore(lastSuccessAt, justUnder24hFromCompletion, async () => ({ deletedCount: 0 }), noopLog);
  assert(
    stillSkippedDiscriminating.outcome.kind === 'skipped',
    `completion+24h-1s must still be skipped (proves pacing is from completion T0+10m, not start T0) — got ${stillSkippedDiscriminating.outcome.kind}`
  );

  // Exactly completion + 24h: due.
  const exactly24hFromCompletion = new Date(completedAt.getTime() + RETENTION_MIN_INTERVAL_MS);
  const dueNow = await maybeRunRetentionCore(lastSuccessAt, exactly24hFromCompletion, async () => ({ deletedCount: 5 }), noopLog);
  assert(dueNow.outcome.kind === 'ran_ok', 'completion+24h must be due');

  // Failed pass never advances lastSuccessAt.
  const failing = await maybeRunRetentionCore(lastSuccessAt, exactly24hFromCompletion, async () => {
    throw new Error('simulated DB failure');
  }, noopLog);
  assert(failing.outcome.kind === 'ran_error', 'thrown runRetention must surface as ran_error');
  assert(failing.lastSuccessAt !== null && failing.lastSuccessAt.getTime() === lastSuccessAt.getTime(), 'failed pass must not change lastSuccessAt');

  // Default getNow (no override) uses the real clock and does not throw.
  const realClockPass = await maybeRunRetentionCore(null, new Date(), async () => ({ deletedCount: 0 }), noopLog);
  assert(realClockPass.outcome.kind === 'ran_ok' && realClockPass.lastSuccessAt !== null, 'default getNow must work without an override');

  console.log('PASS: retention completion-time pacing (5/5 assertions groups).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
