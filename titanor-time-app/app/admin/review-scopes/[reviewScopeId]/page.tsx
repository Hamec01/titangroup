import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getReviewScopeDetail } from '@/lib/review-scopes';
import { prisma } from '@/lib/prisma';
import { ReviewActions } from './ReviewActions';

export const dynamic = 'force-dynamic';

function segmentMinutes(segments: { startAt: string; endAt: string }[]): number {
  return segments.reduce((sum, s) => sum + (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000, 0);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ reviewScopeId: string }> };

export default async function AdminReviewScopeDetailPage({ params }: RouteParams) {
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

  const { reviewScopeId } = await params;
  const scope = await getReviewScopeDetail(reviewScopeId);

  if (!scope) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>No review scope with this id.</p>
          <Link href="/admin/review-scopes">Back to reviews</Link>
        </div>
      </main>
    );
  }

  const [employee, site] = await Promise.all([
    prisma.employee.findUnique({ where: { id: scope.employeeId }, select: { firstName: true, lastName: true } }),
    scope.siteId ? prisma.workSite.findUnique({ where: { id: scope.siteId }, select: { name: true } }) : Promise.resolve(null)
  ]);

  const title = scope.scopeType === 'SITE' ? (site?.name ?? scope.siteId) : scope.scopePurpose === 'EMPTY_FALLBACK' ? 'Empty timesheet confirmation' : 'Non-site data';

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{title}</h1>
        <p className="setup-subtitle">
          {employee ? `${employee.firstName} ${employee.lastName}` : scope.employeeId} · status {scope.status} · version {scope.versionNumber}
        </p>

        {scope.days.length === 0 ? (
          <p>{scope.scopePurpose === 'EMPTY_FALLBACK' ? 'No hours were logged this period.' : 'No days to show for this scope.'}</p>
        ) : (
          <ul className="setup-list">
            {scope.days.map((day) => (
              <li key={day.date} className="setup-item">
                <span className="setup-label">
                  {day.date} — {day.dayType !== 'WORK' ? day.dayType.replace('_', ' ').toLowerCase() : day.segments.length === 0 ? (day.confirmedZero ? 'Confirmed 0h' : '—') : formatMinutes(segmentMinutes(day.segments))}
                </span>
              </li>
            ))}
          </ul>
        )}

        {scope.status === 'PENDING' ? (
          <ReviewActions reviewScopeId={scope.id} />
        ) : (
          <p className="setup-subtitle">Already {scope.status.toLowerCase()}.</p>
        )}

        <p>
          <Link href="/admin/review-scopes">Back to reviews</Link>
        </p>
      </div>
    </main>
  );
}
