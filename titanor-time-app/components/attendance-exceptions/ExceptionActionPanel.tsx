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

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5/§9.7-§9.9/§11-§12.4 — T7A.8C.2. Renders
// only what lib/attendance-exception-resolution-context.ts's getResolutionContext already computed
// and role/scope-filtered server-side; every mutation goes through the SAME existing POST
// .../resolve or .../edit endpoints as any other client (curl, Postman), with the same CSRF header
// and full server-side re-validation. This component is a UI convenience, never a second
// authorization boundary — every outcome branch below already assumes the POST can 403/404/409 for
// reasons this panel's own (advisory, possibly stale-by-a-few-seconds) `context` prop didn't predict.

const CSRF_HEADER_VALUE = 'titanor-time';

const ACTION_LABELS: Record<ResolutionActionName, string> = {
  DISMISS: 'Dismiss',
  ACKNOWLEDGE_AS_VALID: 'Acknowledge as valid',
  PAIR_ORPHAN_EVENTS: 'Pair with another event',
  CONFIRM_SOURCE_ASSIGNMENT: 'Confirm site assignment',
  FORCE_CLOSE_OPEN_SHIFT: 'Force close open shift',
  REASON_EDIT: 'Edit reported time'
};

const ERROR_MESSAGES: Record<string, string> = {
  CSRF_REJECTED: 'Your session needs a refresh — please reload the page and try again.',
  NOT_AUTHENTICATED: 'Your session has expired — please log in again.',
  FORBIDDEN: 'You no longer have permission to do this — the page has been refreshed.',
  EXCEPTION_NOT_FOUND: 'This exception could not be found — it may have been removed, or you no longer have access.',
  EXCEPTION_ALREADY_RESOLVED: 'This exception was already resolved by someone else — showing the latest state.',
  ACTION_NOT_APPLICABLE: 'This action no longer applies to this exception — showing the latest state.',
  FOREMAN_SCOPE_INCOMPLETE: 'This exception now touches a site outside your current assignments.',
  OPEN_SHIFT_STILL_PENDING: 'The originating shift is still open — it cannot be dismissed yet.',
  VALIDATION_ERROR: 'Please check the highlighted fields.',
  CLOCK_EVENT_NOT_FOUND: 'One of the selected events could no longer be found — showing the latest state.',
  EVENT_ALREADY_PAIRED: 'One of these events was just paired by someone else — showing the latest state.',
  PAIRED_SHIFT_OVERLAP: 'This pair would overlap an existing shift for this employee. Choose a different event.',
  TARGET_NOT_FOUND: 'The target for this confirmation could no longer be found — showing the latest state.',
  TARGET_ALREADY_RESOLVED: 'This was already confirmed — showing the latest state.',
  OPEN_SHIFT_ALREADY_CLOSED: 'This shift is no longer open — a Check Out may have already arrived. Consider Dismiss instead.',
  TARGET_NOT_EDITABLE: 'There is no live editable entry for this fragment anymore — showing the latest state.',
  DRAFT_NOT_EDITABLE: 'This timesheet is no longer in a draft/returned state — showing the latest state.',
  OVERLAP_STILL_PRESENT: 'This change does not fully resolve the overlap between the two shifts. Adjust the times and try again.',
  BREAK_OUTSIDE_SEGMENT: 'An existing break would fall outside the new time range.',
  WORK_SEGMENT_OVERLAP: 'This change would overlap another interval on the same day.',
  SITE_NOT_ASSIGNED: 'This employee has no active assignment for that site/work area on this date.'
};

function describeErrorCode(code: string | undefined, fallback: string | undefined): string {
  if (code && ERROR_MESSAGES[code]) {
    return ERROR_MESSAGES[code];
  }
  return fallback ? fallback : 'Something went wrong. Please review and try again.';
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
function useResolutionMutation(url: string) {
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
    setAnnouncement('Submitting…');

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
        setAnnouncement('Action completed — refreshing.');
        router.refresh();
        return { ok: true };
      }

      const code = data?.error?.code;
      const requestId = data?.error?.requestId;
      const fieldErrors = data?.error?.fieldErrors;
      const message = describeErrorCode(code, data?.error?.message);
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
      setAnnouncement('Connection problem — refreshed with the latest known state. Please check below before retrying.');
      setError({ message: 'Connection problem — the page has been refreshed with the latest known state. Nothing was resubmitted automatically; please check below before retrying.' });
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

function ErrorBanner({ error }: { error: ErrorState }) {
  return (
    <div className="exc-action-error" role="alert">
      <p>{error.message}</p>
      {error.requestId && <p className="exc-muted">Reference: {error.requestId}</p>}
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
function ConfirmGate({ armed, onArm, onCancel, onConfirm, pending, primaryLabel, summary, disabled, danger }: {
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  primaryLabel: string;
  summary: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  if (!armed) {
    return (
      <button type="button" className={danger ? 'exc-apply-button exc-action-danger-button' : 'exc-apply-button'} onClick={onArm} disabled={disabled}>
        {primaryLabel}
      </button>
    );
  }
  return (
    <div className="exc-confirm-box" role="group" aria-label="Confirm action">
      <p>{summary}</p>
      <div className="exc-confirm-actions">
        <button type="button" className={danger ? 'exc-apply-button exc-action-danger-button' : 'exc-apply-button'} onClick={onConfirm} disabled={pending}>
          {pending ? 'Submitting…' : 'Yes, confirm'}
        </button>
        <button type="button" className="exc-reset-link" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// DISMISS / ACKNOWLEDGE_AS_VALID
// ---------------------------------------------------------------------------------------------

function DismissAckForm({ apiBasePath, exceptionId, action, chronologyNoteRequired }: { apiBasePath: string; exceptionId: string; action: 'DISMISS' | 'ACKNOWLEDGE_AS_VALID'; chronologyNoteRequired: boolean }) {
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`);
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
        {action === 'DISMISS' ? 'Dismiss marks this exception as not requiring further action, without confirming the underlying event was correct.' : 'Acknowledging confirms the recorded data as valid despite the flag — no data is changed.'}
      </p>
      <div className="exc-filter-field">
        <label htmlFor={`note-${action}`}>Note {noteRequired ? '(required)' : '(optional)'}</label>
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
      {error && <ErrorBanner error={error} />}
      <ConfirmGate
        armed={armed}
        onArm={() => setArmed(true)}
        onCancel={() => setArmed(false)}
        onConfirm={handleConfirm}
        pending={pending}
        primaryLabel={ACTION_LABELS[action]}
        summary={`${ACTION_LABELS[action]} this exception? This cannot be undone from this screen.`}
        disabled={noteMissing}
      />
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// PAIR_ORPHAN_EVENTS
// ---------------------------------------------------------------------------------------------

function pairEventLabel(event: PairCandidateEvent): string {
  return `${event.operationType === 'CHECK_IN' ? 'Check In' : 'Check Out'} at ${formatDateTime(event.effectiveAt)} · ${event.siteName} · ${channelLabel(event.channel)}`;
}

function PairOrphanEventsForm({ apiBasePath, exceptionId, namedEvent, candidates }: { apiBasePath: string; exceptionId: string; namedEvent: PairCandidateEvent; candidates: PairCandidateEvent[] }) {
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`);
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

  return (
    <div className="exc-action-form">
      <p className="exc-muted">This will create a new shift from this event and the one you choose below.</p>
      <div className="exc-pair-named">
        <span className="exc-field-label-inline">This event</span>
        {pairEventLabel(namedEvent)}
      </div>

      {candidates.length === 0 ? (
        <p className="exc-empty-candidates">
          No matching {namedEvent.operationType === 'CHECK_IN' ? 'Check Out' : 'Check In'} event was found for this employee yet. This usually means the worker hasn&apos;t clocked again since this exception was raised — check back later, or use Dismiss if this was a false alarm.
        </p>
      ) : (
        <fieldset className="exc-candidate-list">
          <legend>Choose the matching event</legend>
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
              {pairEventLabel(c)}
            </label>
          ))}
        </fieldset>
      )}

      <div className="exc-filter-field">
        <label htmlFor="pair-note">Note (optional)</label>
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
      {error && <ErrorBanner error={error} />}
      {candidates.length > 0 && (
        <ConfirmGate
          armed={armed}
          onArm={() => setArmed(true)}
          onCancel={() => setArmed(false)}
          onConfirm={handleConfirm}
          pending={pending}
          primaryLabel="Pair events"
          summary="Create a shift from these two events? This cannot be undone from this screen."
          disabled={!selected}
        />
      )}
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// CONFIRM_SOURCE_ASSIGNMENT
// ---------------------------------------------------------------------------------------------

function assignmentLabel(a: AssignmentCandidate): string {
  const range = `${a.validFrom} – ${a.validTo ?? 'ongoing'}`;
  return `${a.siteName}${a.workAreaName ? ` — ${a.workAreaName}` : ''}${a.isPrimary ? ' (primary)' : ''} · ${range}`;
}

function ConfirmSourceAssignmentForm({ apiBasePath, exceptionId, target, alreadyResolved, candidates }: { apiBasePath: string; exceptionId: string; target: { siteName: string; date: string } | null; alreadyResolved: boolean; candidates: AssignmentCandidate[] }) {
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);

  if (!target) {
    return <p className="exc-empty-candidates">The target for this confirmation could no longer be found — it may have changed since this page loaded.</p>;
  }
  if (alreadyResolved) {
    return <p className="exc-empty-candidates">This already has a confirmed site assignment — the exception should catch up shortly.</p>;
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
        Target: {target.siteName} on {target.date}.
      </p>
      {candidates.length === 0 ? (
        <p className="exc-empty-candidates">No site assignment covers this employee for this site on this date. Create or adjust the employee&apos;s assignment first.</p>
      ) : (
        <fieldset className="exc-candidate-list">
          <legend>Choose the assignment</legend>
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
              {assignmentLabel(c)}
            </label>
          ))}
        </fieldset>
      )}
      <div className="exc-filter-field">
        <label htmlFor="confirm-note">Note (optional)</label>
        <textarea id="confirm-note" value={note} maxLength={2000} rows={2} onChange={(e) => { setNote(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      <FieldError fieldErrors={error?.fieldErrors} field="chosenAssignmentId" />
      {error && <ErrorBanner error={error} />}
      {candidates.length > 0 && (
        <ConfirmGate
          armed={armed}
          onArm={() => setArmed(true)}
          onCancel={() => setArmed(false)}
          onConfirm={handleConfirm}
          pending={pending}
          primaryLabel="Confirm assignment"
          summary="Confirm this site assignment for the target shift? This cannot be undone from this screen."
          disabled={!selectedId}
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
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/resolve`);
  const [endLocal, setEndLocal] = useState(() => utcIsoToHelsinkiDateTimeLocal(new Date().toISOString()));
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  if (!openShift) {
    return <p className="exc-empty-candidates">This shift is no longer open — a real Check Out may have already arrived. Use Dismiss instead.</p>;
  }

  function validateAndArm() {
    setClientError(null);
    if (reason.trim().length === 0) {
      setClientError('A reason is required.');
      return;
    }
    const endIso = helsinkiDateTimeLocalToUtcIso(endLocal);
    if (!(new Date(endIso).getTime() > new Date(openShift!.openedAt).getTime())) {
      setClientError('The end time must be after the shift opened.');
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
        This will create a closed shift without a real Check Out event. Make sure the end time below is correct — this cannot be undone from this screen.
      </div>
      <p className="exc-muted">
        Opened {formatDateTime(openShift.openedAt)} · {openShift.siteName}
        {openShift.workAreaName ? ` — ${openShift.workAreaName}` : ''}
      </p>
      <div className="exc-filter-field">
        <label htmlFor="force-close-end">End date/time (Europe/Helsinki)</label>
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
        <label htmlFor="force-close-reason">Reason (required)</label>
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
      {error && <ErrorBanner error={error} />}
      <ConfirmGate armed={armed} onArm={validateAndArm} onCancel={() => setArmed(false)} onConfirm={handleConfirm} pending={pending} primaryLabel="Force close shift" summary="Force close this shift with the entered end time and reason?" danger />
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
  const { submit, pending, error, announcement } = useResolutionMutation(`${apiBasePath}/${exceptionId}/edit`);
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
      return { body: {}, error: 'End must be after start.' };
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
      return { body: {}, error: 'Change at least one field before saving.' };
    }
    if (reason.trim().length === 0) {
      return { body: {}, error: 'A reason is required.' };
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
          <dt>Recorded (raw, unchanged)</dt>
          <dd>
            {formatDateTime(fragment.recordedStartAt)} – {formatDateTime(fragment.recordedEndAt)}
          </dd>
        </div>
        <div>
          <dt>Currently reported</dt>
          <dd>
            {formatDateTime(fragment.currentReported.startAt)} – {formatDateTime(fragment.currentReported.endAt)}
          </dd>
        </div>
      </dl>

      {fragment.breaks.length > 0 && (
        <>
          <h3 className="exc-subsection-title">Breaks (read-only)</h3>
          <ul className="exc-fragment-list">
            {fragment.breaks.map((b, i) => (
              <li key={i}>
                {formatDateTime(b.startAt)} – {formatDateTime(b.endAt)} {b.paid ? '(paid)' : '(unpaid)'}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="exc-filter-field">
        <label htmlFor={`edit-start-${fragment.id}`}>Start (Europe/Helsinki)</label>
        <input id={`edit-start-${fragment.id}`} type="datetime-local" value={startLocal} onChange={(e) => { setStartLocal(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      <div className="exc-filter-field">
        <label htmlFor={`edit-end-${fragment.id}`}>End (Europe/Helsinki){requiresEndAt ? ' — required' : ''}</label>
        <input id={`edit-end-${fragment.id}`} type="datetime-local" value={endLocal} onChange={(e) => { setEndLocal(e.target.value); setArmed(false); }} disabled={pending} />
      </div>
      <div className="exc-filter-field">
        <label htmlFor={`edit-site-${fragment.id}`}>Site / work area</label>
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
        <label htmlFor={`edit-reason-${fragment.id}`}>Reason (required)</label>
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
      {error && <ErrorBanner error={error} />}
      <ConfirmGate armed={armed} onArm={validateAndArm} onCancel={() => setArmed(false)} onConfirm={handleConfirm} pending={pending} primaryLabel="Save edit" summary="Save this edit and resolve the exception with this reason?" />
      <AnnouncementRegion text={announcement} />
    </div>
  );
}

function ReasonEditForm({ apiBasePath, exceptionId, fragments, requiresEndAt, isOverlappingShift }: { apiBasePath: string; exceptionId: string; fragments: EditFragmentCandidate[]; requiresEndAt: boolean; isOverlappingShift: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(fragments.length === 1 ? fragments[0].id : null);

  if (fragments.length === 0) {
    return <p className="exc-empty-candidates">No editable target is available for this exception yet — the reported entry it would apply to could not be found.</p>;
  }

  const selected = fragments.find((f) => f.id === selectedId) ?? null;

  return (
    <div>
      {isOverlappingShift && <p className="exc-muted">Editing either side of the overlapping pair is allowed — after a successful edit, the two shifts must no longer overlap.</p>}
      {fragments.length > 1 && (
        <fieldset className="exc-candidate-list">
          <legend>Choose which entry to edit</legend>
          {fragments.map((f, i) => (
            <label key={f.id} className="exc-candidate-option">
              <input type="radio" name="edit-fragment" value={f.id} checked={selectedId === f.id} onChange={() => setSelectedId(f.id)} />
              {f.date} · {f.siteName}
              {f.workAreaName ? ` — ${f.workAreaName}` : ''}
              {isOverlappingShift ? ` (${i === 0 ? 'this shift' : 'related shift'})` : ''}
            </label>
          ))}
        </fieldset>
      )}
      {selected && (
        <ReasonEditFragmentForm apiBasePath={apiBasePath} exceptionId={exceptionId} fragment={selected} requiresEndAt={requiresEndAt} sideLabel={isOverlappingShift ? `Editing: ${selected.date} · ${selected.siteName}${selected.workAreaName ? ` — ${selected.workAreaName}` : ''}` : null} />
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

function readOnlyExplanation(context: ResolutionContext): string {
  if (context.readOnlyReason === 'SCOPE_INCOMPLETE') {
    return 'This exception touches a site outside your current assignments — resolution is unavailable here.';
  }
  return 'No resolution actions apply to this exception type.';
}

export function ExceptionActionPanel({ apiBasePath, exceptionId, context }: ExceptionActionPanelProps) {
  const [selectedAction, setSelectedAction] = useState<ResolutionActionName | null>(null);

  if (!context) {
    return <p className="exc-muted">You can view this exception but do not have permission to resolve it.</p>;
  }
  if (context.allowedActions.length === 0) {
    return <p className="exc-muted">{readOnlyExplanation(context)}</p>;
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
      <div className="exc-action-selector" role="group" aria-label="Choose a resolution action">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={a === active ? 'exc-action-tab exc-action-tab-active' : a === 'FORCE_CLOSE_OPEN_SHIFT' ? 'exc-action-tab exc-action-tab-danger' : 'exc-action-tab'}
            aria-pressed={a === active}
            onClick={() => setSelectedAction(a === active ? null : a)}
          >
            {ACTION_LABELS[a]}
          </button>
        ))}
      </div>
      {formNode && <div className="exc-action-form-wrap">{formNode}</div>}
    </div>
  );
}
