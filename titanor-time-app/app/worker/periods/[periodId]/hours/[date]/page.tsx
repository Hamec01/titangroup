import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listActionablePeriods, listWorkerCurrentAssignments } from '@/lib/worker-context';
import { getWorkerTimesheetDraft } from '@/lib/worker-timesheets';
import DayEditor from './DayEditor';

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
  const periods = await listActionablePeriods(employeeId);
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

  return (
    <DayEditor
      periodId={periodId}
      timesheetId={period.timesheetId}
      date={date}
      initialDayType={day?.dayType ?? 'WORK'}
      initialConfirmedZero={day?.confirmedZero ?? false}
      initialSegments={day?.segments ?? []}
      assignmentOptions={assignments.map((a) => ({ siteId: a.siteId, siteName: a.siteName, workAreaId: a.workAreaId, workAreaName: a.workAreaName }))}
    />
  );
}
