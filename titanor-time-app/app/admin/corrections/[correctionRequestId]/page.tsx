import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getCorrectionDetail } from '@/lib/corrections';
import { CorrectionActions } from './CorrectionActions';

export const dynamic = 'force-dynamic';

function segmentMinutes(segments: { startAt: string; endAt: string }[]): number {
  return segments.reduce((sum, s) => sum + (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000, 0);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ correctionRequestId: string }> };

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 T7.9 — request/draft.edit/submit/approve all folded
// into this one page (confirmed ADMIN-only first slice), mirroring how /admin/timesheets/
// [timesheetId] combines card+actions rather than separate routes per action.
export default async function AdminCorrectionDetailPage({ params }: RouteParams) {
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

  const { correctionRequestId } = await params;
  const correction = await getCorrectionDetail(correctionRequestId);

  if (!correction) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>No correction request with this id.</p>
          <Link href="/admin/corrections">Back to corrections</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{correction.employeeName}</h1>
        <p className="setup-subtitle">
          Status: {correction.status} · reason: {correction.reason}
        </p>
        {correction.overrideReason ? <p className="setup-subtitle">Override reason: {correction.overrideReason}</p> : null}

        {correction.days.length === 0 ? (
          <p>{correction.status === 'PENDING' ? 'Open the draft to start editing.' : 'No days to show.'}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Details</th>
                {correction.status === 'DRAFT_OPEN' ? <th></th> : null}
              </tr>
            </thead>
            <tbody>
              {correction.days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>
                    {day.dayType !== 'WORK'
                      ? day.dayType.replace('_', ' ').toLowerCase()
                      : day.segments.length === 0
                        ? day.confirmedZero
                          ? 'Confirmed 0h'
                          : '—'
                        : `${formatMinutes(segmentMinutes(day.segments))} · ${[...new Set(day.segments.map((s) => s.siteId))].length} site(s)`}
                  </td>
                  {correction.status === 'DRAFT_OPEN' ? (
                    <td>
                      <Link href={`/admin/corrections/${correction.id}/days/${day.date}`}>Edit</Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <CorrectionActions correctionRequestId={correction.id} status={correction.status} isSuperAdmin={session.user.roles.includes('SUPER_ADMIN')} />

        <p>
          <Link href="/admin/corrections">Back to corrections</Link>
        </p>
      </div>
    </main>
  );
}
