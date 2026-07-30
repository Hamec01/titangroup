import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0/§1 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

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

  const authenticated = await resolveAuthenticatedSession(request);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'session.revoke_all.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  // Soft-revoke only — UserSession rows are never physically deleted.
  await prisma.userSession.updateMany({
    where: { userId: authenticated.user.id, revokedAt: null },
    data: { revokedAt: new Date() }
  });

  const response = new NextResponse(null, { status: 204, headers: successHeaders(requestId) });
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  return response;
}
