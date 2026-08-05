import { cache } from 'react';
import { cookies } from 'next/headers';
import { resolveAuthenticatedSession, type AuthenticatedSession } from '@/lib/auth';
import { SESSION_COOKIE_NAME } from '@/lib/session';

/**
 * Same as resolveAuthenticatedSession(), for Server Components — which get
 * the request's cookies via next/headers' cookies(), not a NextRequest.
 * Route Handlers should keep using resolveAuthenticatedSession(request.
 * cookies.get(...)?.value) directly; this wrapper exists for page-level auth
 * checks (e.g. /admin/setup redirecting an unauthenticated/wrong-role visitor
 * to /login) where no NextRequest is available.
 */
export const resolveServerSession = cache(async (): Promise<AuthenticatedSession | null> => {
  const store = await cookies();
  return resolveAuthenticatedSession(store.get(SESSION_COOKIE_NAME)?.value);
});
