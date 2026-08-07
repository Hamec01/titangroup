import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getTemplateDetail } from '@/lib/templates';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 — GET /api/admin/templates/:templateId.
// PATCH (creates a new version) is a separate future slice — not implemented here.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ templateId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'template.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { templateId } = await params;
  // A malformed UUID would otherwise reach Postgres as a `uuid`-typed query parameter and throw
  // (22P02 invalid input syntax), surfacing as an unhandled 500 — checked before ever querying, same
  // as a genuinely unknown id, since neither case has a template to return.
  if (!UUID_PATTERN.test(templateId)) {
    return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'No template with this id.' }, requestId);
  }

  const detail = await getTemplateDetail(templateId);
  if (!detail) {
    return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'No template with this id.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}
