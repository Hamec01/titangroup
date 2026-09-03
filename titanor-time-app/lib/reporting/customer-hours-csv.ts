import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { CustomerTimeReport } from '@/lib/reporting/customer-time-report';

// R15-D7 Deploy F — "Часы заказчику" CSV. UTF-8 BOM, CRLF, formula-injection guard (buildCsvRow).
// One section per selected customer; a WORKER row per worker; a CUSTOMER_TOTAL row per customer;
// a GRAND_TOTAL row when more than one customer. Minutes AND decimal hours (dot). Customer + site
// names come from the report (resolved server-side by id). NO money, rates, GPS, personal docs.

const HUMAN_TEXT_INDICES = new Set([1, 2, 3]); // customer_name, site_name, employee_name

function hours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

export function buildCustomerHoursCsv(report: CustomerTimeReport): Buffer {
  const header = [
    'row_type',
    'customer_name',
    'site_name',
    'employee_name',
    'employee_number',
    'work_dates',
    'worked_minutes',
    'worked_hours',
    'timesheet_status',
    'date_from',
    'date_to',
    'final_approved'
  ];
  const lines: string[] = [buildCsvRow(header, new Set())];
  const finalApproved = report.dataMode === 'FINAL_APPROVED_ONLY' ? 'yes' : 'no';

  for (const section of report.sections) {
    const customerName = section.workAreaName ?? '(no customer)';
    for (const w of section.workers) {
      lines.push(
        buildCsvRow(
          [
            'WORKER',
            customerName,
            section.siteName,
            `${w.employee.lastName} ${w.employee.firstName}`,
            w.employee.employeeNumber,
            w.workDates.join(' '),
            w.workedMinutes,
            hours(w.workedMinutes),
            w.timesheetStatus,
            report.dateFrom,
            report.dateTo,
            finalApproved
          ],
          HUMAN_TEXT_INDICES
        )
      );
    }
    lines.push(
      buildCsvRow(
        ['CUSTOMER_TOTAL', customerName, section.siteName, '', '', '', section.totalMinutes, hours(section.totalMinutes), '', report.dateFrom, report.dateTo, finalApproved],
        HUMAN_TEXT_INDICES
      )
    );
  }

  if (report.sections.length > 1) {
    lines.push(
      buildCsvRow(
        ['GRAND_TOTAL', '', '', '', '', '', report.grandTotalMinutes, hours(report.grandTotalMinutes), '', report.dateFrom, report.dateTo, finalApproved],
        HUMAN_TEXT_INDICES
      )
    );
  }

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function customerHoursCsvFileName(report: CustomerTimeReport): string {
  const one = report.sections.length === 1 ? report.sections[0].workAreaName : null;
  const slug = (one ?? 'customers').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'customers';
  return `titanor-customer-hours_${slug}_${report.dateFrom}_${report.dateTo}.csv`;
}
