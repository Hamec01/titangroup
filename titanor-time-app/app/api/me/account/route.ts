import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { getAccountSettings, normalizeAccountEmail, updateAccountEmail } from '@/lib/account';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);

  const account = await getAccountSettings(session.user.id);
  if (!account) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  return NextResponse.json(account, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  if (typeof body.email !== 'string' || !normalizeAccountEmail(body.email)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid recovery email.', fieldErrors: { email: ['invalid'] } }, requestId);
  }
  if (typeof body.currentPassword !== 'string' || body.currentPassword.length === 0 || body.currentPassword.length > 256) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Current password is required.', fieldErrors: { currentPassword: ['required'] } }, requestId);
  }

  const result = await updateAccountEmail({
    userId: session.user.id,
    email: normalizeAccountEmail(body.email)!,
    currentPassword: body.currentPassword,
    requestId
  });
  if (!result.ok) {
    if (result.code === 'INVALID_CURRENT_PASSWORD') {
      return jsonError(400, { code: result.code, message: 'Current password is incorrect.' }, requestId);
    }
    if (result.code === 'EMAIL_IN_USE') {
      return jsonError(409, { code: result.code, message: 'This email is already linked to another account.' }, requestId);
    }
    return jsonError(403, { code: result.code, message: 'This account cannot update a recovery email.' }, requestId);
  }
  return NextResponse.json({ email: result.email }, { status: 200, headers: successHeaders(requestId) });
}
