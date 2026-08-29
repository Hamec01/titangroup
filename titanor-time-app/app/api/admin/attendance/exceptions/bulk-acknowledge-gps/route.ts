import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { parseExceptionListQuery } from '@/lib/attendance-exceptions';
import { bulkAcknowledgeGpsNotVerified } from '@/lib/attendance-exception-resolution';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T14.5c — POST /api/admin/attendance/exceptions/bulk-acknowledge-gps.
// ACKNOWLEDGE_AS_VALID every still-OPEN GPS_NOT_VERIFIED exception matching a NARROWED filter
// (siteId / employeeId / payrollPeriodId, optionally a date range) — for clearing the "GPS не
// подтверждён" backlog at a site where the phone reliably can't get a fix. ADMIN only; requires
// both attendance.exception.read.all and attendance.exception.resolve.all, same as the single
// resolve route. Never a foreman surface (no scope is passed).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.resolve.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId), { status: 400, headers: successHeaders(requestId) });
  }
  const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  const parsed = parseExceptionListQuery(
    { page: null, pageSize: null, status: null, type: null, siteId: str(body.siteId), employeeId: str(body.employeeId), payrollPeriodId: str(body.payrollPeriodId), from: str(body.from), to: str(body.to) },
    { allowEmployeeId: true }
  );
  if (!parsed.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid filter.', fieldErrors: parsed.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  const outcome = await bulkAcknowledgeGpsNotVerified(
    {
      siteId: parsed.filters.siteId,
      employeeId: parsed.filters.employeeId,
      payrollPeriodId: parsed.filters.payrollPeriodId,
      occurredFrom: parsed.filters.occurredFrom,
      occurredTo: parsed.filters.occurredTo
    },
    authenticated.user.id,
    requestId
  );

  switch (outcome.kind) {
    case 'OK':
      return NextResponse.json({ acknowledgedCount: outcome.acknowledgedCount }, { status: 200, headers: successHeaders(requestId) });
    case 'NO_SCOPE':
      return NextResponse.json(
        errorBody({ code: 'VALIDATION_ERROR', message: 'A site, employee or payroll period filter is required.', fieldErrors: { siteId: ['at least one of siteId / employeeId / payrollPeriodId is required'] } }, requestId),
        { status: 400, headers: successHeaders(requestId) }
      );
    case 'NONE_MATCHED':
      return NextResponse.json({ acknowledgedCount: 0 }, { status: 200, headers: successHeaders(requestId) });
    case 'TOO_MANY':
      return NextResponse.json(
        errorBody({ code: 'BULK_LIMIT_EXCEEDED', message: `${outcome.matched} exceptions match — narrow the filter to at most ${outcome.max}.` }, requestId),
        { status: 409, headers: successHeaders(requestId) }
      );
  }
}
