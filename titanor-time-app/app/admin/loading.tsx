// T7A.9B — loading skeleton for /admin (operational overview). No layout collapse (task §13): the
// skeleton reserves the same card shell as the real content, so nothing jumps once data arrives.
export default function AdminOverviewLoading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card ov-card">
        <h1>Operational overview</h1>
        <p className="ov-muted" role="status" aria-live="polite">
          Loading…
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
