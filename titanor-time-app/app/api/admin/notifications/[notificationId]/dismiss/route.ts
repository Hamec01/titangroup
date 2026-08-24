import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { dismissAdminNotification } from '@/lib/qualification-notifications';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-admin dismiss — task spec §31: userId always comes from the session, never the request
 * body, so admin A can never dismiss on behalf of admin B. Naturally idempotent (upsert on the
 * (notificationId, userId) unique pair): a repeat POST is a harmless no-op, which is why this
 * doesn't need the heavier Idempotency-Key ceremony used by the export-batch-creation endpoint
 * (that one guards against duplicating an irreversible side effect; this one has none). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ notificationId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'admin.notification.dismiss'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { notificationId } = await params;
  if (!UUID_PATTERN.test(notificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Notification not found.' }, requestId);
  }

  const result = await dismissAdminNotification(notificationId, authenticated.user.id);
  if (!result.ok) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Notification not found.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
