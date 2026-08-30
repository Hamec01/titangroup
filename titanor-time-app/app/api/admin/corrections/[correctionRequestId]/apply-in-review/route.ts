import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { submitCorrection, applyInReviewCorrection } from '@/lib/corrections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Task A (2026-08-27) — "Применить изменения" on an in-review admin correction (timesheet is
// SUBMITTED / FOREMAN_APPROVED). submitCorrection freezes the correction status DRAFT_OPEN ->
// SUBMITTED (and rejects a no-op edit with NO_CORRECTION_CHANGES); applyInReviewCorrection then
// freezes a CORRECTION version authored by this admin and sends the timesheet back to SUBMITTED
// with every review scope PENDING. There is no four-eyes gate here — the review pass that follows
// is the second pair of eyes (owner decision).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ correctionRequestId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'correction.draft.edit'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { correctionRequestId } = await params;
  const correctionRequestIdInvalid = requireUuidParam(correctionRequestId, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
  if (correctionRequestIdInvalid) return correctionRequestIdInvalid;

  const submitted = await submitCorrection(correctionRequestId, requestId);
  if ('code' in submitted) {
    if (submitted.code === 'NO_CORRECTION_CHANGES') {
      return jsonError(409, { code: 'NO_CORRECTION_CHANGES', message: 'Nothing was changed — edit a day first.' }, requestId);
    }
    // NOT_FOUND / INVALID_STATE_TRANSITION here just means the correction is not in DRAFT_OPEN
    // (e.g. a retry after submitCorrection already succeeded but applyInReviewCorrection then
    // failed) — fall through; applyInReviewCorrection re-validates everything under its own lock.
  }

  const applied = await applyInReviewCorrection(correctionRequestId, authenticated.user.id, requestId);
  if ('code' in applied) {
    if (applied.code === 'NOT_FOUND') {
      return jsonError(404, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
    }
    return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'This timesheet is no longer under review — refresh the page.' }, requestId);
  }

  return NextResponse.json(applied, { status: 200, headers: successHeaders(requestId) });
}
