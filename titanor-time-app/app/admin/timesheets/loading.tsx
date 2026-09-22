// UT4-B — same skeleton convention as app/admin/loading.tsx. Covers only the very first,
// no-JS-yet/slow-server render; the client view's own in-place skeleton (TimesheetsLedgerView.tsx)
// covers every subsequent filter-driven fetch.
export default function AdminTimesheetsLoading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card ledger-card">
        <p className="ov-muted" role="status" aria-live="polite">
          Загрузка…
        </p>
        <div className="ov-skeleton-grid" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ov-skeleton-card" />
          ))}
        </div>
      </div>
    </main>
  );
}
