'use client';

import { useEffect, useRef, useState } from 'react';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §15 — POST
// /api/admin/users/:userId/activation. Shared by the /admin/users list (manual issue/reissue per
// row) and /admin/users/new's post-creation success view (auto-issue once). The API already
// returns activationCode pre-formatted as "XXXX-XXXX-XX" — never reformatted here. The raw code
// only ever lives in this component's own React state: never localStorage/sessionStorage, never
// console, gone the moment this component unmounts or the page refreshes.
const CSRF_HEADER_VALUE = 'titanor-time';

interface IssuedCode {
  code: string;
  expiresAt: string;
}

function describeIssueError(code: string | undefined): string {
  switch (code) {
    case 'USER_NOT_FOUND':
      return 'This user no longer exists.';
    case 'USER_ALREADY_ACTIVE':
      return 'This account has already been activated.';
    case 'USER_USES_WORKER_ACTIVATION':
      return 'This user is linked to a worker profile and uses the regular worker activation flow instead.';
    case 'ACCOUNT_NOT_ELIGIBLE':
      return 'This account is not eligible for activation right now.';
    case 'FORBIDDEN':
      return 'You no longer have permission to issue activation codes.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function ActivationCodeIssuer({ userId, autoIssue = false }: { userId: string; autoIssue?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoIssueFailed, setAutoIssueFailed] = useState(false);
  const [issuedCode, setIssuedCode] = useState<IssuedCode | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const autoIssueAttempted = useRef(false);

  async function handleIssue(isAutoAttempt: boolean): Promise<void> {
    if (loading) {
      return;
    }
    setError(null);
    setAutoIssueFailed(false);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/users/${userId}/activation`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': crypto.randomUUID()
        }
      });

      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setError(describeIssueError(code));
        setAutoIssueFailed(isAutoAttempt);
        setLoading(false);
        return;
      }

      const body = (await response.json()) as { activationCode: string; activationExpiresAt: string };
      setIssuedCode({ code: body.activationCode, expiresAt: body.activationExpiresAt });
      setCodeCopied(false);
      setLinkCopied(false);
      const activationUrl = `${window.location.origin}/activate-account/${body.activationCode}`;
      try {
        const QRCode = (await import('qrcode')).default;
        setQrDataUrl(await QRCode.toDataURL(activationUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 }));
      } catch {
        setQrDataUrl(null);
      }
      setLoading(false);
    } catch {
      setError('Network error. Please try again.');
      setAutoIssueFailed(isAutoAttempt);
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoIssue && !autoIssueAttempted.current) {
      autoIssueAttempted.current = true;
      void handleIssue(true);
    }
    // Fires once on mount only — this component is always mounted fresh per user, never reused
    // for a different userId in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyIssuedCode(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(issuedCode.code);
      setCodeCopied(true);
    } catch {
      // Clipboard API unavailable — the code is still shown as plain text below.
    }
  }

  async function copyActivationLink(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/activate-account/${issuedCode.code}`);
      setLinkCopied(true);
    } catch {
      // QR and the visible code remain available when Clipboard API is unavailable.
    }
  }

  if (issuedCode) {
    return (
      <div className="activation-print-card">
        <p className="login-error" role="alert">
          This code is shown only once — write it down, copy it, or print it now. It will not be shown again after
          you leave or refresh this page.
        </p>
        <p>
          <strong>{issuedCode.code}</strong>{' '}
          <button type="button" className="login-submit" onClick={copyIssuedCode}>
            {codeCopied ? 'Copied' : 'Copy code'}
          </button>
        </p>
        <p>Expires: {new Date(issuedCode.expiresAt).toLocaleString()}</p>
        {qrDataUrl ? (
          // Generated locally in this browser — the raw code is never sent to a third-party image service.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="activation-qr" src={qrDataUrl} alt="Foreman account activation QR code" />
        ) : null}
        <div className="activation-actions">
          <button type="button" className="login-submit" onClick={copyActivationLink}>
            {linkCopied ? 'Link copied' : 'Copy activation link'}
          </button>
          <button type="button" className="login-submit" onClick={() => window.print()}>
            Print code and QR
          </button>
          <button type="button" className="login-submit" disabled={loading} onClick={() => handleIssue(false)}>
            {loading ? 'Issuing…' : 'Issue / reissue activation code'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {autoIssueFailed ? (
        <p className="login-error" role="alert">
          Account created, but the activation code could not be issued automatically.
        </p>
      ) : null}
      <button type="button" className="login-submit" disabled={loading} onClick={() => handleIssue(false)}>
        {loading ? 'Issuing…' : 'Issue / reissue activation code'}
      </button>
      <p className="setup-subtitle">Reissuing revokes any previously issued code for this user.</p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
