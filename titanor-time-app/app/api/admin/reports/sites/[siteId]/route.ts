import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getSiteTimeReport, parseSiteReportQuery } from '@/lib/site-time-report';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.2A" §I —
// GET /api/admin/reports/sites/:siteId?periodId=&page=&pageSize=
function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

const REQUIRED_PERMISSIONS = ['site.read.all', 'period.read.all', 'timesheet.read.all'];

type RouteParams = { params: Promise<{ siteId: string }> };

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

  const { siteId } = await params;
  const { searchParams } = new URL(request.url);
  const parsed = parseSiteReportQuery({
    siteId,
    periodId: searchParams.get('periodId'),
    page: searchParams.get('page'),
    pageSize: searchParams.get('pageSize')
  });
  if (!parsed.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid parameters.', fieldErrors: parsed.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  // One shared REPEATABLE READ transaction — the /admin/reports/sites Server Component (T8.2B,
  // not built yet) will call this exact function too, no HTTP self-fetch.
  const outcome = await getSiteTimeReport(parsed.siteId, parsed.periodId, { page: parsed.page, pageSize: parsed.pageSize }, { kind: 'unrestricted' });

  if (outcome.code === 'SITE_NOT_FOUND') {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No work site with this id.' }, requestId);
  }
  if (outcome.code === 'PERIOD_NOT_FOUND') {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No payroll period with this id.' }, requestId);
  }
  if (outcome.code === 'SITE_REPORT_NOT_FOUND') {
    // Unreachable for the unrestricted admin scope — kept only so the outcome union stays
    // exhaustive without a non-null assertion.
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No work site with this id.' }, requestId);
  }

  return NextResponse.json(outcome.report, { status: 200, headers: successHeaders(requestId) });
}
