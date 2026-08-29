import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { dismissWorkerNotification } from '@/lib/worker-notifications';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T15.3 — POST /api/worker/notifications/:id/dismiss. Per-account dismissal (a shared device with
// two workers). dismissWorkerNotification checks the notice belongs to this employee, so a guessed
// id from another worker is a 404. Idempotent.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: { params: Promise<{ notificationId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const employeeId = authenticated.user.employeeId;
  if (!employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  const { notificationId } = await params;
  if (!UUID_PATTERN.test(notificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Notification not found.' }, requestId);
  }

  const ok = await dismissWorkerNotification(notificationId, employeeId, authenticated.user.id);
  if (!ok) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Notification not found.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
