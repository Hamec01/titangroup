'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { LOCALE_STORAGE_KEY, type AppLocale } from '@/lib/i18n/locale';

const AppLocaleContext = createContext<AppLocale>('RU');

export function AppLocaleProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = locale === 'RU' ? 'ru' : 'en';
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Storage can be unavailable in private/restricted browsing. The server preference remains
      // authoritative online, so this must never prevent the UI from rendering.
    }
  }, [locale]);

  const value = useMemo(() => locale, [locale]);
  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

export function useAppLocale(): AppLocale {
  return useContext(AppLocaleContext);
}
