export default function AdminExportHistoryLoading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>CSV exports</h1>
        <p role="status" aria-live="polite">
          Loading exports…
        </p>
      </div>
    </main>
  );
}
