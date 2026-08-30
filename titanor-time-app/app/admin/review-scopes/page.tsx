import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listReviewScopes } from '@/lib/review-scopes';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §8 — admin fallback review list UI. Page 1,
// status=PENDING only — no filter/sort UI, same minimal scope as /admin/assignments's list page.
export default async function AdminReviewScopesPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
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

  const { items, totalItems } = await listReviewScopes({ page: 1, pageSize: PAGE_SIZE, callerEmployeeId: session.user.employeeId });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Timesheets to review', 'Табели на проверку')}</h1>
        <p className="setup-subtitle">
          {localeText(locale, `${totalItems} pending scope${totalItems === 1 ? '' : 's'}`, `Ожидает проверки: ${totalItems}`)}
        </p>
        {items.length === 0 ? (
          <p>{localeText(locale, 'Nothing pending review.', 'Нет табелей, ожидающих проверки.')}</p>
        ) : (
          <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.common.name}</th>
                <th>{localeText(locale, 'Scope', 'Раздел')}</th>
                <th>{localeText(locale, 'Exception?', 'Исключение?')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.employeeName}</td>
                  <td>
                    <Link href={`/admin/review-scopes/${item.id}`}>
                      {item.scopeType === 'SITE'
                        ? item.siteName
                        : item.scopePurpose === 'EMPTY_FALLBACK'
                          ? localeText(locale, 'Empty timesheet confirmation', 'Подтверждение пустого табеля')
                          : localeText(locale, 'Non-site data', 'Данные вне объекта')}
                    </Link>
                  </td>
                  <td>{item.hasException ? s.common.yes : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </main>
  );
}
