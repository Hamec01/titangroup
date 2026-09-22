// UT4-B (Titanor Time — единый табель) — rollout switch for the new /admin/timesheets page.
// Env var, not a DB row or cookie: the project has no feature-flag system at all (checked during
// UT4-A), and an env var needs no migration to add or remove (TZ §21's own constraint), can't be
// flipped by accident through any UI, and satisfies "откат без отката migration" literally — flip
// it off and restart, zero data touched, since UT4 never writes anything.
export function isTimesheetsLedgerUiEnabled(): boolean {
  return process.env.TIMESHEETS_LEDGER_UI_ENABLED === '1';
}
