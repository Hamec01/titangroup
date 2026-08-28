import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets } from '@/lib/worker-context';
import { getWorkerTimesheetDraft, getWorkerTimesheetCurrentVersion, getWorkerTimesheetSummary, type SegmentView } from '@/lib/worker-timesheets';
import { prisma } from '@/lib/prisma';
import { ReturnReasonsNotice } from '../ReturnReasonsNotice';
import { ReopenForEditsButton } from '../ReopenForEditsButton';
import { AdminCorrectionNotice } from '../AdminCorrectionNotice';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import type { HoursListPayload } from '@/lib/offline-outbox/read-snapshots';
import { workedMinutesFromIsoSegments, workedDayMinutesFromIso } from '@/lib/reporting/report-format';
import { effectiveUnpaidBreakMinutes, loadAutoUnpaidBreakDefaultMinutes } from '@/lib/reporting/auto-break';
import { resolveAppLocale } from '@/lib/i18n/server';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS, dayTypeLabel } from '@/lib/i18n/worker';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods/[periodId]/hours` — the day list. Which
// source backs it depends on the timesheet's own status, not a client choice: DRAFT/RETURNED reads
// the mutable draft (day rows link to the editor); SUBMITTED/FOREMAN_APPROVED reads the frozen
// current-version read-only (04_...§9 — draft is physically emptied by submit, current-version is
// what exists instead). DoD: no edit affordance is rendered at all once the timesheet isn't
// editable, matching PATCH .../days/:date's own 409 DRAFT_NOT_EDITABLE guard.
const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

function localeTag(locale: 'EN' | 'RU'): string {
  return locale === 'RU' ? 'ru-RU' : 'en-GB';
}

function formatDayLabel(date: string, locale: 'EN' | 'RU'): string {
  return new Intl.DateTimeFormat(localeTag(locale), { timeZone: 'Europe/Helsinki', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${date}T00:00:00.000Z`));
}

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

type RouteParams = { params: Promise<{ periodId: string }> };

export default async function WorkerHoursListPage({ params }: RouteParams) {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const common = COMMON_STRINGS[locale];
  const t = WORKER_STRINGS[locale];
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
          <p>{t.periodNotAvailable}</p>
          <WorkerLink href="/worker/periods" className="wk-back-link">
            {common.backToYourPeriods}
          </WorkerLink>
        </div>
      </main>
    );
  }

  const editable = EDITABLE_STATUSES.has(period.timesheetStatus);
  const periodStatus = period.timesheetStatus;
  // T12 — the worker still owns the timesheet while the period is OPEN and now is before the cutoff,
  // even after they tapped "Отправить". A non-draft one just needs a one-tap reopen first.
  const withinEditWindow = period.status === 'OPEN' && Date.now() < new Date(period.editCutoff).getTime();
  const canReopen = withinEditWindow && !editable;

  let days: { date: string; dayType: string; confirmedZero: boolean; segments: SegmentView[] }[];
  let plannedShifts: { date: string; plannedBreakMinutes: number; plannedBreakPaid: boolean }[] = [];
  if (editable) {
    const draft = await getWorkerTimesheetDraft(employeeId, period.timesheetId);
    days = 'code' in draft ? [] : draft.days;
    plannedShifts = 'code' in draft ? [] : draft.plannedShifts;
  } else {
    const version = await getWorkerTimesheetCurrentVersion(employeeId, period.timesheetId);
    days = 'code' in version ? [] : version.days;
    plannedShifts = 'code' in version ? [] : version.plannedShifts;
  }
  // T10-D — planned UNPAID lunch minutes per date. Same precedence the admin card / reports use
  // (lib/reporting/auto-break.ts): a paid break contributes 0, a template break its own minutes,
  // and an assignment with no template break falls back to the company default. The worker sees the
  // same auto-deducted hours the admin does ("работник тоже должен видеть что обед не оплачивается").
  const autoUnpaidDefault = await loadAutoUnpaidBreakDefaultMinutes();
  const plannedUnpaidByDate = new Map<string, number>();
  for (const ps of plannedShifts) {
    const unpaid = effectiveUnpaidBreakMinutes(ps.plannedBreakMinutes, ps.plannedBreakPaid, autoUnpaidDefault);
    plannedUnpaidByDate.set(ps.date, Math.max(plannedUnpaidByDate.get(ps.date) ?? 0, unpaid));
  }
  const workedMinutesForDay = (day: { date: string; segments: SegmentView[] }): number =>
    workedDayMinutesFromIso(day.segments, plannedUnpaidByDate.get(day.date) ?? 0);
  const autoLunchForDay = (day: { date: string; segments: SegmentView[] }): number =>
    workedMinutesFromIsoSegments(day.segments) - workedMinutesForDay(day);

  const siteIds = [...new Set(days.flatMap((d) => d.segments.map((s) => s.siteId)))];
  const sites = siteIds.length > 0 ? await prisma.workSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : [];
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));

  const summary = await getWorkerTimesheetSummary(employeeId, period.timesheetId);
  const returnReasons = 'code' in summary ? [] : summary.returnReasons;
  const adminCorrection = 'code' in summary ? null : summary.adminCorrection;

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
      totalMinutes: workedMinutesForDay(day),
      siteNames: [...new Set(day.segments.map((s) => siteNameById.get(s.siteId) ?? s.siteId))]
    })),
    returnReasons: returnReasons.map((r) => ({ scopeType: r.scopeType, siteName: r.siteName, contextSiteName: r.contextSiteName, reason: r.reason, returnedAt: r.returnedAt }))
  };

  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const visibleDays = days
    .filter((day) => day.segments.length > 0 || day.confirmedZero || day.dayType !== 'WORK' || day.date === todayKey)
    .sort((a, b) => b.date.localeCompare(a.date));
  const emptyDays = days.filter((day) => !visibleDays.includes(day));

  function renderDay(day: (typeof days)[number]) {
    const minutes = workedMinutesForDay(day);
    const autoLunch = autoLunchForDay(day);
    const siteNames = [...new Set(day.segments.map((s) => siteNameById.get(s.siteId) ?? s.siteId))];
    const isToday = day.date === todayKey;
    const stateLabel = day.dayType !== 'WORK'
      ? dayTypeLabel(day.dayType, locale)
      : day.confirmedZero
        ? t.confirmedZeroShort
          : periodStatus === 'RETURNED'
          ? t.needsCorrection
          : editable
            ? t.draftState
            : t.readOnly;
    const content = (
      <article className={`wk-day-card${isToday ? ' is-today' : ''}`}>
        <div className="wk-day-card-top">
          <div>
            {isToday ? <span className="wk-day-today-badge">{t.today}</span> : null}
            <p className="wk-day-date">{formatDayLabel(day.date, locale)}</p>
            <p className="wk-day-iso">{day.date}</p>
          </div>
          <span className="wk-day-state">{stateLabel}</span>
        </div>

        {day.segments.length > 0 ? (
          <div className="wk-day-intervals">
            {day.segments.map((segment) => (
              <p key={segment.id} className="wk-day-interval-row">
                {formatClock(segment.startAt)} — {formatClock(segment.endAt)}
              </p>
            ))}
          </div>
        ) : (
          <p className="wk-day-summary">{day.dayType === 'WORK' ? t.dayEmptyDash : dayTypeLabel(day.dayType, locale)}</p>
        )}

        <div className="wk-day-card-bottom">
          <p className="wk-day-sites">{siteNames.length > 0 ? siteNames.join(' · ') : t.dayEmptyDash}</p>
          <strong>{formatMinutes(minutes)}</strong>
        </div>
        {autoLunch > 0 ? <p className="wk-readonly-note">{t.unpaidLunchDeducted(autoLunch)}</p> : null}
      </article>
    );
    return (
      <li key={day.date}>
        {editable ? (
          <WorkerLink href={`/worker/periods/${periodId}/hours/${day.date}`} className="wk-day-item">
            {content}
            <span className="wk-day-chevron" aria-hidden="true">›</span>
          </WorkerLink>
        ) : (
          <div className="wk-day-item wk-day-item-readonly">{content}</div>
        )}
      </li>
    );
  }

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <WorkerLink href={`/worker/periods/${periodId}`} className="wk-back-link">
          ← {period.startDate} – {period.endDate}
        </WorkerLink>
        <h1>{t.hours}</h1>
        <ReturnReasonsNotice status={period.timesheetStatus} reasons={returnReasons} />
        <AdminCorrectionNotice correction={adminCorrection} />
        {!editable && canReopen && (
          <div className="wk-return-notice" role="status">
            <p className="wk-return-reason-text">{t.weekOpenForEdits}</p>
            <ReopenForEditsButton timesheetId={period.timesheetId} label={t.makeChanges} />
          </div>
        )}
        {!editable && !canReopen && <p className="wk-readonly-note">{t.weekClosedWithManager}</p>}

        {days.length === 0 ? (
          <p className="wk-empty">{t.noDaysInPeriodYet}</p>
        ) : (
          <>
            <ul className="wk-day-list">{visibleDays.map(renderDay)}</ul>
            {emptyDays.length > 0 && (
              <details className="wk-empty-days">
                <summary>{t.chooseAnotherDate(emptyDays.length)}</summary>
                <ul className="wk-day-list">{emptyDays.map(renderDay)}</ul>
              </details>
            )}
          </>
        )}

        {editable && (
          <WorkerLink href={`/worker/periods/${periodId}/submit`} className="wk-action-button wk-submit-sticky-action">
            {t.reviewAndSubmit}
          </WorkerLink>
        )}
      </div>
      <SnapshotWriter routeKind="hours-list" ownerUserId={session.user.id} periodId={periodId} payload={snapshotPayload} />
    </main>
  );
}
