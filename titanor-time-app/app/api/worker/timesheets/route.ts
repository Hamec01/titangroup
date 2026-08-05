import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listWorkerTimesheets } from '@/lib/worker-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/history` — "список всех периодов работника (не
// только actionable)". Not detailed in 04_...§9 (only the singular :timesheetId endpoints are) —
// contract-by-extension, same pattern as ForemanAssignment's admin endpoints. Reuses
// timesheet.read.own (already granted to WORKER — that permission's own matrix row describes
// "собственные табели", plural, not just a single one) rather than seeding a new code.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  const items = await listWorkerTimesheets(authenticated.user.employeeId);
  return NextResponse.json({ items }, { status: 200, headers: successHeaders(requestId) });
}
