import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { CustomTimeReport } from '@/lib/reporting/custom-time-report';

// T13.11 — Customer Project Working Hours CSV. UTF-8 BOM, CRLF, formula-injection guard
// (buildCsvRow). Numeric minutes + decimal hours with a dot. A row_type column
// (DETAIL / EMPLOYEE_SUBTOTAL / SITE_SUBTOTAL / GRAND_TOTAL). No UUIDs, no sensitive PII, no money.

const HUMAN_TEXT_INDICES = new Set([2, 3]); // employee_name, site_name

function hours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}
function helsinkiTime(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function buildCustomerHoursCsv(report: CustomTimeReport): Buffer {
  const header = ['row_type', 'date', 'employee_name', 'site_name', 'first_start', 'last_end', 'worked_minutes', 'worked_hours', 'gross_minutes', 'paid_break_minutes', 'unpaid_break_minutes', 'worked_days'];
  const lines: string[] = [buildCsvRow(header, new Set())];

  for (const d of report.dailyRows) {
    lines.push(
      buildCsvRow(
        ['DETAIL', d.date, `${d.employee.lastName} ${d.employee.firstName}`, d.site.name, helsinkiTime(d.firstStartAt), helsinkiTime(d.lastEndAt), d.workedMinutes, hours(d.workedMinutes), d.grossMinutes, d.paidBreakMinutes, d.unpaidBreakMinutes, ''],
        HUMAN_TEXT_INDICES
      )
    );
  }
  for (const e of report.employeeSubtotals) {
    lines.push(
      buildCsvRow(
        ['EMPLOYEE_SUBTOTAL', '', `${e.employee.lastName} ${e.employee.firstName}`, '', '', '', e.totals.workedMinutes, hours(e.totals.workedMinutes), e.totals.grossMinutes, e.totals.paidBreakMinutes, e.totals.unpaidBreakMinutes, e.totals.workedDays],
        HUMAN_TEXT_INDICES
      )
    );
  }
  for (const s of report.siteSubtotals) {
    lines.push(
      buildCsvRow(
        ['SITE_SUBTOTAL', '', '', s.site.name, '', '', s.totals.workedMinutes, hours(s.totals.workedMinutes), s.totals.grossMinutes, s.totals.paidBreakMinutes, s.totals.unpaidBreakMinutes, s.totals.workedDays],
        HUMAN_TEXT_INDICES
      )
    );
  }
  lines.push(
    buildCsvRow(
      ['GRAND_TOTAL', '', '', '', '', '', report.grandTotal.workedMinutes, hours(report.grandTotal.workedMinutes), report.grandTotal.grossMinutes, report.grandTotal.paidBreakMinutes, report.grandTotal.unpaidBreakMinutes, report.grandTotal.workedDays],
      HUMAN_TEXT_INDICES
    )
  );

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function customerHoursCsvFileName(report: CustomTimeReport): string {
  return `titanor-project-hours_${report.dateFrom}_${report.dateTo}.csv`;
}
