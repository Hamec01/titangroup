import { NextRequest, NextResponse } from 'next/server';
import { successHeaders } from '@/lib/api-error';
import { guardApiRequest } from '@/lib/api-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §1 — exact contract for this endpoint.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardApiRequest(request);
  if (!guard.ok) return guard.response;
  const { session: authenticated, requestId } = guard;

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
