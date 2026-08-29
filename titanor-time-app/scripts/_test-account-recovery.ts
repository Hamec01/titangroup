// Disposable-DB regression check for account email and password recovery.
// Run only with an explicit throwaway DATABASE_URL and PASSWORD_RESET_TOKEN_HMAC_KEY.
import { prisma } from '@/lib/prisma';
import { issuePasswordReset, redeemPasswordReset } from '@/lib/password-reset';
import { updateAccountEmail } from '@/lib/account';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const argon2 = await import('argon2');
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      username: `recovery-${suffix}`,
      email: `before-${suffix}@example.test`,
      passwordHash: await argon2.hash('Initial password 1', { type: argon2.argon2id }),
      status: 'ACTIVE',
      locale: 'RU'
    }
  });
  await prisma.userSession.create({
    data: { userId: user.id, tokenHash: `existing-${suffix}`, expiresAt: new Date(Date.now() + 60_000) }
  });

  const wrongPassword = await updateAccountEmail({
    userId: user.id,
    email: `after-${suffix}@example.test`,
    currentPassword: 'incorrect',
    requestId: crypto.randomUUID()
  });
  assert(!wrongPassword.ok && wrongPassword.code === 'INVALID_CURRENT_PASSWORD', 'email change must require the current password');

  const emailChange = await updateAccountEmail({
    userId: user.id,
    email: `after-${suffix}@example.test`,
    currentPassword: 'Initial password 1',
    requestId: crypto.randomUUID()
  });
  assert(emailChange.ok, 'email change should succeed with the current password');

  const first = await issuePasswordReset(`after-${suffix}@example.test`, crypto.randomUUID());
  const second = await issuePasswordReset(`after-${suffix}@example.test`, crypto.randomUUID());
  assert(first && second, 'active account must receive reset tokens');

  const firstRedeem = await redeemPasswordReset({ token: first.token, password: 'A fresh password 2', requestId: crypto.randomUUID(), ipAddress: null, userAgent: null });
  assert(!firstRedeem.ok && firstRedeem.code === 'TOKEN_INVALID', 'new request must revoke the prior token');

  const redeemed = await redeemPasswordReset({ token: second.token, password: 'A fresh password 2', requestId: crypto.randomUUID(), ipAddress: null, userAgent: null });
  assert(redeemed.ok, 'new reset token should redeem once');

  const [updatedUser, sessions, token] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true, passwordHash: true } }),
    prisma.userSession.findMany({ where: { userId: user.id }, select: { revokedAt: true } }),
    prisma.passwordResetToken.findUniqueOrThrow({ where: { id: second.id }, select: { usedAt: true, revokedAt: true } })
  ]);
  assert(updatedUser.email === `after-${suffix}@example.test`, 'recovery email must be stored on User');
  assert(await argon2.verify(updatedUser.passwordHash!, 'A fresh password 2'), 'password must be replaced');
  assert(sessions.every((session) => session.revokedAt !== null), 'password reset must revoke every previous session');
  assert(token.usedAt !== null && token.revokedAt === null, 'redeemed token must be one-time used');
  console.log('account recovery regression check passed');
}

main().finally(() => prisma.$disconnect());
