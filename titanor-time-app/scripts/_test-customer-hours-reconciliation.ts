// UT7-B — pure unit coverage for lib/reporting/customer-hours-reconciliation.ts's
// decideReconciliationActions (which CURRENT items get superseded, and why) and
// lib/reporting/customer-hours-diff.ts's computeChangedDates (structural day-by-day comparison).
// No database, no Prisma, no transaction — hand-built inputs only.
export {}; // forces module scope (avoids TS2393 colliding with other test scripts' own global main())

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

async function main() {
  const { decideReconciliationActions, classifyReconciliationSourceUnreadable, classifyReconciliationBuildFailure } = await import('../lib/reporting/customer-hours-reconciliation');
  const { computeChangedDates } = await import('../lib/reporting/customer-hours-diff');
  const { WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE } = await import('../lib/reporting/weekly-customer-slice');

  const site = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const wa = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  function fakeSlice(siteId: string, workAreaId: string | null, weekStart: string, fingerprint: string, workedMinutes = 450): any {
    return {
      logicalKey: { employeeId: 'emp-1', timesheetId: 'ts-1', siteId, workAreaId, weekStart, weekEnd: '2026-09-27' },
      payload: { schemaVersion: 1, employeeId: 'emp-1', siteId, workAreaId, weekStart, weekEnd: '2026-09-27', days: [] },
      fingerprint,
      workedMinutes,
      grossMinutes: workedMinutes + 30,
      breakMinutes: 30,
      dayTotals: []
    };
  }

  // ---------------------------------------------------------------------------------------------
  // 1. decideReconciliationActions — unchanged fingerprint -> KEEP.
  // ---------------------------------------------------------------------------------------------
  {
    const current = [{ id: 'item-1', siteId: site, workAreaId: wa, weekStart: '2026-09-21', fingerprint: 'a'.repeat(64) }];
    const fresh = [fakeSlice(site, wa, '2026-09-21', 'a'.repeat(64))];
    const decisions = decideReconciliationActions(current, fresh);
    check('1: unchanged fingerprint -> KEEP', decisions.length === 1 && decisions[0].action === 'KEEP', decisions);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Fingerprint changed -> SUPERSEDE, reason FINGERPRINT_CHANGED, fresh numbers carried through.
  // ---------------------------------------------------------------------------------------------
  {
    const current = [{ id: 'item-1', siteId: site, workAreaId: wa, weekStart: '2026-09-21', fingerprint: 'a'.repeat(64) }];
    const fresh = [fakeSlice(site, wa, '2026-09-21', 'b'.repeat(64), 500)];
    const decisions = decideReconciliationActions(current, fresh);
    check(
      '2: changed fingerprint -> SUPERSEDE/FINGERPRINT_CHANGED with fresh numbers',
      decisions.length === 1 && decisions[0].action === 'SUPERSEDE' && (decisions[0] as any).reason === 'FINGERPRINT_CHANGED' && (decisions[0] as any).freshFingerprint === 'b'.repeat(64) && (decisions[0] as any).freshWorkedMinutes === 500,
      decisions
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Slice disappeared entirely -> SUPERSEDE, reason SLICE_REMOVED, fresh numbers null.
  // ---------------------------------------------------------------------------------------------
  {
    const current = [{ id: 'item-1', siteId: site, workAreaId: wa, weekStart: '2026-09-21', fingerprint: 'a'.repeat(64) }];
    const decisions = decideReconciliationActions(current, []);
    check(
      '3: no matching fresh slice -> SUPERSEDE/SLICE_REMOVED, freshFingerprint null',
      decisions.length === 1 && decisions[0].action === 'SUPERSEDE' && (decisions[0] as any).reason === 'SLICE_REMOVED' && (decisions[0] as any).freshFingerprint === null && (decisions[0] as any).freshWorkedMinutes === null,
      decisions
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Multiple logical keys — only the changed one is superseded, the rest stay KEEP.
  // ---------------------------------------------------------------------------------------------
  {
    const waOther = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const current = [
      { id: 'item-1', siteId: site, workAreaId: wa, weekStart: '2026-09-21', fingerprint: 'a'.repeat(64) },
      { id: 'item-2', siteId: site, workAreaId: waOther, weekStart: '2026-09-21', fingerprint: 'c'.repeat(64) },
      { id: 'item-3', siteId: site, workAreaId: wa, weekStart: '2026-09-28', fingerprint: 'd'.repeat(64) }
    ];
    const fresh = [
      fakeSlice(site, wa, '2026-09-21', 'a'.repeat(64)), // item-1 unchanged
      fakeSlice(site, waOther, '2026-09-21', 'c'.repeat(64)), // item-2 unchanged
      fakeSlice(site, wa, '2026-09-28', 'e'.repeat(64)) // item-3 changed
    ];
    const decisions = decideReconciliationActions(current, fresh);
    const byId = new Map(decisions.map((d) => [d.itemId, d]));
    check('4: item-1 (unchanged customer/week) KEEP', byId.get('item-1')?.action === 'KEEP', decisions);
    check('4b: item-2 (different customer, unchanged) KEEP', byId.get('item-2')?.action === 'KEEP', decisions);
    check('4c: item-3 (different week, changed) SUPERSEDE', byId.get('item-3')?.action === 'SUPERSEDE', decisions);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. New logical key with no prior CURRENT item is never in the decision list at all (no automatic
  //    approval of new hours) — decideReconciliationActions only ever iterates currentItems.
  // ---------------------------------------------------------------------------------------------
  {
    const current: any[] = [];
    const fresh = [fakeSlice(site, wa, '2026-09-21', 'a'.repeat(64))];
    const decisions = decideReconciliationActions(current, fresh);
    check('5: no CURRENT items -> empty decision list regardless of fresh slices', decisions.length === 0, decisions);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. computeChangedDates — identical days -> no changed dates.
  // ---------------------------------------------------------------------------------------------
  {
    const day = (date: string, extra: Record<string, unknown> = {}) => ({ date, dayType: 'WORK', confirmedZero: false, segments: [{ startAt: '2026-09-21T07:00:00.000Z', endAt: '2026-09-21T15:00:00.000Z', breaks: [] }], autoUnpaidBreakMinutes: 30, ...extra });
    const before = [day('2026-09-21'), day('2026-09-22')];
    const after = [day('2026-09-21'), day('2026-09-22')];
    check('6: byte-identical days -> no changed dates', computeChangedDates(before, after).length === 0, computeChangedDates(before, after));
  }

  // ---------------------------------------------------------------------------------------------
  // 7. computeChangedDates — one day's segments differ -> only that date reported.
  // ---------------------------------------------------------------------------------------------
  {
    const before = [
      { date: '2026-09-21', dayType: 'WORK', confirmedZero: false, segments: [{ startAt: '2026-09-21T07:00:00.000Z', endAt: '2026-09-21T15:00:00.000Z', breaks: [] }], autoUnpaidBreakMinutes: 30 },
      { date: '2026-09-22', dayType: 'WORK', confirmedZero: false, segments: [{ startAt: '2026-09-22T07:00:00.000Z', endAt: '2026-09-22T15:00:00.000Z', breaks: [] }], autoUnpaidBreakMinutes: 30 }
    ];
    const after = [
      { date: '2026-09-21', dayType: 'WORK', confirmedZero: false, segments: [{ startAt: '2026-09-21T07:00:00.000Z', endAt: '2026-09-21T16:00:00.000Z', breaks: [] }], autoUnpaidBreakMinutes: 30 }, // endAt changed
      { date: '2026-09-22', dayType: 'WORK', confirmedZero: false, segments: [{ startAt: '2026-09-22T07:00:00.000Z', endAt: '2026-09-22T15:00:00.000Z', breaks: [] }], autoUnpaidBreakMinutes: 30 }
    ];
    const changed = computeChangedDates(before, after);
    check('7: only the genuinely different date is reported', changed.length === 1 && changed[0] === '2026-09-21', changed);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. computeChangedDates — a date present before but absent after (removed) is reported; a date
  //    added after is also reported; result is sorted.
  // ---------------------------------------------------------------------------------------------
  {
    const mk = (date: string) => ({ date, dayType: 'WORK', confirmedZero: false, segments: [{ startAt: `${date}T07:00:00.000Z`, endAt: `${date}T15:00:00.000Z`, breaks: [] }], autoUnpaidBreakMinutes: 30 });
    const before = [mk('2026-09-23'), mk('2026-09-21')];
    const after = [mk('2026-09-21'), mk('2026-09-24')];
    const changed = computeChangedDates(before, after);
    check('8: removed date (23rd) and added date (24th) both reported, sorted', changed.length === 2 && changed[0] === '2026-09-23' && changed[1] === '2026-09-24', changed);
  }

  // ---------------------------------------------------------------------------------------------
  // 9. computeChangedDates with after=null (slice removed entirely) -> every before-date reported.
  // ---------------------------------------------------------------------------------------------
  {
    const mk = (date: string) => ({ date, dayType: 'WORK', confirmedZero: false, segments: [{ startAt: `${date}T07:00:00.000Z`, endAt: `${date}T15:00:00.000Z`, breaks: [] }], autoUnpaidBreakMinutes: 30 });
    const before = [mk('2026-09-21'), mk('2026-09-22')];
    const changed = computeChangedDates(before, null);
    check('9: after=null -> every before-date is "changed"', changed.length === 2 && changed[0] === '2026-09-21' && changed[1] === '2026-09-22', changed);
  }

  // ---------------------------------------------------------------------------------------------
  // 10. classifyReconciliationSourceUnreadable — UT7-B-fixup #1/#3 pure classifier. A sourceError
  //     present, or the resolved source id not matching the version this reconciliation run is for,
  //     both mean "unreadable" regardless of the other condition. A clean match with no sourceError
  //     is the only "readable" case.
  // ---------------------------------------------------------------------------------------------
  {
    const v = 'v1'.padEnd(36, '-');
    check('10a: sourceError present -> unreadable', classifyReconciliationSourceUnreadable('some read failure', v, v) === true);
    check('10b: resolvedSourceId mismatch, no sourceError -> unreadable', classifyReconciliationSourceUnreadable(undefined, 'other-version', v) === true);
    check('10c: resolvedSourceId undefined (never resolved) -> unreadable', classifyReconciliationSourceUnreadable(undefined, undefined, v) === true);
    check('10d: no sourceError, resolvedSourceId matches -> readable', classifyReconciliationSourceUnreadable(undefined, v, v) === false);
    check('10e: both sourceError AND mismatch -> still unreadable (either condition suffices)', classifyReconciliationSourceUnreadable('boom', 'other', v) === true);
  }

  // ---------------------------------------------------------------------------------------------
  // 11. classifyReconciliationBuildFailure — the one KNOWN, deferrable buildWeeklyCustomerSlices
  //     error, extracted to its own pure predicate (UT7-B-fixup #3).
  // ---------------------------------------------------------------------------------------------
  {
    const knownError = new Error(`${WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE}: break exceeds segment duration`);
    check('11a: known invariant-failure message -> true', classifyReconciliationBuildFailure(knownError) === true);
    check('11b: unrelated Error -> false', classifyReconciliationBuildFailure(new Error('ECONNRESET')) === false);
    check('11c: non-Error thrown value -> false', classifyReconciliationBuildFailure({ some: 'object' }) === false);
    check('11d: a message that merely CONTAINS the marker but does not START with it -> false (startsWith, not includes)', classifyReconciliationBuildFailure(new Error(`wrapped: ${WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE}`)) === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
