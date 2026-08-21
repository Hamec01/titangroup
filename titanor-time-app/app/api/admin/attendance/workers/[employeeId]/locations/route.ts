import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getAdminWorkerGpsView } from '@/lib/attendance-gps-admin';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'attendance.gps.read.raw')) || !(await hasPermission(authenticated.user.roles, 'worker.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  const fromRaw = request.nextUrl.searchParams.get('from');
  const toRaw = request.nextUrl.searchParams.get('to');
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const toDay = toRaw && datePattern.test(toRaw) ? new Date(`${toRaw}T00:00:00.000Z`) : new Date();
  const from = fromRaw && datePattern.test(fromRaw) ? new Date(`${fromRaw}T00:00:00.000Z`) : new Date(toDay.getTime() - 7 * 86_400_000);
  const toExclusive = new Date(toDay.getTime() + 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(toExclusive.getTime()) || from >= toExclusive || toExclusive.getTime() - from.getTime() > 31 * 86_400_000) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Choose a valid range of at most 31 days.' }, requestId);
  }
  const view = await getAdminWorkerGpsView({ employeeId, actorUserId: authenticated.user.id, requestId, from, toExclusive });
  if (!view) return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  return NextResponse.json(view, { status: 200, headers: { ...successHeaders(requestId), 'Cache-Control': 'private, no-store' } });
}
