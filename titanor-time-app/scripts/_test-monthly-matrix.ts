export {};

let passed = 0;

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
  passed += 1;
}

type Day = { date: string; dayType?: string; confirmedZero?: boolean; minutes?: number };

function slice(employeeId: string, name: string, number: string, siteId: string, workAreaId: string | null, weekStart: string, days: Day[], submitted = true) {
  return {
    kind: 'WEEKLY_CUSTOMER_SLICE' as const,
    logicalKey: { employeeId, timesheetId: `t-${employeeId}`, siteId, workAreaId, weekStart, weekEnd: '' },
    employeeName: name,
    employeeNumber: number,
    submissionState: submitted ? ('SUBMITTED' as const) : ('NOT_SUBMITTED' as const),
    displayDays: days.map((d) => ({ date: d.date, dayType: d.dayType ?? 'WORK', confirmedZero: d.confirmedZero ?? false, segments: [], autoUnpaidBreakMinutes: 0, grossMinutes: d.minutes ?? 0, breakMinutes: 0, workedMinutes: d.minutes ?? 0 }))
  } as unknown as import('../lib/reporting/time-ledger').WeeklyCustomerSliceRow;
}

function week(start: string, minutes: Array<number | Day>): Day[] {
  const base = new Date(`${start}T00:00:00Z`).getTime();
  return minutes.map((m, i) => {
    const date = new Date(base + i * 86400000).toISOString().slice(0, 10);
    return typeof m === 'number' ? { date, minutes: m } : { ...m, date };
  });
}

async function main() {
  const { buildMonthlyMatrix, monthDays, monthRange, shiftMonth, isValidMonth, formatMatrixHours, customerKeyOf } = await import('../lib/reporting/monthly-matrix');

  check(isValidMonth('2026-10') && !isValidMonth('2026-13') && !isValidMonth('26-10') && !isValidMonth('2026-1'), 'month validation');
  check(shiftMonth('2026-01', -1) === '2025-12' && shiftMonth('2026-12', 1) === '2027-01', 'month shift across years');
  check(monthRange('2028-02').endDate === '2028-02-29' && monthRange('2026-10').endDate === '2026-10-31', 'month range incl. leap year');
  const october = monthDays('2026-10');
  check(october.length === 31 && october[0].isoWeekday === 4 && october[2].weekend && october[3].weekend && !october[4].weekend, 'Oct 2026 starts Thursday; 3–4 are the weekend');
  check(formatMatrixHours(600) === '10' && formatMatrixHours(450) === '7.5' && formatMatrixHours(0) === '', 'hour formatting');

  const A = 'site-a';
  const names = new Map([['e1', { firstName: 'Oleksandr', lastName: 'Kryvoshlyk' }]]);
  // Week of Mon 28.09 – Sun 04.10: 28–30 Sept belong to September and must be ignored.
  const inputs = [
    { slice: slice('e1', 'Oleksandr Kryvoshlyk', '1001', A, 'wa-1', '2026-09-28', week('2026-09-28', [600, 600, 600, 600, 600, 240, 0])), siteName: 'Meyer Turku', workAreaName: 'Siris Finland Oy' },
    // Week 05.10 – 11.10: Mon 8h, Tue sick, Wed nothing (→ OFF), Thu 10h, Fri confirmed zero, Sun 4h.
    { slice: slice('e1', 'Oleksandr Kryvoshlyk', '1001', A, 'wa-1', '2026-10-05', week('2026-10-05', [480, { date: '', dayType: 'SICK_LEAVE' }, 0, 600, { date: '', confirmedZero: true }, 0, 240])), siteName: 'Meyer Turku', workAreaName: 'Siris Finland Oy' },
    // Second worker starts on Wednesday 07.10 → Mon/Tue stay empty, not OFF; draft week.
    { slice: slice('e2', 'Serhii Halanov', '1002', A, null, '2026-10-05', week('2026-10-05', [0, 0, 600, 600, 0, 0, 0]), false), siteName: 'Meyer Turku', workAreaName: null },
    // Same worker e2 also has hours for another customer on Thursday (split day).
    { slice: slice('e2', 'Serhii Halanov', '1002', 'site-b', 'wa-2', '2026-10-05', week('2026-10-05', [0, 0, 0, 120, 0, 0, 0])), siteName: 'Vega', workAreaName: 'Vega Plius' },
    // Week 12.10 – 18.10 in the future relative to "today" 14.10: no OFF after today.
    { slice: slice('e1', 'Oleksandr Kryvoshlyk', '1001', A, 'wa-1', '2026-10-12', week('2026-10-12', [600, 600, 0, 0, 0, 0, 0])), siteName: 'Meyer Turku', workAreaName: 'Siris Finland Oy' }
  ];
  const m = buildMonthlyMatrix('2026-10', inputs, '2026-10-14', names);
  check(m.rows.length === 3, 'one row per worker per customer');
  const r1 = m.rows.find((r) => r.employeeId === 'e1')!;
  check(r1.lastName === 'Kryvoshlyk' && r1.firstName === 'Oleksandr' && r1.employeeNumber === '1001' && r1.customerName === 'Siris Finland Oy · Meyer Turku', 'row identity columns');
  const c = (row: typeof r1, day: number) => row.cells[day - 1];
  check(c(r1, 1).kind === 'WORK' && c(r1, 1).workedMinutes === 600 && c(r1, 2).workedMinutes === 600, 'October days of a week starting in September are kept');
  check(c(r1, 3).kind === 'WORK' && c(r1, 3).workedMinutes === 240, 'Saturday work is shown');
  check(c(r1, 4).kind === 'WEEKEND', 'Sunday without hours is weekend');
  check(c(r1, 5).workedMinutes === 480 && c(r1, 6).kind === 'OFF' && c(r1, 6).dayType === 'SICK_LEAVE', 'sick leave is OFF with its reason');
  check(c(r1, 7).kind === 'OFF' && c(r1, 7).dayType === null, 'weekday without hours inside an active week is OFF');
  check(c(r1, 9).kind === 'OFF', 'confirmed zero is OFF');
  check(c(r1, 10).kind === 'WEEKEND' && c(r1, 11).kind === 'WORK', 'weekend; Sunday work');
  check(c(r1, 13).workedMinutes === 600 && c(r1, 14).kind === 'EMPTY', 'today without hours is not OFF yet (shift may be open)');
  check(c(r1, 15).kind === 'EMPTY' && c(r1, 16).kind === 'EMPTY', 'future weekdays are never OFF');
  check(c(r1, 20).kind === 'EMPTY', 'weeks without a slice stay empty');
  check(r1.totalMinutes === 600 * 2 + 240 + 480 + 600 + 240 + 600 * 2, 'row total = sum of October cells only');

  const r2 = m.rows.find((r) => r.employeeId === 'e2' && r.customerKey === customerKeyOf(A, null))!;
  check(c(r2, 5).kind === 'EMPTY' && c(r2, 6).kind === 'EMPTY', 'days before the first worked day are not OFF');
  check(c(r2, 7).kind === 'WORK' && c(r2, 7).draft, 'draft week flagged');
  check(c(r2, 9).kind === 'OFF', 'Friday after starting is OFF');
  const r3 = m.rows.find((r) => r.customerKey === customerKeyOf('site-b', 'wa-2'))!;
  check(c(r3, 8).workedMinutes === 120 && c(r2, 8).workedMinutes === 600, 'split day stays under each customer');
  check(c(r3, 6).kind === 'EMPTY' && c(r3, 9).kind === 'OFF', 'second-customer row starts at its own first worked day');

  check(m.dayTotals[7] === 1320 && m.dayTotals[0] === 600, 'per-day sums across rows');
  check(m.totalMinutes === m.rows.reduce((s, r) => s + r.totalMinutes, 0), 'grand total');
  check(m.customers.length === 3, 'customer options from all data');

  const filtered = buildMonthlyMatrix('2026-10', inputs, '2026-10-14', names, customerKeyOf('site-b', 'wa-2'));
  check(filtered.rows.length === 1 && filtered.totalMinutes === 120 && filtered.customers.length === 3, 'customer filter keeps the option list');

  const attached = buildMonthlyMatrix('2026-10', inputs, '2026-10-14', names, customerKeyOf(A, 'wa-1'), [
    { employeeId: 'e9', firstName: 'Vadym', lastName: 'Alpatov', employeeNumber: '1020', customerKey: customerKeyOf(A, 'wa-1'), customerName: 'Siris Finland Oy · Meyer Turku' },
    { employeeId: 'e1', firstName: 'Oleksandr', lastName: 'Kryvoshlyk', employeeNumber: '1001', customerKey: customerKeyOf(A, 'wa-1'), customerName: 'Siris Finland Oy · Meyer Turku' },
    { employeeId: 'e8', firstName: 'X', lastName: 'Other', employeeNumber: '1030', customerKey: customerKeyOf('site-b', 'wa-2'), customerName: 'Vega' }
  ]);
  check(attached.rows.length === 2 && attached.rows[0].lastName === 'Alpatov' && attached.rows[0].totalMinutes === 0, 'attached worker without hours gets an empty row; other customers filtered out');
  check(attached.rows[0].cells.every((cell) => cell.kind !== 'OFF' && cell.kind !== 'WORK'), 'attached worker without any hours is never marked OFF');
  check(attached.rows[1].totalMinutes === r1.totalMinutes, 'attached worker with hours is not duplicated');

  const holiday = buildMonthlyMatrix('2026-12', [{ slice: slice('e1', 'A B', '1', A, null, '2026-12-21', week('2026-12-21', [600, 600, 600, { date: '', dayType: 'PUBLIC_HOLIDAY' }, { date: '', dayType: 'PUBLIC_HOLIDAY' }, { date: '', dayType: 'VACATION' }, 0])), siteName: 'S', workAreaName: null }], '2026-12-31');
  const h = holiday.rows[0];
  check(h.cells[23].kind === 'WEEKEND' && h.cells[23].dayType === 'PUBLIC_HOLIDAY', 'public holiday is blue like a weekend');
  check(h.cells[25].kind === 'WEEKEND', 'vacation on a Saturday stays a weekend cell');

  console.log(`monthly matrix unit: ${passed}/${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
