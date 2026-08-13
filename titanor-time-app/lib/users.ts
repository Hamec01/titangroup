import { Prisma, Locale } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.12 (`user.read`, `user.create.foreman`) +
// 03_DATA_MODEL_ERD.md §4.1 (`User`, `UserRole`) — minimal system-user administration backend
// slice. No UI, no credential/activation flow — this file only creates the User+UserRole rows
// (standalone FOREMAN) or grants FOREMAN to an existing Employee's User (dual-role). Getting a
// first password is out of scope here (owner-confirmed UserActivationToken schema checkpoint,
// commit 9320a9f) — not wired up by this file.

const LOOKUP_ROLE_NAMES = ['FOREMAN', 'ADMIN', 'SUPER_ADMIN'] as const;

export interface UserEmployeeSummary {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

export interface UserListItem {
  id: string;
  username: string;
  email: string | null;
  status: string;
  locale: string;
  roles: string[];
  employee: UserEmployeeSummary | null;
  createdAt: string;
}

export interface UserListFilters {
  page: number;
  pageSize: number;
  /** Only 'FOREMAN' is a meaningful value per the contract — anything else is treated as "no filter" by the route layer, not validated here. */
  role?: string;
}

export interface UserListResult {
  items: UserListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** validFrom <= now AND (validTo IS NULL OR validTo > now) — the exact "currently active" window from 04_...§ and 03_...§4.1's UserRole note. */
function activeRoleWhere(now: Date, roleNames: readonly string[]): Prisma.UserRoleWhereInput {
  return {
    role: { name: { in: [...roleNames] } },
    validFrom: { lte: now },
    OR: [{ validTo: null }, { validTo: { gt: now } }]
  };
}

/**
 * Without a role filter: every system user (FOREMAN/ADMIN/SUPER_ADMIN, any currently-active
 * combination, including dual-role FOREMAN+WORKER) — WORKER-only accounts are never included,
 * matching "не декоративный dashboard" scoping (this list is for administering system accounts,
 * not the worker roster, which already has /admin/workers). `roles` on each item is the user's
 * full currently-active role set, not just the one matched by the filter.
 */
export async function listUsers(filters: UserListFilters): Promise<UserListResult> {
  const now = new Date();
  const roleNamesForFilter = filters.role === 'FOREMAN' ? (['FOREMAN'] as const) : LOOKUP_ROLE_NAMES;

  const where: Prisma.UserWhereInput = {
    // T7A §13/§15 п.4 — the reserved SYSTEM actor (userKind=SYSTEM, username=system.scheduler)
    // must never appear in this admin-facing list. Explicit, not incidental: today it also has
    // no active role row so it's excluded either way, but that's not an independent guarantee —
    // this filter is the real one.
    userKind: 'HUMAN',
    userRoles: { some: activeRoleWhere(now, roleNamesForFilter) }
  };

  const [totalItems, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        username: true,
        email: true,
        status: true,
        locale: true,
        createdAt: true,
        employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true } },
        userRoles: {
          where: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
          select: { role: { select: { name: true } } }
        }
      }
    })
  ]);

  return {
    items: users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      status: u.status,
      locale: u.locale,
      roles: u.userRoles.map((ur) => ur.role.name),
      employee: u.employee ? { id: u.employee.id, employeeNumber: u.employee.employeeNumber, firstName: u.employee.firstName, lastName: u.employee.lastName } : null,
      createdAt: u.createdAt.toISOString()
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / filters.pageSize)
  };
}

export interface CreatedForemanUser {
  id: string;
  username: string;
  email: string | null;
  status: string;
  locale: string;
  roles: string[];
  employee: UserEmployeeSummary | null;
  createdAt: string;
}

export type CreateStandaloneForemanError = { code: 'DUPLICATE_USERNAME' } | { code: 'DUPLICATE_EMAIL' };

/**
 * Mode A ("STANDALONE"): a brand-new User with no Employee, PENDING_ACTIVATION, no passwordHash,
 * active FOREMAN role, all in one transaction with the USER_CREATED audit event. No
 * UserActivationToken is issued here (separate follow-up task, not this slice).
 */
export async function createStandaloneForeman(
  username: string,
  email: string | null,
  locale: Locale,
  actorUserId: string,
  requestId: string
): Promise<CreatedForemanUser | CreateStandaloneForemanError> {
  const outcome = await prisma.$transaction(async (tx) => {
    const foremanRole = await tx.role.findUniqueOrThrow({ where: { name: 'FOREMAN' } });

    let user;
    try {
      user = await tx.user.create({
        data: { username, email, status: 'PENDING_ACTIVATION', locale, passwordHash: null, employeeId: null }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = (error.meta?.target as string[] | undefined) ?? [];
        if (target.includes('username')) {
          return { code: 'DUPLICATE_USERNAME' as const };
        }
        if (target.includes('email')) {
          return { code: 'DUPLICATE_EMAIL' as const };
        }
      }
      throw error;
    }

    await tx.userRole.create({ data: { userId: user.id, roleId: foremanRole.id } });

    // afterValue never includes passwordHash (always null here anyway)/token/session/2FA data.
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'USER_CREATED',
      entityType: 'USER',
      entityId: user.id,
      requestId,
      beforeValue: null,
      afterValue: { id: user.id, username: user.username, email: user.email, status: user.status, roles: ['FOREMAN'] }
    });

    return {
      code: 'CREATED' as const,
      result: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        locale: user.locale,
        roles: ['FOREMAN'],
        employee: null,
        createdAt: user.createdAt.toISOString()
      }
    };
  });

  return outcome.code === 'CREATED' ? outcome.result : outcome;
}

export type GrantForemanError =
  | { code: 'EMPLOYEE_NOT_FOUND' }
  | { code: 'EMPLOYEE_USER_MISSING' }
  | { code: 'USER_NOT_ELIGIBLE' }
  | { code: 'USER_ALREADY_FOREMAN' };

/**
 * Mode B ("EXISTING_EMPLOYEE"): the Employee already has a User (created by
 * POST /api/admin/workers) — this never creates a second User (User.employeeId is unique).
 * Locks the Employee row first so two concurrent grant attempts for the same employee serialize
 * (the second sees the first's new active-or-scheduled UserRole and returns USER_ALREADY_FOREMAN,
 * not a bare P2002). A past (validTo <= now) FOREMAN UserRole does not block a new one — history
 * is preserved, not reused. PENDING_ACTIVATION and ACTIVE are both eligible; OFFBOARDING/
 * DEACTIVATED are not — this User status is not touched by this function either way. If
 * PENDING_ACTIVATION, the existing worker ActivationToken flow (unchanged) is still how they get
 * their first password; if ACTIVE, no token is needed.
 */
export async function grantForemanToExistingEmployee(employeeId: string, actorUserId: string, requestId: string): Promise<CreatedForemanUser | GrantForemanError> {
  const outcome = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    if (lockedRows.length === 0) {
      return { code: 'EMPLOYEE_NOT_FOUND' as const };
    }

    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        id: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            status: true,
            locale: true,
            createdAt: true,
            userRoles: { select: { validFrom: true, validTo: true, role: { select: { name: true } } } }
          }
        }
      }
    });

    if (!employee.user) {
      return { code: 'EMPLOYEE_USER_MISSING' as const };
    }
    const user = employee.user;

    if (user.status !== 'PENDING_ACTIVATION' && user.status !== 'ACTIVE') {
      return { code: 'USER_NOT_ELIGIBLE' as const };
    }

    const now = new Date();
    // "Not yet ended" — blocks a duplicate grant whether the existing FOREMAN role is currently
    // active (validFrom <= now) or scheduled to start later (validFrom > now); only a role that
    // has already ended (validTo <= now) lets a new grant through.
    const isUnended = (ur: { validTo: Date | null }) => ur.validTo === null || ur.validTo > now;
    // "Currently active" — additionally requires validFrom <= now; used only for the roles
    // reported back in the response, never for the duplicate guard above.
    const isCurrentlyActive = (ur: { validFrom: Date; validTo: Date | null }) => ur.validFrom <= now && isUnended(ur);

    if (user.userRoles.some((ur) => ur.role.name === 'FOREMAN' && isUnended(ur))) {
      return { code: 'USER_ALREADY_FOREMAN' as const };
    }

    const foremanRole = await tx.role.findUniqueOrThrow({ where: { name: 'FOREMAN' } });
    const newUserRole = await tx.userRole.create({ data: { userId: user.id, roleId: foremanRole.id } });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'FOREMAN_ROLE_GRANTED',
      entityType: 'USER_ROLE',
      entityId: newUserRole.id,
      requestId,
      beforeValue: null,
      afterValue: { userId: user.id, employeeId: employee.id, role: 'FOREMAN' }
    });

    const activeRoleNames = new Set(user.userRoles.filter(isCurrentlyActive).map((ur) => ur.role.name));
    activeRoleNames.add('FOREMAN');

    return {
      code: 'GRANTED' as const,
      result: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        locale: user.locale,
        roles: [...activeRoleNames],
        employee: { id: employee.id, employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName },
        createdAt: user.createdAt.toISOString()
      }
    };
  });

  return outcome.code === 'GRANTED' ? outcome.result : outcome;
}

export interface ForemanSelectableEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  userStatus: string | null;
}

/**
 * For the /admin/users/new "existing employee" select (app/admin/users/new/NewUserForm.tsx) — a
 * Server Component reads this directly (project convention: no internal fetch to the app's own
 * API). Deliberately does not filter by eligibility: an ineligible pick (already FOREMAN,
 * OFFBOARDING/DEACTIVATED, no linked User) is still shown and just gets the exact 409/404 the
 * POST /api/admin/users route already returns — no separate filtering logic to keep in sync.
 */
export async function listEmployeesForForemanSelect(): Promise<ForemanSelectableEmployee[]> {
  const employees = await prisma.employee.findMany({
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, employeeNumber: true, firstName: true, lastName: true, user: { select: { status: true } } }
  });

  return employees.map((employee) => ({
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    userStatus: employee.user?.status ?? null
  }));
}
