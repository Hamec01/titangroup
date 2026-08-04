import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listReviewScopes } from '@/lib/review-scopes';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §8 — GET /api/admin/review-scopes.
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.scope_review.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE ? pageSizeParam : DEFAULT_PAGE_SIZE;

  const statusParam = searchParams.get('status');
  const status = statusParam && ['PENDING', 'APPROVED', 'RETURNED'].includes(statusParam) ? statusParam : undefined;
  const scopeTypeParam = searchParams.get('scopeType');
  const scopeType = scopeTypeParam && ['SITE', 'NON_SITE'].includes(scopeTypeParam) ? scopeTypeParam : undefined;
  const scopePurposeParam = searchParams.get('scopePurpose');
  const scopePurpose = scopeType === 'NON_SITE' && scopePurposeParam && ['DATA', 'EMPTY_FALLBACK'].includes(scopePurposeParam) ? scopePurposeParam : undefined;
  const siteIdParam = searchParams.get('siteId');
  const siteId = siteIdParam && UUID_PATTERN.test(siteIdParam) ? siteIdParam : undefined;
  const employeeIdParam = searchParams.get('employeeId');
  const employeeId = employeeIdParam && UUID_PATTERN.test(employeeIdParam) ? employeeIdParam : undefined;

  const result = await listReviewScopes({ page, pageSize, status, scopeType, scopePurpose, siteId, employeeId, callerEmployeeId: authenticated.user.employeeId });
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
