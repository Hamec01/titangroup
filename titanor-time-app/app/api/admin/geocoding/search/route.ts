import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { jsonError, successHeaders } from '@/lib/api-error';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { searchSiteAddress } from '@/lib/site-geocoding';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'site.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (query.length < 3 || query.length > 200) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Address must contain 3–200 characters.', fieldErrors: { q: ['invalid'] } }, requestId);
  }
  const result = await searchSiteAddress(query);
  if (!result.ok) {
    return jsonError(result.code === 'RATE_LIMITED' ? 429 : 503, {
      code: result.code,
      message: result.code === 'RATE_LIMITED' ? 'Address search is busy. Wait a moment and try again.' : 'Address search is temporarily unavailable.'
    }, requestId);
  }
  return NextResponse.json(result, { status: 200, headers: { ...successHeaders(requestId), 'Cache-Control': 'private, no-store' } });
}
