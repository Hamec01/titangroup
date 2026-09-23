// UT7-B-fixup-2 #4 — pure unit coverage for lib/reporting/customer-hours-history.ts's exported
// isHistoricalCompatibleFilter: historical rows represent "changed after approval" in spirit, so
// they must only be resolved under a status/issue filter compatible with that state. No database.
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
  const { isHistoricalCompatibleFilter } = await import('../lib/reporting/customer-hours-history');

  const base = { status: 'all' as const, onlyIssues: false, onlyChangedAfterApproval: false };

  check('1: status=all, no flags -> compatible', isHistoricalCompatibleFilter({ ...base }) === true);
  check('2: status=changed_after_approval -> compatible', isHistoricalCompatibleFilter({ ...base, status: 'changed_after_approval' }) === true);
  check('3: onlyChangedAfterApproval=true (status=all) -> compatible', isHistoricalCompatibleFilter({ ...base, onlyChangedAfterApproval: true }) === true);
  check('4: onlyIssues=true (status=all) -> compatible', isHistoricalCompatibleFilter({ ...base, onlyIssues: true }) === true);
  check(
    '5: onlyChangedAfterApproval=true even under an otherwise-incompatible status still compatible (flag wins)',
    isHistoricalCompatibleFilter({ status: 'ready', onlyIssues: false, onlyChangedAfterApproval: true }) === true
  );
  check(
    '6: onlyIssues=true even under an otherwise-incompatible status still compatible (flag wins)',
    isHistoricalCompatibleFilter({ status: 'approved', onlyIssues: true, onlyChangedAfterApproval: false }) === true
  );

  check('7: status=approved, no flags -> NOT compatible', isHistoricalCompatibleFilter({ ...base, status: 'approved' }) === false);
  check('8: status=ready, no flags -> NOT compatible', isHistoricalCompatibleFilter({ ...base, status: 'ready' }) === false);
  check('9: status=not_submitted, no flags -> NOT compatible', isHistoricalCompatibleFilter({ ...base, status: 'not_submitted' }) === false);
  check('10: status=needs_attention, no flags -> NOT compatible', isHistoricalCompatibleFilter({ ...base, status: 'needs_attention' }) === false);
  check('11: status=source_error, no flags -> NOT compatible', isHistoricalCompatibleFilter({ ...base, status: 'source_error' }) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
