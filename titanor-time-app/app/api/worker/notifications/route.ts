import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { syncWorkerDeadlineNotifications, listWorkerNotifications } from '@/lib/worker-notifications';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T15.3 — GET /api/worker/notifications. Ensures the deadline notices are current, then returns
// the active ones this account has not dismissed. Read-only from the caller's point of view (the
// sync is an idempotent upsert, same pattern as the admin notification center's own generator).
// Gated on timesheet.read.own (every WORKER holds it; the notice is about their timesheet).
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
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

  try {
    await syncWorkerDeadlineNotifications(employeeId);
  } catch {
    // Non-blocking: if the ensure step fails, still return whatever is already stored.
  }
  const items = await listWorkerNotifications(employeeId, authenticated.user.id);
  return NextResponse.json({ items }, { status: 200, headers: successHeaders(requestId) });
}
