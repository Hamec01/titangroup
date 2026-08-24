import path from 'node:path';
import PDFDocument from 'pdfkit';
import { formatWorkedDuration, timesheetStatusLabel } from '@/lib/reporting/report-format';
import type { CustomTimeReport } from '@/lib/reporting/custom-time-report';
import type { AppLocale } from '@/lib/i18n/locale';

// Part A PDF export (task spec §7) — a plain accounting document via pdfkit (the one new
// server-side PDF dependency the task allows — no headless Chromium). DejaVu Sans is embedded
// (assets/fonts/DejaVuSans*.ttf) specifically because pdfkit's built-in Helvetica has zero
// Cyrillic coverage — without an embedded Unicode font, Russian worker names would render as
// empty boxes, which the task spec explicitly forbids. DejaVu Sans also covers Finnish
// diacritics (ä/ö/å) and general Latin Extended, so one font serves every name in the system.

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');

export interface CustomReportPdfMeta {
  generatedAtHelsinki: string;
  workersLabel: string;
  sitesLabel: string;
  dataModeLabel: string;
}

function finalizePdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function t(locale: AppLocale, en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

const ROW_HEIGHT = 22;
const HEADER_ROW_HEIGHT = 24;

function drawTableHeader(doc: PDFKit.PDFDocument, columns: Column[], x: number, y: number): number {
  doc.font('DejaVu-Bold').fontSize(8);
  let cx = x;
  doc.rect(x, y, columns.reduce((a, c) => a + c.width, 0), HEADER_ROW_HEIGHT).fillAndStroke('#eeeeee', '#333333');
  doc.fillColor('#000000');
  for (const col of columns) {
    doc.text(col.header, cx + 4, y + 7, { width: col.width - 8, align: col.align ?? 'left', lineBreak: false });
    cx += col.width;
  }
  doc.font('DejaVu').fontSize(8);
  return y + HEADER_ROW_HEIGHT;
}

function drawRow(doc: PDFKit.PDFDocument, columns: Column[], cells: string[], x: number, y: number, bold = false): number {
  doc.font(bold ? 'DejaVu-Bold' : 'DejaVu').fontSize(8);
  let cx = x;
  const totalWidth = columns.reduce((a, c) => a + c.width, 0);
  doc.rect(x, y, totalWidth, ROW_HEIGHT).stroke('#cccccc');
  for (const col of columns) {
    doc.text(cells[columns.indexOf(col)] ?? '', cx + 4, y + 6, { width: col.width - 8, align: col.align ?? 'left', lineBreak: false });
    cx += col.width;
  }
  return y + ROW_HEIGHT;
}

function drawDocumentHeader(doc: PDFKit.PDFDocument, meta: CustomReportPdfMeta, report: CustomTimeReport, reportKindLabel: string, locale: AppLocale, marginLeft: number): number {
  let y = doc.page.margins.top;
  doc.font('DejaVu-Bold').fontSize(14).text('TITANOR GROUP', marginLeft, y);
  y += 18;
  doc.fontSize(11).text(t(locale, 'WORKING TIME REPORT', 'ОТЧЁТ ПО РАБОЧЕМУ ВРЕМЕНИ'), marginLeft, y);
  y += 14;
  doc.font('DejaVu-Bold').fontSize(10).text(reportKindLabel, marginLeft, y);
  y += 18;

  doc.font('DejaVu').fontSize(8.5);
  const lines: [string, string][] = [
    [t(locale, 'Generated', 'Сформировано'), meta.generatedAtHelsinki],
    [t(locale, 'Date range', 'Период'), `${report.dateFrom} – ${report.dateTo}`],
    [t(locale, 'Workers', 'Работники'), meta.workersLabel],
    [t(locale, 'Sites', 'Объекты'), meta.sitesLabel],
    [t(locale, 'Data', 'Данные'), meta.dataModeLabel]
  ];
  for (const [label, value] of lines) {
    doc.font('DejaVu-Bold').text(`${label}: `, marginLeft, y, { continued: true });
    doc.font('DejaVu').text(value);
    y += 12;
  }
  return y + 8;
}

function addPageNumbers(doc: PDFKit.PDFDocument, locale: AppLocale): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    // Writing inside the bottom margin would otherwise make pdfkit's auto-flow think the text
    // overflows the page and silently start a NEW page — zero out the bottom margin for this one
    // footer write, then restore it (standard pdfkit footer technique).
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('DejaVu').fontSize(7.5).fillColor('#555555');
    doc.text(t(locale, `Page ${i + 1} of ${range.count}`, `Страница ${i + 1} из ${range.count}`), 0, height - originalBottomMargin + 12, { width, align: 'center', lineBreak: false });
    doc.fillColor('#000000');
    doc.page.margins.bottom = originalBottomMargin;
  }
}

function newDoc(layout: 'portrait' | 'landscape'): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', layout, margins: { top: 50, bottom: 40, left: 36, right: 36 }, bufferPages: true, autoFirstPage: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH);
  doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH);
  doc.font('DejaVu');
  return doc;
}

export async function buildCustomReportSummaryPdf(report: CustomTimeReport, meta: CustomReportPdfMeta, locale: AppLocale): Promise<Buffer> {
  const doc = newDoc('portrait');
  const marginLeft = doc.page.margins.left;
  const columns: Column[] = [
    { header: t(locale, 'Employee', 'Работник'), width: 112 },
    { header: t(locale, 'Number', 'Таб. №'), width: 48 },
    { header: t(locale, 'Site', 'Объект'), width: 78 },
    { header: t(locale, 'Gross', 'Всего'), width: 58, align: 'right' },
    { header: t(locale, 'Paid brk', 'Опл.пер.'), width: 55, align: 'right' },
    { header: t(locale, 'Unpaid brk', 'Неопл.пер.'), width: 62, align: 'right' },
    { header: t(locale, 'Worked', 'Отраб.'), width: 62, align: 'right' },
    { header: t(locale, 'Days', 'Дни'), width: 32, align: 'right' }
  ];
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  let y = drawDocumentHeader(doc, meta, report, t(locale, 'Summary', 'Сводка'), locale, marginLeft);
  y = drawTableHeader(doc, columns, marginLeft, y);

  const cellsFor = (row: { employee: { lastName: string; firstName: string; employeeNumber: string }; site: { name: string }; grossMinutes: number; paidBreakMinutes: number; unpaidBreakMinutes: number; workedMinutes: number; workedDays: number }): string[] => [
    `${row.employee.lastName} ${row.employee.firstName}`,
    row.employee.employeeNumber,
    row.site.name,
    formatWorkedDuration(row.grossMinutes, locale),
    formatWorkedDuration(row.paidBreakMinutes, locale),
    formatWorkedDuration(row.unpaidBreakMinutes, locale),
    formatWorkedDuration(row.workedMinutes, locale),
    String(row.workedDays)
  ];

  for (const row of report.summaryRows) {
    if (y + ROW_HEIGHT > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawTableHeader(doc, columns, marginLeft, y);
    }
    y = drawRow(doc, columns, cellsFor(row), marginLeft, y);
  }

  if (report.employeeSubtotals.length > 1) {
    for (const e of report.employeeSubtotals) {
      if (y + ROW_HEIGHT > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(doc, columns, marginLeft, y);
      }
      y = drawRow(
        doc,
        columns,
        [t(locale, `Subtotal — ${e.employee.lastName} ${e.employee.firstName}`, `Итого — ${e.employee.lastName} ${e.employee.firstName}`), '', '', formatWorkedDuration(e.totals.grossMinutes, locale), formatWorkedDuration(e.totals.paidBreakMinutes, locale), formatWorkedDuration(e.totals.unpaidBreakMinutes, locale), formatWorkedDuration(e.totals.workedMinutes, locale), String(e.totals.workedDays)],
        marginLeft,
        y,
        true
      );
    }
  }
  if (report.siteSubtotals.length > 1) {
    for (const s of report.siteSubtotals) {
      if (y + ROW_HEIGHT > bottomLimit) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawTableHeader(doc, columns, marginLeft, y);
      }
      y = drawRow(doc, columns, [t(locale, `Subtotal — ${s.site.name}`, `Итого — ${s.site.name}`), '', s.site.name, formatWorkedDuration(s.totals.grossMinutes, locale), formatWorkedDuration(s.totals.paidBreakMinutes, locale), formatWorkedDuration(s.totals.unpaidBreakMinutes, locale), formatWorkedDuration(s.totals.workedMinutes, locale), String(s.totals.workedDays)], marginLeft, y, true);
    }
  }
  if (y + ROW_HEIGHT > bottomLimit) {
    doc.addPage();
    y = doc.page.margins.top;
    y = drawTableHeader(doc, columns, marginLeft, y);
  }
  drawRow(doc, columns, [t(locale, 'GRAND TOTAL', 'ИТОГО'), '', '', formatWorkedDuration(report.grandTotal.grossMinutes, locale), formatWorkedDuration(report.grandTotal.paidBreakMinutes, locale), formatWorkedDuration(report.grandTotal.unpaidBreakMinutes, locale), formatWorkedDuration(report.grandTotal.workedMinutes, locale), String(report.grandTotal.workedDays)], marginLeft, y, true);

  addPageNumbers(doc, locale);
  return finalizePdf(doc);
}

export async function buildCustomReportDetailedPdf(report: CustomTimeReport, meta: CustomReportPdfMeta, locale: AppLocale): Promise<Buffer> {
  const doc = newDoc('landscape');
  const marginLeft = doc.page.margins.left;
  const columns: Column[] = [
    { header: t(locale, 'Date', 'Дата'), width: 58 },
    { header: t(locale, 'Number', 'Таб. №'), width: 55 },
    { header: t(locale, 'Employee', 'Работник'), width: 108 },
    { header: t(locale, 'Site', 'Объект'), width: 95 },
    { header: t(locale, 'Work area', 'Раб. зона'), width: 85 },
    { header: t(locale, 'Start', 'Начало'), width: 42, align: 'right' },
    { header: t(locale, 'End', 'Конец'), width: 42, align: 'right' },
    { header: t(locale, 'Paid brk', 'Опл.пер.'), width: 58, align: 'right' },
    { header: t(locale, 'Unpaid brk', 'Неопл.пер.'), width: 64, align: 'right' },
    { header: t(locale, 'Worked', 'Отраб.'), width: 60, align: 'right' },
    { header: t(locale, 'Status', 'Статус'), width: 90 }
  ];
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  let y = drawDocumentHeader(doc, meta, report, t(locale, 'Detailed', 'Детально'), locale, marginLeft);
  y = drawTableHeader(doc, columns, marginLeft, y);

  const helsinkiTimeOfDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

  for (const row of report.detailRows) {
    if (y + ROW_HEIGHT > bottomLimit) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawTableHeader(doc, columns, marginLeft, y);
    }
    y = drawRow(
      doc,
      columns,
      [
        row.date,
        row.employee.employeeNumber,
        `${row.employee.lastName} ${row.employee.firstName}`,
        row.site.name,
        row.workAreaName ?? '',
        helsinkiTimeOfDay(row.startAt),
        helsinkiTimeOfDay(row.endAt),
        formatWorkedDuration(row.paidBreakMinutes, locale),
        formatWorkedDuration(row.unpaidBreakMinutes, locale),
        formatWorkedDuration(row.workedMinutes, locale),
        timesheetStatusLabel(row.timesheetStatus, locale)
      ],
      marginLeft,
      y
    );
  }

  if (y + ROW_HEIGHT > bottomLimit) {
    doc.addPage();
    y = doc.page.margins.top;
    y = drawTableHeader(doc, columns, marginLeft, y);
  }
  drawRow(
    doc,
    columns,
    [t(locale, 'GRAND TOTAL', 'ИТОГО'), '', '', '', '', '', '', formatWorkedDuration(report.grandTotal.paidBreakMinutes, locale), formatWorkedDuration(report.grandTotal.unpaidBreakMinutes, locale), formatWorkedDuration(report.grandTotal.workedMinutes, locale), ''],
    marginLeft,
    y,
    true
  );

  addPageNumbers(doc, locale);
  return finalizePdf(doc);
}

export function customReportPdfFileName(report: CustomTimeReport): string {
  return `titanor-time-report_${report.dateFrom}_${report.dateTo}.pdf`;
}
