'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from './AppLocaleProvider';
import type { AppLocale } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const locale = useAppLocale();
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startTransition] = useTransition();

  useEffect(() => {
    pendingRef.current = false;
    setPending(false);
  }, [locale]);

  async function changeLocale(nextLocale: AppLocale) {
    if (nextLocale === locale || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/me/locale', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ locale: nextLocale })
      });
      if (!response.ok) throw new Error('LOCALE_UPDATE_FAILED');
      startTransition(() => router.refresh());
    } catch {
      setError(locale === 'RU' ? 'Не удалось сменить язык.' : 'Could not change language.');
      pendingRef.current = false;
      setPending(false);
    }
  }

  const busy = pending || isRefreshing;
  return (
    <div className={compact ? 'language-switcher language-switcher-compact' : 'language-switcher'}>
      <span className="sr-only">{locale === 'RU' ? 'Язык' : 'Language'}</span>
      <button type="button" disabled={busy || locale === 'RU'} aria-pressed={locale === 'RU'} onClick={() => void changeLocale('RU')}>RU</button>
      <button type="button" disabled={busy || locale === 'EN'} aria-pressed={locale === 'EN'} onClick={() => void changeLocale('EN')}>EN</button>
      {error ? <span className="language-switcher-error" role="alert">{error}</span> : null}
    </div>
  );
}
