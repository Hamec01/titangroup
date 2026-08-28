'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminStrings } from '@/lib/i18n/admin';

const CSRF_HEADER_VALUE = 'titanor-time';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const TOAST_AUTO_HIDE_MS = 9000;

interface NotificationItem {
  id: string;
  type: string;
  severity: 'WARNING' | 'CRITICAL';
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  qualificationName: string | null;
  qualificationNameRu: string | null;
  expiresOn: string | null;
  threshold: number | null;
  createdAt: string;
  eventAt: string | null;
  // T12 §1a — TIMESHEET_AWAITING_APPROVAL
  timesheetId: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  timesheetIsRevision: boolean;
}

function formatWeek(startDate: string | null, endDate: string | null, locale: 'EN' | 'RU'): string {
  if (!startDate || !endDate) return '';
  const fmt = (d: string) => new Date(d).toLocaleDateString(locale === 'RU' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' });
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

// The small "when it happened" line under the severity tag — for a timesheet alert this is when
// the worker submitted / revised it, for a qualification alert when the alert was raised.
function formatEventAt(iso: string, locale: 'EN' | 'RU'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const loc = locale === 'RU' ? 'ru-RU' : 'en-GB';
  const date = d.toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' }).replace(' г.', '');
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 10a6 6 0 1 1 12 0v4.2c0 .5.18.98.5 1.36L20 17.5H4l1.5-2c.32-.38.5-.86.5-1.36V10Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9.5 20a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function summaryLine(item: NotificationItem, locale: 'EN' | 'RU', daysWord: (n: number) => string): string {
  if (item.type === 'TIMESHEET_AWAITING_APPROVAL') {
    const week = formatWeek(item.periodStartDate, item.periodEndDate, locale);
    if (item.timesheetIsRevision) {
      return locale === 'RU' ? `внёс правки в табель за неделю ${week} — нужно утвердить` : `revised the timesheet for ${week} — needs approval`;
    }
    return locale === 'RU' ? `сдал табель за неделю ${week} — нужно утвердить` : `submitted the timesheet for ${week} — needs approval`;
  }
  const name = locale === 'RU' && item.qualificationNameRu ? item.qualificationNameRu : item.qualificationName ?? '';
  if (item.type === 'QUALIFICATION_MISSING_EXPIRY') {
    return locale === 'RU' ? `${name} — не указан срок действия` : `${name} — expiry date missing`;
  }
  if (item.type === 'QUALIFICATION_EXPIRED' || !item.expiresOn) {
    return locale === 'RU' ? `${name} — истекло` : `${name} — expired`;
  }
  const days = Math.round((new Date(item.expiresOn).getTime() - Date.now()) / 86400000);
  if (days <= 0) {
    return locale === 'RU' ? `${name} — истекает сегодня` : `${name} — expires today`;
  }
  return locale === 'RU' ? `${name} — истекает через ${daysWord(days)}` : `${name} — expires in ${days} day${days === 1 ? '' : 's'}`;
}

function ruDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} дня`;
  return `${n} дней`;
}

export function NotificationCenter({ strings, locale }: { strings: AdminStrings; locale: 'EN' | 'RU' }) {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toasts, setToasts] = useState<NotificationItem[]>([]);
  const seenIds = useRef<Set<string> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/notifications', { credentials: 'same-origin' });
      if (!response.ok) return;
      const body = await response.json();
      const nextItems: NotificationItem[] = body.items ?? [];
      if (seenIds.current === null) {
        // First load this session: don't toast the entire backlog, just record it as seen.
        seenIds.current = new Set(nextItems.map((n) => n.id));
      } else {
        const fresh = nextItems.filter((n) => !seenIds.current!.has(n.id));
        for (const n of nextItems) seenIds.current!.add(n.id);
        if (fresh.length > 0) {
          setToasts((prev) => [...prev, ...fresh].slice(-3));
        }
      }
      setItems(nextItems);
    } catch {
      // Silent — notification center is a non-blocking convenience, not a critical path.
    }
  }, []);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = window.setTimeout(() => setToasts((prev) => prev.slice(1)), TOAST_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false);
    }
    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node) && bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setDrawerOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [drawerOpen]);

  async function handleDismiss(id: string): Promise<void> {
    setItems((prev) => prev.filter((n) => n.id !== id));
    await fetch(`/api/admin/notifications/${id}/dismiss`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
    });
  }

  function handleViewWorker(employeeId: string | null): void {
    setDrawerOpen(false);
    if (employeeId) router.push(`/admin/workers/${employeeId}/profile#qualifications`);
  }

  // T12 §1a — a timesheet-approval notification links to the timesheet card, not the worker dossier.
  function handleView(item: NotificationItem): void {
    setDrawerOpen(false);
    if (item.type === 'TIMESHEET_AWAITING_APPROVAL' && item.timesheetId) {
      router.push(`/admin/timesheets/${item.timesheetId}`);
      return;
    }
    if (item.employeeId) router.push(`/admin/workers/${item.employeeId}/profile#qualifications`);
  }

  const criticalCount = items.filter((i) => i.severity === 'CRITICAL').length;

  return (
    <>
      <div className="notif-bell-wrap">
        <button
          type="button"
          ref={bellRef}
          className="notif-bell-button"
          aria-label={items.length > 0 ? (locale === 'RU' ? `${items.length} активных уведомлений` : `${items.length} active notification${items.length === 1 ? '' : 's'}`) : strings.notificationBellLabel}
          aria-haspopup="true"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <BellIcon />
          {items.length > 0 ? (
            <span className={`notif-badge ${criticalCount > 0 ? 'notif-badge-critical' : 'notif-badge-warning'}`} aria-hidden="true">
              {items.length > 9 ? '9+' : items.length}
            </span>
          ) : null}
        </button>

        {drawerOpen ? (
          <div className="notif-drawer" role="dialog" aria-label={strings.notificationDrawerTitle} ref={panelRef}>
            <div className="notif-drawer-head">
              <h2>{strings.notificationDrawerTitle}</h2>
              <button type="button" className="notif-drawer-close" onClick={() => setDrawerOpen(false)} aria-label={strings.notificationClose}>
                ×
              </button>
            </div>
            {items.length === 0 ? (
              <p className="notif-drawer-empty">{strings.notificationDrawerEmpty}</p>
            ) : (
              <ul className="notif-drawer-list">
                {items.map((item) => (
                  <li key={item.id} className={`notif-drawer-item notif-drawer-item-${item.severity.toLowerCase()}`}>
                    <div className="notif-drawer-item-head">
                      <span className="notif-severity-tag">{item.severity === 'CRITICAL' ? strings.notificationSeverityCritical : strings.notificationSeverityWarning}</span>
                      <button type="button" className="notif-drawer-item-dismiss" onClick={() => handleDismiss(item.id)} aria-label={strings.notificationDismiss}>
                        ×
                      </button>
                    </div>
                    {item.eventAt ? <p className="notif-drawer-item-time">{formatEventAt(item.eventAt, locale)}</p> : null}
                    <p className="notif-drawer-item-name">{item.employeeName}</p>
                    <p className="notif-drawer-item-detail">{summaryLine(item, locale, ruDays)}</p>
                    {item.expiresOn ? <p className="notif-drawer-item-date">{item.expiresOn}</p> : null}
                    <div className="notif-drawer-item-actions">
                      <button type="button" className="notif-drawer-item-link" onClick={() => handleView(item)}>
                        {item.type === 'TIMESHEET_AWAITING_APPROVAL' ? (locale === 'RU' ? 'Открыть табель' : 'Open timesheet') : strings.notificationViewWorker} →
                      </button>
                      <button type="button" className="notif-drawer-item-hide" onClick={() => handleDismiss(item.id)}>
                        {locale === 'RU' ? 'Убрать' : 'Dismiss'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <div className="notif-toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`notif-toast notif-toast-${toast.severity.toLowerCase()}`}>
            <span className="notif-toast-icon" aria-hidden="true">
              !
            </span>
            <div className="notif-toast-body">
              <p className="notif-toast-name">{toast.employeeName}</p>
              {toast.eventAt ? <p className="notif-toast-time">{formatEventAt(toast.eventAt, locale)}</p> : null}
              <p className="notif-toast-detail">{summaryLine(toast, locale, ruDays)}</p>
            </div>
            <div className="notif-toast-actions">
              <button
                type="button"
                onClick={() => {
                  setToasts((prev) => prev.filter((t) => t.id !== toast.id));
                  handleView(toast);
                }}
              >
                {strings.notificationToastView}
              </button>
              <button type="button" aria-label={strings.notificationToastClose} onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
