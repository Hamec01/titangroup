import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getPeriodTimeReport } from '@/lib/period-time-report';
import { createReportFile, type ReportFileFormat } from '@/lib/report-files';
import { buildPeriodReportCsv, periodReportCsvFileName } from '@/lib/reporting/period-report-csv';
import { buildPeriodReportPdf, periodReportPdfFileName } from '@/lib/reporting/period-report-pdf';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const READ_PERMISSIONS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all', 'export.read'];

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== 'titanor-time') return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  for (const permission of READ_PERMISSIONS) if (!(await hasPermission(authenticated.user.roles, permission))) return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'export.create'))) return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);

  let body: { periodId?: unknown; format?: unknown };
  try { body = await request.json(); } catch { return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be JSON.' }, requestId); }
  const periodId = typeof body.periodId === 'string' ? body.periodId : '';
  const format = body.format === 'PDF' || body.format === 'CSV' ? body.format : null;
  if (!UUID_PATTERN.test(periodId) || !format) return jsonError(400, { code: 'VALIDATION_ERROR', message: 'periodId and format are required.', fieldErrors: { periodId: ['invalid'], format: ['must be PDF or CSV'] } }, requestId);

  const result = await getPeriodTimeReport(periodId, { page: 1, pageSize: 100 });
  if (result.code === 'PERIOD_NOT_FOUND') return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  const generatedAt = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Helsinki', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const report = result.report;
  const content = format === 'CSV' ? buildPeriodReportCsv(report) : await buildPeriodReportPdf(report, generatedAt);
  const file = await createReportFile({
    periodId,
    reportType: 'PERIOD_SUMMARY',
    format: format as ReportFileFormat,
    fileName: format === 'CSV' ? periodReportCsvFileName(report) : periodReportPdfFileName(report),
    mimeType: format === 'CSV' ? 'text/csv; charset=utf-8' : 'application/pdf',
    content,
    rowCount: report.sites.length + 1,
    createdByUserId: authenticated.user.id
  });
  return NextResponse.json({ file }, { status: 201, headers: successHeaders(requestId) });
}
