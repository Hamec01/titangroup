import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import {
  resolveWorkforceScope,
  type MatrixStatusFilter,
  type MatrixVerificationFilter,
  type MatrixSort,
  type MatrixProfessionCategory,
  type MatrixActiveFilter
} from '@/lib/qualification-matrix';
import { buildWorkforceCsv, workforceCsvFileName } from '@/lib/reporting/workforce-export-csv';
import { buildWorkforcePdf, workforcePdfFileName } from '@/lib/reporting/workforce-export-pdf';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T13.6 — workforce matrix PDF/CSV export. Whole filtered scope (not the current page), hard row
// cap -> 400 REPORT_TOO_LARGE. GET, stateless, no ExportBatch / Idempotency-Key / CSRF — same
// posture as /api/admin/reports/custom/export.
const REQUIRED_PERMISSIONS = ['worker.profile.read.all', 'worker.read.all'];

const STATUSES = ['ALL', 'VALID', 'EXPIRING_SOON', 'CRITICAL', 'EXPIRED', 'MISSING_EXPIRY', 'MISSING'];
const VERIFICATIONS = ['ALL', 'VERIFIED', 'SELF_REPORTED'];
const CATEGORIES = ['ALL', 'SHIPBUILDING', 'CONSTRUCTION'];
const ACTIVES = ['ALL', 'ACTIVE', 'INACTIVE'];
const SORTS = ['ATTENTION', 'NAME', 'NUMBER', 'PROFESSION', 'CURRENT_SITE', 'EXPIRY'];

function pick<T extends string>(value: string | null, allowed: string[], fallback: T): T {
  return (value && allowed.includes(value) ? value : fallback) as T;
}

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

  const sp = request.nextUrl.searchParams;
  const formatRaw = sp.get('format') ?? 'PDF';
  if (formatRaw !== 'PDF' && formatRaw !== 'CSV') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'format must be PDF or CSV.', fieldErrors: { format: ['PDF or CSV'] } }, requestId);
  }

  const query = {
    search: sp.get('search') ?? '',
    qualificationCode: sp.get('qualification') || null,
    status: pick<MatrixStatusFilter>(sp.get('status'), STATUSES, 'ALL'),
    siteId: sp.get('siteId') || null,
    verification: pick<MatrixVerificationFilter>(sp.get('verification'), VERIFICATIONS, 'ALL'),
    professionCategory: pick<MatrixProfessionCategory>(sp.get('professionCategory'), CATEGORIES, 'ALL'),
    professionCode: sp.get('professionCode') || null,
    active: pick<MatrixActiveFilter>(sp.get('active'), ACTIVES, 'ALL'),
    sort: pick<MatrixSort>(sp.get('sort'), SORTS, 'ATTENTION')
  };

  const scope = await resolveWorkforceScope(query);
  if (!scope.ok) {
    return jsonError(400, { code: 'REPORT_TOO_LARGE', message: `The selection has ${scope.count} workers — narrow the filters (limit ${scope.limit}).` }, requestId);
  }

  // Exports always render in English, independent of the admin's UI locale — same as the custom
  // report. The matrix screen itself stays bilingual.
  const locale = 'EN' as const;
  const generatedAtHelsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const filterBits: string[] = [];
  if (query.search) filterBits.push(`search "${query.search}"`);
  if (query.professionCategory !== 'ALL') filterBits.push(query.professionCategory.toLowerCase());
  if (query.professionCode) filterBits.push(`profession ${query.professionCode}`);
  if (query.qualificationCode) filterBits.push(`qualification ${query.qualificationCode}`);
  if (query.status !== 'ALL') filterBits.push(`status ${query.status}`);
  if (query.verification !== 'ALL') filterBits.push(query.verification.toLowerCase());
  if (query.active !== 'ALL') filterBits.push(query.active.toLowerCase());
  const filterSummary = filterBits.length > 0 ? filterBits.join(', ') : 'all workers';

  if (formatRaw === 'CSV') {
    const content = buildWorkforceCsv(scope.rows, locale);
    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${workforceCsvFileName()}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'X-Request-Id': requestId
      }
    });
  }

  const pdf = await buildWorkforcePdf(scope.rows, { generatedAtHelsinki, filterSummary }, locale);
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${workforcePdfFileName()}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'X-Request-Id': requestId
    }
  });
}
