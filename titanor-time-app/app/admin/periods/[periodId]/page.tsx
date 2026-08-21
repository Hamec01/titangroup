import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getPeriodDetail } from '@/lib/periods';
import { LockPeriodAction } from './LockPeriodAction';
import { LegacyPeriodEditForm } from './LegacyPeriodEditForm';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ periodId: string }> };

export default async function AdminPeriodDetailPage({ params }: RouteParams) {
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

  const { periodId } = await params;
  const period = await getPeriodDetail(periodId);

  if (!period) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>No period with this id.</p>
          <Link href="/admin/periods">Back to periods</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>
          {period.startDate} – {period.endDate}
        </h1>
        <p className="setup-subtitle">
          Status: {period.status} · version {period.version}
        </p>

        {period.status === 'OPEN' ? (
          <div className="worker-setup-callout">
            <p>
              <strong>What to do now:</strong> leave this period open while workers enter and submit hours.
            </p>
            <p>New workers are added automatically when their assignment dates overlap this period.</p>
          </div>
        ) : null}

        {period.status === 'OPEN' && period.submissionScheduleId === null ? <LegacyPeriodEditForm period={period} /> : null}

        <ul className="setup-list">
          <li className="setup-item">
            <span className="setup-label">Participants</span>
            <span className="setup-status setup-status-pending">{period.participantsTotal}</span>
          </li>
          <li className="setup-item">
            <span className="setup-label">Final approved</span>
            <span className="setup-status setup-status-done">{period.timesheetsFinalApproved}</span>
          </li>
          <li className="setup-item">
            <span className="setup-label">Still pending</span>
            <span className="setup-status setup-status-pending">{period.timesheetsPending}</span>
          </li>
        </ul>

        {period.lockedAt && <p className="setup-subtitle">Locked at {period.lockedAt}</p>}
        {period.exportedAt && <p className="setup-subtitle">Exported at {period.exportedAt}</p>}

        {period.status === 'OPEN' ? (
          <LockPeriodAction periodId={period.id} canLock={period.participantsTotal > 0 && period.timesheetsPending === 0} />
        ) : null}

        <p>
          <Link href={`/admin/reports?periodId=${period.id}`}>View a worker's time report for this period</Link>
        </p>
        <p>
          <Link href={`/admin/reports/sites?periodId=${period.id}`}>View a site's time report for this period</Link>
        </p>
        <p>
          <Link href={`/admin/reports/periods?periodId=${period.id}`}>View full period report</Link>
        </p>
        <p>
          <Link href={`/admin/export?periodId=${period.id}`}>View CSV exports for this period</Link>
        </p>
        <p>
          <Link href="/admin/periods">Back to periods</Link>
        </p>
      </div>
    </main>
  );
}
