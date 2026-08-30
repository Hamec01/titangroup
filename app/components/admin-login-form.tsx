'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export function AdminLoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'titanor-admin'
        },
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        setError(response.status === 429 ? 'Too many attempts. Please wait and try again.' : 'Wrong password. Please try again.');
        setIsLoading(false);
        return;
      }

      setPassword('');
      router.refresh();
    } catch {
      setError('Login failed. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <form className="admin-login-form" onSubmit={onSubmit}>
      <h1>Admin access</h1>
      <p>Private sign-in. Registration is disabled.</p>

      <label htmlFor="admin-password">Password</label>
      <input
        id="admin-password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        required
      />

      {error ? <p className="admin-form-error">{error}</p> : null}

      <button className="button-primary" type="submit" disabled={isLoading}>
        {isLoading ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  );
}
