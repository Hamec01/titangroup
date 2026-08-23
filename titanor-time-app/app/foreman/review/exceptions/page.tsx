import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listForemanReviewScopes } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/exceptions` — hasException=true,
// individual review only (never bulk-approvable).
export default async function ForemanReviewExceptionsPage() {
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

  const { items, totalItems } = await listForemanReviewScopes({
    foremanUserId: session.user.id,
    foremanEmployeeId: session.user.employeeId,
    today: helsinkiToday(),
    hasException: true,
    page: 1,
    pageSize: PAGE_SIZE
  });

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>{localeText(locale, 'With exceptions', 'С исключениями')}</h1>
        <p className="setup-subtitle">{localeText(locale, `${totalItems} to review individually`, `К индивидуальной проверке: ${totalItems}`)}</p>
        {items.length === 0 ? (
          <p className="wk-empty">{localeText(locale, 'Nothing here.', 'Здесь пусто.')}</p>
        ) : (
          <ul className="setup-list">
            {items.map((item) => (
              <li key={item.id} className="setup-item">
                <Link href={`/foreman/review/${item.timesheetId}`}>
                  {item.employeeName} — {item.siteName}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href="/foreman/review">{localeText(locale, 'Back to review queue', 'К очереди проверки')}</Link>
        </p>
      </div>
    </main>
  );
}
