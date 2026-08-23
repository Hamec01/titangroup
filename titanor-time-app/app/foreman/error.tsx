'use client';

import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// T7A.9B — scoped error boundary for /foreman (operational overview). Never renders error.message
// or a stack trace (task §12) — only Next's own safe correlation `digest`, if present.
export default function ForemanOverviewError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const ru = useAppLocale() === 'RU';
  return (
    <main className="wk-page">
      <div className="setup-card worker-card ov-card">
        <h1>{ru ? 'Обзор' : 'Overview'}</h1>
        <p className="login-error" role="alert">
          {ru ? 'Не удалось загрузить эту страницу.' : 'Something went wrong loading this page.'} {error.digest && <span className="ov-muted">{ru ? 'Код обращения:' : 'Reference:'} {error.digest}</span>}
        </p>
        <button type="button" className="exc-apply-button" onClick={() => reset()}>
          {ru ? 'Попробовать снова' : 'Try again'}
        </button>
      </div>
    </main>
  );
}
