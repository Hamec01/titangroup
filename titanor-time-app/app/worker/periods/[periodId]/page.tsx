import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets, listWorkerCurrentAssignments } from '@/lib/worker-context';
import { getWorkerTimesheetSummary } from '@/lib/worker-timesheets';
import { ReturnReasonsNotice } from './ReturnReasonsNotice';
import { AdminCorrectionNotice } from './AdminCorrectionNotice';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import type { PeriodDetailPayload } from '@/lib/offline-outbox/read-snapshots';
import { workerTimesheetStatusLabel } from '@/lib/worker-timesheet-presentation';
import { resolveAppLocale } from '@/lib/i18n/server';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS } from '@/lib/i18n/worker';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods/[periodId]` — "финальная точка первого
// вертикального сценария": объект(ы), рабочая область, шаблон и статус табеля этого периода.
// Resolves the period via listWorkerTimesheets (all of them, not just actionable) — this page
// doubles as /worker/history's detail target, so a period whose timesheet has left "actionable"
// (e.g. FINAL_APPROVED, once timesheet.final_approve exists) must still open here, read-only.
// Assignments are resolved as of the period's own start date, not "today" — a past period's
// assignments may no longer be current.
const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);
type RouteParams = { params: Promise<{ periodId: string }> };

export default async function WorkerPeriodDetailPage({ params }: RouteParams) {
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

  const { periodId } = await params;
  const employeeId = session.user.employeeId;

  const periods = await listWorkerTimesheets(employeeId);
  const period = periods.find((p) => p.id === periodId);

  if (!period) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>{t.periodNotAvailable}</p>
          <WorkerLink href="/worker/periods" className="wk-back-link">
            {common.backToYourPeriods}
          </WorkerLink>
        </div>
      </main>
    );
  }

  const assignments = await listWorkerCurrentAssignments(employeeId, new Date(`${period.startDate}T00:00:00.000Z`));
  const summary = await getWorkerTimesheetSummary(employeeId, period.timesheetId);
  const returnReasons = 'code' in summary ? [] : summary.returnReasons;
  const adminCorrection = 'code' in summary ? null : summary.adminCorrection;
  const editable = EDITABLE_STATUSES.has(period.timesheetStatus);

  const snapshotPayload: PeriodDetailPayload = {
    periodId: period.id,
    startDate: period.startDate,
    endDate: period.endDate,
    timesheetStatus: period.timesheetStatus,
    editable,
    totalMinutes: period.totalMinutes,
    assignments: assignments.map((a) => ({ id: a.id, siteName: a.siteName, workAreaName: a.workAreaName, templateName: a.templateName, isPrimary: a.isPrimary })),
    returnReasons: returnReasons.map((r) => ({ scopeType: r.scopeType, siteName: r.siteName, contextSiteName: r.contextSiteName, reason: r.reason, returnedAt: r.returnedAt }))
  };

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <h1>
          {period.startDate} – {period.endDate}
        </h1>
        <span className={`wk-status-badge wk-status-${period.timesheetStatus.toLowerCase()}`}>{workerTimesheetStatusLabel(period.timesheetStatus, period.totalMinutes, locale)}</span>

        <ReturnReasonsNotice status={period.timesheetStatus} reasons={returnReasons} />
        <AdminCorrectionNotice correction={adminCorrection} />

        <h2 className="wk-section-title">{t.yourAssignments}</h2>
        {assignments.length === 0 ? (
          <p className="wk-empty">{t.notAssignedToSiteYet}</p>
        ) : (
          <ul className="wk-assignment-list">
            {assignments.map((assignment) => (
              <li key={assignment.id} className="wk-assignment-item">
                <span className="wk-assignment-site">
                  {assignment.siteName}
                  {assignment.isPrimary ? t.primarySuffix : ''}
                </span>
                {assignment.workAreaName && <span className="wk-assignment-detail">{assignment.workAreaName}</span>}
                {assignment.templateName && <span className="wk-assignment-detail">{assignment.templateName}</span>}
              </li>
            ))}
          </ul>
        )}

        {editable ? (
          <WorkerLink href={`/worker/periods/${period.id}/hours`} className="wk-action-button">
            {t.enterHours}
          </WorkerLink>
        ) : (
          <WorkerLink href={`/worker/periods/${period.id}/hours`} className="wk-back-link">
            {t.viewHours}
          </WorkerLink>
        )}
      </div>
      <SnapshotWriter routeKind="period-detail" ownerUserId={session.user.id} periodId={period.id} payload={snapshotPayload} />
    </main>
  );
}
