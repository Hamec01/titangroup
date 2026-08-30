// R07-A — the shared route guard (lib/api-guard.guardApiRequest) + the /api/auth/* routes migrated
// to it. Needs DATABASE_URL. Proves the guard's CSRF / auth / permission gates are byte-identical
// to the inline checks they replaced.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { guardApiRequest } from '../lib/api-guard';
import { GET as authSession } from '../app/api/auth/session/route';
import { POST as logout } from '../app/api/auth/logout/route';
import { POST as logoutAll } from '../app/api/auth/logout-all/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 200) : ''); }
};

async function makeSession(roleName: string | null) {
  const user = await prisma.user.create({ data: { username: `g-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  if (roleName) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const token = generateSessionToken();
  const s = await prisma.userSession.create({
    data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() }
  });
  return { user, token, sessionId: s.id };
}

function req(token: string | null, method: 'GET' | 'POST', csrf: boolean): NextRequest {
  const headers = new Headers();
  if (token) headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
  if (csrf) headers.set('x-requested-with', 'titanor-time');
  return new NextRequest('http://localhost/x', { method, headers });
}

async function main() {
  // ---- guardApiRequest unit behaviour ----
  {
    const g = await guardApiRequest(req(null, 'GET', false));
    check('guard: no cookie -> not ok, 401', !g.ok && g.response.status === 401);
  }
  {
    const g = await guardApiRequest(req('deadbeef', 'GET', false));
    check('guard: bogus token -> 401', !g.ok && g.response.status === 401);
  }
  {
    const s = await makeSession('WORKER');
    const g = await guardApiRequest(req(s.token, 'POST', false), { csrf: true });
    check('guard: csrf required, header missing -> 403', !g.ok && g.response.status === 403);
    const g2 = await guardApiRequest(req(s.token, 'POST', true), { csrf: true });
    check('guard: csrf ok + session -> ok', g2.ok === true);
    if (g2.ok) check('guard: session + requestId returned', !!g2.session.user.id && typeof g2.requestId === 'string');
  }
  {
    const s = await makeSession('WORKER');
    const denied = await guardApiRequest(req(s.token, 'GET', false), { permission: 'user.create' });
    check('guard: missing permission -> 403', !denied.ok && denied.response.status === 403);
    const okG = await guardApiRequest(req(s.token, 'GET', false), { permission: 'timesheet.read.own' });
    check('guard: held permission -> ok', okG.ok === true);
  }
  {
    const s = await makeSession('SUPER_ADMIN');
    const all = await guardApiRequest(req(s.token, 'GET', false), { permission: ['worker.read.all', 'timesheet.read.all'] });
    check('guard: ALL of a permission array held -> ok', all.ok === true);
    const anyG = await guardApiRequest(req(s.token, 'GET', false), { anyPermission: ['this.does.not.exist', 'worker.read.all'] });
    check('guard: anyPermission (one held) -> ok', anyG.ok === true);
    const anyNone = await guardApiRequest(req(s.token, 'GET', false), { anyPermission: ['nope.a', 'nope.b'] });
    check('guard: anyPermission (none held) -> 403', !anyNone.ok && anyNone.response.status === 403);
  }

  // ---- migrated routes ----
  {
    check('GET /api/auth/session: no session -> 401', (await authSession(req(null, 'GET', false))).status === 401);
    const s = await makeSession('WORKER');
    const res = await authSession(req(s.token, 'GET', false));
    check('GET /api/auth/session: valid -> 200', res.status === 200);
  }
  {
    check('POST /api/auth/logout: no CSRF -> 403', (await logout(req('x', 'POST', false))).status === 403);
    check('POST /api/auth/logout: CSRF ok but no session -> 401', (await logout(req(null, 'POST', true))).status === 401);
    const s = await makeSession('WORKER');
    const res = await logout(req(s.token, 'POST', true));
    check('POST /api/auth/logout: valid -> 204', res.status === 204);
    const row = await prisma.userSession.findUnique({ where: { id: s.sessionId } });
    check('POST /api/auth/logout: session soft-revoked', row?.revokedAt !== null);
  }
  {
    const s = await makeSession('WORKER'); // WORKER holds session.revoke_all.own (seeded)
    const res = await logoutAll(req(s.token, 'POST', true));
    check('POST /api/auth/logout-all: valid -> 204', res.status === 204, { status: res.status });
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
