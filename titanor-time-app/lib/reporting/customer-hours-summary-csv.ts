import { CSV_BOM, buildCsvRow } from '@/lib/csv-export';
import type { CustomerHoursSummaryResult } from '@/lib/reporting/customer-hours-summary';

// UT8-B — the new customer-facing "Сводка" CSV. Same safety primitives as the legacy
// customer-hours-csv.ts (UTF-8 BOM, CRLF, formula-injection guard via buildCsvRow) but reads
// EXCLUSIVELY from CustomerHoursSummaryResult.rows — the exact WeeklyCustomerSliceRow numbers
// already shown in "Табель" — never a fresh computation. No GPS, no coordinates, no salary/rates,
// no personal documents, no internal notes.
//
// mode='final': only approvalState==='APPROVED' rows (the caller must have already refused to reach
// here at all unless summary.readyForCustomerExport === true — this filter is a second, defensive
// guarantee, not the only one).
// mode='preview': every row in scope, each carrying its own approval_status column — never
// presented as the official document (the PDF/UI layer adds the explicit watermark/banner).

export type SummaryExportMode = 'preview' | 'final' | 'recorded';

// Header: row_type(0) customer_name(1) site_name(2) week_start(3) week_end(4) employee_name(5)
// employee_number(6) worked_minutes(7) worked_hours(8) approval_status(9) confirmed_by(10) confirmed_at(11)
const HUMAN_TEXT_INDICES = new Set([1, 2, 5, 6, 10]); // customer_name, site_name, employee_name, employee_number, confirmed_by

function hours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'confirmed',
  READY: 'pending',
  NEEDS_ATTENTION: 'pending',
  CHANGED_AFTER_APPROVAL: 'changed_after_approval'
};

interface DetailRow {
  customerName: string;
  siteName: string;
  weekStart: string;
  weekEnd: string;
  employeeName: string;
  employeeNumber: string;
  employeeId: string;
  customerKey: string;
  workedMinutes: number;
  approvalStatus: string;
  confirmedBy: string;
  confirmedAt: string;
}

export function buildCustomerHoursSummaryCsv(summary: CustomerHoursSummaryResult, mode: SummaryExportMode): Buffer {
  if (mode === 'recorded') return buildRecordedHoursCsv(summary);

  const header = ['row_type', 'customer_name', 'site_name', 'week_start', 'week_end', 'employee_name', 'employee_number', 'worked_minutes', 'worked_hours', 'approval_status', 'confirmed_by', 'confirmed_at'];
  const lines: string[] = [buildCsvRow(header, new Set())];

  // UT8-B-fixup-3 #2 — final never includes a row whose worker hasn't actually submitted it, even if
  // an admin pre-confirmed the draft (approvalState==='APPROVED' alone is no longer sufficient here —
  // this is the renderer-level half of the guarantee; loadCustomerHoursSummary's own
  // readyForCustomerExport/blockers already refuses the export route before reaching this function).
  const sourceRows = mode === 'final' ? summary.rows.filter((r) => r.approvalState === 'APPROVED' && r.submissionState === 'SUBMITTED') : summary.rows;

  const details: DetailRow[] = sourceRows.map((r) => ({
    customerName: r.logicalKey.workAreaId ? (summary.byCustomer.find((c) => c.workAreaId === r.logicalKey.workAreaId && c.siteId === r.logicalKey.siteId)?.workAreaName ?? '') : '(no customer)',
    siteName: summary.byCustomer.find((c) => c.siteId === r.logicalKey.siteId && c.workAreaId === r.logicalKey.workAreaId)?.siteName ?? '',
    weekStart: r.logicalKey.weekStart,
    weekEnd: r.logicalKey.weekEnd,
    employeeName: r.employeeName,
    employeeNumber: r.employeeNumber,
    employeeId: r.logicalKey.employeeId,
    customerKey: `${r.logicalKey.siteId}::${r.logicalKey.workAreaId ?? ''}`,
    workedMinutes: r.workedMinutes,
    // UT8-B-fixup-3 #2 — submissionState wins over approvalState for the DISPLAYED status: a
    // still-DRAFT/RETURNED slice reads "not_submitted" even when an admin already confirmed it.
    approvalStatus: r.submissionState === 'SUBMITTED' ? (STATUS_LABEL[r.approvalState] ?? r.approvalState.toLowerCase()) : 'not_submitted',
    confirmedBy: r.currentApprovalItem?.approvedByUserName ?? '',
    confirmedAt: r.currentApprovalItem?.approvedAt ?? ''
  }));
  details.sort((a, b) => a.customerName.localeCompare(b.customerName) || a.employeeName.localeCompare(b.employeeName) || a.weekStart.localeCompare(b.weekStart));

  const byCustomer = new Map<string, DetailRow[]>();
  for (const d of details) {
    const list = byCustomer.get(d.customerKey) ?? [];
    list.push(d);
    byCustomer.set(d.customerKey, list);
  }

  let grandTotal = 0;
  for (const [, rowsForCustomer] of byCustomer) {
    const customerName = rowsForCustomer[0].customerName;
    const siteName = rowsForCustomer[0].siteName;
    let customerTotal = 0;

    const byEmployee = new Map<string, DetailRow[]>();
    for (const d of rowsForCustomer) {
      const list = byEmployee.get(d.employeeId) ?? [];
      list.push(d);
      byEmployee.set(d.employeeId, list);
    }

    for (const [, rowsForEmployee] of byEmployee) {
      let employeeTotal = 0;
      for (const d of rowsForEmployee) {
        lines.push(
          buildCsvRow(
            ['DETAIL', d.customerName, d.siteName, d.weekStart, d.weekEnd, d.employeeName, d.employeeNumber, d.workedMinutes, hours(d.workedMinutes), d.approvalStatus, d.confirmedBy, d.confirmedAt],
            HUMAN_TEXT_INDICES
          )
        );
        employeeTotal += d.workedMinutes;
      }
      lines.push(
        buildCsvRow(['WORKER_TOTAL', customerName, siteName, '', '', rowsForEmployee[0].employeeName, rowsForEmployee[0].employeeNumber, employeeTotal, hours(employeeTotal), '', '', ''], HUMAN_TEXT_INDICES)
      );
      customerTotal += employeeTotal;
    }

    lines.push(buildCsvRow(['CUSTOMER_TOTAL', customerName, siteName, '', '', '', '', customerTotal, hours(customerTotal), '', '', ''], HUMAN_TEXT_INDICES));
    grandTotal += customerTotal;
  }

  if (byCustomer.size > 1) {
    lines.push(buildCsvRow(['GRAND_TOTAL', '', '', '', '', '', '', grandTotal, hours(grandTotal), '', '', ''], HUMAN_TEXT_INDICES));
  }

  // UT8-B-fixup #2 — preview only: historical (removed / source-unreadable) rows and whole-timesheet
  // source errors are listed EXPLICITLY, with their own row_type and reason, never folded into any
  // DETAIL/WORKER_TOTAL/CUSTOMER_TOTAL/GRAND_TOTAL sum above — those totals only ever iterate
  // `details`. A HISTORICAL row's worked_minutes is the OLD confirmed value (informational only,
  // clearly not current); a SOURCE_ERROR row has none (the source never resolved a single segment).
  // Never emitted for mode='final' — the route already refuses to reach here at all while either
  // list is non-empty, but this is a second, defensive guarantee at the renderer level too.
  if (mode === 'preview') {
    for (const h of summary.historical) {
      const status = h.reason === 'SLICE_REMOVED' ? 'removed_after_confirmation' : 'source_unreadable_historical';
      lines.push(
        buildCsvRow(
          [
            'HISTORICAL',
            h.workAreaName ?? '(no customer)',
            h.siteName,
            h.weekStart,
            h.weekEnd,
            h.employeeName,
            h.employeeNumber,
            h.lastApproval.workedMinutes,
            hours(h.lastApproval.workedMinutes),
            status,
            h.lastApproval.approvedByUserName,
            h.lastApproval.approvedAt
          ],
          HUMAN_TEXT_INDICES
        )
      );
    }
    for (const se of summary.sourceErrors) {
      lines.push(buildCsvRow(['SOURCE_ERROR', '', '', '', '', se.employeeName, se.employeeNumber, '', '', 'source_unreadable', '', ''], HUMAN_TEXT_INDICES));
    }
    // UT8-B-fixup-2/fixup-3 #1 — a worker expected to have a timesheet for this period with no
    // SUBMITTED content at all (either no Timesheet whatsoever, or one still stuck at an empty
    // DRAFT/RETURNED): no customer/site attribution (no segments exist to read one from), no hours
    // (nothing to have hours for), week_start/week_end reuse the PERIOD's own start/end. Never in
    // any total above. A DRAFT/RETURNED slice that DOES have hours shows up as a DETAIL row instead
    // (see the submissionState-driven approvalStatus override above), not here.
    for (const ns of summary.notSubmitted) {
      lines.push(buildCsvRow(['NOT_SUBMITTED', '', '', ns.periodStartDate, ns.periodEndDate, ns.employeeName, ns.employeeNumber, '', '', 'not_submitted', '', ''], HUMAN_TEXT_INDICES));
    }
    if (summary.totals.historicalTruncated) {
      lines.push(
        buildCsvRow(['NOTE', 'historical list is incomplete for this selection — narrow the filter to see everything', '', '', '', '', '', '', '', '', '', ''], new Set([1]))
      );
    }
  }

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}

export function customerHoursSummaryCsvFileName(summary: CustomerHoursSummaryResult, mode: SummaryExportMode): string {
  const one = summary.byCustomer.length === 1 ? summary.byCustomer[0].workAreaName : null;
  const slug = (one ?? 'customers').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'customers';
  const modeTag = mode === 'preview' ? '_preview' : mode === 'recorded' ? '_recorded' : '';
  return `titanor-summary_${slug}_${summary.requestedRange.startDate}_${summary.requestedRange.endDate}${modeTag}.csv`;
}

function buildRecordedHoursCsv(summary: CustomerHoursSummaryResult): Buffer {
  const header = ['row_type', 'customer_name', 'site_name', 'week_start', 'week_end', 'employee_name', 'employee_number', 'worked_minutes', 'worked_hours'];
  const lines: string[] = [buildCsvRow(header, new Set())];
  const textIndices = new Set([1, 2, 5, 6]);

  const rows = summary.rows
    .map((r) => {
      const customer = summary.byCustomer.find((c) => c.siteId === r.logicalKey.siteId && c.workAreaId === r.logicalKey.workAreaId);
      return {
        customerName: customer?.workAreaName ?? '(no customer)',
        siteName: customer?.siteName ?? '',
        weekStart: r.logicalKey.weekStart,
        weekEnd: r.logicalKey.weekEnd,
        employeeName: r.employeeName,
        employeeNumber: r.employeeNumber,
        employeeId: r.logicalKey.employeeId,
        customerKey: `${r.logicalKey.siteId}::${r.logicalKey.workAreaId ?? ''}`,
        workedMinutes: r.workedMinutes
      };
    })
    .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.employeeName.localeCompare(b.employeeName) || a.weekStart.localeCompare(b.weekStart));

  const byCustomer = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byCustomer.get(row.customerKey) ?? [];
    list.push(row);
    byCustomer.set(row.customerKey, list);
  }

  let grandTotal = 0;
  for (const customerRows of byCustomer.values()) {
    let customerTotal = 0;
    const byEmployee = new Map<string, typeof rows>();
    for (const row of customerRows) {
      const list = byEmployee.get(row.employeeId) ?? [];
      list.push(row);
      byEmployee.set(row.employeeId, list);
    }
    for (const employeeRows of byEmployee.values()) {
      let employeeTotal = 0;
      for (const row of employeeRows) {
        lines.push(buildCsvRow(['DETAIL', row.customerName, row.siteName, row.weekStart, row.weekEnd, row.employeeName, row.employeeNumber, row.workedMinutes, hours(row.workedMinutes)], textIndices));
        employeeTotal += row.workedMinutes;
      }
      const first = employeeRows[0];
      lines.push(buildCsvRow(['WORKER_TOTAL', first.customerName, first.siteName, '', '', first.employeeName, first.employeeNumber, employeeTotal, hours(employeeTotal)], textIndices));
      customerTotal += employeeTotal;
    }
    const first = customerRows[0];
    lines.push(buildCsvRow(['CUSTOMER_TOTAL', first.customerName, first.siteName, '', '', '', '', customerTotal, hours(customerTotal)], textIndices));
    grandTotal += customerTotal;
  }
  if (byCustomer.size > 1) lines.push(buildCsvRow(['GRAND_TOTAL', '', '', '', '', '', '', grandTotal, hours(grandTotal)], textIndices));

  return Buffer.concat([CSV_BOM, Buffer.from(lines.join(''), 'utf8')]);
}
