export default function AdminExportBatchDetailLoading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Export batch</h1>
        <p role="status" aria-live="polite">
          Loading export…
        </p>
      </div>
    </main>
  );
}
