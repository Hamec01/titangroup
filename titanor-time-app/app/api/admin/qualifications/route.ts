import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getQualificationMatrix, type MatrixStatusFilter, type MatrixVerificationFilter, type MatrixSort } from '@/lib/qualification-matrix';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_PERMISSIONS = ['worker.profile.read.all', 'worker.read.all'];
const STATUS_VALUES: MatrixStatusFilter[] = ['ALL', 'VALID', 'EXPIRING_SOON', 'CRITICAL', 'EXPIRED', 'MISSING_EXPIRY', 'MISSING'];
const VERIFICATION_VALUES: MatrixVerificationFilter[] = ['ALL', 'VERIFIED', 'SELF_REPORTED'];
const SORT_VALUES: MatrixSort[] = ['ATTENTION', 'NAME', 'EXPIRY'];

/** /admin/qualifications matrix data — task spec §16-20. Query params live in the URL (server-
 * side filtered, never shipped-then-filtered-in-browser). Read-only, no CSRF/idempotency. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(authenticated.user.roles, permissionCode))) {
      return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
    }
  }

  const url = request.nextUrl;
  const search = url.searchParams.get('search') ?? '';
  const qualificationCode = url.searchParams.get('qualification') || null;
  const statusRaw = url.searchParams.get('status') ?? 'ALL';
  const status = STATUS_VALUES.includes(statusRaw as MatrixStatusFilter) ? (statusRaw as MatrixStatusFilter) : 'ALL';
  const siteId = url.searchParams.get('siteId') || null;
  const verificationRaw = url.searchParams.get('verification') ?? 'ALL';
  const verification = VERIFICATION_VALUES.includes(verificationRaw as MatrixVerificationFilter) ? (verificationRaw as MatrixVerificationFilter) : 'ALL';
  const sortRaw = url.searchParams.get('sort') ?? 'ATTENTION';
  const sort = SORT_VALUES.includes(sortRaw as MatrixSort) ? (sortRaw as MatrixSort) : 'ATTENTION';
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const pageSize = 20;

  const result = await getQualificationMatrix({ search, qualificationCode, status, siteId, verification, sort, page, pageSize });
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
