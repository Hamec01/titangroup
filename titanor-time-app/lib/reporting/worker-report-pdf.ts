import type { WorkerTimeReport } from '@/lib/worker-time-report';
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
// report PDF. getWorkerTimeReport has no pagination.

const COLUMNS: WorkingReportColumn[] = [
  { header: 'Site', width: 170 },
  { header: 'Worked days', width: 60, align: 'right' },
  { header: 'Gross', width: 70, align: 'right' },
  { header: 'Paid break', width: 70, align: 'right' },
  { header: 'Unpaid break', width: 70, align: 'right' },
  { header: 'Worked', width: 70, align: 'right' },
  { header: 'Segments', width: 45, align: 'right' }
];

export async function buildWorkerReportPdf(report: WorkerTimeReport, meta: WorkingReportMeta): Promise<Buffer> {
  const doc = newWorkingReportPdf('portrait');
  const left = doc.page.margins.left;
  const t = report.total;

  let y = drawWorkingReportHeader(doc, `Worker detail — ${report.employee.lastName} ${report.employee.firstName}`, meta);
  doc.font('DejaVu').fontSize(8).fillColor('#333333');
  doc.text(`Employee number: ${report.employee.employeeNumber}`, left, y);
  y = doc.y + 3;
  doc.text(`Timesheet status: ${timesheetStatusEnglish(report.timesheet?.status ?? null)}`, left, y);
  y = doc.y + 3;
  doc.text(
    `Included in period: ${report.participant ? (report.participant.expected ? 'Yes' : 'Excluded') : 'Not a participant'}`,
    left,
    y
  );
  y = doc.y + 10;
  doc.fillColor('#111111');

  const rows = report.sites.map((site) => [
    site.siteName,
    String(site.workedDayCount),
    formatMinutesEnglish(site.grossMinutes),
    formatMinutesEnglish(site.paidBreakMinutes),
    formatMinutesEnglish(site.unpaidBreakMinutes),
    formatMinutesEnglish(site.workedMinutes),
    String(site.segmentCount)
  ]);
  const totalRow = [
    'TOTAL',
    String(t.workedDayCount),
    formatMinutesEnglish(t.grossMinutes),
    formatMinutesEnglish(t.paidBreakMinutes),
    formatMinutesEnglish(t.unpaidBreakMinutes),
    formatMinutesEnglish(t.workedMinutes),
    String(t.segmentCount)
  ];

  drawWorkingReportTable(doc, y, COLUMNS, rows, { totalRow, emptyText: 'No worked segments for this worker in this period.' });

  drawWorkingReportPageNumbers(doc);
  return finalizeWorkingReportPdf(doc);
}

export function workerReportPdfFileName(report: WorkerTimeReport): string {
  return workingReportFileName('WORKER_DETAIL', 'PDF', {
    startDate: report.period.startDate,
    endDate: report.period.endDate,
    subject: report.employee.employeeNumber
  });
}
