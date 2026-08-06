import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets } from '@/lib/worker-context';
import { getWorkerTimesheetDraft, getWorkerTimesheetSummary } from '@/lib/worker-timesheets';
import { ReturnReasonsNotice } from '../ReturnReasonsNotice';
import SubmitButton from './SubmitButton';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods/[periodId]/submit` — confirmation before
// timesheet.submit. UNRESOLVED_PROPOSALS can't actually occur yet (TimesheetReviewProposal isn't
// built — ЭТАП 7 sub-task 5's own note), but SubmitButton still surfaces that error code correctly
// if the contract ever starts returning it.
const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

function segmentMinutes(segments: { startAt: string; endAt: string }[]): number {
  return segments.reduce((sum, s) => sum + (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000, 0);
}

type RouteParams = { params: Promise<{ periodId: string }> };

export default async function WorkerSubmitPage({ params }: RouteParams) {
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

  if (!period || !EDITABLE_STATUSES.has(period.timesheetStatus)) {
    redirect(`/worker/periods/${periodId}`);
  }

  const draft = await getWorkerTimesheetDraft(employeeId, period.timesheetId);
  const days = 'code' in draft ? [] : draft.days;
  const workedDays = days.filter((d) => d.segments.length > 0 || d.confirmedZero || d.dayType !== 'WORK');
  const totalMinutes = days.reduce((sum, d) => sum + segmentMinutes(d.segments), 0);
  const summary = await getWorkerTimesheetSummary(employeeId, period.timesheetId);
  const returnReasons = 'code' in summary ? [] : summary.returnReasons;

  return (
    <main className="wk-page">
      <div className="wk-card">
        <Link href={`/worker/periods/${periodId}/hours`} className="wk-back-link">
          ← Back to hours
        </Link>
        <h1>Submit timesheet</h1>
        <ReturnReasonsNotice status={period.timesheetStatus} reasons={returnReasons} />
        <p>
          {period.startDate} – {period.endDate}
        </p>
        <p className="wk-readonly-note">
          {workedDays.length} of {days.length} days filled in · {Math.floor(totalMinutes / 60)}h {Math.round(totalMinutes % 60)}m total
        </p>
        <p className="wk-empty">Once submitted, you won&apos;t be able to edit your hours unless it&apos;s returned to you.</p>
        <SubmitButton periodId={periodId} timesheetId={period.timesheetId} />
      </div>
    </main>
  );
}
