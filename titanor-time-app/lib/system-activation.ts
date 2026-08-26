import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { generateActivationCode, formatActivationCodeForDisplay, normalizeActivationCode, hashActivationCode, MIN_PASSWORD_LENGTH } from '@/lib/activation';
import { SESSION_DURATION_MS, generateSessionToken, hashSessionToken } from '@/lib/session';

// docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.12 + 04_ADMIN_FIRST_API_CONTRACTS.md — credential
// vertical slice for a standalone User (created via POST /api/admin/users, mode STANDALONE —
// employeeId IS NULL — for FOREMAN, or POST /api/admin/users/admins for ADMIN). Deliberately
// separate from lib/activation.ts's worker flow: reuses its crypto/session primitives
// (generateActivationCode, formatActivationCodeForDisplay, normalizeActivationCode,
// hashActivationCode, ACTIVATION_TOKEN_HMAC_KEY via those helpers, generateSessionToken/
// hashSessionToken) but never touches ActivationToken, worker eligibility, or
// setInitialPassword — this module only ever reads/writes UserActivationToken + User rows where
// employeeId IS NULL.
//
// STANDALONE_ELIGIBLE_ROLES was originally FOREMAN-only (this module predates admin creation);
// createStandaloneAdmin (lib/users.ts) later added a second standalone-user path assigning
// ADMIN, but this eligibility gate was never updated to match — a SUPER_ADMIN-created second
// admin got permanently stuck PENDING_ACTIVATION with no way to ever receive an activation code.
// Fixed here. SUPER_ADMIN itself is out of scope: it is only ever created via the bootstrap CLI,
// which sets a password directly and never goes through this token flow at all.

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const STANDALONE_ELIGIBLE_ROLES = new Set(['FOREMAN', 'ADMIN']);

function currentStandaloneRoleWhere(now: Date) {
  return (ur: { validFrom: Date; validTo: Date | null; role: { name: string } }) =>
    STANDALONE_ELIGIBLE_ROLES.has(ur.role.name) && ur.validFrom <= now && (ur.validTo === null || ur.validTo > now);
}

export type IssueSystemActivationTokenError =
  | { code: 'USER_NOT_FOUND' }
  | { code: 'USER_ALREADY_ACTIVE' }
  | { code: 'USER_USES_WORKER_ACTIVATION' }
  | { code: 'SYSTEM_USER_NOT_ELIGIBLE' }
  | { code: 'ACCOUNT_NOT_ELIGIBLE' };

export interface IssueSystemActivationTokenResult {
  activationCode: string;
  activationExpiresAt: string;
}

/**
 * Lock User FOR UPDATE first (same lock order redeemAccountPassword below uses), re-check
 * eligibility under that lock, expire any past-due PENDING, revoke any remaining live PENDING,
 * create the new PENDING row, write USER_ACTIVATION_TOKEN_ISSUED — one transaction, so a
 * concurrent issue/reissue for the same userId serializes on the User row lock.
 */
export async function issueSystemActivationToken(userId: string, actorUserId: string, requestId: string): Promise<IssueSystemActivationTokenResult | IssueSystemActivationTokenError> {
  const outcome = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    if (lockedRows.length === 0) {
      return { code: 'USER_NOT_FOUND' as const };
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        employeeId: true,
        status: true,
        passwordHash: true,
        userKind: true,
        userRoles: { select: { validFrom: true, validTo: true, role: { select: { name: true } } } }
      }
    });

    // T7A §13/§15 — the reserved SYSTEM actor can never be issued an activation token; checked
    // before every other branch so it can never be misreported as an ordinary ineligible account.
    if (user.userKind !== 'HUMAN') {
      return { code: 'SYSTEM_USER_NOT_ELIGIBLE' as const };
    }

    // employeeId check comes first — a worker User must always be reported as
    // USER_USES_WORKER_ACTIVATION, never USER_ALREADY_ACTIVE, regardless of its status.
    if (user.employeeId !== null) {
      return { code: 'USER_USES_WORKER_ACTIVATION' as const };
    }
    if (user.status === 'ACTIVE') {
      return { code: 'USER_ALREADY_ACTIVE' as const };
    }

    const now = new Date();
    const hasEligibleStandaloneRole = user.userRoles.some(currentStandaloneRoleWhere(now));
    if (user.status !== 'PENDING_ACTIVATION' || user.passwordHash !== null || !hasEligibleStandaloneRole) {
      return { code: 'ACCOUNT_NOT_ELIGIBLE' as const };
    }

    await tx.userActivationToken.updateMany({ where: { userId, status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    await tx.userActivationToken.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'REVOKED' } });

    const code = generateActivationCode();
    const tokenHash = hashActivationCode(code);
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    await tx.userActivationToken.create({ data: { userId, tokenHash, status: 'PENDING', expiresAt, createdByUserId: actorUserId } });

    // Never include the raw code or tokenHash in the audit trail (same rule as worker activation).
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'USER_ACTIVATION_TOKEN_ISSUED',
      entityType: 'USER',
      entityId: userId,
      requestId,
      beforeValue: null,
      afterValue: { expiresAt: expiresAt.toISOString() }
    });

    return { code: 'ISSUED' as const, activationCode: code, activationExpiresAt: expiresAt.toISOString() };
  });

  if (outcome.code === 'ISSUED') {
    return { activationCode: formatActivationCodeForDisplay(outcome.activationCode), activationExpiresAt: outcome.activationExpiresAt };
  }
  return outcome;
}

export type VerifySystemActivationTokenError = { code: 'TOKEN_EXPIRED' } | { code: 'TOKEN_USED' } | { code: 'TOKEN_INVALID' };

export interface VerifySystemActivationTokenResult {
  username: string;
  locale: string;
}

/**
 * PENDING+not-expired -> valid; PENDING+expired -> atomically flip to EXPIRED and report
 * TOKEN_EXPIRED; EXPIRED -> TOKEN_EXPIRED; USED -> TOKEN_USED; REVOKED and unknown hash both ->
 * generic TOKEN_INVALID — same semantics as verifyActivationToken (lib/activation.ts), against
 * UserActivationToken instead of ActivationToken. Never returns email, roles, passwordHash, or
 * tokenHash.
 */
export async function verifySystemActivationToken(rawCode: string): Promise<VerifySystemActivationTokenResult | VerifySystemActivationTokenError> {
  const normalized = normalizeActivationCode(rawCode);
  if (!normalized) {
    return { code: 'TOKEN_INVALID' };
  }
  const tokenHash = hashActivationCode(normalized);

  const outcome = await prisma.$transaction(async (tx) => {
    const token = await tx.userActivationToken.findUnique({
      where: { tokenHash },
      select: { id: true, status: true, expiresAt: true, user: { select: { username: true, locale: true } } }
    });
    if (!token) {
      return { code: 'TOKEN_INVALID' as const };
    }
    const now = new Date();

    if (token.status === 'USED') {
      return { code: 'TOKEN_USED' as const };
    }
    if (token.status === 'REVOKED') {
      return { code: 'TOKEN_INVALID' as const };
    }
    if (token.status === 'EXPIRED') {
      return { code: 'TOKEN_EXPIRED' as const };
    }
    if (token.expiresAt <= now) {
      await tx.userActivationToken.update({ where: { id: token.id }, data: { status: 'EXPIRED' } });
      return { code: 'TOKEN_EXPIRED' as const };
    }
    return { code: 'VALID' as const, username: token.user.username, locale: token.user.locale };
  });

  if (outcome.code === 'VALID') {
    return { username: outcome.username, locale: outcome.locale };
  }
  return outcome;
}

export type SetAccountPasswordError =
  | { code: 'TOKEN_EXPIRED' }
  | { code: 'TOKEN_USED' }
  | { code: 'TOKEN_INVALID' }
  | { code: 'SYSTEM_USER_NOT_ELIGIBLE' }
  | { code: 'ACCOUNT_NOT_ELIGIBLE' }
  | { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

export interface SetAccountPasswordResult {
  user: { id: string; username: string; roles: string[]; locale: string };
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * Lock order matches issueSystemActivationToken: User FOR UPDATE first, then
 * UserActivationToken FOR UPDATE — so a concurrent issue/reissue and a concurrent redeem always
 * serialize the same way and never deadlock. A cheap unlocked preflight lookup (by tokenHash)
 * determines which User row to lock; nothing from it is trusted for the actual decision — status,
 * expiry, and User eligibility are all re-read after both locks are held.
 */
export async function setAccountPassword(
  rawCode: string,
  password: string,
  requestId: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<SetAccountPasswordResult | SetAccountPasswordError> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { code: 'VALIDATION_ERROR', fieldErrors: { password: [`must be at least ${MIN_PASSWORD_LENGTH} characters`] } };
  }
  const normalized = normalizeActivationCode(rawCode);
  if (!normalized) {
    return { code: 'TOKEN_INVALID' };
  }
  const tokenHash = hashActivationCode(normalized);

  const preflight = await prisma.userActivationToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if (!preflight) {
    return { code: 'TOKEN_INVALID' };
  }

  // Argon2id hashing is deliberately done before opening the transaction (CPU/memory-heavy) so
  // both FOR UPDATE locks below are held for as short a time as possible.
  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const outcome = await prisma.$transaction(async (tx) => {
    const lockedUserRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${preflight.userId}::uuid FOR UPDATE`;
    if (lockedUserRows.length === 0) {
      return { code: 'TOKEN_INVALID' as const };
    }
    const lockedTokenRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "UserActivationToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    if (lockedTokenRows.length === 0) {
      return { code: 'TOKEN_INVALID' as const };
    }

    const token = await tx.userActivationToken.findUniqueOrThrow({
      where: { tokenHash },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        user: {
          select: {
            id: true,
            username: true,
            locale: true,
            status: true,
            employeeId: true,
            passwordHash: true,
            userKind: true,
            userRoles: { select: { validFrom: true, validTo: true, role: { select: { name: true } } } }
          }
        }
      }
    });
    const now = new Date();

    if (token.status === 'USED') {
      return { code: 'TOKEN_USED' as const };
    }
    if (token.status === 'REVOKED') {
      return { code: 'TOKEN_INVALID' as const };
    }
    if (token.status === 'EXPIRED' || token.expiresAt <= now) {
      if (token.status === 'PENDING') {
        await tx.userActivationToken.update({ where: { id: token.id }, data: { status: 'EXPIRED' } });
      }
      return { code: 'TOKEN_EXPIRED' as const };
    }

    const user = token.user;
    // T7A §13/§15 — last line of defense before a passwordHash would be written to the reserved
    // SYSTEM actor and a session auto-created below; checked even though issueSystemActivationToken
    // should already prevent a token from ever existing for it.
    if (user.userKind !== 'HUMAN') {
      return { code: 'SYSTEM_USER_NOT_ELIGIBLE' as const };
    }
    const hasEligibleStandaloneRole = user.userRoles.some(currentStandaloneRoleWhere(now));
    if (user.employeeId !== null || user.status !== 'PENDING_ACTIVATION' || user.passwordHash !== null || !hasEligibleStandaloneRole) {
      return { code: 'ACCOUNT_NOT_ELIGIBLE' as const };
    }

    await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', passwordHash } });
    // The current FOREMAN/ADMIN role checked above already exists — never created or duplicated here.

    await tx.userActivationToken.update({ where: { id: token.id }, data: { status: 'USED', usedAt: now } });

    const sessionToken = generateSessionToken();
    const sessionTokenHash = hashSessionToken(sessionToken);
    const sessionExpiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
    await tx.userSession.create({
      data: {
        userId: user.id,
        tokenHash: sessionTokenHash,
        authLevel: 'PASSWORD',
        expiresAt: sessionExpiresAt,
        lastSeenAt: now,
        ipAddress,
        userAgent
      }
    });

    await createAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'ACCOUNT_ACTIVATED',
      entityType: 'USER',
      entityId: user.id,
      requestId,
      beforeValue: { status: 'PENDING_ACTIVATION' },
      afterValue: { status: 'ACTIVE' }
    });

    const activeRoleNames = user.userRoles.filter((ur) => ur.validFrom <= now && (ur.validTo === null || ur.validTo > now)).map((ur) => ur.role.name);

    return {
      code: 'ACTIVATED' as const,
      user: { id: user.id, username: user.username, roles: activeRoleNames, locale: user.locale },
      sessionToken,
      sessionExpiresAt
    };
  });

  if (outcome.code !== 'ACTIVATED') {
    return outcome;
  }
  return { user: outcome.user, sessionToken: outcome.sessionToken, sessionExpiresAt: outcome.sessionExpiresAt };
}
