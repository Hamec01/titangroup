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

export type CreateForemanAssignmentError = { code: 'FOREMAN_NOT_FOUND' } | { code: 'SITE_NOT_FOUND' } | { code: 'USER_NOT_FOREMAN' };

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
 * doesn't even dedupe the same foreman+site twice). The one real business
 * check is that foremanUserId currently holds an active FOREMAN role
 * ("активная роль FOREMAN, проверяется в приложении" — ERD's own note that
 * this isn't a DB-level FK constraint).
 */
export async function createForemanAssignment(
  input: CreateForemanAssignmentInput
): Promise<ForemanAssignmentResult | CreateForemanAssignmentError> {
  const foreman = await prisma.user.findUnique({ where: { id: input.foremanUserId }, select: { id: true } });
  if (!foreman) {
    return { code: 'FOREMAN_NOT_FOUND' };
  }

  const site = await prisma.workSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) {
    return { code: 'SITE_NOT_FOUND' };
  }

  const activeForemanRole = await prisma.userRole.findFirst({
    where: { userId: input.foremanUserId, role: { name: 'FOREMAN' }, validTo: null },
    select: { id: true }
  });
  if (!activeForemanRole) {
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
