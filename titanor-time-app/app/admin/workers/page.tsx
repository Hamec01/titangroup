import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkers } from '@/lib/workers';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md — read-only worker list
// (PROJECT_ROADMAP.md T6.2: "Список работников. Сначала read-only."). Page 1
// only, no pager UI — out of scope for this task, same as the API route's
// missing search/sort/filter params.
export default async function AdminWorkersPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  const s = adminDailyStrings(await resolveAppLocale());
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

  const searchParams = await props.searchParams;
  const showArchived = searchParams.archived === '1';
  const { items, totalItems, archivedCount } = await listWorkers(1, PAGE_SIZE, { includeArchived: showArchived });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.workers.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.workers.singular : s.workers.plural} · <Link href="/admin/workers/new">{s.common.createNew}</Link>
          {showArchived ? (
            <>
              {' · '}
              <Link href="/admin/workers">{s.workers.hideArchived}</Link>
            </>
          ) : archivedCount > 0 ? (
            <>
              {' · '}
              <Link href="/admin/workers?archived=1">
                {s.workers.showArchived} ({archivedCount})
              </Link>
            </>
          ) : null}
        </p>
        {items.length === 0 ? (
          <p>{s.workers.empty}</p>
        ) : (
          <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{s.common.name}</th>
                <th>{s.workers.login}</th>
                <th>{s.common.status}</th>
                <th>{s.workers.assignment}</th>
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
                  <td>{worker.active ? s.common.active : s.common.inactive}</td>
                  <td>
                    {worker.currentAssignments.length === 0
                      ? '—'
                      : worker.currentAssignments
                          .map((assignment) => assignment.siteName + (assignment.isPrimary ? ` (${s.common.primary})` : ''))
                          .join(', ')}
                  </td>
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
