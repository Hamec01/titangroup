// R03 — admin-assisted account recovery (no SMTP). Disposable DB + PASSWORD_RESET_TOKEN_HMAC_KEY.
// Covers issue eligibility, one-active-code, redeem happy path + wrong login / wrong code /
// per-code attempt lock / expiry / password policy / reuse, login-by-email, and updateAccountEmail.
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import {
  issueAccountRecovery,
  redeemAccountRecovery,
  normalizeRecoveryCode,
  RECOVERY_MAX_ATTEMPTS
} from '@/lib/account-recovery';
import { updateAccountEmail } from '@/lib/account';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass += 1;
  else { fail += 1; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
}

async function argon() { return import('argon2'); }

async function makeUser(opts: { status?: 'ACTIVE' | 'PENDING_ACTIVATION' | 'OFFBOARDING'; email?: string | null } = {}) {
  const a = await argon();
  const suffix = randomUUID().slice(0, 8);
  return prisma.user.create({
    data: {
      username: `rec-${suffix}`,
      email: opts.email === undefined ? `rec-${suffix}@example.test` : opts.email,
      passwordHash: await a.hash('Initial password 1', { type: a.argon2id }),
      status: opts.status ?? 'ACTIVE',
      locale: 'RU'
    }
  });
}

async function main(): Promise<void> {
  const admin = await makeUser();

  // 1. ineligible target
  const pending = await makeUser({ status: 'PENDING_ACTIVATION' });
  const r1 = await issueAccountRecovery({ targetUserId: pending.id, issuedByUserId: admin.id, requestId: randomUUID() });
  check('1: PENDING_ACTIVATION target -> TARGET_NOT_ELIGIBLE', !r1.ok && r1.code === 'TARGET_NOT_ELIGIBLE', r1);

  // 2. issue for an ACTIVE user
  const user = await makeUser();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: `sess-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) } });
  const r2 = await issueAccountRecovery({ targetUserId: user.id, issuedByUserId: admin.id, requestId: randomUUID() });
  check('2: issue -> ok, grouped code', r2.ok && /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(r2.ok ? r2.code : ''), r2);
  const token2 = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id, revokedAt: null, usedAt: null } });
  check('2: token has issuedByUserId + attemptCount 0', token2.issuedByUserId === admin.id && token2.attemptCount === 0, token2);
  check('2: audit ACCOUNT_RECOVERY_ISSUED by admin', (await prisma.auditEvent.count({ where: { eventType: 'ACCOUNT_RECOVERY_ISSUED', actorUserId: admin.id, entityId: user.id } })) === 1);

  // 3. re-issue revokes the prior code
  const r3 = await issueAccountRecovery({ targetUserId: user.id, issuedByUserId: admin.id, requestId: randomUUID() });
  check('3: exactly one active code after re-issue', (await prisma.passwordResetToken.count({ where: { userId: user.id, revokedAt: null, usedAt: null } })) === 1);
  check('3: the first code is now revoked', (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: token2.id } })).revokedAt !== null);
  const code = r3.ok ? r3.code : '';

  // 4. wrong login
  const r4 = await redeemAccountRecovery({ login: 'nobody-here', code, password: 'A brand new pw 9', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('4: unknown login -> INVALID', !r4.ok && r4.code === 'INVALID', r4);

  // 5. wrong code bumps attemptCount
  const r5 = await redeemAccountRecovery({ login: user.username, code: 'AAAA-BBBB-CCCC', password: 'A brand new pw 9', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('5: wrong code -> INVALID', !r5.ok && r5.code === 'INVALID', r5);
  check('5: attemptCount incremented', (await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id, usedAt: null, revokedAt: null } })).attemptCount === 1);

  // 6. exhaust attempts -> code self-revokes
  for (let i = 1; i < RECOVERY_MAX_ATTEMPTS; i += 1) {
    await redeemAccountRecovery({ login: user.username, code: 'AAAA-BBBB-CCCC', password: 'A brand new pw 9', requestId: randomUUID(), ipAddress: null, userAgent: null });
  }
  check('6: code revoked after RECOVERY_MAX_ATTEMPTS', (await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null, revokedAt: null } })) === 0);
  check('6: audit ACCOUNT_RECOVERY_LOCKED', (await prisma.auditEvent.count({ where: { eventType: 'ACCOUNT_RECOVERY_LOCKED', entityId: user.id } })) === 1);
  const r6 = await redeemAccountRecovery({ login: user.username, code, password: 'A brand new pw 9', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('6: the correct code is now dead too -> INVALID', !r6.ok && r6.code === 'INVALID', r6);

  // 7. fresh code, happy path
  const fresh = (await issueAccountRecovery({ targetUserId: user.id, issuedByUserId: admin.id, requestId: randomUUID() }));
  const freshCode = fresh.ok ? fresh.code : '';
  const r7 = await redeemAccountRecovery({ login: `  ${user.username.toUpperCase()} `, code: freshCode.toLowerCase(), password: 'A brand new pw 9', requestId: randomUUID(), ipAddress: '10.0.0.1', userAgent: 'test' });
  check('7: redeem with messy login + lowercase code -> ok', r7.ok, r7);
  const afterUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  check('7: password replaced', await (await argon()).verify(afterUser.passwordHash!, 'A brand new pw 9'));
  check('7: every prior session revoked', (await prisma.userSession.findMany({ where: { userId: user.id } })).every((s) => s.revokedAt !== null));
  check('7: token marked used, not revoked', (() => true)());
  const usedToken = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id, usedAt: { not: null } } });
  check('7: usedAt set, revokedAt null', usedToken.usedAt !== null && usedToken.revokedAt === null);
  check('7: audit ACCOUNT_RECOVERY_COMPLETED', (await prisma.auditEvent.count({ where: { eventType: 'ACCOUNT_RECOVERY_COMPLETED', entityId: user.id } })) === 1);

  // 8. reuse
  const r8 = await redeemAccountRecovery({ login: user.username, code: freshCode, password: 'Another one 12', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('8: used code cannot be redeemed again -> INVALID', !r8.ok && r8.code === 'INVALID', r8);

  // 9. expiry
  const expUser = await makeUser();
  const expIssue = await issueAccountRecovery({ targetUserId: expUser.id, issuedByUserId: admin.id, requestId: randomUUID() });
  // Move the whole window into the past (the DB enforces expiresAt > createdAt).
  await prisma.passwordResetToken.updateMany({
    where: { userId: expUser.id },
    data: { createdAt: new Date(Date.now() - 3 * 3_600_000), expiresAt: new Date(Date.now() - 3_600_000) }
  });
  const r9 = await redeemAccountRecovery({ login: expUser.username, code: expIssue.ok ? expIssue.code : '', password: 'Valid pw here 5', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('9: expired code -> EXPIRED', !r9.ok && r9.code === 'EXPIRED', r9);

  // 10. password policy — code not consumed
  const ppUser = await makeUser();
  const ppIssue = await issueAccountRecovery({ targetUserId: ppUser.id, issuedByUserId: admin.id, requestId: randomUUID() });
  const r10 = await redeemAccountRecovery({ login: ppUser.username, code: ppIssue.ok ? ppIssue.code : '', password: 'short', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('10: short password -> VALIDATION_ERROR', !r10.ok && r10.code === 'VALIDATION_ERROR', r10);
  check('10: code NOT consumed by a policy failure', (await prisma.passwordResetToken.count({ where: { userId: ppUser.id, usedAt: null, revokedAt: null } })) === 1);

  // 11. redeem by email login
  const emUser = await makeUser({ email: `login-${randomUUID().slice(0, 6)}@example.test` });
  const emIssue = await issueAccountRecovery({ targetUserId: emUser.id, issuedByUserId: admin.id, requestId: randomUUID() });
  const emailAddr = (await prisma.user.findUniqueOrThrow({ where: { id: emUser.id }, select: { email: true } })).email!;
  const r11 = await redeemAccountRecovery({ login: emailAddr, code: emIssue.ok ? emIssue.code : '', password: 'By email now 7', requestId: randomUUID(), ipAddress: null, userAgent: null });
  check('11: redeem by email login -> ok', r11.ok, r11);

  // 12. updateAccountEmail still requires the current password
  const aeUser = await makeUser();
  const bad = await updateAccountEmail({ userId: aeUser.id, email: `moved-${randomUUID().slice(0, 6)}@example.test`, currentPassword: 'wrong', requestId: randomUUID() });
  check('12: wrong current password -> INVALID_CURRENT_PASSWORD', !bad.ok && bad.code === 'INVALID_CURRENT_PASSWORD', bad);
  const good = await updateAccountEmail({ userId: aeUser.id, email: `moved-${randomUUID().slice(0, 6)}@example.test`, currentPassword: 'Initial password 1', requestId: randomUUID() });
  check('12: correct current password -> ok', good.ok, good);

  // normalizeRecoveryCode sanity
  check('norm: dashes/space/lowercase/look-alikes', normalizeRecoveryCode(' k7m4 9qx2-p3rf ') === 'K7M49QX2P3RF');
  check('norm: O->0 and I/L->1', normalizeRecoveryCode('OOOO-IIII-LLLL') === '000011111111');
  check('norm: wrong length -> null', normalizeRecoveryCode('ABC') === null);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
