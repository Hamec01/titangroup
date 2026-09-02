import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { generateWorkerUsernameBase, reserveWorkerUsername } from '@/lib/worker-usernames';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 (worker endpoints) —
// shared by the API routes and the /admin/workers* Server Component pages,
// same pattern as lib/setup-status.ts.

export interface CurrentAssignment {
  /** SiteAssignment.id — the real React key (a worker can have two current assignments on the
   *  same site, one per work area) and the id passed to POST .../assignments/:id/end|change. */
  assignmentId: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  /** Template *id* (not the version id) — pre-selects the "Change site/zone" form's dropdown. */
  templateId: string | null;
  templateName: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface WorkerListItem {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  /** Login username — independent of employeeNumber (lib/worker-usernames.ts). */
  username: string;
  active: boolean;
  currentAssignments: CurrentAssignment[];
}

export interface WorkerListResult {
  items: WorkerListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  /**
   * Employees with no active Employment row ("archived" = deactivated). Hidden from the default
   * list; ?archived=1 shows everyone. There is no physical delete for Employee (Timesheet /
   * ClockEvent / AuditEvent history references it — T9_INTERNAL_TEST_PLAN.md §1); deactivate plus
   * this filter IS the archive, and POST .../reactivate brings a worker back.
   */
  archivedCount: number;
}

export type ActivationStatus = 'ALREADY_ACTIVE' | 'READY_FOR_ACTIVATION' | 'SETUP_INCOMPLETE';

export interface WorkerDetail {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  employment: {
    active: boolean;
    startDate: string;
    endDate: string | null;
    deactivationReason: string | null;
  } | null;
  currentAssignments: CurrentAssignment[];
  /** Assignments whose validTo is already in the past — shown in a collapsed "Past assignments"
   *  block so the card stays focused on where the worker is now. Newest end first, capped. */
  pastAssignments: CurrentAssignment[];
  activationStatus: ActivationStatus;
  /** Login username — independent of employeeNumber (lib/worker-usernames.ts). */
  username: string;
  /**
   * Pure `generateWorkerUsernameBase(firstName, lastName)` for the *current* name — cheap UI hint
   * only, not a DB-checked candidate. The UI shows "Generate friendly login" when `username`
   * doesn't start with this (covers both a still-numeric username and a stale base from a
   * since-renamed Employee); it does not claim `recommendedUsernameBase` itself is collision-free.
   */
  recommendedUsernameBase: string;
}

/**
 * Calendar date "today" in Europe/Helsinki, as a UTC-midnight Date usable
 * against `@db.Date` columns. Project-wide convention per
 * 03_DATA_MODEL_ERD.md (date fields are Europe/Helsinki calendar days, not
 * host-local or UTC) — the host running this code is not guaranteed to be in
 * that timezone (see IMPLEMENTATION_STATUS.md §10 for a past incident caused
 * by assuming otherwise).
 */
export function helsinkiToday(): Date {
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** SiteAssignment rows whose [validFrom, validTo] window covers `today` — "current" per 03_DATA_MODEL_ERD.md §4.4. */
function currentAssignmentWhere(today: Date) {
  return {
    validFrom: { lte: today },
    OR: [{ validTo: null }, { validTo: { gte: today } }]
  };
}

function mapAssignment(assignment: {
  id: string;
  isPrimary: boolean;
  validFrom: Date;
  validTo: Date | null;
  site: { id: string; name: string };
  workArea: { id: string; name: string } | null;
  templateVersion: { template: { id: string; name: string } } | null;
}): CurrentAssignment {
  return {
    assignmentId: assignment.id,
    siteId: assignment.site.id,
    siteName: assignment.site.name,
    workAreaId: assignment.workArea?.id ?? null,
    workAreaName: assignment.workArea?.name ?? null,
    templateId: assignment.templateVersion?.template.id ?? null,
    templateName: assignment.templateVersion?.template.name ?? null,
    isPrimary: assignment.isPrimary,
    validFrom: assignment.validFrom.toISOString().slice(0, 10),
    validTo: assignment.validTo ? assignment.validTo.toISOString().slice(0, 10) : null
  };
}

const CURRENT_ASSIGNMENT_SELECT = {
  id: true,
  isPrimary: true,
  validFrom: true,
  validTo: true,
  site: { select: { id: true, name: true } },
  workArea: { select: { id: true, name: true } },
  templateVersion: { select: { template: { select: { id: true, name: true } } } }
} as const;

/**
 * page/pageSize only — search/sort/filter from §0's general pagination
 * convention are out of scope for this task (PROJECT_ROADMAP.md T6.2: "Список
 * работников. Сначала read-only."). Sort order is fixed (lastName, firstName
 * ascending) rather than exposed as a param.
 */
export async function listWorkers(
  page: number,
  pageSize: number,
  options: { includeArchived?: boolean } = {}
): Promise<WorkerListResult> {
  const today = helsinkiToday();

  // Default: only workers with an active Employment. ?archived=1 drops the filter and shows
  // deactivated ("archived") workers too. Archived workers keep every row they ever had.
  const where: Prisma.EmployeeWhereInput = options.includeArchived
    ? {}
    : { employments: { some: { active: true } } };

  const [totalItems, archivedCount, employees] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.count({ where: { employments: { none: { active: true } } } }),
    prisma.employee.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        user: { select: { username: true } },
        employments: { where: { active: true }, select: { id: true }, take: 1 },
        siteAssignments: {
          where: currentAssignmentWhere(today),
          select: CURRENT_ASSIGNMENT_SELECT
        }
      }
    })
  ]);

  const items: WorkerListItem[] = employees.map((employee) => ({
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    username: employee.user?.username ?? '',
    active: employee.employments.length > 0,
    currentAssignments: employee.siteAssignments.map(mapAssignment)
  }));

  return {
    items,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
    archivedCount
  };
}

/**
 * activationStatus is computed, not stored — pending ActivationToken rows intentionally do not
 * change readiness because issuing a replacement revokes the previous live code.
 * Activation establishes account ownership and is intentionally independent of operational
 * setup. A newly-hired worker may install/sign in before an owner assigns a site or opens a
 * payroll period; the worker home renders that missing-setup state explicitly.
 */
async function computeActivationStatus(
  userStatus: string | undefined,
  employmentActive: boolean
): Promise<ActivationStatus> {
  if (userStatus === 'ACTIVE') {
    return 'ALREADY_ACTIVE';
  }
  if (userStatus !== 'PENDING_ACTIVATION' || !employmentActive) {
    return 'SETUP_INCOMPLETE';
  }
  return 'READY_FOR_ACTIVATION';
}

/** Returns null if no Employee with this id exists — callers map that to 404 WORKER_NOT_FOUND. */
export async function getWorkerDetail(employeeId: string): Promise<WorkerDetail | null> {
  const today = helsinkiToday();

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      phone: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { status: true, username: true } },
      // Registration (POST /api/admin/workers) creates exactly one Employment
      // row today — most-recent-first tolerates a future rehire flow that
      // adds a second row without this query needing to change.
      employments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { active: true, startDate: true, endDate: true, deactivationReason: true }
      },
      siteAssignments: {
        where: currentAssignmentWhere(today),
        select: CURRENT_ASSIGNMENT_SELECT
      }
    }
  });

  if (!employee) {
    return null;
  }

  const pastAssignmentRows = await prisma.siteAssignment.findMany({
    where: { employeeId, validTo: { lt: today } },
    orderBy: { validTo: 'desc' },
    take: 20,
    select: CURRENT_ASSIGNMENT_SELECT
  });

  const currentAssignments = employee.siteAssignments.map(mapAssignment);
  const pastAssignments = pastAssignmentRows.map(mapAssignment);
  const employment = employee.employments[0] ?? null;

  const activationStatus = await computeActivationStatus(
    employee.user?.status,
    employment?.active ?? false
  );

  return {
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    phone: employee.phone,
    version: employee.version,
    createdAt: employee.createdAt.toISOString(),
    updatedAt: employee.updatedAt.toISOString(),
    employment: employment
      ? {
          active: employment.active,
          startDate: employment.startDate.toISOString().slice(0, 10),
          endDate: employment.endDate ? employment.endDate.toISOString().slice(0, 10) : null,
          deactivationReason: employment.deactivationReason
        }
      : null,
    currentAssignments,
    pastAssignments,
    activationStatus,
    username: employee.user?.username ?? '',
    recommendedUsernameBase: generateWorkerUsernameBase(employee.firstName, employee.lastName)
  };
}

/**
 * The latest calendar day of *real* recorded or submitted time bound to each of these
 * assignments — WorkSegment (submitted) / TimesheetPlannedShift (submitted) / TimesheetDraftSegment
 * (entered hours) / ClockShiftFragment (clocked, not yet materialised). POST
 * /api/admin/assignments/:id/end cannot move validTo before this day (the admin adjusts the
 * timesheet first), so the worker card pre-fills its "End" form with it and the endpoint reports
 * it on a 409. Note this deliberately does NOT include TimesheetDraftPlannedShift — those are
 * just the auto-materialised schedule for the rest of the open period, and `/end` deletes the
 * ones after the end date so "end today" works. Assignments with no such row are absent.
 */
export async function latestBoundShiftDates(assignmentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (assignmentIds.length === 0) {
    return out;
  }
  const where = { sourceAssignmentId: { in: assignmentIds } };
  const grouped = await Promise.all([
    prisma.workSegment.groupBy({ by: ['sourceAssignmentId'], where, _max: { date: true } }),
    prisma.timesheetPlannedShift.groupBy({ by: ['sourceAssignmentId'], where, _max: { date: true } }),
    prisma.timesheetDraftSegment.groupBy({ by: ['sourceAssignmentId'], where, _max: { date: true } }),
    prisma.clockShiftFragment.groupBy({ by: ['sourceAssignmentId'], where, _max: { date: true } })
  ]);
  const latest = new Map<string, Date>();
  for (const row of grouped.flat()) {
    const day = row._max.date;
    // ClockShiftFragment.sourceAssignmentId is nullable (a fragment whose assignment is not yet
    // resolved) — those carry no "this assignment owns day X" fact, so skip them.
    if (!day || !row.sourceAssignmentId) {
      continue;
    }
    const prev = latest.get(row.sourceAssignmentId);
    if (!prev || day > prev) {
      latest.set(row.sourceAssignmentId, day);
    }
  }
  for (const [id, day] of latest) {
    out.set(id, day.toISOString().slice(0, 10));
  }
  return out;
}

/** Single-assignment form for POST /api/admin/assignments/:id/end's 409 body — see latestBoundShiftDates. */
export async function earliestAssignmentEndDate(assignmentId: string): Promise<string | null> {
  return (await latestBoundShiftDates([assignmentId])).get(assignmentId) ?? null;
}

/**
 * For each id, the date the worker card's "End" form should default to: the assignment's last
 * planned/recorded shift day when that is still in the future, otherwise today. Every input id is
 * present in the result. Ending exactly here never trips the dependents guard.
 */
export async function assignmentEndDateDefaults(assignmentIds: string[]): Promise<Map<string, string>> {
  const today = helsinkiToday().toISOString().slice(0, 10);
  const bound = await latestBoundShiftDates(assignmentIds);
  const out = new Map<string, string>();
  for (const id of assignmentIds) {
    const last = bound.get(id);
    out.set(id, last && last > today ? last : today);
  }
  return out;
}

export type RegenerateWorkerUsernameResult =
  | { code: 'WORKER_NOT_FOUND' }
  | { employeeId: string; previousUsername: string; username: string; changed: boolean };

/**
 * docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 — POST
 * /api/admin/workers/:employeeId/regenerate-username. Explicit, admin-triggered replacement of a
 * Worker's login username with the one lib/worker-usernames.ts would generate from their
 * *current* Employee.firstName/lastName — never run automatically by PATCH (firstName/lastName
 * edits) or by any migration. `SELECT "User" ... FOR UPDATE` on the target row makes a double
 * click / concurrent call safe: the second caller sees the already-updated username, recomputes
 * the same candidate, finds it already current, and returns changed:false without a second
 * AuditEvent — see reserveWorkerUsername's `excludeUserId` for why the check doesn't count the
 * target's own current row as a collision against itself. Only `User.username` is ever written
 * here — passwordHash, activation tokens, roles, sessions, and Employee.employeeId/employeeNumber
 * are untouched, so a currently-valid session (keyed by userId, docs/titanor-time/
 * 03_DATA_MODEL_ERD.md §4.1) and the existing password keep working under the new username.
 */
export async function regenerateWorkerUsername(employeeId: string, actorUserId: string, requestId: string): Promise<RegenerateWorkerUsernameResult> {
  return prisma.$transaction(async (tx) => {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { firstName: true, lastName: true, user: { select: { id: true } } }
    });
    if (!employee || !employee.user) {
      return { code: 'WORKER_NOT_FOUND' } as const;
    }
    const userId = employee.user.id;

    const lockedRows = await tx.$queryRaw<{ username: string }[]>`SELECT username FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    if (lockedRows.length === 0) {
      return { code: 'WORKER_NOT_FOUND' } as const;
    }
    const previousUsername = lockedRows[0].username;

    const base = generateWorkerUsernameBase(employee.firstName, employee.lastName);
    const candidate = await reserveWorkerUsername(tx, base, userId);

    if (candidate === previousUsername) {
      return { employeeId, previousUsername, username: previousUsername, changed: false };
    }

    await tx.user.update({ where: { id: userId }, data: { username: candidate } });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'WORKER_USERNAME_CHANGED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      requestId,
      beforeValue: { employeeId, previousUsername },
      afterValue: { employeeId, username: candidate }
    });

    return { employeeId, previousUsername, username: candidate, changed: true };
  });
}
