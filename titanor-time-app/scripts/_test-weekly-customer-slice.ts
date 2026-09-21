// UT1 (Titanor Time — единый табель и подтверждение часов по заказчику, UT0/UT0-R1/UT0-R2
// checkpoints) — buildWeeklyCustomerSlices / computeSliceFingerprint / helsinkiWeekBounds /
// enumerateHelsinkiWeeks. Pure, no DB, no network.
import {
  buildWeeklyCustomerSlices,
  computeSliceFingerprint,
  enumerateHelsinkiWeeks,
  helsinkiWeekBounds,
  WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE,
  type BuildSlicesInput,
  type CanonicalSlicePayload,
  type RawDay,
  type RawSegment
} from '../lib/reporting/weekly-customer-slice';
import { computeDayWorkedMs, msToMinutes } from '../lib/reporting/worked-time';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x !== undefined ? JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600) : '');
  }
};

let segCounter = 0;
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function mkSeg(dateIso: string, startH: number, startM: number, endH: number, endM: number, siteId: string, workAreaId: string | null, breaks: { sH: number; sM: number; eH: number; eM: number; paid: boolean }[] = [], id?: string): RawSegment {
  return {
    id: id ?? `seg-${segCounter++}`,
    startAt: new Date(`${dateIso}T${pad(startH)}:${pad(startM)}:00.000Z`),
    endAt: new Date(`${dateIso}T${pad(endH)}:${pad(endM)}:00.000Z`),
    siteId,
    workAreaId,
    breaks: breaks.map((b) => ({
      startAt: new Date(`${dateIso}T${pad(b.sH)}:${pad(b.sM)}:00.000Z`),
      endAt: new Date(`${dateIso}T${pad(b.eH)}:${pad(b.eM)}:00.000Z`),
      paid: b.paid
    }))
  };
}
function mkDay(dateIso: string, segments: RawSegment[], dayType = 'WORK', confirmedZero = false): RawDay {
  return { date: new Date(`${dateIso}T00:00:00.000Z`), dayType, confirmedZero, segments };
}
function addOneDay(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function build(days: RawDay[], overrides: Partial<BuildSlicesInput> = {}) {
  return buildWeeklyCustomerSlices({
    employeeId: 'emp-1',
    timesheetId: 'ts-1',
    sourceId: 'ver-1',
    days,
    plannedUnpaidBreakBySourceAndDate: new Map(),
    autoBreakThresholdMinutes: 360,
    ...overrides
  });
}

const S1 = '11111111-1111-1111-1111-111111111111';
const WA_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WA_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WA_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------------------------
// 1. Helsinki Monday–Sunday week boundaries, including both 2026 EU DST transition weeks.
// ---------------------------------------------------------------------------------------------
{
  const plain = helsinkiWeekBounds(new Date('2026-09-24T00:00:00.000Z')); // Thursday
  check('plain Thursday -> Mon 09-21 .. Sun 09-27', plain.weekStart === '2026-09-21' && plain.weekEnd === '2026-09-27', plain);

  // EU spring-forward: last Sunday of March 2026 = 2026-03-29.
  const spring = helsinkiWeekBounds(new Date('2026-03-29T00:00:00.000Z'));
  check('DST spring week -> Mon 03-23 .. Sun 03-29', spring.weekStart === '2026-03-23' && spring.weekEnd === '2026-03-29', spring);

  // EU fall-back: last Sunday of October 2026 = 2026-10-25.
  const autumn = helsinkiWeekBounds(new Date('2026-10-25T00:00:00.000Z'));
  check('DST autumn week -> Mon 10-19 .. Sun 10-25', autumn.weekStart === '2026-10-19' && autumn.weekEnd === '2026-10-25', autumn);

  const mondayItself = helsinkiWeekBounds(new Date('2026-09-21T00:00:00.000Z'));
  check('Monday itself is its own weekStart', mondayItself.weekStart === '2026-09-21' && mondayItself.weekEnd === '2026-09-27', mondayItself);
}

// ---------------------------------------------------------------------------------------------
// 2. enumerateHelsinkiWeeks — 1/2/3/4-week ranges give 1/2/3/4 weeks (7/14/21/28 days).
// ---------------------------------------------------------------------------------------------
{
  const w1 = enumerateHelsinkiWeeks('2026-09-21', '2026-09-27');
  check('1 week -> 1 entry, 7 days', w1.length === 1 && w1[0].weekStart === '2026-09-21' && w1[0].weekEnd === '2026-09-27', w1);

  const w2 = enumerateHelsinkiWeeks('2026-09-14', '2026-09-27');
  check('2 weeks -> 2 entries', w2.length === 2 && w2[0].weekStart === '2026-09-14' && w2[1].weekEnd === '2026-09-27', w2);

  const w3 = enumerateHelsinkiWeeks('2026-09-07', '2026-09-27');
  check('3 weeks -> 3 entries', w3.length === 3 && w3[0].weekStart === '2026-09-07' && w3[2].weekEnd === '2026-09-27', w3);

  const w4 = enumerateHelsinkiWeeks('2026-08-31', '2026-09-27');
  check('4 weeks -> 4 entries, 28 days total', w4.length === 4 && w4[0].weekStart === '2026-08-31' && w4[3].weekEnd === '2026-09-27', w4);
}

// ---------------------------------------------------------------------------------------------
// 3. Cross-worker independence of the `${sourceId}:${date}` auto-break lookup (the regression the
//    admin-timesheets.ts fix and this builder both depend on) — one SHARED map, two different
//    sourceId workers on the SAME calendar date, must not leak into each other.
// ---------------------------------------------------------------------------------------------
{
  const sharedMap = new Map<string, number>([
    ['ver-A:2026-09-21', 0], // worker A: lunch paid, no deduction
    ['ver-B:2026-09-21', 30] // worker B: 30-min unpaid lunch
  ]);
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 16, 0, S1, WA_A)]); // 9h gross, no logged break

  const slicesA = build([day], { sourceId: 'ver-A', plannedUnpaidBreakBySourceAndDate: sharedMap });
  const slicesB = build([day], { sourceId: 'ver-B', plannedUnpaidBreakBySourceAndDate: sharedMap });
  check('worker A (paid lunch) keeps full 9h = 540 min', slicesA[0].workedMinutes === 540, slicesA);
  check('worker B (30-min unpaid) gets 510 min, unaffected by A sharing the same map', slicesB[0].workedMinutes === 510, slicesB);
}

// ---------------------------------------------------------------------------------------------
// 4. Several intervals of one day, same customer -> summed correctly, both segments present.
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A), mkSeg('2026-09-21', 12, 0, 17, 0, S1, WA_A)]);
  const slices = build([day]);
  check('one slice for the one (site,workArea)', slices.length === 1, slices.length);
  check('4h+5h = 9h = 540 min, no plan -> no deduction', slices[0].workedMinutes === 540, slices[0]);
  check('canonical day has both segments', slices[0].payload.days[0].segments.length === 2, slices[0].payload.days[0]);
}

// ---------------------------------------------------------------------------------------------
// 5. Paid break stays inside worked time; unpaid break is subtracted.
// ---------------------------------------------------------------------------------------------
{
  const paidDay = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 16, 0, S1, WA_A, [{ sH: 12, sM: 0, eH: 12, eM: 30, paid: true }])]);
  const paidSlices = build([paidDay]);
  check('paid 30-min break not subtracted -> 9h = 540 min', paidSlices[0].workedMinutes === 540, paidSlices[0]);

  const unpaidDay = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 16, 0, S1, WA_A, [{ sH: 12, sM: 0, eH: 12, eM: 30, paid: false }])]);
  const unpaidSlices = build([unpaidDay]);
  check('unpaid 30-min break subtracted -> 8h30 = 510 min', unpaidSlices[0].workedMinutes === 510, unpaidSlices[0]);
}

// ---------------------------------------------------------------------------------------------
// 6 / 18. Single-customer day — the automatic break is applied once, entirely to that one group
//         (regression for the existing computeDayWorkedMs rule; no allocation needed).
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 15, 30, S1, WA_A)]); // 8.5h gross
  const map = new Map([['ver-1:2026-09-21', 30]]);
  const slices = build([day], { plannedUnpaidBreakBySourceAndDate: map });
  check('single customer day: 8.5h - 30min = 480 min', slices[0].workedMinutes === 480, slices[0]);
  check('  autoUnpaidBreakMinutes on that one day = 30 (whole amount, one group)', slices[0].payload.days[0].autoUnpaidBreakMinutes === 30, slices[0].payload.days[0]);
}

// ---------------------------------------------------------------------------------------------
// 7. Identical canonical content -> identical fingerprint, independent of input array order.
// ---------------------------------------------------------------------------------------------
{
  const s1 = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [], 'id-x');
  const s2 = mkSeg('2026-09-21', 12, 0, 16, 0, S1, WA_A, [], 'id-y');
  const day = mkDay('2026-09-21', [s1, s2]);
  const dayReversed = mkDay('2026-09-21', [s2, s1]);
  const a = build([day]);
  const b = build([dayReversed]);
  check('same content, reversed segment input order -> identical fingerprint', a[0].fingerprint === b[0].fingerprint, { a: a[0].fingerprint, b: b[0].fingerprint });
}

// ---------------------------------------------------------------------------------------------
// 8. Changing start/end/break-paid/dayType/workAreaId/siteId each changes the fingerprint.
// ---------------------------------------------------------------------------------------------
{
  const basePayload: CanonicalSlicePayload = {
    schemaVersion: 1,
    employeeId: 'emp-1',
    siteId: S1,
    workAreaId: WA_A,
    weekStart: '2026-09-21',
    weekEnd: '2026-09-27',
    days: [
      {
        date: '2026-09-21',
        dayType: 'WORK',
        confirmedZero: false,
        autoUnpaidBreakMinutes: 0,
        segments: [{ startAt: '2026-09-21T07:00:00.000Z', endAt: '2026-09-21T16:00:00.000Z', breaks: [{ startAt: '2026-09-21T12:00:00.000Z', endAt: '2026-09-21T12:30:00.000Z', paid: false }] }]
      }
    ]
  };
  const baseFp = computeSliceFingerprint(basePayload);

  const changedStart = { ...basePayload, days: [{ ...basePayload.days[0], segments: [{ ...basePayload.days[0].segments[0], startAt: '2026-09-21T07:01:00.000Z' }] }] };
  check('changed startAt -> different fingerprint', computeSliceFingerprint(changedStart) !== baseFp);

  const changedEnd = { ...basePayload, days: [{ ...basePayload.days[0], segments: [{ ...basePayload.days[0].segments[0], endAt: '2026-09-21T16:01:00.000Z' }] }] };
  check('changed endAt -> different fingerprint', computeSliceFingerprint(changedEnd) !== baseFp);

  const changedPaid = { ...basePayload, days: [{ ...basePayload.days[0], segments: [{ ...basePayload.days[0].segments[0], breaks: [{ ...basePayload.days[0].segments[0].breaks[0], paid: true }] }] }] };
  check('changed break paid flag -> different fingerprint', computeSliceFingerprint(changedPaid) !== baseFp);

  const changedBreakStart = { ...basePayload, days: [{ ...basePayload.days[0], segments: [{ ...basePayload.days[0].segments[0], breaks: [{ ...basePayload.days[0].segments[0].breaks[0], startAt: '2026-09-21T12:05:00.000Z' }] }] }] };
  check('changed break startAt -> different fingerprint', computeSliceFingerprint(changedBreakStart) !== baseFp);

  const changedBreakEnd = { ...basePayload, days: [{ ...basePayload.days[0], segments: [{ ...basePayload.days[0].segments[0], breaks: [{ ...basePayload.days[0].segments[0].breaks[0], endAt: '2026-09-21T12:35:00.000Z' }] }] }] };
  check('changed break endAt -> different fingerprint', computeSliceFingerprint(changedBreakEnd) !== baseFp);

  const changedDayType = { ...basePayload, days: [{ ...basePayload.days[0], dayType: 'SICK_LEAVE' }] };
  check('changed dayType -> different fingerprint', computeSliceFingerprint(changedDayType) !== baseFp);

  const changedConfirmedZero = { ...basePayload, days: [{ ...basePayload.days[0], confirmedZero: true }] };
  check('changed confirmedZero -> different fingerprint', computeSliceFingerprint(changedConfirmedZero) !== baseFp);

  const changedWorkArea = { ...basePayload, workAreaId: WA_B };
  check('changed workAreaId -> different fingerprint', computeSliceFingerprint(changedWorkArea) !== baseFp);

  const changedSite = { ...basePayload, siteId: WA_C }; // any different uuid stands in for a different site here
  check('changed siteId -> different fingerprint', computeSliceFingerprint(changedSite) !== baseFp);

  const changedAutoBreak = { ...basePayload, days: [{ ...basePayload.days[0], autoUnpaidBreakMinutes: 15 }] };
  check('changed autoUnpaidBreakMinutes -> different fingerprint', computeSliceFingerprint(changedAutoBreak) !== baseFp);
}

// ---------------------------------------------------------------------------------------------
// 9. Renaming a customer/site/employee cannot change the fingerprint — structurally guaranteed:
//    RawSegment/RawDay/BuildSlicesInput carry no display-name field at all, so the builder has
//    nothing to rename. Demonstrated by two builder calls over exactly the same ids/times.
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 15, 0, S1, WA_A, [], 'id-rename')]);
  const a = build([day]);
  const b = build([day]);
  check('same ids/times (no name input exists to rename) -> identical fingerprint', a[0].fingerprint === b[0].fingerprint);
}

// ---------------------------------------------------------------------------------------------
// 10. Two different (siteId, workAreaId) pairs on different days of the same week -> two
//     independent slices, each carrying only its own day.
// ---------------------------------------------------------------------------------------------
{
  const mon = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A)]); // Mon, customer A, 4h
  const wed = mkDay('2026-09-23', [mkSeg('2026-09-23', 7, 0, 10, 0, S1, WA_B)]); // Wed, customer B, 3h
  const slices = build([mon, wed]);
  check('two customer slices produced', slices.length === 2, slices.map((s) => s.logicalKey));
  const sliceA = slices.find((s) => s.logicalKey.workAreaId === WA_A)!;
  const sliceB = slices.find((s) => s.logicalKey.workAreaId === WA_B)!;
  check('customer A slice has only Monday', sliceA.payload.days.length === 1 && sliceA.payload.days[0].date === '2026-09-21', sliceA.payload.days);
  check('customer B slice has only Wednesday', sliceB.payload.days.length === 1 && sliceB.payload.days[0].date === '2026-09-23', sliceB.payload.days);
  check('customer A worked minutes = 240', sliceA.workedMinutes === 240);
  check('customer B worked minutes = 180', sliceB.workedMinutes === 180);
}

// ---------------------------------------------------------------------------------------------
// 11. A non-work day (no segments at all) in the middle of a work week is absent from every
//     customer slice's days[] — it stays exclusively in the existing NON_SITE review scope
//     territory (UT0-R2 §2/§5), never duplicated into a customer fingerprint.
// ---------------------------------------------------------------------------------------------
{
  const mon = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 15, 0, S1, WA_A)]);
  const tue = mkDay('2026-09-22', [], 'SICK_LEAVE', false);
  const wed = mkDay('2026-09-23', [mkSeg('2026-09-23', 7, 0, 15, 0, S1, WA_A)]);
  const slices = build([mon, tue, wed]);
  check('one slice only (same customer both work days)', slices.length === 1, slices.length);
  check('canonical days length is 2, not 3 — SICK_LEAVE day excluded', slices[0].payload.days.length === 2, slices[0].payload.days.map((d) => d.date));
  check('present dates are exactly Mon and Wed', slices[0].payload.days.map((d) => d.date).join(',') === '2026-09-21,2026-09-23', slices[0].payload.days);
}

// ---------------------------------------------------------------------------------------------
// 12. Tie-break by segment id (last resort only) — two segments sharing identical startAt/endAt
//     always end up in the same canonical order (ascending id), regardless of input order, and
//     the id itself never appears in — nor affects — the fingerprint.
// ---------------------------------------------------------------------------------------------
{
  const sB = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [], 'id-b');
  const sA = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [], 'id-a'); // identical times, different id
  const orderBA = build([mkDay('2026-09-21', [sB, sA])]);
  const orderAB = build([mkDay('2026-09-21', [sA, sB])]);
  check('tie-broken order identical regardless of input order', orderBA[0].fingerprint === orderAB[0].fingerprint, { ba: orderBA[0].fingerprint, ab: orderAB[0].fingerprint });
}

// ---------------------------------------------------------------------------------------------
// 13. Auto-break allocation, main required scenario: one day, two customers, 4h + 4h, a single
//     30-minute auto-deduction -> split 15 + 15 (not 420-total / not 480-total).
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A), mkSeg('2026-09-21', 12, 0, 16, 0, S1, WA_B)]);
  const map = new Map([['ver-1:2026-09-21', 30]]);
  const slices = build([day], { plannedUnpaidBreakBySourceAndDate: map });
  const a = slices.find((s) => s.logicalKey.workAreaId === WA_A)!;
  const b = slices.find((s) => s.logicalKey.workAreaId === WA_B)!;
  check('customer A gets 15 of the 30 min auto break', a.payload.days[0].autoUnpaidBreakMinutes === 15, a.payload.days[0]);
  check('customer B gets 15 of the 30 min auto break', b.payload.days[0].autoUnpaidBreakMinutes === 15, b.payload.days[0]);
  check('customer A worked minutes = 225 (4h - 15min)', a.workedMinutes === 225, a);
  check('customer B worked minutes = 225 (4h - 15min)', b.workedMinutes === 225, b);
  check('combined total is 450, not 420 and not 480', a.workedMinutes + b.workedMinutes === 450, a.workedMinutes + b.workedMinutes);
}

// ---------------------------------------------------------------------------------------------
// 14. Uneven distribution: 4h / 3h / 1h, 25-minute auto break -> 13 / 9 / 3 (largest remainder).
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [
    mkSeg('2026-09-21', 6, 0, 10, 0, S1, WA_A), // 4h
    mkSeg('2026-09-21', 10, 0, 13, 0, S1, WA_B), // 3h
    mkSeg('2026-09-21', 13, 0, 14, 0, S1, WA_C) // 1h
  ]);
  const map = new Map([['ver-1:2026-09-21', 25]]);
  const slices = build([day], { plannedUnpaidBreakBySourceAndDate: map, autoBreakThresholdMinutes: 0 });
  const a = slices.find((s) => s.logicalKey.workAreaId === WA_A)!;
  const b = slices.find((s) => s.logicalKey.workAreaId === WA_B)!;
  const c = slices.find((s) => s.logicalKey.workAreaId === WA_C)!;
  check('4h group gets 13 min', a.payload.days[0].autoUnpaidBreakMinutes === 13, a.payload.days[0]);
  check('3h group gets 9 min', b.payload.days[0].autoUnpaidBreakMinutes === 9, b.payload.days[0]);
  check('1h group gets 3 min', c.payload.days[0].autoUnpaidBreakMinutes === 3, c.payload.days[0]);
  check('allocation sums to exactly 25', a.payload.days[0].autoUnpaidBreakMinutes + b.payload.days[0].autoUnpaidBreakMinutes + c.payload.days[0].autoUnpaidBreakMinutes === 25);
}

// ---------------------------------------------------------------------------------------------
// 15. Stable tie-break when remainders are exactly equal — deterministic by canonical
//     (siteId, workAreaId) key ascending, independent of segment input order.
// ---------------------------------------------------------------------------------------------
{
  const segs = [mkSeg('2026-09-21', 6, 0, 10, 0, S1, WA_A), mkSeg('2026-09-21', 10, 0, 14, 0, S1, WA_B)]; // equal 4h + 4h
  const map = new Map([['ver-1:2026-09-21', 31]]); // odd -> forces a 0.5/0.5 remainder tie
  const forward = build([mkDay('2026-09-21', segs)], { plannedUnpaidBreakBySourceAndDate: map });
  const backward = build([mkDay('2026-09-21', [...segs].reverse())], { plannedUnpaidBreakBySourceAndDate: map });
  const fA = forward.find((s) => s.logicalKey.workAreaId === WA_A)!;
  const fB = forward.find((s) => s.logicalKey.workAreaId === WA_B)!;
  check('tie -> lower canonical key (A) wins the extra minute: 16', fA.payload.days[0].autoUnpaidBreakMinutes === 16, fA.payload.days[0]);
  check('tie -> higher canonical key (B) gets 15', fB.payload.days[0].autoUnpaidBreakMinutes === 15, fB.payload.days[0]);
  const bA = backward.find((s) => s.logicalKey.workAreaId === WA_A)!;
  check('reversed segment input order gives the identical result', bA.payload.days[0].autoUnpaidBreakMinutes === fA.payload.days[0].autoUnpaidBreakMinutes);
}

// ---------------------------------------------------------------------------------------------
// 16. Tie-break involving "Без заказчика" (workAreaId = null) — the empty-string representation
//     sorts before any real UUID, so the null-workArea group wins a tied remainder deterministically.
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 6, 0, 8, 0, S1, null), mkSeg('2026-09-21', 8, 0, 10, 0, S1, WA_C)]); // equal 2h + 2h
  const map = new Map([['ver-1:2026-09-21', 1]]); // one minute, forced tie
  const slices = build([day], { plannedUnpaidBreakBySourceAndDate: map, autoBreakThresholdMinutes: 0 });
  const noCustomer = slices.find((s) => s.logicalKey.workAreaId === null)!;
  const withCustomer = slices.find((s) => s.logicalKey.workAreaId === WA_C)!;
  check('"Без заказчика" (null) wins the single tied minute', noCustomer.payload.days[0].autoUnpaidBreakMinutes === 1, noCustomer.payload.days[0]);
  check('the other customer gets 0', withCustomer.payload.days[0].autoUnpaidBreakMinutes === 0, withCustomer.payload.days[0]);
}

// ---------------------------------------------------------------------------------------------
// 17. Double-rounding edge case: the day-level auto-break total (itself already rounded once) can
//     exceed the sum of every group's individually-rounded cap when segments are not minute-aligned
//     — a pure rounding artifact, only reachable with sub-minute timestamps (verified beforehand by
//     a 300k-case randomized search — see the allocator's own doc comment). UT1-fixup: an earlier
//     version of this test accepted the resulting overflow as valid ("one group absorbs the
//     artifact"), which is exactly what let a negative workedMinutes slip through
//     (grossMinutes=32, breakMinutes=33 -> workedMinutes=-1). The correct, current behavior is a
//     loud, named invariant failure instead of a fabricated number — this test now asserts that.
// ---------------------------------------------------------------------------------------------
{
  const base = Date.parse('2026-09-21T06:00:00.000Z');
  const WA_D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const grossMs: Record<string, number> = { [WA_A]: 737222, [WA_B]: 1469498, [WA_C]: 1938917, [WA_D]: 842584 };
  let cursor = base;
  const segs: RawSegment[] = [];
  for (const [wa, ms] of Object.entries(grossMs)) {
    segs.push({ id: `dr-${wa}`, startAt: new Date(cursor), endAt: new Date(cursor + ms), siteId: S1, workAreaId: wa, breaks: [] });
    cursor += ms; // segments stay non-overlapping; irrelevant to the calculation either way
  }
  const map = new Map([['ver-1:2026-09-21', 200]]); // planned unpaid break far exceeds gross -> capped at gross by computeDayWorkedMs itself
  const day = mkDay('2026-09-21', segs);

  const dayLevel = computeDayWorkedMs(
    segs.map((s) => ({ startAt: s.startAt, endAt: s.endAt, breaks: [] })),
    { plannedUnpaidBreakMinutes: 200, grossThresholdMinutes: 0 }
  );
  check('sanity: whole-day auto minutes = 83 (round(4,988,221 / 60000)) — the value that cannot be distributed without exceeding a cap', msToMinutes(dayLevel.autoUnpaidBreakMs) === 83, msToMinutes(dayLevel.autoUnpaidBreakMs));

  let thrown: unknown = null;
  try {
    build([day], { plannedUnpaidBreakBySourceAndDate: map, autoBreakThresholdMinutes: 0 });
  } catch (e) {
    thrown = e;
  }
  check('unreconcilable double-rounding case throws, does not return a result', thrown instanceof Error, thrown);
  check(
    'thrown error names the invariant-failure identifier',
    thrown instanceof Error && thrown.message.startsWith(WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE),
    thrown instanceof Error ? thrown.message : thrown
  );
}

// ---------------------------------------------------------------------------------------------
// 19. Additivity at the day level (minute-aligned timestamps): the sum of workedMinutes of every
//     slice touching a day equals the single whole-day computeDayWorkedMs result for that day.
// ---------------------------------------------------------------------------------------------
{
  const day = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A), mkSeg('2026-09-21', 12, 0, 16, 0, S1, WA_B)]);
  const map = new Map([['ver-1:2026-09-21', 30]]);
  const slices = build([day], { plannedUnpaidBreakBySourceAndDate: map });
  const sumSlices = slices.reduce((sum, s) => sum + s.workedMinutes, 0);
  const whole = computeDayWorkedMs(day.segments.map((s) => ({ startAt: s.startAt, endAt: s.endAt, breaks: s.breaks })), { plannedUnpaidBreakMinutes: 30, grossThresholdMinutes: 360 });
  check('sum of per-customer workedMinutes equals the single whole-day calculation', sumSlices === msToMinutes(whole.workedMs), { sumSlices, whole: msToMinutes(whole.workedMs) });
}

// ---------------------------------------------------------------------------------------------
// 20. Canonical payload length is 1..7, never padded to a fixed 7 — direct check of UT0-R2 §2.
// ---------------------------------------------------------------------------------------------
{
  const mon = mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 15, 0, S1, WA_A)]);
  const slices = build([mon]);
  check('one worked day in the week -> canonical days length 1, not 7', slices[0].payload.days.length === 1, slices[0].payload.days.length);
}

// ---------------------------------------------------------------------------------------------
// 21. enumerateHelsinkiWeeks beyond the 1-4 week UI range — the pure calendar-arithmetic function
//     itself has no upper bound baked in.
// ---------------------------------------------------------------------------------------------
{
  const w6 = enumerateHelsinkiWeeks('2026-08-17', '2026-09-27'); // Mon..Sun, 6 whole weeks
  check('6 weeks -> 6 entries, correct outer bounds', w6.length === 6 && w6[0].weekStart === '2026-08-17' && w6[5].weekEnd === '2026-09-27', w6);
  check('6 weeks are contiguous (each weekStart is the previous weekEnd + 1 day)', w6.every((w, i) => i === 0 || w.weekStart === addOneDay(w6[i - 1].weekEnd)), w6);
}

// ---------------------------------------------------------------------------------------------
// 22. A cross-midnight segment stays whole inside the RawDay it was placed in — the builder never
//     re-derives or splits it by its own startAt/endAt; both timestamps pass through unchanged.
// ---------------------------------------------------------------------------------------------
{
  const seg: RawSegment = {
    id: 'night-shift',
    startAt: new Date('2026-09-21T23:00:00.000Z'),
    endAt: new Date('2026-09-22T01:00:00.000Z'), // crosses into the next calendar day
    siteId: S1,
    workAreaId: WA_A,
    breaks: []
  };
  const slices = build([mkDay('2026-09-21', [seg])]); // attached to the 21st, as the caller decided
  check('exactly one slice, one canonical day (the 21st, not split into a second day)', slices.length === 1 && slices[0].payload.days.length === 1, slices[0]?.payload.days);
  check('canonical day is 2026-09-21', slices[0].payload.days[0].date === '2026-09-21', slices[0].payload.days[0]);
  check('the segment keeps its original startAt (23:00 on the 21st)', slices[0].payload.days[0].segments[0].startAt === '2026-09-21T23:00:00.000Z', slices[0].payload.days[0].segments[0]);
  check('the segment keeps its original endAt (01:00 on the 22nd) — not truncated at midnight', slices[0].payload.days[0].segments[0].endAt === '2026-09-22T01:00:00.000Z', slices[0].payload.days[0].segments[0]);
  check('2h cross-midnight segment -> 120 worked minutes, not split/halved', slices[0].workedMinutes === 120, slices[0].workedMinutes);
}

// ---------------------------------------------------------------------------------------------
// 23. Fingerprint stability across a simulated resubmit: two segments share the exact same
//     startAt/endAt but carry different break facts. A resubmit rebuilds both segments under fresh
//     UUIDs (here deliberately chosen so a naive id-first sort would REVERSE their order) and the
//     draft/version freeze code has no reason to preserve array order either — the fingerprint must
//     stay identical because canonical order is decided by break content first, id only last.
// ---------------------------------------------------------------------------------------------
{
  const early = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [{ sH: 8, sM: 0, eH: 8, eM: 10, paid: false }], 'id-1');
  const late = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [{ sH: 9, sM: 0, eH: 9, eM: 10, paid: false }], 'id-2');
  const original = build([mkDay('2026-09-21', [early, late])]);

  // "resubmit": identical time/break facts, brand-new ids chosen to flip alphabetical order
  // (zzz.. for the segment that must still sort FIRST by break content, aaa.. for the one that
  // must still sort SECOND), fed in reversed array order as a resubmit's freeze pass might.
  const earlyResubmitted = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [{ sH: 8, sM: 0, eH: 8, eM: 10, paid: false }], 'zzz-fresh-early');
  const lateResubmitted = mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A, [{ sH: 9, sM: 0, eH: 9, eM: 10, paid: false }], 'aaa-fresh-late');
  const resubmitted = build([mkDay('2026-09-21', [lateResubmitted, earlyResubmitted])]);

  check(
    'resubmit with fresh, order-reversing UUIDs does not change the fingerprint',
    original[0].fingerprint === resubmitted[0].fingerprint,
    { original: original[0].fingerprint, resubmitted: resubmitted[0].fingerprint }
  );
}

// ---------------------------------------------------------------------------------------------
// 24. Global invariant sweep across a diverse set of scenarios (single/multi-segment days, paid
//     and unpaid explicit breaks, multi-customer auto-break split, a non-work day in the mix):
//     every produced slice must have workedMinutes >= 0, breakMinutes >= 0, and
//     grossMinutes = workedMinutes + breakMinutes exactly (UT1-fixup §2/§4).
// ---------------------------------------------------------------------------------------------
{
  const scenarios = [
    ...build([mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 16, 0, S1, WA_A, [{ sH: 12, sM: 0, eH: 12, eM: 30, paid: false }])])]),
    ...build([mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 16, 0, S1, WA_A, [{ sH: 12, sM: 0, eH: 12, eM: 30, paid: true }])])]),
    ...build([mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 11, 0, S1, WA_A), mkSeg('2026-09-21', 12, 0, 16, 0, S1, WA_B)])], {
      plannedUnpaidBreakBySourceAndDate: new Map([['ver-1:2026-09-21', 30]])
    }),
    ...build(
      [mkDay('2026-09-21', [mkSeg('2026-09-21', 6, 0, 10, 0, S1, WA_A), mkSeg('2026-09-21', 10, 0, 13, 0, S1, WA_B), mkSeg('2026-09-21', 13, 0, 14, 0, S1, WA_C)])],
      { plannedUnpaidBreakBySourceAndDate: new Map([['ver-1:2026-09-21', 25]]), autoBreakThresholdMinutes: 0 }
    ),
    ...build([mkDay('2026-09-21', [mkSeg('2026-09-21', 7, 0, 15, 0, S1, WA_A)]), mkDay('2026-09-22', [], 'SICK_LEAVE'), mkDay('2026-09-23', [mkSeg('2026-09-23', 7, 0, 15, 0, S1, WA_A)])])
  ];
  check('the sweep collected at least 5 slices across scenarios', scenarios.length >= 5, scenarios.length);
  check(
    'every slice: workedMinutes >= 0',
    scenarios.every((s) => s.workedMinutes >= 0),
    scenarios.map((s) => s.workedMinutes)
  );
  check(
    'every slice: breakMinutes >= 0',
    scenarios.every((s) => s.breakMinutes >= 0),
    scenarios.map((s) => s.breakMinutes)
  );
  check(
    'every slice: grossMinutes = workedMinutes + breakMinutes',
    scenarios.every((s) => s.grossMinutes === s.workedMinutes + s.breakMinutes),
    scenarios.map((s) => ({ gross: s.grossMinutes, worked: s.workedMinutes, brk: s.breakMinutes }))
  );
}

console.log(JSON.stringify({ pass, fail }));
process.exit(fail > 0 ? 1 : 0);
