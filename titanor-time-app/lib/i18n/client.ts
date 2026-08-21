import { DEFAULT_APP_LOCALE, LOCALE_STORAGE_KEY, normalizeToAppLocale, type AppLocale } from './locale';

/**
 * Client-only locale read — for the one subtree that structurally cannot resolve locale
 * server-side: app/worker-offline/page.tsx must stay byte-identical for every visitor (no
 * cookies()/headers()/resolveServerSession() anywhere in that tree — required for the service
 * worker to cache it safely, T7A.10C.1 §C). `app/worker-offline/OfflineShellClient.tsx` calls this
 * instead. SSR-safe (`typeof window === 'undefined'` returns the default so server and first
 * client render agree — never call this synchronously in a state initializer that could disagree
 * with SSR; callers correct it in a mount `useEffect`, same shape as `app/login/page.tsx`'s own
 * `readStoredLocale()`).
 */
export function readClientLocale(): AppLocale {
  if (typeof window === 'undefined') {
    return DEFAULT_APP_LOCALE;
  }
  return normalizeToAppLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
}
