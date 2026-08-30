import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listOwnSessions } from '@/lib/sessions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R03 — GET /api/me/sessions. The caller's own active sessions (device/IP/last-seen). TZ §6.1.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(session.user.roles, 'session.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const sessions = await listOwnSessions(session.user.id, session.sessionId);
  return NextResponse.json({ sessions }, { status: 200, headers: successHeaders(requestId) });
}
