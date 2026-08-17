import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ExceptionDetail, ClockShiftDetail } from '@/lib/attendance-exceptions';
import {
  exceptionTypeLabel,
  exceptionStatusLabel,
  exceptionStatusBadgeClass,
  channelLabel,
  gpsVerificationLabel,
  gpsUnavailableReasonLabel,
  operationTypeLabel,
  materializationStateLabel,
  projectionStateLabel,
  timesheetStatusLabel,
  formatDateTime,
  detailKeyLabel
} from '@/lib/attendance-exceptions-ui';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.3 — T7A.8C.1. Renders only the
// already-allowlisted ExceptionDetail DTO returned by lib/attendance-exceptions.ts's
// getAttendanceExceptionDetail — never fetches or displays anything beyond what that function
// returns (no raw GPS/payloadHash/requestId/device fields exist on the DTO to begin with, so
// there is nothing here that could leak them). A null clockShift/relatedClockShift is rendered the
// same way regardless of whether the underlying reason is "nothing linked" or FOREMAN own↔foreign
// redaction — this view never tries to tell those apart or guess the redacted side's data.

interface Props {
  basePath: string;
  detail: ExceptionDetail;
  /** Non-null only for ADMIN when a timesheet is linked — FOREMAN never gets a clickable link. */
  timesheetHref: string | null;
  /** T7A.8C.2 — the interactive resolution UI (ExceptionActionPanel), rendered only while the
   * exception is still OPEN. The page always passes one; this component never builds it itself
   * (it stays a pure display of the already-allowlisted ExceptionDetail DTO, same as T7A.8C.1). */
  resolutionPanel: ReactNode;
}

export function ExceptionDetailView({ basePath, detail, timesheetHref, resolutionPanel }: Props) {
  const isTerminal = detail.status !== 'OPEN';

  return (
    <div className="setup-card worker-card exc-card">
      <p>
        <Link href={basePath}>&larr; Back to exceptions</Link>
      </p>

      <div className="exc-detail-header">
        <h1>{exceptionTypeLabel(detail.type)}</h1>
        <span className={exceptionStatusBadgeClass(detail.status)}>{exceptionStatusLabel(detail.status)}</span>
      </div>
      <p className="exc-summary-lead">{detail.summary}</p>
      <p className="exc-muted exc-id-line">Exception ID: {detail.id}</p>

      <section className="exc-detail-section">
        <h2 className="wk-section-title">Overview</h2>
        <dl className="exc-detail-grid">
          <div>
            <dt>Employee</dt>
            <dd>{detail.employee.name}</dd>
          </div>
          <div>
            <dt>Site</dt>
            <dd>{detail.site ? detail.site.name : '—'}</dd>
          </div>
          <div>
            <dt>Occurred at</dt>
            <dd>{formatDateTime(detail.occurredAt)}</dd>
          </div>
          <div>
            <dt>Created at</dt>
            <dd>{formatDateTime(detail.createdAt)}</dd>
          </div>
          <div>
            <dt>Payroll period</dt>
            <dd>{detail.payrollPeriod ? `${detail.payrollPeriod.startDate} – ${detail.payrollPeriod.endDate}` : 'Not linked'}</dd>
          </div>
          <div>
            <dt>Timesheet</dt>
            <dd>
              {detail.timesheet ? (
                timesheetHref ? (
                  <Link href={timesheetHref}>View timesheet ({timesheetStatusLabel(detail.timesheet.status)})</Link>
                ) : (
                  timesheetStatusLabel(detail.timesheet.status)
                )
              ) : (
                'Not linked'
              )}
            </dd>
          </div>
        </dl>
      </section>

      {detail.clockEvent && (
        <section className="exc-detail-section">
          <h2 className="wk-section-title">Clock event</h2>
          <dl className="exc-detail-grid">
            <div>
              <dt>Operation</dt>
              <dd>{operationTypeLabel(detail.clockEvent.operationType)}</dd>
            </div>
            <div>
              <dt>Effective at</dt>
              <dd>{formatDateTime(detail.clockEvent.effectiveAt)}</dd>
            </div>
            <div>
              <dt>Received by server</dt>
              <dd>{formatDateTime(detail.clockEvent.serverReceivedAt)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                {channelLabel(detail.clockEvent.channel)}
                {detail.clockEvent.capturedOffline ? ' · captured offline' : ''}
              </dd>
            </div>
            <div>
              <dt>GPS verification</dt>
              <dd>{gpsVerificationLabel(detail.clockEvent.gpsVerification)}</dd>
            </div>
            <div>
              <dt>GPS accuracy</dt>
              <dd>{detail.clockEvent.gpsAccuracyMeters !== null ? `${detail.clockEvent.gpsAccuracyMeters} m` : '—'}</dd>
            </div>
            {detail.clockEvent.gpsUnavailableReason && (
              <div>
                <dt>GPS unavailable reason</dt>
                <dd>{gpsUnavailableReasonLabel(detail.clockEvent.gpsUnavailableReason)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <ClockShiftSection title="Shift" shift={detail.clockShift} />
      <ClockShiftSection title="Related shift" shift={detail.relatedClockShift} />

      {detail.detail && (
        <section className="exc-detail-section">
          <h2 className="wk-section-title">Additional detail</h2>
          <dl className="exc-detail-grid">
            {Object.entries(detail.detail).map(([key, value]) => (
              <div key={key}>
                <dt>{detailKeyLabel(key)}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="exc-detail-section">
        <h2 className="wk-section-title">Resolution</h2>
        {isTerminal ? (
          <dl className="exc-detail-grid">
            <div>
              <dt>Resolved at</dt>
              <dd>{detail.resolvedAt ? formatDateTime(detail.resolvedAt) : '—'}</dd>
            </div>
            <div>
              <dt>Resolved by</dt>
              <dd>{detail.resolvedBy ? detail.resolvedBy.name : '—'}</dd>
            </div>
            <div>
              <dt>Note</dt>
              <dd>{detail.resolutionNote ?? 'No note'}</dd>
            </div>
          </dl>
        ) : (
          resolutionPanel
        )}
      </section>
    </div>
  );
}

function ClockShiftSection({ title, shift }: { title: string; shift: ClockShiftDetail | null }) {
  if (!shift) {
    return (
      <section className="exc-detail-section">
        <h2 className="wk-section-title">{title}</h2>
        <p className="exc-muted">Not available.</p>
      </section>
    );
  }

  return (
    <section className="exc-detail-section">
      <h2 className="wk-section-title">{title}</h2>
      <dl className="exc-detail-grid">
        <div>
          <dt>Site</dt>
          <dd>{shift.site.name}</dd>
        </div>
        <div>
          <dt>Work area</dt>
          <dd>{shift.workArea ? shift.workArea.name : '—'}</dd>
        </div>
        <div>
          <dt>Recorded start</dt>
          <dd>{formatDateTime(shift.recordedStartAt)}</dd>
        </div>
        <div>
          <dt>Recorded end</dt>
          <dd>
            {formatDateTime(shift.recordedEndAt)}
            {shift.endAtProvisional ? ' (provisional)' : ''}
          </dd>
        </div>
        <div>
          <dt>Materialization</dt>
          <dd>{materializationStateLabel(shift.materializationState)}</dd>
        </div>
      </dl>
      {shift.fragments.length > 0 && (
        <>
          <h3 className="exc-subsection-title">Fragments</h3>
          <ul className="exc-fragment-list">
            {shift.fragments.map((f) => (
              <li key={f.id}>
                #{f.fragmentIndex}: {formatDateTime(f.recordedStartAt)} – {formatDateTime(f.recordedEndAt)} · {projectionStateLabel(f.reportedProjectionState)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
