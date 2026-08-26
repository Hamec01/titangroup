import path from 'node:path';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { qualificationStatusLabel } from '@/lib/qualification-expiry';
import type { AppLocale } from '@/lib/i18n/locale';
import type { WorkerDossierData, WorkerDossierQualification } from '@/lib/worker-dossier';

// Worker Dossier PDF (task spec §27-39) — built on the same pdfkit + embedded DejaVu Sans
// infrastructure as lib/reporting/custom-report-pdf.ts (no Puppeteer/Chromium, per task spec
// §30). A separate builder rather than extending custom-report-pdf.ts: that file's helpers are
// table-report-shaped (fixed columns, one repeating row type) and none of it deals with
// portrait free-form sections or embedded images, so there's little to actually share beyond the
// finalize/font-registration boilerplate duplicated below.

const FONT_REGULAR_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'assets/fonts/DejaVuSans-Bold.ttf');
const LOGO_PATH = path.join(process.cwd(), 'assets/brand/titanor-group.png');

const MARGIN = 42;
const MAX_IMAGE_WIDTH = 200;
const MAX_IMAGE_HEIGHT = 200;

function t(locale: AppLocale, en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}

function dash(value: string | null | undefined): string {
  return value && value.length > 0 ? value : '—';
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

function newDoc(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN }, bufferPages: true, autoFirstPage: true });
  doc.registerFont('DejaVu', FONT_REGULAR_PATH);
  doc.registerFont('DejaVu-Bold', FONT_BOLD_PATH);
  doc.font('DejaVu');
  return doc;
}

function bottomLimit(doc: PDFKit.PDFDocument): number {
  return doc.page.height - doc.page.margins.bottom;
}

/** Adds a page and returns the new top-of-content y if `needed` vertical space doesn't fit before the bottom margin — otherwise returns `y` unchanged. */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  if (y + needed > bottomLimit(doc)) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number): number {
  y = ensureSpace(doc, y, 22);
  doc.font('DejaVu-Bold').fontSize(12).fillColor('#16324f').text(title, x, y);
  doc.fillColor('#000000');
  return y + 20;
}

function drawFieldRow(doc: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, width: number): number {
  y = ensureSpace(doc, y, 14);
  doc.font('DejaVu-Bold').fontSize(9).text(`${label}: `, x, y, { continued: true, width });
  doc.font('DejaVu').fontSize(9).text(value);
  return y + 14;
}

function statusColorHex(color: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED'): string {
  switch (color) {
    case 'GREEN':
      return '#1f7a3d';
    case 'YELLOW':
      return '#8a6d00';
    case 'ORANGE':
      return '#a34d00';
    case 'RED':
      return '#a3251f';
  }
}

function drawQualificationBlock(doc: PDFKit.PDFDocument, q: WorkerDossierQualification, locale: AppLocale, x: number, y: number, contentWidth: number): number {
  const displayName = locale === 'RU' && q.nameRu ? q.nameRu : q.name;
  y = ensureSpace(doc, y, 90);
  doc.font('DejaVu-Bold').fontSize(10).fillColor('#000000').text(displayName, x, y, { width: contentWidth });
  y = doc.y + 3;

  y = drawFieldRow(doc, t(locale, 'Certificate number', 'Номер сертификата'), dash(q.certificateNumber), x, y, contentWidth);
  y = drawFieldRow(doc, t(locale, 'Issuer', 'Кем выдано'), dash(q.issuer), x, y, contentWidth);
  y = drawFieldRow(doc, t(locale, 'Issued on', 'Дата выдачи'), dash(q.issuedOn), x, y, contentWidth);
  y = drawFieldRow(doc, t(locale, 'Valid until', 'Действует до'), dash(q.expiresOn), x, y, contentWidth);

  y = ensureSpace(doc, y, 14);
  const statusLabel = q.isExpiringToday ? t(locale, 'Expires today', 'Истекает сегодня') : qualificationStatusLabel(q.status, locale === 'RU' ? 'RU' : 'EN');
  doc.font('DejaVu-Bold').fontSize(9).text(`${t(locale, 'Status', 'Статус')}: `, x, y, { continued: true });
  doc.font('DejaVu-Bold').fillColor(statusColorHex(q.color)).text(statusLabel);
  doc.fillColor('#000000');
  y += 14;

  const verificationLabel = q.verificationState === 'VERIFIED' ? t(locale, 'Verified', 'Подтверждено') : t(locale, 'Self-reported', 'Указано самостоятельно');
  y = drawFieldRow(doc, t(locale, 'Verification', 'Подтверждение'), verificationLabel, x, y, contentWidth);

  if (q.photo) {
    y = ensureSpace(doc, y, MAX_IMAGE_HEIGHT + 6);
    doc.image(q.photo, x, y, { fit: [MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT] });
    y += MAX_IMAGE_HEIGHT + 10;
  } else {
    y = ensureSpace(doc, y, 14);
    doc.font('DejaVu').fontSize(8.5).fillColor('#555555').text(t(locale, 'Document image not attached', 'Изображение документа не прикреплено'), x, y);
    doc.fillColor('#000000');
    y += 16;
  }

  return y + 8;
}

function drawStampPage(doc: PDFKit.PDFDocument, locale: AppLocale, generatedAtHelsinki: string): void {
  doc.addPage();
  const centerX = doc.page.width / 2;
  const stampY = doc.page.height / 2 - 90;
  const boxWidth = 260;
  const boxHeight = 180;
  const boxX = centerX - boxWidth / 2;

  doc.roundedRect(boxX, stampY, boxWidth, boxHeight, 6).lineWidth(1.4).strokeColor('#16324f').stroke();
  doc.strokeColor('#000000').lineWidth(1);

  if (existsSync(LOGO_PATH)) {
    const logoWidth = 130;
    doc.image(LOGO_PATH, centerX - logoWidth / 2, stampY + 22, { width: logoWidth });
  }

  doc.font('DejaVu-Bold').fontSize(11).fillColor('#16324f').text('TITANOR GROUP', boxX, stampY + 90, { width: boxWidth, align: 'center' });
  doc.font('DejaVu').fontSize(8.5).fillColor('#444444').text(generatedAtHelsinki, boxX, stampY + 112, { width: boxWidth, align: 'center' });
  doc.fillColor('#000000');

  doc.fontSize(7.5).fillColor('#777777').text(t(locale, 'This stamp confirms the document was generated by Titanor Time. It is not an electronic signature.', 'Штамп подтверждает, что документ сформирован в Titanor Time. Это не является электронной подписью.'), MARGIN, doc.page.height - MARGIN - 26, {
    width: doc.page.width - MARGIN * 2,
    align: 'center'
  });
  doc.fillColor('#000000');
}

function addPageFooters(doc: PDFKit.PDFDocument, locale: AppLocale): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('DejaVu').fontSize(7.5).fillColor('#555555');
    doc.text(t(locale, `Page ${i + 1} of ${range.count}`, `Страница ${i + 1} из ${range.count}`), 0, height - originalBottomMargin + 12, { width, align: 'center', lineBreak: false });
    doc.fillColor('#000000');
    doc.page.margins.bottom = originalBottomMargin;
  }
}

export async function buildWorkerDossierPdf(data: WorkerDossierData, locale: AppLocale, generatedAtHelsinki: string): Promise<Buffer> {
  const doc = newDoc();
  const x = MARGIN;
  const contentWidth = doc.page.width - MARGIN * 2;
  let y = doc.page.margins.top;

  // --- Header ---
  const logoAvailable = existsSync(LOGO_PATH);
  if (logoAvailable) {
    doc.image(LOGO_PATH, x, y, { width: 120 });
  }
  const titleX = logoAvailable ? x + 140 : x;
  doc.font('DejaVu-Bold').fontSize(15).text('TITANOR GROUP', titleX, y);
  doc.font('DejaVu-Bold').fontSize(12).text(t(locale, 'WORKER DOSSIER', 'ДОСЬЕ РАБОТНИКА'), titleX, y + 20);
  doc.font('DejaVu').fontSize(8.5).fillColor('#555555');
  doc.text(`${t(locale, 'Employee number', 'Табельный номер')}: ${data.employeeNumber}`, titleX, y + 40);
  doc.text(`${t(locale, 'Generated', 'Сформировано')}: ${generatedAtHelsinki}`, titleX, y + 53);
  doc.fillColor('#000000');
  y = Math.max(y + 78, logoAvailable ? y + 92 : y);
  doc.moveTo(x, y).lineTo(x + contentWidth, y).strokeColor('#cccccc').lineWidth(1).stroke();
  y += 14;

  // --- Personal information ---
  y = drawSectionTitle(doc, t(locale, 'PERSONAL INFORMATION', 'ЛИЧНЫЕ ДАННЫЕ'), x, y);
  const personalPhotoWidth = data.photo ? 100 : 0;
  const personalFieldsX = data.photo ? x + personalPhotoWidth + 16 : x;
  const personalFieldsWidth = contentWidth - (data.photo ? personalPhotoWidth + 16 : 0);
  const personalBlockTop = y;
  if (data.photo) {
    doc.image(data.photo, x, y, { fit: [personalPhotoWidth, personalPhotoWidth] });
  }
  let fy = personalBlockTop;
  fy = drawFieldRow(doc, t(locale, 'First name', 'Имя'), dash(data.firstName), personalFieldsX, fy, personalFieldsWidth);
  fy = drawFieldRow(doc, t(locale, 'Last name', 'Фамилия'), dash(data.lastName), personalFieldsX, fy, personalFieldsWidth);
  fy = drawFieldRow(doc, t(locale, 'Employee number', 'Табельный номер'), dash(data.employeeNumber), personalFieldsX, fy, personalFieldsWidth);
  fy = drawFieldRow(doc, t(locale, 'Date of birth', 'Дата рождения'), dash(data.dateOfBirth), personalFieldsX, fy, personalFieldsWidth);
  fy = drawFieldRow(doc, t(locale, 'Personal identity code', 'Личный идентификационный код'), dash(data.personalIdentityCode), personalFieldsX, fy, personalFieldsWidth);
  fy = drawFieldRow(doc, t(locale, 'Phone', 'Телефон'), dash(data.phone), personalFieldsX, fy, personalFieldsWidth);
  fy = drawFieldRow(doc, t(locale, 'Email', 'Email'), dash(data.contactEmail), personalFieldsX, fy, personalFieldsWidth);
  y = Math.max(fy, data.photo ? personalBlockTop + personalPhotoWidth + 6 : fy) + 8;

  // --- Address ---
  y = drawSectionTitle(doc, t(locale, 'ADDRESS', 'АДРЕС'), x, y);
  y = drawFieldRow(doc, t(locale, 'Street address', 'Улица, дом'), dash(data.addressStreet), x, y, contentWidth);
  const postalCity = [data.addressPostalCode, data.addressCity].filter(Boolean).join(' ');
  y = drawFieldRow(doc, t(locale, 'Postal code / City', 'Индекс / Город'), dash(postalCity || null), x, y, contentWidth);
  y = drawFieldRow(doc, t(locale, 'Country', 'Страна'), dash(data.addressCountry), x, y, contentWidth);
  y += 6;

  // --- Work information ---
  y = drawSectionTitle(doc, t(locale, 'WORK INFORMATION', 'РАБОЧАЯ ИНФОРМАЦИЯ'), x, y);
  y = drawFieldRow(doc, t(locale, 'Profession / Specialty', 'Профессия / Специальность'), dash(data.specialty), x, y, contentWidth);
  y = drawFieldRow(doc, t(locale, 'Employment contract', 'Трудовой договор'), data.contractAttached ? t(locale, 'Attached', 'Прикреплён') : t(locale, 'Not attached', 'Не прикреплён'), x, y, contentWidth);
  y = ensureSpace(doc, y, 14);
  doc.font('DejaVu-Bold').fontSize(9).text(`${t(locale, 'Skills', 'Навыки')}: `, x, y);
  y = doc.y + 2;
  doc.font('DejaVu').fontSize(9).text(dash(data.skills), x, y, { width: contentWidth });
  y = doc.y + 10;

  // --- Cards / Certificates ---
  const cards = data.qualifications.filter((q) => q.category === 'SAFETY_CARD');
  const certificates = data.qualifications.filter((q) => q.category !== 'SAFETY_CARD');

  y = drawSectionTitle(doc, t(locale, 'CARDS / SAFETY CARDS', 'КАРТЫ / КАРТЫ БЕЗОПАСНОСТИ'), x, y);
  if (cards.length === 0) {
    y = ensureSpace(doc, y, 14);
    doc.font('DejaVu').fontSize(9).fillColor('#555555').text(t(locale, 'No cards on file.', 'Карты не прикреплены.'), x, y);
    doc.fillColor('#000000');
    y += 18;
  } else {
    for (const q of cards) {
      y = drawQualificationBlock(doc, q, locale, x, y, contentWidth);
    }
  }

  y = drawSectionTitle(doc, t(locale, 'CERTIFICATES / QUALIFICATIONS', 'СЕРТИФИКАТЫ / КВАЛИФИКАЦИИ'), x, y);
  if (certificates.length === 0) {
    y = ensureSpace(doc, y, 14);
    doc.font('DejaVu').fontSize(9).fillColor('#555555').text(t(locale, 'No certificates on file.', 'Сертификаты не прикреплены.'), x, y);
    doc.fillColor('#000000');
  } else {
    for (const q of certificates) {
      y = drawQualificationBlock(doc, q, locale, x, y, contentWidth);
    }
  }

  drawStampPage(doc, locale, generatedAtHelsinki);
  addPageFooters(doc, locale);
  return finalizePdf(doc);
}

export function workerDossierPdfFileName(employeeNumber: string, dateHelsinki: string): string {
  const safeNumber = employeeNumber.replace(/[^A-Za-z0-9_-]/g, '_');
  return `titanor-worker-dossier_${safeNumber}_${dateHelsinki}.pdf`;
}
