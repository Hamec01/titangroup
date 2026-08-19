import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { listExportBatches, parsePageQuery } from '@/lib/csv-export';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" §BK — GET /api/admin/export-batches.
// Read-only: creates zero AuditEvent rows, mutates nothing, never includes `content`.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'export.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const periodIdParam = searchParams.get('periodId');
  if (periodIdParam !== null && !UUID_PATTERN.test(periodIdParam)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'periodId must be a UUID.', fieldErrors: { periodId: ['invalid'] } }, requestId);
  }

  const parsedPage = parsePageQuery({ page: searchParams.get('page'), pageSize: searchParams.get('pageSize') });
  if (!parsedPage.ok) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors: parsedPage.fieldErrors }, requestId);
  }

  const result = await listExportBatches({ periodId: periodIdParam ?? undefined }, { page: parsedPage.page, pageSize: parsedPage.pageSize });
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
