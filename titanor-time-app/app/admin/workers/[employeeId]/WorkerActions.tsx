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
