import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getSiteDetail } from '@/lib/sites';
import { listAssignableForemen } from '@/lib/foreman-assignments';
import { getGeofenceHistory } from '@/lib/geofences';
import { SiteEditForm } from './SiteEditForm';
import { SiteFinishFlow } from './SiteFinishFlow';
import { WorkAreaSection } from './WorkAreaSection';
import { ForemanAssignmentSection } from './ForemanAssignmentSection';
import { GeofenceSection } from './GeofenceSection';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

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

  const { siteId } = await params;
  const [site, assignableForemen, geofenceHistory] = await Promise.all([getSiteDetail(siteId), listAssignableForemen(), getGeofenceHistory(siteId, 1, 20)]);

  if (!site) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            {s.sites.notFound}
          </p>
        </div>
      </main>
    );
  }

  // getGeofenceHistory only returns null for a nonexistent site — site is already confirmed to
  // exist above (WorkSite has no delete path), this fallback is purely defensive.
  const geofence = geofenceHistory ?? { siteId: site.id, currentGeofenceVersionId: null, current: null, items: [], page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{site.name}</h1>
        <p className="setup-subtitle">
          {site.active ? s.common.active : s.common.closed}
          {site.defaultForemanUsername ? ` · ${s.sites.defaultForeman}: ${site.defaultForemanUsername}` : ''}
        </p>
        <p>
          <Link href={`/admin/reports/sites?siteId=${site.id}`}>{s.sites.report}</Link>
        </p>

        <SiteFinishFlow site={{ id: site.id, name: site.name, finishingState: site.finishingState, finishedAt: site.finishedAt, stuckOpenShifts: site.stuckOpenShifts }} />

        <WorkAreaSection siteId={site.id} workAreas={site.workAreas} />

        <ForemanAssignmentSection siteId={site.id} foremanAssignments={site.foremanAssignments} assignableForemen={assignableForemen} />

        <GeofenceSection siteId={site.id} history={geofence} siteAddress={site.address} />

        <h2>{s.sites.assignments}</h2>
        {site.activeAssignments.length === 0 ? (
          <p>{s.common.none}</p>
        ) : (
          <ul className="setup-list">
            {site.activeAssignments.map((assignment) => (
              <li key={assignment.employeeId} className="setup-item">
                <span className="setup-label">
                  {assignment.employeeName}
                  {assignment.isPrimary ? ` (${s.common.primary})` : ''}
                  {assignment.workAreaName ? ` — ${assignment.workAreaName}` : ''}
                  {assignment.templateName ? ` — ${assignment.templateName}` : ''}
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
