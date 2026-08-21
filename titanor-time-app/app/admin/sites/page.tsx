import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listSites } from '@/lib/sites';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md — read-only site list (PROJECT_ROADMAP.md
// T6.6). Page 1 only, no search/filter/sort UI yet — the API route supports
// them (04_ADMIN_FIRST_API_CONTRACTS.md §3), but wiring that up is out of
// scope for this task, same call as /admin/workers's list page.
export default async function AdminSitesPage() {
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

  const { items, totalItems } = await listSites(1, PAGE_SIZE, {});

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.sites.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.sites.singular : s.sites.plural} · <Link href="/admin/sites/new">{s.common.createNew}</Link>
        </p>
        {items.length === 0 ? (
          <p>{s.sites.empty}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.common.name}</th>
                <th>{s.common.status}</th>
                <th>{s.sites.assignments}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((site) => (
                <tr key={site.id}>
                  <td>
                    <Link href={`/admin/sites/${site.id}`}>{site.name}</Link>
                  </td>
                  <td>{site.active ? s.common.active : s.common.closed}</td>
                  <td>{site.activeAssignmentsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
