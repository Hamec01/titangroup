import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { openCorrectionDraft } from '@/lib/corrections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  const result = await openCorrectionDraft(correctionRequestId, authenticated.user.id, requestId);

  if ('code' in result) {
    if (result.code === 'NOT_FOUND') {
      return jsonError(404, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
    }
    return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Correction request is not PENDING.' }, requestId);
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
