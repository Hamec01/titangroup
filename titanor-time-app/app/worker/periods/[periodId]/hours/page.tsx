import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listActionablePeriods } from '@/lib/worker-context';
import { getWorkerTimesheetDraft, getWorkerTimesheetCurrentVersion, type SegmentView } from '@/lib/worker-timesheets';
import { prisma } from '@/lib/prisma';

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
  const periods = await listActionablePeriods(employeeId);
  const period = periods.find((p) => p.id === periodId);

  if (!period) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>This period is not available to you.</p>
          <Link href="/worker/periods" className="wk-back-link">
            Back to your periods
          </Link>
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

  return (
    <main className="wk-page">
      <div className="wk-card">
        <Link href={`/worker/periods/${periodId}`} className="wk-back-link">
          ← {period.startDate} – {period.endDate}
        </Link>
        <h1>Hours</h1>
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
                    <Link href={`/worker/periods/${periodId}/hours/${day.date}`} className="wk-day-item">
                      {content}
                    </Link>
                  ) : (
                    <div className="wk-day-item wk-day-item-readonly">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {editable && (
          <Link href={`/worker/periods/${periodId}/submit`} className="wk-action-button">
            Review and submit
          </Link>
        )}
      </div>
    </main>
  );
}
