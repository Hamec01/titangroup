import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { MIN_PASSWORD_LENGTH } from '@/lib/activation';
import { passwordResetTokenHmacKey } from '@/lib/password-reset-secret';

const TOKEN_TTL_MS = 60 * 60 * 1000;

export function generatePasswordResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashPasswordResetToken(rawToken: string): string {
  return createHmac('sha256', passwordResetTokenHmacKey()).update(rawToken).digest('hex');
}

export interface IssuedPasswordReset {
  id: string;
  userId: string;
  token: string;
  email: string;
  username: string;
}

/** Returns null for an unknown/ineligible account to keep the public endpoint non-enumerating. */
export async function issuePasswordReset(email: string, requestId: string): Promise<IssuedPasswordReset | null> {
  const user = await prisma.user.findFirst({
    where: { email, userKind: 'HUMAN', status: { in: ['ACTIVE', 'OFFBOARDING'] } },
    select: { id: true, email: true, username: true }
  });
  if (!user?.email) return null;

  const token = generatePasswordResetToken();
  const tokenHash = hashPasswordResetToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  const issued = await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    const reset = await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
    await createAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'PASSWORD_RESET_REQUESTED',
      entityType: 'USER',
      entityId: user.id,
      requestId,
      afterValue: { expiresAt: expiresAt.toISOString() }
    });
    return reset;
  });

  return { id: issued.id, userId: user.id, token, email: user.email, username: user.username };
}

/** A delivery failure leaves no usable reset link, while retaining a safe audit event. */
export async function revokeUndeliveredPasswordReset(id: string, userId: string, requestId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({ where: { id, userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await createAuditEvent(tx, {
      actorUserId: userId,
      eventType: 'PASSWORD_RESET_DELIVERY_FAILED',
      entityType: 'USER',
      entityId: userId,
      requestId,
      afterValue: null
    });
  });
}

export type RedeemPasswordResetResult =
  | { ok: true; user: { id: string; username: string; roles: string[]; locale: string } }
  | { ok: false; code: 'TOKEN_EXPIRED' | 'TOKEN_USED' | 'TOKEN_INVALID' | 'ACCOUNT_NOT_ELIGIBLE' | 'VALIDATION_ERROR' };

export async function redeemPasswordReset(input: {
  token: string;
  password: string;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<RedeemPasswordResetResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 256) {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }
  const tokenHash = hashPasswordResetToken(input.token);
  const preflight = await prisma.passwordResetToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if (!preflight) return { ok: false, code: 'TOKEN_INVALID' };

  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  return prisma.$transaction(async (tx) => {
    const lockedUsers = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${preflight.userId}::uuid FOR UPDATE`;
    if (lockedUsers.length === 0) return { ok: false, code: 'TOKEN_INVALID' as const };
    const lockedTokens = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PasswordResetToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    if (lockedTokens.length === 0) return { ok: false, code: 'TOKEN_INVALID' as const };

    const reset = await tx.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash },
      select: {
        id: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true, username: true, locale: true, status: true, userKind: true,
            userRoles: { select: { validFrom: true, validTo: true, role: { select: { name: true } } } }
          }
        }
      }
    });
    const now = new Date();
    if (reset.usedAt) return { ok: false, code: 'TOKEN_USED' as const };
    if (reset.revokedAt) return { ok: false, code: 'TOKEN_INVALID' as const };
    if (reset.expiresAt <= now) return { ok: false, code: 'TOKEN_EXPIRED' as const };
    if (reset.user.userKind !== 'HUMAN' || (reset.user.status !== 'ACTIVE' && reset.user.status !== 'OFFBOARDING')) {
      return { ok: false, code: 'ACCOUNT_NOT_ELIGIBLE' as const };
    }

    await tx.user.update({ where: { id: reset.user.id }, data: { passwordHash } });
    await tx.userSession.updateMany({ where: { userId: reset.user.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: now } });

    await createAuditEvent(tx, {
      actorUserId: reset.user.id,
      eventType: 'PASSWORD_RESET_COMPLETED',
      entityType: 'USER',
      entityId: reset.user.id,
      requestId: input.requestId,
      afterValue: { allPreviousSessionsRevoked: true }
    });

    const roles = reset.user.userRoles
      .filter((role) => role.validFrom <= now && (role.validTo === null || role.validTo > now))
      .map((role) => role.role.name);
    return { ok: true, user: { id: reset.user.id, username: reset.user.username, roles, locale: reset.user.locale } };
  });
}
