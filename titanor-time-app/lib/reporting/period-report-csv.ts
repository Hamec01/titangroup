import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { PeriodTimeReport } from '@/lib/period-time-report';

export function buildPeriodReportCsv(report: PeriodTimeReport): Buffer {
  const rows = [buildCsvRow(['Site', 'Assigned workers', 'Worked workers', 'Missing timesheet', 'Worked days', 'Gross minutes', 'Paid break minutes', 'Unpaid break minutes', 'Worked minutes', 'Segments'], new Set())];
  for (const site of report.sites) {
    rows.push(buildCsvRow([site.site.name, site.assignedWorkerCount, site.workedWorkerCount, site.withoutTimesheetCount, site.workedDayCount, site.grossMinutes, site.paidBreakMinutes, site.unpaidBreakMinutes, site.workedMinutes, site.segmentCount], new Set([0])));
  }
  rows.push(buildCsvRow(['TOTAL', report.summary.assignedWorkerCount, report.summary.workedWorkerCount, report.summary.withoutTimesheetCount, report.summary.workedDayCount, report.summary.grossMinutes, report.summary.paidBreakMinutes, report.summary.unpaidBreakMinutes, report.summary.workedMinutes, report.summary.segmentCount], new Set([0])));
  return Buffer.concat([CSV_BOM, Buffer.from(rows.join(''), 'utf8')]);
}

export function periodReportCsvFileName(report: PeriodTimeReport): string {
  return `titanor-report_${report.period.startDate}_${report.period.endDate}.csv`;
}
