import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { revokeOwnSession } from '@/lib/sessions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R03 — DELETE /api/me/sessions/:sessionId. Sign one of the caller's own devices out. TZ §6.1.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ sessionId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(session.user.roles, 'session.revoke.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { sessionId } = await params;
  if (!UUID_PATTERN.test(sessionId)) {
    return jsonError(404, { code: 'SESSION_NOT_FOUND', message: 'No session with this id.' }, requestId);
  }

  const result = await revokeOwnSession({ userId: session.user.id, sessionId, currentSessionId: session.sessionId, requestId });
  if (!result.ok) {
    return jsonError(404, { code: 'SESSION_NOT_FOUND', message: 'No session with this id.' }, requestId);
  }

  const response = new NextResponse(null, { status: 204, headers: successHeaders(requestId) });
  if (result.wasCurrent) {
    response.cookies.set(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  }
  return response;
}
