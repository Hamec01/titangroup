import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getForemanOverview } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review` — split into standard (no exception,
// bulk-approvable) vs exceptions (individual review only).
export default async function ForemanReviewPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  if (!session.user.roles.includes('FOREMAN')) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires the FOREMAN role.', 'Доступ запрещён — эта страница доступна только прорабу.')}
        </p>
      </main>
    );
  }

  const overview = await getForemanOverview(session.user.id, session.user.employeeId, helsinkiToday());
  const standardCount = overview.pendingCount - overview.exceptionCount;

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>{localeText(locale, 'Review queue', 'Очередь проверки')}</h1>
        {overview.pendingCount === 0 ? (
          <p className="wk-empty">{localeText(locale, 'Nothing waiting for review on your sites.', 'На ваших объектах нет табелей, ожидающих проверки.')}</p>
        ) : (
          <ul className="setup-list">
            <li className="setup-item">
              <Link href="/foreman/review/standard">{localeText(locale, `Standard (${standardCount})`, `Обычные (${standardCount})`)}</Link>
            </li>
            <li className="setup-item">
              <Link href="/foreman/review/exceptions">{localeText(locale, `With exceptions (${overview.exceptionCount})`, `С исключениями (${overview.exceptionCount})`)}</Link>
            </li>
          </ul>
        )}
        <p>
          <Link href="/foreman">{localeText(locale, 'Back to overview', 'К обзору')}</Link>
        </p>
      </div>
    </main>
  );
}
