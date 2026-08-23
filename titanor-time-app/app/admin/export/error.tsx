'use client';

import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BZ — scoped error boundary for
// /admin/export. Never renders error.message or a stack trace — only Next's own safe correlation
// `digest`, if present.
export default function AdminExportHistoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ru = useAppLocale() === 'RU';
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Выгрузки CSV' : 'CSV exports'}</h1>
        <p className="login-error" role="alert">
          {ru ? 'Не удалось загрузить эту страницу.' : 'Something went wrong loading this page.'} {error.digest && <span className="ov-muted">{ru ? 'Код обращения:' : 'Reference:'} {error.digest}</span>}
        </p>
        <button type="button" className="exc-apply-button" onClick={() => reset()}>
          {ru ? 'Попробовать снова' : 'Try again'}
        </button>
        <p>
          <a href="/admin/export">{ru ? 'К выгрузкам' : 'Back to exports'}</a>
        </p>
      </div>
    </main>
  );
}
