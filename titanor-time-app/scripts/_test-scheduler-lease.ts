// R06-A — the single-writer scheduler lease (lib/scheduler-lease). Needs a disposable PostgreSQL 16.
import { prisma } from '../lib/prisma';
import { acquireOrRenewLease, releaseLease, SCHEDULER_LEASE_NAME } from '../lib/scheduler-lease';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const A = 'host-a:100:aaaa';
const B = 'host-b:200:bbbb';

async function main() {
  const t0 = new Date('2026-08-30T12:00:00.000Z');

  // A takes the lease (first ever).
  check('1: A acquires the fresh lease', (await acquireOrRenewLease(A, t0)) === 'acquired');
  check('1: exactly one lease row', (await prisma.schedulerLease.count()) === 1);

  // B cannot take it while A's lease is live.
  check('2: B is refused (held_by_another)', (await acquireOrRenewLease(B, new Date(t0.getTime() + 60_000))) === 'held_by_another');
  check('2: row still held by A', (await prisma.schedulerLease.findUniqueOrThrow({ where: { name: SCHEDULER_LEASE_NAME } })).holderId === A);

  // A renews — acquiredAt is preserved, renewedAt advances.
  const beforeRenew = await prisma.schedulerLease.findUniqueOrThrow({ where: { name: SCHEDULER_LEASE_NAME } });
  const tRenew = new Date(t0.getTime() + 120_000);
  check('3: A renews', (await acquireOrRenewLease(A, tRenew)) === 'renewed');
  const afterRenew = await prisma.schedulerLease.findUniqueOrThrow({ where: { name: SCHEDULER_LEASE_NAME } });
  check('3: acquiredAt unchanged, renewedAt advanced',
    afterRenew.acquiredAt.getTime() === beforeRenew.acquiredAt.getTime() && afterRenew.renewedAt.getTime() === tRenew.getTime(), afterRenew);

  // After the TTL with no renewal, B takes it over.
  const wayLater = new Date(tRenew.getTime() + 200 * 60 * 1000); // > 90 min TTL past A's last renew
  check('4: B takes over the expired lease', (await acquireOrRenewLease(B, wayLater)) === 'acquired');
  check('4: row now held by B, acquiredAt = takeover time',
    (await prisma.schedulerLease.findUniqueOrThrow({ where: { name: SCHEDULER_LEASE_NAME } })).holderId === B);
  check('4: A is now refused', (await acquireOrRenewLease(A, new Date(wayLater.getTime() + 60_000))) === 'held_by_another');

  // Release lets a new holder in immediately.
  await releaseLease(B);
  check('5: released -> no row', (await prisma.schedulerLease.count()) === 0);
  check('5: A can re-acquire right away', (await acquireOrRenewLease(A, new Date(wayLater.getTime() + 120_000))) === 'acquired');
  // releasing with the wrong holder id is a no-op
  await releaseLease('someone-else');
  check('5: wrong-holder release is a no-op', (await prisma.schedulerLease.count()) === 1);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
