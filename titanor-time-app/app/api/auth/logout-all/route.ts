import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0/§1 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

// Contract permission is `session.revoke_all.own`, but Permission/RolePermission
// enforcement (role guard, T5.6, IMPLEMENTATION_STATUS.md §11) doesn't exist yet —
// gated on "authenticated" only for now, same as /logout. Revisit once role guard
// lands: every authenticated user can already only ever revoke their own sessions
// (scoped by their own userId below), so this gap doesn't let anyone touch another
// user's sessions in the meantime.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, {
      code: 'CSRF_REJECTED',
      message: 'Missing or invalid X-Requested-With header.'
    });
  }

  const authenticated = await resolveAuthenticatedSession(request);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' });
  }

  // Soft-revoke only — UserSession rows are never physically deleted.
  await prisma.userSession.updateMany({
    where: { userId: authenticated.user.id, revokedAt: null },
    data: { revokedAt: new Date() }
  });

  const response = new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  return response;
}
