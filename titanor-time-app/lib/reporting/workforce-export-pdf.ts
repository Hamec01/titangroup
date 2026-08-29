import path from 'node:path';
import PDFDocument from 'pdfkit';
import { qualificationStatusLabel } from '@/lib/qualification-expiry';
import type { QualificationMatrixRow } from '@/lib/qualification-matrix';
import type { AppLocale } from '@/lib/i18n/locale';

// T13.6 — workforce matrix PDF via pdfkit + embedded DejaVu Sans (Cyrillic + ä/ö/å), same infra as
// lib/reporting/custom-report-pdf.ts. Landscape table. No UUIDs, no date of birth / address /
// phone / contract / certificate images.

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');

function t(locale: AppLocale, en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}

function finalizePdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

interface Column {
  header: string;
  width: number;
}
const ROW_MIN_HEIGHT = 20;
const HEADER_ROW_HEIGHT = 22;

function chipText(chip: QualificationMatrixRow['safetyCard'], locale: AppLocale): string {
  if (!chip) return locale === 'RU' ? 'нет' : 'missing';
  const name = locale === 'RU' && chip.nameRu ? chip.nameRu : chip.name;
  const bits = [name, qualificationStatusLabel(chip.status, locale === 'RU' ? 'RU' : 'EN')];
  if (chip.expiresOn) bits.push(`→ ${chip.expiresOn}`);
  return bits.join(' · ');
}

export async function buildWorkforcePdf(rows: QualificationMatrixRow[], meta: { generatedAtHelsinki: string; filterSummary: string }, locale: AppLocale): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 46, bottom: 40, left: 34, right: 34 }, bufferPages: true, autoFirstPage: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH);
  doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH);
  doc.font('DejaVu');

  const marginLeft = doc.page.margins.left;
  const columns: Column[] = [
    { header: t(locale, 'Number', 'Таб. №'), width: 62 },
    { header: t(locale, 'Name', 'ФИО'), width: 120 },
    { header: t(locale, 'Professions', 'Профессии'), width: 150 },
    { header: t(locale, 'Current site(s)', 'Объект(ы)'), width: 120 },
    { header: t(locale, 'Empl.', 'Занят.'), width: 46 },
    { header: t(locale, 'Safety card', 'Карта ТБ'), width: 110 },
    { header: t(locale, 'Hot work', 'Огневые'), width: 110 },
    { header: t(locale, 'Other qualifications', 'Прочие допуски'), width: 140 }
  ];
  const totalWidth = columns.reduce((a, c) => a + c.width, 0);
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  const drawHeader = (y: number): number => {
    doc.font('DejaVu-Bold').fontSize(14).text('TITANOR GROUP', marginLeft, doc.page.margins.top);
    doc.fontSize(10).text(t(locale, 'WORKFORCE MATRIX', 'МАТРИЦА РАБОТНИКОВ'), marginLeft, doc.page.margins.top + 17);
    doc.font('DejaVu').fontSize(8);
    doc.text(`${t(locale, 'Generated', 'Сформировано')}: ${meta.generatedAtHelsinki}`, marginLeft, doc.page.margins.top + 31);
    doc.text(`${t(locale, 'Filter', 'Фильтр')}: ${meta.filterSummary}`, marginLeft, doc.page.margins.top + 42);
    return doc.page.margins.top + 58;
  };
  const drawTableHead = (y: number): number => {
    doc.font('DejaVu-Bold').fontSize(7.5);
    doc.rect(marginLeft, y, totalWidth, HEADER_ROW_HEIGHT).fillAndStroke('#eeeeee', '#333333');
    doc.fillColor('#000000');
    let cx = marginLeft;
    for (const col of columns) {
      doc.text(col.header, cx + 3, y + 6, { width: col.width - 6, lineBreak: false });
      cx += col.width;
    }
    doc.font('DejaVu').fontSize(7.5);
    return y + HEADER_ROW_HEIGHT;
  };

  let y = drawHeader(0);
  y = drawTableHead(y);

  for (const r of rows) {
    const cells = [
      r.employeeNumber,
      `${r.lastName} ${r.firstName}`,
      r.professions.map((p) => (locale === 'RU' ? p.nameRu ?? p.nameEn : p.nameEn)).join(', ') || '—',
      r.currentSites.map((s) => s.name).join(', ') || '—',
      r.active ? t(locale, 'yes', 'да') : t(locale, 'no', 'нет'),
      chipText(r.safetyCard, locale),
      chipText(r.hotWorkCard, locale),
      r.otherChips.map((c) => chipText(c, locale)).join('; ') || '—'
    ];
    const heights = columns.map((col, i) => doc.heightOfString(cells[i], { width: col.width - 6 }));
    const rowHeight = Math.max(ROW_MIN_HEIGHT, ...heights) + 6;

    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawTableHead(doc.page.margins.top);
    }
    doc.rect(marginLeft, y, totalWidth, rowHeight).stroke('#cccccc');
    let cx = marginLeft;
    for (let i = 0; i < columns.length; i++) {
      doc.text(cells[i], cx + 3, y + 4, { width: columns[i].width - 6 });
      cx += columns[i].width;
    }
    y += rowHeight;
  }

  // page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const ob = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('DejaVu').fontSize(7).fillColor('#555555');
    doc.text(t(locale, `Page ${i + 1} of ${range.count}`, `Страница ${i + 1} из ${range.count}`), 0, height - ob + 12, { width, align: 'center', lineBreak: false });
    doc.fillColor('#000000');
    doc.page.margins.bottom = ob;
  }

  return finalizePdf(doc);
}

export function workforcePdfFileName(): string {
  return `titanor-workforce_${new Date().toISOString().slice(0, 10)}.pdf`;
}
