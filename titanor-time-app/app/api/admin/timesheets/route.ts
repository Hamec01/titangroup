import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listTimesheets } from '@/lib/admin-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets` — GET /api/admin/timesheets.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'RETURNED', 'FOREMAN_APPROVED', 'FINAL_APPROVED']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE ? pageSizeParam : DEFAULT_PAGE_SIZE;
  const statusParam = searchParams.get('status');
  const status = statusParam && VALID_STATUSES.has(statusParam) ? statusParam : undefined;
  const periodIdParam = searchParams.get('periodId');
  const periodId = periodIdParam && UUID_PATTERN.test(periodIdParam) ? periodIdParam : undefined;

  const result = await listTimesheets({ page, pageSize, status, periodId });
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
