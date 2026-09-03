import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { reopenSite } from '@/lib/site-lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.8 — "Восстановить объект": active=true,
// finishedAt=NULL. Assignments are NOT revived — the admin assigns workers again.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ siteId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'site.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { siteId } = await params;
  if (!UUID_PATTERN.test(siteId)) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }

  const result = await reopenSite({ siteId, actorUserId: authenticated.user.id, requestId });
  if ('code' in result) {
    if (result.code === 'SITE_NOT_FOUND') {
      return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
    }
    return jsonError(409, { code: 'NOT_FINISHED', message: 'This site is not finished.' }, requestId);
  }
  return NextResponse.json({ siteId: result.siteId, active: true, assignmentsRevived: false }, { status: 200, headers: successHeaders(requestId) });
}
