import type { AttendanceAutoSubmitTickResult } from '@/lib/attendance-auto-submit';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §1-§6, follow-up (2026-08-18)
// — the scheduler's lifecycle primitives (interval parsing, abort-aware sleep, one-tick execution)
// extracted out of scripts/attendance-auto-submit-scheduler.ts so they are directly unit-testable
// (fast, in-process, dependency-injected fakes) without spawning a real long-lived process or
// waiting out real 30–3600s production intervals. sleep() itself has no hardcoded bound — it is a
// generic ms/AbortSignal primitive; only resolveIntervalSecondsOrExit() below enforces the
// production 30–3600s range, and that enforcement is unchanged and untouched by this refactor.

export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 3600;

export function resolveIntervalSecondsOrExit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ATTENDANCE_SCHEDULER_INTERVAL_SECONDS;
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

export function logSafe(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n');
}

/**
 * Follow-up fix — the previous version registered an `abort` listener on every call but only ever
 * removed it via `{ once: true }`, which only fires (and thus only unregisters) when abort actually
 * happens. On the far more common normal-timeout path, the listener was never removed — on the
 * scheduler's one long-lived AbortSignal (one per process, reused for every sleep call across the
 * whole process lifetime), this leaked one listener per tick interval, eventually tripping Node's
 * MaxListenersExceededWarning. Both exit paths now explicitly leave zero listeners behind: the
 * timer path removes its own abort listener before resolving; the abort path's listener removes
 * itself via `{ once: true }` (kept as defense in depth, not the sole cleanup mechanism anymore).
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type TickOutcome = { kind: 'ok'; durationMs: number; result: AttendanceAutoSubmitTickResult } | { kind: 'top_level_error'; durationMs: number };

/**
 * One tick cycle, dependency-injected so it is testable without a real database or a real 30s+
 * wait. Never lets an exception escape — a per-candidate `failed` count inside a resolved result is
 * an expected, retryable degradation of the tick itself, not a runner-level failure (heartbeat
 * still updates); a REJECTED tick call does not update the heartbeat at all — that is what should
 * eventually make the container unhealthy if it keeps happening, never masked as a successful tick.
 *
 * Follow-up fix — completedAt (used for the heartbeat) is captured only AFTER the tick call
 * genuinely resolves, never before it starts and never on the rejected path. The previous version
 * passed the tick's *start* time to writeHeartbeat, so lastTickCompletedAt silently meant "started
 * at" instead of "completed at" — for any tick slower than the health-stale window, this produced a
 * false-unhealthy reading immediately after a fully successful completion. startedAt is still used
 * for the structured log's own `startedAt` field (which is genuinely about when the tick began) and
 * for computing durationMs — only the heartbeat's own timestamp changes.
 */
export async function runOneTickCore(
  tick: (now: Date) => Promise<AttendanceAutoSubmitTickResult>,
  writeHeartbeat: (completedAt: Date) => Promise<void>,
  log: (fields: Record<string, unknown>) => void
): Promise<TickOutcome> {
  const startedAt = new Date();
  const startTime = performance.now();
  try {
    const result = await tick(new Date());
    const completedAt = new Date();
    const durationMs = Math.round(performance.now() - startTime);
    await writeHeartbeat(completedAt);
    log({
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
    return { kind: 'ok', durationMs, result };
  } catch {
    // Never logs the raw Error/message/stack — it may contain DB connection details or SQL
    // fragments. A single stable code is enough for operators to know a tick failed at the top
    // level; real diagnosis happens by inspecting the database/infra directly, not by leaking
    // arbitrary error content into logs.
    const durationMs = Math.round(performance.now() - startTime);
    log({
      event: 'attendance_auto_submit_tick',
      startedAt: startedAt.toISOString(),
      durationMs,
      runnerOutcome: 'top_level_error',
      errorCode: 'SCHEDULER_TICK_TOP_LEVEL_ERROR'
    });
    return { kind: 'top_level_error', durationMs };
  }
}

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §B — raw GPS retention
// pacing, run from the SAME scheduler loop as the auto-submit tick, one independent try/catch'd
// step per iteration, never sharing a transaction or blocking with the tick step.

export const RETENTION_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RetentionOutcome = { kind: 'ran_ok'; deletedCount: number } | { kind: 'ran_error' } | { kind: 'skipped' };

export interface RetentionStepResult {
  outcome: RetentionOutcome;
  lastSuccessAt: Date | null;
}

/**
 * `lastSuccessAt` starts `null` in the caller (one variable per process, never persisted) — so the
 * very first scheduler loop iteration (the same one that already runs the immediate first
 * auto-submit tick) also attempts retention, satisfying "first pass right after scheduler start"
 * with no separate startup-only code path. A successful pass gates the next attempt to 24h later; a
 * failed pass leaves it unchanged, so the very next loop iteration (not 24h later) retries — never
 * logs the raw Error, only a stable error code.
 *
 * T7A.10C.1 FOLLOW-UP — `lastSuccessAt` is now set from a timestamp captured AFTER `runRetention()`
 * resolves, never the pre-call `now` used for the due-check. The previous version paced the 24h
 * gate from "when this pass started," so a long-running pass let the next pass start early relative
 * to actual completion — the exact class of bug `runOneTickCore` above already fixed once for the
 * heartbeat; this was the one remaining unfixed instance of it. `getNow` defaults to the real clock
 * (`new Date`) and is only ever overridden by tests — production behavior is unchanged in the common
 * case where `runRetention()` is fast, and correct instead of merely-usually-correct when it isn't.
 */
export async function maybeRunRetentionCore(
  lastSuccessAt: Date | null,
  now: Date,
  runRetention: () => Promise<{ deletedCount: number }>,
  log: (fields: Record<string, unknown>) => void,
  getNow: () => Date = () => new Date()
): Promise<RetentionStepResult> {
  const due = lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() >= RETENTION_MIN_INTERVAL_MS;
  if (!due) {
    return { outcome: { kind: 'skipped' }, lastSuccessAt };
  }
  try {
    const result = await runRetention();
    const completedAt = getNow();
    log({ event: 'attendance_location_retention', retentionRan: true, retentionOutcome: 'ok', retentionDeleted: result.deletedCount });
    return { outcome: { kind: 'ran_ok', deletedCount: result.deletedCount }, lastSuccessAt: completedAt };
  } catch {
    // Never logs the raw Error/message/stack — same PII/secret-leak reasoning as runOneTickCore's
    // own top-level-error branch above.
    log({ event: 'attendance_location_retention', retentionRan: true, retentionOutcome: 'top_level_error', errorCode: 'RETENTION_TOP_LEVEL_ERROR' });
    return { outcome: { kind: 'ran_error' }, lastSuccessAt };
  }
}
