import { writeFile, readFile } from 'node:fs/promises';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §6 + R06-A — a tiny, PII-free
// on-disk heartbeat shared between scripts/attendance-auto-submit-scheduler.ts (writer) and
// scripts/attendance-scheduler-healthcheck.ts (reader), so Docker's healthcheck never needs an HTTP
// server or a database connection of its own. Path is overridable only for test isolation.
//
// R06-A enriches the record so the healthcheck can distinguish healthy / stale / db-unavailable /
// schema-incompatible / tick-failing / overlapping / process-stopped instead of a single 0-or-1.
// `lastTickCompletedAt` is kept for backward compatibility (older monitoring reads it).

export const DEFAULT_HEARTBEAT_PATH = '/tmp/attendance-scheduler-heartbeat.json';

export function heartbeatPath(): string {
  return process.env.ATTENDANCE_SCHEDULER_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH;
}

export type TickOutcomeCategory = 'ok' | 'tick_error' | 'db_unavailable' | 'schema_incompatible';

export interface HeartbeatContent {
  /** Heartbeat record format version — bump on any breaking shape change. */
  format: 2;
  /** OS pid of the scheduler process that wrote this — lets the healthcheck notice a dead writer. */
  pid: number;
  /** When the scheduler process started (ISO). */
  processStartedAt: string;
  /** ISO of the last COMPLETED (successful) tick. Kept for backward compatibility. */
  lastTickCompletedAt: string | null;
  /** ISO of the last tick attempt (success or failure). */
  lastTickAt: string | null;
  /** Outcome of the last tick attempt. */
  lastOutcome: TickOutcomeCategory | null;
  /** Stable code for the last non-ok tick (never the raw error). */
  lastErrorCode: string | null;
  /** Consecutive non-ok ticks (reset to 0 on a successful tick). */
  consecutiveFailures: number;
  /** ISO of the last time this process skipped its work because another scheduler holds the lease. */
  lastOverlapAt: string | null;
}

export function newHeartbeat(pid: number, processStartedAt: Date): HeartbeatContent {
  return {
    format: 2,
    pid,
    processStartedAt: processStartedAt.toISOString(),
    lastTickCompletedAt: null,
    lastTickAt: null,
    lastOutcome: null,
    lastErrorCode: null,
    consecutiveFailures: 0,
    lastOverlapAt: null
  };
}

export async function writeHeartbeatRecord(record: HeartbeatContent): Promise<void> {
  await writeFile(heartbeatPath(), JSON.stringify(record), 'utf8');
}

export async function readHeartbeatRecord(): Promise<HeartbeatContent | null> {
  try {
    const raw = await readFile(heartbeatPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<HeartbeatContent> & { lastTickCompletedAt?: unknown };
    if (parsed && parsed.format === 2 && typeof parsed.pid === 'number') {
      return parsed as HeartbeatContent;
    }
    // Older format-1 record ({ lastTickCompletedAt }) — accept it degraded so a rolling deploy
    // doesn't make the healthcheck blind for one interval.
    if (parsed && typeof parsed.lastTickCompletedAt === 'string') {
      return {
        ...newHeartbeat(0, new Date(0)),
        lastTickCompletedAt: parsed.lastTickCompletedAt,
        lastTickAt: parsed.lastTickCompletedAt,
        lastOutcome: 'ok'
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Back-compat shims — the pre-R06-A API. Still used by the unit-tested runtime primitives; they
// now update the format-2 record in place.
// ---------------------------------------------------------------------------------------------

export interface LegacyHeartbeatContent {
  lastTickCompletedAt: string;
}

/** @deprecated pre-R06-A shape. */
export async function writeHeartbeat(completedAt: Date): Promise<void> {
  const existing = (await readHeartbeatRecord()) ?? newHeartbeat(process.pid, new Date());
  await writeHeartbeatRecord({
    ...existing,
    lastTickCompletedAt: completedAt.toISOString(),
    lastTickAt: completedAt.toISOString(),
    lastOutcome: 'ok',
    lastErrorCode: null,
    consecutiveFailures: 0
  });
}

/** @deprecated pre-R06-A shape. */
export async function readHeartbeat(): Promise<LegacyHeartbeatContent | null> {
  const record = await readHeartbeatRecord();
  return record?.lastTickCompletedAt ? { lastTickCompletedAt: record.lastTickCompletedAt } : null;
}
