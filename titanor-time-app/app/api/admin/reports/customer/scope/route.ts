import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { MAX_CUSTOM_REPORT_DAYS } from '@/lib/reporting/custom-time-report';
import { searchCustomerWorkAreas } from '@/lib/reporting/customer-workarea-picker';
import { getCustomerTimeReport } from '@/lib/reporting/customer-time-report';
import { resolveCustomerReadiness } from '@/lib/reporting/customer-hours';

// R15-D7 Deploy F — read-only picker + preview for /admin/reports/customer.
//   action=search&q=…                    -> { workAreas: [{ workAreaId, label, active, ... }] }
//   action=preview&waIds=…&dateFrom&dateTo -> { report, readiness }   (per-customer cards + worker list)
// Same permission set as the export route; never writes, never an AuditEvent.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

function idList(sp: URLSearchParams, key: string): string[] {
  return Array.from(
    new Set(
      sp
        .getAll(key)
        .flatMap((v) => v.split(','))
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    )
  );
}

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
  const action = (sp.get('action') ?? 'search').toLowerCase();

  if (action === 'search') {
    const workAreas = await searchCustomerWorkAreas(sp.get('q') ?? '', { limit: 50 });
    return NextResponse.json({ workAreas }, { status: 200, headers: { ...NO_STORE, 'X-Request-Id': requestId } });
  }

  // action=preview
  const dateFrom = sp.get('dateFrom');
  const dateTo = sp.get('dateTo');
  if (!dateFrom || !DATE_PATTERN.test(dateFrom) || !dateTo || !DATE_PATTERN.test(dateTo)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'dateFrom and dateTo are required (YYYY-MM-DD).' }, requestId);
  }
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T00:00:00.000Z`);
  if (from > to) return jsonError(400, { code: 'VALIDATION_ERROR', message: 'dateFrom must be <= dateTo.' }, requestId);
  if (Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1 > MAX_CUSTOM_REPORT_DAYS) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: `Date range must be ${MAX_CUSTOM_REPORT_DAYS} days or fewer.` }, requestId);
  }

  const workAreaIds = idList(sp, 'waIds');
  if (workAreaIds.some((id) => !UUID_PATTERN.test(id))) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid waIds.', fieldErrors: { waIds: ['list of UUIDs'] } }, requestId);
  }
  const includeNoCustomer = sp.get('noCustomer') === '1';
  if (workAreaIds.length === 0 && !includeNoCustomer) {
    return NextResponse.json(
      { report: null, readiness: null },
      { status: 200, headers: { ...NO_STORE, 'X-Request-Id': requestId } }
    );
  }
  const employeeIds = idList(sp, 'workerIds');
  if (employeeIds.some((id) => !UUID_PATTERN.test(id))) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid workerIds.', fieldErrors: { workerIds: ['list of UUIDs'] } }, requestId);
  }

  const [report, readiness] = await Promise.all([
    getCustomerTimeReport({
      dateFrom: from,
      dateTo: to,
      workAreaIds,
      includeNoCustomer,
      employeeIds: employeeIds.length ? employeeIds : null,
      dataMode: 'CURRENT_CANONICAL'
    }),
    resolveCustomerReadiness({
      dateFrom: from,
      dateTo: to,
      employeeIds: employeeIds.length ? employeeIds : null,
      workAreaIds,
      includeNoCustomer
    })
  ]);

  return NextResponse.json({ report, readiness }, { status: 200, headers: { ...NO_STORE, 'X-Request-Id': requestId } });
}
