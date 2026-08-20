'use client';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BZ — scoped error boundary for
// /admin/export. Never renders error.message or a stack trace — only Next's own safe correlation
// `digest`, if present.
export default function AdminExportHistoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>CSV exports</h1>
        <p className="login-error" role="alert">
          Something went wrong loading this page. {error.digest && <span className="ov-muted">Reference: {error.digest}</span>}
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
