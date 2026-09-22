import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { formatHelsinkiDateTime, utcIsoToHelsinkiTime } from '@/lib/helsinki-datetime';
import { dayTypeLabel } from '@/lib/i18n/worker';
import { issueLabel, approveDraftWarningLabel } from '@/lib/reporting/ledger-ui-text';
import { ApproveWeekAction } from './ApproveWeekAction';

function formatDayHeader(dateIso: string, locale: AppLocale): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(d);
  const [, m, day] = dateIso.split('-');
  return `${weekday} ${day}.${m}`;
}

// UT4-B — TZ §5.6: all seven days including empty ones, several intervals per day shown
// separately, paid vs unpaid break distinguished, day type in plain text, blockers/warnings/info
// in plain language, who-approved-when, and the "changed after approval" fact. Every genuinely
// technical field (fingerprint, canonicalSource, CURRENT/SUPERSEDED, sourceRevision) lives ONLY in
// the trailing collapsed "Диагностика" <details> — never in the always-visible part above it.
export function ExpandedWeekPanel({ locale, row, onApproved }: { locale: AppLocale; row: WeeklyCustomerSliceRow; onApproved: () => void }) {
  return (
    <div className="ledger-expanded">
      {row.submissionState === 'NOT_SUBMITTED' && <p className="ledger-approve-draft-warning">{approveDraftWarningLabel(locale)}</p>}
      <table className="ledger-days-table">
        <thead>
          <tr>
            <th>{localeText(locale, 'Day', 'День')}</th>
            <th>{localeText(locale, 'Start', 'Начало')}</th>
            <th>{localeText(locale, 'End', 'Конец')}</th>
            <th>{localeText(locale, 'Break', 'Перерыв')}</th>
            <th>{localeText(locale, 'Hours', 'Часы')}</th>
            <th>{localeText(locale, 'Type', 'Тип')}</th>
          </tr>
        </thead>
        <tbody>
          {row.displayDays.map((day) => {
            if (day.segments.length === 0) {
              return (
                <tr key={day.date}>
                  <td>{formatDayHeader(day.date, locale)}</td>
                  <td colSpan={3}>{day.confirmedZero ? localeText(locale, 'Confirmed 0h', 'Подтверждён нулевой день') : '—'}</td>
                  <td>{day.confirmedZero ? formatWorkedDuration(0, locale) : '—'}</td>
                  <td>{dayTypeLabel(day.dayType, locale)}</td>
                </tr>
              );
            }
            // UT4-B-fixup #3 — hours shown here are day.workedMinutes/grossMinutes/breakMinutes, the
            // SAME canonical per-day total the API already computed via buildWeeklyCustomerSlices
            // (never a separate per-segment recomputation here). Each interval still shows its own
            // start/end and its own EXPLICIT breaks; the day's single Hours total and its auto-break
            // note are shown once (rowSpan), never attributed to one particular segment.
            const rowCount = day.segments.length;
            return day.segments.map((segment, i) => {
              const paidBreakMinutes = segment.breaks.filter((b) => b.paid).reduce((s, b) => s + (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000, 0);
              const unpaidBreakMinutes = segment.breaks.filter((b) => !b.paid).reduce((s, b) => s + (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000, 0);
              return (
                <tr key={`${day.date}-${i}`}>
                  {i === 0 && <td rowSpan={rowCount}>{formatDayHeader(day.date, locale)}</td>}
                  <td>{utcIsoToHelsinkiTime(segment.startAt)}</td>
                  <td>{utcIsoToHelsinkiTime(segment.endAt)}</td>
                  <td>
                    {unpaidBreakMinutes > 0 && <span>{localeText(locale, 'unpaid', 'неопл.')} {formatWorkedDuration(unpaidBreakMinutes, locale)}</span>}
                    {unpaidBreakMinutes > 0 && paidBreakMinutes > 0 && ' · '}
                    {paidBreakMinutes > 0 && <span>{localeText(locale, 'paid', 'опл.')} {formatWorkedDuration(paidBreakMinutes, locale)}</span>}
                    {unpaidBreakMinutes === 0 && paidBreakMinutes === 0 && '—'}
                  </td>
                  {i === 0 && (
                    <td rowSpan={rowCount}>
                      {formatWorkedDuration(day.workedMinutes, locale)}
                      {day.autoUnpaidBreakMinutes > 0 && (
                        <div className="ledger-day-auto-break-note">
                          {localeText(
                            locale,
                            `incl. ${formatWorkedDuration(day.autoUnpaidBreakMinutes, locale)} automatic unpaid break for the day`,
                            `в т.ч. автоматический перерыв за день: ${formatWorkedDuration(day.autoUnpaidBreakMinutes, locale)}`
                          )}
                        </div>
                      )}
                    </td>
                  )}
                  {i === 0 && <td rowSpan={rowCount}>{dayTypeLabel(day.dayType, locale)}</td>}
                </tr>
              );
            });
          })}
        </tbody>
      </table>

      {(row.blockers.length > 0 || row.warnings.length > 0 || row.info.length > 0) && (
        <ul className="ledger-issue-list">
          {row.blockers.map((issue, i) => (
            <li key={`b-${i}`} className="ledger-issue-blocker">
              {issueLabel(issue, locale)}
            </li>
          ))}
          {row.warnings.map((issue, i) => (
            <li key={`w-${i}`} className="ledger-issue-warning">
              {issueLabel(issue, locale)}
            </li>
          ))}
          {row.info.map((issue, i) => (
            <li key={`i-${i}`} className="ledger-issue-info">
              {issueLabel(issue, locale)}
            </li>
          ))}
        </ul>
      )}

      <p className="ledger-approval-history">{approvalHistorySentence(row, locale)}</p>

      <div className="ledger-approve-action">
        <ApproveWeekAction locale={locale} row={row} onApproved={onApproved} />
      </div>

      <details className="ledger-diagnostics">
        <summary>{localeText(locale, 'Diagnostics', 'Диагностика')}</summary>
        <dl>
          <dt>{localeText(locale, 'Fingerprint', 'Отпечаток')}</dt>
          <dd>{row.currentFingerprint}</dd>
          <dt>{localeText(locale, 'Canonical source', 'Канонический источник')}</dt>
          <dd>
            {row.canonicalSource.dataSource} · {row.canonicalSource.sourceId}
            {row.canonicalSource.versionNumber !== null ? ` · v${row.canonicalSource.versionNumber}` : ''}
            {row.canonicalSource.sourceRevision !== null ? ` · rev ${row.canonicalSource.sourceRevision}` : ''}
          </dd>
          {row.currentApprovalItem && (
            <>
              <dt>{localeText(locale, 'Current approval fingerprint', 'Отпечаток текущего подтверждения')}</dt>
              <dd>{row.currentApprovalItem.fingerprint}</dd>
            </>
          )}
          {row.lastHistoricalApproval && (
            <>
              <dt>{localeText(locale, 'Last approval record state', 'Состояние последней записи подтверждения')}</dt>
              <dd>{row.lastHistoricalApproval.approvalState}</dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

function approvalHistorySentence(row: WeeklyCustomerSliceRow, locale: AppLocale): string {
  if (row.currentApprovalItem) {
    return localeText(
      locale,
      `Approved by ${row.currentApprovalItem.approvedByUserName}, ${formatHelsinkiDateTime(row.currentApprovalItem.approvedAt)}.`,
      `Подтвердил(а) ${row.currentApprovalItem.approvedByUserName}, ${formatHelsinkiDateTime(row.currentApprovalItem.approvedAt)}.`
    );
  }
  if (row.lastHistoricalApproval) {
    return localeText(
      locale,
      `Was approved by ${row.lastHistoricalApproval.approvedByUserName} on ${formatHelsinkiDateTime(row.lastHistoricalApproval.approvedAt)}, then the worker made a change — needs re-approval.`,
      `Было подтверждено (${row.lastHistoricalApproval.approvedByUserName}, ${formatHelsinkiDateTime(row.lastHistoricalApproval.approvedAt)}), затем работник изменил часы — нужна повторная проверка.`
    );
  }
  return localeText(locale, 'Not approved yet.', 'Ещё не подтверждалось.');
}
