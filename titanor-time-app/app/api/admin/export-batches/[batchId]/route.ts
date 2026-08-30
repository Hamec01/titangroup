import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getExportBatchDetail, isValidExportBatchId, parsePageQuery } from '@/lib/csv-export';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" §BK — GET /api/admin/export-batches/:batchId.
// Read-only. Never returns correction reason or any other correction payload — only covered
// CorrectionRequest ids/count.
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
  const batchIdInvalid = requireUuidParam(batchId, { code: 'EXPORT_BATCH_NOT_FOUND', message: 'No export batch with this id.' }, requestId);
  if (batchIdInvalid) return batchIdInvalid;
  if (!isValidExportBatchId(batchId)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'batchId must be a UUID.', fieldErrors: { batchId: ['invalid'] } }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const parsedPage = parsePageQuery({ page: searchParams.get('page'), pageSize: searchParams.get('pageSize') });
  if (!parsedPage.ok) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors: parsedPage.fieldErrors }, requestId);
  }

  const detail = await getExportBatchDetail(batchId, { page: parsedPage.page, pageSize: parsedPage.pageSize });
  if (!detail) {
    // Malformed and nonexistent batchId already share the same 400-vs-404 split as the rest of the
    // admin API (format checked first, above) — a valid-format but nonexistent id gets this uniform
    // 404, no oracle.
    return jsonError(404, { code: 'EXPORT_BATCH_NOT_FOUND', message: 'No export batch with this id.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}
