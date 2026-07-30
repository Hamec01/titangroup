import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §1 — exact contract for this endpoint.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  return NextResponse.json(
    {
      user: {
        id: authenticated.user.id,
        username: authenticated.user.username,
        roles: authenticated.user.roles,
        locale: authenticated.user.locale
      }
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
