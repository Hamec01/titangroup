import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listTimesheets } from '@/lib/admin-timesheets';

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

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the ADMIN or SUPER_ADMIN role.
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
        <h1>{status === 'FINAL_APPROVED' ? 'Finalized timesheets' : 'Timesheets ready for final approval'}</h1>
        <p className="setup-subtitle">
          {status === 'FINAL_APPROVED' ? (
            <Link href="/admin/timesheets">Awaiting final approval</Link>
          ) : (
            <Link href="/admin/timesheets?status=FINAL_APPROVED">Finalized (start a correction)</Link>
          )}
        </p>
        <p className="setup-subtitle">{totalItems} {status === 'FINAL_APPROVED' ? 'finalized' : 'awaiting final approval'}</p>
        {items.length === 0 ? (
          <p>Nothing awaiting final approval.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Period</th>
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
