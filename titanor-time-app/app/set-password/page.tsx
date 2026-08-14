'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';
const MIN_PASSWORD_LENGTH = 8;

function describeError(code: string | undefined): string {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return 'This activation code has expired. Ask your admin to issue a new one.';
    case 'TOKEN_USED':
      return 'This activation code has already been used.';
    case 'TOKEN_INVALID':
      return 'This activation code is not valid.';
    case 'ACCOUNT_NOT_ELIGIBLE':
      return 'This account is no longer eligible for activation.';
    case 'VALIDATION_ERROR':
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    default:
      return 'Something went wrong. Please try again.';
  }
}

function SetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activatedUsername, setActivatedUsername] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/set-initial-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ token, password })
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setErrorMessage(describeError(body?.error?.code));
        setLoading(false);
        return;
      }

      const body = (await response.json()) as { user: { username: string } };
      window.history.replaceState(null, '', '/set-password');
      setActivatedUsername(body.user.username);
      setLoading(false);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  async function copyUsername(): Promise<void> {
    if (!activatedUsername) {
      return;
    }
    try {
      await navigator.clipboard.writeText(activatedUsername);
      setCopied(true);
    } catch {
      // Clipboard API unavailable — the username is still shown as plain text.
    }
  }

  if (activatedUsername) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Account activated</h1>
          <p>Your username (for future logins):</p>
          <p>
            <strong>{activatedUsername}</strong>{' '}
            <button type="button" className="login-submit" onClick={copyUsername}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
          <button type="button" className="login-submit" onClick={() => router.push('/worker')}>
            Continue
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={handleSubmit} aria-busy={loading}>
        <h1>Set your password</h1>
        <p>At least {MIN_PASSWORD_LENGTH} characters.</p>

        <div className="login-field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            disabled={loading}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="login-field">
          <label htmlFor="confirm-password">Confirm password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            disabled={loading}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>

        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </main>
  );
}

// docs/titanor-time/01_SCREEN_MAP.md §1 `/set-password` — token carried via ?token= from
// /activate/[token]'s "Continue" link. Suspense boundary required by Next.js for useSearchParams
// in a page component.
export default function SetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPasswordForm />
    </Suspense>
  );
}
