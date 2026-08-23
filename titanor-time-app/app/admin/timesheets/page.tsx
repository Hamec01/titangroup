import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listTimesheets } from '@/lib/admin-timesheets';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets` — defaults to FOREMAN_APPROVED, the
// actionable queue for final-approve/override-return; ?status=FINAL_APPROVED added (T7.9) so an
// admin can browse to a finalized timesheet and start a correction from its card — no full filter
// UI, just this one extra toggle, same minimal scope as /admin/assignments's list page otherwise.
type RouteParams = { searchParams: Promise<{ status?: string }> };

export default async function AdminTimesheetsPage({ searchParams }: RouteParams) {
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

  const { status: statusParam } = await searchParams;
  const status = statusParam === 'FINAL_APPROVED' ? 'FINAL_APPROVED' : 'FOREMAN_APPROVED';
  const { items, totalItems } = await listTimesheets({ page: 1, pageSize: PAGE_SIZE, status });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{status === 'FINAL_APPROVED' ? localeText(locale, 'Finalized timesheets', 'Окончательно одобренные табели') : localeText(locale, 'Timesheets ready for final approval', 'Табели, готовые к окончательному одобрению')}</h1>
        <p className="setup-subtitle">
          {status === 'FINAL_APPROVED' ? (
            <Link href="/admin/timesheets">{localeText(locale, 'Awaiting final approval', 'Ожидают окончательного одобрения')}</Link>
          ) : (
            <Link href="/admin/timesheets?status=FINAL_APPROVED">{localeText(locale, 'Finalized (start a correction)', 'Окончательно одобрено (начать корректировку)')}</Link>
          )}
        </p>
        <p className="setup-subtitle">{localeText(locale, `${totalItems} ${status === 'FINAL_APPROVED' ? 'finalized' : 'awaiting final approval'}`, `${status === 'FINAL_APPROVED' ? 'Окончательно одобрено' : 'Ожидает окончательного одобрения'}: ${totalItems}`)}</p>
        {items.length === 0 ? (
          <p>{localeText(locale, 'Nothing awaiting final approval.', 'Нет табелей, ожидающих окончательного одобрения.')}</p>
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
