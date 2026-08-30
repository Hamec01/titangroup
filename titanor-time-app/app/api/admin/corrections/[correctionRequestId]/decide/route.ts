import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { decideCorrection } from '@/lib/corrections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 — POST .../decide, body { decision: 'APPROVED' |
// 'REJECTED', approvalOverride?, overrideReason? }. approvalOverride is SUPER_ADMIN-only (four-eyes
// bypass) — enforced here, not just in lib/corrections.ts, so an ADMIN can't even attempt it.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ correctionRequestId: string }> };

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
  if (!(await hasPermission(authenticated.user.roles, 'correction.approve'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { decision, approvalOverride, overrideReason } = bodyObject as { decision?: unknown; approvalOverride?: unknown; overrideReason?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    fieldErrors.decision = ["must be 'APPROVED' or 'REJECTED'"];
  }
  const wantsOverride = approvalOverride === true;
  if (approvalOverride !== undefined && typeof approvalOverride !== 'boolean') {
    fieldErrors.approvalOverride = ['must be a boolean'];
  }
  if (wantsOverride && !authenticated.user.roles.includes('SUPER_ADMIN')) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'approvalOverride requires SUPER_ADMIN.' }, requestId);
  }
  if (overrideReason !== undefined && typeof overrideReason !== 'string') {
    fieldErrors.overrideReason = ['must be a string'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  const { correctionRequestId } = await params;
  const correctionRequestIdInvalid = requireUuidParam(correctionRequestId, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
  if (correctionRequestIdInvalid) return correctionRequestIdInvalid;
  const result = await decideCorrection(
    correctionRequestId,
    decision as 'APPROVED' | 'REJECTED',
    authenticated.user.id,
    wantsOverride,
    typeof overrideReason === 'string' ? overrideReason.trim() : null,
    requestId
  );

  if ('code' in result) {
    switch (result.code) {
      case 'NOT_FOUND':
        return jsonError(404, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Correction request is not SUBMITTED.' }, requestId);
      case 'SELF_APPROVAL_FORBIDDEN':
        return jsonError(403, { code: 'SELF_APPROVAL_FORBIDDEN', message: 'The decider must be different from whoever opened the draft, unless approvalOverride is used.' }, requestId);
      case 'VALIDATION_ERROR':
        return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
