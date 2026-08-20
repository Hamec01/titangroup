import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getForemanTimesheetDetail } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';
import { ForemanReviewActions } from './ForemanReviewActions';
import { workedMinutesFromIsoSegments } from '@/lib/reporting/report-format';

export const dynamic = 'force-dynamic';

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ timesheetId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/[timesheetId]` — card + approve/return
// folded into the same page (mirrors /admin/review-scopes/[reviewScopeId] and
// /admin/timesheets/[timesheetId]'s established precedent, rather than separate .../approve and
// .../return routes). Days on other sites are shown collapsed, not omitted — the worker's week
// stays visible as a whole even though only this foreman's own site is expanded.
export default async function ForemanReviewDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!session.user.roles.includes('FOREMAN')) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the FOREMAN role.
        </p>
      </main>
    );
  }

  const { timesheetId } = await params;
  const detail = await getForemanTimesheetDetail(timesheetId, session.user.id, helsinkiToday());

  if (!detail) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>No timesheet with this id on your own sites.</p>
          <Link href="/foreman/review">Back to review queue</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{detail.employeeName}</h1>
        <p className="setup-subtitle">
          Status: {detail.status} · version {detail.versionNumber}
          {detail.hasException ? ' · has exception' : ''}
        </p>

        <ul className="setup-list">
          {detail.days.map((day) => (
            <li key={day.date} className="setup-item">
              <span className="setup-label">
                {day.date} —{' '}
                {day.collapsed
                  ? 'other site'
                  : day.dayType !== 'WORK'
                    ? day.dayType.replace('_', ' ').toLowerCase()
                    : day.segments.length === 0
                      ? day.confirmedZero
                        ? 'Confirmed 0h'
                        : '—'
                      : formatMinutes(workedMinutesFromIsoSegments(day.segments))}
              </span>
            </li>
          ))}
        </ul>

        {detail.reviewScopeStatus === 'PENDING' ? (
          <ForemanReviewActions reviewScopeId={detail.reviewScopeId} />
        ) : (
          <p className="setup-subtitle">Already {detail.reviewScopeStatus.toLowerCase()}.</p>
        )}

        <p>
          <Link href="/foreman/review">Back to review queue</Link>
        </p>
      </div>
    </main>
  );
}
