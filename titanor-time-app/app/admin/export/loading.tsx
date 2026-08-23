export default function AdminExportHistoryLoading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Выгрузки CSV</h1>
        <p role="status" aria-live="polite">
          Загрузка выгрузок…
        </p>
      </div>
    </main>
  );
}
