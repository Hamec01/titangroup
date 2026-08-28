import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getTimesheetCard } from '@/lib/admin-timesheets';
import { RequestCorrectionForm } from './RequestCorrectionForm';
import { StartCorrectionForm } from './StartCorrectionForm';
import { DirectEditForm } from './DirectEditForm';
import { DiscardOpenEditButton } from './DiscardOpenEditButton';
import { ReturnTimesheetForm } from './ReturnTimesheetForm';
import { ApproveTimesheetButton } from '../../review/ApproveTimesheetButton';
import { workedMinutesFromIsoSegments, timesheetStatusLabel } from '@/lib/reporting/report-format';
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

type RouteParams = { params: Promise<{ timesheetId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets/[timesheetId]` — card + (when
// FOREMAN_APPROVED) the final-approve/override-return actions folded into the same page rather
// than a separate .../approve route, mirroring how /admin/review-scopes/[reviewScopeId] already
// combines detail+actions.
export default async function AdminTimesheetCardPage({ params }: RouteParams) {
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

  const { timesheetId } = await params;
  const card = await getTimesheetCard(timesheetId);

  if (!card) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>{localeText(locale, 'No timesheet with this id.', 'Табель с таким идентификатором не найден.')}</p>
          <Link href="/admin/timesheets">{localeText(locale, 'Back to timesheets', 'К табелям')}</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{card.employeeName}</h1>
        <p className="setup-subtitle">
          {localeText(locale, 'Status:', 'Статус:')} {timesheetStatusLabel(card.status, locale)} {card.versionNumber ? localeText(locale, `· version ${card.versionNumber}`, `· версия ${card.versionNumber}`) : ''}
        </p>

        {card.days.length === 0 ? (
          <p>{localeText(locale, 'No submitted version yet.', 'Отправленной версии пока нет.')}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{localeText(locale, 'Date', 'Дата')}</th>
                <th>{localeText(locale, 'Details', 'Детали')}</th>
              </tr>
            </thead>
            <tbody>
              {card.days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>
                    {day.dayType !== 'WORK'
                      ? dayTypeLabel(day.dayType, locale)
                      : day.segments.length === 0
                        ? day.confirmedZero
                          ? localeText(locale, 'Confirmed 0h', 'Подтверждено 0ч')
                          : '—'
                        : `${formatMinutes(workedMinutesFromIsoSegments(day.segments), ru)} · ${day.segments.map((s) => s.siteName).join(', ')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {card.status === 'SUBMITTED' || card.status === 'FOREMAN_APPROVED' ? (
          <>
            {card.openCorrectionRequestId ? (
              <div className="setup-card form">
                <p className="setup-subtitle">{localeText(locale, 'An edit is open on this timesheet. Continue it, or discard it to approve the hours as they are.', 'По этому табелю открыта правка. Продолжите её — или отмените, чтобы утвердить часы как есть.')}</p>
                <Link className="login-submit" href={`/admin/corrections/${card.openCorrectionRequestId}`}>
                  {localeText(locale, 'Continue editing', 'Продолжить правку')}
                </Link>
                <DiscardOpenEditButton correctionRequestId={card.openCorrectionRequestId} />
              </div>
            ) : (
              <>
                <ApproveTimesheetButton
                  timesheetId={card.timesheetId}
                  variant="card"
                  onDoneHref="/admin/review"
                  label={card.status === 'FOREMAN_APPROVED' ? localeText(locale, 'Final approve', 'Окончательно одобрить') : localeText(locale, 'Approve hours', 'Утвердить часы')}
                />
                <DirectEditForm timesheetId={card.timesheetId} />
                {card.status === 'SUBMITTED' ? <StartCorrectionForm timesheetId={card.timesheetId} /> : null}
                <ReturnTimesheetForm timesheetId={card.timesheetId} />
              </>
            )}
          </>
        ) : card.status === 'FINAL_APPROVED' ? (
          <RequestCorrectionForm timesheetId={card.timesheetId} />
        ) : (
          <p className="setup-subtitle">{localeText(locale, `Not awaiting approval (status: ${timesheetStatusLabel(card.status, locale)}).`, `Не ожидает утверждения (статус: ${timesheetStatusLabel(card.status, locale)}).`)}</p>
        )}

        <p>
          <Link href="/admin/timesheets">{localeText(locale, 'Back to timesheets', 'К табелям')}</Link>
        </p>
      </div>
    </main>
  );
}
