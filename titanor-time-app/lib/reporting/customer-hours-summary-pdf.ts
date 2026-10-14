import path from 'node:path';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { companyLegalInfo } from '@/lib/reporting/company-legal-info';
import type { CustomerHoursSummaryResult } from '@/lib/reporting/customer-hours-summary';
import type { SummaryExportMode } from '@/lib/reporting/customer-hours-summary-csv';

// UT8-B — the new customer-facing "Сводка" PDF. Same visual/library conventions as the legacy
// customer-hours-pdf.ts (pdfkit + embedded DejaVu Sans + the Titanor logo, NO signature/invoice/
// money/rates/TES/personal documents/GPS), but reads EXCLUSIVELY from CustomerHoursSummaryResult —
// the exact WeeklyCustomerSliceRow numbers "Табель" already shows. Landscape (more columns than the
// legacy 4-column report: week, employee, number, hours, status, confirmed by/at).

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');
const LOGO_PATH = path.join(process.cwd(), 'assets/brand/titanor-group.png');

export interface CustomerHoursSummaryPdfMeta {
  generatedAtHelsinki: string;
  preparedBy: string;
}

const ROW_HEIGHT = 18;
const HEADER_ROW_HEIGHT = 19;
const CELL_H = 10;

function finalizePdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const STATUS_LABEL_EN: Record<string, string> = {
  APPROVED: 'Confirmed',
  READY: 'Pending',
  NEEDS_ATTENTION: 'Pending',
  CHANGED_AFTER_APPROVAL: 'Changed after confirmation'
};

export async function buildCustomerHoursSummaryPdf(summary: CustomerHoursSummaryResult, mode: SummaryExportMode, meta: CustomerHoursSummaryPdfMeta): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 }, bufferPages: true, autoFirstPage: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH);
  doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH);
  doc.font('DejaVu');
  const x = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const company = companyLegalInfo();

  let y = doc.page.margins.top;
  if (existsSync(LOGO_PATH)) doc.image(LOGO_PATH, x, y, { width: 100 });
  const titleX = x + 116;
  doc.font('DejaVu-Bold').fontSize(14).text(company.legalName, titleX, y);
  doc.font('DejaVu').fontSize(8).fillColor('#555555');
  let ly = y + 18;
  if (company.businessId) {
    doc.text(`Business ID: ${company.businessId}`, titleX, ly);
    ly += 10;
  }
  doc.fillColor('#000000');
  y = Math.max(y + 44, ly + 6);

  const isRecorded = mode === 'recorded';
  doc.font('DejaVu-Bold').fontSize(12).text(isRecorded ? 'ФАКТИЧЕСКИ ЗАФИКСИРОВАННЫЕ ЧАСЫ / RECORDED WORKING HOURS' : 'CUSTOMER HOURS SUMMARY', x, y);
  y += 15;
  const isFinal = mode === 'final';
  doc.font('DejaVu-Bold').fontSize(9).fillColor(isFinal || isRecorded ? '#1f7a3d' : '#a34d00');
  doc.text(isRecorded ? 'ТЕКУЩИЕ ЗАФИКСИРОВАННЫЕ ЧАСЫ / CURRENT RECORDED HOURS' : isFinal ? 'CONFIRMED FOR CUSTOMER' : 'PREVIEW — CONTAINS UNCONFIRMED HOURS, NOT AN OFFICIAL DOCUMENT', x, y);
  doc.fillColor('#000000');
  y += 16;

  doc.font('DejaVu').fontSize(8.5);
  const headLines: [string, string][] = [
    ['Period', `${summary.requestedRange.startDate} – ${summary.requestedRange.endDate}`],
    [isRecorded ? 'Workers (recorded)' : 'Workers (confirmed)', String(isRecorded ? summary.totals.recordedWorkerCount : summary.totals.confirmedWorkerCount)],
    ['Generated (Europe/Helsinki)', meta.generatedAtHelsinki],
    ['Prepared by', meta.preparedBy]
  ];
  for (const [label, value] of headLines) {
    doc.font('DejaVu-Bold').text(`${label}: `, x, y, { continued: true });
    doc.font('DejaVu').text(value);
    y += 12;
  }
  y += 6;

  // Table geometry: Week | Employee | Number | Hours | Status | Confirmed by | Confirmed at
  const cols = isRecorded
    ? [
        { w: 150, align: 'left' as const },
        { w: contentWidth - 150 - 120 - 100, align: 'left' as const },
        { w: 120, align: 'left' as const },
        { w: 100, align: 'right' as const }
      ]
    : [
        { w: 90, align: 'left' as const },
        { w: 170, align: 'left' as const },
        { w: 90, align: 'left' as const },
        { w: 70, align: 'right' as const },
        { w: 130, align: 'left' as const },
        { w: 150, align: 'left' as const },
        { w: contentWidth - 90 - 170 - 90 - 70 - 130 - 150, align: 'left' as const }
      ];
  const totalW = cols.reduce((a, c) => a + c.w, 0);

  const drawColHead = (yy: number): number => {
    doc.font('DejaVu-Bold').fontSize(7.5);
    doc.rect(x, yy, totalW, HEADER_ROW_HEIGHT).fillAndStroke('#eeeeee', '#333333');
    doc.fillColor('#000000');
    const labels = isRecorded ? ['Week', 'Employee', 'Number', 'Hours'] : ['Week', 'Employee', 'Number', 'Hours', 'Status', 'Confirmed by', 'Confirmed at'];
    let cx = x;
    for (let i = 0; i < cols.length; i++) {
      doc.text(labels[i], cx + 3, yy + 6, { width: cols[i].w - 6, align: cols[i].align, lineBreak: false });
      cx += cols[i].w;
    }
    doc.font('DejaVu').fontSize(7.5);
    return yy + HEADER_ROW_HEIGHT;
  };
  const drawRow = (cells: string[], yy: number, bold = false): number => {
    doc.font(bold ? 'DejaVu-Bold' : 'DejaVu').fontSize(7.5);
    doc.rect(x, yy, totalW, ROW_HEIGHT).stroke('#cccccc');
    let cx = x;
    for (let i = 0; i < cols.length; i++) {
      doc.text(cells[i] ?? '', cx + 3, yy + 4, { width: cols[i].w - 6, height: CELL_H, align: cols[i].align, lineBreak: false, ellipsis: true });
      cx += cols[i].w;
    }
    return yy + ROW_HEIGHT;
  };
  const ensure = (need: number) => {
    if (y + need > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };

  // UT8-B-fixup-3 #2 — final never includes a row whose worker hasn't actually submitted it, even if
  // an admin pre-confirmed the draft (a second, renderer-level guarantee alongside
  // loadCustomerHoursSummary's own readyForCustomerExport/blockers refusal at the route level).
  const sourceRows = isFinal ? summary.rows.filter((r) => r.approvalState === 'APPROVED' && r.submissionState === 'SUBMITTED') : summary.rows;
  const byCustomerKey = new Map<string, typeof sourceRows>();
  for (const r of sourceRows) {
    const key = `${r.logicalKey.siteId}::${r.logicalKey.workAreaId ?? ''}`;
    const list = byCustomerKey.get(key) ?? [];
    list.push(r);
    byCustomerKey.set(key, list);
  }

  for (const cust of summary.byCustomer) {
    const key = `${cust.siteId}::${cust.workAreaId ?? ''}`;
    const rowsForCustomer = byCustomerKey.get(key) ?? [];
    if (rowsForCustomer.length === 0) continue; // nothing to export for this customer under this mode
    rowsForCustomer.sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.logicalKey.weekStart.localeCompare(b.logicalKey.weekStart));

    ensure(HEADER_ROW_HEIGHT + ROW_HEIGHT * 2 + 22);
    doc.font('DejaVu-Bold').fontSize(10).text(cust.workAreaName ?? '(no customer)', x, y);
    y += 13;
    doc.font('DejaVu').fontSize(8).fillColor('#555555');
    doc.text(`Site: ${cust.siteName}`, x, y);
    doc.fillColor('#000000');
    y += 13;
    y = drawColHead(y);

    let customerTotal = 0;
    for (const r of rowsForCustomer) {
      ensure(ROW_HEIGHT);
      if (y === doc.page.margins.top) y = drawColHead(y);
      const weekLabel = `${r.logicalKey.weekStart} – ${r.logicalKey.weekEnd}`;
      // UT8-B-fixup-3 #2 — submissionState wins over approvalState for the DISPLAYED status.
      const status = r.submissionState === 'SUBMITTED' ? (STATUS_LABEL_EN[r.approvalState] ?? r.approvalState) : 'Not submitted';
      const confirmedBy = r.currentApprovalItem?.approvedByUserName ?? '—';
      const confirmedAt = r.currentApprovalItem ? formatHelsinkiDateTime(r.currentApprovalItem.approvedAt) : '—';
      y = drawRow(isRecorded ? [weekLabel, `${r.employeeName}`, r.employeeNumber, formatWorkedDuration(r.workedMinutes, 'EN')] : [weekLabel, `${r.employeeName}`, r.employeeNumber, formatWorkedDuration(r.workedMinutes, 'EN'), status, confirmedBy, confirmedAt], y);
      customerTotal += r.workedMinutes;
    }
    ensure(ROW_HEIGHT);
    y = drawRow(isRecorded ? ['', 'Customer total', '', formatWorkedDuration(customerTotal, 'EN')] : ['', '', '', formatWorkedDuration(customerTotal, 'EN'), 'Customer total', '', ''], y, true);
    y += 10;
  }

  if (summary.byCustomer.filter((c) => (byCustomerKey.get(`${c.siteId}::${c.workAreaId ?? ''}`) ?? []).length > 0).length > 1) {
    const grandTotal = sourceRows.reduce((s, r) => s + r.workedMinutes, 0);
    ensure(ROW_HEIGHT + 6);
    doc.font('DejaVu-Bold').fontSize(9.5);
    doc.rect(x, y, totalW, ROW_HEIGHT).fillAndStroke('#f3f3f3', '#333333');
    doc.fillColor('#000000');
    doc.text('GRAND TOTAL', x + 3, y + 4, { width: totalW - 76, lineBreak: false });
    doc.text(formatWorkedDuration(grandTotal, 'EN'), x + totalW - 73, y + 4, { width: 70, align: 'right', lineBreak: false });
    y += ROW_HEIGHT;
  }

  // UT8-B-fixup #2 — preview only: historical (removed / source-unreadable) rows and whole-timesheet
  // source errors get their OWN clearly-separated section, reusing the SAME 7-column table layout —
  // never folded into the customer tables or the GRAND TOTAL above (that total only ever sums
  // `sourceRows`). Never emitted for mode='final' — the route already refuses to reach here at all
  // while either list is non-empty, but this is a second, defensive guarantee at the renderer level.
  if (mode === 'preview' && (summary.historical.length > 0 || summary.sourceErrors.length > 0)) {
    y += 12;
    ensure(HEADER_ROW_HEIGHT + ROW_HEIGHT + 20);
    doc.font('DejaVu-Bold').fontSize(10).text('Removed / historically confirmed hours (NOT included in any total above)', x, y);
    y += 15;
    y = drawColHead(y);
    for (const h of summary.historical) {
      ensure(ROW_HEIGHT);
      if (y === doc.page.margins.top) y = drawColHead(y);
      const weekLabel = `${h.weekStart} – ${h.weekEnd}`;
      const status = h.reason === 'SLICE_REMOVED' ? 'Removed after confirmation' : 'Source unreadable';
      y = drawRow([weekLabel, h.employeeName, h.employeeNumber, formatWorkedDuration(h.lastApproval.workedMinutes, 'EN'), status, h.lastApproval.approvedByUserName, formatHelsinkiDateTime(h.lastApproval.approvedAt)], y);
    }
    for (const se of summary.sourceErrors) {
      ensure(ROW_HEIGHT);
      if (y === doc.page.margins.top) y = drawColHead(y);
      y = drawRow(['—', se.employeeName, se.employeeNumber, '—', 'Technically unreadable', '—', '—'], y);
    }
    if (summary.totals.historicalTruncated) {
      y += 8;
      ensure(14);
      doc.font('DejaVu-Bold').fontSize(8).fillColor('#a34d00');
      doc.text('This historical list is incomplete for this selection — narrow the filter to see everything.', x, y, { width: totalW });
      doc.fillColor('#000000');
      y += 14;
    }
  }

  // UT8-B-fixup-2/fixup-3 #1 — preview only: workers expected to have a timesheet for this period
  // with no SUBMITTED content at all (no Timesheet whatsoever, or one still stuck at an empty
  // DRAFT/RETURNED). No customer/site attribution and no hours (nothing to have hours for) — its
  // own clearly separate section, never folded into any total above. A DRAFT/RETURNED slice that
  // DOES have hours appears as a normal row above instead, labeled "Not submitted".
  if (mode === 'preview' && summary.notSubmitted.length > 0) {
    y += 12;
    ensure(HEADER_ROW_HEIGHT + ROW_HEIGHT + 20);
    doc.font('DejaVu-Bold').fontSize(10).text('Not submitted (no submitted timesheet for this period)', x, y);
    y += 15;
    y = drawColHead(y);
    for (const ns of summary.notSubmitted) {
      ensure(ROW_HEIGHT);
      if (y === doc.page.margins.top) y = drawColHead(y);
      const periodLabel = `${ns.periodStartDate} – ${ns.periodEndDate}`;
      y = drawRow([periodLabel, ns.employeeName, ns.employeeNumber, '—', 'Not submitted', '—', '—'], y);
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const ob = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('DejaVu').fontSize(7).fillColor('#555555');
    doc.text(`Page ${i + 1} of ${range.count}`, 0, height - ob + 12, { width, align: 'center', lineBreak: false });
    doc.text(
      isRecorded
        ? 'Actual recorded working hours. Not an invoice — no salary, rates or TES calculation.'
        : isFinal
          ? 'Confirmed working hours per customer. Not an invoice — no salary, rates or TES calculation.'
          : 'PREVIEW — contains unconfirmed / changed hours. Not an official document.',
      0,
      height - ob + 22,
      { width, align: 'center', lineBreak: false }
    );
    doc.fillColor('#000000');
    doc.page.margins.bottom = ob;
  }

  return finalizePdf(doc);
}

export function customerHoursSummaryPdfFileName(summary: CustomerHoursSummaryResult, mode: SummaryExportMode): string {
  const one = summary.byCustomer.length === 1 ? summary.byCustomer[0].workAreaName : null;
  const slug = (one ?? 'customers').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'customers';
  const modeTag = mode === 'preview' ? '_preview' : mode === 'recorded' ? '_recorded' : '';
  return `titanor-summary_${slug}_${summary.requestedRange.startDate}_${summary.requestedRange.endDate}${modeTag}.pdf`;
}
