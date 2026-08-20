import { randomInt, createHmac } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { activationTokenHmacKey } from '@/lib/activation-secret';
import { SESSION_DURATION_MS, generateSessionToken, hashSessionToken } from '@/lib/session';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.1 "ActivationToken" +
// 04_ADMIN_FIRST_API_CONTRACTS.md §1/§5 — owner-confirmed activation vertical slice checkpoint.
// Code: 10 chars, Crockford Base32 (no I/L/O/U), generated only via node:crypto (randomInt, never
// Math.random). Display grouping "XXXX-XXXX-XX" is cosmetic only — QR and manual entry both
// normalize (strip hyphens/spaces, uppercase) to the same 10-char code before hashing, so they
// always produce the same tokenHash.

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;
const CROCKFORD_PATTERN = new RegExp(`^[${CROCKFORD_ALPHABET}]{${CODE_LENGTH}}$`);
const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
// Owner-approved minimum shared by worker/foreman activation and administrative CLI flows.
export const MIN_PASSWORD_LENGTH = 8;

export function generateActivationCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CROCKFORD_ALPHABET[randomInt(0, CROCKFORD_ALPHABET.length)];
  }
  return code;
}

export function formatActivationCodeForDisplay(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 10)}`;
}

/** Strips hyphens/spaces, uppercases, and validates against the Crockford alphabet + exact length. Returns null (not throws) on any malformed input — callers map that to TOKEN_INVALID. */
export function normalizeActivationCode(input: string): string | null {
  const stripped = input.replace(/[-\s]/g, '').toUpperCase();
  return CROCKFORD_PATTERN.test(stripped) ? stripped : null;
}

/** HMAC-SHA256(ACTIVATION_TOKEN_HMAC_KEY, normalizedCode) — deterministic, enables the equality lookup GET /api/auth/activate needs (unlike Argon2id, which re-salts every call). Never logs the code or the resulting hash — callers must not pass either to createAuditEvent/console. */
export function hashActivationCode(normalizedCode: string): string {
  return createHmac('sha256', activationTokenHmacKey()).update(normalizedCode).digest('hex');
}

export type IssueActivationTokenError = { code: 'WORKER_NOT_FOUND' } | { code: 'WORKER_ALREADY_ACTIVE' } | { code: 'SETUP_INCOMPLETE' };

export interface IssueActivationTokenResult {
  activationCode: string;
  activationExpiresAt: string;
}

/**
 * 02_ROLE_PERMISSION_MATRIX.md §2.2 `worker.activation.generate` + owner-confirmed issuance
 * transaction: lock Employee FOR UPDATE and re-check User.status + active employment under that
 * lock. Site assignment/payroll setup is deliberately not an activation prerequisite: account
 * ownership may be established before the owner finishes operational setup. Then expire past-due
 * PENDING, revoke any remaining live PENDING, create the new PENDING row, write
 * ACTIVATION_TOKEN_ISSUED — all one transaction, so two concurrent issuance requests for the same
 * employee serialize on the Employee row lock and never both reach the partial-unique-index
 * insert unresolved.
 */
export async function issueActivationToken(employeeId: string, actorUserId: string, requestId: string): Promise<IssueActivationTokenResult | IssueActivationTokenError> {
  const outcome = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    if (lockedRows.length === 0) {
      return { code: 'WORKER_NOT_FOUND' as const };
    }

    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        user: { select: { status: true } },
        employments: { orderBy: { createdAt: 'desc' }, take: 1, select: { active: true } }
      }
    });

    if (employee.user?.status === 'ACTIVE') {
      return { code: 'WORKER_ALREADY_ACTIVE' as const };
    }

    const employmentActive = employee.employments[0]?.active ?? false;
    if (employee.user?.status !== 'PENDING_ACTIVATION' || !employmentActive) {
      return { code: 'SETUP_INCOMPLETE' as const };
    }

    const now = new Date();
    await tx.activationToken.updateMany({ where: { employeeId, status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    await tx.activationToken.updateMany({ where: { employeeId, status: 'PENDING' }, data: { status: 'REVOKED' } });

    const code = generateActivationCode();
    const tokenHash = hashActivationCode(code);
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    await tx.activationToken.create({ data: { employeeId, tokenHash, status: 'PENDING', expiresAt, createdByUserId: actorUserId } });

    // Never include the raw code or tokenHash in the audit trail (owner instruction).
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'ACTIVATION_TOKEN_ISSUED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      requestId,
      beforeValue: null,
      afterValue: { expiresAt: expiresAt.toISOString() }
    });

    return { code: 'ISSUED' as const, activationCode: code, activationExpiresAt: expiresAt.toISOString() };
  });

  if (outcome.code === 'ISSUED') {
    return { activationCode: outcome.activationCode, activationExpiresAt: outcome.activationExpiresAt };
  }
  return outcome;
}

export type VerifyActivationTokenError = { code: 'TOKEN_EXPIRED' } | { code: 'TOKEN_USED' } | { code: 'TOKEN_INVALID' };

export interface VerifyActivationTokenResult {
  employeeFirstName: string;
  employeeLastNameInitial: string;
}

/**
 * 04_ADMIN_FIRST_API_CONTRACTS.md §1 `GET /api/auth/activate` semantics, owner-confirmed:
 * PENDING+not-expired -> valid; PENDING+expired -> atomically flip to EXPIRED and report
 * TOKEN_EXPIRED (self-heals a token whose issuance transaction never got a chance to expire it
 * lazily); EXPIRED -> TOKEN_EXPIRED; USED -> TOKEN_USED; REVOKED and unknown hash both -> generic
 * TOKEN_INVALID (no distinction — a revoked code shouldn't read differently from a fabricated one).
 */
export async function verifyActivationToken(rawCode: string): Promise<VerifyActivationTokenResult | VerifyActivationTokenError> {
  const normalized = normalizeActivationCode(rawCode);
  if (!normalized) {
    return { code: 'TOKEN_INVALID' };
  }
  const tokenHash = hashActivationCode(normalized);

  const outcome = await prisma.$transaction(async (tx) => {
    const token = await tx.activationToken.findUnique({
      where: { tokenHash },
      select: { id: true, status: true, expiresAt: true, employee: { select: { firstName: true, lastName: true } } }
    });
    if (!token) {
      return { code: 'TOKEN_INVALID' as const };
    }
    const activationNow = new Date();

    if (token.status === 'USED') {
      return { code: 'TOKEN_USED' as const };
    }
    if (token.status === 'REVOKED') {
      return { code: 'TOKEN_INVALID' as const };
    }
    if (token.status === 'EXPIRED') {
      return { code: 'TOKEN_EXPIRED' as const };
    }
    if (token.expiresAt <= activationNow) {
      await tx.activationToken.update({ where: { id: token.id }, data: { status: 'EXPIRED' } });
      return { code: 'TOKEN_EXPIRED' as const };
    }
    return {
      code: 'VALID' as const,
      employeeFirstName: token.employee.firstName,
      employeeLastNameInitial: `${token.employee.lastName.charAt(0).toUpperCase()}.`
    };
  });

  if (outcome.code === 'VALID') {
    return { employeeFirstName: outcome.employeeFirstName, employeeLastNameInitial: outcome.employeeLastNameInitial };
  }
  return outcome;
}

export type SetInitialPasswordError =
  | { code: 'TOKEN_EXPIRED' }
  | { code: 'TOKEN_USED' }
  | { code: 'TOKEN_INVALID' }
  | { code: 'ACCOUNT_NOT_ELIGIBLE' }
  | { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

export interface SetInitialPasswordResult {
  user: { id: string; username: string; roles: string[]; locale: string };
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * POST /api/auth/set-initial-password, owner-confirmed transaction (point 7): re-verify the token
 * under FOR UPDATE (not trusting the earlier GET /api/auth/activate call, since time may have
 * passed — "истечение между GET activate и POST set-password"), re-check Employment.active +
 * User.status = PENDING_ACTIVATION are still true (point 8 — a worker deactivated in that same
 * window must not be reactivated), set the Argon2id passwordHash, flip User.status -> ACTIVE,
 * ensure an active WORKER UserRole exists (createWorker/POST /api/admin/workers never assigns one
 * today — without this, auto-login would return a user with zero roles and no access to
 * /worker/*), flip the token to USED+usedAt, create the auto-login UserSession, and write
 * ACCOUNT_ACTIVATED — all one transaction. The caller (route handler) only sets the session cookie
 * after this resolves successfully, never before.
 */
export async function setInitialPassword(
  rawCode: string,
  password: string,
  requestId: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<SetInitialPasswordResult | SetInitialPasswordError> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { code: 'VALIDATION_ERROR', fieldErrors: { password: [`must be at least ${MIN_PASSWORD_LENGTH} characters`] } };
  }
  const normalized = normalizeActivationCode(rawCode);
  if (!normalized) {
    return { code: 'TOKEN_INVALID' };
  }
  const tokenHash = hashActivationCode(normalized);

  // Reject fabricated/expired/used codes before paying the Argon2 cost. The token is locked and
  // checked again below, so this is only a cheap abuse guard — never an authorization decision.
  const preflight = await verifyActivationToken(normalized);
  if ('code' in preflight) {
    return preflight;
  }

  // Argon2id hashing is deliberately done before opening the transaction (it's CPU/memory-heavy,
  // ~100ms+) so the FOR UPDATE lock below is held for as short a time as possible.
  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const outcome = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ActivationToken" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    if (lockedRows.length === 0) {
      return { code: 'TOKEN_INVALID' as const };
    }

    const token = await tx.activationToken.findUniqueOrThrow({
      where: { tokenHash },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        employee: {
          select: {
            user: { select: { id: true, username: true, locale: true, status: true } },
            employments: { orderBy: { createdAt: 'desc' }, take: 1, select: { active: true } }
          }
        }
      }
    });
    const activationNow = new Date();

    if (token.status === 'USED') {
      return { code: 'TOKEN_USED' as const };
    }
    if (token.status === 'REVOKED') {
      return { code: 'TOKEN_INVALID' as const };
    }
    if (token.status === 'EXPIRED' || token.expiresAt <= activationNow) {
      if (token.status === 'PENDING') {
        await tx.activationToken.update({ where: { id: token.id }, data: { status: 'EXPIRED' } });
      }
      return { code: 'TOKEN_EXPIRED' as const };
    }

    const user = token.employee.user;
    const employmentActive = token.employee.employments[0]?.active ?? false;
    if (!user || user.status !== 'PENDING_ACTIVATION' || !employmentActive) {
      return { code: 'ACCOUNT_NOT_ELIGIBLE' as const };
    }

    await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', passwordHash } });

    const workerRole = await tx.role.findUniqueOrThrow({ where: { name: 'WORKER' } });
    const existingWorkerRole = await tx.userRole.findFirst({ where: { userId: user.id, roleId: workerRole.id, validTo: null } });
    if (!existingWorkerRole) {
      await tx.userRole.create({ data: { userId: user.id, roleId: workerRole.id } });
    }

    await tx.activationToken.update({ where: { id: token.id }, data: { status: 'USED', usedAt: activationNow } });

    const sessionToken = generateSessionToken();
    const sessionTokenHash = hashSessionToken(sessionToken);
    const sessionExpiresAt = new Date(activationNow.getTime() + SESSION_DURATION_MS);
    await tx.userSession.create({
      data: {
        userId: user.id,
        tokenHash: sessionTokenHash,
        authLevel: 'PASSWORD',
        expiresAt: sessionExpiresAt,
        lastSeenAt: activationNow,
        ipAddress,
        userAgent
      }
    });

    await createAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'ACCOUNT_ACTIVATED',
      entityType: 'AUTHENTICATION',
      entityId: user.id,
      requestId,
      beforeValue: { status: 'PENDING_ACTIVATION' },
      afterValue: { status: 'ACTIVE' }
    });

    const activeRoles = await tx.userRole.findMany({ where: { userId: user.id, validTo: null }, include: { role: true } });

    return {
      code: 'ACTIVATED' as const,
      user: { id: user.id, username: user.username, roles: activeRoles.map((r) => r.role.name), locale: user.locale },
      sessionToken,
      sessionExpiresAt
    };
  });

  if (outcome.code !== 'ACTIVATED') {
    return outcome;
  }
  return { user: outcome.user, sessionToken: outcome.sessionToken, sessionExpiresAt: outcome.sessionExpiresAt };
}
