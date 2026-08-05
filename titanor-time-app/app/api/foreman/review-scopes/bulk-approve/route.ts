import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { bulkApproveReviewScopes } from '@/lib/foreman-review';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/bulk-approve` — POST
// /api/foreman/review-scopes/bulk-approve, body { reviewScopeIds: string[] }.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvalidScopesBody extends ApiErrorBody {
  invalidScopeIds: string[];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.bulk_approve'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { reviewScopeIds } = bodyObject as { reviewScopeIds?: unknown };

  if (!Array.isArray(reviewScopeIds) || reviewScopeIds.length === 0 || !reviewScopeIds.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'reviewScopeIds must be a non-empty array of ids.', fieldErrors: { reviewScopeIds: ['required'] } }, requestId);
  }

  const result = await bulkApproveReviewScopes(reviewScopeIds as string[], authenticated.user.id, authenticated.user.employeeId, helsinkiToday(), requestId);

  if ('code' in result) {
    if (result.code === 'INVALID_SCOPES') {
      const body: InvalidScopesBody = {
        code: 'INVALID_SCOPES',
        message: 'One or more selected scopes are not eligible for bulk approval.',
        invalidScopeIds: result.invalidScopeIds
      };
      return NextResponse.json({ error: { ...body, requestId } }, { status: 409, headers: successHeaders(requestId) });
    }
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId);
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
