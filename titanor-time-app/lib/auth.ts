import { prisma } from '@/lib/prisma';
import { hashSessionToken } from '@/lib/session';

export interface AuthenticatedSession {
  sessionId: string;
  user: {
    id: string;
    username: string;
    locale: string;
    roles: string[];
    employeeId: string | null;
  };
}

/**
 * Resolves an opaque tt_session cookie value to its User + active roles
 * (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0: opaque token,
 * SHA-256 looked up in UserSession.tokenHash). Takes the raw token string
 * rather than a NextRequest so both Route Handlers (`request.cookies.get(...)
 * ?.value`) and Server Components (`(await cookies()).get(...)?.value` from
 * `next/headers`, which isn't a NextRequest) can call it — see
 * lib/server-session.ts for the Server Component wrapper. Returns null for
 * any invalid session: missing/empty token, unknown/expired/revoked token,
 * or a user whose account was deactivated after the session was issued
 * (AGENT_RULES.md §12 requires a deactivated account to stop working
 * immediately, not just at next login attempt). OFFBOARDING is intentionally
 * not rejected here, same as at login (03_DATA_MODEL_ERD.md §4.2). On
 * success, refreshes UserSession.lastSeenAt.
 *
 * `roles` reflects only *currently* active UserRole rows — `validFrom <= now
 * AND (validTo IS NULL OR validTo > now)`, the same window every other
 * eligibility check in this app uses (lib/foreman-assignments.ts,
 * lib/users.ts, lib/system-activation.ts) — not just `validTo IS NULL`. A
 * role that hasn't started yet (`validFrom > now`) or has already ended
 * (`validTo <= now`) never grants access, and an ended role stops granting
 * access on the very next call (nothing here caches roles across requests —
 * this function re-reads UserRole fresh every time, so a role change takes
 * effect on the session's next request, not at next login).
 */
export async function resolveAuthenticatedSession(token: string | undefined): Promise<AuthenticatedSession | null> {
  if (!token) {
    return null;
  }

  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          userRoles: {
            where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
            include: { role: true }
          }
        }
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
      roles: session.user.userRoles.map((userRole) => userRole.role.name),
      employeeId: session.user.employeeId
    }
  };
}
