'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkerDetail } from '@/lib/workers';

const CSRF_HEADER_VALUE = 'titanor-time';

export function WorkerActions({ worker }: { worker: WorkerDetail }) {
  const router = useRouter();

  const [firstName, setFirstName] = useState(worker.firstName);
  const [lastName, setLastName] = useState(worker.lastName);
  const [phone, setPhone] = useState(worker.phone ?? '');
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [showDeactivate, setShowDeactivate] = useState(false);
  const [reason, setReason] = useState('');
  const [endDate, setEndDate] = useState('');
  const [deactivateLoading, setDeactivateLoading] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const [activationLoading, setActivationLoading] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  function formatCodeForDisplay(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 10)}`;
  }

  async function handleIssueActivation(): Promise<void> {
    if (activationLoading) {
      return;
    }
    setActivationError(null);
    setActivationLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}/activation`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': crypto.randomUUID()
        }
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'SETUP_INCOMPLETE':
            setActivationError('This worker needs a current site assignment and an open payroll period first.');
            break;
          case 'WORKER_ALREADY_ACTIVE':
            setActivationError('This worker has already activated their account.');
            break;
          case 'FORBIDDEN':
            setActivationError('You no longer have permission to issue activation codes.');
            break;
          default:
            setActivationError('Something went wrong. Please try again.');
        }
        setActivationLoading(false);
        return;
      }

      const body = (await response.json()) as { activationCode: string; activationExpiresAt: string };
      setIssuedCode({ code: body.activationCode, expiresAt: body.activationExpiresAt });
      setCodeCopied(false);
      setLinkCopied(false);
      const activationUrl = `${window.location.origin}/activate/${body.activationCode}`;
      try {
        const QRCode = (await import('qrcode')).default;
        setQrDataUrl(await QRCode.toDataURL(activationUrl, { errorCorrectionLevel: 'M', margin: 2, width: 256 }));
      } catch {
        setQrDataUrl(null);
      }
      setActivationLoading(false);
    } catch {
      setActivationError('Network error. Please try again.');
      setActivationLoading(false);
    }
  }

  async function copyActivationLink(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/activate/${issuedCode.code}`);
      setLinkCopied(true);
    } catch {
      // QR and the visible code remain available when Clipboard API is unavailable.
    }
  }

  async function copyIssuedCode(): Promise<void> {
    if (!issuedCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(formatCodeForDisplay(issuedCode.code));
      setCodeCopied(true);
    } catch {
      // Clipboard API unavailable — the code is still shown as plain text below.
    }
  }

  async function parseErrorCode(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as { error?: { code?: string } };
      return body.error?.code;
    } catch {
      return undefined;
    }
  }

  async function handleEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (editLoading) {
      return;
    }
    setEditError(null);
    setEditLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: worker.version, firstName, lastName, phone: phone || null })
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'VALIDATION_ERROR':
            setEditError('Please check the fields above.');
            break;
          case 'VERSION_CONFLICT':
            setEditError('This worker was changed elsewhere — reloading.');
            router.refresh();
            break;
          case 'FORBIDDEN':
            setEditError('You no longer have permission to edit workers.');
            break;
          default:
            setEditError('Something went wrong. Please try again.');
        }
        setEditLoading(false);
        return;
      }

      router.refresh();
      setEditLoading(false);
    } catch {
      setEditError('Network error. Please try again.');
      setEditLoading(false);
    }
  }

  async function handleDeactivate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (deactivateLoading) {
      return;
    }
    setDeactivateError(null);
    setDeactivateLoading(true);

    try {
      const response = await fetch(`/api/admin/workers/${worker.id}/deactivate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ reason, endDate: endDate || undefined })
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        switch (code) {
          case 'VALIDATION_ERROR':
            setDeactivateError('A reason is required.');
            break;
          case 'ALREADY_DEACTIVATED':
            setDeactivateError('This worker is already deactivated.');
            break;
          case 'FORBIDDEN':
            setDeactivateError('You no longer have permission to deactivate workers.');
            break;
          default:
            setDeactivateError('Something went wrong. Please try again.');
        }
        setDeactivateLoading(false);
        return;
      }

      router.refresh();
      setDeactivateLoading(false);
      setShowDeactivate(false);
    } catch {
      setDeactivateError('Network error. Please try again.');
      setDeactivateLoading(false);
    }
  }

  return (
    <>
      <h2>Edit</h2>
      <form onSubmit={handleEdit} aria-busy={editLoading}>
        <div className="login-field">
          <label htmlFor="edit-first-name">First name</label>
          <input
            id="edit-first-name"
            type="text"
            required
            disabled={editLoading}
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="edit-last-name">Last name</label>
          <input
            id="edit-last-name"
            type="text"
            required
            disabled={editLoading}
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="edit-phone">Phone</label>
          <input
            id="edit-phone"
            type="tel"
            disabled={editLoading}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        {editError ? (
          <p className="login-error" role="alert">
            {editError}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={editLoading}>
          {editLoading ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <h2>Activation</h2>
      {worker.activationStatus === 'READY_FOR_ACTIVATION' ? (
        <section className={issuedCode ? 'activation-print-card' : undefined}>
          {issuedCode ? (
            <div>
              <p className="login-error" role="alert">
                This code is shown only once — write it down or copy it now. It will not be shown again.
              </p>
              <p>
                <strong>{formatCodeForDisplay(issuedCode.code)}</strong>{' '}
                <button type="button" className="login-submit" onClick={copyIssuedCode}>
                  {codeCopied ? 'Copied' : 'Copy'}
                </button>
              </p>
              <p>Expires: {new Date(issuedCode.expiresAt).toLocaleString()}</p>
              {qrDataUrl ? (
                // The QR is generated locally in this browser; the raw activation code is never
                // sent to a third-party image service.
                // eslint-disable-next-line @next/next/no-img-element
                <img className="activation-qr" src={qrDataUrl} alt="Worker activation QR code" />
              ) : null}
              <div className="activation-actions">
                <button type="button" className="login-submit" onClick={copyActivationLink}>
                  {linkCopied ? 'Link copied' : 'Copy activation link'}
                </button>
                <button type="button" className="login-submit" onClick={() => window.print()}>
                  Print code and QR
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="login-submit" disabled={activationLoading} onClick={handleIssueActivation}>
              {activationLoading ? 'Issuing…' : 'Issue activation code'}
            </button>
          )}
          {activationError ? (
            <p className="login-error" role="alert">
              {activationError}
            </p>
          ) : null}
        </section>
      ) : worker.activationStatus === 'SETUP_INCOMPLETE' ? (
        <div>
          <button type="button" className="login-submit" disabled title="Assign the worker to a site and open a payroll period first.">
            Issue activation code
          </button>
          <p>Assign the worker to a site and open a payroll period first.</p>
        </div>
      ) : (
        <p>This worker has already activated their account.</p>
      )}

      {worker.employment?.active ? (
        <>
          <h2>Deactivate</h2>
          {!showDeactivate ? (
            <button type="button" className="login-submit" onClick={() => setShowDeactivate(true)}>
              Deactivate worker
            </button>
          ) : (
            <form onSubmit={handleDeactivate} aria-busy={deactivateLoading}>
              <div className="login-field">
                <label htmlFor="deactivate-reason">Reason</label>
                <textarea
                  id="deactivate-reason"
                  required
                  rows={3}
                  disabled={deactivateLoading}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="login-field">
                <label htmlFor="deactivate-end-date">End date (optional — defaults to today)</label>
                <input
                  id="deactivate-end-date"
                  type="date"
                  disabled={deactivateLoading}
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
              {deactivateError ? (
                <p className="login-error" role="alert">
                  {deactivateError}
                </p>
              ) : null}
              <button className="login-submit" type="submit" disabled={deactivateLoading}>
                {deactivateLoading ? 'Deactivating…' : 'Confirm deactivation'}
              </button>
            </form>
          )}
        </>
      ) : null}
    </>
  );
}
