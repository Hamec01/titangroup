import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export const DOCUMENT_CSRF = 'titanor-time';

export async function authorizeDocumentRequest(request: NextRequest, permission: string, mutation = false) {
  const requestId = randomUUID();
  if (mutation && request.headers.get('x-requested-with') !== DOCUMENT_CSRF) return { ok: false as const, status: 403, code: 'CSRF_REJECTED', requestId };
  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return { ok: false as const, status: 401, code: 'NOT_AUTHENTICATED', requestId };
  if (!(await hasPermission(session.user.roles, permission))) return { ok: false as const, status: 403, code: 'FORBIDDEN', requestId };
  return { ok: true as const, session, requestId };
}

export function documentJsonError(status: number, code: string, requestId: string, extra?: Record<string, unknown>) {
  return Response.json({ error: { code, requestId, ...extra } }, { status, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId } });
}
