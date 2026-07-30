import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §2 — exact contract for this endpoint.
//
// proxy.ts already blocks unauthenticated requests to /api/admin/* at the
// gate, but re-checks the session here anyway — per Next.js's own Proxy
// guidance, a matcher change or a route move can silently remove that
// coverage, so each route verifies auth/permission itself rather than
// trusting the gate alone.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'city.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const cities = await prisma.city.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true }
  });

  return NextResponse.json(
    { items: cities },
    { status: 200, headers: successHeaders(requestId) }
  );
}
