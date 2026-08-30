'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

interface SessionRow {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
}

function deviceLabel(userAgent: string | null, ru: boolean): string {
  if (!userAgent) return ru ? 'Неизвестное устройство' : 'Unknown device';
  const ua = userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  return [browser, os].filter(Boolean).join(ru ? ' · ' : ' on ') || (ua.length > 40 ? `${ua.slice(0, 40)}…` : ua);
}

export function SessionsPanel() {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/me/sessions', { credentials: 'same-origin' });
      if (!response.ok) throw new Error('load');
      const body = await response.json();
      setRows(body.sessions);
    } catch {
      setError(ru ? 'Не удалось загрузить список сеансов.' : 'Could not load your sessions.');
    }
  }, [ru]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revokeOne(id: string): Promise<void> {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/me/sessions/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) throw new Error('revoke');
      await load();
    } catch {
      setError(ru ? 'Не удалось завершить сеанс.' : 'Could not end that session.');
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll(): Promise<void> {
    if (busy) return;
    setBusy('all');
    setError(null);
    try {
      const response = await fetch('/api/auth/logout-all', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok && response.status !== 204) throw new Error('all');
      window.location.href = '/login';
    } catch {
      setError(ru ? 'Не удалось выйти на всех устройствах.' : 'Could not sign out everywhere.');
      setBusy(null);
    }
  }

  return (
    <section className="account-settings" aria-labelledby="sessions-title">
      <h2 id="sessions-title">{ru ? 'Активные сеансы' : 'Active sessions'}</h2>
      <p className="setup-subtitle">{ru ? 'Устройства, на которых выполнен вход в вашу учётную запись.' : 'The devices currently signed in to your account.'}</p>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      {rows === null ? (
        <p className="form-status" role="status">{ru ? 'Загрузка…' : 'Loading…'}</p>
      ) : (
        <ul className="account-sessions-list">
          {rows.map((row) => (
            <li key={row.id} className="account-session-row">
              <div>
                <strong>{deviceLabel(row.userAgent, ru)}{row.current ? (ru ? ' — это устройство' : ' — this device') : ''}</strong>
                <span className="account-session-meta">
                  {row.ipAddress ?? (ru ? 'IP неизвестен' : 'IP unknown')} · {ru ? 'активность' : 'last active'} {new Date(row.lastSeenAt).toLocaleString(ru ? 'ru-RU' : 'en-GB')}
                </span>
              </div>
              {!row.current ? (
                <button type="button" className="wk-clock-cancel-button" onClick={() => revokeOne(row.id)} disabled={busy !== null}>
                  {busy === row.id ? (ru ? 'Завершение…' : 'Ending…') : (ru ? 'Завершить' : 'End')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="wk-clock-cancel-button" onClick={revokeAll} disabled={busy !== null}>
        {busy === 'all' ? (ru ? 'Выход…' : 'Signing out…') : (ru ? 'Выйти на всех устройствах' : 'Sign out everywhere')}
      </button>
    </section>
  );
}
