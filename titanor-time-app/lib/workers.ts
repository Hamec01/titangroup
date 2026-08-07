import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { generateWorkerUsernameBase, reserveWorkerUsername } from '@/lib/worker-usernames';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 (worker endpoints) —
// shared by the API routes and the /admin/workers* Server Component pages,
// same pattern as lib/setup-status.ts.

export interface CurrentAssignment {
  siteId: string;
  siteName: string;
  isPrimary: boolean;
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

function mapAssignment(assignment: { isPrimary: boolean; site: { id: string; name: string } }): CurrentAssignment {
  return {
    siteId: assignment.site.id,
    siteName: assignment.site.name,
    isPrimary: assignment.isPrimary
  };
}

/**
 * page/pageSize only — search/sort/filter from §0's general pagination
 * convention are out of scope for this task (PROJECT_ROADMAP.md T6.2: "Список
 * работников. Сначала read-only."). Sort order is fixed (lastName, firstName
 * ascending) rather than exposed as a param.
 */
export async function listWorkers(page: number, pageSize: number): Promise<WorkerListResult> {
  const today = helsinkiToday();

  const [totalItems, employees] = await Promise.all([
    prisma.employee.count(),
    prisma.employee.findMany({
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
          select: { isPrimary: true, site: { select: { id: true, name: true } } }
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
    totalPages: Math.ceil(totalItems / pageSize)
  };
}

/**
 * activationStatus is computed, not stored — pending ActivationToken rows intentionally do not
 * change readiness because issuing a replacement revokes the previous live code.
 * Mirrors the exact readiness condition 03_DATA_MODEL_ERD.md §4.1 documents
 * for issuing one: an active SiteAssignment + a PayrollPeriodParticipant
 * (expected=true) in an OPEN period — the same condition whose absence that
 * future endpoint reports as 403 SETUP_INCOMPLETE, reused here as a label.
 */
async function computeActivationStatus(
  employeeId: string,
  userStatus: string | undefined,
  employmentActive: boolean,
  hasCurrentAssignment: boolean
): Promise<ActivationStatus> {
  if (userStatus === 'ACTIVE') {
    return 'ALREADY_ACTIVE';
  }
  // A worker whose employment already ended can't be "ready for activation"
  // even if an old SiteAssignment's validTo is still null — deactivation
  // doesn't retract existing assignments (03_DATA_MODEL_ERD.md §4.2 only
  // blocks *new* ones), so hasCurrentAssignment alone isn't a safe signal
  // once employment is over. Found via manual testing, not spec'd
  // explicitly — SETUP_INCOMPLETE is the closest existing label, not a new one.
  if (userStatus !== 'PENDING_ACTIVATION' || !employmentActive || !hasCurrentAssignment) {
    return 'SETUP_INCOMPLETE';
  }
  const openParticipant = await prisma.payrollPeriodParticipant.findFirst({
    where: { employeeId, expected: true, period: { status: 'OPEN' } },
    select: { id: true }
  });
  return openParticipant ? 'READY_FOR_ACTIVATION' : 'SETUP_INCOMPLETE';
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
        select: { isPrimary: true, site: { select: { id: true, name: true } } }
      }
    }
  });

  if (!employee) {
    return null;
  }

  const currentAssignments = employee.siteAssignments.map(mapAssignment);
  const employment = employee.employments[0] ?? null;

  const activationStatus = await computeActivationStatus(
    employee.id,
    employee.user?.status,
    employment?.active ?? false,
    currentAssignments.length > 0
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
    activationStatus,
    username: employee.user?.username ?? '',
    recommendedUsernameBase: generateWorkerUsernameBase(employee.firstName, employee.lastName)
  };
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
