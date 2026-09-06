import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { WorkerTimeReport } from '@/lib/worker-time-report';
import { csvMetaBlock, timesheetStatusEnglish, workingReportFileName, type WorkingReportMeta } from '@/lib/reporting/working-report';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §3 + §6 — English-only working
// report. getWorkerTimeReport has no pagination (a worker spans few sites), so every site bucket
// is always present and the TOTAL line equals the sum of the rows above it.

const HUMAN_TEXT = new Set([0]); // site name

export function buildWorkerReportCsv(report: WorkerTimeReport, meta: WorkingReportMeta): Buffer {
  const t = report.total;
  const lines: string[] = [...csvMetaBlock(meta)];

  lines.push(buildCsvRow(['Worker', `${report.employee.lastName} ${report.employee.firstName}`], new Set([1])));
  lines.push(buildCsvRow(['Employee number', report.employee.employeeNumber], new Set([1])));
  lines.push(buildCsvRow(['Timesheet status', timesheetStatusEnglish(report.timesheet?.status ?? null)], new Set()));
  lines.push(buildCsvRow(['Included in period', report.participant ? (report.participant.expected ? 'Yes' : 'Excluded') : 'Not a participant'], new Set()));
  lines.push('\r\n');

  lines.push(
    buildCsvRow(['Site', 'Worked days', 'Gross minutes', 'Paid break minutes', 'Unpaid break minutes', 'Worked minutes', 'Segments'], new Set())
  );
  for (const site of report.sites) {
    lines.push(
      buildCsvRow(
        [site.siteName, site.workedDayCount, site.grossMinutes, site.paidBreakMinutes, site.unpaidBreakMinutes, site.workedMinutes, site.segmentCount],
        HUMAN_TEXT
      )
    );
  }
  lines.push(
    buildCsvRow(['TOTAL', t.workedDayCount, t.grossMinutes, t.paidBreakMinutes, t.unpaidBreakMinutes, t.workedMinutes, t.segmentCount], new Set())
  );

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function workerReportCsvFileName(report: WorkerTimeReport): string {
  return workingReportFileName('WORKER_DETAIL', 'CSV', {
    startDate: report.period.startDate,
    endDate: report.period.endDate,
    subject: report.employee.employeeNumber
  });
}
