import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets, listWorkerCurrentAssignments } from '@/lib/worker-context';
import { getWorkerTimesheetDraft, getWorkerTimesheetSummary } from '@/lib/worker-timesheets';
import DayEditor from './DayEditor';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import type { DayDetailPayload } from '@/lib/offline-outbox/read-snapshots';

export const dynamic = 'force-dynamic';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

type RouteParams = { params: Promise<{ periodId: string; date: string }> };

export default async function WorkerDayEditorPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  if (!session.user.roles.includes('WORKER') || !session.user.employeeId) {
    redirect('/worker/periods');
  }

  const { periodId, date } = await params;
  if (!DATE_PATTERN.test(date)) {
    redirect(`/worker/periods/${periodId}/hours`);
  }

  const employeeId = session.user.employeeId;
  const periods = await listWorkerTimesheets(employeeId);
  const period = periods.find((p) => p.id === periodId);
  if (!period || !EDITABLE_STATUSES.has(period.timesheetStatus)) {
    redirect(`/worker/periods/${periodId}/hours`);
  }

  const draft = await getWorkerTimesheetDraft(employeeId, period.timesheetId);
  if ('code' in draft) {
    redirect(`/worker/periods/${periodId}/hours`);
  }
  const day = draft.days.find((d) => d.date === date);

  const dayDate = new Date(`${date}T00:00:00.000Z`);
  const assignments = await listWorkerCurrentAssignments(employeeId, dayDate);
  const summary = await getWorkerTimesheetSummary(employeeId, period.timesheetId);
  const returnReasons = 'code' in summary ? [] : summary.returnReasons;
  const segments = day?.segments ?? [];

  // No extra DB query — reuses the same `assignments` this page already fetched for the editor's
  // own dropdown. A segment whose siteId/workAreaId no longer matches a current assignment falls
  // back to the raw id, same graceful-degradation pattern as app/worker/periods/[periodId]/hours.
  const nameByAssignment = new Map(assignments.map((a) => [`${a.siteId}::${a.workAreaId ?? ''}`, { siteName: a.siteName, workAreaName: a.workAreaName }]));
  const snapshotPayload: DayDetailPayload = {
    periodId,
    date,
    dayType: day?.dayType ?? 'WORK',
    confirmedZero: day?.confirmedZero ?? false,
    timesheetStatus: period.timesheetStatus,
    segments: segments.map((s) => {
      const names = nameByAssignment.get(`${s.siteId}::${s.workAreaId ?? ''}`);
      return {
        startAt: s.startAt,
        endAt: s.endAt,
        siteName: names?.siteName ?? s.siteId,
        workAreaName: names?.workAreaName ?? null,
        breaks: s.breaks.map((b) => ({ startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
      };
    }),
    returnReasons: returnReasons.map((r) => ({ scopeType: r.scopeType, siteName: r.siteName, contextSiteName: r.contextSiteName, reason: r.reason, returnedAt: r.returnedAt }))
  };

  return (
    <>
      <DayEditor
        periodId={periodId}
        timesheetId={period.timesheetId}
        date={date}
        initialDayType={day?.dayType ?? 'WORK'}
        initialConfirmedZero={day?.confirmedZero ?? false}
        initialSegments={segments}
        assignmentOptions={assignments.map((a) => ({ siteId: a.siteId, siteName: a.siteName, workAreaId: a.workAreaId, workAreaName: a.workAreaName }))}
        timesheetStatus={period.timesheetStatus}
        returnReasons={returnReasons}
      />
      <SnapshotWriter routeKind="day-detail" ownerUserId={session.user.id} periodId={periodId} date={date} payload={snapshotPayload} />
    </>
  );
}
