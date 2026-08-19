import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getPeriodTimeReport, parsePeriodReportQuery, isValidPeriodId } from '@/lib/period-time-report';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3A" §W —
// GET /api/admin/reports/periods/:periodId?page=&pageSize=
function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

const REQUIRED_PERMISSIONS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all'];

type RouteParams = { params: Promise<{ periodId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(authenticated.user.roles, permissionCode))) {
      return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
    }
  }

  const { periodId } = await params;
  const { searchParams } = new URL(request.url);
  const parsedQuery = parsePeriodReportQuery({ page: searchParams.get('page'), pageSize: searchParams.get('pageSize') });

  const fieldErrors: Record<string, string[]> = !parsedQuery.ok ? { ...parsedQuery.fieldErrors } : {};
  if (!isValidPeriodId(periodId)) {
    fieldErrors.periodId = ['must be a UUID'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid parameters.', fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }
  // Both checked above — narrow for TypeScript.
  if (!parsedQuery.ok) {
    throw new Error('unreachable: fieldErrors check above already returned for a failed parse');
  }

  // One shared REPEATABLE READ transaction — the future T8.3B Server Component will call this
  // exact function too, no HTTP self-fetch.
  const outcome = await getPeriodTimeReport(periodId, { page: parsedQuery.page, pageSize: parsedQuery.pageSize });

  if (outcome.code === 'PERIOD_NOT_FOUND') {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No payroll period with this id.' }, requestId);
  }

  return NextResponse.json(outcome.report, { status: 200, headers: successHeaders(requestId) });
}
