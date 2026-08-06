'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

// Entry point for a code handed to the worker on paper. The token route remains the QR/deep-link
// destination; this form only normalizes the human-readable grouping before navigating there.
export default function ActivationCodePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = code.replace(/[-\s]/g, '').toUpperCase();
    if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(normalized)) {
      setError('Enter the 10-character activation code from your administrator.');
      return;
    }
    setError(null);
    router.push(`/activate/${encodeURIComponent(normalized)}`);
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Activate your account</h1>
        <p>Enter the activation code given to you by your administrator.</p>
        <div className="login-field">
          <label htmlFor="activation-code">Activation code</label>
          <input
            id="activation-code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            required
            maxLength={14}
            placeholder="XXXX-XXXX-XX"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="login-submit" type="submit">
          Continue
        </button>
      </form>
    </main>
  );
}
