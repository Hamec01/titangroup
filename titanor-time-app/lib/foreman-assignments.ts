import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.4 (ForemanAssignment) — contract
// for the endpoints here is NOT in 04_ADMIN_FIRST_API_CONTRACTS.md (only the
// FOREMAN's own /foreman/* review workflow is documented, explicitly out of
// scope); designed by extension from the assignment.* pattern and confirmed
// by the owner (PROJECT_ROADMAP.md T6.9).

export interface CreateForemanAssignmentInput {
  foremanUserId: string;
  siteId: string;
  isSubstitute: boolean;
  validFrom: Date;
  validTo: Date | null;
  assignedByUserId: string;
  requestId: string;
}

export type CreateForemanAssignmentError =
  | { code: 'FOREMAN_NOT_FOUND' }
  | { code: 'SITE_NOT_FOUND' }
  | { code: 'USER_NOT_FOREMAN' }
  | { code: 'FOREMAN_NOT_ELIGIBLE' };

export interface ForemanAssignmentResult {
  id: string;
  foremanUserId: string;
  siteId: string;
  isSubstitute: boolean;
  validFrom: string;
  validTo: string | null;
  assignedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * No overlap check here, unlike assignment.create — 03_DATA_MODEL_ERD.md §4.4
 * deliberately has no EXCLUDE/uniqueness on ForemanAssignment (multiple rows
 * per site are allowed: primary + substitute via isSubstitute, and the ERD
 * doesn't even dedupe the same foreman+site twice). The two real business
 * checks — same rules listAssignableForemen() below filters its select by,
 * so a picked candidate never gets rejected here, but a direct API call with
 * an arbitrary UUID is still fully re-verified server-side — are: the User's
 * status must be PENDING_ACTIVATION or ACTIVE (OFFBOARDING/DEACTIVATED are
 * rejected even if a FOREMAN UserRole row is still present — nothing
 * currently revokes it on status change), and it must currently hold the
 * FOREMAN role (`validFrom <= now AND (validTo IS NULL OR validTo > now)` —
 * neither a not-yet-started nor an already-ended role counts).
 * PENDING_ACTIVATION is deliberately allowed: a foreman can be assigned to a
 * site before finishing their own account activation.
 */
export async function createForemanAssignment(
  input: CreateForemanAssignmentInput
): Promise<ForemanAssignmentResult | CreateForemanAssignmentError> {
  const foreman = await prisma.user.findUnique({ where: { id: input.foremanUserId }, select: { id: true, status: true } });
  if (!foreman) {
    return { code: 'FOREMAN_NOT_FOUND' };
  }

  const site = await prisma.workSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) {
    return { code: 'SITE_NOT_FOUND' };
  }

  if (foreman.status !== 'PENDING_ACTIVATION' && foreman.status !== 'ACTIVE') {
    return { code: 'FOREMAN_NOT_ELIGIBLE' };
  }

  const now = new Date();
  const currentForemanRole = await prisma.userRole.findFirst({
    where: {
      userId: input.foremanUserId,
      role: { name: 'FOREMAN' },
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gt: now } }]
    },
    select: { id: true }
  });
  if (!currentForemanRole) {
    return { code: 'USER_NOT_FOREMAN' };
  }

  const created = await prisma.$transaction(async (tx) => {
    const assignment = await tx.foremanAssignment.create({
      data: {
        foremanUserId: input.foremanUserId,
        siteId: input.siteId,
        isSubstitute: input.isSubstitute,
        validFrom: input.validFrom,
        validTo: input.validTo,
        assignedByUserId: input.assignedByUserId
      }
    });

    await createAuditEvent(tx, {
      actorUserId: input.assignedByUserId,
      eventType: 'FOREMAN_ASSIGNMENT_CREATED',
      entityType: 'FOREMAN_ASSIGNMENT',
      entityId: assignment.id,
      requestId: input.requestId,
      beforeValue: null,
      afterValue: {
        id: assignment.id,
        foremanUserId: assignment.foremanUserId,
        siteId: assignment.siteId,
        isSubstitute: assignment.isSubstitute,
        validFrom: formatDate(assignment.validFrom),
        validTo: assignment.validTo ? formatDate(assignment.validTo) : null
      }
    });

    return assignment;
  });

  return {
    id: created.id,
    foremanUserId: created.foremanUserId,
    siteId: created.siteId,
    isSubstitute: created.isSubstitute,
    validFrom: formatDate(created.validFrom),
    validTo: created.validTo ? formatDate(created.validTo) : null,
    assignedByUserId: created.assignedByUserId,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString()
  };
}

export interface ForemanAssignmentListItem {
  id: string;
  foremanUserId: string;
  foremanUsername: string;
  siteId: string;
  siteName: string;
  isSubstitute: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface ForemanAssignmentListResult {
  items: ForemanAssignmentListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * All foreman assignments (past/current/future), not just currently-valid
 * ones — foreman_assignment.read.all implies full visibility, same as GET
 * /api/admin/workers and GET /api/admin/assignments. page/pageSize only, no
 * search/sort/filter — not called out for this endpoint any more than for
 * GET /api/admin/assignments.
 */
export async function listForemanAssignments(page: number, pageSize: number): Promise<ForemanAssignmentListResult> {
  const [totalItems, assignments] = await Promise.all([
    prisma.foremanAssignment.count(),
    prisma.foremanAssignment.findMany({
      orderBy: { validFrom: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        isSubstitute: true,
        validFrom: true,
        validTo: true,
        foremanUser: { select: { id: true, username: true } },
        site: { select: { id: true, name: true } }
      }
    })
  ]);

  const items: ForemanAssignmentListItem[] = assignments.map((assignment) => ({
    id: assignment.id,
    foremanUserId: assignment.foremanUser.id,
    foremanUsername: assignment.foremanUser.username,
    siteId: assignment.site.id,
    siteName: assignment.site.name,
    isSubstitute: assignment.isSubstitute,
    validFrom: formatDate(assignment.validFrom),
    validTo: assignment.validTo ? formatDate(assignment.validTo) : null
  }));

  return {
    items,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}

export interface AssignableForemanEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

export interface AssignableForeman {
  id: string;
  username: string;
  status: string;
  employee: AssignableForemanEmployee | null;
}

function assignableForemanSortKey(foreman: AssignableForeman): string {
  return foreman.employee ? `${foreman.employee.lastName} ${foreman.employee.firstName}` : foreman.username;
}

/**
 * For the /admin/sites/:siteId foreman selector (ForemanAssignmentSection.tsx) — a Server
 * Component reads this directly (project convention: no internal fetch to the app's own API),
 * same pattern as lib/users.ts's listEmployeesForForemanSelect(). Same eligibility rules as
 * createForemanAssignment() above enforces server-side, so nothing shown here can be rejected
 * there for being ineligible — only for having since changed between page load and submit.
 * Excludes OFFBOARDING/DEACTIVATED, not-yet-started (validFrom > now) and already-ended
 * (validTo <= now) FOREMAN roles, and any User without a currently active FOREMAN role at all.
 * Sorted by the linked Employee's (lastName, firstName) when dual-role, otherwise by username —
 * standalone FOREMAN accounts are included in the same list, not filtered out.
 */
export async function listAssignableForemen(): Promise<AssignableForeman[]> {
  const now = new Date();
  const users = await prisma.user.findMany({
    where: {
      status: { in: ['PENDING_ACTIVATION', 'ACTIVE'] },
      userRoles: {
        some: {
          role: { name: 'FOREMAN' },
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }]
        }
      }
    },
    select: {
      id: true,
      username: true,
      status: true,
      employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true } }
    }
  });

  const foremen: AssignableForeman[] = users.map((user) => ({
    id: user.id,
    username: user.username,
    status: user.status,
    employee: user.employee
  }));

  return foremen.sort((a, b) => assignableForemanSortKey(a).localeCompare(assignableForemanSortKey(b)) || a.username.localeCompare(b.username));
}
