import path from 'node:path';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { companyLegalInfo } from '@/lib/reporting/company-legal-info';
import type { CustomerTimeReport } from '@/lib/reporting/customer-time-report';

// R15-D7 Deploy F — "Часы заказчику" PDF. One section per selected customer: customer + site
// header, a row per worker (name · number · work dates · worked hours), a customer total, and a
// grand total when more than one customer. pdfkit + embedded DejaVu Sans + the Titanor logo.
// NO signature, NO invoice, NO money/rates/TES, NO henkilötunnus / address / phone / GPS. English.

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');
const LOGO_PATH = path.join(process.cwd(), 'assets/brand/titanor-group.png');

export interface CustomerHoursMeta {
  /** Resolved server-side by workArea id — never the browser's text (single-customer reports). */
  generatedAtHelsinki: string;
  preparedBy: string;
  isFinalApproved: boolean;
}

const ROW_HEIGHT = 19;
const HEADER_ROW_HEIGHT = 20;
const CELL_H = 11;

function finalizePdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export async function buildCustomerHoursPdf(report: CustomerTimeReport, meta: CustomerHoursMeta): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margins: { top: 46, bottom: 44, left: 40, right: 40 }, bufferPages: true, autoFirstPage: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH);
  doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH);
  doc.font('DejaVu');
  const x = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const company = companyLegalInfo();

  let y = doc.page.margins.top;
  if (existsSync(LOGO_PATH)) doc.image(LOGO_PATH, x, y, { width: 110 });
  const titleX = x + 126;
  doc.font('DejaVu-Bold').fontSize(15).text(company.legalName, titleX, y);
  doc.font('DejaVu').fontSize(8.5).fillColor('#555555');
  let ly = y + 20;
  if (company.businessId) {
    doc.text(`Business ID: ${company.businessId}`, titleX, ly);
    ly += 11;
  }
  if (company.address) {
    doc.text(company.address, titleX, ly, { width: contentWidth - 126 });
    ly += 11;
  }
  doc.fillColor('#000000');
  y = Math.max(y + 52, ly + 6);

  doc.font('DejaVu-Bold').fontSize(13).text('CUSTOMER WORKING HOURS', x, y);
  y += 17;
  doc.font('DejaVu-Bold').fontSize(9.5).fillColor(meta.isFinalApproved ? '#1f7a3d' : '#a34d00');
  doc.text(meta.isFinalApproved ? 'FINAL APPROVED' : 'NOT FINAL — INTERNAL PREVIEW', x, y);
  doc.fillColor('#000000');
  y += 18;

  doc.font('DejaVu').fontSize(9);
  const customerLabels = report.sections.map((s) => `${s.workAreaName ?? '(no customer)'} — ${s.siteName}`);
  const headLines: [string, string][] = [
    ['Customer(s)', customerLabels.join('; ') || '—'],
    ['Period', `${report.dateFrom} – ${report.dateTo}`],
    ['Workers', String(report.grandWorkerCount)],
    ['Generated (Europe/Helsinki)', meta.generatedAtHelsinki],
    ['Prepared by', meta.preparedBy]
  ];
  for (const [label, value] of headLines) {
    doc.font('DejaVu-Bold').text(`${label}: `, x, y, { continued: true });
    doc.font('DejaVu').text(value);
    y += 13;
  }
  y += 8;

  // Table geometry: Employee | Number | Work dates | Worked
  const cols = [
    { w: 170, align: 'left' as const },
    { w: 70, align: 'left' as const },
    { w: contentWidth - 170 - 70 - 66, align: 'left' as const },
    { w: 66, align: 'right' as const }
  ];
  const totalW = cols.reduce((a, c) => a + c.w, 0);

  const drawColHead = (yy: number): number => {
    doc.font('DejaVu-Bold').fontSize(8);
    doc.rect(x, yy, totalW, HEADER_ROW_HEIGHT).fillAndStroke('#eeeeee', '#333333');
    doc.fillColor('#000000');
    const labels = ['Employee', 'Number', 'Work dates', 'Worked'];
    let cx = x;
    for (let i = 0; i < cols.length; i++) {
      doc.text(labels[i], cx + 3, yy + 6, { width: cols[i].w - 6, align: cols[i].align, lineBreak: false });
      cx += cols[i].w;
    }
    doc.font('DejaVu').fontSize(8);
    return yy + HEADER_ROW_HEIGHT;
  };
  const drawRow = (cells: string[], yy: number, bold = false): number => {
    doc.font(bold ? 'DejaVu-Bold' : 'DejaVu').fontSize(8);
    doc.rect(x, yy, totalW, ROW_HEIGHT).stroke('#cccccc');
    let cx = x;
    for (let i = 0; i < cols.length; i++) {
      doc.text(cells[i] ?? '', cx + 3, yy + 5, { width: cols[i].w - 6, height: CELL_H, align: cols[i].align, lineBreak: false, ellipsis: true });
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

  for (const section of report.sections) {
    ensure(HEADER_ROW_HEIGHT + ROW_HEIGHT * 2 + 24);
    doc.font('DejaVu-Bold').fontSize(10.5).text(`${section.workAreaName ?? '(no customer)'}`, x, y);
    y += 14;
    doc.font('DejaVu').fontSize(8.5).fillColor('#555555');
    doc.text(`Site: ${section.siteName}${section.customerActive ? '' : '  (customer disabled)'}   ·   assigned now: ${section.assignedNowCount}   ·   worked in period: ${section.workedInPeriodCount}`, x, y);
    doc.fillColor('#000000');
    y += 14;
    y = drawColHead(y);
    for (const w of section.workers) {
      ensure(ROW_HEIGHT);
      if (y === doc.page.margins.top) y = drawColHead(y);
      y = drawRow(
        [`${w.employee.lastName} ${w.employee.firstName}`, w.employee.employeeNumber, w.workDates.join(', ') || '—', formatWorkedDuration(w.workedMinutes, 'EN')],
        y
      );
    }
    ensure(ROW_HEIGHT);
    y = drawRow(['Customer total', '', '', formatWorkedDuration(section.totalMinutes, 'EN')], y, true);
    y += 12;
  }

  if (report.sections.length > 1) {
    ensure(ROW_HEIGHT + 6);
    doc.font('DejaVu-Bold').fontSize(9.5);
    doc.rect(x, y, totalW, ROW_HEIGHT).fillAndStroke('#f3f3f3', '#333333');
    doc.fillColor('#000000');
    doc.text('GRAND TOTAL', x + 3, y + 5, { width: totalW - 72, lineBreak: false });
    doc.text(formatWorkedDuration(report.grandTotalMinutes, 'EN'), x + totalW - 69, y + 5, { width: 66, align: 'right', lineBreak: false });
    y += ROW_HEIGHT;
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const ob = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('DejaVu').fontSize(7).fillColor('#555555');
    doc.text(`Page ${i + 1} of ${range.count}`, 0, height - ob + 14, { width, align: 'center', lineBreak: false });
    doc.text('Working time only — no salary, rates or TES calculation. Not an invoice.', 0, height - ob + 24, { width, align: 'center', lineBreak: false });
    doc.fillColor('#000000');
    doc.page.margins.bottom = ob;
  }

  return finalizePdf(doc);
}

export function customerHoursPdfFileName(report: CustomerTimeReport): string {
  const one = report.sections.length === 1 ? report.sections[0].workAreaName : null;
  const slug = (one ?? 'customers').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'customers';
  return `titanor-customer-hours_${slug}_${report.dateFrom}_${report.dateTo}.pdf`;
}
