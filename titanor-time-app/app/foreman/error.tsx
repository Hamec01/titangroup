'use client';

// T7A.9B — scoped error boundary for /foreman (operational overview). Never renders error.message
// or a stack trace (task §12) — only Next's own safe correlation `digest`, if present.
export default function ForemanOverviewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="wk-page">
      <div className="setup-card worker-card ov-card">
        <h1>Overview</h1>
        <p className="login-error" role="alert">
          Something went wrong loading this page. {error.digest && <span className="ov-muted">Reference: {error.digest}</span>}
        </p>
        <button type="button" className="exc-apply-button" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </main>
  );
}
