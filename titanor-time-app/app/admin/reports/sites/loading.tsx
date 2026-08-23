export default function Loading() {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Отчёт по времени объекта</h1>
        <p role="status" aria-live="polite">
          Загрузка отчёта…
        </p>
      </div>
    </main>
  );
}
