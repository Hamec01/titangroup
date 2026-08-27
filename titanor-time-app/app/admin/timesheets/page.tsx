import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listTimesheets } from '@/lib/admin-timesheets';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets` — the admin's timesheet queues.
// FOREMAN_APPROVED (default) = ready for final approval; FINAL_APPROVED (T7.9) = finalized, browse
// to start a correction; SUBMITTED (Task A) = under review, where the admin can now edit hours in
// place. No full filter UI — just these toggles; the unified worker-first review screen is Task B.
const VIEWS = {
  SUBMITTED: { en: 'Timesheets under review', ru: 'Табели на проверке' },
  FOREMAN_APPROVED: { en: 'Ready for final approval', ru: 'Готовы к окончательному одобрению' },
  FINAL_APPROVED: { en: 'Finalized timesheets', ru: 'Окончательно одобренные табели' }
} as const;
type ViewStatus = keyof typeof VIEWS;

type RouteParams = { searchParams: Promise<{ status?: string }> };

export default async function AdminTimesheetsPage({ searchParams }: RouteParams) {
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

  const { status: statusParam } = await searchParams;
  const status: ViewStatus = statusParam === 'FINAL_APPROVED' || statusParam === 'SUBMITTED' ? statusParam : 'FOREMAN_APPROVED';
  const { items, totalItems } = await listTimesheets({ page: 1, pageSize: PAGE_SIZE, status });

  const otherViews = (Object.keys(VIEWS) as ViewStatus[]).filter((v) => v !== status);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? VIEWS[status].ru : VIEWS[status].en}</h1>
        <p className="setup-subtitle">
          {otherViews.map((v, i) => (
            <span key={v}>
              {i > 0 ? ' · ' : ''}
              <Link href={v === 'FOREMAN_APPROVED' ? '/admin/timesheets' : `/admin/timesheets?status=${v}`}>{ru ? VIEWS[v].ru : VIEWS[v].en}</Link>
            </span>
          ))}
        </p>
        <p className="setup-subtitle">{ru ? `Всего: ${totalItems}` : `${totalItems} total`}</p>
        {items.length === 0 ? (
          <p>{ru ? 'Пусто.' : 'Nothing here.'}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.common.name}</th>
                <th>{localeText(locale, 'Period', 'Период')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.employeeName}</td>
                  <td>
                    <Link href={`/admin/timesheets/${item.id}`}>
                      {item.periodStartDate} – {item.periodEndDate}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
