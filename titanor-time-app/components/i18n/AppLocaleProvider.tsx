'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { LOCALE_STORAGE_KEY, type AppLocale } from '@/lib/i18n/locale';

const AppLocaleContext = createContext<AppLocale>('RU');

export function AppLocaleProvider({
  locale,
  persist = true,
  children
}: {
  locale: AppLocale;
  /**
   * Whether this provider is authoritative enough to write `locale` into localStorage (so the
   * offline PWA shell can read the last real choice). True for the authenticated section layouts,
   * whose `locale` is the server-resolved `User.locale` at first render. The offline shell passes
   * `false`: it is a *reader* of that stored preference, and it mounts with a transient default
   * before its own effect resolves the real value — persisting here would clobber the stored
   * RU/EN/FI choice with the placeholder.
   */
  persist?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.lang = locale === 'RU' ? 'ru' : 'en';
    if (!persist) {
      return;
    }
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Storage can be unavailable in private/restricted browsing. The server preference remains
      // authoritative online, so this must never prevent the UI from rendering.
    }
  }, [locale, persist]);

  const value = useMemo(() => locale, [locale]);
  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

export function useAppLocale(): AppLocale {
  return useContext(AppLocaleContext);
}
