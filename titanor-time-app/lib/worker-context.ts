import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';
import { computeDayWorkedMs, msToMinutes } from '@/lib/reporting/worked-time';
import { effectiveUnpaidBreakMinutes, DEFAULT_AUTO_UNPAID_BREAK_MINUTES } from '@/lib/reporting/auto-break';
import { DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES } from '@/lib/reporting/canonical-daily-buckets';
import { computeTimesheetEditCutoff } from '@/lib/timesheet-edit-window';
import { liveAssignmentWhere } from '@/lib/assignment-lifecycle';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §9 (Рабочий кабинет), read-only context
// endpoints — first sub-task's own `worker.read.own`/`assignment.read.own`/`period.read.own`
// slice. §9's own rule: "Все эндпоинты используют req.session.userId → User.employeeId;
// employeeId никогда не принимается из запроса" — every function here takes employeeId
// resolved by the caller from the session, never trusts a request parameter.

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface WorkerContext {
  employee: {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
  locale: string;
}

/** null employeeId => caller should surface 403 NO_EMPLOYEE_PROFILE (§9: "Доступ требует ... заполненный User.employeeId"). */
export async function getWorkerContext(userId: string, locale: string, employeeId: string | null): Promise<WorkerContext | null> {
  if (!employeeId) {
    return null;
  }
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, employeeNumber: true, firstName: true, lastName: true, phone: true }
  });
  if (!employee) {
    return null;
  }
  return { employee, locale };
}

export interface WorkerCurrentAssignment {
  id: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  templateVersionId: string | null;
  templateName: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  /** R15 fixroad F03 — the site is flagged "GPS often unavailable here" (informational only). */
  siteGpsOftenUnavailable: boolean;
}

/** Operationally-live SiteAssignments for this worker — what the app offers as Check-In options.
 *  R15-D7: `liveAssignmentWhere` (clockInDisabledAt-aware), shared with every other consumer. */
export async function listWorkerCurrentAssignments(employeeId: string, today: Date): Promise<WorkerCurrentAssignment[]> {
  const assignments = await prisma.siteAssignment.findMany({
    where: { employeeId, ...liveAssignmentWhere(new Date(), today) },
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
    select: {
      id: true,
      siteId: true,
      site: { select: { name: true, gpsOftenUnavailable: true } },
      workAreaId: true,
      workArea: { select: { name: true } },
      templateVersionId: true,
      templateVersion: { select: { template: { select: { name: true } } } },
      isPrimary: true,
      validFrom: true,
      validTo: true
    }
  });

  return assignments.map((a) => ({
    id: a.id,
    siteId: a.siteId,
    siteName: a.site.name,
    workAreaId: a.workAreaId,
    workAreaName: a.workArea?.name ?? null,
    templateVersionId: a.templateVersionId,
    templateName: a.templateVersion?.template.name ?? null,
    isPrimary: a.isPrimary,
    validFrom: formatDate(a.validFrom),
    validTo: a.validTo ? formatDate(a.validTo) : null,
    siteGpsOftenUnavailable: a.site.gpsOftenUnavailable
  }));
}

export interface WorkerPeriodSummary {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

/** The OPEN period (if any) whose date range contains `today` AND this employee has a Timesheet in — mirrors admin's getCurrentPeriod, scoped to one employee. */
export async function getWorkerCurrentPeriod(employeeId: string, today: Date): Promise<WorkerPeriodSummary | null> {
  const timesheet = await prisma.timesheet.findFirst({
    where: { employeeId, period: { status: 'OPEN', startDate: { lte: today }, endDate: { gte: today } } },
    select: { period: { select: { id: true, startDate: true, endDate: true, status: true } } }
  });
  return timesheet ? { id: timesheet.period.id, startDate: formatDate(timesheet.period.startDate), endDate: formatDate(timesheet.period.endDate), status: timesheet.period.status } : null;
}

export interface ActionablePeriod extends WorkerPeriodSummary {
  timesheetId: string;
  timesheetStatus: string;
  totalMinutes: number;
  workedDayCount: number;
  activityDays: WorkerPeriodActivityDay[];
  /** T12 — the instant the worker loses edit rights (periodEnd + grace @ cutoffTime), ISO. */
  editCutoff: string;
}

export interface WorkerPeriodActivityDay {
  date: string;
  totalMinutes: number;
  siteNames: string[];
}

const workerPeriodSelect = Prisma.validator<Prisma.TimesheetSelect>()({
  id: true,
  status: true,
  currentVersionId: true,
  period: { select: { id: true, startDate: true, endDate: true, status: true } },
  draft: {
    select: {
      id: true,
      timesheetDraftSegments: {
        select: {
          date: true,
          siteId: true,
          startAt: true,
          endAt: true,
          site: { select: { name: true } },
          breaks: { select: { startAt: true, endAt: true, paid: true } }
        }
      },
      plannedShifts: { select: { date: true, plannedBreakMinutes: true, plannedBreakPaid: true } }
    }
  },
  currentVersion: {
    select: {
      versionNumber: true,
      submissionSource: true,
      workSegments: {
        select: {
          date: true,
          siteId: true,
          startAt: true,
          endAt: true,
          site: { select: { name: true } },
          breaks: { select: { startAt: true, endAt: true, paid: true } }
        }
      },
      plannedShifts: { select: { date: true, plannedBreakMinutes: true, plannedBreakPaid: true } }
    }
  }
});

type WorkerPeriodRow = Prisma.TimesheetGetPayload<{ select: typeof workerPeriodSelect }>;

export interface WorkerEditWindowPolicy {
  cutoffDaysAfterPeriodEnd: number;
  cutoffTime: Date;
  // T10-D — same inputs the admin card / reports use for the automatic unpaid lunch.
  autoUnpaidBreakThresholdMinutes: number;
  autoUnpaidBreakMinutes: number;
}

async function loadWorkerEditWindowPolicy(): Promise<WorkerEditWindowPolicy> {
  const p = await prisma.companyAttendancePolicy.findFirst({
    select: { cutoffDaysAfterPeriodEnd: true, cutoffTime: true, autoUnpaidBreakThresholdMinutes: true, autoUnpaidBreakMinutes: true }
  });
  return {
    cutoffDaysAfterPeriodEnd: p?.cutoffDaysAfterPeriodEnd ?? 1,
    cutoffTime: p?.cutoffTime ?? new Date('1970-01-01T23:59:00.000Z'),
    autoUnpaidBreakThresholdMinutes: p?.autoUnpaidBreakThresholdMinutes ?? DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES,
    autoUnpaidBreakMinutes: p?.autoUnpaidBreakMinutes ?? DEFAULT_AUTO_UNPAID_BREAK_MINUTES
  };
}

function mapWorkerPeriod(row: WorkerPeriodRow, policy: WorkerEditWindowPolicy): ActionablePeriod {
  const source = resolveCanonicalSource({
    id: row.id,
    status: row.status,
    currentVersionId: row.currentVersionId,
    draft: row.draft,
    currentVersion: row.currentVersion
  });
  const segments = source.dataSource === 'DRAFT' ? row.draft!.timesheetDraftSegments : row.currentVersion!.workSegments;
  const plannedShifts = source.dataSource === 'DRAFT' ? (row.draft?.plannedShifts ?? []) : (row.currentVersion?.plannedShifts ?? []);

  // T10-D — planned UNPAID lunch minutes per date, same precedence as lib/reporting/auto-break.ts.
  const plannedUnpaidByDate = new Map<string, number>();
  for (const ps of plannedShifts) {
    const unpaid = effectiveUnpaidBreakMinutes(ps.plannedBreakMinutes, ps.plannedBreakPaid, policy.autoUnpaidBreakMinutes);
    plannedUnpaidByDate.set(formatDate(ps.date), Math.max(plannedUnpaidByDate.get(formatDate(ps.date)) ?? 0, unpaid));
  }

  // One bucket per calendar day (across sites) — the automatic unpaid lunch is a per-DAY deduction,
  // matching getTimesheetCard.
  const days = new Map<string, { segments: typeof segments; siteNames: Set<string> }>();
  for (const segment of segments) {
    const date = formatDate(segment.date);
    const day = days.get(date) ?? { segments: [] as typeof segments, siteNames: new Set<string>() };
    day.segments.push(segment);
    day.siteNames.add(segment.site.name);
    days.set(date, day);
  }

  const activityDays = [...days.entries()]
    .map(([date, day]) => {
      const worked = computeDayWorkedMs(day.segments, {
        plannedUnpaidBreakMinutes: plannedUnpaidByDate.get(date) ?? 0,
        grossThresholdMinutes: policy.autoUnpaidBreakThresholdMinutes
      });
      return { date, totalMinutes: msToMinutes(worked.workedMs), siteNames: [...day.siteNames].sort((a, b) => a.localeCompare(b)) };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    id: row.period.id,
    startDate: formatDate(row.period.startDate),
    endDate: formatDate(row.period.endDate),
    status: row.period.status,
    timesheetId: row.id,
    timesheetStatus: row.status,
    totalMinutes: activityDays.reduce((sum, day) => sum + day.totalMinutes, 0),
    workedDayCount: activityDays.length,
    activityDays,
    editCutoff: computeTimesheetEditCutoff(row.period.endDate, policy).toISOString()
  };
}

/**
 * Actionable = PayrollPeriodParticipant.expected=true + PayrollPeriod.status=OPEN +
 * Timesheet.status != FINAL_APPROVED (04_...§9). (periodId, employeeId) uniquely determines
 * both the Participant and the Timesheet, so querying Timesheet with a `participant.expected`
 * filter captures all three conditions in one query.
 */
export async function listActionablePeriods(employeeId: string): Promise<ActionablePeriod[]> {
  const timesheets = await prisma.timesheet.findMany({
    where: {
      employeeId,
      status: { not: 'FINAL_APPROVED' },
      period: { status: 'OPEN' },
      participant: { expected: true }
    },
    orderBy: { period: { startDate: 'asc' } },
    select: workerPeriodSelect
  });

  const policy = await loadWorkerEditWindowPolicy();
  return timesheets.map((r) => mapWorkerPeriod(r, policy));
}

/**
 * All of the employee's timesheets, any status, any period status — 01_SCREEN_MAP.md §3
 * `/worker/history` ("не только actionable"). Same shape as ActionablePeriod so the period/
 * hours/submit detail pages can resolve a period by this broader lookup too (needed once a
 * timesheet reaches FINAL_APPROVED and drops out of "actionable" — history still needs to open
 * it, read-only, via the same pages).
 */
export async function listWorkerTimesheets(employeeId: string): Promise<ActionablePeriod[]> {
  const timesheets = await prisma.timesheet.findMany({
    where: { employeeId },
    orderBy: { period: { startDate: 'desc' } },
    select: workerPeriodSelect
  });

  const policy = await loadWorkerEditWindowPolicy();
  return timesheets.map((r) => mapWorkerPeriod(r, policy));
}
