import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getSiteDetail } from '@/lib/sites';
import { SiteEditForm } from './SiteEditForm';
import { WorkAreaSection } from './WorkAreaSection';
import { ForemanAssignmentSection } from './ForemanAssignmentSection';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md, docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md
// §3 (/admin/sites/:siteId). "Closing" a site (PROJECT_ROADMAP.md T6.6) is
// just the `active` field in the same PATCH as everything else — unlike
// worker deactivation, there's no separate business rule/endpoint for it.
export default async function SiteDetailPage({ params }: { params: Promise<{ siteId: string }> }) {
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

  const { siteId } = await params;
  const site = await getSiteDetail(siteId);

  if (!site) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            No site found with this id.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{site.name}</h1>
        <p className="setup-subtitle">
          {site.active ? 'Active' : 'Closed'}
          {site.defaultForemanUsername ? ` · default foreman: ${site.defaultForemanUsername}` : ''}
        </p>

        <WorkAreaSection siteId={site.id} workAreas={site.workAreas} />

        <ForemanAssignmentSection siteId={site.id} foremanAssignments={site.foremanAssignments} />

        <h2>Active assignments</h2>
        {site.activeAssignments.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul className="setup-list">
            {site.activeAssignments.map((assignment) => (
              <li key={assignment.employeeId} className="setup-item">
                <span className="setup-label">
                  {assignment.employeeName}
                  {assignment.isPrimary ? ' (primary)' : ''}
                  {assignment.workAreaName ? ` — ${assignment.workAreaName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}

        <SiteEditForm site={site} />
      </div>
    </main>
  );
}
