'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ResolutionContext,
  ResolutionActionName,
  PairCandidateEvent,
  AssignmentCandidate,
  EditFragmentCandidate
} from '@/lib/attendance-exception-resolution-context';
import { exceptionTypeLabel, channelLabel, formatDateTime } from '@/lib/attendance-exceptions-ui';
import { helsinkiDateTimeLocalToUtcIso, utcIsoToHelsinkiDateTimeLocal } from '@/lib/helsinki-datetime';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5/§9.7-§9.9/§11-§12.4 — T7A.8C.2. Renders
// only what lib/attendance-exception-resolution-context.ts's getResolutionContext already computed
// and role/scope-filtered server-side; every mutation goes through the SAME existing POST
// .../resolve or .../edit endpoints as any other client (curl, Postman), with the same CSRF header
// and full server-side re-validation. This component is a UI convenience, never a second
// authorization boundary — every outcome branch below already assumes the POST can 403/404/409 for
// reasons this panel's own (advisory, possibly stale-by-a-few-seconds) `context` prop didn't predict.

const CSRF_HEADER_VALUE = 'titanor-time';

const ACTION_LABELS: Record<ResolutionActionName, { en: string; ru: string }> = {
  // T12 — was "Dismiss / Отклонить", which read as "reject the hours"; this action changes nothing
  // about the event or the hours, it only clears the alert from the queue.
  DISMISS: { en: 'Clear alert', ru: 'Снять сигнал' },
  ACKNOWLEDGE_AS_VALID: { en: 'Acknowledge as valid', ru: 'Подтвердить как верное' },
  PAIR_ORPHAN_EVENTS: { en: 'Pair with another event', ru: 'Связать с другим событием' },
  CONFIRM_SOURCE_ASSIGNMENT: { en: 'Confirm site assignment', ru: 'Подтвердить назначение объекта' },
  FORCE_CLOSE_OPEN_SHIFT: { en: 'Force close open shift', ru: 'Принудительно закрыть смену' },
  REASON_EDIT: { en: 'Edit reported time', ru: 'Изменить заявленное время' }
};

function actionLabel(action: ResolutionActionName, locale: AppLocale): string {
  return locale === 'RU' ? ACTION_LABELS[action].ru : ACTION_LABELS[action].en;
}

const ERROR_MESSAGES: Record<string, { en: string; ru: string }> = {
  CSRF_REJECTED: { en: 'Your session needs a refresh — please reload the page and try again.', ru: 'Сессию нужно обновить — перезагрузите страницу и попробуйте снова.' },
  NOT_AUTHENTICATED: { en: 'Your session has expired — please log in again.', ru: 'Сессия истекла — войдите снова.' },
  FORBIDDEN: { en: 'You no longer have permission to do this — the page has been refreshed.', ru: 'У вас больше нет права на это действие — страница обновлена.' },
  EXCEPTION_NOT_FOUND: { en: 'This exception could not be found — it may have been removed, or you no longer have access.', ru: 'Это исключение не найдено — возможно, оно было удалено, или у вас больше нет доступа.' },
  EXCEPTION_ALREADY_RESOLVED: { en: 'This exception was already resolved by someone else — showing the latest state.', ru: 'Это исключение уже решено кем-то другим — показано актуальное состояние.' },
  ACTION_NOT_APPLICABLE: { en: 'This action no longer applies to this exception — showing the latest state.', ru: 'Это действие больше не применимо к этому исключению — показано актуальное состояние.' },
  FOREMAN_SCOPE_INCOMPLETE: { en: 'This exception now touches a site outside your current assignments.', ru: 'Это исключение теперь относится к объекту вне ваших текущих назначений.' },
  OPEN_SHIFT_STILL_PENDING: { en: 'The originating shift is still open — the alert cannot be cleared yet.', ru: 'Исходная смена всё ещё открыта — сигнал пока снять нельзя.' },
  VALIDATION_ERROR: { en: 'Please check the highlighted fields.', ru: 'Проверьте выделенные поля.' },
  CLOCK_EVENT_NOT_FOUND: { en: 'One of the selected events could no longer be found — showing the latest state.', ru: 'Одно из выбранных событий больше не найдено — показано актуальное состояние.' },
  EVENT_ALREADY_PAIRED: { en: 'One of these events was just paired by someone else — showing the latest state.', ru: 'Одно из этих событий только что было связано кем-то другим — показано актуальное состояние.' },
  PAIRED_SHIFT_OVERLAP: { en: 'This pair would overlap an existing shift for this employee. Choose a different event.', ru: 'Эта пара пересечётся с существующей сменой этого работника. Выберите другое событие.' },
  TARGET_NOT_FOUND: { en: 'The target for this confirmation could no longer be found — showing the latest state.', ru: 'Цель для этого подтверждения больше не найдена — показано актуальное состояние.' },
  TARGET_ALREADY_RESOLVED: { en: 'This was already confirmed — showing the latest state.', ru: 'Это уже было подтверждено — показано актуальное состояние.' },
  OPEN_SHIFT_ALREADY_CLOSED: { en: 'This shift is no longer open — a Check Out may have already arrived. Use "Clear alert" instead.', ru: 'Эта смена больше не открыта — возможно, уход уже был зафиксирован. Используйте «Снять сигнал».' },
  TARGET_NOT_EDITABLE: { en: 'There is no live editable entry for this fragment anymore — showing the latest state.', ru: 'Для этого фрагмента больше нет доступной для редактирования записи — показано актуальное состояние.' },
  DRAFT_NOT_EDITABLE: { en: 'This timesheet is no longer in a draft/returned state — showing the latest state.', ru: 'Этот табель больше не в состоянии черновика/возврата — показано актуальное состояние.' },
  OVERLAP_STILL_PRESENT: { en: 'This change does not fully resolve the overlap between the two shifts. Adjust the times and try again.', ru: 'Это изменение не устраняет пересечение полностью между двумя сменами. Скорректируйте время и попробуйте снова.' },
  BREAK_OUTSIDE_SEGMENT: { en: 'An existing break would fall outside the new time range.', ru: 'Существующий перерыв выйдет за пределы нового диапазона времени.' },
  WORK_SEGMENT_OVERLAP: { en: 'This change would overlap another interval on the same day.', ru: 'Это изменение пересечётся с другим интервалом в тот же день.' },
  SITE_NOT_ASSIGNED: { en: 'This employee has no active assignment for that site/work area on this date.', ru: 'У этого работника нет активного назначения на этот объект/зону на эту дату.' }
};

function describeErrorCode(code: string | undefined, fallback: string | undefined, locale: AppLocale): string {
  if (code && ERROR_MESSAGES[code]) {
    return locale === 'RU' ? ERROR_MESSAGES[code].ru : ERROR_MESSAGES[code].en;
  }
  return fallback ? fallback : (locale === 'RU' ? 'Что-то пошло не так. Проверьте и попробуйте снова.' : 'Something went wrong. Please review and try again.');
}

interface ErrorState {
  message: string;
  fieldErrors?: Record<string, string[]>;
  requestId?: string;
}

interface MutationResult {
  ok: boolean;
  code?: string;
  fieldErrors?: Record<string, string[]>;
}

/** Shared low-level mutation primitive for every one of the six action forms below — one POST
 * call, one synchronous double-click guard, one refresh/error-reconciliation policy. A ref (not
 * state) gates re-entry: it is set synchronously before the first `await`, so a second click fired
 * before React has re-rendered the disabled button still bails out immediately (task §9). */
function useResolutionMutation(url: string, locale: AppLocale) {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  async function submit(body: unknown): Promise<MutationResult> {
    if (pendingRef.current) {
      return { ok: false };
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setAnnouncement(locale === 'RU' ? 'Отправка…' : 'Submitting…');

    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify(body)
      });
      let data: { error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]>; requestId?: string } } | null = null;
      try {
        data = await res.json();
      } catch {
        // No/invalid JSON body — fall through to the generic message below.
      }

      if (res.ok) {
        setAnnouncement(locale === 'RU' ? 'Действие выполнено — обновление.' : 'Action completed — refreshing.');
        router.refresh();
        return { ok: true };
      }

      const code = data?.error?.code;
      const requestId = data?.error?.requestId;
      const fieldErrors = data?.error?.fieldErrors;
      const message = describeErrorCode(code, data?.error?.message, locale);
      setError({ message, fieldErrors, requestId });
      setAnnouncement(message);
      // 403/404/409 all mean "the world moved since this page loaded" in one way or another
      // (permission revoked, target vanished, status/target/assignment changed) — refresh so the
      // server-computed context/detail catches up. 400 VALIDATION_ERROR is purely about THIS
      // request's shape, not server state, so it does not refresh (no point, and it would just
      // discard nothing useful either way — router.refresh() never clears this component's own
      // local input state, only the read-only context/detail props threaded down from the server).
      if (res.status === 403 || res.status === 404 || res.status === 409) {
        router.refresh();
      }
      return { ok: false, code, fieldErrors };
    } catch {
      // Network failure/timeout — the mutation may or may not have reached the server. Never
      // auto-retry; refresh so the next render reflects whatever actually happened, and let the
      // human decide whether to submit again (task §9/§10).
      const connectionMessage = locale === 'RU'
        ? 'Проблема с соединением — страница обновлена с последним известным состоянием. Ничего не было отправлено повторно автоматически; проверьте перед повторной попыткой.'
        : 'Connection problem — the page has been refreshed with the latest known state. Nothing was resubmitted automatically; please check below before retrying.';
      setAnnouncement(locale === 'RU' ? 'Проблема с соединением — показано последнее известное состояние.' : 'Connection problem — refreshed with the latest known state. Please check below before retrying.');
      setError({ message: connectionMessage });
      router.refresh();
      return { ok: false };
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return { submit, pending, error, announcement };
}

function AnnouncementRegion({ text }: { text: string }) {
  return (
    <p className="exc-sr-announce" role="status" aria-live="polite">
      {text}
    </p>
  );
}

function ErrorBanner({ error, locale }: { error: ErrorState; locale: AppLocale }) {
  return (
    <div className="exc-action-error" role="alert">
      <p>{error.message}</p>
      {error.requestId && <p className="exc-muted">{locale === 'RU' ? 'Код запроса:' : 'Reference:'} {error.requestId}</p>}
    </div>
  );
}

function FieldError({ fieldErrors, field }: { fieldErrors: Record<string, string[]> | undefined; field: string }) {
  const messages = fieldErrors?.[field];
  if (!messages || messages.length === 0) {
    return null;
  }
  return (
    <p className="exc-field-error" role="alert">
      {messages.join('; ')}
    </p>
  );
}

/** Explicit two-step confirmation (task §8: "не использовать неоформленный window.confirm как
 * единственный UX") — the primary button only ARMS the confirm step; a second, separate click
 * inside a clearly-labelled inline panel actually submits. Re-used by all six forms below. */
function ConfirmGate({ armed, onArm, onCancel, onConfirm, pending, primaryLabel, summary, disabled, danger, locale }: {
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  primaryLabel: string;
  summary: string;
  disabled?: boolean;
  danger?: boolean;
  locale: AppLocale;
}) {
  const ru = locale === 'RU';
  if (!armed) {
    return (
      <button type="button" className={danger ? 'exc-apply-button exc-action-danger-button' : 'exc-apply-button'} onClick={onArm} disabled={disabled}>
        {primaryLabel}
      </button>
    );
  }
  return (
    <div className="exc-confirm-box" role="group" aria-label={ru ? 'Подтвердите действие' : 'Confirm action'}>
      <p>{summary}</p>
      <div className="exc-confirm-actions">
        <button type="button" className={danger ? 'exc-apply-button exc-action-danger-button' : 'exc-apply-button'} onClick={onConfirm} disabled={pending}>
          {pending ? (ru ? 'Отправка…' : 'Submitting…') : (ru ? 'Да, подтвердить' : 'Yes, confirm')}
        </button>
        <button type="button" className="exc-reset-link" onClick={onCancel} disabled={pending}>
          {ru ? 'Отмена' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// DISMISS / ACKNOWLEDGE_AS_VALID
// ---------------------------------------------------------------------------------------------

function DismissAckForm({ apiBasePath, exceptionId, action, chronologyNoteRequired }: { apiBasePath: string; exceptionId: string; action: 'DISMISS' | 'ACKNOWLEDGE_AS_VALID'; chronologyNoteRequired: boolean }) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`, locale);
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);

  const noteRequired = action === 'DISMISS' && chronologyNoteRequired;
  const noteMissing = noteRequired && note.trim().length === 0;

  async function handleConfirm() {
    const result = await submit({ action, resolutionNote: note.trim().length > 0 ? note.trim() : undefined });
    if (!result.ok) {
      setArmed(false);
    }
  }

  return (
    <div className="exc-action-form">
      <p className="exc-muted">
        {action === 'DISMISS'
          ? (ru ? 'Убирает сигнал из очереди. Часы, смена и отметки НЕ меняются — это не признание события верным и не исправление часов. Если часы неправильные, используйте «Изменить часы» на карточке табеля или верните табель работнику.' : 'Clears the alert from the queue. The hours, the shift and the check-ins are NOT changed — this is neither confirming the event nor fixing the hours. If the hours are wrong, use "Edit hours" on the timesheet card or return the timesheet to the worker.')
          : (ru ? 'Подтверждает зафиксированные данные как верные, несмотря на флаг — данные не изменяются.' : 'Confirms the recorded data as valid despite the flag — no data is changed.')}
      </p>
      <div className="exc-filter-field">
        <label htmlFor={`note-${action}`}>{ru ? 'Примечание' : 'Note'} {noteRequired ? (ru ? '(обязательно)' : '(required)') : (ru ? '(необязательно)' : '(optional)')}</label>
        <textarea
          id={`note-${action}`}
          value={note}
          maxLength={2000}
          rows={3}
          onChange={(e) => {
            setNote(e.target.value);
            setArmed(false);
          }}
          disabled={pending}
        />
      </div>
      <FieldError fieldErrors={error?.fieldErrors} field="resolutionNote" />
      {error && <ErrorBanner error={error} locale={locale} />}
      <ConfirmGate
        armed={armed}
        onArm={() => setArmed(true)}
        onCancel={() => setArmed(false)}
        onConfirm={handleConfirm}
        pending={pending}
        primaryLabel={actionLabel(action, locale)}
        summary={ru ? `${actionLabel(action, locale)} это исключение? Это действие нельзя отменить с этого экрана.` : `${actionLabel(action, locale)} this exception? This cannot be undone from this screen.`}
        disabled={noteMissing}
        locale={locale}
      />
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// PAIR_ORPHAN_EVENTS
// ---------------------------------------------------------------------------------------------

function pairEventLabel(event: PairCandidateEvent, locale: AppLocale): string {
  const ru = locale === 'RU';
  const op = event.operationType === 'CHECK_IN' ? (ru ? 'Приход' : 'Check In') : (ru ? 'Уход' : 'Check Out');
  return `${op} ${ru ? 'в' : 'at'} ${formatDateTime(event.effectiveAt)} · ${event.siteName} · ${channelLabel(event.channel, locale)}`;
}

function PairOrphanEventsForm({ apiBasePath, exceptionId, namedEvent, candidates }: { apiBasePath: string; exceptionId: string; namedEvent: PairCandidateEvent; candidates: PairCandidateEvent[] }) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`, locale);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);

  const selected = candidates.find((c) => c.id === selectedId) ?? null;

  async function handleConfirm() {
    if (!selected) {
      return;
    }
    const checkInEventId = namedEvent.operationType === 'CHECK_IN' ? namedEvent.id : selected.id;
    const checkOutEventId = namedEvent.operationType === 'CHECK_IN' ? selected.id : namedEvent.id;
    const result = await submit({ action: 'PAIR_ORPHAN_EVENTS', checkInEventId, checkOutEventId, resolutionNote: note.trim().length > 0 ? note.trim() : undefined });
    if (!result.ok) {
      setArmed(false);
    }
  }

  const missingOpName = namedEvent.operationType === 'CHECK_IN' ? (ru ? 'ухода' : 'Check Out') : (ru ? 'прихода' : 'Check In');

  return (
    <div className="exc-action-form">
      <p className="exc-muted">{ru ? 'Это создаст новую смену из этого события и того, которое вы выберете ниже.' : 'This will create a new shift from this event and the one you choose below.'}</p>
      <div className="exc-pair-named">
        <span className="exc-field-label-inline">{ru ? 'Это событие' : 'This event'}</span>
        {pairEventLabel(namedEvent, locale)}
      </div>

      {candidates.length === 0 ? (
        <p className="exc-empty-candidates">
          {ru
            ? `Подходящее событие ${missingOpName} для этого работника пока не найдено. Обычно это значит, что работник ещё не отмечался снова после появления этого исключения — проверьте позже, либо нажмите «Снять сигнал», если это была ложная тревога.`
            : <>No matching {missingOpName} event was found for this employee yet. This usually means the worker hasn&apos;t clocked again since this exception was raised — check back later, or use "Clear alert" if this was a false alarm.</>}
        </p>
      ) : (
        <fieldset className="exc-candidate-list">
          <legend>{ru ? 'Выберите соответствующее событие' : 'Choose the matching event'}</legend>
          {candidates.map((c) => (
            <label key={c.id} className="exc-candidate-option">
              <input
                type="radio"
                name="pair-candidate"
                value={c.id}
                checked={selectedId === c.id}
                onChange={() => {
                  setSelectedId(c.id);
                  setArmed(false);
                }}
                disabled={pending}
              />
              {pairEventLabel(c, locale)}
            </label>
          ))}
        </fieldset>
      )}

      <div className="exc-filter-field">
        <label htmlFor="pair-note">{ru ? 'Примечание (необязательно)' : 'Note (optional)'}</label>
        <textarea
          id="pair-note"
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => {
            setNote(e.target.value);
            setArmed(false);
          }}
          disabled={pending}
        />
      </div>
      <FieldError fieldErrors={error?.fieldErrors} field="checkInEventId" />
      <FieldError fieldErrors={error?.fieldErrors} field="checkOutEventId" />
      {error && <ErrorBanner error={error} locale={locale} />}
      {candidates.length > 0 && (
        <ConfirmGate
          armed={armed}
          onArm={() => setArmed(true)}
          onCancel={() => setArmed(false)}
          onConfirm={handleConfirm}
          pending={pending}
          primaryLabel={ru ? 'Связать события' : 'Pair events'}
          summary={ru ? 'Создать смену из этих двух событий? Это действие нельзя отменить с этого экрана.' : 'Create a shift from these two events? This cannot be undone from this screen.'}
          disabled={!selected}
          locale={locale}
        />
      )}
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// CONFIRM_SOURCE_ASSIGNMENT
// ---------------------------------------------------------------------------------------------

function assignmentLabel(a: AssignmentCandidate, locale: AppLocale): string {
  const ru = locale === 'RU';
  const range = `${a.validFrom} – ${a.validTo ?? (ru ? 'бессрочно' : 'ongoing')}`;
  return `${a.siteName}${a.workAreaName ? ` — ${a.workAreaName}` : ''}${a.isPrimary ? (ru ? ' (основное)' : ' (primary)') : ''} · ${range}`;
}

function ConfirmSourceAssignmentForm({ apiBasePath, exceptionId, target, alreadyResolved, candidates }: { apiBasePath: string; exceptionId: string; target: { siteName: string; date: string } | null; alreadyResolved: boolean; candidates: AssignmentCandidate[] }) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`, locale);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);

  if (!target) {
    return <p className="exc-empty-candidates">{ru ? 'Цель для этого подтверждения больше не найдена — возможно, она изменилась с момента загрузки страницы.' : 'The target for this confirmation could no longer be found — it may have changed since this page loaded.'}</p>;
  }
  if (alreadyResolved) {
    return <p className="exc-empty-candidates">{ru ? 'Для этого уже подтверждено назначение объекта — исключение скоро обновится.' : 'This already has a confirmed site assignment — the exception should catch up shortly.'}</p>;
  }

  async function handleConfirm() {
    if (!selectedId) {
      return;
    }
    const result = await submit({ action: 'CONFIRM_SOURCE_ASSIGNMENT', chosenAssignmentId: selectedId, resolutionNote: note.trim().length > 0 ? note.trim() : undefined });
    if (!result.ok) {
      setArmed(false);
    }
  }

  return (
    <div className="exc-action-form">
      <p className="exc-muted">
        {ru ? `Цель: ${target.siteName}, ${target.date}.` : <>Target: {target.siteName} on {target.date}.</>}
      </p>
      {candidates.length === 0 ? (
        <p className="exc-empty-candidates">{ru ? 'Ни одно назначение не покрывает этого работника для этого объекта на эту дату. Сначала создайте или скорректируйте назначение работника.' : "No site assignment covers this employee for this site on this date. Create or adjust the employee's assignment first."}</p>
      ) : (
        <fieldset className="exc-candidate-list">
          <legend>{ru ? 'Выберите назначение' : 'Choose the assignment'}</legend>
          {candidates.map((c) => (
            <label key={c.id} className="exc-candidate-option">
              <input
                type="radio"
                name="assignment-candidate"
                value={c.id}
                checked={selectedId === c.id}
                onChange={() => {
                  setSelectedId(c.id);
                  setArmed(false);
                }}
                disabled={pending}
              />
              {assignmentLabel(c, locale)}
            </label>
          ))}
        </fieldset>
      )}
      <div className="exc-filter-field">
        <label htmlFor="confirm-note">{ru ? 'Примечание (необязательно)' : 'Note (optional)'}</label>
        <textarea id="confirm-note" value={note} maxLength={2000} rows={2} onChange={(e) => { setNote(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      <FieldError fieldErrors={error?.fieldErrors} field="chosenAssignmentId" />
      {error && <ErrorBanner error={error} locale={locale} />}
      {candidates.length > 0 && (
        <ConfirmGate
          armed={armed}
          onArm={() => setArmed(true)}
          onCancel={() => setArmed(false)}
          onConfirm={handleConfirm}
          pending={pending}
          primaryLabel={ru ? 'Подтвердить назначение' : 'Confirm assignment'}
          summary={ru ? 'Подтвердить это назначение объекта для целевой смены? Это действие нельзя отменить с этого экрана.' : 'Confirm this site assignment for the target shift? This cannot be undone from this screen.'}
          disabled={!selectedId}
          locale={locale}
        />
      )}
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// FORCE_CLOSE_OPEN_SHIFT
// ---------------------------------------------------------------------------------------------

function ForceCloseOpenShiftForm({ apiBasePath, exceptionId, openShift }: { apiBasePath: string; exceptionId: string; openShift: { openedAt: string; siteName: string; workAreaName: string | null } | null }) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`, locale);
  const [endLocal, setEndLocal] = useState(() => utcIsoToHelsinkiDateTimeLocal(new Date().toISOString()));
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  if (!openShift) {
    return <p className="exc-empty-candidates">{ru ? 'Эта смена больше не открыта — возможно, уже поступил реальный уход. Нажмите «Снять сигнал».' : 'This shift is no longer open — a real Check Out may have already arrived. Use "Clear alert" instead.'}</p>;
  }

  function validateAndArm() {
    setClientError(null);
    if (reason.trim().length === 0) {
      setClientError(ru ? 'Требуется указать причину.' : 'A reason is required.');
      return;
    }
    const endIso = helsinkiDateTimeLocalToUtcIso(endLocal);
    if (!(new Date(endIso).getTime() > new Date(openShift!.openedAt).getTime())) {
      setClientError(ru ? 'Время окончания должно быть позже открытия смены.' : 'The end time must be after the shift opened.');
      return;
    }
    setArmed(true);
  }

  async function handleConfirm() {
    const endIso = helsinkiDateTimeLocalToUtcIso(endLocal);
    const result = await submit({ action: 'FORCE_CLOSE_OPEN_SHIFT', explicitEndAt: endIso, reason: reason.trim() });
    if (!result.ok) {
      setArmed(false);
    }
  }

  return (
    <div className="exc-action-form">
      <div className="exc-warning" role="note">
        {ru ? 'Это создаст закрытую смену без реального события ухода. Убедитесь, что время окончания ниже указано верно — это действие нельзя отменить с этого экрана.' : 'This will create a closed shift without a real Check Out event. Make sure the end time below is correct — this cannot be undone from this screen.'}
      </div>
      <p className="exc-muted">
        {ru ? 'Открыта' : 'Opened'} {formatDateTime(openShift.openedAt)} · {openShift.siteName}
        {openShift.workAreaName ? ` — ${openShift.workAreaName}` : ''}
      </p>
      <div className="exc-filter-field">
        <label htmlFor="force-close-end">{ru ? 'Дата/время окончания (Europe/Helsinki)' : 'End date/time (Europe/Helsinki)'}</label>
        <input
          id="force-close-end"
          type="datetime-local"
          value={endLocal}
          onChange={(e) => {
            setEndLocal(e.target.value);
            setArmed(false);
          }}
          disabled={pending}
        />
      </div>
      <div className="exc-filter-field">
        <label htmlFor="force-close-reason">{ru ? 'Причина (обязательно)' : 'Reason (required)'}</label>
        <textarea
          id="force-close-reason"
          value={reason}
          maxLength={2000}
          rows={3}
          onChange={(e) => {
            setReason(e.target.value);
            setArmed(false);
          }}
          disabled={pending}
        />
      </div>
      {clientError && (
        <p className="exc-field-error" role="alert">
          {clientError}
        </p>
      )}
      <FieldError fieldErrors={error?.fieldErrors} field="explicitEndAt" />
      <FieldError fieldErrors={error?.fieldErrors} field="reason" />
      {error && <ErrorBanner error={error} locale={locale} />}
      <ConfirmGate
        armed={armed}
        onArm={validateAndArm}
        onCancel={() => setArmed(false)}
        onConfirm={handleConfirm}
        pending={pending}
        primaryLabel={ru ? 'Принудительно закрыть смену' : 'Force close shift'}
        summary={ru ? 'Принудительно закрыть эту смену с указанным временем окончания и причиной?' : 'Force close this shift with the entered end time and reason?'}
        danger
        locale={locale}
      />
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// REASON_EDIT
// ---------------------------------------------------------------------------------------------

function fragmentAssignmentKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

function ReasonEditFragmentForm({ apiBasePath, exceptionId, fragment, requiresEndAt, sideLabel }: { apiBasePath: string; exceptionId: string; fragment: EditFragmentCandidate; requiresEndAt: boolean; sideLabel: string | null }) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/edit`, locale);
  const initialKey = fragmentAssignmentKey(fragment.currentReported.siteId, fragment.currentReported.workAreaId);
  const [startLocal, setStartLocal] = useState(() => utcIsoToHelsinkiDateTimeLocal(fragment.currentReported.startAt));
  const [endLocal, setEndLocal] = useState(() => utcIsoToHelsinkiDateTimeLocal(fragment.currentReported.endAt));
  const [assignmentKey, setAssignmentKey] = useState(initialKey);
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const options = fragment.assignmentOptions.length > 0 ? fragment.assignmentOptions : [{ siteId: fragment.currentReported.siteId, siteName: fragment.currentReported.siteName, workAreaId: fragment.currentReported.workAreaId, workAreaName: fragment.currentReported.workAreaName }];

  function buildBody(): { body: Record<string, unknown>; error: string | null } {
    const startIso = helsinkiDateTimeLocalToUtcIso(startLocal);
    const endIso = helsinkiDateTimeLocalToUtcIso(endLocal);
    const [siteId, workAreaIdRaw] = assignmentKey.split('::');
    const workAreaId = workAreaIdRaw || null;

    if (!(new Date(endIso).getTime() > new Date(startIso).getTime())) {
      return { body: {}, error: ru ? 'Окончание должно быть позже начала.' : 'End must be after start.' };
    }

    const body: Record<string, unknown> = { clockShiftFragmentId: fragment.id, reason: reason.trim() };
    const startChanged = startIso !== fragment.currentReported.startAt;
    const endChanged = endIso !== fragment.currentReported.endAt;
    const siteChanged = siteId !== fragment.currentReported.siteId;
    const workAreaChanged = workAreaId !== fragment.currentReported.workAreaId;

    if (startChanged) {
      body.startAt = startIso;
    }
    if (endChanged || requiresEndAt) {
      // task §7 — CHECKOUT_CHRONOLOGY_ANOMALY always sends endAt per the backend contract, even if
      // the user left it unchanged.
      body.endAt = endIso;
    }
    if (siteChanged) {
      body.siteId = siteId;
    }
    if (siteChanged || workAreaChanged) {
      // task §7 — "если site изменён, workAreaId отправлять явно, включая null" — sending it
      // whenever EITHER component changed is a safe superset of that rule.
      body.workAreaId = workAreaId;
    }

    const hasAnyFieldEdit = 'startAt' in body || 'endAt' in body || 'siteId' in body || 'workAreaId' in body;
    if (!hasAnyFieldEdit) {
      return { body: {}, error: ru ? 'Измените хотя бы одно поле перед сохранением.' : 'Change at least one field before saving.' };
    }
    if (reason.trim().length === 0) {
      return { body: {}, error: ru ? 'Требуется указать причину.' : 'A reason is required.' };
    }
    return { body, error: null };
  }

  function validateAndArm() {
    const { error: validationError } = buildBody();
    setClientError(validationError);
    if (!validationError) {
      setArmed(true);
    }
  }

  async function handleConfirm() {
    const { body, error: validationError } = buildBody();
    if (validationError) {
      setClientError(validationError);
      setArmed(false);
      return;
    }
    const result = await submit(body);
    if (!result.ok) {
      setArmed(false);
    }
  }

  return (
    <div className="exc-action-form">
      {sideLabel && <p className="exc-muted">{sideLabel}</p>}
      <dl className="exc-detail-grid">
        <div>
          <dt>{ru ? 'Зафиксировано (исходно, без изменений)' : 'Recorded (raw, unchanged)'}</dt>
          <dd>
            {formatDateTime(fragment.recordedStartAt)} – {formatDateTime(fragment.recordedEndAt)}
          </dd>
        </div>
        <div>
          <dt>{ru ? 'Текущее заявленное' : 'Currently reported'}</dt>
          <dd>
            {formatDateTime(fragment.currentReported.startAt)} – {formatDateTime(fragment.currentReported.endAt)}
          </dd>
        </div>
      </dl>

      {fragment.breaks.length > 0 && (
        <>
          <h3 className="exc-subsection-title">{ru ? 'Перерывы (только просмотр)' : 'Breaks (read-only)'}</h3>
          <ul className="exc-fragment-list">
            {fragment.breaks.map((b, i) => (
              <li key={i}>
                {formatDateTime(b.startAt)} – {formatDateTime(b.endAt)} {b.paid ? (ru ? '(оплачиваемый)' : '(paid)') : (ru ? '(неоплачиваемый)' : '(unpaid)')}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="exc-filter-field">
        <label htmlFor={`edit-start-${fragment.id}`}>{ru ? 'Начало (Europe/Helsinki)' : 'Start (Europe/Helsinki)'}</label>
        <input id={`edit-start-${fragment.id}`} type="datetime-local" value={startLocal} onChange={(e) => { setStartLocal(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      <div className="exc-filter-field">
        <label htmlFor={`edit-end-${fragment.id}`}>{ru ? 'Окончание (Europe/Helsinki)' : 'End (Europe/Helsinki)'}{requiresEndAt ? (ru ? ' — обязательно' : ' — required') : ''}</label>
        <input id={`edit-end-${fragment.id}`} type="datetime-local" value={endLocal} onChange={(e) => { setEndLocal(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      <div className="exc-filter-field">
        <label htmlFor={`edit-site-${fragment.id}`}>{ru ? 'Объект / рабочая зона' : 'Site / work area'}</label>
        <select id={`edit-site-${fragment.id}`} value={assignmentKey} onChange={(e) => { setAssignmentKey(e.target.value); setArmed(false); }} disabled={pending}>
          {options.map((o) => {
            const key = fragmentAssignmentKey(o.siteId, o.workAreaId);
            return (
              <option key={key} value={key}>
                {o.siteName}
                {o.workAreaName ? ` — ${o.workAreaName}` : ''}
              </option>
            );
          })}
        </select>
      </div>
      <div className="exc-filter-field">
        <label htmlFor={`edit-reason-${fragment.id}`}>{ru ? 'Причина (обязательно)' : 'Reason (required)'}</label>
        <textarea id={`edit-reason-${fragment.id}`} value={reason} maxLength={2000} rows={3} onChange={(e) => { setReason(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      {clientError && (
        <p className="exc-field-error" role="alert">
          {clientError}
        </p>
      )}
      <FieldError fieldErrors={error?.fieldErrors} field="startAt" />
      <FieldError fieldErrors={error?.fieldErrors} field="endAt" />
      <FieldError fieldErrors={error?.fieldErrors} field="siteId" />
      <FieldError fieldErrors={error?.fieldErrors} field="workAreaId" />
      <FieldError fieldErrors={error?.fieldErrors} field="reason" />
      {error && <ErrorBanner error={error} locale={locale} />}
      <ConfirmGate
        armed={armed}
        onArm={validateAndArm}
        onCancel={() => setArmed(false)}
        onConfirm={handleConfirm}
        pending={pending}
        primaryLabel={ru ? 'Сохранить изменение' : 'Save edit'}
        summary={ru ? 'Сохранить это изменение и решить исключение с этой причиной?' : 'Save this edit and resolve the exception with this reason?'}
        locale={locale}
      />
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

function ReasonEditForm({ apiBasePath, exceptionId, fragments, requiresEndAt, isOverlappingShift }: { apiBasePath: string; exceptionId: string; fragments: EditFragmentCandidate[]; requiresEndAt: boolean; isOverlappingShift: boolean }) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const [selectedId, setSelectedId] = useState<string | null>(fragments.length === 1 ? fragments[0].id : null);

  if (fragments.length === 0) {
    return <p className="exc-empty-candidates">{ru ? 'Для этого исключения пока нет доступной для редактирования цели — соответствующая запись не найдена.' : 'No editable target is available for this exception yet — the reported entry it would apply to could not be found.'}</p>;
  }

  const selected = fragments.find((f) => f.id === selectedId) ?? null;

  return (
    <div>
      {isOverlappingShift && <p className="exc-muted">{ru ? 'Можно редактировать любую сторону пересекающейся пары — после успешного изменения смены больше не должны пересекаться.' : 'Editing either side of the overlapping pair is allowed — after a successful edit, the two shifts must no longer overlap.'}</p>}
      {fragments.length > 1 && (
        <fieldset className="exc-candidate-list">
          <legend>{ru ? 'Выберите запись для редактирования' : 'Choose which entry to edit'}</legend>
          {fragments.map((f, i) => (
            <label key={f.id} className="exc-candidate-option">
              <input type="radio" name="edit-fragment" value={f.id} checked={selectedId === f.id} onChange={() => setSelectedId(f.id)} />
              {f.date} · {f.siteName}
              {f.workAreaName ? ` — ${f.workAreaName}` : ''}
              {isOverlappingShift ? ` (${i === 0 ? (ru ? 'эта смена' : 'this shift') : (ru ? 'связанная смена' : 'related shift')})` : ''}
            </label>
          ))}
        </fieldset>
      )}
      {selected && (
        <ReasonEditFragmentForm apiBasePath={apiBasePath} exceptionId={exceptionId} fragment={selected} requiresEndAt={requiresEndAt} sideLabel={isOverlappingShift ? `${ru ? 'Редактирование' : 'Editing'}: ${selected.date} · ${selected.siteName}${selected.workAreaName ? ` — ${selected.workAreaName}` : ''}` : null} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------------------------

interface ExceptionActionPanelProps {
  apiBasePath: string; // e.g. /api/admin/attendance/exceptions or /api/foreman/attendance/exceptions
  exceptionId: string;
  /** null when the caller has read but not resolve permission (task §2) — renders a plain
   * read-only explanation, never a mutation UI. */
  context: ResolutionContext | null;
}

function readOnlyExplanation(context: ResolutionContext, ru: boolean): string {
  if (context.readOnlyReason === 'SCOPE_INCOMPLETE') {
    return ru ? 'Это исключение относится к объекту вне ваших текущих назначений — решение здесь недоступно.' : 'This exception touches a site outside your current assignments — resolution is unavailable here.';
  }
  return ru ? 'Для этого типа исключения нет доступных действий по решению.' : 'No resolution actions apply to this exception type.';
}

export function ExceptionActionPanel({ apiBasePath, exceptionId, context }: ExceptionActionPanelProps) {
  const locale: AppLocale = useAppLocale();
  const ru = locale === 'RU';
  const [selectedAction, setSelectedAction] = useState<ResolutionActionName | null>(null);

  if (!context) {
    return <p className="exc-muted">{ru ? 'Вы можете просматривать это исключение, но у вас нет прав на его решение.' : 'You can view this exception but do not have permission to resolve it.'}</p>;
  }
  if (context.allowedActions.length === 0) {
    return <p className="exc-muted">{readOnlyExplanation(context, ru)}</p>;
  }

  const actions = context.allowedActions;
  const active = selectedAction && actions.includes(selectedAction) ? selectedAction : null;

  let formNode: ReactNode = null;
  if (active === 'DISMISS' || active === 'ACKNOWLEDGE_AS_VALID') {
    formNode = <DismissAckForm apiBasePath={apiBasePath} exceptionId={exceptionId} action={active} chronologyNoteRequired={context.chronologyNoteRequired} />;
  } else if (active === 'PAIR_ORPHAN_EVENTS' && context.pairContext) {
    formNode = <PairOrphanEventsForm apiBasePath={apiBasePath} exceptionId={exceptionId} namedEvent={context.pairContext.namedEvent} candidates={context.pairContext.candidates} />;
  } else if (active === 'CONFIRM_SOURCE_ASSIGNMENT' && context.assignmentContext) {
    formNode = <ConfirmSourceAssignmentForm apiBasePath={apiBasePath} exceptionId={exceptionId} target={context.assignmentContext.target} alreadyResolved={context.assignmentContext.alreadyResolved} candidates={context.assignmentContext.candidates} />;
  } else if (active === 'FORCE_CLOSE_OPEN_SHIFT' && context.forceCloseContext) {
    formNode = <ForceCloseOpenShiftForm apiBasePath={apiBasePath} exceptionId={exceptionId} openShift={context.forceCloseContext.openShift} />;
  } else if (active === 'REASON_EDIT' && context.editContext) {
    formNode = <ReasonEditForm apiBasePath={apiBasePath} exceptionId={exceptionId} fragments={context.editContext.fragments} requiresEndAt={context.editContext.requiresEndAt} isOverlappingShift={context.editContext.isOverlappingShift} />;
  }

  return (
    <div className="exc-action-panel">
      <div className="exc-action-selector" role="group" aria-label={ru ? 'Выберите действие для решения' : 'Choose a resolution action'}>
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={a === active ? 'exc-action-tab exc-action-tab-active' : a === 'FORCE_CLOSE_OPEN_SHIFT' ? 'exc-action-tab exc-action-tab-danger' : 'exc-action-tab'}
            aria-pressed={a === active}
            onClick={() => setSelectedAction(a === active ? null : a)}
          >
            {actionLabel(a, locale)}
          </button>
        ))}
      </div>
      {formNode && <div className="exc-action-form-wrap">{formNode}</div>}
    </div>
  );
}
