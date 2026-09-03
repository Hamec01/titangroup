import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { enableCustomer } from '@/lib/site-lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.9 — re-enable a disabled customer.
// Assignments are NOT revived; a finished parent site rejects it.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ siteId: string; workAreaId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'workarea.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { workAreaId } = await params;
  if (!UUID_PATTERN.test(workAreaId)) {
    return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'No customer with this id.' }, requestId);
  }

  const result = await enableCustomer({ workAreaId, actorUserId: authenticated.user.id, requestId });
  if ('code' in result) {
    if (result.code === 'CUSTOMER_NOT_FOUND') {
      return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'No customer with this id.' }, requestId);
    }
    if (result.code === 'SITE_FINISHED') {
      return jsonError(409, { code: 'SITE_FINISHED', message: 'The parent site is finished — reopen it first.' }, requestId);
    }
    return jsonError(409, { code: 'NOT_DISABLED', message: 'This customer is not disabled.' }, requestId);
  }
  return NextResponse.json({ workAreaId: result.workAreaId, active: true, assignmentsRevived: false }, { status: 200, headers: successHeaders(requestId) });
}
