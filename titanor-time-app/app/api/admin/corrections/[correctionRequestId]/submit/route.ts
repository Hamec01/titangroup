import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { submitCorrection } from '@/lib/corrections';

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
  const result = await submitCorrection(correctionRequestId, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'NOT_FOUND':
        return jsonError(404, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Correction draft is not open.' }, requestId);
      case 'NO_CORRECTION_CHANGES':
        return jsonError(409, { code: 'NO_CORRECTION_CHANGES', message: 'The draft is identical to the base version — nothing to submit.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
