import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listReviewScopes } from '@/lib/review-scopes';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §8 — admin fallback review list UI. Page 1,
// status=PENDING only — no filter/sort UI, same minimal scope as /admin/assignments's list page.
export default async function AdminReviewScopesPage() {
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

  const { items, totalItems } = await listReviewScopes({ page: 1, pageSize: PAGE_SIZE, callerEmployeeId: session.user.employeeId });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Timesheets to review</h1>
        <p className="setup-subtitle">
          {totalItems} pending scope{totalItems === 1 ? '' : 's'}
        </p>
        {items.length === 0 ? (
          <p>Nothing pending review.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Scope</th>
                <th>Exception?</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.employeeName}</td>
                  <td>
                    <Link href={`/admin/review-scopes/${item.id}`}>
                      {item.scopeType === 'SITE' ? item.siteName : item.scopePurpose === 'EMPTY_FALLBACK' ? 'Empty timesheet confirmation' : 'Non-site data'}
                    </Link>
                  </td>
                  <td>{item.hasException ? 'Yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
