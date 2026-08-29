import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { normalizeAccountEmail } from '@/lib/account';
import { issuePasswordReset, revokeUndeliveredPasswordReset } from '@/lib/password-reset';
import { passwordResetMailConfig, passwordResetUrl, sendPasswordResetEmail } from '@/lib/password-reset-mailer';
import { checkRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const IP_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
const EMAIL_RATE_LIMIT = { limit: 3, windowMs: 15 * 60 * 1000 };

function clientIp(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

// Always use this response after a syntactically valid request, whether an account exists or
// delivery succeeded. This prevents the endpoint from becoming an email-account enumerator.
function acceptedResponse(requestId: string): NextResponse {
  return NextResponse.json(
    { message: 'If an account matches this email, a recovery link will arrive shortly.' },
    { status: 200, headers: successHeaders(requestId) }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const email = rawBody && typeof rawBody === 'object' && typeof (rawBody as Record<string, unknown>).email === 'string'
    ? normalizeAccountEmail((rawBody as Record<string, string>).email)
    : null;
  if (!email) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Enter a valid email address.', fieldErrors: { email: ['invalid'] } }, requestId);
  }

  const ip = clientIp(request);
  if (!checkRateLimit(`password-reset-ip:${ip ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs) || !checkRateLimit(`password-reset-email:${email}`, EMAIL_RATE_LIMIT.limit, EMAIL_RATE_LIMIT.windowMs)) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many recovery requests. Try again later.' }, requestId);
  }

  let mailConfig;
  try {
    mailConfig = passwordResetMailConfig();
  } catch (error) {
    console.error('Password reset delivery is not configured.', { requestId, message: error instanceof Error ? error.message : 'unknown' });
    return jsonError(503, { code: 'DELIVERY_UNAVAILABLE', message: 'Password reset email is temporarily unavailable.' }, requestId);
  }

  const issued = await issuePasswordReset(email, requestId);
  if (!issued) return acceptedResponse(requestId);

  try {
    await sendPasswordResetEmail(mailConfig, {
      to: issued.email,
      username: issued.username,
      resetUrl: passwordResetUrl(mailConfig, issued.token)
    });
  } catch (error) {
    // Do not reveal delivery outcomes to an unauthenticated caller and do not retain a token whose
    // link was not delivered. Operational logs have only a request ID, never email/token values.
    console.error('Password reset delivery failed.', { requestId, message: error instanceof Error ? error.message : 'unknown' });
    await revokeUndeliveredPasswordReset(issued.id, issued.userId, requestId).catch(() => undefined);
  }
  return acceptedResponse(requestId);
}
