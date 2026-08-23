import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getForemanTimesheetDetail } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';
import { ForemanReviewActions } from './ForemanReviewActions';
import { workedMinutesFromIsoSegments, timesheetStatusLabel } from '@/lib/reporting/report-format';
import { dayTypeLabel } from '@/lib/i18n/worker';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const SCOPE_STATUS_LABELS: Record<string, { en: string; ru: string }> = {
  PENDING: { en: 'pending', ru: 'ожидает' },
  APPROVED: { en: 'approved', ru: 'одобрено' },
  RETURNED: { en: 'returned', ru: 'возвращено' }
};

function formatMinutes(minutes: number, ru: boolean): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return ru ? `${h}ч${m ? ` ${m}м` : ''}` : `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ timesheetId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/[timesheetId]` — card + approve/return
// folded into the same page (mirrors /admin/review-scopes/[reviewScopeId] and
// /admin/timesheets/[timesheetId]'s established precedent, rather than separate .../approve and
// .../return routes). Days on other sites are shown collapsed, not omitted — the worker's week
// stays visible as a whole even though only this foreman's own site is expanded.
export default async function ForemanReviewDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';

  if (!session.user.roles.includes('FOREMAN')) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires the FOREMAN role.', 'Доступ запрещён — эта страница доступна только прорабу.')}
        </p>
      </main>
    );
  }

  const { timesheetId } = await params;
  const detail = await getForemanTimesheetDetail(timesheetId, session.user.id, helsinkiToday());

  if (!detail) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>{localeText(locale, 'No timesheet with this id on your own sites.', 'На ваших объектах нет табеля с таким идентификатором.')}</p>
          <Link href="/foreman/review">{localeText(locale, 'Back to review queue', 'К очереди проверки')}</Link>
        </div>
      </main>
    );
  }

  const scopeStatusLabel = ru ? (SCOPE_STATUS_LABELS[detail.reviewScopeStatus]?.ru ?? detail.reviewScopeStatus) : (SCOPE_STATUS_LABELS[detail.reviewScopeStatus]?.en ?? detail.reviewScopeStatus);

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{detail.employeeName}</h1>
        <p className="setup-subtitle">
          {localeText(locale, 'Status:', 'Статус:')} {timesheetStatusLabel(detail.status, locale)} · {localeText(locale, `version ${detail.versionNumber}`, `версия ${detail.versionNumber}`)}
          {detail.hasException ? localeText(locale, ' · has exception', ' · есть исключение') : ''}
        </p>

        <ul className="setup-list">
          {detail.days.map((day) => (
            <li key={day.date} className="setup-item">
              <span className="setup-label">
                {day.date} —{' '}
                {day.collapsed
                  ? localeText(locale, 'other site', 'другой объект')
                  : day.dayType !== 'WORK'
                    ? dayTypeLabel(day.dayType, locale)
                    : day.segments.length === 0
                      ? day.confirmedZero
                        ? localeText(locale, 'Confirmed 0h', 'Подтверждено 0ч')
                        : '—'
                      : formatMinutes(workedMinutesFromIsoSegments(day.segments), ru)}
              </span>
            </li>
          ))}
        </ul>

        {detail.reviewScopeStatus === 'PENDING' ? (
          <ForemanReviewActions reviewScopeId={detail.reviewScopeId} />
        ) : (
          <p className="setup-subtitle">{localeText(locale, `Already ${detail.reviewScopeStatus.toLowerCase()}.`, `Уже ${scopeStatusLabel}.`)}</p>
        )}

        <p>
          <Link href="/foreman/review">{localeText(locale, 'Back to review queue', 'К очереди проверки')}</Link>
        </p>
      </div>
    </main>
  );
}
