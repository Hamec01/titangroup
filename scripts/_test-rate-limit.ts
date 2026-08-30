// R07-B — public-site in-memory rate limiter (lib/rate-limit). Pure.
import { checkRateLimit, __resetRateLimitStore } from '../lib/rate-limit';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const uniq = () => `k:${Math.random().toString(36).slice(2)}`;

// 1. allowed up to the limit, then blocked
{
  const k = uniq();
  const r = [];
  for (let i = 0; i < 5; i++) r.push(checkRateLimit(k, 3, 60_000).allowed);
  check('first 3 allowed, rest blocked', JSON.stringify(r) === JSON.stringify([true, true, true, false, false]), r);
  check('count keeps climbing', checkRateLimit(k, 3, 60_000).count === 6);
}

// 2. keys are independent
{
  const a = uniq(); const b = uniq();
  check('a hits limit', checkRateLimit(a, 1, 60_000).allowed && !checkRateLimit(a, 1, 60_000).allowed);
  check('b still fresh', checkRateLimit(b, 1, 60_000).allowed);
}

// 3. window expiry
{
  const k = uniq();
  check('first allowed', checkRateLimit(k, 1, 20).allowed);
  check('immediate retry blocked', !checkRateLimit(k, 1, 20).allowed);
  const past = Date.now() + 25;
  // busy-wait ~25ms so the 20ms window expires
  while (Date.now() < past) { /* spin */ }
  const after = checkRateLimit(k, 1, 60_000);
  check('after expiry -> allowed, count reset to 1', after.allowed && after.count === 1, after);
}

// 4. resetAt is in the future and stable within a window
{
  const k = uniq();
  const a = checkRateLimit(k, 5, 60_000);
  const b = checkRateLimit(k, 5, 60_000);
  check('resetAt in the future', a.resetAt > Date.now());
  check('resetAt stable within the window', a.resetAt === b.resetAt);
}

__resetRateLimitStore();
console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
