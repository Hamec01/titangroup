// Табель v2 → "Скачать Excel": the customer month grid as an .xlsx laid out like the customer's own
// spreadsheet (Nr., Surname, Name, Emp. no., day 1..31 with the weekday under it, Total; a Sum: row under it). English
// headers — the file is for the customer. Colours match the on-screen grid. Hours are numbers and
// the totals are SUM formulas (with cached values), so the customer can keep working in the sheet.

import { buildXlsx, cellRef, type XlsxCell, type XlsxStyle } from '@/lib/xlsx-writer';
import type { MonthlyMatrix } from '@/lib/reporting/monthly-matrix';

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const GREEN = '92D050';
const BLUE = '00B0F0';
const RED = 'FF0000';
const HEADER = 'DDEBF7';
const SUM = 'D9D9D9';

const st = {
  title: { bold: true, fontSize: 14 } satisfies XlsxStyle,
  subtitle: { fontSize: 11, fontColor: '595959' } satisfies XlsxStyle,
  head: { bold: true, fill: HEADER, border: true, align: 'center' } satisfies XlsxStyle,
  headLeft: { bold: true, fill: HEADER, border: true, align: 'left' } satisfies XlsxStyle,
  headWeekend: { bold: true, fill: BLUE, border: true, align: 'center' } satisfies XlsxStyle,
  headSmall: { fontSize: 9, fill: HEADER, border: true, align: 'center' } satisfies XlsxStyle,
  headWeekendSmall: { fontSize: 9, fill: BLUE, border: true, align: 'center' } satisfies XlsxStyle,
  text: { border: true, align: 'left' } satisfies XlsxStyle,
  textBold: { bold: true, border: true, align: 'left' } satisfies XlsxStyle,
  number: { border: true, align: 'center' } satisfies XlsxStyle,
  work: { fill: GREEN, border: true, align: 'center' } satisfies XlsxStyle,
  weekend: { fill: BLUE, border: true, align: 'center' } satisfies XlsxStyle,
  off: { fill: RED, fontColor: '9C0006', bold: true, border: true, align: 'center' } satisfies XlsxStyle,
  empty: { border: true, align: 'center' } satisfies XlsxStyle,
  total: { bold: true, border: true, align: 'center' } satisfies XlsxStyle,
  sumLabel: { bold: true, fill: SUM, border: true, align: 'right' } satisfies XlsxStyle,
  sum: { bold: true, fill: SUM, border: true, align: 'center' } satisfies XlsxStyle,
  sumWeekend: { bold: true, fill: BLUE, border: true, align: 'center' } satisfies XlsxStyle,
  legendWork: { fill: GREEN, border: true } satisfies XlsxStyle,
  legendWeekend: { fill: BLUE, border: true } satisfies XlsxStyle,
  legendOff: { fill: RED, fontColor: '9C0006', bold: true, border: true, align: 'center' } satisfies XlsxStyle
};

function hours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export function monthlyMatrixXlsxFileName(customerName: string, month: string): string {
  return `Timesheet_${customerName}_${month}.xlsx`;
}

export function buildMonthlyMatrixXlsx(matrix: MonthlyMatrix, meta: { customerName: string; siteName: string; generatedAt: string }): Buffer {
  const [year, monthNumber] = matrix.month.split('-').map(Number);
  const firstDayCol = 4;
  const totalCol = firstDayCol + matrix.days.length;
  const headerRow = 3;
  const rows: Array<Array<XlsxCell | null>> = [];

  rows[0] = [{ value: `${meta.customerName} — ${meta.siteName}`, style: st.title }];
  rows[1] = [{ value: `${MONTHS_EN[monthNumber - 1]} ${year} · generated ${meta.generatedAt}`, style: st.subtitle }];
  rows[2] = [];
  rows[headerRow] = [
    { value: 'Nr.', style: st.head },
    { value: 'Surname', style: st.headLeft },
    { value: 'Name', style: st.headLeft },
    { value: 'Emp. no.', style: st.head },
    ...matrix.days.map((d): XlsxCell => ({ value: d.day, style: d.weekend ? st.headWeekend : st.head })),
    { value: 'Total', style: st.head }
  ];
  // Second header row: weekday under each day number (the four worker columns and Total are merged).
  rows[headerRow + 1] = [
    ...[0, 1, 2, 3].map((): XlsxCell => ({ value: null, style: st.head })),
    ...matrix.days.map((d): XlsxCell => ({ value: WEEKDAYS_EN[d.isoWeekday - 1], style: d.weekend ? st.headWeekendSmall : st.headSmall })),
    { value: null, style: st.head }
  ];
  const dataStart = headerRow + 2;
  matrix.rows.forEach((row, i) => {
    const r = dataStart + i;
    const cells: XlsxCell[] = [
      { value: i + 1, style: st.number },
      { value: row.lastName, style: st.textBold },
      { value: row.firstName, style: st.text },
      { value: row.employeeNumber, style: st.number }
    ];
    row.cells.forEach((cell, d) => {
      const weekend = matrix.days[d].weekend;
      if (cell.kind === 'WORK') cells.push({ value: hours(cell.workedMinutes), style: weekend ? st.weekend : st.work });
      else if (cell.kind === 'OFF') cells.push({ value: 'OFF', style: st.off });
      else if (cell.kind === 'WEEKEND') cells.push({ value: null, style: st.weekend });
      else cells.push({ value: null, style: st.empty });
    });
    cells.push({ formula: `SUM(${cellRef(r, firstDayCol)}:${cellRef(r, totalCol - 1)})`, value: hours(row.totalMinutes), style: st.total });
    rows[r] = cells;
  });

  const sumRow = dataStart + matrix.rows.length;
  const dataFirst = dataStart;
  const dataLast = Math.max(dataStart, sumRow - 1);
  rows[sumRow] = [
    { value: 'Sum:', style: st.sumLabel },
    { value: null, style: st.sumLabel },
    { value: null, style: st.sumLabel },
    { value: null, style: st.sumLabel },
    ...matrix.days.map((d, i): XlsxCell => ({ formula: `SUM(${cellRef(dataFirst, firstDayCol + i)}:${cellRef(dataLast, firstDayCol + i)})`, value: hours(matrix.dayTotals[i]), style: d.weekend ? st.sumWeekend : st.sum })),
    { formula: `SUM(${cellRef(dataFirst, totalCol)}:${cellRef(dataLast, totalCol)})`, value: hours(matrix.totalMinutes), style: st.sum }
  ];

  const legend = sumRow + 2;
  rows[legend] = [null, { value: null, style: st.legendWork }, { value: 'Hours worked' }];
  rows[legend + 1] = [null, { value: null, style: st.legendWeekend }, { value: 'Weekend / public holiday' }];
  rows[legend + 2] = [null, { value: 'OFF', style: st.legendOff }, { value: 'Did not work (absence, sick leave, vacation)' }];

  for (let i = 0; i < rows.length; i += 1) rows[i] ??= [];

  return buildXlsx({
    name: `${MONTHS_EN[monthNumber - 1]} ${year}`,
    rows,
    columnWidths: [5, 18, 16, 9, ...matrix.days.map(() => 5.5), 8],
    merges: [[headerRow, 0, headerRow + 1, 0], [headerRow, 1, headerRow + 1, 1], [headerRow, 2, headerRow + 1, 2], [headerRow, 3, headerRow + 1, 3], [headerRow, totalCol, headerRow + 1, totalCol], [sumRow, 0, sumRow, 3]],
    freeze: { rows: dataStart, cols: firstDayCol },
    landscape: true
  });
}
