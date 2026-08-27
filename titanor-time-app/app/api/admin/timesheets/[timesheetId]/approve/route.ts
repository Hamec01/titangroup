import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { adminApproveTimesheet } from '@/lib/admin-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Task B (2026-08-27) — one-click "Утвердить табель". SUBMITTED (no foreman on any pending SITE
// scope) -> approve all scopes + FOREMAN_APPROVED + FINAL_APPROVED in one transaction;
// FOREMAN_APPROVED -> FINAL_APPROVED. Needs both the scope-review and the final-approve grants.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ timesheetId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.scope_review.all')) || !(await hasPermission(authenticated.user.roles, 'timesheet.final_approve'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { timesheetId } = await params;
  const result = await adminApproveTimesheet(timesheetId, authenticated.user.id, authenticated.user.employeeId ?? null, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'NOT_FOUND':
        return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
      case 'SELF_APPROVAL_FORBIDDEN':
        return jsonError(403, { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You cannot approve your own timesheet.' }, requestId);
      case 'FOREMAN_REVIEW_PENDING':
        return jsonError(409, { code: 'FOREMAN_REVIEW_PENDING', message: `Awaiting foreman review: ${result.siteNames.join(', ')}` }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'This timesheet is not awaiting approval — refresh the page.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
