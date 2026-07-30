import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { SESSION_COOKIE_NAME, hashSessionToken } from '@/lib/session';

export interface AuthenticatedSession {
  sessionId: string;
  user: {
    id: string;
    username: string;
    locale: string;
    roles: string[];
  };
}

/**
 * Resolves the tt_session cookie on `request` to its User + active roles
 * (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0: opaque token,
 * SHA-256 looked up in UserSession.tokenHash). Returns null for any invalid
 * session: missing cookie, unknown/expired/revoked token, or a user whose
 * account was deactivated after the session was issued (AGENT_RULES.md §12
 * requires a deactivated account to stop working immediately, not just at
 * next login attempt). OFFBOARDING is intentionally not rejected here, same
 * as at login (03_DATA_MODEL_ERD.md §4.2). On success, refreshes
 * UserSession.lastSeenAt.
 */
export async function resolveAuthenticatedSession(request: NextRequest): Promise<AuthenticatedSession | null> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { userRoles: { where: { validTo: null }, include: { role: true } } }
      }
    }
  });

  if (!session || session.revokedAt !== null || session.expiresAt <= now || session.user.status === 'DEACTIVATED') {
    return null;
  }

  await prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      username: session.user.username,
      locale: session.user.locale,
      roles: session.user.userRoles.map((userRole) => userRole.role.name)
    }
  };
}
