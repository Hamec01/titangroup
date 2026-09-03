import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { MAX_CUSTOM_REPORT_DAYS } from '@/lib/reporting/custom-time-report';
import { getCustomerTimeReport } from '@/lib/reporting/customer-time-report';
import { resolveCustomerReadiness } from '@/lib/reporting/customer-hours';
import { buildCustomerHoursPdf, customerHoursPdfFileName } from '@/lib/reporting/customer-hours-pdf';
import { buildCustomerHoursCsv, customerHoursCsvFileName } from '@/lib/reporting/customer-hours-csv';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R15-D7 Deploy F — "Часы заказчику". The document is scoped to REAL WorkArea id(s) — segments are
// filtered by workAreaId so one customer's document never contains another customer's hours. The
// customer / site names come from the DB by id (the browser's text is ignored). A FINAL client
// export (PDF or CSV) is refused when: no real customer was selected, the internal "no customer"
// option is in scope, or any covering timesheet in the customer scope is not FINAL_APPROVED. The
// internal preview (?mode=PREVIEW / the /scope endpoint) always works.
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
  const dateFromRaw = sp.get('dateFrom');
  const dateToRaw = sp.get('dateTo');
  const fieldErrors: Record<string, string[]> = {};
  if (!dateFromRaw || !DATE_PATTERN.test(dateFromRaw)) fieldErrors.dateFrom = ['required, YYYY-MM-DD'];
  if (!dateToRaw || !DATE_PATTERN.test(dateToRaw)) fieldErrors.dateTo = ['required, YYYY-MM-DD'];
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid date range.', fieldErrors }, requestId);
  }
  const dateFrom = new Date(`${dateFromRaw}T00:00:00.000Z`);
  const dateTo = new Date(`${dateToRaw}T00:00:00.000Z`);
  if (dateFrom > dateTo) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'dateFrom must be <= dateTo.', fieldErrors: { dateFrom: ['on or before dateTo'] } }, requestId);
  }
  if (Math.round((dateTo.getTime() - dateFrom.getTime()) / MS_PER_DAY) + 1 > MAX_CUSTOM_REPORT_DAYS) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: `Date range must be ${MAX_CUSTOM_REPORT_DAYS} days or fewer.`, fieldErrors: { dateTo: [`exceeds ${MAX_CUSTOM_REPORT_DAYS} days`] } }, requestId);
  }

  const workAreaIds = idList(sp, 'waIds');
  const employeeIds = idList(sp, 'workerIds');
  for (const [label, ids] of [['waIds', workAreaIds], ['workerIds', employeeIds]] as const) {
    if (ids.some((id) => !UUID_PATTERN.test(id))) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: `Invalid ${label}.`, fieldErrors: { [label]: ['list of UUIDs'] } }, requestId);
    }
  }
  const includeNoCustomer = sp.get('noCustomer') === '1';

  const mode = (sp.get('mode') ?? 'FINAL').toUpperCase() === 'PREVIEW' ? 'PREVIEW' : 'FINAL';
  const preview = sp.get('preview') === '1';
  const formatRaw = (sp.get('format') ?? 'PDF').toUpperCase();
  if (!preview && formatRaw !== 'PDF' && formatRaw !== 'CSV') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'format must be PDF or CSV.', fieldErrors: { format: ['PDF or CSV'] } }, requestId);
  }

  // Validate every requested workArea id actually exists (names are then always taken from the DB).
  if (workAreaIds.length > 0) {
    const found = await prisma.workArea.count({ where: { id: { in: workAreaIds } } });
    if (found !== workAreaIds.length) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'One or more waIds do not reference a customer.', fieldErrors: { waIds: ['unknown id'] } }, requestId);
    }
  }
  if (workAreaIds.length === 0 && !includeNoCustomer) {
    return jsonError(400, { code: 'CUSTOMER_REQUIRED', message: 'Select at least one customer (or the internal "no customer" option for a preview).', fieldErrors: { waIds: ['required'] } }, requestId);
  }

  const dataMode = mode === 'PREVIEW' ? 'CURRENT_CANONICAL' : 'FINAL_APPROVED_ONLY';
  const readiness = await resolveCustomerReadiness({ dateFrom, dateTo, employeeIds: employeeIds.length ? employeeIds : null, workAreaIds, includeNoCustomer });

  if (preview) {
    const report = await getCustomerTimeReport({
      dateFrom,
      dateTo,
      workAreaIds,
      includeNoCustomer,
      employeeIds: employeeIds.length ? employeeIds : null,
      dataMode: 'CURRENT_CANONICAL'
    });
    return NextResponse.json({ readiness, report }, { status: 200, headers: { ...NO_STORE, 'X-Request-Id': requestId } });
  }

  // ── FINAL export gates (client PDF / CSV) ──────────────────────────────────────────────────
  if (mode === 'FINAL') {
    if (includeNoCustomer) {
      return jsonError(
        409,
        { code: 'NO_CUSTOMER_NOT_EXPORTABLE', message: 'The internal "no customer" option cannot be part of a client export. Remove it, or use the preview.' },
        requestId
      );
    }
    if (readiness.level !== 'CUSTOMER_FINAL') {
      return NextResponse.json(
        {
          error: {
            code: 'NOT_FINAL_APPROVED',
            message: 'Some timesheets for this customer are not final-approved yet.',
            blockers: readiness.blockers,
            noData: readiness.noData,
            requestId
          }
        },
        { status: 409, headers: { ...NO_STORE, 'X-Request-Id': requestId } }
      );
    }
  }

  const report = await getCustomerTimeReport({
    dateFrom,
    dateTo,
    workAreaIds,
    includeNoCustomer: false,
    employeeIds: employeeIds.length ? employeeIds : null,
    dataMode
  });

  const generatedAtHelsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

  if (mode === 'FINAL') {
    await prisma.$transaction((tx) =>
      createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'REPORT_EXPORTED',
        entityType: 'CUSTOMER_HOURS_REPORT',
        entityId: null,
        requestId,
        beforeValue: null,
        afterValue: {
          report: 'CUSTOMER_HOURS',
          format: formatRaw,
          dateFrom: report.dateFrom,
          dateTo: report.dateTo,
          workAreaIds,
          customerCount: report.sections.length,
          workerCount: report.grandWorkerCount,
          totalMinutes: report.grandTotalMinutes
        }
      })
    );
  }

  if (formatRaw === 'CSV') {
    const content = buildCustomerHoursCsv(report);
    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${customerHoursCsvFileName(report)}"`,
        'X-Content-Type-Options': 'nosniff',
        ...NO_STORE,
        'X-Request-Id': requestId
      }
    });
  }

  const pdf = await buildCustomerHoursPdf(report, { generatedAtHelsinki, preparedBy: authenticated.user.username, isFinalApproved: mode === 'FINAL' });
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${customerHoursPdfFileName(report)}"`,
      'X-Content-Type-Options': 'nosniff',
      ...NO_STORE,
      'X-Request-Id': requestId
    }
  });
}
