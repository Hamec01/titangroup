import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { disableCustomer, disableCustomerPreview, type DisableCustomerDecision } from '@/lib/site-lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.9 — GET returns the preflight; POST
// disables the customer. When live/future assignments exist the body MUST carry `decision`
// ('LEAVE_ON_SITE_NO_CUSTOMER' | 'REMOVE_WORKERS') — transferring them to another customer of the
// same site is the Deploy E group transfer (the preview lists `otherActiveCustomers` for it).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS: DisableCustomerDecision[] = ['LEAVE_ON_SITE_NO_CUSTOMER', 'REMOVE_WORKERS'];

type RouteParams = { params: Promise<{ siteId: string; workAreaId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'site.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { workAreaId } = await params;
  if (!UUID_PATTERN.test(workAreaId)) {
    return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'No customer with this id.' }, requestId);
  }
  const preview = await disableCustomerPreview(workAreaId);
  if (!preview) {
    return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'No customer with this id.' }, requestId);
  }
  return NextResponse.json(preview, { status: 200, headers: successHeaders(requestId) });
}

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

  let decision: DisableCustomerDecision | undefined;
  try {
    const raw = (await request.json()) as { decision?: unknown };
    if (raw && typeof raw === 'object' && raw.decision !== undefined && raw.decision !== null) {
      if (typeof raw.decision !== 'string' || !DECISIONS.includes(raw.decision as DisableCustomerDecision)) {
        return jsonError(400, { code: 'VALIDATION_ERROR', message: 'decision must be LEAVE_ON_SITE_NO_CUSTOMER or REMOVE_WORKERS.' }, requestId);
      }
      decision = raw.decision as DisableCustomerDecision;
    }
  } catch {
    // no body → decision stays undefined (allowed only when there are no affected workers)
  }

  const result = await disableCustomer({ workAreaId, decision, actorUserId: authenticated.user.id, requestId });
  if ('code' in result) {
    if (result.code === 'CUSTOMER_NOT_FOUND') {
      return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'No customer with this id.' }, requestId);
    }
    if (result.code === 'ALREADY_DISABLED') {
      return jsonError(409, { code: 'ALREADY_DISABLED', message: 'This customer is already disabled.' }, requestId);
    }
    // DECISION_REQUIRED — send the preflight back so the UI can render the explicit choice.
    return NextResponse.json(
      {
        error: {
          code: 'DECISION_REQUIRED',
          message: 'This customer has assigned workers — choose what happens to them.',
          requestId,
          preview: result.preview
        }
      },
      { status: 409, headers: successHeaders(requestId) }
    );
  }
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
