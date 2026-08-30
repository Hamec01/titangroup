// R03 — admin-assisted recovery HTTP routes. Direct-route-handler style. Needs DATABASE_URL +
// PASSWORD_RESET_TOKEN_HMAC_KEY. Covers: issue (worker + user), CSRF, permission, Idempotency-Key
// mandatory + replay, ineligible target, and the public /api/auth/password-reset/confirm flow
// (login + code + new password), wrong code, reuse, non-enumerating errors.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as workerRecovery } from '../app/api/admin/workers/[employeeId]/recovery/route';
import { POST as userRecovery } from '../app/api/admin/users/[userId]/recovery/route';
import { POST as confirm } from '../app/api/auth/password-reset/confirm/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); }
};

async function argon() { return import('argon2'); }

async function adminSession() {
  const user = await prisma.user.create({ data: { username: `rec-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { user, token };
}

async function makeWorker(status: 'ACTIVE' | 'PENDING_ACTIVATION' = 'ACTIVE') {
  const a = await argon();
  const emp = await prisma.employee.create({ data: { employeeNumber: `REC-${randomUUID().slice(0, 8)}`, firstName: 'Rec', lastName: 'Worker' } });
  const user = await prisma.user.create({
    data: {
      username: `rec-w-${randomUUID().slice(0, 8)}`,
      status,
      locale: 'RU',
      employeeId: emp.id,
      passwordHash: status === 'ACTIVE' ? await a.hash('Original pw here 1', { type: a.argon2id }) : null
    }
  });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return { emp, user };
}

function req(url: string, opts: { token?: string; csrf?: boolean; idem?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.token}`;
  if (opts.csrf !== false) headers['x-requested-with'] = 'titanor-time';
  if (opts.idem !== null) headers['idempotency-key'] = opts.idem ?? randomUUID();
  return new NextRequest(`http://localhost${url}`, { method: 'POST', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : '{}' });
}
const wParams = (employeeId: string) => ({ params: Promise.resolve({ employeeId }) });
const uParams = (userId: string) => ({ params: Promise.resolve({ userId }) });

async function main() {
  const admin = await adminSession();

  // --- worker recovery: happy path ---
  const w = await makeWorker('ACTIVE');
  await prisma.userSession.create({ data: { userId: w.user.id, tokenHash: `w-sess-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) } });
  const idem = randomUUID();
  const r1 = await workerRecovery(req(`/api/admin/workers/${w.emp.id}/recovery`, { token: admin.token, idem }), wParams(w.emp.id));
  const j1 = await r1.json();
  check('1: worker recovery -> 201 with grouped code', r1.status === 201 && /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(j1.code), j1);
  const code = j1.code as string;

  // replay same Idempotency-Key -> same code, no new token
  const r1b = await workerRecovery(req(`/api/admin/workers/${w.emp.id}/recovery`, { token: admin.token, idem }), wParams(w.emp.id));
  const j1b = await r1b.json();
  check('1: Idempotency-Key replay returns the same code', j1b.code === code);
  check('1: still exactly one active code', (await prisma.passwordResetToken.count({ where: { userId: w.user.id, usedAt: null, revokedAt: null } })) === 1);

  // --- guards ---
  check('2: no CSRF header -> 403', (await workerRecovery(req(`/api/admin/workers/${w.emp.id}/recovery`, { token: admin.token, csrf: false }), wParams(w.emp.id))).status === 403);
  check('2: no session -> 401', (await workerRecovery(req(`/api/admin/workers/${w.emp.id}/recovery`), wParams(w.emp.id))).status === 401);
  const workerTok = generateSessionToken();
  const someWorker = await prisma.user.create({ data: { username: `rec-nope-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  await prisma.userRole.create({ data: { userId: someWorker.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } })).id } });
  await prisma.userSession.create({ data: { userId: someWorker.id, tokenHash: hashSessionToken(workerTok), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  check('2: WORKER role -> 403 FORBIDDEN', (await workerRecovery(req(`/api/admin/workers/${w.emp.id}/recovery`, { token: workerTok }), wParams(w.emp.id))).status === 403);
  check('2: missing Idempotency-Key -> 400', (await workerRecovery(req(`/api/admin/workers/${w.emp.id}/recovery`, { token: admin.token, idem: null }), wParams(w.emp.id))).status === 400);
  check('2: malformed employeeId -> 404', (await workerRecovery(req(`/api/admin/workers/not-a-uuid/recovery`, { token: admin.token }), wParams('not-a-uuid'))).status === 404);

  // --- ineligible: PENDING_ACTIVATION worker ---
  const pending = await makeWorker('PENDING_ACTIVATION');
  const rp = await workerRecovery(req(`/api/admin/workers/${pending.emp.id}/recovery`, { token: admin.token }), wParams(pending.emp.id));
  check('3: PENDING_ACTIVATION worker -> 409 TARGET_NOT_ELIGIBLE', rp.status === 409 && (await rp.json()).error?.code === 'TARGET_NOT_ELIGIBLE', rp.status);

  // --- standalone user recovery ---
  const su = await prisma.user.create({ data: { username: `rec-su-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', passwordHash: await (await argon()).hash('Standalone pw 1', { type: (await argon()).argon2id }) } });
  await prisma.userRole.create({ data: { userId: su.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { name: 'FOREMAN' } })).id } });
  const rsu = await userRecovery(req(`/api/admin/users/${su.id}/recovery`, { token: admin.token }), uParams(su.id));
  check('4: standalone user recovery -> 201', rsu.status === 201, rsu.status);

  // --- confirm flow ---
  const rw1 = await confirm(req('/api/auth/password-reset/confirm', { body: { login: w.user.username, code: 'AAAA-BBBB-CCCC', password: 'Brand new pw 9' } }));
  check('5: wrong code -> 400 RECOVERY_INVALID', rw1.status === 400 && (await rw1.json()).error?.code === 'RECOVERY_INVALID');
  const rw2 = await confirm(req('/api/auth/password-reset/confirm', { body: { login: 'ghost-user', code, password: 'Brand new pw 9' } }));
  check('5: unknown login -> 400 RECOVERY_INVALID (non-enumerating)', rw2.status === 400 && (await rw2.json()).error?.code === 'RECOVERY_INVALID');
  const rw3 = await confirm(req('/api/auth/password-reset/confirm', { body: { login: w.user.username, code, password: 'short' } }));
  check('5: short password -> 400 VALIDATION_ERROR', rw3.status === 400 && (await rw3.json()).error?.code === 'VALIDATION_ERROR');

  const rOk = await confirm(req('/api/auth/password-reset/confirm', { body: { login: w.user.username, code, password: 'Brand new pw 9' } }));
  check('6: correct login + code + password -> 200', rOk.status === 200, rOk.status);
  const after = await prisma.user.findUniqueOrThrow({ where: { id: w.user.id }, select: { passwordHash: true } });
  check('6: password replaced', await (await argon()).verify(after.passwordHash!, 'Brand new pw 9'));
  check('6: all sessions revoked', (await prisma.userSession.findMany({ where: { userId: w.user.id } })).every((s) => s.revokedAt !== null));
  const rReuse = await confirm(req('/api/auth/password-reset/confirm', { body: { login: w.user.username, code, password: 'Brand new pw 9' } }));
  check('6: reused code -> 400 RECOVERY_INVALID', rReuse.status === 400 && (await rReuse.json()).error?.code === 'RECOVERY_INVALID');

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
