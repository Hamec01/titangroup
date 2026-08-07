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

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, fieldErrors: Record<string, string[]> | undefined): string | null {
  switch (code) {
    case 'VALIDATION_ERROR':
      return fieldErrors?.days?.[0] ?? fieldErrors?.name?.[0] ?? fieldErrors?.description?.[0] ?? fieldErrors?.fields?.[0] ?? 'Invalid form data.';
    case 'TEMPLATE_NOT_FOUND':
      return 'This template no longer exists.';
    case 'NOT_AUTHENTICATED':
      return 'Your session expired — please sign in again.';
    case 'FORBIDDEN':
      return 'You no longer have permission to edit templates.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// docs/titanor-time/01_SCREEN_MAP.md — /admin/templates/[templateId] Edit section. Saving never
// rewrites the current WorkScheduleTemplateVersion — PATCH always creates a new immutable version
// (docs/titanor-time/03_DATA_MODEL_ERD.md §4.5), so existing SiteAssignment rows keep pointing at
// whichever templateVersionId they already recorded until explicitly moved via assignment.split —
// this form never touches SiteAssignment at all.
export function EditTemplateForm({ template }: { template: TemplateDetail }) {
  const router = useRouter();
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
        setErrorMessage(describeError(code, fieldErrors));
        setLoading(false);
        return;
      }

      const updated = (await response.json()) as { currentVersionNumber: number };
      setSavedVersionNumber(updated.currentVersionNumber);
      setEditing(false);
      setLoading(false);
      router.refresh();
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  function handleReload(): void {
    router.refresh();
  }

  if (!editing) {
    return (
      <div>
        {savedVersionNumber !== null ? <p className="setup-subtitle">Saved — now on version {savedVersionNumber}.</p> : null}
        <button type="button" className="login-submit" onClick={() => setEditing(true)}>
          Edit schedule
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <h2>Edit schedule</h2>
      <p className="setup-subtitle">
        Saving creates a new version. Existing assignments remain on their recorded version until changed or split.
      </p>

      <div className="login-field">
        <label htmlFor="template-edit-name">Name</label>
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
        <label htmlFor="template-edit-description">Description (optional)</label>
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
          Reload
        </button>
      ) : (
        <>
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="login-submit" disabled={loading} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      )}
    </form>
  );
}
