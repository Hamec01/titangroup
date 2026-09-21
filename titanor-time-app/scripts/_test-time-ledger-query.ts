// UT3-B / UT3-B-fixup (Titanor Time — единый табель и подтверждение часов по заказчику) —
// pure-function coverage for lib/reporting/time-ledger.ts's exported comparator/signature helpers
// AND lib/reporting/time-ledger-query.ts's parseTimeLedgerQuery. No database: everything exercised
// here is plain-object/URLSearchParams in, plain-value out. The full read pipeline (fast/chunked
// paths, draft/placeholder semantics, blockers/warnings, approval matching, 409 regression) is
// covered by the db-lane scripts/_test-time-ledger.ts.

import { compareEntries, entrySignature, sortTupleFor, type SortTuple, type WeeklyCustomerSliceRow, type NotSubmittedRow, type SourceErrorRow, type TimeLedgerEntry } from '../lib/reporting/time-ledger';
import { parseTimeLedgerQuery } from '../lib/reporting/time-ledger-query';

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

// ---------------------------------------------------------------------------------------------
// Fixture factories — minimal valid entries with every field a sensible fixed dummy, so a test only
// has to override what it actually cares about.
// ---------------------------------------------------------------------------------------------

function tuple(overrides: Partial<SortTuple> = {}): SortTuple {
  return {
    groupRank: 0,
    siteId: 'site-a',
    workAreaSortKey: 'wa-a',
    weekOrPeriodStart: '2099-01-05',
    employeeDisplayName: 'Aaltonen Anna',
    employeeId: 'emp-a',
    timesheetOrPeriodId: 'ts-a',
    entryDiscriminant: 'SLICE:emp-a:ts-a:site-a:wa-a:2099-01-05',
    ...overrides
  };
}

function sliceRow(overrides: Partial<WeeklyCustomerSliceRow> = {}): WeeklyCustomerSliceRow {
  return {
    kind: 'WEEKLY_CUSTOMER_SLICE',
    logicalKey: { employeeId: 'emp-a', timesheetId: 'ts-a', siteId: 'site-a', workAreaId: 'wa-a', weekStart: '2099-01-05', weekEnd: '2099-01-11' },
    employeeName: 'Aaltonen Anna',
    employeeNumber: 'E-001',
    submissionState: 'SUBMITTED',
    approvalState: 'READY',
    workedMinutes: 450,
    grossMinutes: 480,
    breakMinutes: 30,
    currentFingerprint: 'f'.repeat(64),
    canonicalSource: { dataSource: 'CURRENT_VERSION', sourceId: 'ver-a', sourceKind: 'VERSION', sourceRevision: null, versionNumber: 1, submissionSource: 'MANUAL' },
    currentApprovalItem: null,
    lastHistoricalApproval: null,
    supersededFingerprintMatch: false,
    selfApprovalBlocked: false,
    eligibility: { canApprove: true },
    blockers: [],
    warnings: [],
    info: [],
    displayDays: [],
    ...overrides
  };
}

function notSubmittedRow(overrides: Partial<NotSubmittedRow> = {}): NotSubmittedRow {
  return {
    kind: 'NOT_SUBMITTED',
    employeeId: 'emp-a',
    employeeName: 'Aaltonen Anna',
    employeeNumber: 'E-001',
    periodId: 'per-a',
    periodStartDate: '2099-01-05',
    periodEndDate: '2099-01-11',
    timesheetId: null,
    timesheetStatus: null,
    weeksCovered: ['2099-01-05'],
    ...overrides
  };
}

function sourceErrorRow(overrides: Partial<SourceErrorRow> = {}): SourceErrorRow {
  return {
    kind: 'SOURCE_ERROR',
    employeeId: 'emp-a',
    employeeName: 'Aaltonen Anna',
    employeeNumber: 'E-001',
    timesheetId: 'ts-a',
    periodId: 'per-a',
    periodStartDate: '2099-01-05',
    periodEndDate: '2099-01-11',
    reason: 'REPORT_CANONICAL_SOURCE_INVARIANT_FAILURE: timesheet ts-a has status DRAFT but no TimesheetDraft',
    workedMinutes: null,
    approvable: false,
    ...overrides
  };
}

// ---------------------------------------------------------------------------------------------
// compareEntries — field-by-field precedence, cascading only when the earlier field ties.
// ---------------------------------------------------------------------------------------------

check('groupRank: slice(0) before not_submitted(1)', compareEntries(tuple({ groupRank: 0 }), tuple({ groupRank: 1 })) < 0);
check('groupRank: not_submitted(1) before source_error(2)', compareEntries(tuple({ groupRank: 1 }), tuple({ groupRank: 2 })) < 0);
check('groupRank: symmetric (source_error after slice)', compareEntries(tuple({ groupRank: 2 }), tuple({ groupRank: 0 })) > 0);

check('siteId: only compared when groupRank ties', compareEntries(tuple({ groupRank: 0, siteId: 'zzz' }), tuple({ groupRank: 1, siteId: 'aaa' })) < 0, 'groupRank must win over siteId');
check('siteId: alphabetical when groupRank ties', compareEntries(tuple({ siteId: 'site-a' }), tuple({ siteId: 'site-b' })) < 0);

check('workAreaSortKey: empty string (no customer) sorts before a real id', compareEntries(tuple({ workAreaSortKey: '' }), tuple({ workAreaSortKey: 'wa-x' })) < 0);
check('workAreaSortKey: only compared when siteId ties', compareEntries(tuple({ siteId: 'a', workAreaSortKey: 'zzz' }), tuple({ siteId: 'b', workAreaSortKey: 'aaa' })) < 0);

check('weekOrPeriodStart: chronological when workArea ties', compareEntries(tuple({ weekOrPeriodStart: '2099-01-05' }), tuple({ weekOrPeriodStart: '2099-01-12' })) < 0);

check('employeeDisplayName: alphabetical when week ties', compareEntries(tuple({ employeeDisplayName: 'Aaltonen Anna' }), tuple({ employeeDisplayName: 'Virtanen Ville' })) < 0);

check('employeeId: tie-break when display name ties (e.g. two same-named workers)', compareEntries(tuple({ employeeDisplayName: 'Sama Nimi', employeeId: 'emp-1' }), tuple({ employeeDisplayName: 'Sama Nimi', employeeId: 'emp-2' })) < 0);

check('timesheetOrPeriodId: tie-break when employeeId ties (two entries, same employee)', compareEntries(tuple({ timesheetOrPeriodId: 'ts-1' }), tuple({ timesheetOrPeriodId: 'ts-2' })) < 0);

check(
  'entryDiscriminant: absolute final tie-break — everything else identical',
  compareEntries(tuple({ entryDiscriminant: 'A' }), tuple({ entryDiscriminant: 'B' })) < 0
);
check('compareEntries: fully identical tuples compare equal (0)', compareEntries(tuple(), tuple()) === 0);

// A realistic cross-chunk scenario: chunk 2's early-alphabet site must sort before chunk 1's
// late-alphabet site even though chunk 1 was scanned first (UT3-A-R2's own motivating case for
// abandoning "sort within chunk, assign position immediately").
{
  const fromChunk1 = tuple({ groupRank: 0, siteId: 'zzz-late-site', weekOrPeriodStart: '2099-01-05' });
  const fromChunk2 = tuple({ groupRank: 0, siteId: 'aaa-early-site', weekOrPeriodStart: '2099-06-01' });
  check('cross-chunk: a later-scanned early-site entry still sorts first globally', compareEntries(fromChunk2, fromChunk1) < 0);
}

// ---------------------------------------------------------------------------------------------
// sortTupleFor — per-kind shape (groupRank / discriminant prefix / week-vs-period source field).
// ---------------------------------------------------------------------------------------------

{
  const t = sortTupleFor(sliceRow());
  check('sortTupleFor(slice): groupRank 0', t.groupRank === 0);
  check('sortTupleFor(slice): weekOrPeriodStart = logicalKey.weekStart', t.weekOrPeriodStart === '2099-01-05');
  check('sortTupleFor(slice): discriminant starts with SLICE:', t.entryDiscriminant.startsWith('SLICE:'));
  check('sortTupleFor(slice, no customer): workAreaSortKey is empty string, not "null"', sortTupleFor(sliceRow({ logicalKey: { ...sliceRow().logicalKey, workAreaId: null } })).workAreaSortKey === '');
}
{
  const t = sortTupleFor(notSubmittedRow());
  check('sortTupleFor(not_submitted): groupRank 1', t.groupRank === 1);
  check('sortTupleFor(not_submitted): weekOrPeriodStart = periodStartDate', t.weekOrPeriodStart === '2099-01-05');
  check('sortTupleFor(not_submitted): discriminant starts with NOT_SUBMITTED:', t.entryDiscriminant.startsWith('NOT_SUBMITTED:'));
  check('sortTupleFor(not_submitted): siteId is null (no site concept)', t.siteId === null);
}
{
  const t = sortTupleFor(sourceErrorRow());
  check('sortTupleFor(source_error): groupRank 2', t.groupRank === 2);
  check('sortTupleFor(source_error): discriminant starts with SOURCE_ERROR:', t.entryDiscriminant.startsWith('SOURCE_ERROR:'));
}

// Two different (employeeId, periodId) NOT_SUBMITTED entries never collide on discriminant.
{
  const a = sortTupleFor(notSubmittedRow({ employeeId: 'emp-1', periodId: 'per-1' })).entryDiscriminant;
  const b = sortTupleFor(notSubmittedRow({ employeeId: 'emp-1', periodId: 'per-2' })).entryDiscriminant;
  check('not_submitted discriminant distinguishes different periods for the same employee', a !== b, { a, b });
}

// ---------------------------------------------------------------------------------------------
// entrySignature — the Pass-1/Pass-2 consistency digest (UT3-A-R2 §2). Must be stable across
// displayDays-only changes (that is exactly what makes a "light" descriptor safe to keep), and must
// change when anything summary/ordering/eligibility/blockers/warnings/minutes-relevant changes.
// Must also be independent of source object key insertion order (canonical JSON).
// ---------------------------------------------------------------------------------------------

{
  const withDays = sliceRow({ displayDays: [{ date: '2099-01-05', dayType: 'WORK', confirmedZero: false, segments: [{ startAt: 'x', endAt: 'y', breaks: [] }], autoUnpaidBreakMinutes: 30 }] });
  const withoutDays = sliceRow({ displayDays: [] });
  check('entrySignature ignores displayDays entirely', entrySignature(withDays) === entrySignature(withoutDays));
}

check('entrySignature changes when workedMinutes changes', entrySignature(sliceRow({ workedMinutes: 450 })) !== entrySignature(sliceRow({ workedMinutes: 451 })));
check('entrySignature changes when approvalState changes', entrySignature(sliceRow({ approvalState: 'READY' })) !== entrySignature(sliceRow({ approvalState: 'APPROVED' })));
check('entrySignature changes when a blocker is added', entrySignature(sliceRow({ blockers: [] })) !== entrySignature(sliceRow({ blockers: [{ code: 'X', message: 'x' }] })));
check('entrySignature changes when a warning is added', entrySignature(sliceRow({ warnings: [] })) !== entrySignature(sliceRow({ warnings: [{ code: 'X', message: 'x' }] })));
check('entrySignature changes when submissionState changes', entrySignature(sliceRow({ submissionState: 'SUBMITTED' })) !== entrySignature(sliceRow({ submissionState: 'NOT_SUBMITTED' })));
check('entrySignature changes when currentFingerprint changes', entrySignature(sliceRow({ currentFingerprint: 'a'.repeat(64) })) !== entrySignature(sliceRow({ currentFingerprint: 'b'.repeat(64) })));
check('entrySignature changes when eligibility.canApprove changes', entrySignature(sliceRow({ eligibility: { canApprove: true } })) !== entrySignature(sliceRow({ eligibility: { canApprove: false } })));
check('entrySignature: identical content, different nested key insertion order -> same signature', entrySignature(sliceRow({ canonicalSource: { dataSource: 'CURRENT_VERSION', sourceId: 'ver-a', sourceKind: 'VERSION', sourceRevision: null, versionNumber: 1, submissionSource: 'MANUAL' } })) === entrySignature(sliceRow({ canonicalSource: { submissionSource: 'MANUAL', versionNumber: 1, sourceRevision: null, sourceKind: 'VERSION', sourceId: 'ver-a', dataSource: 'CURRENT_VERSION' } })));

check('entrySignature: two entries with identical content produce the identical signature', entrySignature(sliceRow()) === entrySignature(sliceRow()));

check('entrySignature works on NOT_SUBMITTED rows and is stable for identical content', entrySignature(notSubmittedRow()) === entrySignature(notSubmittedRow()));
check('entrySignature(NOT_SUBMITTED) changes when timesheetStatus changes', entrySignature(notSubmittedRow({ timesheetId: 'ts-x', timesheetStatus: 'DRAFT' })) !== entrySignature(notSubmittedRow({ timesheetId: 'ts-x', timesheetStatus: 'RETURNED' })));

check('entrySignature works on SOURCE_ERROR rows and is stable for identical content', entrySignature(sourceErrorRow()) === entrySignature(sourceErrorRow()));
check('entrySignature(SOURCE_ERROR) changes when reason changes', entrySignature(sourceErrorRow({ reason: 'a' })) !== entrySignature(sourceErrorRow({ reason: 'b' })));

// entrySignature never leaks displayDays into its own digest even when three kinds are mixed in one array (defensive, type-level sanity).
{
  const mixed: TimeLedgerEntry[] = [sliceRow(), notSubmittedRow(), sourceErrorRow()];
  const signatures = mixed.map(entrySignature);
  check('entrySignature: three different entry kinds -> three different signatures', new Set(signatures).size === 3, signatures);
}

// ---------------------------------------------------------------------------------------------
// parseTimeLedgerQuery — UT3-B-fixup point 1/10. A garbage/repeated/out-of-range value is always a
// rejection, never a silent fallback to a default that lets the request "succeed" with the wrong
// meaning.
// ---------------------------------------------------------------------------------------------

function sp(pairs: Record<string, string | string[]>): URLSearchParams {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) {
    for (const one of Array.isArray(v) ? v : [v]) usp.append(k, one);
  }
  return usp;
}

// 10.1 — a syntactically shaped but calendar-invalid date (Feb 30) must be rejected outright, never
// silently rolled over (Date's own arithmetic would turn it into 2026-03-02).
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-02-30', endDate: '2026-03-05' }));
  check('parser: 2026-02-30 (not a real calendar date) -> rejected', r.ok === false && r.error.code === 'VALIDATION_ERROR' && !!r.error.fieldErrors?.startDate, r);
}
{
  // Sanity: the equivalent REAL date must be accepted, proving the rejection above is about
  // calendar validity specifically, not merely date-string shape.
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-03-02', endDate: '2026-03-05' }));
  check('parser: a real calendar date is accepted', r.ok === true, r);
}
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-13-01', endDate: '2026-13-05' }));
  check('parser: month 13 -> rejected', r.ok === false && !!(r as { error: { fieldErrors?: Record<string, string[]> } }).error.fieldErrors?.startDate);
}

// 10.2 — an invalid boolean never silently becomes false.
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-01-05', endDate: '2026-01-11', onlyIssues: 'garbage' }));
  check('parser: onlyIssues=garbage -> rejected (never silently false)', r.ok === false && r.error.code === 'VALIDATION_ERROR' && !!r.error.fieldErrors?.onlyIssues, r);
}
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'garbage' }));
  check('parser: allTime=garbage -> rejected (never silently false)', r.ok === false && !!r.error.fieldErrors?.allTime, r);
}
{
  // Documented alternate boolean encodings both work: 'true'/'1' and 'false'/'0'.
  const r1 = parseTimeLedgerQuery(sp({ allTime: '1' }));
  const r2 = parseTimeLedgerQuery(sp({ startDate: '2026-01-05', endDate: '2026-01-11', onlyIssues: '0' }));
  check('parser: allTime=1 accepted as true', r1.ok === true && r1.query.allTime === true, r1);
  check('parser: onlyIssues=0 accepted as false', r2.ok === true && r2.query.onlyIssues === false, r2);
}

// 10.3 — a repeated supported parameter is rejected, never silently resolved to the first/last value.
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-01-05', endDate: '2026-01-11', page: ['1', '2'] }));
  check('parser: repeated page= -> rejected', r.ok === false && r.error.code === 'VALIDATION_ERROR' && !!r.error.fieldErrors?.page, r);
}
{
  const r = parseTimeLedgerQuery(sp({ startDate: ['2026-01-05', '2026-02-05'], endDate: '2026-01-11' }));
  check('parser: repeated startDate= -> rejected', r.ok === false && !!(r as { error: { fieldErrors?: Record<string, string[]> } }).error.fieldErrors?.startDate, r);
}

// 10.4 — an explicit range over ~2 years is rejected with a dedicated code, not folded into a
// generic VALIDATION_ERROR.
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2020-01-01', endDate: '2026-01-01' }));
  check('parser: explicit range > ~2 years -> RANGE_TOO_LARGE', r.ok === false && r.error.code === 'RANGE_TOO_LARGE', r);
}
{
  // A range comfortably under 2 years is fine.
  const r = parseTimeLedgerQuery(sp({ startDate: '2025-01-01', endDate: '2026-01-01' }));
  check('parser: explicit range under 2 years is accepted', r.ok === true, r);
}

// 10.5 — semantic conflicts get their own dedicated codes.
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'true', startDate: '2026-01-05' }));
  check('parser: allTime=true + startDate -> CONFLICTING_RANGE_PARAMETERS', r.ok === false && r.error.code === 'CONFLICTING_RANGE_PARAMETERS', r);
}
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'true', status: 'not_submitted', submissionState: 'submitted' }));
  check('parser: status=not_submitted + submissionState=submitted -> CONFLICTING_FILTER_PARAMETERS', r.ok === false && r.error.code === 'CONFLICTING_FILTER_PARAMETERS', r);
}
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'true', status: 'not_submitted', submissionSource: 'manual' }));
  check('parser: status=not_submitted + submissionSource=manual -> CONFLICTING_FILTER_PARAMETERS', r.ok === false && r.error.code === 'CONFLICTING_FILTER_PARAMETERS', r);
}
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'true', status: 'source_error', submissionSource: 'auto' }));
  check('parser: status=source_error + submissionSource=auto -> CONFLICTING_FILTER_PARAMETERS', r.ok === false && r.error.code === 'CONFLICTING_FILTER_PARAMETERS', r);
}
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'true', onlyChangedAfterApproval: 'true', status: 'ready' }));
  check('parser: onlyChangedAfterApproval=true + status=ready -> CONFLICTING_FILTER_PARAMETERS', r.ok === false && r.error.code === 'CONFLICTING_FILTER_PARAMETERS', r);
}
{
  // The one status value onlyChangedAfterApproval is compatible with — no conflict.
  const r = parseTimeLedgerQuery(sp({ allTime: 'true', onlyChangedAfterApproval: 'true', status: 'changed_after_approval' }));
  check('parser: onlyChangedAfterApproval=true + status=changed_after_approval -> accepted', r.ok === true, r);
}

// Invalid page/pageSize/UUID/enum — each its own fieldError, never a silently-substituted default.
{
  const cases: [string, Record<string, string>][] = [
    ['page=0', { page: '0' }],
    ['page=abc', { page: 'abc' }],
    ['page=1.5', { page: '1.5' }],
    ['page=-1', { page: '-1' }],
    ['pageSize=0', { pageSize: '0' }],
    ['pageSize=201', { pageSize: '201' }],
    ['siteId=not-a-uuid', { siteId: 'not-a-uuid' }],
    ['workAreaId=not-a-uuid-or-none', { workAreaId: 'garbage' }],
    ['status=bogus', { status: 'bogus' }],
    ['submissionState=bogus', { submissionState: 'bogus' }],
    ['submissionSource=bogus', { submissionSource: 'bogus' }]
  ];
  for (const [label, extra] of cases) {
    const r = parseTimeLedgerQuery(sp({ startDate: '2026-01-05', endDate: '2026-01-11', ...extra }));
    check(`parser: ${label} -> rejected`, r.ok === false, r);
  }
}

// startDate > endDate is still rejected (pre-existing behavior, re-confirmed through the new parser).
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-02-01', endDate: '2026-01-01' }));
  check('parser: startDate > endDate -> rejected', r.ok === false && !!(r as { error: { fieldErrors?: Record<string, string[]> } }).error.fieldErrors?.endDate, r);
}

// A fully valid minimal request normalizes exactly as expected, with every optional field at its
// documented default.
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-01-05', endDate: '2026-01-11' }));
  check(
    'parser: minimal valid request -> correct defaults',
    r.ok === true &&
      r.query.allTime === false &&
      r.query.requestedRange?.startDate === '2026-01-05' &&
      r.query.requestedRange?.endDate === '2026-01-11' &&
      r.query.employeeSearch === null &&
      r.query.siteId === null &&
      r.query.workAreaId === null &&
      r.query.status === 'all' &&
      r.query.onlyIssues === false &&
      r.query.onlyChangedAfterApproval === false &&
      r.query.submissionState === 'all' &&
      r.query.submissionSource === 'all' &&
      r.query.page === 1 &&
      r.query.pageSize === 50,
    r
  );
}
{
  const r = parseTimeLedgerQuery(sp({ allTime: 'true' }));
  check('parser: minimal valid allTime request', r.ok === true && r.query.allTime === true && r.query.requestedRange === null, r);
}
{
  const r = parseTimeLedgerQuery(sp({ startDate: '2026-01-05', endDate: '2026-01-11', workAreaId: 'none' }));
  check("parser: workAreaId='none' is accepted as the literal sentinel", r.ok === true && r.query.workAreaId === 'none', r);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
