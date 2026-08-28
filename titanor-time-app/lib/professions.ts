import { Prisma, type ProfessionCategory } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// T13.2 — profession services shared by the admin API routes and the /admin/workers* Server
// Components. Route files only do HTTP/auth/CSRF/idempotency/validation mapping, same split as
// lib/employee-profile.ts / lib/assignments.ts.
//
// A profession is a trade / work speciality. It is NOT a certificate/qualification, grants no
// role or permission, does not authorise site work. See
// docs/titanor-time/T13_PROFESSIONS_WORKFORCE_REPORTS_TES_DESIGN.md.

const MAX_CUSTOM_NAME_LENGTH = 120;

/** lower + trim + collapse internal whitespace — so "Welder" / "  welder " / "WELDER" all map to
 *  the same value that ux_employee_profession_custom is unique on. */
export function normalizeProfessionName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const CATEGORIES: ProfessionCategory[] = ['SHIPBUILDING', 'CONSTRUCTION'];
export function isProfessionCategory(value: unknown): value is ProfessionCategory {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value);
}

export interface ProfessionCatalogEntry {
  id: string;
  code: string;
  category: ProfessionCategory;
  nameEn: string;
  nameRu: string;
}

export interface ProfessionCatalogGroup {
  category: ProfessionCategory;
  professions: ProfessionCatalogEntry[];
}

/** Active catalog professions, grouped by category, each group sorted by sortOrder then nameEn. */
export async function listProfessionCatalog(): Promise<ProfessionCatalogGroup[]> {
  const rows = await prisma.professionDefinition.findMany({
    where: { isActive: true },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { nameEn: 'asc' }],
    select: { id: true, code: true, category: true, nameEn: true, nameRu: true }
  });
  return CATEGORIES.map((category) => ({
    category,
    professions: rows.filter((r) => r.category === category)
  })).filter((g) => g.professions.length > 0);
}

export interface EmployeeProfessionView {
  id: string;
  definitionId: string | null;
  code: string | null;
  category: ProfessionCategory;
  nameEn: string;
  nameRu: string | null;
  isCustom: boolean;
  createdAt: string;
}

/** A worker's professions, catalog and custom, newest first. `nameEn`/`category` are the catalog
 *  snapshot for a catalog row, or the custom values for a custom row; `nameRu` is null for custom. */
export async function listEmployeeProfessions(employeeId: string): Promise<EmployeeProfessionView[]> {
  const rows = await prisma.employeeProfession.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      definitionId: true,
      customName: true,
      customCategory: true,
      createdAt: true,
      definition: { select: { code: true, category: true, nameEn: true, nameRu: true } }
    }
  });
  return rows.map((r) => {
    if (r.definition) {
      return {
        id: r.id,
        definitionId: r.definitionId,
        code: r.definition.code,
        category: r.definition.category,
        nameEn: r.definition.nameEn,
        nameRu: r.definition.nameRu,
        isCustom: false,
        createdAt: r.createdAt.toISOString()
      };
    }
    return {
      id: r.id,
      definitionId: null,
      code: null,
      category: r.customCategory as ProfessionCategory,
      nameEn: r.customName ?? '',
      nameRu: null,
      isCustom: true,
      createdAt: r.createdAt.toISOString()
    };
  });
}

export type AddProfessionInput =
  | { employeeId: string; definitionId: string; actorUserId: string; requestId: string }
  | { employeeId: string; customName: string; customCategory: ProfessionCategory; actorUserId: string; requestId: string };

export type AddProfessionResult =
  | { ok: true; id: string }
  | { ok: false; code: 'EMPLOYEE_NOT_FOUND' | 'DEFINITION_NOT_FOUND' | 'ALREADY_ADDED' }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23505') || message.includes('ux_employee_profession_');
}

/** Adds one profession to a worker. Catalog (`definitionId`) XOR custom (`customName` +
 *  `customCategory`). The two partial unique indexes are the race-safe guarantee — a double-submit
 *  that passes the pre-check still hits 23505, caught here as ALREADY_ADDED (409). */
export async function addEmployeeProfession(input: AddProfessionInput): Promise<AddProfessionResult> {
  const employee = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } });
  if (!employee) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' };

  let data: Prisma.EmployeeProfessionUncheckedCreateInput;
  let auditAfter: Record<string, unknown>;

  if ('definitionId' in input) {
    const definition = await prisma.professionDefinition.findFirst({
      where: { id: input.definitionId, isActive: true },
      select: { id: true, code: true, category: true }
    });
    if (!definition) return { ok: false, code: 'DEFINITION_NOT_FOUND' };
    data = { employeeId: input.employeeId, definitionId: definition.id, createdByUserId: input.actorUserId };
    auditAfter = { professionCode: definition.code, category: definition.category };
  } else {
    // Collapse internal whitespace in the display name too (keep case) — "Rope Access  Technician"
    // stored as "Rope Access Technician". customNameNormalized additionally lowercases.
    const displayName = input.customName.trim().replace(/\s+/g, ' ');
    const fieldErrors: Record<string, string[]> = {};
    if (displayName.length === 0) fieldErrors.customName = ['required'];
    else if (displayName.length > MAX_CUSTOM_NAME_LENGTH) fieldErrors.customName = [`must be ${MAX_CUSTOM_NAME_LENGTH} characters or fewer`];
    if (!isProfessionCategory(input.customCategory)) fieldErrors.customCategory = ['must be SHIPBUILDING or CONSTRUCTION'];
    if (Object.keys(fieldErrors).length > 0) return { ok: false, code: 'VALIDATION_ERROR', fieldErrors };

    const normalized = normalizeProfessionName(displayName);
    data = {
      employeeId: input.employeeId,
      customName: displayName,
      customNameNormalized: normalized,
      customCategory: input.customCategory,
      createdByUserId: input.actorUserId
    };
    auditAfter = { customNameNormalized: normalized, category: input.customCategory };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.employeeProfession.create({ data });
      await createAuditEvent(tx, {
        actorUserId: input.actorUserId,
        eventType: 'EMPLOYEE_PROFESSION_ADDED',
        entityType: 'EMPLOYEE_PROFESSION',
        entityId: created.id,
        requestId: input.requestId,
        beforeValue: null,
        afterValue: { employeeId: input.employeeId, ...auditAfter }
      });
      return { ok: true as const, id: created.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: 'ALREADY_ADDED' };
    throw error;
  }
}

export type RemoveProfessionResult = { ok: true } | { ok: false; code: 'NOT_FOUND' };

/** `employeeId` is the path param — always checked against the row's actual owner. */
export async function removeEmployeeProfession(input: { employeeProfessionId: string; employeeId: string; actorUserId: string; requestId: string }): Promise<RemoveProfessionResult> {
  const row = await prisma.employeeProfession.findUnique({
    where: { id: input.employeeProfessionId },
    select: { id: true, employeeId: true, definitionId: true, customNameNormalized: true, customCategory: true, definition: { select: { code: true, category: true } } }
  });
  if (!row || row.employeeId !== input.employeeId) return { ok: false, code: 'NOT_FOUND' };

  await prisma.$transaction(async (tx) => {
    await tx.employeeProfession.delete({ where: { id: row.id } });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'EMPLOYEE_PROFESSION_REMOVED',
      entityType: 'EMPLOYEE_PROFESSION',
      entityId: row.id,
      requestId: input.requestId,
      beforeValue: {
        employeeId: input.employeeId,
        professionCode: row.definition?.code ?? null,
        customNameNormalized: row.customNameNormalized,
        category: row.definition?.category ?? row.customCategory
      },
      afterValue: null
    });
  });
  return { ok: true };
}
