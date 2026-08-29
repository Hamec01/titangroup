import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getCustomTimeReport, MAX_CUSTOM_REPORT_DAYS } from '@/lib/reporting/custom-time-report';
import { resolveCustomerReadiness } from '@/lib/reporting/customer-hours';
import { buildCustomerHoursPdf, customerHoursPdfFileName } from '@/lib/reporting/customer-hours-pdf';
import { buildCustomerHoursCsv, customerHoursCsvFileName } from '@/lib/reporting/customer-hours-csv';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T13.11 — Customer Project Working Hours. A document for the customer: confirmed (FINAL_APPROVED)
// hours by site. Does NOT depend on the customer's TES, shows no money. GET + stateless (no
// ExportBatch), but a FINAL customer export writes one lightweight REPORT_EXPORTED AuditEvent
// (it leaves the building). If a covering timesheet is not FINAL_APPROVED the final export is
// blocked (409 with the list); ?mode=PREVIEW returns an internal not-final preview instead.
const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function parseIdList(sp: URLSearchParams, key: string): string[] | null {
  const values = sp
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return values.length > 0 ? values : null;
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

  const employeeIds = parseIdList(sp, 'employeeIds');
  const siteIds = parseIdList(sp, 'siteIds');
  for (const [label, ids] of [['employeeIds', employeeIds], ['siteIds', siteIds]] as const) {
    if (ids && ids.some((id) => !UUID_PATTERN.test(id))) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: `Invalid ${label}.`, fieldErrors: { [label]: ['list of UUIDs'] } }, requestId);
    }
  }

  const mode = (sp.get('mode') ?? 'FINAL').toUpperCase() === 'PREVIEW' ? 'PREVIEW' : 'FINAL';
  const preview = sp.get('preview') === '1';
  const formatRaw = (sp.get('format') ?? 'PDF').toUpperCase();
  if (!preview && formatRaw !== 'PDF' && formatRaw !== 'CSV') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'format must be PDF or CSV.', fieldErrors: { format: ['PDF or CSV'] } }, requestId);
  }
  const customer = (sp.get('customer') ?? '').slice(0, 200);
  const projectReference = (sp.get('projectReference') ?? '').slice(0, 200);

  const readiness = await resolveCustomerReadiness({ dateFrom, dateTo, employeeIds, siteIds });

  if (preview) {
    const report = await getCustomTimeReport({ dateFrom, dateTo, employeeIds, siteIds, dataMode: mode === 'PREVIEW' ? 'CURRENT_CANONICAL' : 'FINAL_APPROVED_ONLY' });
    return NextResponse.json(
      {
        readiness,
        report: { dateFrom: report.dateFrom, dateTo: report.dateTo, dailyRows: report.dailyRows, siteSubtotals: report.siteSubtotals, employeeSubtotals: report.employeeSubtotals, grandTotal: report.grandTotal, sites: report.sites }
      },
      { status: 200, headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId } }
    );
  }

  if (mode === 'FINAL' && readiness.level !== 'CUSTOMER_FINAL') {
    return NextResponse.json(
      { error: { code: 'NOT_FINAL_APPROVED', message: 'Some timesheets in this range are not final-approved yet.', blockers: readiness.blockers, noData: readiness.noData, requestId } },
      { status: 409, headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId } }
    );
  }

  const report = await getCustomTimeReport({ dateFrom, dateTo, employeeIds, siteIds, dataMode: mode === 'PREVIEW' ? 'CURRENT_CANONICAL' : 'FINAL_APPROVED_ONLY' });
  const generatedAtHelsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const meta = { customer, projectReference, generatedAtHelsinki, preparedBy: authenticated.user.username, isFinalApproved: mode === 'FINAL' };

  // Lightweight audit — no ExportBatch, no employee names/numbers, no hours breakdown.
  if (mode === 'FINAL') {
    await prisma.$transaction((tx) =>
      createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'REPORT_EXPORTED',
        entityType: 'CUSTOMER_HOURS_REPORT',
        entityId: null,
        requestId,
        beforeValue: null,
        afterValue: { report: 'CUSTOMER_PROJECT_HOURS', format: formatRaw, dateFrom: report.dateFrom, dateTo: report.dateTo, customer: customer || null, projectReference: projectReference || null, siteCount: report.sites.length, workerCount: report.employees.length, dailyRowCount: report.dailyRows.length }
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
        'Cache-Control': 'private, no-store',
        'X-Request-Id': requestId
      }
    });
  }

  const pdf = await buildCustomerHoursPdf(report, meta);
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${customerHoursPdfFileName(report)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'X-Request-Id': requestId
    }
  });
}
