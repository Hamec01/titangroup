import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { listForemanReviewScopes } from '@/lib/foreman-review';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review[/standard|/exceptions]` — GET
// /api/foreman/review-scopes?status=PENDING[&hasException=false|true]. status is always PENDING
// for this endpoint (nothing else FOREMAN needs to browse here), so it isn't a real query knob —
// accepted but ignored if present, same as the value the screen map's own URLs always pass.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.assigned'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE ? pageSizeParam : DEFAULT_PAGE_SIZE;
  const hasExceptionParam = searchParams.get('hasException');
  const hasException = hasExceptionParam === 'true' ? true : hasExceptionParam === 'false' ? false : undefined;

  const result = await listForemanReviewScopes({
    foremanUserId: authenticated.user.id,
    foremanEmployeeId: authenticated.user.employeeId,
    today: helsinkiToday(),
    hasException,
    page,
    pageSize
  });

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
