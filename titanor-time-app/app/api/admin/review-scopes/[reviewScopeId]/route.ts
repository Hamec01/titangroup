import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getReviewScopeDetail } from '@/lib/review-scopes';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §8 — GET /api/admin/review-scopes/:reviewScopeId.
type RouteParams = { params: Promise<{ reviewScopeId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

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
  const detail = await getReviewScopeDetail(reviewScopeId);
  if (!detail) {
    return jsonError(404, { code: 'REVIEW_SCOPE_NOT_FOUND', message: 'No review scope with this id.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}
