import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getExportBatchDownload, isValidExportBatchId } from '@/lib/csv-export';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" §BK —
// GET /api/admin/export-batches/:batchId/download. Returns the exact stored ExportBatch.content —
// never reconstructed from the current database state. Read-only, no AuditEvent.
type RouteParams = { params: Promise<{ batchId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'export.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { batchId } = await params;
  if (!isValidExportBatchId(batchId)) {
    // Same uniform 404 as a genuinely missing batch — a malformed id must not be a distinguishable
    // oracle on this endpoint either (this download route is the one place raw bytes ever leave the
    // system, so it gets the strictest "no HTML/stack trace, ever" treatment).
    return jsonError(404, { code: 'EXPORT_BATCH_NOT_FOUND', message: 'No export batch with this id.' }, requestId);
  }

  const download = await getExportBatchDownload(batchId);
  if (!download) {
    return jsonError(404, { code: 'EXPORT_BATCH_NOT_FOUND', message: 'No export batch with this id.' }, requestId);
  }

  return new NextResponse(new Uint8Array(download.content), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${download.fileName}"`,
      'Content-Length': String(download.fileSizeBytes),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Content-SHA256': download.fileHash,
      'X-Request-Id': requestId
    }
  });
}
