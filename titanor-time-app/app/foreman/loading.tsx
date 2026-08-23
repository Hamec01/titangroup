// T7A.9B — loading skeleton for /foreman (scoped operational overview). No layout collapse
// (task §13): the skeleton reserves the same card shell as the real content. Hardcoded to Russian
// (the app's default/pilot locale) — see app/admin/loading.tsx for why this file can't do a real
// locale lookup.
export default function ForemanOverviewLoading() {
  return (
    <main className="wk-page">
      <div className="setup-card worker-card ov-card">
        <h1>Обзор</h1>
        <p className="ov-muted" role="status" aria-live="polite">
          Загрузка…
        </p>
        <div className="ov-skeleton-grid" aria-hidden="true">
          {Array.from({ length: 15 }).map((_, i) => (
            <div key={i} className="ov-skeleton-card" />
          ))}
        </div>
      </div>
    </main>
  );
}
