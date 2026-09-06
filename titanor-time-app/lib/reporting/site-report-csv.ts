import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { SiteTimeReport } from '@/lib/site-time-report';
import { csvMetaBlock, timesheetStatusEnglish, workingReportFileName, type WorkingReportMeta } from '@/lib/reporting/working-report';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §3 + §6 — English-only working
// report. Receives the FULL worker list (export route uses `{ all: true }`); the TOTAL line's
// additive columns equal the sum of the worker rows above it (§3.9).

const HUMAN_TEXT = new Set([0, 1]); // worker name, employee number

export function buildSiteReportCsv(report: SiteTimeReport, meta: WorkingReportMeta): Buffer {
  const s = report.summary;
  const lines: string[] = [...csvMetaBlock(meta)];

  lines.push(buildCsvRow(['Site', report.site.name], HUMAN_TEXT));
  lines.push(buildCsvRow(['Workers (unique)', s.workerCount], new Set()));
  lines.push(buildCsvRow(['Without timesheet', s.withoutTimesheetCount], new Set()));
  lines.push(buildCsvRow(['Worked days (distinct dates)', s.workedDayCount], new Set()));
  for (const [status, count] of Object.entries(s.timesheetStatusCounts)) {
    lines.push(buildCsvRow([`Timesheet status: ${timesheetStatusEnglish(status)}`, count], new Set()));
  }
  lines.push('\r\n');

  lines.push(
    buildCsvRow(
      ['Worker', 'Employee number', 'Timesheet status', 'Worked days', 'Gross minutes', 'Paid break minutes', 'Unpaid break minutes', 'Worked minutes', 'Segments'],
      new Set()
    )
  );
  for (const item of report.items) {
    lines.push(
      buildCsvRow(
        [
          `${item.employee.lastName} ${item.employee.firstName}`,
          item.employee.employeeNumber,
          timesheetStatusEnglish(item.timesheet?.status ?? null),
          item.total.workedDayCount,
          item.total.grossMinutes,
          item.total.paidBreakMinutes,
          item.total.unpaidBreakMinutes,
          item.total.workedMinutes,
          item.total.segmentCount
        ],
        HUMAN_TEXT
      )
    );
  }
  lines.push(
    buildCsvRow(
      ['TOTAL', '', '', s.workedDayCount, s.grossMinutes, s.paidBreakMinutes, s.unpaidBreakMinutes, s.workedMinutes, s.segmentCount],
      new Set()
    )
  );
  lines.push('\r\n');
  lines.push(
    buildCsvRow(
      ['Note: the TOTAL worked-days value is the count of distinct dates worked at this site; a date worked by several workers is counted once there but appears in each worker row above. Gross / paid-break / unpaid-break / worked minutes and segment counts are column sums.'],
      new Set([0])
    )
  );

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function siteReportCsvFileName(report: SiteTimeReport): string {
  return workingReportFileName('SITE_DETAIL', 'CSV', { startDate: report.period.startDate, endDate: report.period.endDate, subject: report.site.name });
}
