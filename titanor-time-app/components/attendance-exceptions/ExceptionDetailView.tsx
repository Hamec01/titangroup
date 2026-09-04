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
import type { AppLocale } from '@/lib/i18n/locale';
import { ExceptionGpsMap } from './ExceptionGpsMap';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.3 — T7A.8C.1. Renders only the
// already-allowlisted ExceptionDetail DTO returned by lib/attendance-exceptions.ts's
// getAttendanceExceptionDetail — never fetches or displays anything beyond what that function
// returns (no raw GPS/payloadHash/requestId/device fields exist on the DTO to begin with, so
// there is nothing here that could leak them). A null clockShift/relatedClockShift is rendered the
// same way regardless of whether the underlying reason is "nothing linked" or FOREMAN own↔foreign
// redaction — this view never tries to tell those apart or guess the redacted side's data.

// T14 — a one-line description of an approximate GPS point (its age / how long after the event it
// arrived), for both the Clock-event field list and the mini-map caption.
function approximateLocationNote(loc: NonNullable<ExceptionDetail['gpsLocation']>, ru: boolean): string {
  const mins = (seconds: number) => Math.max(1, Math.round(seconds / 60));
  if (loc.capturedAfterEventSeconds !== null) {
    return ru
      ? `Приблизительно — координаты получены примерно через ${mins(loc.capturedAfterEventSeconds)} мин после отметки`
      : `Approximate — location fixed about ${mins(loc.capturedAfterEventSeconds)} min after the clock event`;
  }
  if (loc.fixAgeSeconds !== null) {
    return ru
      ? `Приблизительно — последняя известная координата устройства, ≈ ${mins(loc.fixAgeSeconds)} мин назад`
      : `Approximate — the device's last known location, ≈ ${mins(loc.fixAgeSeconds)} min old`;
  }
  return ru ? 'Приблизительно — координата из кэша устройства, возраст неизвестен' : 'Approximate — a cached device location, age unknown';
}

interface Props {
  basePath: string;
  detail: ExceptionDetail;
  /** Non-null only for ADMIN when a timesheet is linked — FOREMAN never gets a clickable link. */
  timesheetHref: string | null;
  /** T7A.8C.2 — the interactive resolution UI (ExceptionActionPanel), rendered only while the
   * exception is still OPEN. The page always passes one; this component never builds it itself
   * (it stays a pure display of the already-allowlisted ExceptionDetail DTO, same as T7A.8C.1). */
  resolutionPanel: ReactNode;
  locale: AppLocale;
}

export function ExceptionDetailView({ basePath, detail, timesheetHref, resolutionPanel, locale }: Props) {
  const ru = locale === 'RU';
  const isTerminal = detail.status !== 'OPEN';

  return (
    <div className="setup-card worker-card exc-card">
      <p>
        <Link href={basePath}>&larr; {ru ? 'К списку исключений' : 'Back to exceptions'}</Link>
      </p>

      <div className="exc-detail-header">
        <h1>{exceptionTypeLabel(detail.type, locale)}</h1>
        <span className={exceptionStatusBadgeClass(detail.status)}>{exceptionStatusLabel(detail.status, locale)}</span>
      </div>
      <p className="exc-summary-lead">{detail.summary}</p>
      {detail.siteGpsOftenUnavailable && detail.type === 'GPS_NOT_VERIFIED' && (
        <p
          className="exc-info-note"
          role="note"
          style={{ borderLeft: '3px solid #7a7a7a', padding: '6px 10px', margin: '8px 0', fontSize: '0.9em', opacity: 0.9 }}
        >
          {ru
            ? 'Объект отмечен как место, где часто нет GPS-сигнала (корпус судна, крытый цех). Отметка без координат отсюда — обычное дело; как правило её можно принять. Проверка и решение — за администратором; автоматически ничего не принято.'
            : 'This site is flagged as a place where GPS is often unavailable (ship hull, covered hall). A check-in with no location from here is expected — it can usually be accepted. The review and the decision are the administrator’s; nothing was accepted automatically.'}
        </p>
      )}
      <p className="exc-muted exc-id-line">{ru ? 'ID исключения:' : 'Exception ID:'} {detail.id}</p>

      <section className="exc-detail-section">
        <h2 className="wk-section-title">{ru ? 'Обзор' : 'Overview'}</h2>
        <dl className="exc-detail-grid">
          <div>
            <dt>{ru ? 'Работник' : 'Employee'}</dt>
            <dd>{detail.employee.name}</dd>
          </div>
          <div>
            <dt>{ru ? 'Объект' : 'Site'}</dt>
            <dd>{detail.site ? detail.site.name : '—'}</dd>
          </div>
          <div>
            <dt>{ru ? 'Произошло в' : 'Occurred at'}</dt>
            <dd>{formatDateTime(detail.occurredAt)}</dd>
          </div>
          <div>
            <dt>{ru ? 'Создано' : 'Created at'}</dt>
            <dd>{formatDateTime(detail.createdAt)}</dd>
          </div>
          <div>
            <dt>{ru ? 'Расчётный период' : 'Payroll period'}</dt>
            <dd>{detail.payrollPeriod ? `${detail.payrollPeriod.startDate} – ${detail.payrollPeriod.endDate}` : (ru ? 'Не связано' : 'Not linked')}</dd>
          </div>
          <div>
            <dt>{ru ? 'Табель' : 'Timesheet'}</dt>
            <dd>
              {detail.timesheet ? (
                timesheetHref ? (
                  <Link href={timesheetHref}>{ru ? 'Открыть табель' : 'View timesheet'} ({timesheetStatusLabel(detail.timesheet.status, locale)})</Link>
                ) : (
                  timesheetStatusLabel(detail.timesheet.status, locale)
                )
              ) : (
                ru ? 'Не связано' : 'Not linked'
              )}
            </dd>
          </div>
        </dl>
      </section>

      {detail.clockEvent && (
        <section className="exc-detail-section">
          <h2 className="wk-section-title">{ru ? 'Событие учёта' : 'Clock event'}</h2>
          <dl className="exc-detail-grid">
            <div>
              <dt>{ru ? 'Операция' : 'Operation'}</dt>
              <dd>{operationTypeLabel(detail.clockEvent.operationType, locale)}</dd>
            </div>
            <div>
              <dt>{ru ? 'Время события' : 'Effective at'}</dt>
              <dd>{formatDateTime(detail.clockEvent.effectiveAt)}</dd>
            </div>
            <div>
              <dt>{ru ? 'Получено сервером' : 'Received by server'}</dt>
              <dd>{formatDateTime(detail.clockEvent.serverReceivedAt)}</dd>
            </div>
            <div>
              <dt>{ru ? 'Источник' : 'Source'}</dt>
              <dd>
                {channelLabel(detail.clockEvent.channel, locale)}
                {detail.clockEvent.capturedOffline ? (ru ? ' · зафиксировано оффлайн' : ' · captured offline') : ''}
              </dd>
            </div>
            <div>
              <dt>{ru ? 'Подтверждение GPS' : 'GPS verification'}</dt>
              <dd>{gpsVerificationLabel(detail.clockEvent.gpsVerification, locale)}</dd>
            </div>
            <div>
              <dt>{ru ? 'Точность GPS' : 'GPS accuracy'}</dt>
              <dd>{detail.clockEvent.gpsAccuracyMeters !== null ? `${detail.clockEvent.gpsAccuracyMeters} ${ru ? 'м' : 'm'}` : '—'}</dd>
            </div>
            {detail.clockEvent.gpsUnavailableReason && (
              <div>
                <dt>{ru ? 'Причина недоступности GPS' : 'GPS unavailable reason'}</dt>
                <dd>{gpsUnavailableReasonLabel(detail.clockEvent.gpsUnavailableReason, locale)}</dd>
              </div>
            )}
            {detail.gpsLocation?.isApproximate && (
              <div>
                <dt>{ru ? 'Местоположение' : 'Location'}</dt>
                <dd>{approximateLocationNote(detail.gpsLocation, ru)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <ClockShiftSection title={ru ? 'Смена' : 'Shift'} shift={detail.clockShift} locale={locale} />
      <ClockShiftSection title={ru ? 'Связанная смена' : 'Related shift'} shift={detail.relatedClockShift} locale={locale} />

      {detail.detail && (
        <section className="exc-detail-section">
          <h2 className="wk-section-title">{ru ? 'Дополнительные сведения' : 'Additional detail'}</h2>
          <dl className="exc-detail-grid">
            {Object.entries(detail.detail).map(([key, value]) => (
              <div key={key}>
                <dt>{detailKeyLabel(key, locale)}</dt>
                <dd>{typeof value === 'boolean' ? (value ? (ru ? 'Да' : 'Yes') : ru ? 'Нет' : 'No') : String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* GPS-1 — "where was this" for a GPS exception: the retained (possibly imprecise) worker
          point, its accuracy circle and the site geofence. Only present when the viewer holds
          attendance.gps.read.raw. */}
      {detail.gpsLocation && (
        <section className="exc-detail-section">
          <h2 className="wk-section-title">{ru ? 'Где это было' : 'Where this was'}</h2>
          <ExceptionGpsMap
            point={detail.gpsLocation}
            accuracyMeters={detail.clockEvent?.gpsAccuracyMeters ?? null}
            geofence={detail.siteGeofence}
            approximate={detail.gpsLocation.isApproximate}
          />
          <p className="exc-muted">
            {detail.gpsLocation.isApproximate
              ? `${approximateLocationNote(detail.gpsLocation, ru)}. ${
                  ru
                    ? 'Серая пунктирная метка — не проверенное по геозоне местоположение; зелёный — геозона объекта.'
                    : 'The grey dashed marker is an unverified location, not a geofence check; green — the site geofence.'
                }`
              : ru
                ? 'Красный — GPS-точка работника и круг точности; зелёный — геозона объекта. Координаты приблизительны при плохой точности.'
                : "Red — the worker's GPS point and its accuracy circle; green — the site geofence. Coordinates are approximate at low accuracy."}
          </p>
          <p>
            <Link href={`/admin/workers/${detail.employee.id}/locations`}>
              {ru ? 'Все GPS-точки этого работника →' : "All of this worker's GPS points →"}
            </Link>
          </p>
        </section>
      )}

      <section className="exc-detail-section">
        <h2 className="wk-section-title">{ru ? 'Решение' : 'Resolution'}</h2>
        {isTerminal ? (
          <dl className="exc-detail-grid">
            <div>
              <dt>{ru ? 'Решено в' : 'Resolved at'}</dt>
              <dd>{detail.resolvedAt ? formatDateTime(detail.resolvedAt) : '—'}</dd>
            </div>
            <div>
              <dt>{ru ? 'Решено кем' : 'Resolved by'}</dt>
              <dd>{detail.resolvedBy ? detail.resolvedBy.name : '—'}</dd>
            </div>
            <div>
              <dt>{ru ? 'Примечание' : 'Note'}</dt>
              <dd>{detail.resolutionNote ?? (ru ? 'Без примечания' : 'No note')}</dd>
            </div>
          </dl>
        ) : (
          resolutionPanel
        )}
      </section>
    </div>
  );
}

function ClockShiftSection({ title, shift, locale }: { title: string; shift: ClockShiftDetail | null; locale: AppLocale }) {
  const ru = locale === 'RU';
  if (!shift) {
    return (
      <section className="exc-detail-section">
        <h2 className="wk-section-title">{title}</h2>
        <p className="exc-muted">{ru ? 'Недоступно.' : 'Not available.'}</p>
      </section>
    );
  }

  return (
    <section className="exc-detail-section">
      <h2 className="wk-section-title">{title}</h2>
      <dl className="exc-detail-grid">
        <div>
          <dt>{ru ? 'Объект' : 'Site'}</dt>
          <dd>{shift.site.name}</dd>
        </div>
        <div>
          <dt>{ru ? 'Заказчик' : 'Customer'}</dt>
          <dd>{shift.workArea ? shift.workArea.name : '—'}</dd>
        </div>
        <div>
          <dt>{ru ? 'Зафиксированное начало' : 'Recorded start'}</dt>
          <dd>{formatDateTime(shift.recordedStartAt)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Зафиксированное окончание' : 'Recorded end'}</dt>
          <dd>
            {formatDateTime(shift.recordedEndAt)}
            {shift.endAtProvisional ? (ru ? ' (предварительно)' : ' (provisional)') : ''}
          </dd>
        </div>
        <div>
          <dt>{ru ? 'Обработка' : 'Materialization'}</dt>
          <dd>{materializationStateLabel(shift.materializationState, locale)}</dd>
        </div>
      </dl>
      {shift.fragments.length > 0 && (
        <>
          <h3 className="exc-subsection-title">{ru ? 'Фрагменты' : 'Fragments'}</h3>
          <ul className="exc-fragment-list">
            {shift.fragments.map((f) => (
              <li key={f.id}>
                #{f.fragmentIndex}: {formatDateTime(f.recordedStartAt)} – {formatDateTime(f.recordedEndAt)} · {projectionStateLabel(f.reportedProjectionState, locale)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
