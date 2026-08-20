'use client';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BZ — scoped error boundary for
// /admin/export/:batchId. Never renders error.message or a stack trace.
export default function AdminExportBatchDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Export batch</h1>
        <p className="login-error" role="alert">
          Something went wrong loading this export. {error.digest && <span className="ov-muted">Reference: {error.digest}</span>}
        </p>
        <button type="button" className="exc-apply-button" onClick={() => reset()}>
          Try again
        </button>
        <p>
          <a href="/admin/export">Back to exports</a>
        </p>
      </div>
    </main>
  );
}
