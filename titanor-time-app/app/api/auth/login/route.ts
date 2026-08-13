import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAuditEvent } from '@/lib/audit';
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  generateSessionToken,
  hashSessionToken
} from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0/§1 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_PASSWORD_LENGTH = 256;
const IDENTIFIER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };
const IP_RATE_LIMIT = { limit: 50, windowMs: 15 * 60 * 1000 };

// A real Argon2id hash of an unrelated, fixed string — can never match a real
// password. Verified against on every attempt where the identifier doesn't
// resolve to a user, so that case takes about as long as a real password
// check instead of returning early, which would otherwise let an attacker
// enumerate valid usernames/emails by response timing.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$hoBnOzNYf8zPdloDwuu8aw$M+azLBT3hoCxLpSpugR5fKKGiB1zfP1xvxuEgSfB8nA';

function clientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const first = forwardedFor?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

// Shared by both INVALID_CREDENTIALS paths below (unknown identifier, wrong
// password) — deliberately identical in both cases: no identifier, email,
// username, password, hash, cookie, token, IP, or user-agent is ever passed
// in, and actorUserId/entityId are always null, so the audit trail itself
// cannot be used to distinguish "no such account" from "wrong password" any
// more than the 401 response already can (docs/titanor-time/
// 04_ADMIN_FIRST_API_CONTRACTS.md §1: Audit LOGIN_FAILED). Own transaction
// (nothing else to be atomic with — no session is created on failure), still
// via createAuditEvent()'s required tx client, not the top-level `prisma`.
async function recordLoginFailed(requestId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await createAuditEvent(tx, {
      actorUserId: null,
      eventType: 'LOGIN_FAILED',
      entityType: 'AUTHENTICATION',
      entityId: null,
      requestId
    });
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(
      403,
      {
        code: 'CSRF_REJECTED',
        message: 'Missing or invalid X-Requested-With header.'
      },
      requestId
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(
      400,
      { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' },
      requestId
    );
  }

  const { identifier, password } = (body && typeof body === 'object' ? body : {}) as {
    identifier?: unknown;
    password?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    fieldErrors.identifier = ['required'];
  } else if (identifier.length > MAX_IDENTIFIER_LENGTH) {
    fieldErrors.identifier = ['too long'];
  }
  if (typeof password !== 'string' || password.length === 0) {
    fieldErrors.password = ['required'];
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.password = ['too long'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(
      400,
      { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors },
      requestId
    );
  }

  const normalizedIdentifier = (identifier as string).trim().toLowerCase();
  const ip = clientIp(request);

  const identifierAllowed = checkRateLimit(
    `identifier:${normalizedIdentifier}`,
    IDENTIFIER_RATE_LIMIT.limit,
    IDENTIFIER_RATE_LIMIT.windowMs
  );
  const ipAllowed = checkRateLimit(`ip:${ip ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs);
  if (!identifierAllowed || !ipAllowed) {
    return jsonError(
      429,
      { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' },
      requestId
    );
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ username: normalizedIdentifier }, { email: normalizedIdentifier }] }
  });

  const argon2 = await import('argon2');

  // A PENDING_ACTIVATION account has no passwordHash yet (it's set via the
  // separate set-initial-password + ActivationToken flow, not here) — so its
  // status must be checked before password verification, otherwise
  // ACCOUNT_PENDING_ACTIVATION could never actually be returned. The
  // "identifier doesn't resolve to a user" case still runs a dummy verify
  // for timing, since that's the one case with no account to reveal status of.
  if (!user) {
    await argon2.verify(DUMMY_PASSWORD_HASH, password as string).catch(() => false);
    await recordLoginFailed(requestId);
    return jsonError(
      401,
      { code: 'INVALID_CREDENTIALS', message: 'Invalid username/email or password.' },
      requestId
    );
  }

  // T7A §13 — the reserved SYSTEM actor must never be able to log in, independent of `status`.
  // Today `status=DEACTIVATED` already blocks it below, but that's incidental to status, not a
  // structural guarantee — this check doesn't rely on it. Same "don't reveal which accounts
  // exist" handling as the `!user` branch above: dummy verify (timing) + generic
  // INVALID_CREDENTIALS, never a dedicated code that would confirm system.scheduler exists.
  if (user.userKind !== 'HUMAN') {
    await argon2.verify(DUMMY_PASSWORD_HASH, password as string).catch(() => false);
    await recordLoginFailed(requestId);
    return jsonError(
      401,
      { code: 'INVALID_CREDENTIALS', message: 'Invalid username/email or password.' },
      requestId
    );
  }

  if (user.status === 'PENDING_ACTIVATION') {
    return jsonError(
      403,
      {
        code: 'ACCOUNT_PENDING_ACTIVATION',
        message: 'This account has not been activated yet.'
      },
      requestId
    );
  }
  if (user.status === 'DEACTIVATED') {
    return jsonError(
      403,
      { code: 'ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' },
      requestId
    );
  }

  const passwordMatches = await argon2
    .verify(user.passwordHash ?? DUMMY_PASSWORD_HASH, password as string)
    .catch(() => false);

  if (!user.passwordHash || !passwordMatches) {
    await recordLoginFailed(requestId);
    return jsonError(
      401,
      { code: 'INVALID_CREDENTIALS', message: 'Invalid username/email or password.' },
      requestId
    );
  }

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  const userAgent = request.headers.get('user-agent');

  const { activeRoles } = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });

    const activeRoles = await tx.userRole.findMany({
      where: { userId: user.id, validTo: null },
      include: { role: true }
    });

    await tx.userSession.create({
      data: {
        userId: user.id,
        tokenHash,
        authLevel: 'PASSWORD',
        expiresAt,
        lastSeenAt: now,
        ipAddress: ip,
        userAgent
      }
    });

    // Same tx as the UserSession write above — not a separate transaction
    // after the session is issued (docs/titanor-time/03_DATA_MODEL_ERD.md §3:
    // «Действие + AuditEvent — одна транзакция»).
    await createAuditEvent(tx, {
      actorUserId: user.id,
      eventType: 'LOGIN_SUCCEEDED',
      entityType: 'AUTHENTICATION',
      entityId: user.id,
      requestId
    });

    return { activeRoles };
  });

  const response = NextResponse.json(
    {
      user: {
        id: user.id,
        username: user.username,
        roles: activeRoles.map((userRole) => userRole.role.name),
        locale: user.locale
      }
    },
    { status: 200, headers: successHeaders(requestId) }
  );

  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_DURATION_MS / 1000)
  });

  return response;
}
