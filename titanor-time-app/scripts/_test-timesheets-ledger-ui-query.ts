// UT4-B (Titanor Time — единый табель) — pure-function coverage for the new /admin/timesheets
// page's own URL/state helpers (lib/reporting/time-ledger-ui-query.ts), text/badge mapping
// (lib/reporting/ledger-ui-text.ts), and the feature flag (lib/timesheets-ledger-flag.ts). No
// database, no browser — the full rendered page is covered by scripts/_test-timesheets-ledger-browser.ts.

import {
  parseTimeLedgerUiState,
  uiStateToSearchParams,
  uiStateToApiQuery,
  uiStateToApiUrl,
  nextUiState,
  defaultTimeLedgerUiState,
  currentHelsinkiWeekRange,
  rangeForWeeksEndingAt,
  shiftRangeByOwnLength,
  weeksCountFromRange,
  activeFilterCount,
  type TimeLedgerUiState
} from '../lib/reporting/time-ledger-ui-query';
import { approvalStateLabel, approvalStateTone, submissionStateLabel, noCustomerGroupLabel, issueLabel, issueCountLabel } from '../lib/reporting/ledger-ui-text';
import { isTimesheetsLedgerUiEnabled } from '../lib/timesheets-ledger-flag';
import { formatWorkedDuration } from '../lib/reporting/report-format';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

function sp(pairs: Record<string, string>): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) usp.set(k, v);
  return usp;
}

// ---------------------------------------------------------------------------------------------
// Feature flag — on/off.
// ---------------------------------------------------------------------------------------------
{
  const original = process.env.TIMESHEETS_LEDGER_UI_ENABLED;
  delete process.env.TIMESHEETS_LEDGER_UI_ENABLED;
  check('flag: unset -> disabled', isTimesheetsLedgerUiEnabled() === false);
  process.env.TIMESHEETS_LEDGER_UI_ENABLED = '0';
  check('flag: "0" -> disabled (only "1" enables)', isTimesheetsLedgerUiEnabled() === false);
  process.env.TIMESHEETS_LEDGER_UI_ENABLED = 'true';
  check('flag: "true" -> disabled (only exact "1" enables)', isTimesheetsLedgerUiEnabled() === false);
  process.env.TIMESHEETS_LEDGER_UI_ENABLED = '1';
  check('flag: "1" -> enabled', isTimesheetsLedgerUiEnabled() === true);
  if (original === undefined) delete process.env.TIMESHEETS_LEDGER_UI_ENABLED;
  else process.env.TIMESHEETS_LEDGER_UI_ENABLED = original;
}

// ---------------------------------------------------------------------------------------------
// parseTimeLedgerUiState — URL -> state, and its inverse.
// ---------------------------------------------------------------------------------------------

const NOW = new Date('2026-09-24T10:00:00.000Z'); // a Thursday

{
  const r = parseTimeLedgerUiState(sp({}), NOW);
  check('parse: bare URL -> ok, defaults to the current Helsinki week', r.ok === true, r);
  if (r.ok) {
    check('parse: bare URL -> Monday start', r.state.startDate === currentHelsinkiWeekRange(NOW).startDate, r.state);
    check('parse: bare URL view defaults to table', r.state.view === 'table');
    check('parse: bare URL status defaults to all', r.state.status === 'all');
    check('parse: bare URL page defaults to 1', r.state.page === 1);
  }
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27' }), NOW);
  check('parse: explicit valid 1-week Mon-Sun range -> ok', r.ok === true, r);
}
// UT4-B-fixup #1 — a partial/misaligned range is no longer rejected: it is normalized to the full
// Helsinki week(s) it touches (startDate down to that week's Monday, endDate up to that week's
// Sunday). Only a genuinely invalid calendar date, or startDate > endDate, is still rejected.
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-22', endDate: '2026-09-28' }), NOW); // starts on a Tuesday, ends on a Monday
  check('parse: non-Monday startDate -> ok, normalized (not rejected)', r.ok === true, r);
  if (r.ok) {
    check('parse: normalized startDate is the Monday of the touched week (09-21)', r.state.startDate === '2026-09-21', r.state);
    check('parse: normalized endDate is the Sunday of the week containing 09-28 (that Monday\'s own week -> 10-04)', r.state.endDate === '2026-10-04', r.state);
  }
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-29' }), NOW); // 9-day span, not 7/14/21/28
  check('parse: span not exactly 1/2/3/4 weeks -> ok, normalized to the full weeks touched (not rejected)', r.ok === true, r);
  if (r.ok) {
    check('parse: normalized startDate stays 09-21 (already a Monday)', r.state.startDate === '2026-09-21', r.state);
    check('parse: normalized endDate extends to 10-04 (end of the week containing 09-29)', r.state.endDate === '2026-10-04', r.state);
    // This particular normalized span happens to land on a clean 2-week boundary, so it DOES light
    // up the "2 wk" quick button — a wider example below shows the "no button lights up" case.
    check('parse: this normalized span happens to be exactly 2 weeks -> lights up the "2 wk" button', weeksCountFromRange(r.state.startDate as string, r.state.endDate as string) === 2, r.state);
  }
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-11-02' }), NOW); // ~6.5 weeks, no exact button match
  check('parse: a wide explicit range -> ok, normalized (not rejected)', r.ok === true, r);
  if (r.ok) {
    check('parse: normalized wide range has no matching quick-range button (weeksCountFromRange -> null)', weeksCountFromRange(r.state.startDate as string, r.state.endDate as string) === null, r.state);
  }
}
{
  // A range that normalizes to EXACTLY a 1/2/3/4-week span still lights up the matching quick button.
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-23', endDate: '2026-09-25' }), NOW); // Wed-Fri, inside one Mon-Sun week
  check('parse: a partial mid-week range -> ok, normalized to that one full week', r.ok === true, r);
  if (r.ok) {
    check('parse: normalizes to 09-21..09-27, a clean 1-week span', r.state.startDate === '2026-09-21' && r.state.endDate === '2026-09-27', r.state);
    check('parse: normalized 1-week span DOES light up the "1 wk" quick button', weeksCountFromRange(r.state.startDate as string, r.state.endDate as string) === 1, r.state);
  }
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21' }), NOW); // only one of the pair
  check('parse: only startDate present (endDate missing) -> rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-02-30', endDate: '2026-03-08' }), NOW);
  check('parse: startDate is not a real calendar date -> still rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-28', endDate: '2026-09-21' }), NOW); // startDate after endDate
  check('parse: startDate > endDate -> rejected', r.ok === false, r);
}
{
  // UT4-B-fixup #5 — a repeated supported parameter is rejected exactly like the HTTP API parser.
  const usp = new URLSearchParams();
  usp.append('siteId', '11111111-1111-1111-1111-111111111111');
  usp.append('siteId', '22222222-2222-2222-2222-222222222222');
  const r = parseTimeLedgerUiState(usp, NOW);
  check('parse: repeated siteId= parameter -> rejected, never silently takes the first value', r.ok === false, r);
}
{
  const usp = new URLSearchParams();
  usp.append('startDate', '2026-09-21');
  usp.append('startDate', '2026-09-28');
  usp.append('endDate', '2026-09-27');
  const r = parseTimeLedgerUiState(usp, NOW);
  check('parse: repeated startDate= parameter -> rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ allTime: 'true' }), NOW);
  check('parse: allTime=true alone -> ok, dates null', r.ok === true && r.ok && r.state.allTime === true && r.state.startDate === null && r.state.endDate === null, r);
}
{
  const r = parseTimeLedgerUiState(sp({ allTime: 'true', startDate: '2026-09-21', endDate: '2026-09-27' }), NOW);
  check('parse: allTime=true + startDate/endDate together -> rejected (conflicting)', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ allTime: 'garbage' }), NOW);
  check('parse: allTime=garbage -> rejected, never silently false', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27', view: 'bogus' }), NOW);
  check('parse: unknown view -> rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27', page: '0' }), NOW);
  check('parse: page=0 -> rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27', pageSize: '9999' }), NOW);
  check('parse: pageSize over the max -> rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27', siteId: 'not-a-uuid' }), NOW);
  check('parse: invalid siteId -> rejected', r.ok === false, r);
}
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27', workAreaId: 'none' }), NOW);
  check("parse: workAreaId='none' accepted", r.ok === true, r);
}

// Round-trip: serialize(parse(x)) reproduces an equivalent URL (same parse result again).
{
  const original = sp({ startDate: '2026-09-21', endDate: '2026-09-27', siteId: '11111111-1111-1111-1111-111111111111', status: 'needs_attention', onlyIssues: 'true', page: '2' });
  const r1 = parseTimeLedgerUiState(original, NOW);
  check('round-trip setup: first parse ok', r1.ok === true, r1);
  if (r1.ok) {
    const serialized = uiStateToSearchParams(r1.state);
    const r2 = parseTimeLedgerUiState(serialized, NOW);
    check('round-trip: serialize(parse(x)) parses back to an identical state', r2.ok === true && JSON.stringify(r2.state) === JSON.stringify(r1.state), { r1: r1.state, serialized: serialized.toString(), r2 });
  }
}

// ---------------------------------------------------------------------------------------------
// URL -> API query — never sends allTime and dates together, requestedRange null iff allTime.
// ---------------------------------------------------------------------------------------------
{
  const r = parseTimeLedgerUiState(sp({ startDate: '2026-09-21', endDate: '2026-09-27' }), NOW);
  if (r.ok) {
    const q = uiStateToApiQuery(r.state);
    check('uiStateToApiQuery: non-allTime -> requestedRange set, allTime false', q.allTime === false && q.requestedRange?.startDate === '2026-09-21' && q.requestedRange?.endDate === '2026-09-27', q);
    const url = uiStateToApiUrl(r.state);
    check('uiStateToApiUrl: never contains allTime=true alongside startDate', !(url.includes('allTime=true') && url.includes('startDate')), url);
  }
}
{
  const r = parseTimeLedgerUiState(sp({ allTime: 'true' }), NOW);
  if (r.ok) {
    const q = uiStateToApiQuery(r.state);
    check('uiStateToApiQuery: allTime -> requestedRange null', q.allTime === true && q.requestedRange === null, q);
    const url = uiStateToApiUrl(r.state);
    check('uiStateToApiUrl: allTime -> no startDate/endDate in the URL', !url.includes('startDate') && !url.includes('endDate') && url.includes('allTime=true'), url);
  }
}

// ---------------------------------------------------------------------------------------------
// 1-4 weeks, arrows, current week.
// ---------------------------------------------------------------------------------------------
{
  const wk = currentHelsinkiWeekRange(NOW);
  check('currentHelsinkiWeekRange: 7-day span', weeksCountFromRange(wk.startDate, wk.endDate) === 1, wk);
}
{
  const r2 = rangeForWeeksEndingAt('2026-09-27', 2);
  check('rangeForWeeksEndingAt(2): matches the TZ worked example (14.09-27.09)', r2.startDate === '2026-09-14' && r2.endDate === '2026-09-27', r2);
  const r3 = rangeForWeeksEndingAt('2026-09-27', 3);
  check('rangeForWeeksEndingAt(3): matches the TZ worked example (07.09-27.09)', r3.startDate === '2026-09-07' && r3.endDate === '2026-09-27', r3);
  const r4 = rangeForWeeksEndingAt('2026-09-27', 4);
  check('rangeForWeeksEndingAt(4): matches the TZ worked example (31.08-27.09)', r4.startDate === '2026-08-31' && r4.endDate === '2026-09-27', r4);
}
{
  const shiftedNext = shiftRangeByOwnLength('2026-09-21', '2026-09-27', 1);
  check('shiftRangeByOwnLength: next 1-week range does not overlap the previous one', shiftedNext.startDate === '2026-09-28' && shiftedNext.endDate === '2026-10-04', shiftedNext);
  const shiftedPrev = shiftRangeByOwnLength('2026-09-21', '2026-09-27', -1);
  check('shiftRangeByOwnLength: previous 1-week range does not overlap', shiftedPrev.startDate === '2026-09-14' && shiftedPrev.endDate === '2026-09-20', shiftedPrev);
  // A 4-week range shifts by its own 28-day length, not by 7 days.
  const shifted4 = shiftRangeByOwnLength('2026-08-31', '2026-09-27', 1);
  check('shiftRangeByOwnLength: a 4-week range shifts by 28 days, never overlapping', shifted4.startDate === '2026-09-28' && shifted4.endDate === '2026-10-25', shifted4);
}
{
  check('weeksCountFromRange: an irregular span returns null (defensive)', weeksCountFromRange('2026-09-21', '2026-09-25') === null);
}

// ---------------------------------------------------------------------------------------------
// reset page=1 on any non-page change.
// ---------------------------------------------------------------------------------------------
{
  const base: TimeLedgerUiState = { ...defaultTimeLedgerUiState(NOW), page: 3 };
  const afterFilterChange = nextUiState(base, { siteId: '11111111-1111-1111-1111-111111111111' });
  check('nextUiState: changing a filter resets page to 1', afterFilterChange.page === 1, afterFilterChange);
  const afterPageChange = nextUiState(base, { page: 5 });
  check('nextUiState: an explicit page change is NOT overridden back to 1', afterPageChange.page === 5, afterPageChange);
}
{
  const base = defaultTimeLedgerUiState(NOW);
  check('activeFilterCount: a bare default state has zero active filters', activeFilterCount(base) === 0, base);
  const withFilters = nextUiState(base, { siteId: '11111111-1111-1111-1111-111111111111', onlyIssues: true });
  check('activeFilterCount: counts each set filter', activeFilterCount(withFilters) === 2, withFilters);
}

// ---------------------------------------------------------------------------------------------
// RU/EN labels + "no technical terms in the main labels" (the fixup's own explicit UX principle).
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_TERMS = /fingerprint|canonical|CURRENT|SUPERSEDED|source ?revision|отпечаток|канонич/i;

{
  for (const state of ['READY', 'NEEDS_ATTENTION', 'APPROVED', 'CHANGED_AFTER_APPROVAL'] as const) {
    const en = approvalStateLabel(state, 'EN');
    const ru = approvalStateLabel(state, 'RU');
    check(`approvalStateLabel(${state}, EN) is non-empty and has no technical terms`, en.length > 0 && !FORBIDDEN_TERMS.test(en), en);
    check(`approvalStateLabel(${state}, RU) is non-empty and has no technical terms`, ru.length > 0 && !FORBIDDEN_TERMS.test(ru), ru);
  }
  check('approvalStateTone: NEEDS_ATTENTION and CHANGED_AFTER_APPROVAL are warning (yellow), never danger (TZ §5.5)', approvalStateTone('NEEDS_ATTENTION') === 'warning' && approvalStateTone('CHANGED_AFTER_APPROVAL') === 'warning');
  check('approvalStateTone: APPROVED is success', approvalStateTone('APPROVED') === 'success');
}
check('submissionStateLabel RU/EN differ and are non-technical', submissionStateLabel('SUBMITTED', 'RU') === 'Сдано' && submissionStateLabel('NOT_SUBMITTED', 'EN') === 'Not submitted yet');
check('noCustomerGroupLabel RU', noCustomerGroupLabel('RU') === 'Без заказчика');
check('noCustomerGroupLabel EN', noCustomerGroupLabel('EN') === 'No customer');

{
  const label = issueLabel({ code: 'PLAN_ACTUAL_MISMATCH', message: 'Actual worked time for this site differs from the planned shift.' }, 'RU');
  check('issueLabel: mapped code -> human RU sentence, no code leaked', label === 'План отличается от факта' && !label.includes('PLAN_ACTUAL_MISMATCH'), label);
}
{
  const label = issueLabel({ code: 'OPEN_ATTENDANCE_EXCEPTION_GPS_NOT_VERIFIED', message: 'Open attendance exception (GPS_NOT_VERIFIED) within this week.' }, 'RU');
  check('issueLabel: OPEN_ATTENDANCE_EXCEPTION_* reuses the real exception-type label, no raw code', label.includes('GPS') && !label.includes('OPEN_ATTENDANCE_EXCEPTION_'), label);
}
{
  const label = issueLabel({ code: 'SOME_UNKNOWN_FUTURE_CODE', message: 'A plain human sentence from the server.' }, 'EN');
  check('issueLabel: unknown code falls back to the server message, not the code', label === 'A plain human sentence from the server.', label);
}
check('issueCountLabel RU pluralization: 1 замечание', issueCountLabel(1, 'warning', 'RU') === '1 замечание', issueCountLabel(1, 'warning', 'RU'));
check('issueCountLabel RU pluralization: 2 замечания', issueCountLabel(2, 'warning', 'RU') === '2 замечания', issueCountLabel(2, 'warning', 'RU'));
check('issueCountLabel RU pluralization: 5 замечаний', issueCountLabel(5, 'warning', 'RU') === '5 замечаний', issueCountLabel(5, 'warning', 'RU'));

// ---------------------------------------------------------------------------------------------
// Duration formatting — no rounding to 15/30/60-minute blocks (reused, already-tested function;
// re-confirmed here specifically for the values the ledger page will actually render).
// ---------------------------------------------------------------------------------------------
check('formatWorkedDuration: 97 minutes -> 1h37m exactly, not rounded to 1h30m/1h45m', formatWorkedDuration(97, 'EN') === '1 h 37 min', formatWorkedDuration(97, 'EN'));
check('formatWorkedDuration: 97 minutes RU', formatWorkedDuration(97, 'RU') === '1 ч 37 мин', formatWorkedDuration(97, 'RU'));
check('formatWorkedDuration: 1 minute -> not rounded away to 0', formatWorkedDuration(1, 'EN') === '0 h 1 min', formatWorkedDuration(1, 'EN'));
check('formatWorkedDuration: 0 minutes', formatWorkedDuration(0, 'RU') === '0 ч 0 мин', formatWorkedDuration(0, 'RU'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
