import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getCorrectionDetail } from '@/lib/corrections';
import { CorrectionActions } from './CorrectionActions';
import { workedMinutesFromIsoSegments } from '@/lib/reporting/report-format';
import { correctionStatusLabel } from '@/lib/attendance-overview-ui';
import { dayTypeLabel } from '@/lib/i18n/worker';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

function formatMinutes(minutes: number, ru: boolean): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return ru ? `${h}ч${m ? ` ${m}м` : ''}` : `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ correctionRequestId: string }> };

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 T7.9 — request/draft.edit/submit/approve all folded
// into this one page (confirmed ADMIN-only first slice), mirroring how /admin/timesheets/
// [timesheetId] combines card+actions rather than separate routes per action.
export default async function AdminCorrectionDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';
  const s = adminDailyStrings(locale);
  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {s.accessDenied}
        </p>
      </main>
    );
  }

  const { correctionRequestId } = await params;
  const correction = await getCorrectionDetail(correctionRequestId);

  // T12 — a REJECTED / APPROVED correction is history: its draft is a stale snapshot of whatever
  // version it was opened against (which is why it could show a "missing Friday"). Never render it
  // as if it were editable — show a one-line outcome and point back to the live timesheet.
  if (correction && (correction.status === 'REJECTED' || correction.status === 'APPROVED')) {
    const applied = correction.status === 'APPROVED';
    return (
      <main className="setup-page">
        <div className="setup-card">
          <h1>{correction.employeeName}</h1>
          <p className="setup-subtitle">
            {applied
              ? localeText(locale, 'This edit was applied — the timesheet now shows the new version.', 'Эта правка применена — в табеле теперь новая версия.')
              : localeText(locale, 'This edit was discarded — nothing was changed. It may have been on an out-of-date version.', 'Эта правка отменена — ничего не изменено. Возможно, она была на устаревшей версии табеля.')}
          </p>
          <p>
            <Link className="login-submit" href={`/admin/timesheets/${correction.timesheetId}`}>
              {localeText(locale, 'Open the timesheet', 'Открыть табель')}
            </Link>
          </p>
          <p>
            <Link href="/admin/corrections">{localeText(locale, 'Back to corrections', 'К списку корректировок')}</Link>
          </p>
        </div>
      </main>
    );
  }

  if (!correction) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>{localeText(locale, 'No correction request with this id.', 'Запрос на корректировку с таким идентификатором не найден.')}</p>
          <Link href="/admin/corrections">{localeText(locale, 'Back to corrections', 'К списку корректировок')}</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{correction.employeeName}</h1>
        {correction.directEdit ? (
          <p className="setup-subtitle">
            {localeText(
              locale,
              'Direct hours edit by an administrator — no reason, the worker is not notified.',
              'Прямая правка часов администратором — без причины, работник не уведомляется.'
            )}
          </p>
        ) : correction.timesheetStatus === 'SUBMITTED' || correction.timesheetStatus === 'FOREMAN_APPROVED' ? (
          <p className="setup-subtitle">{localeText(locale, 'Admin edit of a timesheet still under review.', 'Исправление табеля, ещё находящегося на проверке.')}</p>
        ) : null}
        <p className="setup-subtitle">
          {localeText(locale, 'Status:', 'Статус:')} {correctionStatusLabel(correction.status, locale)}
          {correction.directEdit ? '' : ` · ${localeText(locale, 'reason:', 'причина:')} ${correction.reason}`}
        </p>
        {correction.overrideReason ? <p className="setup-subtitle">{localeText(locale, 'Override reason:', 'Причина переопределения:')} {correction.overrideReason}</p> : null}

        {correction.days.length === 0 ? (
          <p>{correction.status === 'PENDING' ? localeText(locale, 'Open the draft to start editing.', 'Откройте черновик, чтобы начать редактирование.') : localeText(locale, 'No days to show.', 'Нет дней для отображения.')}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{localeText(locale, 'Date', 'Дата')}</th>
                <th>{localeText(locale, 'Details', 'Детали')}</th>
                {correction.status === 'DRAFT_OPEN' ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {correction.days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>
                    {day.dayType !== 'WORK'
                      ? dayTypeLabel(day.dayType, locale)
                      : day.segments.length === 0
                        ? day.confirmedZero
                          ? localeText(locale, 'Confirmed 0h', 'Подтверждено 0ч')
                          : '—'
                        : `${formatMinutes(workedMinutesFromIsoSegments(day.segments), ru)} · ${localeText(locale, `${[...new Set(day.segments.map((s) => s.siteId))].length} site(s)`, `объектов: ${[...new Set(day.segments.map((s) => s.siteId))].length}`)}`}
                  </td>
                  {correction.status === 'DRAFT_OPEN' ? (
                    <td>
                      <Link href={`/admin/corrections/${correction.id}/days/${day.date}`}>{localeText(locale, 'Edit', 'Изменить')}</Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <CorrectionActions
          correctionRequestId={correction.id}
          status={correction.status}
          isSuperAdmin={session.user.roles.includes('SUPER_ADMIN')}
          timesheetStatus={correction.timesheetStatus}
          directEdit={correction.directEdit}
        />

        <p>
          <Link href="/admin/corrections">{localeText(locale, 'Back to corrections', 'К списку корректировок')}</Link>
        </p>
      </div>
    </main>
  );
}
