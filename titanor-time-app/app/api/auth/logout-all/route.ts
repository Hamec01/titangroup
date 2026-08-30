import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { successHeaders } from '@/lib/api-error';
import { guardApiRequest } from '@/lib/api-guard';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0/§1 — exact contract for this endpoint.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardApiRequest(request, { csrf: true, permission: 'session.revoke_all.own' });
  if (!guard.ok) return guard.response;
  const { session: authenticated, requestId } = guard;

  // Soft-revoke only — UserSession rows are never physically deleted.
  await prisma.userSession.updateMany({
    where: { userId: authenticated.user.id, revokedAt: null },
    data: { revokedAt: new Date() }
  });

  const response = new NextResponse(null, { status: 204, headers: successHeaders(requestId) });
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  return response;
}
