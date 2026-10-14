import { NextRequest, NextResponse } from 'next/server';
import { guardApiRequest, isUuid } from '@/lib/api-guard';
import { jsonError } from '@/lib/api-error';
import { createAuditEvent } from '@/lib/audit';
import { prisma } from '@/lib/prisma';
import { helsinkiToday } from '@/lib/workers';
import { attachmentContentDisposition } from '@/lib/reporting/content-disposition';
import { isValidMonth, loadCustomerMonthMatrix } from '@/lib/reporting/monthly-matrix';
import { buildMonthlyMatrixXlsx, monthlyMatrixXlsxFileName } from '@/lib/reporting/monthly-matrix-xlsx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

// Табель v2 → "Скачать Excel": GET ?siteId=…&workArea=<workAreaId|none>&month=YYYY-MM. Same data as
// the on-screen month grid (loadCustomerMonthMatrix); same permissions as the other timesheet exports.
export async function GET(request: NextRequest) {
  const guard = await guardApiRequest(request, { permission: ['timesheet.read.all', 'export.read'] });
  if (!guard.ok) return guard.response;
  const { session, requestId } = guard;
  const sp = request.nextUrl.searchParams;
  const siteId = sp.get('siteId');
  const workArea = sp.get('workArea');
  const month = sp.get('month');
  if (!isUuid(siteId) || !workArea || (workArea !== 'none' && !isUuid(workArea)) || !month || !isValidMonth(month)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'siteId, workArea (uuid or none) and month (YYYY-MM) are required.' }, requestId);
  }
  const workAreaId = workArea === 'none' ? null : workArea;
  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { name: true } });
  const area = workAreaId ? await prisma.workArea.findFirst({ where: { id: workAreaId, siteId }, select: { name: true } }) : null;
  if (!site || (workAreaId && !area)) return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' }, requestId);

  const todayIso = helsinkiToday().toISOString().slice(0, 10);
  const outcome = await loadCustomerMonthMatrix(month, { siteId, workAreaId }, { userId: session.user.id, employeeId: session.user.employeeId }, todayIso);
  if (!outcome.ok) return jsonError(409, { code: 'SELECTION_TOO_LARGE', message: 'Too much data for one month.' }, requestId);

  const customerName = area?.name ?? 'No customer';
  const generatedAt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const content = buildMonthlyMatrixXlsx(outcome.matrix, { customerName, siteName: site.name, generatedAt });

  await prisma.$transaction((tx) =>
    createAuditEvent(tx, {
      actorUserId: session.user.id,
      eventType: 'REPORT_EXPORTED',
      entityType: 'CUSTOMER_MONTH_MATRIX',
      entityId: null,
      requestId,
      beforeValue: null,
      afterValue: { report: 'CUSTOMER_MONTH_MATRIX', format: 'XLSX', month, siteId, workAreaId, workerCount: outcome.matrix.rows.length, totalMinutes: outcome.matrix.totalMinutes }
    })
  );

  return new NextResponse(new Uint8Array(content), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': attachmentContentDisposition(monthlyMatrixXlsxFileName(customerName, month)),
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
      ...NO_STORE
    }
  });
}
