import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getClockState } from '@/lib/attendance-clock';
import { listWorkerCurrentAssignments, listActionablePeriods, getWorkerContext } from '@/lib/worker-context';
import { helsinkiToday } from '@/lib/workers';
import { WorkerClockPanel } from './WorkerClockPanel';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker` — post-login mobile-first clock home page
// (T7A Worker Online Clock UI). employeeId is always the session's own, never accepted from
// query/body (§14 threat model — "Подмена employeeId"). Independent reads run via Promise.all so
// hydration doesn't wait on them sequentially; WorkerClockPanel hydrates from this server-rendered
// state and only re-fetches GET clock-state itself after a mutating action or a network-unknown
// reconciliation (§6/§7 of the task brief) — never as a redundant bootstrap call.
export default async function WorkerHomePage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!session.user.roles.includes('WORKER')) {
    return (
      <main className="wk-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the WORKER role.
        </p>
      </main>
    );
  }
  if (!session.user.employeeId) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>Your account has no linked employee profile.</p>
        </div>
      </main>
    );
  }

  const employeeId = session.user.employeeId;
  const today = helsinkiToday();

  const [clockState, assignments, periods, context] = await Promise.all([
    getClockState(employeeId),
    listWorkerCurrentAssignments(employeeId, today),
    listActionablePeriods(employeeId),
    getWorkerContext(session.user.id, session.user.locale, employeeId)
  ]);

  const periodsHref = periods.length === 1 ? `/worker/periods/${periods[0].id}` : '/worker/periods';
  const todayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', weekday: 'long', day: 'numeric', month: 'long' }).format(today);
  const workerName = context ? `${context.employee.firstName} ${context.employee.lastName}` : null;

  return (
    <main className="wk-page">
      <WorkerClockPanel initialClockState={clockState} assignments={assignments} workerName={workerName} todayLabel={todayLabel} periodsHref={periodsHref} />
    </main>
  );
}
