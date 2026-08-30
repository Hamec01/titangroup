import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { MIN_PASSWORD_LENGTH } from '@/lib/activation';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 255;

export interface AccountSettings {
  username: string;
  email: string | null;
  roles: string[];
  lastLoginAt: string | null;
}

export function normalizeAccountEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(normalized) ? normalized : null;
}

export async function getAccountSettings(userId: string): Promise<AccountSettings | null> {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      email: true,
      lastLoginAt: true,
      userRoles: {
        where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
        select: { role: { select: { name: true } } }
      }
    }
  });
  return user
    ? {
        username: user.username,
        email: user.email,
        roles: user.userRoles.map((item) => item.role.name),
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null
      }
    : null;
}

export type UpdateAccountEmailResult =
  | { ok: true; email: string }
  | { ok: false; code: 'INVALID_CURRENT_PASSWORD' | 'EMAIL_IN_USE' | 'ACCOUNT_NOT_ELIGIBLE' };

/** Updating a recovery address requires the current password and never audits the address itself. */
export async function updateAccountEmail(input: {
  userId: string;
  email: string;
  currentPassword: string;
  requestId: string;
}): Promise<UpdateAccountEmailResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${input.userId}::uuid FOR UPDATE`;
      if (lockedRows.length === 0) return { ok: false, code: 'ACCOUNT_NOT_ELIGIBLE' as const };

      const user = await tx.user.findUniqueOrThrow({
        where: { id: input.userId },
        select: { id: true, email: true, passwordHash: true, userKind: true }
      });
      if (user.userKind !== 'HUMAN' || !user.passwordHash) return { ok: false, code: 'ACCOUNT_NOT_ELIGIBLE' as const };

      const argon2 = await import('argon2');
      const passwordMatches = await argon2.verify(user.passwordHash, input.currentPassword).catch(() => false);
      if (!passwordMatches) return { ok: false, code: 'INVALID_CURRENT_PASSWORD' as const };

      await tx.user.update({ where: { id: user.id }, data: { email: input.email } });
      await createAuditEvent(tx, {
        actorUserId: user.id,
        eventType: 'ACCOUNT_RECOVERY_EMAIL_UPDATED',
        entityType: 'USER',
        entityId: user.id,
        requestId: input.requestId,
        beforeValue: { emailPresent: user.email !== null },
        afterValue: { emailPresent: true }
      });
      return { ok: true, email: input.email };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, code: 'EMAIL_IN_USE' };
    }
    throw error;
  }
}

export const MAX_PASSWORD_LENGTH = 256;

export type ChangeAccountPasswordResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_CURRENT_PASSWORD' | 'SAME_AS_CURRENT' | 'VALIDATION_ERROR' | 'ACCOUNT_NOT_ELIGIBLE' };

/**
 * Change one's own password using the current one. Keeps the caller's session and revokes every
 * OTHER active session (a password change should sign the account out of any other device). Never
 * audits the password itself.
 */
export async function changeAccountPassword(input: {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
  newPassword: string;
  requestId: string;
}): Promise<ChangeAccountPasswordResult> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH || input.newPassword.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${input.userId}::uuid FOR UPDATE`;
    if (locked.length === 0) return { ok: false, code: 'ACCOUNT_NOT_ELIGIBLE' as const };

    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { id: true, passwordHash: true, userKind: true }
    });
    if (user.userKind !== 'HUMAN' || !user.passwordHash) return { ok: false, code: 'ACCOUNT_NOT_ELIGIBLE' as const };

    const argon2 = await import('argon2');
    if (!(await argon2.verify(user.passwordHash, input.currentPassword).catch(() => false))) {
      return { ok: false, code: 'INVALID_CURRENT_PASSWORD' as const };
    }
    if (await argon2.verify(user.passwordHash, input.newPassword).catch(() => false)) {
      return { ok: false, code: 'SAME_AS_CURRENT' as const };
    }

    const now = new Date();
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(input.newPassword, { type: argon2.argon2id }) } });
    const revoked = await tx.userSession.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: input.currentSessionId } },
      data: { revokedAt: now }
    });
    await createAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'PASSWORD_CHANGED',
      entityType: 'USER',
      entityId: user.id,
      requestId: input.requestId,
      afterValue: { otherSessionsRevoked: revoked.count }
    });
    return { ok: true };
  });
}
