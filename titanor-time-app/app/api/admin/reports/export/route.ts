import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';
import { getPeriodTimeReport } from '@/lib/period-time-report';
import { getSiteTimeReport } from '@/lib/site-time-report';
import { getWorkerTimeReport } from '@/lib/worker-time-report';
import { createReportFile, ReportFileValidationError, type ReportFileFormat, type ReportType } from '@/lib/report-files';
import { REPORT_TYPE_NAME, type WorkingReportMeta } from '@/lib/reporting/working-report';
import { buildPeriodReportCsv, periodReportCsvFileName } from '@/lib/reporting/period-report-csv';
import { buildPeriodReportPdf, periodReportPdfFileName } from '@/lib/reporting/period-report-pdf';
import { buildSiteReportCsv, siteReportCsvFileName } from '@/lib/reporting/site-report-csv';
import { buildSiteReportPdf, siteReportPdfFileName } from '@/lib/reporting/site-report-pdf';
import { buildWorkerReportCsv, workerReportCsvFileName } from '@/lib/reporting/worker-report-csv';
import { buildWorkerReportPdf, workerReportPdfFileName } from '@/lib/reporting/worker-report-pdf';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §5 + §8 — POST /api/admin/reports/export.
// Creates one saved WORKING report (analytics snapshot, deletable) — never an official payroll
// export (that stays on POST /api/admin/periods/:periodId/export, immutable ExportBatch). Works for
// OPEN / LOCKED / EXPORTED periods alike. Idempotency-Key mandatory: a retry of the exact same
// request returns the already-created file; a fresh key is a new, deliberate snapshot (§8).

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/reports/export';
const READ_PERMISSIONS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all', 'export.read'];
const REPORT_TYPES: ReportType[] = ['PERIOD_SUMMARY', 'SITE_DETAIL', 'WORKER_DETAIL'];

function periodLabel(startDate: string, endDate: string): string {
  return `${startDate} – ${endDate}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  for (const permission of READ_PERMISSIONS) {
    if (!(await hasPermission(authenticated.user.roles, permission))) {
      return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
    }
  }
  if (!(await hasPermission(authenticated.user.roles, 'export.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let body: { periodId?: unknown; format?: unknown; reportType?: unknown; siteId?: unknown; employeeId?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be JSON.' }, requestId);
  }

  const periodId = typeof body.periodId === 'string' ? body.periodId : '';
  const format: ReportFileFormat | null = body.format === 'PDF' || body.format === 'CSV' ? body.format : null;
  const reportType = typeof body.reportType === 'string' && REPORT_TYPES.includes(body.reportType as ReportType) ? (body.reportType as ReportType) : null;
  const siteId = typeof body.siteId === 'string' ? body.siteId : null;
  const employeeId = typeof body.employeeId === 'string' ? body.employeeId : null;

  const fieldErrors: Record<string, string[]> = {};
  if (!UUID_PATTERN.test(periodId)) fieldErrors.periodId = ['must be a UUID'];
  if (!format) fieldErrors.format = ['must be PDF or CSV'];
  if (!reportType) fieldErrors.reportType = [`must be one of ${REPORT_TYPES.join(', ')}`];
  if (reportType === 'SITE_DETAIL' && (!siteId || !UUID_PATTERN.test(siteId))) fieldErrors.siteId = ['must be a UUID for a site detail report'];
  if (reportType === 'WORKER_DETAIL' && (!employeeId || !UUID_PATTERN.test(employeeId))) fieldErrors.employeeId = ['must be a UUID for a worker detail report'];
  if (Object.keys(fieldErrors).length > 0 || !format || !reportType) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid export request.', fieldErrors }, requestId);
  }

  // Idempotency — mandatory (§8.2). The hash binds the key to this exact target + intent.
  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  }
  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  const requestHash = computeRequestHash({ body: { periodId, format, reportType, siteId, employeeId } });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(
      409,
      {
        code: begin.code,
        message:
          begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS'
            ? 'A request with this Idempotency-Key is still being processed.'
            : 'This Idempotency-Key was already used for a different request.'
      },
      requestId
    );
  }

  const respond = async (statusCode: number, payload: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body: payload });
    return NextResponse.json(payload, { status: statusCode, headers: successHeaders(requestId) });
  };
  const respondError = (statusCode: number, code: string, message: string): Promise<NextResponse> =>
    respond(statusCode, { error: { code, message, requestId } });

  const generatedAtIso = new Date().toISOString();
  const generatedBy = `${authenticated.user.username} (${authenticated.user.roles.join(', ')})`;

  let content: Buffer;
  let fileName: string;
  let rowCount: number;

  if (reportType === 'PERIOD_SUMMARY') {
    const result = await getPeriodTimeReport(periodId, { all: true });
    if (result.code === 'PERIOD_NOT_FOUND') return respondError(404, 'PERIOD_NOT_FOUND', 'No period with this id.');
    const report = result.report;
    const meta: WorkingReportMeta = {
      reportType,
      periodLabel: periodLabel(report.period.startDate, report.period.endDate),
      periodStatus: report.period.status,
      generatedAtIso,
      generatedBy,
      filters: ['Company-wide (all sites)']
    };
    content = format === 'CSV' ? buildPeriodReportCsv(report, meta) : await buildPeriodReportPdf(report, meta);
    fileName = format === 'CSV' ? periodReportCsvFileName(report) : periodReportPdfFileName(report);
    rowCount = report.totalItems;
  } else if (reportType === 'SITE_DETAIL') {
    const result = await getSiteTimeReport(siteId as string, periodId, { all: true }, { kind: 'unrestricted' });
    if (result.code === 'SITE_NOT_FOUND' || result.code === 'SITE_REPORT_NOT_FOUND') return respondError(404, 'SITE_NOT_FOUND', 'No site with this id.');
    if (result.code === 'PERIOD_NOT_FOUND') return respondError(404, 'PERIOD_NOT_FOUND', 'No period with this id.');
    const report = result.report;
    const meta: WorkingReportMeta = {
      reportType,
      periodLabel: periodLabel(report.period.startDate, report.period.endDate),
      periodStatus: report.period.status,
      generatedAtIso,
      generatedBy,
      filters: [`Site: ${report.site.name}`]
    };
    content = format === 'CSV' ? buildSiteReportCsv(report, meta) : await buildSiteReportPdf(report, meta);
    fileName = format === 'CSV' ? siteReportCsvFileName(report) : siteReportPdfFileName(report);
    rowCount = report.totalItems;
  } else {
    const result = await getWorkerTimeReport(employeeId as string, periodId);
    if (result.code === 'WORKER_NOT_FOUND') return respondError(404, 'WORKER_NOT_FOUND', 'No worker with this id.');
    if (result.code === 'PERIOD_NOT_FOUND') return respondError(404, 'PERIOD_NOT_FOUND', 'No period with this id.');
    const report = result.report;
    const meta: WorkingReportMeta = {
      reportType,
      periodLabel: periodLabel(report.period.startDate, report.period.endDate),
      periodStatus: report.period.status,
      generatedAtIso,
      generatedBy,
      filters: [`Worker: ${report.employee.lastName} ${report.employee.firstName} (${report.employee.employeeNumber})`]
    };
    content = format === 'CSV' ? buildWorkerReportCsv(report, meta) : await buildWorkerReportPdf(report, meta);
    fileName = format === 'CSV' ? workerReportCsvFileName(report) : workerReportPdfFileName(report);
    rowCount = report.sites.length;
  }

  try {
    const file = await createReportFile({
      periodId,
      reportType,
      format: format as ReportFileFormat,
      fileName,
      content,
      rowCount,
      createdByUserId: authenticated.user.id,
      requestId
    });
    return respond(201, { file, reportTypeName: REPORT_TYPE_NAME[reportType] });
  } catch (error) {
    if (error instanceof ReportFileValidationError) {
      return respondError(422, 'REPORT_FILE_INVALID', error.message);
    }
    throw error;
  }
}
