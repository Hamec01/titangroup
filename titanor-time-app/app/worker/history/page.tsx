import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets } from '@/lib/worker-context';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import type { HistoryListPayload } from '@/lib/offline-outbox/read-snapshots';
import { workerTimesheetStatusLabel } from '@/lib/worker-timesheet-presentation';
import { resolveAppLocale } from '@/lib/i18n/server';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS } from '@/lib/i18n/worker';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/history` — all periods, not just actionable.
// Links straight to the already-built /worker/periods/[periodId] rather than a separate
// /worker/history/[timesheetId] route — that page already branches editable-vs-read-only by
// status, which is exactly what a history entry (often FINAL_APPROVED) needs.
export default async function WorkerHistoryPage() {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const common = COMMON_STRINGS[locale];
  const t = WORKER_STRINGS[locale];
  if (!session) {
    redirect('/login');
  }
  if (!session.user.roles.includes('WORKER')) {
    return (
      <main className="wk-page">
        <p className="login-error" role="alert">
          {common.accessDeniedWorker}
        </p>
      </main>
    );
  }
  if (!session.user.employeeId) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>{common.noEmployeeProfile}</p>
        </div>
      </main>
    );
  }

  const timesheets = await listWorkerTimesheets(session.user.employeeId);

  const snapshotPayload: HistoryListPayload = {
    timesheets: timesheets.map((t) => ({ id: t.id, startDate: t.startDate, endDate: t.endDate, timesheetId: t.timesheetId, timesheetStatus: t.timesheetStatus, totalMinutes: t.totalMinutes, workedDayCount: t.workedDayCount }))
  };

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <WorkerLink href="/worker/periods" className="wk-back-link">
          {t.currentPeriods}
        </WorkerLink>
        <h1>{t.historyTitle}</h1>
        {timesheets.length === 0 ? (
          <p className="wk-empty">{t.noPeriodsYet}</p>
        ) : (
          <ul className="wk-period-list">
            {timesheets.map((t) => (
              <li key={t.timesheetId}>
                <WorkerLink href={`/worker/periods/${t.id}`} className="wk-period-item">
                  <span className="wk-period-dates">
                    {t.startDate} – {t.endDate}
                  </span>
                  <span className={`wk-status-badge wk-status-${t.timesheetStatus.toLowerCase()}`}>{workerTimesheetStatusLabel(t.timesheetStatus, t.totalMinutes, locale)}</span>
                </WorkerLink>
              </li>
            ))}
          </ul>
        )}
      </div>
      <SnapshotWriter routeKind="history-list" ownerUserId={session.user.id} payload={snapshotPayload} />
    </main>
  );
}
