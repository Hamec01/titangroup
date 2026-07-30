import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';

// Proxy (formerly "middleware", renamed in Next.js 16 — see
// https://nextjs.org/docs/messages/middleware-to-proxy) defaults to the
// Node.js runtime, which resolveAuthenticatedSession() needs for Prisma's
// native query engine. Setting `runtime` explicitly is an error on this file
// convention, unlike the old middleware.ts.
export const config = {
  matcher: ['/api/admin/:path*', '/api/worker/:path*']
};

// Authentication gate only — a session must exist, be unexpired/unrevoked,
// and belong to a non-DEACTIVATED user (same rules as
// GET /api/auth/session). This is intentionally not a permission/role check:
// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md gives each admin/worker
// endpoint its own specific required permission, which needs the role guard
// (T5.6, IMPLEMENTATION_STATUS.md §11) — not built yet, since
// Permission/RolePermission are still unseeded. Until then, every route
// under /api/admin/* and /api/worker/* is reachable by any authenticated
// user; none of those routes exist yet either.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const authenticated = await resolveAuthenticatedSession(request);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' });
  }

  return NextResponse.next();
}
