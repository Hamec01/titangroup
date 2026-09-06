import type { PeriodTimeReport } from '@/lib/period-time-report';
import {
  drawWorkingReportHeader,
  drawWorkingReportPageNumbers,
  finalizeWorkingReportPdf,
  formatMinutesEnglish,
  newWorkingReportPdf,
  timesheetStatusEnglish,
  workingReportFileName,
  type WorkingReportMeta
} from '@/lib/reporting/working-report';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §3 + §6 — English-only working
// report PDF. Receives the FULL site set (export route uses `{ all: true }`); the table below is
// never truncated and the TOTAL row's additive columns equal the sum of the rows above.

const COLUMNS: { header: string; width: number; align?: 'left' | 'right' }[] = [
  { header: 'Site', width: 150 },
  { header: 'Workers (hrs/assigned)', width: 90 },
  { header: 'Worked days', width: 52, align: 'right' },
  { header: 'Gross', width: 66, align: 'right' },
  { header: 'Breaks', width: 66, align: 'right' },
  { header: 'Worked', width: 66, align: 'right' },
  { header: 'Segments', width: 46, align: 'right' }
];

export async function buildPeriodReportPdf(report: PeriodTimeReport, meta: WorkingReportMeta): Promise<Buffer> {
  const doc = newWorkingReportPdf('portrait');
  const left = doc.page.margins.left;
  const totalWidth = COLUMNS.reduce((a, c) => a + c.width, 0);
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  let y = drawWorkingReportHeader(doc, 'Payroll period summary', meta);

  const s = report.summary;
  doc.font('DejaVu-Bold').fontSize(9).text('Company summary', left, y);
  y = doc.y + 2;
  doc.font('DejaVu').fontSize(8).fillColor('#333333');
  doc.text(
    `Workers (unique): ${s.workerCount}   Sites: ${s.siteCount}   With hours: ${s.workedWorkerCount}   Assigned: ${s.assignedWorkerCount}   Without timesheet: ${s.withoutTimesheetCount}   Worked days: ${s.workedDayCount}`,
    left,
    y,
    { width: totalWidth }
  );
  y = doc.y + 3;
  const st = s.timesheetStatusCounts;
  doc.text(
    `Timesheet status — ${(['DRAFT', 'SUBMITTED', 'RETURNED', 'FOREMAN_APPROVED', 'FINAL_APPROVED'] as const).map((k) => `${timesheetStatusEnglish(k)}: ${st[k]}`).join('   ')}`,
    left,
    y,
    { width: totalWidth }
  );
  y = doc.y + 10;
  doc.fillColor('#111111');

  const drawHead = (top: number): number => {
    doc.rect(left, top, totalWidth, 20).fillAndStroke('#eeeeee', '#333333');
    doc.fillColor('#111111').font('DejaVu-Bold').fontSize(7.5);
    let cx = left;
    for (const col of COLUMNS) {
      doc.text(col.header, cx + 3, top + 6, { width: col.width - 6, align: col.align ?? 'left', lineBreak: false });
      cx += col.width;
    }
    doc.font('DejaVu').fontSize(7.5);
    return top + 20;
  };

  const drawRow = (cells: string[], bold = false): void => {
    const heights = COLUMNS.map((col, i) => doc.heightOfString(cells[i], { width: col.width - 6 }));
    const rowHeight = Math.max(18, ...heights) + 6;
    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawHead(doc.page.margins.top);
    }
    doc.rect(left, y, totalWidth, rowHeight).stroke('#cccccc');
    doc.font(bold ? 'DejaVu-Bold' : 'DejaVu').fontSize(7.5).fillColor('#111111');
    let cx = left;
    for (let i = 0; i < COLUMNS.length; i++) {
      doc.text(cells[i], cx + 3, y + 4, { width: COLUMNS[i].width - 6, align: COLUMNS[i].align ?? 'left' });
      cx += COLUMNS[i].width;
    }
    y += rowHeight;
  };

  y = drawHead(y);
  if (report.sites.length === 0) {
    drawRow(['No sites with hours or assignments in this period.', '', '', '', '', '', '']);
  } else {
    for (const site of report.sites) {
      drawRow([
        site.site.name,
        `${site.workedWorkerCount} / ${site.assignedWorkerCount}`,
        String(site.workedDayCount),
        formatMinutesEnglish(site.grossMinutes),
        formatMinutesEnglish(site.paidBreakMinutes + site.unpaidBreakMinutes),
        formatMinutesEnglish(site.workedMinutes),
        String(site.segmentCount)
      ]);
    }
    drawRow(
      [
        'TOTAL',
        `${s.workedWorkerCount} / ${s.assignedWorkerCount}`,
        String(s.workedDayCount),
        formatMinutesEnglish(s.grossMinutes),
        formatMinutesEnglish(s.paidBreakMinutes + s.unpaidBreakMinutes),
        formatMinutesEnglish(s.workedMinutes),
        String(s.segmentCount)
      ],
      true
    );
  }

  y += 8;
  if (y + 40 > bottomLimit) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.font('DejaVu').fontSize(6.5).fillColor('#666666').text(
    'Note: worker counts and worked-day counts on the TOTAL line are deduplicated company figures — a worker or a date active on several sites is counted once there but appears in every matching site row. Only gross / break / worked minutes and segment counts are column sums.',
    left,
    y,
    { width: totalWidth }
  );

  drawWorkingReportPageNumbers(doc);
  return finalizeWorkingReportPdf(doc);
}

export function periodReportPdfFileName(report: PeriodTimeReport): string {
  return workingReportFileName('PERIOD_SUMMARY', 'PDF', { startDate: report.period.startDate, endDate: report.period.endDate });
}
