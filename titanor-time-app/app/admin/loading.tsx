// T7A.9B — loading skeleton for /admin (operational overview). No layout collapse (task §13): the
// skeleton reserves the same card shell as the real content, so nothing jumps once data arrives.
// Hardcoded to Russian (the app's default/pilot locale, lib/i18n/locale.ts DEFAULT_APP_LOCALE) —
// this file renders before the request's real locale (session/cookie, a DB-backed lookup) is known,
// and adding that lookup here would defeat the whole point of a fast, dependency-free skeleton.
export default function AdminOverviewLoading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card ov-card">
        <h1>Сегодня</h1>
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
