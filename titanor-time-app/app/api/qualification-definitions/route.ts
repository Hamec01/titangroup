import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listSelectableQualificationDefinitions } from '@/lib/qualification-catalog';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Shared by the worker "add qualification" picker and the admin qualifications matrix filter —
 * EMPLOYEE-scope catalog only (company-reference standards are never a personal certificate,
 * see lib/qualification-catalog.ts). Read-only, no CSRF/idempotency needed. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  const canReadOwn = await hasPermission(authenticated.user.roles, 'worker.profile.read.own');
  const canReadAll = await hasPermission(authenticated.user.roles, 'worker.profile.read.all');
  if (!canReadOwn && !canReadAll) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const definitions = await listSelectableQualificationDefinitions();
  return NextResponse.json({ items: definitions }, { status: 200, headers: successHeaders(requestId) });
}
