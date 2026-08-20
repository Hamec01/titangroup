import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { lockPeriod } from '@/lib/periods';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// PROJECT_ROADMAP.md T7.10 ("Закрытие периода") + 01_SCREEN_MAP.md §3
// `/admin/periods/[periodId]` DoD: "period.lock с неутверждёнными табелями → список блокеров".
// No wire contract for this endpoint exists in 04_ADMIN_FIRST_API_CONTRACTS.md §7 (only
// create/read/current are specified there) — designed here following the same shape as the
// sibling timesheet.final_approve/return endpoints (pure state transition, no request body).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ periodId: string }> };
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'period.lock'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { periodId } = await params;
  if (!UUID_PATTERN.test(periodId)) {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  }
  const result = await lockPeriod(periodId, authenticated.user.id, requestId);

  if ('code' in result) {
    if (result.code === 'NOT_FOUND') {
      return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
    }
    if (result.code === 'NOT_ALL_FINAL_APPROVED') {
      return jsonError(
        409,
        {
          code: 'NOT_ALL_FINAL_APPROVED',
          message: 'Not every expected participant has reached FINAL_APPROVED.',
          blockers: result.blockers
        },
        requestId
      );
    }
    return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Period is not in OPEN status.' }, requestId);
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
