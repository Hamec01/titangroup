// R03 — GET /api/me/sessions + DELETE /api/me/sessions/:id. Direct-route-handler style.
// Needs DATABASE_URL with the session.read.own / session.revoke.own permissions seeded.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { GET as listSessions } from '../app/api/me/sessions/route';
import { DELETE as revokeSession } from '../app/api/me/sessions/[sessionId]/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 200) : ''); }
};

async function worker() {
  const user = await prisma.user.create({ data: { username: `sm-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } })).id } });
  return user;
}
async function session(userId: string, meta: { ip?: string; ua?: string } = {}) {
  const token = generateSessionToken();
  const row = await prisma.userSession.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date(), ipAddress: meta.ip ?? null, userAgent: meta.ua ?? null }
  });
  return { token, id: row.id };
}
function getReq(token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new NextRequest('http://localhost/api/me/sessions', { headers });
}
function delReq(token: string | null, id: string, csrf = true) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  if (csrf) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(`http://localhost/api/me/sessions/${id}`, { method: 'DELETE', headers });
}
const p = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });

async function main() {
  const u = await worker();
  const a = await session(u.id, { ip: '10.0.0.1', ua: 'Firefox' });
  const b = await session(u.id, { ip: '10.0.0.2', ua: 'Safari on iPhone' });
  const c = await session(u.id, { ip: '10.0.0.3', ua: 'Chrome' });

  check('1: no session -> 401', (await listSessions(getReq(null))).status === 401);

  const l1 = await listSessions(getReq(a.token));
  const j1 = await l1.json();
  check('1: lists all 3 active sessions', l1.status === 200 && j1.sessions.length === 3, j1);
  check('1: the caller session is flagged current, others not', j1.sessions.filter((s: { current: boolean }) => s.current).length === 1 && j1.sessions.find((s: { id: string }) => s.id === a.id).current === true, j1.sessions);
  check('1: metadata surfaced, no token hash', j1.sessions.every((s: Record<string, unknown>) => 'ipAddress' in s && 'userAgent' in s && !('tokenHash' in s)));

  // revoke another session
  check('2: no CSRF -> 403', (await revokeSession(delReq(a.token, b.id, false), p(b.id))).status === 403);
  check('2: malformed id -> 404', (await revokeSession(delReq(a.token, 'not-a-uuid'), p('not-a-uuid'))).status === 404);
  const rB = await revokeSession(delReq(a.token, b.id), p(b.id));
  check('2: revoke another session -> 204', rB.status === 204, rB.status);
  check('2: session b is revoked', (await prisma.userSession.findUniqueOrThrow({ where: { id: b.id } })).revokedAt !== null);
  check('2: session a (caller) untouched', (await prisma.userSession.findUniqueOrThrow({ where: { id: a.id } })).revokedAt === null);
  check('2: revoking b again -> 404 (indistinguishable)', (await revokeSession(delReq(a.token, b.id), p(b.id))).status === 404);
  check('2: audit SESSION_REVOKED', (await prisma.auditEvent.count({ where: { eventType: 'SESSION_REVOKED', actorUserId: u.id } })) === 1);

  // another user's session id -> 404, not revoked
  const other = await worker();
  const os = await session(other.id);
  check('3: another user\'s session id -> 404', (await revokeSession(delReq(a.token, os.id), p(os.id))).status === 404);
  check('3: that session is NOT revoked', (await prisma.userSession.findUniqueOrThrow({ where: { id: os.id } })).revokedAt === null);

  // revoke own current session -> clears cookie
  const rSelf = await revokeSession(delReq(a.token, a.id), p(a.id));
  check('4: revoke current session -> 204 + cookie cleared', rSelf.status === 204 && rSelf.cookies.get(SESSION_COOKIE_NAME)?.value === '', rSelf.cookies.get(SESSION_COOKIE_NAME));
  const l2 = await listSessions(getReq(c.token));
  check('4: only session c remains active', (await l2.json()).sessions.length === 1);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
