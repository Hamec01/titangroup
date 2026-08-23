import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listForemanWorkers } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/workers` — workers currently assigned to this
// foreman's own sites.
export default async function ForemanWorkersPage() {
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

  const workers = await listForemanWorkers(session.user.id, helsinkiToday());

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>{localeText(locale, 'Your workers', 'Ваши работники')}</h1>
        {workers.length === 0 ? (
          <p className="wk-empty">{localeText(locale, 'No one is currently assigned to your sites.', 'На ваших объектах пока никто не назначен.')}</p>
        ) : (
          <ul className="setup-list">
            {workers.map((w) => (
              <li key={`${w.employeeId}:${w.siteId}`} className="setup-item">
                <span className="setup-label">{w.employeeName}</span>
                <span className="setup-status setup-status-pending">{w.siteName}</span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href="/foreman">{localeText(locale, 'Back to overview', 'К обзору')}</Link>
        </p>
      </div>
    </main>
  );
}
