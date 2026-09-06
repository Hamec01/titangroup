import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { PeriodTimeReport } from '@/lib/period-time-report';
import { csvMetaBlock, timesheetStatusEnglish, workingReportFileName, type WorkingReportMeta } from '@/lib/reporting/working-report';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §3 + §6 — English-only working
// report. Receives the FULL (unpaginated) site set — the export route calls getPeriodTimeReport
// with `{ all: true }`, so every site row is present and the TOTAL line's additive columns equal
// the sum of the rows above it (§3.9), never a summary taken over a truncated list.

// Human-text columns for CSV formula-injection sanitisation (only the free-text site name at index 0).
const HUMAN_TEXT = new Set([0]);

export function buildPeriodReportCsv(report: PeriodTimeReport, meta: WorkingReportMeta): Buffer {
  const s = report.summary;
  const lines: string[] = [...csvMetaBlock(meta)];

  // Company summary — deduplicated people/day figures live here, never in a column sum (§3.10).
  lines.push(buildCsvRow(['Company summary', ''], new Set()));
  lines.push(buildCsvRow(['Workers (unique)', s.workerCount], new Set()));
  lines.push(buildCsvRow(['Sites', s.siteCount], new Set()));
  lines.push(buildCsvRow(['Workers with hours (unique)', s.workedWorkerCount], new Set()));
  lines.push(buildCsvRow(['Assigned workers (unique)', s.assignedWorkerCount], new Set()));
  lines.push(buildCsvRow(['Without timesheet (unique)', s.withoutTimesheetCount], new Set()));
  lines.push(buildCsvRow(['Worked days (distinct dates)', s.workedDayCount], new Set()));
  for (const [status, count] of Object.entries(s.timesheetStatusCounts)) {
    lines.push(buildCsvRow([`Timesheet status: ${timesheetStatusEnglish(status)}`, count], new Set()));
  }
  lines.push('\r\n');

  // Per-site detail.
  lines.push(
    buildCsvRow(
      ['Site', 'Assigned workers', 'Workers with hours', 'Without timesheet', 'Worked days', 'Gross minutes', 'Paid break minutes', 'Unpaid break minutes', 'Worked minutes', 'Segments'],
      new Set()
    )
  );
  for (const site of report.sites) {
    lines.push(
      buildCsvRow(
        [site.site.name, site.assignedWorkerCount, site.workedWorkerCount, site.withoutTimesheetCount, site.workedDayCount, site.grossMinutes, site.paidBreakMinutes, site.unpaidBreakMinutes, site.workedMinutes, site.segmentCount],
        HUMAN_TEXT
      )
    );
  }
  // TOTAL — additive columns only are true column sums; worker/day counts are the deduplicated
  // company figures (documented in the note row below).
  lines.push(
    buildCsvRow(
      ['TOTAL', s.assignedWorkerCount, s.workedWorkerCount, s.withoutTimesheetCount, s.workedDayCount, s.grossMinutes, s.paidBreakMinutes, s.unpaidBreakMinutes, s.workedMinutes, s.segmentCount],
      new Set()
    )
  );
  lines.push('\r\n');
  lines.push(
    buildCsvRow(
      ['Note: worker counts and worked-day counts on the TOTAL line are deduplicated company figures. A worker or a date active on several sites is counted once there but appears in every matching site row above. Only gross / paid-break / unpaid-break / worked minutes and segment counts are column sums.'],
      new Set([0])
    )
  );

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function periodReportCsvFileName(report: PeriodTimeReport): string {
  return workingReportFileName('PERIOD_SUMMARY', 'CSV', { startDate: report.period.startDate, endDate: report.period.endDate });
}
