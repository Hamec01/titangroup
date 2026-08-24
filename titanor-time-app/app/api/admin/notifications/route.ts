import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listActiveNotificationsForAdmin } from '@/lib/qualification-notifications';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Admin Notification Center feed — badge count + drawer contents. Read-only, no CSRF/idempotency. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'admin.notification.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const items = await listActiveNotificationsForAdmin(authenticated.user.id);
  return NextResponse.json({ items, total: items.length }, { status: 200, headers: successHeaders(requestId) });
}
