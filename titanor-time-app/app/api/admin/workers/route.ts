import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { listWorkers } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 — exact contract for this endpoint.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'worker.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize =
    Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE
      ? pageSizeParam
      : DEFAULT_PAGE_SIZE;

  const result = await listWorkers(page, pageSize);

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
