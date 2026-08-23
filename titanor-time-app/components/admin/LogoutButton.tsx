'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

// Shared admin/foreman header logout button — same POST /api/auth/logout + CSRF-header +
// router.replace('/login') pattern as components/worker-pwa/WorkerAppNavigation.tsx's logout,
// just without that component's mobile-menu chrome around it (this sits directly in the header).
export function LogoutButton({ signOut, signingOut, error }: { signOut: string; signingOut: string; error: string }) {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function logout(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setErrorMessage(null);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) throw new Error('LOGOUT_FAILED');
      router.replace('/login');
      router.refresh();
    } catch {
      setErrorMessage(error);
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="admin-logout-button" disabled={pending} onClick={() => void logout()}>
        {pending ? signingOut : signOut}
      </button>
      {errorMessage ? (
        <span className="language-switcher-error" role="alert">
          {errorMessage}
        </span>
      ) : null}
    </>
  );
}
