import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getReportFileDownload, verifyReportFileIntegrity, REPORT_FILE_MIME } from '@/lib/report-files';
import { attachmentContentDisposition } from '@/lib/reporting/content-disposition';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §7 (download safety) + §9.
// GET is read-only (no CSRF header, no audit — download volume would flood AuditEvent; the
// meaningful lifecycle events are REPORT_FILE_CREATED / REPORT_FILE_DELETED, §7.11). The served
// bytes are re-checked against the recorded SHA-256 + size before they leave the process, the
// Content-Type is pinned to the format's allow-listed MIME, and Content-Disposition is built via
// the RFC 6266 helper so a stored file name can never inject a response header.

export async function GET(request: NextRequest, { params }: { params: Promise<{ fileId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'export.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { fileId } = await params;
  if (!UUID_PATTERN.test(fileId)) {
    return jsonError(404, { code: 'REPORT_FILE_NOT_FOUND', message: 'No report file with this id.' }, requestId);
  }

  const file = await getReportFileDownload(fileId);
  if (!file) {
    return jsonError(404, { code: 'REPORT_FILE_NOT_FOUND', message: 'No report file with this id.' }, requestId);
  }
  if (!verifyReportFileIntegrity(file)) {
    return jsonError(500, { code: 'REPORT_FILE_CORRUPT', message: 'The stored report file failed its integrity check and was not served.' }, requestId);
  }

  return new NextResponse(new Uint8Array(file.content), {
    status: 200,
    headers: {
      'Content-Type': REPORT_FILE_MIME[file.format],
      'Content-Disposition': attachmentContentDisposition(file.fileName),
      'Content-Length': String(file.fileSizeBytes),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Content-SHA256': file.fileHash,
      'X-Request-Id': requestId
    }
  });
}
