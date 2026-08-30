// R03 — POST /api/auth/change-password. Direct-route-handler style. Needs DATABASE_URL.
// Self-service change by current password: keeps this session, revokes every other, audits.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as changePassword } from '../app/api/auth/change-password/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 200) : ''); }
};

async function argon() { return import('argon2'); }

function req(token: string | null, body: unknown, csrf = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  if (csrf) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest('http://localhost/api/auth/change-password', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function main() {
  const a = await argon();
  const user = await prisma.user.create({
    data: { username: `cp-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', passwordHash: await a.hash('Original secret 1', { type: a.argon2id }) }
  });
  const currentToken = generateSessionToken();
  const currentSession = await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(currentToken), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  const otherSession = await prisma.userSession.create({ data: { userId: user.id, tokenHash: `other-${randomUUID()}`, expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });

  check('1: no session -> 401', (await changePassword(req(null, { currentPassword: 'x', newPassword: 'Whatever 123' }))).status === 401);
  check('2: no CSRF -> 403', (await changePassword(req(currentToken, { currentPassword: 'Original secret 1', newPassword: 'Whatever 123' }, false))).status === 403);

  const wrong = await changePassword(req(currentToken, { currentPassword: 'nope', newPassword: 'Whatever 123' }));
  check('3: wrong current password -> 400 INVALID_CURRENT_PASSWORD', wrong.status === 400 && (await wrong.json()).error?.code === 'INVALID_CURRENT_PASSWORD');

  const same = await changePassword(req(currentToken, { currentPassword: 'Original secret 1', newPassword: 'Original secret 1' }));
  check('4: new == current -> 400 SAME_AS_CURRENT', same.status === 400 && (await same.json()).error?.code === 'SAME_AS_CURRENT');

  const short = await changePassword(req(currentToken, { currentPassword: 'Original secret 1', newPassword: 'short' }));
  check('5: short new password -> 400 VALIDATION_ERROR', short.status === 400 && (await short.json()).error?.code === 'VALIDATION_ERROR');

  const ok = await changePassword(req(currentToken, { currentPassword: 'Original secret 1', newPassword: 'A stronger one 2' }));
  check('6: happy path -> 204', ok.status === 204, ok.status);
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  check('6: password replaced', await a.verify(after.passwordHash!, 'A stronger one 2'));
  check('6: this session still active', (await prisma.userSession.findUniqueOrThrow({ where: { id: currentSession.id } })).revokedAt === null);
  check('6: the other session revoked', (await prisma.userSession.findUniqueOrThrow({ where: { id: otherSession.id } })).revokedAt !== null);
  check('6: audit PASSWORD_CHANGED', (await prisma.auditEvent.count({ where: { eventType: 'PASSWORD_CHANGED', actorUserId: user.id } })) === 1);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
