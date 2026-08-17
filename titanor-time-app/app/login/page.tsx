'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_LOGIN_LOCALE,
  LOGIN_LOCALES,
  LOGIN_LOCALE_COOKIE_NAME,
  LOGIN_LOCALE_STORAGE_KEY,
  LOGIN_STRINGS,
  isLoginLocale,
  type LoginLocale
} from './i18n';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every
// mutating request, checked server-side by POST /api/auth/login.
const CSRF_HEADER_VALUE = 'titanor-time';

// docs/titanor-time/01_SCREEN_MAP.md §1 (/login "Куда") gives the real
// target routes (/admin, /worker/periods/[periodId]), none of which are
// built yet. Per this task's explicit instruction, the destinations below
// are the owner-specified ones for this checkpoint — SUPER_ADMIN/ADMIN and
// FOREMAN destinations don't exist as real pages yet either (only the next
// checkpoint, /admin/setup, is planned), so this redirect will 404 until
// those land. Not a bug in this page — no placeholder page is faked in to
// hide that.
function resolveHomeRoute(roles: string[]): string | null {
  if (roles.includes('SUPER_ADMIN') || roles.includes('ADMIN')) {
    return '/admin/setup';
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

      const body = (await response.json()) as { user: { roles: string[] } };
      const target = resolveHomeRoute(body.user.roles);
      if (!target) {
        setErrorMessage(t.noRole);
        setLoading(false);
        return;
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
      </form>
    </main>
  );
}
