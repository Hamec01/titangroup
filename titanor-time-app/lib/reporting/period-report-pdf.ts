import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { PeriodTimeReport } from '@/lib/period-time-report';

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');

function duration(minutes: number): string { return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`; }

function finish(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => { const chunks: Buffer[] = []; doc.on('data', (chunk: Buffer) => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); doc.end(); });
}

export async function buildPeriodReportPdf(report: PeriodTimeReport, generatedAt: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 44, bottom: 42, left: 42, right: 42 }, bufferPages: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH); doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH); doc.font('DejaVu').fillColor('#17324d');
  doc.font('DejaVu-Bold').fontSize(18).text('TITANOR TIME');
  doc.font('DejaVu-Bold').fontSize(14).moveDown(0.35).text('Отчёт за расчётный период');
  doc.font('DejaVu').fontSize(9).fillColor('#61778b').moveDown(0.4).text(`${report.period.startDate} – ${report.period.endDate} · ${report.period.status}`);
  doc.text(`Сформировано: ${generatedAt}`);
  doc.moveDown(1.3).fillColor('#17324d').font('DejaVu-Bold').fontSize(11).text('Сводка');
  doc.font('DejaVu').fontSize(10).moveDown(0.35).text(`Работники: ${report.summary.workerCount}   Объекты: ${report.summary.siteCount}   Отработано дней: ${report.summary.workedDayCount}`);
  doc.text(`Всего: ${duration(report.summary.grossMinutes)}   Перерывы: ${duration(report.summary.paidBreakMinutes + report.summary.unpaidBreakMinutes)}   Отработано: ${duration(report.summary.workedMinutes)}`);
  doc.moveDown(1.2).font('DejaVu-Bold').fontSize(11).text('Объекты');
  let y = doc.y + 8;
  const x = doc.page.margins.left;
  const widths = [180, 66, 66, 70, 90];
  const headers = ['Объект', 'Работники', 'Дни', 'Сегменты', 'Отработано'];
  const drawHead = () => { doc.rect(x, y, widths.reduce((a, b) => a + b, 0), 23).fill('#eaf3f9'); doc.fillColor('#17324d').font('DejaVu-Bold').fontSize(8); let cx = x; headers.forEach((h, i) => { doc.text(h, cx + 5, y + 7, { width: widths[i] - 10, lineBreak: false }); cx += widths[i]; }); y += 23; };
  const drawRow = (cells: string[], fill?: string) => { if (y > doc.page.height - 76) { doc.addPage(); y = doc.page.margins.top; drawHead(); } if (fill) doc.rect(x, y, widths.reduce((a, b) => a + b, 0), 24).fill(fill); doc.fillColor('#334f67').font('DejaVu').fontSize(8); let cx = x; cells.forEach((cell, i) => { doc.text(cell, cx + 5, y + 7, { width: widths[i] - 10, lineBreak: false }); cx += widths[i]; }); doc.strokeColor('#dce5eb').rect(x, y, widths.reduce((a, b) => a + b, 0), 24).stroke(); y += 24; };
  drawHead();
  report.sites.forEach((site, index) => drawRow([site.site.name, `${site.workedWorkerCount}/${site.assignedWorkerCount}`, String(site.workedDayCount), String(site.segmentCount), duration(site.workedMinutes)], index % 2 ? '#f8fbfd' : undefined));
  drawRow(['ИТОГО', `${report.summary.workedWorkerCount}/${report.summary.assignedWorkerCount}`, String(report.summary.workedDayCount), String(report.summary.segmentCount), duration(report.summary.workedMinutes)], '#eaf3f9');
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) { doc.switchToPage(i); doc.font('DejaVu').fontSize(7).fillColor('#8193a2').text(`Страница ${i + 1} из ${range.count}`, 0, doc.page.height - 28, { width: doc.page.width, align: 'center' }); }
  return finish(doc);
}

export function periodReportPdfFileName(report: PeriodTimeReport): string { return `titanor-report_${report.period.startDate}_${report.period.endDate}.pdf`; }
