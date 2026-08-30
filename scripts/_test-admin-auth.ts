// R07-B — public-site admin auth: timing-safe password, login rate-limit, CSRF on login+logout,
// append-only audit (no password/token). Runs the real route handlers.
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_SESSION_SECRET = 'test-secret-'.repeat(3);
  const AUDIT = join(tmpdir(), `r07b-audit-${Date.now()}.log`);
  process.env.ADMIN_AUDIT_LOG = AUDIT;

  const { isAdminPasswordValid, isAdminRequestAuthenticated, getAdminSessionCookieName } = await import('../lib/admin-auth');
  const { __resetRateLimitStore } = await import('../lib/rate-limit');
  const { POST: login } = await import('../app/api/admin/login/route');
  const { POST: logout } = await import('../app/api/admin/logout/route');
  const { NextRequest } = await import('next/server');

  const cookieName = getAdminSessionCookieName();

  function req(body: unknown, opts: { csrf?: boolean; ip?: string } = {}): InstanceType<typeof NextRequest> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.csrf !== false) headers.set('x-requested-with', 'titanor-admin');
    if (opts.ip) headers.set('x-forwarded-for', opts.ip);
    return new NextRequest('http://localhost/api/admin/login', { method: 'POST', headers, body: JSON.stringify(body) });
  }

  // ---- timing-safe password check ----
  check('correct password accepted', isAdminPasswordValid('correct horse battery staple'));
  check('wrong password rejected', !isAdminPasswordValid('wrong'));
  check('empty rejected', !isAdminPasswordValid(''));
  check('near-miss rejected', !isAdminPasswordValid('correct horse battery stapl'));

  // ---- login route: CSRF ----
  check('login without X-Requested-With -> 403', (await login(req({ password: 'x' }, { csrf: false }))).status === 403);

  // ---- login route: bad creds -> 401, no cookie ----
  __resetRateLimitStore();
  {
    const r = await login(req({ password: 'nope' }, { ip: '203.0.113.10' }));
    check('login bad creds -> 401', r.status === 401);
    check('login bad creds sets no session cookie', !(r.headers.get('set-cookie') || '').includes(cookieName + '='));
  }

  // ---- login route: good creds -> 200 + Strict/HttpOnly cookie that authenticates ----
  __resetRateLimitStore();
  {
    const r = await login(req({ password: 'correct horse battery staple' }, { ip: '203.0.113.11' }));
    check('login good creds -> 200', r.status === 200);
    const sc = r.headers.get('set-cookie') || '';
    check('cookie HttpOnly', /HttpOnly/i.test(sc));
    check('cookie SameSite=Strict', /SameSite=Strict/i.test(sc), sc);
    const token = (sc.match(new RegExp(cookieName + '=([^;]+)')) || [])[1];
    const authed = new NextRequest('http://localhost/x', { headers: { cookie: `${cookieName}=${token}` } });
    check('issued cookie authenticates a follow-up request', isAdminRequestAuthenticated(authed));
  }

  // ---- login route: rate limit (10 / window) ----
  __resetRateLimitStore();
  {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login(req({ password: 'nope' }, { ip: '198.51.100.5' }))).status;
    check('11th+ attempt from one IP -> 429', last === 429, { last });
    check('a different IP still 401 (own bucket)', (await login(req({ password: 'nope' }, { ip: '198.51.100.6' }))).status === 401);
  }

  // ---- logout route: CSRF ----
  check('logout without X-Requested-With -> 403',
    (await logout(new Request('http://localhost/api/admin/logout', { method: 'POST' }))).status === 403);
  {
    const ok = await logout(new Request('http://localhost/api/admin/logout', { method: 'POST', headers: { 'x-requested-with': 'titanor-admin' } }));
    check('logout with header -> 200 + clears cookie', ok.status === 200 && /Max-Age=0/i.test(ok.headers.get('set-cookie') || ''));
  }

  // ---- audit file: lines written, never the password/token ----
  await sleep(50);
  const content = readFileSync(AUDIT, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('audit has success + failure + rate_limited', lines.some((l) => l.outcome === 'success') && lines.some((l) => l.outcome === 'failure') && lines.some((l) => l.outcome === 'rate_limited'));
  check('audit records the client IP', lines.some((l) => l.ip === '203.0.113.11'));
  check('audit never contains the password', !content.includes('correct horse battery staple'));
  check('audit lines carry no token/cookie/password field', lines.every((l) => !('token' in l) && !('cookie' in l) && !('password' in l)));
  rmSync(AUDIT, { force: true });

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
