// R06-A — the scheduler health state machine (lib/attendance-scheduler-health) and the DB-error
// classifier (lib/db-error-classification). Pure, no DB, no browser.
import { Prisma } from '@prisma/client';
import { classifySchedulerHealth, isHealthy, type SchedulerHealthState } from '../lib/attendance-scheduler-health';
import { newHeartbeat, type HeartbeatContent } from '../lib/attendance-scheduler-heartbeat';
import { classifyDbError } from '../lib/db-error-classification';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const NOW = new Date('2026-08-30T12:00:00.000Z');
const BASE = {
  now: NOW,
  intervalSeconds: 60,
  staleMultiplier: 3,
  staleFloorSeconds: 120,
  failureThreshold: 3,
  startupGraceSeconds: 90
};

function hb(overrides: Partial<HeartbeatContent>, processAgeSec = 3600): HeartbeatContent {
  return { ...newHeartbeat(4242, new Date(NOW.getTime() - processAgeSec * 1000)), ...overrides };
}
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();

function expect(name: string, input: Parameters<typeof classifySchedulerHealth>[0], state: SchedulerHealthState, healthy: boolean) {
  const r = classifySchedulerHealth(input);
  check(`${name} -> ${state} (healthy=${healthy})`, r.state === state && r.healthy === healthy, r);
}

// ---- health state machine ----
expect('no heartbeat', { ...BASE, heartbeat: null }, 'HEARTBEAT_MISSING', false);

expect('pid dead', { ...BASE, heartbeat: hb({ lastTickAt: ago(10), lastOutcome: 'ok', lastTickCompletedAt: ago(10) }), pidAlive: false }, 'PROCESS_STOPPED', false);

expect('just started, no tick yet, in grace', { ...BASE, heartbeat: hb({}, 30), pidAlive: true }, 'STARTING', true);
expect('started long ago, still no tick', { ...BASE, heartbeat: hb({}, 600), pidAlive: true }, 'HEARTBEAT_STALE', false);

expect('healthy: recent ok tick', { ...BASE, heartbeat: hb({ lastTickAt: ago(20), lastTickCompletedAt: ago(20), lastOutcome: 'ok' }), pidAlive: true }, 'HEALTHY', true);
expect('stale: ok tick but old', { ...BASE, heartbeat: hb({ lastTickAt: ago(400), lastTickCompletedAt: ago(400), lastOutcome: 'ok' }), pidAlive: true }, 'HEARTBEAT_STALE', false);

expect('db unavailable', { ...BASE, heartbeat: hb({ lastTickAt: ago(20), lastOutcome: 'db_unavailable', lastErrorCode: 'X', consecutiveFailures: 1 }), pidAlive: true }, 'DB_UNAVAILABLE', false);
expect('schema incompatible', { ...BASE, heartbeat: hb({ lastTickAt: ago(20), lastOutcome: 'schema_incompatible', consecutiveFailures: 1 }), pidAlive: true }, 'SCHEMA_INCOMPATIBLE', false);

expect('one transient tick error -> still healthy', { ...BASE, heartbeat: hb({ lastTickAt: ago(20), lastOutcome: 'tick_error', consecutiveFailures: 1 }), pidAlive: true }, 'HEALTHY', true);
expect('tick failing >= threshold', { ...BASE, heartbeat: hb({ lastTickAt: ago(20), lastOutcome: 'tick_error', consecutiveFailures: 3 }), pidAlive: true }, 'TICK_FAILING', false);
expect('transient tick error but now stale', { ...BASE, heartbeat: hb({ lastTickAt: ago(400), lastOutcome: 'tick_error', consecutiveFailures: 1 }), pidAlive: true }, 'HEARTBEAT_STALE', false);

expect('overlapping: recent overlap, no ok since', { ...BASE, heartbeat: hb({ lastTickAt: ago(20), lastOutcome: 'ok', lastTickCompletedAt: ago(600), lastOverlapAt: ago(15) }), pidAlive: true }, 'OVERLAPPING', false);
expect('overlap but a good tick happened after it', { ...BASE, heartbeat: hb({ lastTickAt: ago(10), lastOutcome: 'ok', lastTickCompletedAt: ago(10), lastOverlapAt: ago(300) }), pidAlive: true }, 'HEALTHY', true);

check('isHealthy(HEALTHY/STARTING) true, others false', isHealthy('HEALTHY') && isHealthy('STARTING') && !isHealthy('DB_UNAVAILABLE') && !isHealthy('OVERLAPPING'));

// ---- DB error classifier ----
check('P1001 -> db_unavailable', classifyDbError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P1001', clientVersion: '6' })) === 'db_unavailable');
check('P2021 -> schema_incompatible', classifyDbError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2021', clientVersion: '6' })) === 'schema_incompatible');
check('P2022 -> schema_incompatible', classifyDbError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2022', clientVersion: '6' })) === 'schema_incompatible');
check('P2002 -> other', classifyDbError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '6' })) === 'other');
check('init error -> db_unavailable', classifyDbError(new Prisma.PrismaClientInitializationError('x', '6')) === 'db_unavailable');
check('message "relation ... does not exist" -> schema_incompatible', classifyDbError(new Error('relation "Foo" does not exist')) === 'schema_incompatible');
check('message ECONNREFUSED -> db_unavailable', classifyDbError(new Error('connect ECONNREFUSED 127.0.0.1:5432')) === 'db_unavailable');
check('plain error -> other', classifyDbError(new Error('something else')) === 'other');

console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
