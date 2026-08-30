'use client';

import { useEffect, useState } from 'react';

// R07-A — app-wide error boundary. Catches render/data errors anywhere below the root layout that
// no nested error.tsx (app/admin/error.tsx, app/foreman/error.tsx, …) already handles. Never
// renders error.message or a stack — only Next's own safe `digest` correlation id. Self-contained:
// the AppLocaleProvider is added per section layout, not at the root, so this reads the locale
// cookie directly and falls back to a bilingual message.
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [ru, setRu] = useState<boolean | null>(null);

  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]+)/);
    setRu(decodeURIComponent(match?.[1] ?? '').toUpperCase() === 'RU');
  }, []);

  const t = (en: string, rus: string) => (ru === null ? `${rus} / ${en}` : ru ? rus : en);

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{t('Something went wrong', 'Что-то пошло не так')}</h1>
        <p className="login-error" role="alert">
          {t('This page could not be loaded. Please try again.', 'Не удалось загрузить эту страницу. Попробуйте снова.')}
          {error.digest ? ` (${t('reference', 'код обращения')}: ${error.digest})` : null}
        </p>
        <button type="button" className="exc-apply-button" onClick={() => reset()}>
          {t('Try again', 'Попробовать снова')}
        </button>
      </div>
    </main>
  );
}
