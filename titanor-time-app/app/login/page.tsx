'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  DEFAULT_LOGIN_LOCALE,
  LOGIN_LOCALES,
  LOGIN_LOCALE_COOKIE_NAME,
  LOGIN_LOCALE_STORAGE_KEY,
  LOGIN_STRINGS,
  isLoginLocale,
  type LoginLocale
} from './i18n';
import { recordAuthenticatedUser } from '@/lib/offline-outbox/device';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every
// mutating request, checked server-side by POST /api/auth/login.
const CSRF_HEADER_VALUE = 'titanor-time';

// docs/titanor-time/PRODUCTION_RELEASE_TZ_FINAL_RU.md §19.5: the operational
// Today/Overview page is the normal ADMIN/SUPER_ADMIN landing. Setup remains
// available from the admin navigation, but is no longer the post-login home.
function resolveHomeRoute(roles: string[]): string | null {
  if (roles.includes('SUPER_ADMIN') || roles.includes('ADMIN')) {
    return '/admin';
  }
  if (roles.includes('FOREMAN')) {
    return '/foreman';
  }
  if (roles.includes('WORKER')) {
    return '/worker';
  }
  return null;
}

function readStoredLocale(): LoginLocale {
  if (typeof window === 'undefined') {
    return DEFAULT_LOGIN_LOCALE;
  }
  const stored = window.localStorage.getItem(LOGIN_LOCALE_STORAGE_KEY);
  return stored && isLoginLocale(stored) ? stored : DEFAULT_LOGIN_LOCALE;
}

export default function LoginPage() {
  const router = useRouter();
  const [locale, setLocale] = useState<LoginLocale>(DEFAULT_LOGIN_LOCALE);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // AUTH SECURITY HOTFIX — identical `false` on the server render and on the first client render
  // (before any effect runs), so this can never cause a hydration mismatch. Flips to `true` only
  // once React has actually mounted and attached handleSubmit — see the submit button below. This
  // is what closes the pre-hydration window itself, not just a courtesy UX touch.
  const [hydrated, setHydrated] = useState(false);

  const t = LOGIN_STRINGS[locale];

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    setLocale(readStoredLocale());
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale.toLowerCase();
  }, [locale]);

  function changeLocale(next: LoginLocale): void {
    setLocale(next);
    window.localStorage.setItem(LOGIN_LOCALE_STORAGE_KEY, next);
    // 1 year, Path=/ — a plain preference cookie, not a session credential;
    // no HttpOnly (the client itself needs to read/rewrite it) and no
    // Secure requirement blocks local http:// development.
    document.cookie = `${LOGIN_LOCALE_COOKIE_NAME}=${next}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE
        },
        body: JSON.stringify({ identifier, password })
      });

      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body (e.g. an upstream proxy/edge failure) — fall
          // through to the generic message below.
        }

        switch (code) {
          case 'ACCOUNT_PENDING_ACTIVATION':
            setErrorMessage(t.errorPendingActivation);
            break;
          case 'ACCOUNT_DEACTIVATED':
            setErrorMessage(t.errorDeactivated);
            break;
          case 'RATE_LIMITED':
            setErrorMessage(t.errorRateLimited);
            break;
          case 'INVALID_CREDENTIALS':
            setErrorMessage(t.errorInvalidCredentials);
            break;
          default:
            setErrorMessage(t.errorGeneric);
        }
        setLoading(false);
        return;
      }

      const body = (await response.json()) as { user: { id: string; roles: string[] } };
      const target = resolveHomeRoute(body.user.roles);
      if (!target) {
        setErrorMessage(t.noRole);
        setLoading(false);
        return;
      }
      // docs/titanor-time/T8_PWA_DESIGN.md §F.3 — records "who is now logged in in this browser"
      // for ANY role, before navigating away. An IndexedDB failure here must never block or slow
      // down a successful login — swallowed deliberately, offline snapshot display simply fails
      // closed later if this never completes.
      try {
        await recordAuthenticatedUser(body.user.id);
      } catch {
        // Intentionally ignored — see comment above.
      }
      router.push(target);
      // Deliberately not resetting `loading` here — the form stays disabled
      // through navigation instead of flashing back to interactive right
      // before the route changes.
    } catch {
      // Network failure, DNS, connection reset, etc. — never let this reach
      // an uncaught rejection/blank screen.
      setErrorMessage(t.errorGeneric);
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <a href="/guide" className="login-guide-link">
        {t.guideLink}
      </a>
      <div className="login-locale-switch" role="group" aria-label="Language">
        {LOGIN_LOCALES.map((code) => (
          <button
            key={code}
            type="button"
            aria-pressed={locale === code}
            onClick={() => changeLocale(code)}
          >
            {code}
          </button>
        ))}
      </div>

      {/* AUTH SECURITY HOTFIX — method/action are a real, safe native fallback (POST never puts
          the body in the URL/history, unlike the browser's GET default that applies when these
          are omitted), for the window before handleSubmit is attached or if JS never loads at
          all. The hydrated React path below still calls event.preventDefault() first and posts
          JSON with the required CSRF header via fetch — method/action never fire once that runs.
          A native fallback submission (no JS) hits this same endpoint without that header and
          gets a safe 403 CSRF_REJECTED — it was never able to complete a login without JS before
          this fix either, so nothing that used to work stops working. */}
      <form className="login-card" method="post" action="/api/auth/login" onSubmit={handleSubmit} aria-busy={loading}>
        {/* eslint-disable-next-line @next/next/no-img-element -- single
            static local asset, not worth next/image's optimization
            pipeline (and its sharp dependency) for one small logo */}
        <img className="login-logo" src="/titanor-logo.png" alt="Titanor" width={1080} height={369} />
        <h1>{t.subtitle}</h1>

        <div className="login-field">
          <label htmlFor="identifier">{t.identifierLabel}</label>
          <input
            id="identifier"
            name="identifier"
            type="text"
            autoComplete="username"
            required
            disabled={loading}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
          />
        </div>

        <div className="login-field">
          <label htmlFor="password">{t.passwordLabel}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={loading}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        {/* AUTH SECURITY HOTFIX — disabled until `hydrated` flips true, i.e. until React has
            actually attached handleSubmit: with no enabled submit control, neither a click nor
            Enter-key implicit submission can fire at all during that gap, so the native
            method/action fallback above never actually gets exercised in the common case (JS
            present, hydration just hasn't finished yet) — it only remains as the safety net for
            JS-disabled clients, who could not complete a login natively before this fix either
            (see the form's own comment). autoComplete/name/password-manager behavior on the
            inputs themselves is untouched — only the submit control is gated. */}
        <button className="login-submit" type="submit" disabled={loading || !hydrated}>
          {loading ? t.submitting : t.submit}
        </button>
        <Link className="login-secondary-link" href="/reset-password">
          {t.forgotPassword}
        </Link>
      </form>
    </main>
  );
}
