import { readHeartbeatRecord } from '../lib/attendance-scheduler-heartbeat';
import { classifySchedulerHealth } from '../lib/attendance-scheduler-health';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §6 + R06-A — standalone
// healthcheck, no HTTP server/port, no database connection of its own (a stuck loop's inability to
// write a fresh heartbeat is exactly the signal this must detect). Invoked by Docker's
// `healthcheck.test`. Prints one line `scheduler-health: STATE (age Ns)` — visible in
// `docker inspect --format '{{json .State.Health}}'` — then exit 0 (healthy) or 1 (unhealthy).

const DEFAULT_INTERVAL_SECONDS = 60;
const STALE_MULTIPLIER = 3;
const STALE_FLOOR_SECONDS = 120;
const FAILURE_THRESHOLD = 3;
const STARTUP_GRACE_SECONDS = 90;

function resolveIntervalSeconds(): number {
  const raw = process.env.ATTENDANCE_SCHEDULER_INTERVAL_SECONDS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_SECONDS;
}

function pidAlive(pid: number): boolean | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function main(): Promise<void> {
  const heartbeat = await readHeartbeatRecord();
  const result = classifySchedulerHealth({
    heartbeat,
    now: new Date(),
    intervalSeconds: resolveIntervalSeconds(),
    staleMultiplier: STALE_MULTIPLIER,
    staleFloorSeconds: STALE_FLOOR_SECONDS,
    failureThreshold: FAILURE_THRESHOLD,
    startupGraceSeconds: STARTUP_GRACE_SECONDS,
    pidAlive: heartbeat ? pidAlive(heartbeat.pid) : undefined
  });

  const age = result.lastTickAgeSeconds === null ? 'n/a' : `${result.lastTickAgeSeconds}s`;
  process.stdout.write(`scheduler-health: ${result.state} (last tick ${age})\n`);
  process.exit(result.healthy ? 0 : 1);
}

main().catch(() => {
  process.stdout.write('scheduler-health: HEARTBEAT_MISSING (healthcheck error)\n');
  process.exit(1);
});
