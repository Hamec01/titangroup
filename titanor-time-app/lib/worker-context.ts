import { prisma } from '@/lib/prisma';

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
}

/** SiteAssignment rows whose [validFrom, validTo] window covers `today` — same "current" definition as lib/workers.ts's currentAssignmentWhere. */
export async function listWorkerCurrentAssignments(employeeId: string, today: Date): Promise<WorkerCurrentAssignment[]> {
  const assignments = await prisma.siteAssignment.findMany({
    where: {
      employeeId,
      validFrom: { lte: today },
      OR: [{ validTo: null }, { validTo: { gte: today } }]
    },
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
    select: {
      id: true,
      siteId: true,
      site: { select: { name: true } },
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
    validTo: a.validTo ? formatDate(a.validTo) : null
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
    select: { id: true, status: true, period: { select: { id: true, startDate: true, endDate: true, status: true } } }
  });

  return timesheets.map((t) => ({
    id: t.period.id,
    startDate: formatDate(t.period.startDate),
    endDate: formatDate(t.period.endDate),
    status: t.period.status,
    timesheetId: t.id,
    timesheetStatus: t.status
  }));
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
    select: { id: true, status: true, period: { select: { id: true, startDate: true, endDate: true, status: true } } }
  });

  return timesheets.map((t) => ({
    id: t.period.id,
    startDate: formatDate(t.period.startDate),
    endDate: formatDate(t.period.endDate),
    status: t.period.status,
    timesheetId: t.id,
    timesheetStatus: t.status
  }));
}
