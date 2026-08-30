'use client';

// R07-A — last-resort boundary for an error thrown by the ROOT layout itself (app/layout.tsx).
// It replaces the entire document, so it must render its own <html>/<body> and cannot rely on any
// provider, global stylesheet class, or the locale cookie machinery. Never renders error.message
// or a stack — only Next's safe `digest`.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          background: '#f4f4f5',
          color: '#18181b'
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong / Что-то пошло не так</h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: '#52525b' }}>
            The application failed to start. Please reload the page. / Приложение не запустилось. Обновите страницу.
            {error.digest ? ` (reference / код: ${error.digest})` : null}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', fontSize: 14, cursor: 'pointer' }}
          >
            Reload / Обновить
          </button>
        </div>
      </body>
    </html>
  );
}
