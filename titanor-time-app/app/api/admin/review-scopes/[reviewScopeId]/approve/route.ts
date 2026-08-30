import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { approveReviewScope } from '@/lib/review-scopes';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §8 — POST /api/admin/review-scopes/:reviewScopeId/approve.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ reviewScopeId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.scope_review.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { reviewScopeId } = await params;
  const reviewScopeIdInvalid = requireUuidParam(reviewScopeId, { code: 'REVIEW_SCOPE_NOT_FOUND', message: 'No review scope with this id.' }, requestId);
  if (reviewScopeIdInvalid) return reviewScopeIdInvalid;
  const result = await approveReviewScope(reviewScopeId, authenticated.user.id, authenticated.user.employeeId, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'REVIEW_SCOPE_NOT_FOUND':
        return jsonError(404, { code: 'REVIEW_SCOPE_NOT_FOUND', message: 'No review scope with this id.' }, requestId);
      case 'STALE_REVIEW_SCOPE':
        return jsonError(409, { code: 'STALE_REVIEW_SCOPE', message: 'This scope is no longer PENDING against the current version, or the timesheet is not SUBMITTED.' }, requestId);
      case 'SELF_APPROVAL_FORBIDDEN':
        return jsonError(403, { code: 'SELF_APPROVAL_FORBIDDEN', message: 'A reviewer cannot approve their own timesheet.' }, requestId);
      default:
        return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
