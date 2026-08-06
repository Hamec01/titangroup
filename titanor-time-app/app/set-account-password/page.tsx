'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';
const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_LENGTH = 256;

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
      return `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`;
    case 'RATE_LIMITED':
      return 'Too many attempts. Try again later.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// docs/titanor-time/01_SCREEN_MAP.md — /set-account-password. Foreman counterpart to
// app/set-password/page.tsx (worker) — same shape (token via ?token=, password + confirm,
// remove token from the URL bar after success), different endpoint/destination: this one never
// sends a standalone FOREMAN to /worker, only /foreman.
function SetAccountPasswordForm() {
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

    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      setErrorMessage(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/set-account-password', {
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
      window.history.replaceState(null, '', '/set-account-password');
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
          <button type="button" className="login-submit" onClick={() => router.push('/foreman')}>
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
        <p>
          Between {MIN_PASSWORD_LENGTH} and {MAX_PASSWORD_LENGTH} characters.
        </p>

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

export default function SetAccountPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetAccountPasswordForm />
    </Suspense>
  );
}
