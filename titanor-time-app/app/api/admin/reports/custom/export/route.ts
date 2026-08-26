import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getCustomTimeReport, MAX_CUSTOM_REPORT_DAYS, type CustomReportDataMode } from '@/lib/reporting/custom-time-report';
import { buildCustomReportSummaryCsv, buildCustomReportDetailedCsv, customReportCsvFileName } from '@/lib/reporting/custom-report-csv';
import { buildCustomReportSummaryPdf, buildCustomReportDetailedPdf, customReportPdfFileName } from '@/lib/reporting/custom-report-pdf';
import type { AppLocale } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Part A — flexible time report export (task spec Part 2/8). Deliberately GET + stateless: no
// ExportBatch row, no Idempotency-Key, no CSRF check — same posture as the three existing T8
// report GET routes (worker/site/period), which this reuses the exact canonical core of
// (lib/reporting/custom-time-report.ts -> lib/reporting/canonical-daily-buckets.ts, worked-
// time.ts, canonical-source.ts). Never touches ExportBatch/ExportItem (§8 — that model stays
// payroll-CSV-specific; ONE arbitrary-date-range custom report here, not a second export history).
const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Supports both a native <select multiple> GET form (repeated `key=id&key=id`) and a single
// comma-separated value (e.g. hand-built links) — either produces the same id list.
function parseIdList(searchParams: URLSearchParams, key: string): string[] | null {
  const values = searchParams
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
  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(authenticated.user.roles, permissionCode))) {
      return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
    }
  }

  const url = request.nextUrl;
  const dateFromRaw = url.searchParams.get('dateFrom');
  const dateToRaw = url.searchParams.get('dateTo');
  const fieldErrors: Record<string, string[]> = {};
  if (!dateFromRaw || !DATE_PATTERN.test(dateFromRaw)) fieldErrors.dateFrom = ['required, YYYY-MM-DD'];
  if (!dateToRaw || !DATE_PATTERN.test(dateToRaw)) fieldErrors.dateTo = ['required, YYYY-MM-DD'];
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid date range.', fieldErrors }, requestId);
  }
  const dateFrom = new Date(`${dateFromRaw}T00:00:00.000Z`);
  const dateTo = new Date(`${dateToRaw}T00:00:00.000Z`);
  if (dateFrom > dateTo) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'dateFrom must be <= dateTo.', fieldErrors: { dateFrom: ['must be on or before dateTo'] } }, requestId);
  }
  const spanDays = Math.round((dateTo.getTime() - dateFrom.getTime()) / MS_PER_DAY) + 1;
  if (spanDays > MAX_CUSTOM_REPORT_DAYS) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: `Date range must be ${MAX_CUSTOM_REPORT_DAYS} days or fewer.`, fieldErrors: { dateTo: [`range exceeds ${MAX_CUSTOM_REPORT_DAYS} days`] } }, requestId);
  }

  const employeeIds = parseIdList(url.searchParams, 'employeeIds');
  const siteIds = parseIdList(url.searchParams, 'siteIds');
  for (const [label, ids] of [['employeeIds', employeeIds], ['siteIds', siteIds]] as const) {
    if (ids && ids.some((id) => !UUID_PATTERN.test(id))) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: `Invalid ${label}.`, fieldErrors: { [label]: ['must be a list of UUIDs'] } }, requestId);
    }
  }

  const dataModeRaw = url.searchParams.get('dataMode') ?? 'FINAL_APPROVED_ONLY';
  if (dataModeRaw !== 'FINAL_APPROVED_ONLY' && dataModeRaw !== 'CURRENT_CANONICAL') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid dataMode.', fieldErrors: { dataMode: ['must be FINAL_APPROVED_ONLY or CURRENT_CANONICAL'] } }, requestId);
  }
  const dataMode = dataModeRaw as CustomReportDataMode;

  const detailRaw = url.searchParams.get('detail') ?? 'SUMMARY';
  if (detailRaw !== 'SUMMARY' && detailRaw !== 'DETAILED') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid detail.', fieldErrors: { detail: ['must be SUMMARY or DETAILED'] } }, requestId);
  }

  const formatRaw = url.searchParams.get('format') ?? 'CSV';
  if (formatRaw !== 'CSV' && formatRaw !== 'PDF') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid format.', fieldErrors: { format: ['must be CSV or PDF'] } }, requestId);
  }

  // Deliberately NOT the admin's own UI locale — accounting/report exports always render in
  // English, independent of the admin's display language (data entry stays Russian-friendly).
  const locale: AppLocale = 'EN';
  const report = await getCustomTimeReport({ dateFrom, dateTo, employeeIds, siteIds, dataMode });

  if (formatRaw === 'CSV') {
    const content = detailRaw === 'SUMMARY' ? buildCustomReportSummaryCsv(report, locale) : buildCustomReportDetailedCsv(report, locale);
    return new NextResponse(new Uint8Array(content), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${customReportCsvFileName(report)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'X-Request-Id': requestId
      }
    });
  }

  const workersLabel = employeeIds === null ? 'All' : report.employees.length > 0 ? report.employees.map((e) => `${e.lastName} ${e.firstName}`).join(', ') : 'None';
  const sitesLabel = siteIds === null ? 'All' : report.sites.length > 0 ? report.sites.map((s) => s.name).join(', ') : 'None';
  const dataModeLabel = dataMode === 'FINAL_APPROVED_ONLY' ? 'Final approved only' : 'Current canonical data';
  const generatedAtHelsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

  const pdfBuffer = detailRaw === 'SUMMARY'
    ? await buildCustomReportSummaryPdf(report, { generatedAtHelsinki, workersLabel, sitesLabel, dataModeLabel }, locale)
    : await buildCustomReportDetailedPdf(report, { generatedAtHelsinki, workersLabel, sitesLabel, dataModeLabel }, locale);

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${customReportPdfFileName(report)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'X-Request-Id': requestId
    }
  });
}
