// T10-D (2026-08-28) — computeDayWorkedMs: the automatic unpaid-lunch deduction
// (docs/titanor-time/T10_DEF_PLAN.md §D). Pure, no DB.
import { computeDayWorkedMs, sumWorkedDayMs, msToMinutes } from '../lib/reporting/worked-time';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

function seg(startH: number, endH: number, breaks: { s: number; e: number; paid: boolean }[] = []) {
  const d = '2026-08-24';
  return {
    startAt: new Date(`${d}T${String(startH).padStart(2, '0')}:00:00Z`),
    endAt: new Date(`${d}T${String(endH).padStart(2, '0')}:00:00Z`),
    breaks: breaks.map((b) => ({ startAt: new Date(`${d}T${String(b.s).padStart(2, '0')}:00:00Z`), endAt: new Date(`${d}T${String(b.e).padStart(2, '0')}:00:00Z`), paid: b.paid }))
  };
}

// 1. Finnish case: 07:00–15:30 (8.5 h gross), no break logged, planned 30-min unpaid, 6 h threshold
{
  const s = { ...seg(7, 15), endAt: new Date('2026-08-24T15:30:00Z') };
  const r = computeDayWorkedMs([s], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  check('8.5h day, no break -> 8h worked', msToMinutes(r.workedMs) === 8 * 60, msToMinutes(r.workedMs));
  check('  autoUnpaidBreakMs = 30 min', msToMinutes(r.autoUnpaidBreakMs) === 30);
  check('  unpaidBreakMs = 30 min', msToMinutes(r.unpaidBreakMs) === 30);
  check('  grossMs unchanged (8.5h)', msToMinutes(r.grossMs) === 510);
}

// 2. Worker logged their own 45-min unpaid break -> no auto-deduction (no double deduct)
{
  const s = seg(7, 16, [{ s: 12, e: 12.75 as number, paid: false }]);
  // build a 45-min break manually
  s.breaks = [{ startAt: new Date('2026-08-24T12:00:00Z'), endAt: new Date('2026-08-24T12:45:00Z'), paid: false }];
  const r = computeDayWorkedMs([s], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  check('logged 45-min break -> that is used, no auto add', msToMinutes(r.unpaidBreakMs) === 45 && r.autoUnpaidBreakMs === 0, r);
  check('  9h gross - 45 min = 8h15', msToMinutes(r.workedMs) === 9 * 60 - 45);
}

// 3. Logged a PAID break -> still counts as "logged", no auto unpaid deduction
{
  const s = seg(7, 16);
  s.breaks = [{ startAt: new Date('2026-08-24T12:00:00Z'), endAt: new Date('2026-08-24T12:30:00Z'), paid: true }];
  const r = computeDayWorkedMs([s], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  check('logged a paid break -> no auto unpaid deduction', r.autoUnpaidBreakMs === 0 && msToMinutes(r.workedMs) === 9 * 60, r);
}

// 4. Short day under threshold -> no deduction
{
  const r = computeDayWorkedMs([seg(9, 14)], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  check('5h day (under 6h threshold) -> no auto deduction', r.autoUnpaidBreakMs === 0 && msToMinutes(r.workedMs) === 5 * 60);
}

// 5. threshold 0 = always deduct
{
  const r = computeDayWorkedMs([seg(9, 14)], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 0 });
  check('threshold 0 -> deduct even on a 5h day', msToMinutes(r.autoUnpaidBreakMs) === 30 && msToMinutes(r.workedMs) === 5 * 60 - 30);
}

// 6. plannedUnpaidBreakMinutes 0 (lunch paid / no plan) -> no deduction
{
  const s = { ...seg(7, 15), endAt: new Date('2026-08-24T15:30:00Z') };
  const r = computeDayWorkedMs([s], { plannedUnpaidBreakMinutes: 0, grossThresholdMinutes: 360 });
  check('planned unpaid break 0 -> no auto deduction (lunch paid)', r.autoUnpaidBreakMs === 0 && msToMinutes(r.workedMs) === 510);
}

// 7. never deduct more than gross
{
  const r = computeDayWorkedMs([seg(8, 15)], { plannedUnpaidBreakMinutes: 100000, grossThresholdMinutes: 0 });
  check('auto deduction capped at gross', r.workedMs === 0 && r.autoUnpaidBreakMs === r.grossMs);
}

// 8. two segments same day, split shift, total 9h, no break -> deduct once
{
  const a = seg(7, 11);
  const b = seg(12, 17);
  const r = computeDayWorkedMs([a, b], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  check('split day 4h+5h=9h gross, no break -> deduct 30 once', msToMinutes(r.autoUnpaidBreakMs) === 30 && msToMinutes(r.workedMs) === 9 * 60 - 30, r);
}

// 9. sumWorkedDayMs adds autoUnpaidBreakMs
{
  const d1 = computeDayWorkedMs([{ ...seg(7, 15), endAt: new Date('2026-08-24T15:30:00Z') }], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  const d2 = computeDayWorkedMs([{ ...seg(7, 15), endAt: new Date('2026-08-24T15:30:00Z') }], { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  const t = sumWorkedDayMs([d1, d2]);
  check('sumWorkedDayMs totals auto break (60 min over 2 days)', msToMinutes(t.autoUnpaidBreakMs) === 60 && msToMinutes(t.workedMs) === 16 * 60);
}

console.log(JSON.stringify({ pass, fail }));
process.exit(fail > 0 ? 1 : 0);
