import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listSites } from '@/lib/sites';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md — read-only site list (PROJECT_ROADMAP.md
// T6.6). Page 1 only, no search/sort UI yet. Finished ("closed") sites are hidden by default —
// ?closed=1 shows them, same pattern as /admin/workers's archived toggle.
export default async function AdminSitesPage(props: {
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
  const showClosed = searchParams.closed === '1';
  const { items, totalItems, closedCount } = await listSites(1, PAGE_SIZE, showClosed ? {} : { active: true });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.sites.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.sites.singular : s.sites.plural} · <Link href="/admin/sites/new">{s.common.createNew}</Link>
          {showClosed ? (
            <>
              {' · '}
              <Link href="/admin/sites">{s.sites.hideClosed}</Link>
            </>
          ) : closedCount > 0 ? (
            <>
              {' · '}
              <Link href="/admin/sites?closed=1">
                {s.sites.showClosed} ({closedCount})
              </Link>
            </>
          ) : null}
        </p>
        {items.length === 0 ? (
          <p>{s.sites.empty}</p>
        ) : (
          <div className="worker-table-scroll">
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
          </div>
        )}
      </div>
    </main>
  );
}
