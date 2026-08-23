'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ExportBatchSummaryDto } from '@/lib/csv-export';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §BV — frozen idempotency attempt, the
// same state machine components/attendance-policy/PolicyForm.tsx already establishes (T7A.10B §7):
// one click -> one immutable attempt (UUID Idempotency-Key + this control's own read-only
// `periodId` prop, never re-read from anywhere else); a network failure keeps the SAME attempt
// alive for Retry; any definitive HTTP response (success or error, including a malformed/non-JSON
// body) concludes the attempt. Success is sticky — this component instance never offers a second
// Create button after one succeeds; the parent page mounts it with `key={periodId}`, so navigating
// to a DIFFERENT period remounts a fresh instance, while `router.refresh()` on the SAME period
// preserves this "already created" state on purpose (rule 6 — no automatic second export).

const CSRF_HEADER_VALUE = 'titanor-time';
const CREATE_BODY = '{}';

type CreateStatus = 'idle' | 'creating' | 'success' | 'error' | 'network-unknown';

interface Attempt {
  key: string;
  periodId: string;
}

function describeExportErrorCode(code: string | undefined, message: string | undefined, ru: boolean): string {
  switch (code) {
    case 'PERIOD_NOT_FOUND':
      return ru ? 'Этот расчётный период больше не существует.' : 'This payroll period no longer exists.';
    case 'PERIOD_NOT_EXPORTABLE':
      return ru ? 'Этот период всё ещё открыт — заблокируйте его перед выгрузкой.' : 'This period is still open — lock it before exporting.';
    case 'NOTHING_TO_EXPORT':
      return ru ? 'Нет одобренных корректировок, ожидающих выгрузки. Последний CSV актуален.' : 'No approved corrections are waiting for export. The latest CSV remains current.';
    case 'NOT_AUTHENTICATED':
      return ru ? 'Сессия истекла — войдите снова.' : 'Your session has expired — please log in again.';
    case 'FORBIDDEN':
      return ru ? 'У вас больше нет права создавать выгрузки.' : 'You no longer have permission to create exports.';
    case 'CSRF_REJECTED':
      return ru ? 'Сессию нужно обновить — перезагрузите страницу и попробуйте снова.' : 'Your session needs a refresh — please reload the page and try again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return ru ? 'Эту выгрузку не удалось выполнить как новый запрос. Перезагрузите страницу и попробуйте снова.' : 'This export could not be completed as a new request. Please reload and try again.';
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return ru ? 'Эта выгрузка всё ещё обрабатывается. Подождите немного и попробуйте снова.' : 'This export is still being processed. Please wait a moment and try again.';
    case 'VALIDATION_ERROR':
      return ru ? 'Перезагрузите страницу и попробуйте снова.' : 'Please reload the page and try again.';
    default:
      // Deliberately never surfaces `message` (raw server text) here — every code this endpoint
      // can actually return is named explicitly above; anything else (5xx, malformed/non-JSON
      // body) gets this generic, safe fallback instead of leaking server internals.
      void message;
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

export function ExportCreateControl({ periodId, buttonLabel }: { periodId: string; buttonLabel: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ExportBatchSummaryDto | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const pendingRef = useRef(false);

  async function runAttempt(a: Attempt): Promise<void> {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setStatus('creating');
    setAnnouncement(ru ? 'Создание выгрузки…' : 'Creating export…');
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/admin/periods/${a.periodId}/export`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': a.key },
        body: CREATE_BODY
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // No/invalid JSON body — falls through to the generic error message below. Still a
        // definitive HTTP response, so the attempt still concludes (rule 4).
      }

      if (res.ok && data?.batch) {
        setAttempt(null);
        setResult(data.batch as ExportBatchSummaryDto);
        setStatus('success');
        setAnnouncement(ru
          ? `Выгрузка создана: ${data.batch.kind === 'FULL' ? 'полная выгрузка' : 'выгрузка корректировок'}.`
          : `Export created: ${data.batch.kind === 'FULL' ? 'full export' : 'correction export'}.`);
        router.refresh();
        return;
      }

      // Every non-network outcome concludes this attempt — a rejected/poisoned key must never be
      // reused. The next Create click (a fresh mount or a genuinely new attempt) generates a new one.
      setAttempt(null);
      const code = data?.error?.code as string | undefined;
      const message = describeExportErrorCode(code, data?.error?.message, ru);
      setErrorMessage(message);
      setStatus('error');
      setAnnouncement(message);
    } catch {
      // Network failure/timeout — the request may or may not have reached the server. Keep the
      // SAME attempt (same key, same periodId, same body) alive for an explicit Retry.
      setStatus('network-unknown');
      const msg = ru ? 'Проблема с соединением — результат выгрузки неизвестен. «Повторить» отправит точно такой же запрос; можно нажимать ещё раз.' : 'Connection problem — the result of this export is unknown. Retry sends the exact same request; it is safe to click again.';
      setErrorMessage(msg);
      setAnnouncement(msg);
    } finally {
      pendingRef.current = false;
    }
  }

  async function handleCreate(): Promise<void> {
    if (pendingRef.current || status === 'success') {
      return;
    }
    const newAttempt: Attempt = { key: crypto.randomUUID(), periodId };
    setAttempt(newAttempt);
    await runAttempt(newAttempt);
  }

  async function handleRetry(): Promise<void> {
    if (pendingRef.current || !attempt) {
      return;
    }
    await runAttempt(attempt);
  }

  if (status === 'success' && result) {
    return (
      <div className="exp-create-panel exp-create-success" aria-live="polite">
        <p>
          {ru ? 'Выгрузка создана:' : 'Export created:'} <strong>{result.kind === 'FULL' ? (ru ? 'полная выгрузка' : 'Full export') : (ru ? 'выгрузка корректировок' : 'Correction export')}</strong>.
        </p>
        <p className="exp-create-links">
          <Link href={`/admin/export/${result.id}`}>{ru ? 'Подробнее' : 'View details'}</Link>
          {' · '}
          <a href={result.downloadUrl}>{ru ? 'Скачать CSV' : 'Download CSV'}</a>
        </p>
        <p className="exp-create-note">{ru ? 'Чтобы создать ещё одну выгрузку, перезагрузите страницу.' : 'To create another export, reload this page.'}</p>
      </div>
    );
  }

  return (
    <div className="exp-create-panel">
      {status === 'network-unknown' ? (
        <div className="exp-network-unknown" role="alert">
          <p>{errorMessage}</p>
          <button type="button" className="login-submit" onClick={handleRetry} disabled={pendingRef.current}>
            {ru ? 'Повторить' : 'Retry'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="exc-apply-button"
          onClick={handleCreate}
          disabled={status === 'creating'}
          aria-busy={status === 'creating'}
        >
          {status === 'creating' ? (ru ? 'Создание…' : 'Creating…') : buttonLabel}
        </button>
      )}

      {status === 'error' && errorMessage && (
        <p className="exp-error-banner" role="alert">
          {errorMessage}
        </p>
      )}

      <p className="exp-sr-announce" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
