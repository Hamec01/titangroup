import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listTimesheets } from '@/lib/admin-timesheets';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets` — defaults to FOREMAN_APPROVED, the
// actionable queue for final-approve/override-return; no filter UI yet (page 1, one status),
// same minimal scope as /admin/assignments's list page.
export default async function AdminTimesheetsPage() {
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

  const { items, totalItems } = await listTimesheets({ page: 1, pageSize: PAGE_SIZE, status: 'FOREMAN_APPROVED' });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Timesheets ready for final approval</h1>
        <p className="setup-subtitle">{totalItems} awaiting final approval</p>
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
