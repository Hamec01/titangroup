import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getTimesheetCard } from '@/lib/admin-timesheets';
import { FinalApprovalActions } from './FinalApprovalActions';

export const dynamic = 'force-dynamic';

function segmentMinutes(segments: { startAt: string; endAt: string }[]): number {
  return segments.reduce((sum, s) => sum + (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000, 0);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ timesheetId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets/[timesheetId]` — card + (when
// FOREMAN_APPROVED) the final-approve/override-return actions folded into the same page rather
// than a separate .../approve route, mirroring how /admin/review-scopes/[reviewScopeId] already
// combines detail+actions.
export default async function AdminTimesheetCardPage({ params }: RouteParams) {
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

  const { timesheetId } = await params;
  const card = await getTimesheetCard(timesheetId);

  if (!card) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>No timesheet with this id.</p>
          <Link href="/admin/timesheets">Back to timesheets</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{card.employeeName}</h1>
        <p className="setup-subtitle">
          Status: {card.status} {card.versionNumber ? `· version ${card.versionNumber}` : ''}
        </p>

        {card.days.length === 0 ? (
          <p>No submitted version yet.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {card.days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>
                    {day.dayType !== 'WORK'
                      ? day.dayType.replace('_', ' ').toLowerCase()
                      : day.segments.length === 0
                        ? day.confirmedZero
                          ? 'Confirmed 0h'
                          : '—'
                        : `${formatMinutes(segmentMinutes(day.segments))} · ${day.segments.map((s) => s.siteName).join(', ')}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {card.status === 'FOREMAN_APPROVED' ? (
          <FinalApprovalActions timesheetId={card.timesheetId} />
        ) : (
          <p className="setup-subtitle">Not awaiting final approval (status: {card.status}).</p>
        )}

        <p>
          <Link href="/admin/timesheets">Back to timesheets</Link>
        </p>
      </div>
    </main>
  );
}
