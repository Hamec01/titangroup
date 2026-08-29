'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { WORKER_STRINGS, describeWorkerErrorCode } from '@/lib/i18n/worker';
import { getAllOutboxEvents } from '@/lib/offline-outbox/db';
import { dismissFailedEvent } from '@/lib/offline-outbox/outbox';
import { subscribeOutboxChanges } from '@/lib/offline-outbox/broadcast';

const CSRF_HEADER_VALUE = 'titanor-time';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;

interface ServerNotification {
  id: string;
  type: 'TIMESHEET_DEADLINE_APPROACHING';
  severity: 'INFO' | 'WARNING';
  deadlineAt: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
}

// A permanently-failed Check In/Out lives only in this bell now (T15/T16 moved it off the clock
// screen). It comes from the device's IndexedDB outbox, not the server.
interface FailedActionItem {
  clientEventId: string;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  errorCode: string | null;
}

function ruDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} дня`;
  return `${n} дней`;
}

function formatWeek(start: string | null, end: string | null, ru: boolean): string {
  if (!start || !end) return '';
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function deadlineLine(item: ServerNotification, ru: boolean, now: number): string {
  const week = formatWeek(item.periodStartDate, item.periodEndDate, ru);
  if (!item.deadlineAt) {
    return ru ? `Сдайте табель за неделю ${week}` : `Submit your timesheet for ${week}`;
  }
  const msLeft = new Date(item.deadlineAt).getTime() - now;
  if (msLeft < 0) {
    return ru
      ? `Табель за неделю ${week} просрочен — отправьте, иначе он уйдёт автоматически`
      : `The timesheet for ${week} is overdue — submit it, or it will be sent automatically`;
  }
  const days = Math.ceil(msLeft / DAY_MS);
  if (days <= 1) {
    return ru ? `Последний день сдать табель за неделю ${week}` : `Last day to submit the timesheet for ${week}`;
  }
  return ru ? `${ruDays(days)} до сдачи табеля за неделю ${week}` : `${days} days left to submit the timesheet for ${week}`;
}

export function WorkerNotificationBell() {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const t = WORKER_STRINGS[locale];
  const router = useRouter();
  const [serverItems, setServerItems] = useState<ServerNotification[]>([]);
  const [failedItems, setFailedItems] = useState<FailedActionItem[]>([]);
  const [open, setOpen] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);

  const loadServer = useCallback(async () => {
    try {
      const res = await fetch('/api/worker/notifications', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      setServerItems(Array.isArray(body.items) ? body.items : []);
    } catch {
      // offline / hiccup — non-blocking
    }
  }, []);

  const loadFailed = useCallback(async () => {
    try {
      const all = await getAllOutboxEvents();
      setFailedItems(
        all
          .filter((r) => r.state === 'FAILED_TERMINAL')
          .map((r) => ({ clientEventId: r.clientEventId, operationType: r.operationType, errorCode: r.lastErrorCode }))
      );
    } catch {
      // IndexedDB unavailable — just no failed items
    }
  }, []);

  useEffect(() => {
    void loadServer();
    void loadFailed();
    const onFocus = () => {
      void loadServer();
      void loadFailed();
    };
    window.addEventListener('focus', onFocus);
    const poll = window.setInterval(() => void loadServer(), POLL_INTERVAL_MS);
    const tick = window.setInterval(() => setNowTick(Date.now()), 60_000);
    const unsub = subscribeOutboxChanges(() => void loadFailed());
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(poll);
      window.clearInterval(tick);
      unsub();
    };
  }, [loadServer, loadFailed]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) && bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  async function dismissServer(id: string): Promise<void> {
    setServerItems((prev) => prev.filter((n) => n.id !== id));
    try {
      await fetch(`/api/worker/notifications/${id}/dismiss`, { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': CSRF_HEADER_VALUE } });
    } catch {
      // best-effort
    }
  }

  async function dismissFailed(clientEventId: string): Promise<void> {
    setFailedItems((prev) => prev.filter((f) => f.clientEventId !== clientEventId));
    try {
      await dismissFailedEvent(clientEventId);
    } catch {
      // best-effort
    }
  }

  function openTimesheet(): void {
    setOpen(false);
    router.push('/worker/periods');
  }

  const count = serverItems.length + failedItems.length;
  const hasWarning = failedItems.length > 0 || serverItems.some((n) => n.severity === 'WARNING');

  return (
    <div className="wk-notif-wrap">
      <button
        type="button"
        ref={bellRef}
        className="wk-notif-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={count > 0 ? (ru ? `Уведомления: ${count}` : `Notifications: ${count}`) : ru ? 'Уведомления' : 'Notifications'}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 10a6 6 0 1 1 12 0v4.2c0 .5.18.98.5 1.36L20 17.5H4l1.5-2c.32-.38.5-.86.5-1.36V10Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M9.5 20a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {count > 0 ? (
          <span className={`wk-notif-badge ${hasWarning ? 'warn' : ''}`} aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="wk-notif-panel" role="dialog" aria-label={ru ? 'Уведомления' : 'Notifications'} ref={panelRef}>
          <div className="wk-notif-panel-head">
            <h2>{ru ? 'Уведомления' : 'Notifications'}</h2>
            <button type="button" className="wk-notif-panel-close" onClick={() => setOpen(false)} aria-label={ru ? 'Закрыть' : 'Close'}>
              ×
            </button>
          </div>
          {count === 0 ? (
            <p className="wk-notif-empty">{ru ? 'Пока ничего нового.' : 'Nothing new.'}</p>
          ) : (
            <ul className="wk-notif-list">
              {failedItems.map((item) => (
                <li key={`f-${item.clientEventId}`} className="wk-notif-item warn">
                  <p className="wk-notif-item-scope">{item.operationType === 'CHECK_IN' ? t.checkIn : t.checkOut}</p>
                  <p className="wk-notif-item-text">{describeWorkerErrorCode(item.errorCode ?? undefined, t)}</p>
                  <p className="wk-notif-item-sub">{t.dismissFailedActionHint}</p>
                  <div className="wk-notif-item-actions">
                    <button type="button" className="wk-notif-item-hide" onClick={() => void dismissFailed(item.clientEventId)}>
                      {ru ? 'Убрать' : 'Dismiss'}
                    </button>
                  </div>
                </li>
              ))}
              {serverItems.map((item) => (
                <li key={`s-${item.id}`} className={`wk-notif-item ${item.severity === 'WARNING' ? 'warn' : ''}`}>
                  <p className="wk-notif-item-text">{deadlineLine(item, ru, nowTick)}</p>
                  <div className="wk-notif-item-actions">
                    <button type="button" className="wk-notif-item-link" onClick={openTimesheet}>
                      {ru ? 'Открыть табель' : 'Open timesheet'} →
                    </button>
                    <button type="button" className="wk-notif-item-hide" onClick={() => void dismissServer(item.id)}>
                      {ru ? 'Убрать' : 'Dismiss'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
