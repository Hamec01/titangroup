import { writeFile, readFile } from 'node:fs/promises';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §6 — a tiny, PII-free
// on-disk heartbeat shared between scripts/attendance-auto-submit-scheduler.ts (writer) and
// scripts/attendance-scheduler-healthcheck.ts (reader), so Docker's healthcheck never needs an HTTP
// server. Path is overridable only for test isolation — never a production-facing knob, never
// affects tick behavior.

export const DEFAULT_HEARTBEAT_PATH = '/tmp/attendance-scheduler-heartbeat.json';

export function heartbeatPath(): string {
  return process.env.ATTENDANCE_SCHEDULER_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH;
}

export interface HeartbeatContent {
  lastTickCompletedAt: string;
}

export async function writeHeartbeat(completedAt: Date): Promise<void> {
  const content: HeartbeatContent = { lastTickCompletedAt: completedAt.toISOString() };
  await writeFile(heartbeatPath(), JSON.stringify(content), 'utf8');
}

export async function readHeartbeat(): Promise<HeartbeatContent | null> {
  try {
    const raw = await readFile(heartbeatPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<HeartbeatContent>;
    if (typeof parsed.lastTickCompletedAt !== 'string') {
      return null;
    }
    return { lastTickCompletedAt: parsed.lastTickCompletedAt };
  } catch {
    return null;
  }
}
