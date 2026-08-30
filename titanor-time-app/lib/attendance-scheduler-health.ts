import type { HeartbeatContent } from '@/lib/attendance-scheduler-heartbeat';

// R06-A — classify the scheduler's health from its heartbeat record. Pure and dependency-injected
// so it is unit-testable without a real process, file, or database. The healthcheck script
// (scripts/attendance-scheduler-healthcheck.ts) is a thin wrapper: read heartbeat + probe the
// recorded pid, call this, print the state, exit 0 (healthy) or 1 (unhealthy).

export type SchedulerHealthState =
  | 'HEALTHY'
  | 'STARTING' // process just started, no tick completed yet, still inside the grace window
  | 'HEARTBEAT_MISSING' // no heartbeat file at all, and past the grace window
  | 'HEARTBEAT_STALE' // last tick was ok but too long ago — process stuck or died
  | 'PROCESS_STOPPED' // heartbeat names a pid that is no longer alive
  | 'DB_UNAVAILABLE' // last tick failed because the database was unreachable
  | 'SCHEMA_INCOMPATIBLE' // last tick failed because the DB schema is not what this build expects
  | 'TICK_FAILING' // ticks are running but keep erroring (>= failureThreshold in a row)
  | 'OVERLAPPING'; // another scheduler holds the lease — this process only ever skips its work

export interface SchedulerHealthInput {
  heartbeat: HeartbeatContent | null;
  now: Date;
  intervalSeconds: number;
  /** heartbeat is "stale" once older than intervalSeconds * staleMultiplier (min staleFloorSeconds). */
  staleMultiplier: number;
  staleFloorSeconds: number;
  /** consecutive tick errors that flip TICK_FAILING. */
  failureThreshold: number;
  /** grace after processStartedAt during which "no completed tick yet" is STARTING, not unhealthy. */
  startupGraceSeconds: number;
  /** true if the pid in the heartbeat is alive (healthcheck runs `process.kill(pid, 0)`); undefined = not checked. */
  pidAlive?: boolean;
}

export interface SchedulerHealthResult {
  state: SchedulerHealthState;
  healthy: boolean;
  /** Age of the last tick attempt in seconds, when known. */
  lastTickAgeSeconds: number | null;
}

const HEALTHY_STATES: ReadonlySet<SchedulerHealthState> = new Set(['HEALTHY', 'STARTING']);

export function classifySchedulerHealth(input: SchedulerHealthInput): SchedulerHealthResult {
  const { heartbeat, now } = input;
  const nowMs = now.getTime();

  if (!heartbeat) {
    return { state: 'HEARTBEAT_MISSING', healthy: false, lastTickAgeSeconds: null };
  }

  // Writer process gone.
  if (input.pidAlive === false && heartbeat.pid > 0) {
    return { state: 'PROCESS_STOPPED', healthy: false, lastTickAgeSeconds: null };
  }

  const staleAfterMs = Math.max(input.intervalSeconds * input.staleMultiplier, input.staleFloorSeconds) * 1000;
  const graceMs = input.startupGraceSeconds * 1000;

  const processAgeMs = heartbeat.processStartedAt ? nowMs - new Date(heartbeat.processStartedAt).getTime() : Number.POSITIVE_INFINITY;
  const lastTickAgeMs = heartbeat.lastTickAt ? nowMs - new Date(heartbeat.lastTickAt).getTime() : null;
  const lastTickAgeSeconds = lastTickAgeMs === null ? null : Math.round(lastTickAgeMs / 1000);

  // Never completed a tick.
  if (!heartbeat.lastTickAt || heartbeat.lastOutcome === null) {
    if (processAgeMs <= graceMs) {
      return { state: 'STARTING', healthy: true, lastTickAgeSeconds };
    }
    return { state: 'HEARTBEAT_STALE', healthy: false, lastTickAgeSeconds };
  }

  // A very recent overlap skip with no successful tick since — a second scheduler is running.
  if (heartbeat.lastOverlapAt) {
    const overlapAgeMs = nowMs - new Date(heartbeat.lastOverlapAt).getTime();
    const lastOkMs = heartbeat.lastTickCompletedAt ? nowMs - new Date(heartbeat.lastTickCompletedAt).getTime() : Number.POSITIVE_INFINITY;
    if (overlapAgeMs <= staleAfterMs && overlapAgeMs < lastOkMs) {
      return { state: 'OVERLAPPING', healthy: false, lastTickAgeSeconds };
    }
  }

  // Last tick outcome drives the classification.
  switch (heartbeat.lastOutcome) {
    case 'db_unavailable':
      return { state: 'DB_UNAVAILABLE', healthy: false, lastTickAgeSeconds };
    case 'schema_incompatible':
      return { state: 'SCHEMA_INCOMPATIBLE', healthy: false, lastTickAgeSeconds };
    case 'tick_error':
      if (heartbeat.consecutiveFailures >= input.failureThreshold) {
        return { state: 'TICK_FAILING', healthy: false, lastTickAgeSeconds };
      }
      // A single transient error — only unhealthy once it also goes stale.
      if (lastTickAgeMs !== null && lastTickAgeMs > staleAfterMs) {
        return { state: 'HEARTBEAT_STALE', healthy: false, lastTickAgeSeconds };
      }
      return { state: 'HEALTHY', healthy: true, lastTickAgeSeconds };
    case 'ok':
    default:
      if (lastTickAgeMs !== null && lastTickAgeMs > staleAfterMs) {
        return { state: 'HEARTBEAT_STALE', healthy: false, lastTickAgeSeconds };
      }
      return { state: 'HEALTHY', healthy: true, lastTickAgeSeconds };
  }
}

export function isHealthy(state: SchedulerHealthState): boolean {
  return HEALTHY_STATES.has(state);
}
