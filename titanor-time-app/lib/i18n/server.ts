import { cookies } from 'next/headers';
import { resolveServerSession } from '@/lib/server-session';
import { normalizeToAppLocale, LOCALE_COOKIE_NAME, type AppLocale } from './locale';

/**
 * Server Component locale resolution — role-agnostic, reused unchanged by any future
 * Foreman/Admin i18n phase. Authenticated: `User.locale` (session, re-read fresh every request per
 * lib/auth.ts). Unauthenticated: the `NEXT_LOCALE` cookie set by `PATCH /api/me/locale` (or by
 * app/login/i18n.ts's own pre-auth switcher, same cookie name). Falls back to `DEFAULT_APP_LOCALE`
 * — never throws. Calls `resolveServerSession()` itself (React `cache()`-deduped per request) so
 * every call site just needs `const locale = await resolveAppLocale();`, no session plumbing.
 */
export async function resolveAppLocale(): Promise<AppLocale> {
  const session = await resolveServerSession();
  if (session) {
    return normalizeToAppLocale(session.user.locale);
  }
  const store = await cookies();
  return normalizeToAppLocale(store.get(LOCALE_COOKIE_NAME)?.value);
}
