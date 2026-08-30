// R07-A — the shared DB-backed fixed-window rate limiter (lib/rate-limit). Needs a disposable
// PostgreSQL 16 (the RateLimitCounter table).
import { prisma } from '../lib/prisma';
import { checkRateLimit } from '../lib/rate-limit';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const uniq = () => `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

async function main() {
  // 1. Allowed up to the limit, then blocked, within one window.
  {
    const key = uniq();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit(key, 3, 60_000));
    check('1: first 3 allowed, rest blocked', JSON.stringify(results) === JSON.stringify([true, true, true, false, false]), results);
    const row = await prisma.rateLimitCounter.findUnique({ where: { key } });
    check('1: one row, count kept climbing', row?.count === 5, row);
  }

  // 2. Distinct keys are independent.
  {
    const a = uniq();
    const b = uniq();
    check('2: a hits its limit', (await checkRateLimit(a, 1, 60_000)) && !(await checkRateLimit(a, 1, 60_000)));
    check('2: b still fresh', await checkRateLimit(b, 1, 60_000));
  }

  // 3. Window expiry resets the counter.
  {
    const key = uniq();
    check('3: first call allowed', await checkRateLimit(key, 1, 60_000));
    check('3: immediate retry blocked (same window)', !(await checkRateLimit(key, 1, 60_000)));
    // Force the window to be expired, then the next call must reset to count=1.
    await prisma.rateLimitCounter.update({ where: { key }, data: { windowExpiresAt: new Date(Date.now() - 1000) } });
    check('3: after expiry -> allowed again', await checkRateLimit(key, 1, 60_000));
    const row = await prisma.rateLimitCounter.findUnique({ where: { key } });
    check('3: counter reset to 1', row?.count === 1, row);
    check('3: window pushed into the future', (row?.windowExpiresAt.getTime() ?? 0) > Date.now(), row);
  }

  // 4. Concurrent increments are atomic — exactly `limit` of N parallel calls are allowed.
  {
    const key = uniq();
    const N = 30;
    const limit = 10;
    const outcomes = await Promise.all(Array.from({ length: N }, () => checkRateLimit(key, limit, 60_000)));
    const allowed = outcomes.filter(Boolean).length;
    check(`4: exactly ${limit} of ${N} concurrent calls allowed`, allowed === limit, { allowed });
    const row = await prisma.rateLimitCounter.findUnique({ where: { key } });
    check('4: final count == N (no lost updates)', row?.count === N, row);
  }

  // 5. Opportunistic cleanup query is valid and removes only long-expired rows.
  {
    const stale = uniq();
    const fresh = uniq();
    await prisma.rateLimitCounter.create({ data: { key: stale, count: 1, windowExpiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
    await prisma.rateLimitCounter.create({ data: { key: fresh, count: 1, windowExpiresAt: new Date(Date.now() + 60_000) } });
    await prisma.$executeRaw`DELETE FROM "RateLimitCounter" WHERE "windowExpiresAt" < now() - interval '1 hour'`;
    check('5: long-expired row GC-d', (await prisma.rateLimitCounter.findUnique({ where: { key: stale } })) === null);
    check('5: fresh row untouched', (await prisma.rateLimitCounter.findUnique({ where: { key: fresh } })) !== null);
  }

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
