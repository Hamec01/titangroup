import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { deleteReportFile } from '@/lib/report-files';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ fileId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== 'titanor-time') return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'export.create'))) return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  const { fileId } = await params;
  if (!UUID_PATTERN.test(fileId)) return jsonError(404, { code: 'REPORT_FILE_NOT_FOUND', message: 'No report file with this id.' }, requestId);
  if (!(await deleteReportFile(fileId))) return jsonError(404, { code: 'REPORT_FILE_NOT_FOUND', message: 'No report file with this id.' }, requestId);
  return NextResponse.json({ deleted: true }, { status: 200, headers: successHeaders(requestId) });
}
