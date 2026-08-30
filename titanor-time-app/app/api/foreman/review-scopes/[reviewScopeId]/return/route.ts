import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { isForemanOwnScope } from '@/lib/foreman-review';
import { returnReviewScope } from '@/lib/review-scopes';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/[timesheetId]/return` — POST
// /api/foreman/review-scopes/:reviewScopeId/return. Reuses lib/review-scopes.ts's
// returnReviewScope core, same as the approve route — own-site ownership gate added here.
// proposals[] (propose-correction) is out of scope, same as the admin fallback path — rejected
// explicitly if non-empty, not silently dropped.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ reviewScopeId: string }> };

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.return'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { reviewScopeId } = await params;
  const reviewScopeIdInvalid = requireUuidParam(reviewScopeId, { code: 'REVIEW_SCOPE_NOT_FOUND', message: 'No review scope with this id on your own sites.' }, requestId);
  if (reviewScopeIdInvalid) return reviewScopeIdInvalid;

  if (!(await isForemanOwnScope(reviewScopeId, authenticated.user.id, helsinkiToday()))) {
    return jsonError(404, { code: 'REVIEW_SCOPE_NOT_FOUND', message: 'No review scope with this id on your own sites.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { returnReason, proposals } = bodyObject as { returnReason?: unknown; proposals?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof returnReason !== 'string' || returnReason.trim().length === 0) {
    fieldErrors.returnReason = ['required'];
  }
  let normalizedProposals: unknown[] | undefined;
  if (proposals !== undefined) {
    if (!Array.isArray(proposals)) {
      fieldErrors.proposals = ['must be an array'];
    } else {
      normalizedProposals = proposals;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  const result = await returnReviewScope(reviewScopeId, authenticated.user.id, authenticated.user.employeeId, (returnReason as string).trim(), normalizedProposals, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'REVIEW_SCOPE_NOT_FOUND':
        return jsonError(404, { code: 'REVIEW_SCOPE_NOT_FOUND', message: 'No review scope with this id.' }, requestId);
      case 'STALE_REVIEW_SCOPE':
        return jsonError(409, { code: 'STALE_REVIEW_SCOPE', message: 'This scope is no longer PENDING against the current version, or the timesheet is not SUBMITTED/RETURNED.' }, requestId);
      case 'SELF_APPROVAL_FORBIDDEN':
        return jsonError(403, { code: 'SELF_APPROVAL_FORBIDDEN', message: 'A reviewer cannot return their own timesheet.' }, requestId);
      case 'VALIDATION_ERROR':
        return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
