import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets } from '@/lib/worker-context';
import { getWorkerTimesheetDraft, getWorkerTimesheetCurrentVersion, getWorkerTimesheetSummary, type SegmentView } from '@/lib/worker-timesheets';
import { prisma } from '@/lib/prisma';
import { ReturnReasonsNotice } from '../ReturnReasonsNotice';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import type { HoursListPayload } from '@/lib/offline-outbox/read-snapshots';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods/[periodId]/hours` — the day list. Which
// source backs it depends on the timesheet's own status, not a client choice: DRAFT/RETURNED reads
// the mutable draft (day rows link to the editor); SUBMITTED/FOREMAN_APPROVED reads the frozen
// current-version read-only (04_...§9 — draft is physically emptied by submit, current-version is
// what exists instead). DoD: no edit affordance is rendered at all once the timesheet isn't
// editable, matching PATCH .../days/:date's own 409 DRAFT_NOT_EDITABLE guard.
const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

function segmentMinutes(segments: { startAt: string; endAt: string }[]): number {
  return segments.reduce((sum, s) => sum + (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000, 0);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

type RouteParams = { params: Promise<{ periodId: string }> };

export default async function WorkerHoursListPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  if (!session.user.roles.includes('WORKER') || !session.user.employeeId) {
    redirect('/worker/periods');
  }

  const { periodId } = await params;
  const employeeId = session.user.employeeId;
  const periods = await listWorkerTimesheets(employeeId);
  const period = periods.find((p) => p.id === periodId);

  if (!period) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>This period is not available to you.</p>
          <WorkerLink href="/worker/periods" className="wk-back-link">
            Back to your periods
          </WorkerLink>
        </div>
      </main>
    );
  }

  const editable = EDITABLE_STATUSES.has(period.timesheetStatus);

  let days: { date: string; dayType: string; confirmedZero: boolean; segments: SegmentView[] }[];
  if (editable) {
    const draft = await getWorkerTimesheetDraft(employeeId, period.timesheetId);
    days = 'code' in draft ? [] : draft.days;
  } else {
    const version = await getWorkerTimesheetCurrentVersion(employeeId, period.timesheetId);
    days = 'code' in version ? [] : version.days;
  }

  const siteIds = [...new Set(days.flatMap((d) => d.segments.map((s) => s.siteId)))];
  const sites = siteIds.length > 0 ? await prisma.workSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : [];
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));

  const summary = await getWorkerTimesheetSummary(employeeId, period.timesheetId);
  const returnReasons = 'code' in summary ? [] : summary.returnReasons;

  const snapshotPayload: HoursListPayload = {
    periodId,
    startDate: period.startDate,
    endDate: period.endDate,
    timesheetStatus: period.timesheetStatus,
    editable,
    days: days.map((day) => ({
      date: day.date,
      dayType: day.dayType,
      confirmedZero: day.confirmedZero,
      totalMinutes: segmentMinutes(day.segments),
      siteNames: [...new Set(day.segments.map((s) => siteNameById.get(s.siteId) ?? s.siteId))]
    })),
    returnReasons: returnReasons.map((r) => ({ scopeType: r.scopeType, siteName: r.siteName, contextSiteName: r.contextSiteName, reason: r.reason, returnedAt: r.returnedAt }))
  };

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <WorkerLink href={`/worker/periods/${periodId}`} className="wk-back-link">
          ← {period.startDate} – {period.endDate}
        </WorkerLink>
        <h1>Hours</h1>
        <ReturnReasonsNotice status={period.timesheetStatus} reasons={returnReasons} />
        {!editable && <p className="wk-readonly-note">Read-only — this timesheet is being reviewed.</p>}

        {days.length === 0 ? (
          <p className="wk-empty">No days in this period yet.</p>
        ) : (
          <ul className="wk-day-list">
            {days.map((day) => {
              const minutes = segmentMinutes(day.segments);
              const content = (
                <>
                  <span className="wk-day-date">{day.date}</span>
                  <span className="wk-day-summary">
                    {day.dayType !== 'WORK'
                      ? day.dayType.replace('_', ' ').toLowerCase()
                      : day.confirmedZero
                        ? 'Confirmed 0h'
                        : day.segments.length === 0
                          ? '—'
                          : `${formatMinutes(minutes)} · ${day.segments.map((s) => siteNameById.get(s.siteId) ?? s.siteId).join(', ')}`}
                  </span>
                </>
              );
              return (
                <li key={day.date}>
                  {editable ? (
                    <WorkerLink href={`/worker/periods/${periodId}/hours/${day.date}`} className="wk-day-item">
                      {content}
                    </WorkerLink>
                  ) : (
                    <div className="wk-day-item wk-day-item-readonly">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {editable && (
          <WorkerLink href={`/worker/periods/${periodId}/submit`} className="wk-action-button">
            Review and submit
          </WorkerLink>
        )}
      </div>
      <SnapshotWriter routeKind="hours-list" ownerUserId={session.user.id} periodId={periodId} payload={snapshotPayload} />
    </main>
  );
}
