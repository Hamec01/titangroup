import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getReviewScopeDetail } from '@/lib/review-scopes';
import { prisma } from '@/lib/prisma';
import { ReviewActions } from './ReviewActions';
import { workedMinutesFromIsoSegments } from '@/lib/reporting/report-format';
import { dayTypeLabel } from '@/lib/i18n/worker';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
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

type RouteParams = { params: Promise<{ reviewScopeId: string }> };

export default async function AdminReviewScopeDetailPage({ params }: RouteParams) {
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

  const { reviewScopeId } = await params;
  const scope = await getReviewScopeDetail(reviewScopeId);

  if (!scope) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>{localeText(locale, 'No review scope with this id.', 'Раздел проверки с таким идентификатором не найден.')}</p>
          <Link href="/admin/review-scopes">{localeText(locale, 'Back to reviews', 'К проверкам')}</Link>
        </div>
      </main>
    );
  }

  const [employee, site] = await Promise.all([
    prisma.employee.findUnique({ where: { id: scope.employeeId }, select: { firstName: true, lastName: true } }),
    scope.siteId ? prisma.workSite.findUnique({ where: { id: scope.siteId }, select: { name: true } }) : Promise.resolve(null)
  ]);

  const title = scope.scopeType === 'SITE'
    ? (site?.name ?? scope.siteId)
    : scope.scopePurpose === 'EMPTY_FALLBACK'
      ? localeText(locale, 'Empty timesheet confirmation', 'Подтверждение пустого табеля')
      : localeText(locale, 'Non-site data', 'Данные вне объекта');

  const statusLabel = ru ? (SCOPE_STATUS_LABELS[scope.status]?.ru ?? scope.status) : (SCOPE_STATUS_LABELS[scope.status]?.en ?? scope.status);

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{title}</h1>
        <p className="setup-subtitle">
          {employee ? `${employee.firstName} ${employee.lastName}` : scope.employeeId} · {localeText(locale, `status ${statusLabel}`, `статус: ${statusLabel}`)} · {localeText(locale, `version ${scope.versionNumber}`, `версия ${scope.versionNumber}`)}
        </p>

        {scope.days.length === 0 ? (
          <p>{scope.scopePurpose === 'EMPTY_FALLBACK' ? localeText(locale, 'No hours were logged this period.', 'В этом периоде часы не были зафиксированы.') : localeText(locale, 'No days to show for this scope.', 'Для этого раздела нет дней для отображения.')}</p>
        ) : (
          <ul className="setup-list">
            {scope.days.map((day) => (
              <li key={day.date} className="setup-item">
                <span className="setup-label">
                  {day.date} — {day.dayType !== 'WORK' ? dayTypeLabel(day.dayType, locale) : day.segments.length === 0 ? (day.confirmedZero ? localeText(locale, 'Confirmed 0h', 'Подтверждено 0ч') : '—') : formatMinutes(workedMinutesFromIsoSegments(day.segments), ru)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {scope.status === 'PENDING' ? (
          <ReviewActions reviewScopeId={scope.id} />
        ) : (
          <p className="setup-subtitle">{localeText(locale, `Already ${scope.status.toLowerCase()}.`, `Уже ${statusLabel}.`)}</p>
        )}

        <p>
          <Link href="/admin/review-scopes">{localeText(locale, 'Back to reviews', 'К проверкам')}</Link>
        </p>
      </div>
    </main>
  );
}
