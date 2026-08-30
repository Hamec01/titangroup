import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { MIN_PASSWORD_LENGTH } from '@/lib/activation';
import { passwordResetTokenHmacKey } from '@/lib/password-reset-secret';

// R03 — admin-assisted account recovery, no SMTP (TZ §7).
//
// The admin presses "Restore access" on a user/worker card; the system shows a one-time code
// ONCE. The user types their login + that code + a new password on /reset-password. On success
// every prior session is revoked. Codes are stored only as HMAC-SHA256; the raw value never
// touches the database or the logs.

export const RECOVERY_CODE_TTL_MS = 45 * 60 * 1000;
export const RECOVERY_MAX_ATTEMPTS = 5;

// Crockford base32 — no I, L, O, U (so it can be read aloud without ambiguity). 12 chars ~= 60 bits.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;

/** A fresh recovery code, grouped for legibility: `K7M4-9QX2-P3RF`. */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Canonicalise whatever the user typed (spaces, dashes, look-alikes) → 12 uppercase chars, or null. */
export function normalizeRecoveryCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return cleaned;
}

function hashRecoveryCode(canonicalCode: string): string {
  return createHmac('sha256', passwordResetTokenHmacKey()).update(canonicalCode).digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export type IssueAccountRecoveryResult =
  | { ok: true; code: string; expiresAt: Date }
  | { ok: false; code: 'TARGET_NOT_ELIGIBLE' };

/**
 * Issue a one-time recovery code for an ACTIVE/OFFBOARDING human account and revoke any code
 * issued earlier. `issuedByUserId` is the admin who confirmed the action; it is recorded but the
 * raw code is returned only here and never persisted or audited.
 */
export async function issueAccountRecovery(input: {
  targetUserId: string;
  issuedByUserId: string;
  requestId: string;
}): Promise<IssueAccountRecoveryResult> {
  const target = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, status: true, userKind: true }
  });
  if (!target || target.userKind !== 'HUMAN' || (target.status !== 'ACTIVE' && target.status !== 'OFFBOARDING')) {
    return { ok: false, code: 'TARGET_NOT_ELIGIBLE' };
  }

  const code = generateRecoveryCode();
  const tokenHash = hashRecoveryCode(normalizeRecoveryCode(code)!);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RECOVERY_CODE_TTL_MS);

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${target.id}::uuid FOR UPDATE`;
    await tx.passwordResetToken.updateMany({
      where: { userId: target.id, usedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    await tx.passwordResetToken.create({
      data: { userId: target.id, tokenHash, expiresAt, issuedByUserId: input.issuedByUserId }
    });
    await createAuditEvent(tx, {
      actorUserId: input.issuedByUserId,
      eventType: 'ACCOUNT_RECOVERY_ISSUED',
      entityType: 'USER',
      entityId: target.id,
      requestId: input.requestId,
      afterValue: { expiresAt: expiresAt.toISOString(), issuedByUserId: input.issuedByUserId }
    });
  });

  return { ok: true, code, expiresAt };
}

export type RedeemAccountRecoveryResult =
  | { ok: true; user: { id: string; username: string; roles: string[]; locale: string } }
  | { ok: false; code: 'INVALID' | 'EXPIRED' | 'VALIDATION_ERROR' };

/**
 * Redeem a recovery code with the account's own login. Every failure that is not a password-policy
 * problem returns 'INVALID' or 'EXPIRED' with an identical caller-facing message — the endpoint
 * must not reveal whether a login exists or whether a code is outstanding (TZ §7.2).
 */
export async function redeemAccountRecovery(input: {
  login: string;
  code: string;
  password: string;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<RedeemAccountRecoveryResult> {
  const normalizedLogin = input.login.trim().toLowerCase();
  const normalizedCode = normalizeRecoveryCode(input.code);
  if (!normalizedLogin || !normalizedCode) return { ok: false, code: 'INVALID' };
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 256) {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: normalizedLogin }, { email: normalizedLogin }] },
    select: { id: true }
  });
  if (!user) return { ok: false, code: 'INVALID' };

  const argon2 = await import('argon2');
  const codeHash = hashRecoveryCode(normalizedCode);

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
    if (locked.length === 0) return { ok: false, code: 'INVALID' as const };

    const token = await tx.passwordResetToken.findFirst({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tokenHash: true,
        expiresAt: true,
        attemptCount: true,
        user: {
          select: {
            id: true, username: true, locale: true, status: true, userKind: true,
            userRoles: { select: { validFrom: true, validTo: true, role: { select: { name: true } } } }
          }
        }
      }
    });
    if (!token) return { ok: false, code: 'INVALID' as const };
    await tx.$queryRaw`SELECT id FROM "PasswordResetToken" WHERE id = ${token.id}::uuid FOR UPDATE`;

    const now = new Date();

    if (!hashesMatch(codeHash, token.tokenHash)) {
      const attempts = token.attemptCount + 1;
      const exhausted = attempts >= RECOVERY_MAX_ATTEMPTS;
      await tx.passwordResetToken.update({
        where: { id: token.id },
        data: { attemptCount: attempts, ...(exhausted ? { revokedAt: now } : {}) }
      });
      if (exhausted) {
        await createAuditEvent(tx, {
          actorUserId: token.user.id,
          eventType: 'ACCOUNT_RECOVERY_LOCKED',
          entityType: 'USER',
          entityId: token.user.id,
          requestId: input.requestId,
          afterValue: { attemptCount: attempts }
        });
      }
      return { ok: false, code: 'INVALID' as const };
    }

    if (token.expiresAt <= now) {
      await tx.passwordResetToken.update({ where: { id: token.id }, data: { revokedAt: now } });
      return { ok: false, code: 'EXPIRED' as const };
    }
    if (token.user.userKind !== 'HUMAN' || (token.user.status !== 'ACTIVE' && token.user.status !== 'OFFBOARDING')) {
      return { ok: false, code: 'INVALID' as const };
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await tx.user.update({ where: { id: token.user.id }, data: { passwordHash } });
    await tx.userSession.updateMany({ where: { userId: token.user.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: now } });

    await createAuditEvent(tx, {
      actorUserId: token.user.id,
      eventType: 'ACCOUNT_RECOVERY_COMPLETED',
      entityType: 'USER',
      entityId: token.user.id,
      requestId: input.requestId,
      afterValue: { allPreviousSessionsRevoked: true }
    });

    const roles = token.user.userRoles
      .filter((r) => r.validFrom <= now && (r.validTo === null || r.validTo > now))
      .map((r) => r.role.name);
    return { ok: true, user: { id: token.user.id, username: token.user.username, roles, locale: token.user.locale } };
  });
}
