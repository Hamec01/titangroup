import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getClockState } from '@/lib/attendance-clock';
import { listWorkerCurrentAssignments, listActionablePeriods, getWorkerContext } from '@/lib/worker-context';
import { helsinkiToday } from '@/lib/workers';
import { WorkerClockPanel } from './WorkerClockPanel';
import { resolveAppLocale } from '@/lib/i18n/server';
import { COMMON_STRINGS } from '@/lib/i18n/common';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker` — post-login mobile-first clock home page
// (T7A Worker Online Clock UI). employeeId is always the session's own, never accepted from
// query/body (§14 threat model — "Подмена employeeId"). Independent reads run via Promise.all so
// hydration doesn't wait on them sequentially; WorkerClockPanel hydrates from this server-rendered
// state and only re-fetches GET clock-state itself after a mutating action or a network-unknown
// reconciliation (§6/§7 of the task brief) — never as a redundant bootstrap call.
export default async function WorkerHomePage() {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const common = COMMON_STRINGS[locale];
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

  const employeeId = session.user.employeeId;
  const today = helsinkiToday();

  const [clockState, assignments, periods, context] = await Promise.all([
    getClockState(employeeId),
    listWorkerCurrentAssignments(employeeId, today),
    listActionablePeriods(employeeId),
    getWorkerContext(session.user.id, session.user.locale, employeeId)
  ]);

  const periodsHref = periods.length === 1 ? `/worker/periods/${periods[0].id}` : '/worker/periods';
  const timeCardHref = periods.length === 1 ? `/worker/periods/${periods[0].id}/hours` : '/worker/periods';
  const todayLabel = new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', { timeZone: 'Europe/Helsinki', weekday: 'long', day: 'numeric', month: 'long' }).format(today);
  const workerName = context ? `${context.employee.firstName} ${context.employee.lastName}` : null;
  const todayKey = today.toISOString().slice(0, 10);
  const activityDays = periods.flatMap((period) => period.activityDays.map((day) => ({ ...day, periodId: period.id })));

  // Rolling 7-calendar-day strip ending today, each day linking to its own hours page when an
  // actionable period's [startDate, endDate] covers that date — lets the worker see (and jump
  // into) a whole week of worked time from the clock screen itself, not just today's single entry.
  const WEEK_WINDOW_DAYS = 7;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const activityByDate = new Map(activityDays.map((day) => [day.date, day]));
  const dayLabelFormatter = new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', { timeZone: 'Europe/Helsinki', weekday: 'short', day: 'numeric' });
  const weekActivity =
    periods.length > 0
      ? {
          days: Array.from({ length: WEEK_WINDOW_DAYS }, (_, i) => {
            const date = new Date(today.getTime() - (WEEK_WINDOW_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10);
            const period = periods.find((p) => p.startDate <= date && date <= p.endDate) ?? null;
            return {
              date,
              label: dayLabelFormatter.format(new Date(`${date}T00:00:00.000Z`)),
              totalMinutes: activityByDate.get(date)?.totalMinutes ?? 0,
              isToday: date === todayKey,
              href: period ? `/worker/periods/${period.id}/hours/${date}` : null
            };
          }),
          totalMinutes: periods.reduce((sum, p) => sum + p.totalMinutes, 0)
        }
      : null;

  return (
    <main className="wk-page">
      <WorkerClockPanel
        initialClockState={clockState}
        assignments={assignments}
        workerName={workerName}
        todayLabel={todayLabel}
        weekActivity={weekActivity}
        periodsHref={periodsHref}
        historyHref="/worker/history"
        installHref="/worker/install"
        timeCardHref={timeCardHref}
      />
    </main>
  );
}
