import path from 'node:path';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { companyLegalInfo } from '@/lib/reporting/company-legal-info';
import type { CustomTimeReport } from '@/lib/reporting/custom-time-report';

// T13.11 — Customer Project Working Hours PDF. A document for the customer: confirmed hours by
// site. pdfkit + embedded DejaVu Sans + the real Titanor logo. NO signature, NO invoice, NO
// money, NO TES, NO henkilötunnus / address / phone / contract. Always renders in English.

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');
const LOGO_PATH = path.join(process.cwd(), 'assets/brand/titanor-group.png');

export interface CustomerHoursMeta {
  customer: string;
  projectReference: string;
  generatedAtHelsinki: string;
  preparedBy: string;
  isFinalApproved: boolean;
}

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}
const ROW_HEIGHT = 20;
const HEADER_ROW_HEIGHT = 22;

function finalizePdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function helsinkiTime(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export async function buildCustomerHoursPdf(report: CustomTimeReport, meta: CustomerHoursMeta): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margins: { top: 46, bottom: 44, left: 40, right: 40 }, bufferPages: true, autoFirstPage: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH);
  doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH);
  doc.font('DejaVu');
  const x = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const company = companyLegalInfo();

  let y = doc.page.margins.top;
  if (existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, x, y, { width: 110 });
  }
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
  y = Math.max(y + 84, ly + 6);

  doc.font('DejaVu-Bold').fontSize(13).text('WORKING TIME REPORT', x, y);
  y += 17;
  doc.font('DejaVu-Bold').fontSize(9.5).fillColor(meta.isFinalApproved ? '#1f7a3d' : '#a34d00');
  doc.text(meta.isFinalApproved ? 'FINAL APPROVED' : 'NOT FINAL — INTERNAL PREVIEW', x, y);
  doc.fillColor('#000000');
  y += 18;

  doc.font('DejaVu').fontSize(9);
  const lines: [string, string][] = [
    ['Customer', meta.customer || '—'],
    ['Project / Reference', meta.projectReference || '—'],
    ['Sites', report.sites.length > 0 ? report.sites.map((s) => s.name).join(', ') : 'All'],
    ['Period', `${report.dateFrom} – ${report.dateTo}`],
    ['Generated (Europe/Helsinki)', meta.generatedAtHelsinki],
    ['Prepared by', meta.preparedBy]
  ];
  for (const [label, value] of lines) {
    doc.font('DejaVu-Bold').text(`${label}: `, x, y, { continued: true });
    doc.font('DejaVu').text(value);
    y += 13;
  }
  y += 8;

  const columns: Column[] = [
    { header: 'Date', width: 58 },
    { header: 'Employee', width: 130 },
    { header: 'Site', width: 110 },
    { header: 'Start', width: 40, align: 'right' },
    { header: 'End', width: 40, align: 'right' },
    { header: 'Worked', width: 60, align: 'right' }
  ];
  const totalWidth = columns.reduce((a, c) => a + c.width, 0);
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  const drawHead = (yy: number): number => {
    doc.font('DejaVu-Bold').fontSize(8);
    doc.rect(x, yy, totalWidth, HEADER_ROW_HEIGHT).fillAndStroke('#eeeeee', '#333333');
    doc.fillColor('#000000');
    let cx = x;
    for (const c of columns) {
      doc.text(c.header, cx + 3, yy + 6, { width: c.width - 6, align: c.align ?? 'left', lineBreak: false });
      cx += c.width;
    }
    doc.font('DejaVu').fontSize(8);
    return yy + HEADER_ROW_HEIGHT;
  };
  const drawRow = (cells: string[], yy: number, bold = false): number => {
    doc.font(bold ? 'DejaVu-Bold' : 'DejaVu').fontSize(8);
    doc.rect(x, yy, totalWidth, ROW_HEIGHT).stroke('#cccccc');
    let cx = x;
    for (let i = 0; i < columns.length; i++) {
      doc.text(cells[i] ?? '', cx + 3, yy + 5, { width: columns[i].width - 6, align: columns[i].align ?? 'left', lineBreak: false });
      cx += columns[i].width;
    }
    return yy + ROW_HEIGHT;
  };

  y = drawHead(y);
  for (const d of report.dailyRows) {
    if (y + ROW_HEIGHT > bottomLimit) {
      doc.addPage();
      y = drawHead(doc.page.margins.top);
    }
    y = drawRow([d.date, `${d.employee.lastName} ${d.employee.firstName}`, d.site.name, helsinkiTime(d.firstStartAt), helsinkiTime(d.lastEndAt), formatWorkedDuration(d.workedMinutes, 'EN')], y);
  }

  const ensure = () => {
    if (y + ROW_HEIGHT > bottomLimit) {
      doc.addPage();
      y = drawHead(doc.page.margins.top);
    }
  };
  if (report.siteSubtotals.length > 1) {
    for (const s of report.siteSubtotals) {
      ensure();
      y = drawRow([`Subtotal — ${s.site.name}`, '', '', '', '', formatWorkedDuration(s.totals.workedMinutes, 'EN')], y, true);
    }
  }
  if (report.employeeSubtotals.length > 1) {
    for (const e of report.employeeSubtotals) {
      ensure();
      y = drawRow([`Subtotal — ${e.employee.lastName} ${e.employee.firstName}`, '', '', '', '', formatWorkedDuration(e.totals.workedMinutes, 'EN')], y, true);
    }
  }
  ensure();
  drawRow(['GRAND TOTAL', '', '', '', '', formatWorkedDuration(report.grandTotal.workedMinutes, 'EN')], y, true);

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

export function customerHoursPdfFileName(report: CustomTimeReport): string {
  return `titanor-project-hours_${report.dateFrom}_${report.dateTo}.pdf`;
}
