import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import { formatWorkedDuration, timesheetStatusLabel } from '@/lib/reporting/report-format';
import type { CustomTimeReport } from '@/lib/reporting/custom-time-report';
import type { AppLocale } from '@/lib/i18n/locale';

// Part A CSV export (task spec §6) — reuses the exact BOM/CRLF/quote-every-cell/formula-
// injection-guard primitive CSV_V1 uses (lib/csv-export.ts's buildCsvRow), with a fully
// different, human-readable column set: no UUIDs, human-readable durations
// (lib/reporting/report-format.ts's formatWorkedDuration — same formatter T8's admin UI uses),
// never the raw CSV_V1 payroll-batch schema. This is deliberately a separate code path from
// createExportBatch()/ExportBatch — no persistent state, see custom-time-report.ts's docblock.

// Only 3 human-text columns risk spreadsheet-formula injection in either CSV shape — same
// principle as CSV_V1's HUMAN_TEXT_COLUMN_INDICES, applied to this CSV's own column order.
const SUMMARY_HUMAN_TEXT_INDICES = new Set([1, 2]); // employee_name, site_name
const DETAIL_HUMAN_TEXT_INDICES = new Set([2, 3, 4]); // employee_name, site_name, work_area

function dateRangeLabel(report: CustomTimeReport): string {
  return `${report.dateFrom} – ${report.dateTo}`;
}

function helsinkiTimeOfDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function buildCustomReportSummaryCsv(report: CustomTimeReport, locale: AppLocale): Buffer {
  const header = locale === 'RU'
    ? ['Табельный номер', 'ФИО работника', 'Объект', 'Период', 'Общее время', 'Оплач. перерывы', 'Неоплач. перерывы', 'Отработано', 'Рабочих дней']
    : ['Employee number', 'Employee name', 'Site', 'Date range', 'Gross time', 'Paid breaks', 'Unpaid breaks', 'Worked time', 'Worked days'];

  const rows: string[] = [buildCsvRow(header, new Set())];
  const range = dateRangeLabel(report);

  for (const row of report.summaryRows) {
    rows.push(
      buildCsvRow(
        [
          row.employee.employeeNumber,
          `${row.employee.lastName} ${row.employee.firstName}`,
          row.site.name,
          range,
          formatWorkedDuration(row.grossMinutes, locale),
          formatWorkedDuration(row.paidBreakMinutes, locale),
          formatWorkedDuration(row.unpaidBreakMinutes, locale),
          formatWorkedDuration(row.workedMinutes, locale),
          row.workedDays
        ],
        SUMMARY_HUMAN_TEXT_INDICES
      )
    );
  }

  if (report.employeeSubtotals.length > 1) {
    for (const e of report.employeeSubtotals) {
      const label = locale === 'RU' ? `Итого — ${e.employee.lastName} ${e.employee.firstName}` : `Subtotal — ${e.employee.lastName} ${e.employee.firstName}`;
      rows.push(
        buildCsvRow(
          [e.employee.employeeNumber, label, '', range, formatWorkedDuration(e.totals.grossMinutes, locale), formatWorkedDuration(e.totals.paidBreakMinutes, locale), formatWorkedDuration(e.totals.unpaidBreakMinutes, locale), formatWorkedDuration(e.totals.workedMinutes, locale), e.totals.workedDays],
          SUMMARY_HUMAN_TEXT_INDICES
        )
      );
    }
  }
  if (report.siteSubtotals.length > 1) {
    for (const s of report.siteSubtotals) {
      const label = locale === 'RU' ? `Итого — ${s.site.name}` : `Subtotal — ${s.site.name}`;
      rows.push(
        buildCsvRow(
          ['', label, s.site.name, range, formatWorkedDuration(s.totals.grossMinutes, locale), formatWorkedDuration(s.totals.paidBreakMinutes, locale), formatWorkedDuration(s.totals.unpaidBreakMinutes, locale), formatWorkedDuration(s.totals.workedMinutes, locale), s.totals.workedDays],
          SUMMARY_HUMAN_TEXT_INDICES
        )
      );
    }
  }
  const grandLabel = locale === 'RU' ? 'ИТОГО' : 'GRAND TOTAL';
  rows.push(
    buildCsvRow(
      ['', grandLabel, '', range, formatWorkedDuration(report.grandTotal.grossMinutes, locale), formatWorkedDuration(report.grandTotal.paidBreakMinutes, locale), formatWorkedDuration(report.grandTotal.unpaidBreakMinutes, locale), formatWorkedDuration(report.grandTotal.workedMinutes, locale), report.grandTotal.workedDays],
      SUMMARY_HUMAN_TEXT_INDICES
    )
  );

  return Buffer.concat([CSV_BOM, Buffer.from(rows.join(''), 'utf8')]);
}

export function buildCustomReportDetailedCsv(report: CustomTimeReport, locale: AppLocale): Buffer {
  const header = locale === 'RU'
    ? ['Дата', 'Табельный номер', 'ФИО работника', 'Объект', 'Рабочая зона', 'Начало', 'Окончание', 'Оплач. перерыв', 'Неоплач. перерыв', 'Отработано', 'Статус табеля']
    : ['Date', 'Employee number', 'Employee name', 'Site', 'Work area', 'Start', 'End', 'Paid break', 'Unpaid break', 'Worked time', 'Timesheet status'];

  const rows: string[] = [buildCsvRow(header, new Set())];
  for (const row of report.detailRows) {
    rows.push(
      buildCsvRow(
        [
          row.date,
          row.employee.employeeNumber,
          `${row.employee.lastName} ${row.employee.firstName}`,
          row.site.name,
          row.workAreaName ?? '',
          helsinkiTimeOfDay(row.startAt),
          helsinkiTimeOfDay(row.endAt),
          formatWorkedDuration(row.paidBreakMinutes, locale),
          formatWorkedDuration(row.unpaidBreakMinutes, locale),
          formatWorkedDuration(row.workedMinutes, locale),
          timesheetStatusLabel(row.timesheetStatus, locale)
        ],
        DETAIL_HUMAN_TEXT_INDICES
      )
    );
  }
  return Buffer.concat([CSV_BOM, Buffer.from(rows.join(''), 'utf8')]);
}

export function customReportCsvFileName(report: CustomTimeReport): string {
  return `titanor-time-report_${report.dateFrom}_${report.dateTo}.csv`;
}
