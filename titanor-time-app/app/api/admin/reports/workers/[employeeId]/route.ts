import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getWorkerTimeReport } from '@/lib/worker-time-report';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md — GET /api/admin/reports/workers/:employeeId?periodId=<uuid>
function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

const REQUIRED_PERMISSIONS = ['worker.read.all', 'period.read.all', 'timesheet.read.all'];

type RouteParams = { params: Promise<{ employeeId: string }> };

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

  const { employeeId } = await params;
  const { searchParams } = new URL(request.url);
  const periodId = searchParams.get('periodId');

  const fieldErrors: Record<string, string[]> = {};
  if (!UUID_PATTERN.test(employeeId)) {
    fieldErrors.employeeId = ['must be a UUID'];
  }
  if (!periodId) {
    fieldErrors.periodId = ['required'];
  } else if (!UUID_PATTERN.test(periodId)) {
    fieldErrors.periodId = ['must be a UUID'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid parameters.', fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  // §6 ТЗ T8_REPORTS_DESIGN.md — one REPEATABLE READ read-only transaction, no HTTP self-fetch; the
  // /admin/reports Server Component calls the exact same function.
  const outcome = await getWorkerTimeReport(employeeId, periodId as string);

  if (outcome.code === 'WORKER_NOT_FOUND') {
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  }
  if (outcome.code === 'PERIOD_NOT_FOUND') {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No payroll period with this id.' }, requestId);
  }

  return NextResponse.json(outcome.report, { status: 200, headers: successHeaders(requestId) });
}
