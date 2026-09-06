import type { SiteTimeReport } from '@/lib/site-time-report';
import {
  drawWorkingReportHeader,
  drawWorkingReportPageNumbers,
  drawWorkingReportTable,
  finalizeWorkingReportPdf,
  formatMinutesEnglish,
  newWorkingReportPdf,
  timesheetStatusEnglish,
  workingReportFileName,
  type WorkingReportColumn,
  type WorkingReportMeta
} from '@/lib/reporting/working-report';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §3 + §6 — English-only working
// report PDF, full (unpaginated) worker list.

const COLUMNS: WorkingReportColumn[] = [
  { header: 'Worker', width: 130 },
  { header: 'Emp. no.', width: 60 },
  { header: 'Timesheet', width: 74 },
  { header: 'Worked days', width: 50, align: 'right' },
  { header: 'Gross', width: 62, align: 'right' },
  { header: 'Breaks', width: 62, align: 'right' },
  { header: 'Worked', width: 62, align: 'right' },
  { header: 'Segments', width: 44, align: 'right' }
];

export async function buildSiteReportPdf(report: SiteTimeReport, meta: WorkingReportMeta): Promise<Buffer> {
  const doc = newWorkingReportPdf('portrait');
  const left = doc.page.margins.left;
  const s = report.summary;

  let y = drawWorkingReportHeader(doc, `Site detail — ${report.site.name}`, meta);
  doc.font('DejaVu').fontSize(8).fillColor('#333333').text(
    `Workers (unique): ${s.workerCount}   Without timesheet: ${s.withoutTimesheetCount}   Worked days: ${s.workedDayCount}`,
    left,
    y
  );
  y = doc.y + 3;
  const st = s.timesheetStatusCounts;
  doc.text(
    `Timesheet status — ${(['DRAFT', 'SUBMITTED', 'RETURNED', 'FOREMAN_APPROVED', 'FINAL_APPROVED'] as const).map((k) => `${timesheetStatusEnglish(k)}: ${st[k]}`).join('   ')}`,
    left,
    y
  );
  y = doc.y + 10;
  doc.fillColor('#111111');

  const rows = report.items.map((item) => [
    `${item.employee.lastName} ${item.employee.firstName}`,
    item.employee.employeeNumber,
    timesheetStatusEnglish(item.timesheet?.status ?? null),
    String(item.total.workedDayCount),
    formatMinutesEnglish(item.total.grossMinutes),
    formatMinutesEnglish(item.total.paidBreakMinutes + item.total.unpaidBreakMinutes),
    formatMinutesEnglish(item.total.workedMinutes),
    String(item.total.segmentCount)
  ]);
  const totalRow = [
    'TOTAL',
    '',
    '',
    String(s.workedDayCount),
    formatMinutesEnglish(s.grossMinutes),
    formatMinutesEnglish(s.paidBreakMinutes + s.unpaidBreakMinutes),
    formatMinutesEnglish(s.workedMinutes),
    String(s.segmentCount)
  ];

  y = drawWorkingReportTable(doc, y, COLUMNS, rows, { totalRow, emptyText: 'No workers with hours or assignments on this site in this period.' });

  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  y += 8;
  if (y + 30 > bottomLimit) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.font('DejaVu').fontSize(6.5).fillColor('#666666').text(
    'Note: the TOTAL worked-days value is the count of distinct dates worked at this site; a date worked by several workers is counted once there. Gross / break / worked minutes and segment counts are column sums.',
    left,
    y,
    { width: COLUMNS.reduce((a, c) => a + c.width, 0) }
  );

  drawWorkingReportPageNumbers(doc);
  return finalizeWorkingReportPdf(doc);
}

export function siteReportPdfFileName(report: SiteTimeReport): string {
  return workingReportFileName('SITE_DETAIL', 'PDF', { startDate: report.period.startDate, endDate: report.period.endDate, subject: report.site.name });
}
