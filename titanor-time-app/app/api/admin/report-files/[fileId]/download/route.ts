import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getReportFileDownload } from '@/lib/report-files';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest, { params }: { params: Promise<{ fileId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'export.read'))) return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  const { fileId } = await params;
  if (!UUID_PATTERN.test(fileId)) return jsonError(404, { code: 'REPORT_FILE_NOT_FOUND', message: 'No report file with this id.' }, requestId);
  const file = await getReportFileDownload(fileId);
  if (!file) return jsonError(404, { code: 'REPORT_FILE_NOT_FOUND', message: 'No report file with this id.' }, requestId);
  return new NextResponse(new Uint8Array(file.content), { status: 200, headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${file.fileName}"`, 'Content-Length': String(file.fileSizeBytes), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': file.fileHash, 'X-Request-Id': requestId } });
}
