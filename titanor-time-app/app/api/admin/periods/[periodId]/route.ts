import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getPeriodDetail } from '@/lib/periods';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §7 — GET /api/admin/periods/:periodId.
type RouteParams = { params: Promise<{ periodId: string }> };
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'period.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { periodId } = await params;
  if (!UUID_PATTERN.test(periodId)) {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  }
  const period = await getPeriodDetail(periodId);
  if (!period) {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  }

  return NextResponse.json(period, { status: 200, headers: successHeaders(requestId) });
}
