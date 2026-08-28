'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { PolicyView, PolicyPatchInput } from '@/lib/attendance-policy';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

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
  maxGpsAccuracyMeters: string;
  autoUnpaidBreakThresholdMinutes: string;
  autoUnpaidBreakMinutes: string;
  autoCloseShiftFallbackHours: string;
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
    maxShiftDurationHours: String(policy.maxShiftDurationHours),
    maxGpsAccuracyMeters: String(policy.maxGpsAccuracyMeters),
    autoUnpaidBreakThresholdMinutes: String(policy.autoUnpaidBreakThresholdMinutes),
    autoUnpaidBreakMinutes: String(policy.autoUnpaidBreakMinutes),
    autoCloseShiftFallbackHours: String(policy.autoCloseShiftFallbackHours)
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

  if (form.maxGpsAccuracyMeters === '') {
    incompleteFields.push('maxGpsAccuracyMeters');
  } else if (Number(form.maxGpsAccuracyMeters) !== policy.maxGpsAccuracyMeters) {
    patch.maxGpsAccuracyMeters = Number(form.maxGpsAccuracyMeters);
  }

  if (form.autoUnpaidBreakThresholdMinutes === '') {
    incompleteFields.push('autoUnpaidBreakThresholdMinutes');
  } else if (Number(form.autoUnpaidBreakThresholdMinutes) !== policy.autoUnpaidBreakThresholdMinutes) {
    patch.autoUnpaidBreakThresholdMinutes = Number(form.autoUnpaidBreakThresholdMinutes);
  }

  if (form.autoUnpaidBreakMinutes === '') {
    incompleteFields.push('autoUnpaidBreakMinutes');
  } else if (Number(form.autoUnpaidBreakMinutes) !== policy.autoUnpaidBreakMinutes) {
    patch.autoUnpaidBreakMinutes = Number(form.autoUnpaidBreakMinutes);
  }

  if (form.autoCloseShiftFallbackHours === '') {
    incompleteFields.push('autoCloseShiftFallbackHours');
  } else if (Number(form.autoCloseShiftFallbackHours) !== policy.autoCloseShiftFallbackHours) {
    patch.autoCloseShiftFallbackHours = Number(form.autoCloseShiftFallbackHours);
  }

  return { patch, incompleteFields };
}

function describeErrorCode(code: string | undefined, fallback: string | undefined, ru: boolean): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return ru ? 'Проверьте выделенные поля.' : 'Please check the highlighted fields.';
    case 'FORBIDDEN':
      return ru ? 'У вас больше нет права изменять политику учёта.' : 'You no longer have permission to update the attendance policy.';
    case 'NOT_AUTHENTICATED':
      return ru ? 'Сессия истекла — войдите снова.' : 'Your session has expired — please log in again.';
    case 'CSRF_REJECTED':
      return ru ? 'Сессию нужно обновить — перезагрузите страницу и попробуйте снова.' : 'Your session needs a refresh — please reload the page and try again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return ru ? 'Это сохранение не удалось выполнить как новый запрос. Внесите новое изменение и сохраните снова.' : 'This save could not be completed as a new request. Please make a fresh change and save again.';
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return ru ? 'Это сохранение всё ещё обрабатывается. Подождите немного перед повторной попыткой.' : 'This save is still being processed. Please wait a moment before trying again.';
    default:
      return fallback && fallback.length > 0 ? fallback : (ru ? 'Что-то пошло не так. Проверьте и попробуйте снова.' : 'Something went wrong. Please review and try again.');
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
  const ru = useAppLocale() === 'RU';
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
    setAnnouncement(ru ? 'Сохранение…' : 'Saving…');
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
        setAnnouncement(ru ? 'Сохранено.' : 'Saved.');
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
      setErrorMessage(describeErrorCode(code, message, ru));
      setStatus(res.status === 400 ? 'validation-error' : 'server-error');
      setAnnouncement(describeErrorCode(code, message, ru));
    } catch {
      // Network failure/timeout — the request may or may not have reached the server. Keep the
      // SAME attempt (same key, same payload) alive for an explicit Retry — never regenerate it,
      // never auto-retry silently.
      setStatus('network-unknown');
      const msg = ru ? 'Проблема с соединением — результат сохранения неизвестен. «Повторить» отправит точно такой же запрос; можно нажимать ещё раз.' : 'Connection problem — the result of this save is unknown. Retry sends the exact same request; it is safe to click again.';
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
      setFieldErrors(Object.fromEntries(incompleteFields.map((f) => [f, [ru ? 'Это поле обязательно.' : 'This field is required.']])));
      setErrorMessage(ru ? 'Заполните все поля перед сохранением.' : 'Please fill in all fields before saving.');
      return;
    }
    if (Object.keys(patch).length === 0) {
      setStatus('validation-error');
      setFieldErrors({});
      setErrorMessage(ru ? 'Измените хотя бы одно поле перед сохранением.' : 'Change at least one field before saving.');
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
          <dt>{ru ? 'Часовой пояс' : 'Timezone'}</dt>
          <dd>{policy.timezone} ({ru ? 'фиксировано' : 'fixed'})</dd>
        </div>
        <div>
          <dt>{ru ? 'Последнее обновление' : 'Last updated'}</dt>
          <dd>{formatHelsinkiDateTime(policy.updatedAt)}</dd>
        </div>
      </dl>

      {!canUpdate && (
        <p className="policy-readonly-note">{ru ? 'Вы можете просматривать эту политику, но у вас нет прав на её изменение.' : 'You can view this policy but do not have permission to change it.'}</p>
      )}

      <form onSubmit={handleSubmit} noValidate aria-busy={status === 'saving'}>
        <div className="policy-field">
          <label htmlFor="policy-cutoff-days">{ru ? 'Дней после окончания периода до закрытия' : 'Cutoff days after period end'}</label>
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
          <label htmlFor="policy-cutoff-time">{ru ? 'Время закрытия (Europe/Helsinki)' : 'Cutoff time (Europe/Helsinki)'}</label>
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
          <label htmlFor="policy-debounce-minutes">{ru ? 'Задержка повторного открытия системой (минуты)' : 'System reopen debounce (minutes)'}</label>
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
          <label htmlFor="policy-max-shift-hours">{ru ? 'Максимальная длительность смены (часы)' : 'Maximum shift duration (hours)'}</label>
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

        <div className="policy-field">
          <label htmlFor="policy-max-gps-accuracy">{ru ? 'Максимальная точность GPS для подтверждения геозоны (метры)' : 'Max GPS accuracy for geofence verification (metres)'}</label>
          <input
            id="policy-max-gps-accuracy"
            name="maxGpsAccuracyMeters"
            type="number"
            min={10}
            max={5000}
            step={5}
            value={form.maxGpsAccuracyMeters}
            onChange={(e) => onFieldChange('maxGpsAccuracyMeters', e.target.value)}
            disabled={fieldsDisabled}
          />
          <p className="policy-readonly-note">
            {ru
              ? 'Отметка прихода/ухода с точностью хуже этого значения помечается «GPS не подтверждён» и уходит администратору на проверку. По умолчанию 75 м; повысьте, если на объекте стабильно слабый сигнал (например, внутри цеха).'
              : 'A clock-in/out with accuracy worse than this is flagged “GPS not verified” for admin review. Default 75 m; raise it for a site with chronically weak signal (e.g. inside a workshop).'}
          </p>
          <FieldError fieldErrors={fieldErrors} field="maxGpsAccuracyMeters" />
        </div>

        <div className="policy-field">
          <label htmlFor="policy-auto-unpaid-threshold">{ru ? 'Порог для автоматического вычета обеда (минуты отработки)' : 'Auto unpaid-lunch threshold (worked minutes)'}</label>
          <input
            id="policy-auto-unpaid-threshold"
            name="autoUnpaidBreakThresholdMinutes"
            type="number"
            min={0}
            max={1440}
            step={30}
            value={form.autoUnpaidBreakThresholdMinutes}
            onChange={(e) => onFieldChange('autoUnpaidBreakThresholdMinutes', e.target.value)}
            disabled={fieldsDisabled}
          />
          <p className="policy-readonly-note">
            {ru
              ? 'Если работник отработал за день не меньше этого времени и не отметил перерыв, из оплачиваемых часов автоматически вычитается плановый обед. По умолчанию 360 мин (6 ч) — финская норма. 0 — вычитать всегда.'
              : 'If a worker logs at least this much on a day and records no break, the planned lunch is auto-deducted from paid hours. Default 360 min (6 h) — the Finnish norm. 0 = always deduct.'}
          </p>
          <FieldError fieldErrors={fieldErrors} field="autoUnpaidBreakThresholdMinutes" />
        </div>

        <div className="policy-field">
          <label htmlFor="policy-auto-unpaid-minutes">{ru ? 'Обед по умолчанию, если в шаблоне не задан (минуты)' : 'Default unpaid lunch when the template has none (minutes)'}</label>
          <input
            id="policy-auto-unpaid-minutes"
            name="autoUnpaidBreakMinutes"
            type="number"
            min={0}
            max={1440}
            step={5}
            value={form.autoUnpaidBreakMinutes}
            onChange={(e) => onFieldChange('autoUnpaidBreakMinutes', e.target.value)}
            disabled={fieldsDisabled}
          />
          <p className="policy-readonly-note">
            {ru
              ? 'Страховка: применяется, когда у смены нет своего перерыва (например, объект без шаблона графика). Шаблон со своим перерывом или галочкой «обед оплачивается» всегда важнее. По умолчанию 30 мин; 0 — отключить страховку.'
              : 'Safety net: used when a shift has no break of its own (e.g. an assignment with no schedule template). A template with its own break or the “lunch is paid” flag always wins. Default 30 min; 0 disables the fallback.'}
          </p>
          <FieldError fieldErrors={fieldErrors} field="autoUnpaidBreakMinutes" />
        </div>

        <div className="policy-field">
          <label htmlFor="policy-auto-close-fallback">{ru ? 'Смена без ухода: расчётная длина, если в графике нет окончания (часы)' : 'Abandoned shift: estimated length when the template has no planned end (hours)'}</label>
          <input
            id="policy-auto-close-fallback"
            name="autoCloseShiftFallbackHours"
            type="number"
            min={1}
            max={24}
            step={1}
            value={form.autoCloseShiftFallbackHours}
            onChange={(e) => onFieldChange('autoCloseShiftFallbackHours', e.target.value)}
            disabled={fieldsDisabled}
          />
          <p className="policy-readonly-note">
            {ru
              ? 'Если работник не сделал уход и смена висит дольше «максимальной длительности смены», планировщик закрывает её плановым временем окончания из графика. Когда планового окончания нет (нет шаблона или это выходной) — берётся приход + столько часов. По умолчанию 8. Реальный уход, пришедший до авто-закрытия, всё равно закрывает смену обычным образом.'
              : 'If a worker never checks out and the shift stays open past “maximum shift duration”, the scheduler closes it at the day’s planned end from the schedule. When there is no planned end (no template, or a day off) it uses check-in + this many hours. Default 8. A real check-out arriving before the auto-close still closes the shift normally.'}
          </p>
          <FieldError fieldErrors={fieldErrors} field="autoCloseShiftFallbackHours" />
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
              {ru ? 'Повторить' : 'Retry'}
            </button>
          </div>
        )}

        {canUpdate && status !== 'network-unknown' && (
          <button className="login-submit" type="submit" disabled={fieldsDisabled}>
            {status === 'saving' ? (ru ? 'Сохранение…' : 'Saving…') : (ru ? 'Сохранить' : 'Save')}
          </button>
        )}

        <p className="policy-sr-announce" role="status" aria-live="polite">
          {announcement}
        </p>
      </form>
    </div>
  );
}
