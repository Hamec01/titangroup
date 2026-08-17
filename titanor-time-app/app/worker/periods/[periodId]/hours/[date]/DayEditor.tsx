'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ReturnReasonView } from '@/lib/worker-timesheets';
import { helsinkiDateAndTimeToUtcIso as helsinkiTimeToIso, utcIsoToHelsinkiTime as isoToHelsinkiTime } from '@/lib/helsinki-datetime';
import { ReturnReasonsNotice } from '../../ReturnReasonsNotice';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

function assignmentKeyOf(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

interface AssignmentOption {
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
}

interface InitialBreak {
  startAt: string;
  endAt: string;
  paid: boolean;
}

interface InitialSegment {
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  breaks: InitialBreak[];
}

interface DayEditorProps {
  periodId: string;
  timesheetId: string;
  date: string;
  initialDayType: string;
  initialConfirmedZero: boolean;
  initialSegments: InitialSegment[];
  assignmentOptions: AssignmentOption[];
  timesheetStatus: string;
  returnReasons: ReturnReasonView[];
}

interface EditableBreak {
  startAt: string;
  endAt: string;
  paid: boolean;
}

interface EditableSegment {
  key: number;
  assignmentKey: string;
  startAt: string;
  endAt: string;
  breaks: EditableBreak[];
}

let nextKey = 0;

function describeError(code: string | undefined, fieldErrors: Record<string, string[]> | undefined): string {
  switch (code) {
    case 'WORK_SEGMENT_OVERLAP':
      return 'These time ranges overlap — please adjust them.';
    case 'SITE_NOT_ASSIGNED':
      return 'You are not assigned to that site/area on this date.';
    case 'DAY_TYPE_CONFLICT':
      return 'Cannot have hours logged and mark the day as absence at the same time.';
    case 'DAY_STATE_CONFLICT':
      return 'Cannot confirm zero hours while hours are logged.';
    case 'DAY_TYPE_REQUIRES_ABSENCE':
      return 'This day type requires an approved absence request.';
    case 'DRAFT_NOT_EDITABLE':
      return 'This timesheet can no longer be edited.';
    case 'VALIDATION_ERROR':
      return fieldErrors
        ? Object.entries(fieldErrors)
            .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
            .join('; ')
        : 'Invalid input.';
    default:
      return 'Could not save — please try again.';
  }
}

export default function DayEditor({
  periodId,
  timesheetId,
  date,
  initialDayType,
  initialConfirmedZero,
  initialSegments,
  assignmentOptions,
  timesheetStatus,
  returnReasons
}: DayEditorProps) {
  const router = useRouter();
  const [segments, setSegments] = useState<EditableSegment[]>(() =>
    initialSegments.map((s) => ({
      key: nextKey++,
      assignmentKey: assignmentKeyOf(s.siteId, s.workAreaId),
      startAt: isoToHelsinkiTime(s.startAt),
      endAt: isoToHelsinkiTime(s.endAt),
      breaks: s.breaks.map((b) => ({ startAt: isoToHelsinkiTime(b.startAt), endAt: isoToHelsinkiTime(b.endAt), paid: b.paid }))
    }))
  );
  const [confirmedZero, setConfirmedZero] = useState(initialConfirmedZero);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAbsenceDay = initialDayType !== 'WORK';

  function addSegment() {
    if (assignmentOptions.length === 0) {
      return;
    }
    setSegments((prev) => [
      ...prev,
      { key: nextKey++, assignmentKey: assignmentKeyOf(assignmentOptions[0].siteId, assignmentOptions[0].workAreaId), startAt: '08:00', endAt: '16:00', breaks: [] }
    ]);
    setConfirmedZero(false);
  }

  function removeSegment(key: number) {
    setSegments((prev) => prev.filter((s) => s.key !== key));
  }

  function updateSegment(key: number, patch: Partial<EditableSegment>) {
    setSegments((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function addBreak(segKey: number) {
    setSegments((prev) => prev.map((s) => (s.key === segKey ? { ...s, breaks: [...s.breaks, { startAt: '12:00', endAt: '12:30', paid: false }] } : s)));
  }

  function updateBreak(segKey: number, breakIndex: number, patch: Partial<EditableBreak>) {
    setSegments((prev) => prev.map((s) => (s.key === segKey ? { ...s, breaks: s.breaks.map((b, i) => (i === breakIndex ? { ...b, ...patch } : b)) } : s)));
  }

  function removeBreak(segKey: number, breakIndex: number) {
    setSegments((prev) => prev.map((s) => (s.key === segKey ? { ...s, breaks: s.breaks.filter((_, i) => i !== breakIndex) } : s)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const body = {
        confirmedZero: segments.length === 0 ? confirmedZero : false,
        segments: segments.map((s) => {
          const [siteId, workAreaId] = s.assignmentKey.split('::');
          return {
            startAt: helsinkiTimeToIso(date, s.startAt),
            endAt: helsinkiTimeToIso(date, s.endAt),
            siteId,
            workAreaId: workAreaId || null,
            breaks: s.breaks.map((b) => ({ startAt: helsinkiTimeToIso(date, b.startAt), endAt: helsinkiTimeToIso(date, b.endAt), paid: b.paid }))
          };
        })
      };
      const res = await fetch(`/api/worker/timesheets/${timesheetId}/days/${date}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(describeError(data?.error?.code, data?.error?.fieldErrors));
        setSaving(false);
        return;
      }
      router.push(`/worker/periods/${periodId}/hours`);
    } catch {
      setError('Network error — please try again.');
      setSaving(false);
    }
  }

  return (
    <main className="wk-page">
      <div className="wk-card">
        <a href={`/worker/periods/${periodId}/hours`} className="wk-back-link">
          ← Back
        </a>
        <h1>{date}</h1>

        <ReturnReasonsNotice status={timesheetStatus} reasons={returnReasons} />

        {isAbsenceDay ? (
          <p className="wk-readonly-note">This day is marked as {initialDayType.replace('_', ' ').toLowerCase()}. Manage absences from your profile.</p>
        ) : (
          <>
            {segments.length === 0 && (
              <label className="wk-checkbox-row">
                <input type="checkbox" checked={confirmedZero} onChange={(e) => setConfirmedZero(e.target.checked)} disabled={saving} />
                No hours worked today
              </label>
            )}

            <ul className="wk-segment-list">
              {segments.map((segment) => (
                <li key={segment.key} className="wk-segment-card">
                  <select value={segment.assignmentKey} onChange={(e) => updateSegment(segment.key, { assignmentKey: e.target.value })} disabled={saving}>
                    {assignmentOptions.map((option) => {
                      const key = assignmentKeyOf(option.siteId, option.workAreaId);
                      return (
                        <option key={key} value={key}>
                          {option.siteName}
                          {option.workAreaName ? ` — ${option.workAreaName}` : ''}
                        </option>
                      );
                    })}
                  </select>
                  <div className="wk-time-row">
                    <input type="time" value={segment.startAt} onChange={(e) => updateSegment(segment.key, { startAt: e.target.value })} disabled={saving} />
                    <span>–</span>
                    <input type="time" value={segment.endAt} onChange={(e) => updateSegment(segment.key, { endAt: e.target.value })} disabled={saving} />
                  </div>

                  {segment.breaks.map((b, i) => (
                    <div key={i} className="wk-break-row">
                      <input type="time" value={b.startAt} onChange={(e) => updateBreak(segment.key, i, { startAt: e.target.value })} disabled={saving} />
                      <span>–</span>
                      <input type="time" value={b.endAt} onChange={(e) => updateBreak(segment.key, i, { endAt: e.target.value })} disabled={saving} />
                      <label className="wk-break-paid">
                        <input type="checkbox" checked={b.paid} onChange={(e) => updateBreak(segment.key, i, { paid: e.target.checked })} disabled={saving} />
                        Paid
                      </label>
                      <button type="button" className="wk-remove-button" onClick={() => removeBreak(segment.key, i)} disabled={saving}>
                        Remove break
                      </button>
                    </div>
                  ))}
                  <button type="button" className="wk-secondary-button" onClick={() => addBreak(segment.key)} disabled={saving}>
                    + Add break
                  </button>

                  <button type="button" className="wk-remove-button" onClick={() => removeSegment(segment.key)} disabled={saving}>
                    Remove interval
                  </button>
                </li>
              ))}
            </ul>

            <button type="button" className="wk-secondary-button" onClick={addSegment} disabled={saving || assignmentOptions.length === 0}>
              + Add interval
            </button>
          </>
        )}

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        {!isAbsenceDay && (
          <button type="button" className="wk-action-button" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </main>
  );
}
