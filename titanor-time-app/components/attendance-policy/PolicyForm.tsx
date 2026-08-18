'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { PolicyView, PolicyPatchInput } from '@/lib/attendance-policy';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10B" §7 — retry/idempotency
// semantics for this form. One "attempt" object (UUID Idempotency-Key + frozen payload) per Save
// click; a network failure keeps the SAME attempt alive for Retry (byte-identical resend); any
// definitive server outcome (success, validation error, permission error, idempotency conflict)
// concludes the attempt — the next Save (after at least one real edit) creates a brand new key.

const CSRF_HEADER_VALUE = 'titanor-time';
const POLICY_URL = '/api/admin/attendance/policy';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'validation-error' | 'network-unknown' | 'server-error';

interface FormState {
  cutoffDaysAfterPeriodEnd: string;
  cutoffTime: string;
  systemReopenDebounceMinutes: string;
  maxShiftDurationHours: string;
}

interface Attempt {
  key: string;
  payload: PolicyPatchInput;
}

function formStateFromPolicy(policy: PolicyView): FormState {
  return {
    cutoffDaysAfterPeriodEnd: String(policy.cutoffDaysAfterPeriodEnd),
    cutoffTime: policy.cutoffTime,
    systemReopenDebounceMinutes: String(policy.systemReopenDebounceMinutes),
    maxShiftDurationHours: String(policy.maxShiftDurationHours)
  };
}

/** Only structural completeness (empty native-number-input value) is checked here — every real
 * range/format bound lives exactly once, server-side, in lib/attendance-policy.ts's own
 * validatePolicyPatchInput. This never re-derives those bounds. */
function buildPatch(form: FormState, policy: PolicyView): { patch: PolicyPatchInput; incompleteFields: string[] } {
  const patch: PolicyPatchInput = {};
  const incompleteFields: string[] = [];

  if (form.cutoffDaysAfterPeriodEnd === '') {
    incompleteFields.push('cutoffDaysAfterPeriodEnd');
  } else if (Number(form.cutoffDaysAfterPeriodEnd) !== policy.cutoffDaysAfterPeriodEnd) {
    patch.cutoffDaysAfterPeriodEnd = Number(form.cutoffDaysAfterPeriodEnd);
  }

  if (form.cutoffTime === '') {
    incompleteFields.push('cutoffTime');
  } else {
    const normalized = form.cutoffTime.length === 5 ? `${form.cutoffTime}:00` : form.cutoffTime;
    if (normalized !== policy.cutoffTime) {
      patch.cutoffTime = normalized;
    }
  }

  if (form.systemReopenDebounceMinutes === '') {
    incompleteFields.push('systemReopenDebounceMinutes');
  } else if (Number(form.systemReopenDebounceMinutes) !== policy.systemReopenDebounceMinutes) {
    patch.systemReopenDebounceMinutes = Number(form.systemReopenDebounceMinutes);
  }

  if (form.maxShiftDurationHours === '') {
    incompleteFields.push('maxShiftDurationHours');
  } else if (Number(form.maxShiftDurationHours) !== policy.maxShiftDurationHours) {
    patch.maxShiftDurationHours = Number(form.maxShiftDurationHours);
  }

  return { patch, incompleteFields };
}

function describeErrorCode(code: string | undefined, fallback: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Please check the highlighted fields.';
    case 'FORBIDDEN':
      return 'You no longer have permission to update the attendance policy.';
    case 'NOT_AUTHENTICATED':
      return 'Your session has expired — please log in again.';
    case 'CSRF_REJECTED':
      return 'Your session needs a refresh — please reload the page and try again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This save could not be completed as a new request. Please make a fresh change and save again.';
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return 'This save is still being processed. Please wait a moment before trying again.';
    default:
      return fallback && fallback.length > 0 ? fallback : 'Something went wrong. Please review and try again.';
  }
}

function FieldError({ fieldErrors, field }: { fieldErrors: Record<string, string[]>; field: string }) {
  const messages = fieldErrors[field];
  if (!messages || messages.length === 0) {
    return null;
  }
  return (
    <p className="policy-field-error" role="alert">
      {messages.join('; ')}
    </p>
  );
}

export function PolicyForm({ initialPolicy, canUpdate }: { initialPolicy: PolicyView; canUpdate: boolean }) {
  const router = useRouter();
  const [policy, setPolicy] = useState(initialPolicy);
  const [form, setForm] = useState(() => formStateFromPolicy(initialPolicy));
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const pendingRef = useRef(false);

  const fieldsDisabled = !canUpdate || status === 'saving' || status === 'network-unknown';

  function onFieldChange(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (status !== 'idle' && status !== 'saving' && status !== 'network-unknown') {
      // A real edit after a concluded attempt (saved/validation-error/server-error) starts fresh —
      // the next Save computes a brand new diff and a brand new Idempotency-Key (§7).
      setStatus('idle');
      setErrorMessage(null);
      setFieldErrors({});
    }
  }

  async function runAttempt(a: Attempt): Promise<void> {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setStatus('saving');
    setAnnouncement('Saving…');
    setErrorMessage(null);
    setFieldErrors({});

    try {
      const res = await fetch(POLICY_URL, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': a.key },
        body: JSON.stringify(a.payload)
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // No/invalid JSON body — fall through to the generic message below.
      }

      if (res.ok) {
        setPolicy(data as PolicyView);
        setForm(formStateFromPolicy(data as PolicyView));
        setAttempt(null);
        setStatus('saved');
        setAnnouncement('Saved.');
        router.refresh();
        return;
      }

      const code = data?.error?.code as string | undefined;
      const message = data?.error?.message as string | undefined;
      const apiFieldErrors = (data?.error?.fieldErrors as Record<string, string[]> | undefined) ?? {};

      // Every non-network outcome concludes this attempt — a poisoned or rejected key must never
      // be silently reused; the next Save (after an edit) generates a fresh one (§7).
      setAttempt(null);
      setFieldErrors(apiFieldErrors);
      setErrorMessage(describeErrorCode(code, message));
      setStatus(res.status === 400 ? 'validation-error' : 'server-error');
      setAnnouncement(describeErrorCode(code, message));
    } catch {
      // Network failure/timeout — the request may or may not have reached the server. Keep the
      // SAME attempt (same key, same payload) alive for an explicit Retry — never regenerate it,
      // never auto-retry silently.
      setStatus('network-unknown');
      const msg = 'Connection problem — the result of this save is unknown. Retry sends the exact same request; it is safe to click again.';
      setErrorMessage(msg);
      setAnnouncement(msg);
    } finally {
      pendingRef.current = false;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pendingRef.current || !canUpdate) {
      return;
    }

    const { patch, incompleteFields } = buildPatch(form, policy);
    if (incompleteFields.length > 0) {
      setStatus('validation-error');
      setFieldErrors(Object.fromEntries(incompleteFields.map((f) => [f, ['This field is required.']])));
      setErrorMessage('Please fill in all fields before saving.');
      return;
    }
    if (Object.keys(patch).length === 0) {
      setStatus('validation-error');
      setFieldErrors({});
      setErrorMessage('Change at least one field before saving.');
      return;
    }

    const newAttempt: Attempt = { key: crypto.randomUUID(), payload: patch };
    setAttempt(newAttempt);
    await runAttempt(newAttempt);
  }

  async function handleRetry(): Promise<void> {
    if (pendingRef.current || !attempt) {
      return;
    }
    await runAttempt(attempt);
  }

  return (
    <div className="policy-form-wrap">
      <dl className="policy-readonly-grid">
        <div>
          <dt>Timezone</dt>
          <dd>{policy.timezone} (fixed)</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatHelsinkiDateTime(policy.updatedAt)}</dd>
        </div>
      </dl>

      {!canUpdate && (
        <p className="policy-readonly-note">You can view this policy but do not have permission to change it.</p>
      )}

      <form onSubmit={handleSubmit} noValidate aria-busy={status === 'saving'}>
        <div className="policy-field">
          <label htmlFor="policy-cutoff-days">Cutoff days after period end</label>
          <input
            id="policy-cutoff-days"
            name="cutoffDaysAfterPeriodEnd"
            type="number"
            min={0}
            max={31}
            step={1}
            value={form.cutoffDaysAfterPeriodEnd}
            onChange={(e) => onFieldChange('cutoffDaysAfterPeriodEnd', e.target.value)}
            disabled={fieldsDisabled}
          />
          <FieldError fieldErrors={fieldErrors} field="cutoffDaysAfterPeriodEnd" />
        </div>

        <div className="policy-field">
          <label htmlFor="policy-cutoff-time">Cutoff time (Europe/Helsinki)</label>
          <input
            id="policy-cutoff-time"
            name="cutoffTime"
            type="time"
            step={1}
            value={form.cutoffTime}
            onChange={(e) => onFieldChange('cutoffTime', e.target.value)}
            disabled={fieldsDisabled}
          />
          <FieldError fieldErrors={fieldErrors} field="cutoffTime" />
        </div>

        <div className="policy-field">
          <label htmlFor="policy-debounce-minutes">System reopen debounce (minutes)</label>
          <input
            id="policy-debounce-minutes"
            name="systemReopenDebounceMinutes"
            type="number"
            min={1}
            max={1440}
            step={1}
            value={form.systemReopenDebounceMinutes}
            onChange={(e) => onFieldChange('systemReopenDebounceMinutes', e.target.value)}
            disabled={fieldsDisabled}
          />
          <FieldError fieldErrors={fieldErrors} field="systemReopenDebounceMinutes" />
        </div>

        <div className="policy-field">
          <label htmlFor="policy-max-shift-hours">Maximum shift duration (hours)</label>
          <input
            id="policy-max-shift-hours"
            name="maxShiftDurationHours"
            type="number"
            min={1}
            max={168}
            step={1}
            value={form.maxShiftDurationHours}
            onChange={(e) => onFieldChange('maxShiftDurationHours', e.target.value)}
            disabled={fieldsDisabled}
          />
          <FieldError fieldErrors={fieldErrors} field="maxShiftDurationHours" />
        </div>

        {fieldErrors.body && <FieldError fieldErrors={fieldErrors} field="body" />}

        {errorMessage && (status === 'validation-error' || status === 'server-error') && (
          <p className="policy-error-banner" role="alert">
            {errorMessage}
          </p>
        )}

        {status === 'network-unknown' && (
          <div className="policy-network-unknown" role="alert">
            <p>{errorMessage}</p>
            <button type="button" className="login-submit" onClick={handleRetry}>
              Retry
            </button>
          </div>
        )}

        {canUpdate && status !== 'network-unknown' && (
          <button className="login-submit" type="submit" disabled={fieldsDisabled}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        )}

        <p className="policy-sr-announce" role="status" aria-live="polite">
          {announcement}
        </p>
      </form>
    </div>
  );
}
