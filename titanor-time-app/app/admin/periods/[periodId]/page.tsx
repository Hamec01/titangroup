import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getPeriodDetail } from '@/lib/periods';
import { LockPeriodAction } from './LockPeriodAction';
import { LegacyPeriodEditForm } from './LegacyPeriodEditForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ periodId: string }> };

export default async function AdminPeriodDetailPage({ params }: RouteParams) {
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

  const { periodId } = await params;
  const period = await getPeriodDetail(periodId);

  if (!period) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p>{s.periods.notFound}</p>
          <Link href="/admin/periods">{s.periods.back}</Link>
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
          {s.common.status}: {period.status} · {s.common.version} {period.version}
        </p>

        {period.status === 'OPEN' ? (
          <div className="worker-setup-callout">
            <p>
              <strong>{s.periods.whatNow}</strong> {s.periods.openHelp}
            </p>
            <p>{s.periods.autoParticipants}</p>
          </div>
        ) : null}

        {period.status === 'OPEN' && period.submissionScheduleId === null ? <LegacyPeriodEditForm period={period} /> : null}

        <ul className="setup-list">
          <li className="setup-item">
            <span className="setup-label">{s.periods.participants}</span>
            <span className="setup-status setup-status-pending">{period.participantsTotal}</span>
          </li>
          <li className="setup-item">
            <span className="setup-label">{s.periods.approved}</span>
            <span className="setup-status setup-status-done">{period.timesheetsFinalApproved}</span>
          </li>
          <li className="setup-item">
            <span className="setup-label">{s.periods.pending}</span>
            <span className="setup-status setup-status-pending">{period.timesheetsPending}</span>
          </li>
        </ul>

        {period.lockedAt && <p className="setup-subtitle">{s.periods.lockedAt}: {period.lockedAt}</p>}
        {period.exportedAt && <p className="setup-subtitle">{s.periods.exportedAt}: {period.exportedAt}</p>}

        {period.status === 'OPEN' ? (
          <LockPeriodAction periodId={period.id} canLock={period.participantsTotal > 0 && period.timesheetsPending === 0} />
        ) : null}

        <p>
          <Link href={`/admin/reports?periodId=${period.id}`}>{s.periods.workerReport}</Link>
        </p>
        <p>
          <Link href={`/admin/reports/sites?periodId=${period.id}`}>{s.periods.siteReport}</Link>
        </p>
        <p>
          <Link href={`/admin/reports/periods?periodId=${period.id}`}>{s.periods.fullReport}</Link>
        </p>
        <p>
          <Link href={`/admin/export?periodId=${period.id}`}>{s.periods.csv}</Link>
        </p>
        <p>
          <Link href="/admin/periods">{s.periods.back}</Link>
        </p>
      </div>
    </main>
  );
}
