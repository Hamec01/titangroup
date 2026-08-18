import { readHeartbeat } from '../lib/attendance-scheduler-heartbeat';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §6 — standalone healthcheck,
// no HTTP server/port. Invoked directly by Docker's `healthcheck.test` (compose.titanor-time.yaml,
// `scheduler` service). Exit 0 = healthy, exit 1 = unhealthy (heartbeat missing or stale). Never
// reads DATABASE_URL or touches the database itself — a stuck/crashed loop's own inability to write
// a fresh heartbeat is exactly the signal this is meant to detect, so this check must not depend on
// the same resource that might be the problem.

const DEFAULT_INTERVAL_SECONDS = 60;
const STALE_MULTIPLIER = 3;
const STALE_FLOOR_SECONDS = 120;

function resolveIntervalSeconds(): number {
  const raw = process.env.ATTENDANCE_SCHEDULER_INTERVAL_SECONDS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SECONDS;
}

async function main(): Promise<void> {
  const heartbeat = await readHeartbeat();
  if (!heartbeat) {
    process.exit(1);
  }

  const intervalSeconds = resolveIntervalSeconds();
  const staleAfterMs = Math.max(intervalSeconds * STALE_MULTIPLIER, STALE_FLOOR_SECONDS) * 1000;
  const ageMs = Date.now() - new Date(heartbeat.lastTickCompletedAt).getTime();

  process.exit(ageMs >= 0 && ageMs <= staleAfterMs ? 0 : 1);
}

main().catch(() => process.exit(1));
