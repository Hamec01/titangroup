import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { MAX_CUSTOM_REPORT_DAYS } from '@/lib/reporting/custom-time-report';
import { resolveCustomerScopeWorkers } from '@/lib/reporting/customer-report-scope';

// docs/titanor-time/CUSTOMER_REPORT_SCOPE_PICKER_RU.md §5 — read-only "which workers are in scope for
// these sites/date range or directly across workers" lookup for the customer scope picker. Same permission set
// as the export route; never writes, never an ExportBatch, never an AuditEvent.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  for (const p of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(authenticated.user.roles, p))) {
      return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
    }
  }

  const sp = request.nextUrl.searchParams;
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');
  if (!dateFrom || !DATE_PATTERN.test(dateFrom) || !dateTo || !DATE_PATTERN.test(dateTo)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'dateFrom and dateTo are required (YYYY-MM-DD).' }, requestId);
  }
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  if (from > to) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'dateFrom must be <= dateTo.' }, requestId);
  }
  if (Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1 > MAX_CUSTOM_REPORT_DAYS) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: `Date range must be ${MAX_CUSTOM_REPORT_DAYS} days or fewer.` }, requestId);
  }

  const siteMode = (sp.get('siteMode') ?? '').toUpperCase() === 'ALL' ? 'ALL' : 'PICK';
  const scopeBasis = (sp.get('scopeBasis') ?? '').toUpperCase() === 'WORKERS' ? 'WORKERS' : 'SITES';
  const siteIds = sp
    .getAll('siteIds')
    .flatMap((v) => v.split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (scopeBasis === 'SITES' && siteMode === 'PICK') {
    if (siteIds.length === 0) {
      return NextResponse.json({ workers: [] }, { status: 200, headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId } });
    }
    if (siteIds.some((id) => !UUID_PATTERN.test(id))) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid siteIds.', fieldErrors: { siteIds: ['list of UUIDs'] } }, requestId);
    }
  }

  const workers = await resolveCustomerScopeWorkers({ scopeBasis, siteMode, siteIds, dateFrom, dateTo });

  return NextResponse.json(
    { workers },
    { status: 200, headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId } }
  );
}
