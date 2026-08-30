import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// R03 — self-service session management (TZ §6.1/§6.2). The "device" is inferred from the stored
// User-Agent; no fingerprinting beyond what the browser already sends. Sessions are soft-revoked,
// never deleted.

export interface OwnSession {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  expiresAt: string;
}

export async function listOwnSessions(userId: string, currentSessionId: string): Promise<OwnSession[]> {
  const now = new Date();
  const rows = await prisma.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, ipAddress: true, userAgent: true, lastSeenAt: true, createdAt: true, expiresAt: true }
  });
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString()
  }));
}

export type RevokeOwnSessionResult =
  | { ok: true; wasCurrent: boolean }
  | { ok: false; code: 'SESSION_NOT_FOUND' };

/**
 * Revoke one of the caller's own sessions. Revoking the current session is allowed (it is an
 * explicit "sign out this device") — the route then clears the cookie. A session id that is not
 * the caller's, already revoked, or unknown is a single indistinguishable SESSION_NOT_FOUND.
 */
export async function revokeOwnSession(input: {
  userId: string;
  sessionId: string;
  currentSessionId: string;
  requestId: string;
}): Promise<RevokeOwnSessionResult> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.userSession.findFirst({
      where: { id: input.sessionId, userId: input.userId, revokedAt: null },
      select: { id: true }
    });
    if (!target) return { ok: false, code: 'SESSION_NOT_FOUND' as const };

    await tx.userSession.update({ where: { id: target.id }, data: { revokedAt: new Date() } });
    await createAuditEvent(tx, {
      actorUserId: input.userId,
      eventType: 'SESSION_REVOKED',
      entityType: 'USER_SESSION',
      entityId: target.id,
      requestId: input.requestId,
      afterValue: { self: true, wasCurrent: target.id === input.currentSessionId }
    });
    return { ok: true, wasCurrent: target.id === input.currentSessionId };
  });
}
