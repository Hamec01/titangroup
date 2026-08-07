import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkers } from '@/lib/workers';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md — read-only worker list
// (PROJECT_ROADMAP.md T6.2: "Список работников. Сначала read-only."). Page 1
// only, no pager UI — out of scope for this task, same as the API route's
// missing search/sort/filter params.
export default async function AdminWorkersPage() {
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

  const { items, totalItems } = await listWorkers(1, PAGE_SIZE);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Workers</h1>
        <p className="setup-subtitle">
          {totalItems} worker{totalItems === 1 ? '' : 's'}
        </p>
        {items.length === 0 ? (
          <p>No workers yet.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Login username</th>
                <th>Status</th>
                <th>Current assignment</th>
              </tr>
            </thead>
            <tbody>
              {items.map((worker) => (
                <tr key={worker.id}>
                  <td>{worker.employeeNumber}</td>
                  <td>
                    <Link href={`/admin/workers/${worker.id}`}>
                      {worker.firstName} {worker.lastName}
                    </Link>
                  </td>
                  <td>{worker.username}</td>
                  <td>{worker.active ? 'Active' : 'Inactive'}</td>
                  <td>
                    {worker.currentAssignments.length === 0
                      ? '—'
                      : worker.currentAssignments
                          .map((assignment) => assignment.siteName + (assignment.isPrimary ? ' (primary)' : ''))
                          .join(', ')}
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
