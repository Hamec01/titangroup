'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { TemplateDetail } from '@/lib/templates';
import {
  TemplateDaysEditor,
  templateDaysFromDetail,
  toggleTemplateWorkingDay,
  updateTemplateDay,
  templateDaysToRequestPayload,
  type TemplateDayState
} from '../TemplateDaysEditor';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(locale: AppLocale, code: string | undefined, fieldErrors: Record<string, string[]> | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return fieldErrors?.days?.[0] ?? fieldErrors?.name?.[0] ?? fieldErrors?.description?.[0] ?? fieldErrors?.fields?.[0] ?? localeText(locale, 'Invalid form data.', 'Форма заполнена неверно.');
    case 'TEMPLATE_NOT_FOUND':
      return localeText(locale, 'This template no longer exists.', 'Этого шаблона больше нет.');
    case 'NOT_AUTHENTICATED':
      return localeText(locale, 'Your session expired — please sign in again.', 'Сессия завершилась — войдите снова.');
    case 'FORBIDDEN':
      return localeText(locale, 'You no longer have permission to edit templates.', 'У вас больше нет права изменять шаблоны.');
    default:
      return localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.');
  }
}

// docs/titanor-time/01_SCREEN_MAP.md — /admin/templates/[templateId] Edit section. Saving never
// rewrites the current WorkScheduleTemplateVersion — PATCH always creates a new immutable version
// (docs/titanor-time/03_DATA_MODEL_ERD.md §4.5), so existing SiteAssignment rows keep pointing at
// whichever templateVersionId they already recorded until explicitly moved via assignment.split —
// this form never touches SiteAssignment at all.
export function EditTemplateForm({ template }: { template: TemplateDetail }) {
  const router = useRouter();
  const locale = useAppLocale();
  const s = adminDailyStrings(locale);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [days, setDays] = useState<TemplateDayState[]>(() => templateDaysFromDetail(template.days));
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [savedVersionNumber, setSavedVersionNumber] = useState<number | null>(null);

  function updateDay(weekday: number, patch: Partial<TemplateDayState>): void {
    setDays((current) => updateTemplateDay(current, weekday, patch));
  }

  function toggleWorkingDay(weekday: number, isWorkingDay: boolean): void {
    setDays((current) => toggleTemplateWorkingDay(current, weekday, isWorkingDay));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setConflict(false);
    setSavedVersionNumber(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/templates/${template.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          expectedVersionNumber: template.currentVersionNumber,
          name,
          description: description || null,
          days: templateDaysToRequestPayload(days)
        })
      });

      if (!response.ok) {
        let code: string | undefined;
        let fieldErrors: Record<string, string[]> | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string; fieldErrors?: Record<string, string[]> } };
          code = body.error?.code;
          fieldErrors = body.error?.fieldErrors;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        if (code === 'VERSION_CONFLICT') {
          setConflict(true);
        }
        setErrorMessage(describeError(locale, code, fieldErrors));
        setLoading(false);
        return;
      }

      const updated = (await response.json()) as { currentVersionNumber: number };
      setSavedVersionNumber(updated.currentVersionNumber);
      setEditing(false);
      setLoading(false);
      router.refresh();
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  function handleReload(): void {
    router.refresh();
  }

  if (!editing) {
    return (
      <div>
        {savedVersionNumber !== null ? <p className="setup-subtitle">{localeText(locale, 'Saved — now on version', 'Сохранено — текущая версия')} {savedVersionNumber}.</p> : null}
        <button type="button" className="login-submit" onClick={() => setEditing(true)}>
          {localeText(locale, 'Edit schedule', 'Изменить график')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <h2>{localeText(locale, 'Edit schedule', 'Изменить график')}</h2>
      <p className="setup-subtitle">
        {localeText(locale, 'Saving creates a new version. Existing assignments remain on their recorded version until changed or split.', 'При сохранении создаётся новая версия. Существующие назначения сохраняют прежнюю версию, пока их не изменить или разделить.')}
      </p>

      <div className="login-field">
        <label htmlFor="template-edit-name">{s.common.name}</label>
        <input
          id="template-edit-name"
          type="text"
          required
          disabled={loading}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="template-edit-description">{s.sites.description}</label>
        <textarea
          id="template-edit-description"
          rows={2}
          disabled={loading}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <TemplateDaysEditor days={days} loading={loading} onToggleWorkingDay={toggleWorkingDay} onUpdateDay={updateDay} />

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {conflict ? (
        <button type="button" className="login-submit" onClick={handleReload}>
          {localeText(locale, 'Reload', 'Обновить')}
        </button>
      ) : (
        <>
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? s.common.saving : localeText(locale, 'Save changes', 'Сохранить изменения')}
          </button>
          <button type="button" className="login-submit" disabled={loading} onClick={() => setEditing(false)}>
            {localeText(locale, 'Cancel', 'Отмена')}
          </button>
        </>
      )}
    </form>
  );
}
