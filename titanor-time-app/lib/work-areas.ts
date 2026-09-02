import { prisma } from '@/lib/prisma';
import { helsinkiToday } from '@/lib/workers';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 (work-areas nested
// under a site) — shared by the API routes. Unlike lib/sites.ts's
// getSiteDetail() (unpaginated, embedded workAreas list for the detail
// page), this is the dedicated, paginated GET /api/admin/sites/:siteId/work-areas
// endpoint the contract also requires.

export interface WorkAreaListItem {
  id: string;
  name: string;
  active: boolean;
  version: number;
}

export interface WorkAreaListResult {
  items: WorkAreaListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export async function listWorkAreas(
  siteId: string,
  page: number,
  pageSize: number,
  active: boolean | undefined
): Promise<WorkAreaListResult> {
  const where = { siteId, ...(active !== undefined ? { active } : {}) };

  const [totalItems, areas] = await Promise.all([
    prisma.workArea.count({ where }),
    prisma.workArea.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, name: true, active: true, version: true }
    })
  ]);

  return {
    items: areas,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}

export interface WorkAreaWorker {
  employeeId: string;
  employeeNumber: string;
  name: string;
  isPrimary: boolean;
  templateName: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface WorkAreaDetail {
  id: string;
  name: string;
  active: boolean;
  version: number;
  site: { id: string; name: string };
  /** Workers whose assignment to this customer covers today (validTo compared with `gt` today,
   *  same admin-view "current" definition as the worker card — an assignment ended today has
   *  already moved the worker off). Primary assignments first, then by name. */
  currentWorkers: WorkAreaWorker[];
  /** Workers who were on this customer but whose assignment has ended. Newest end first, capped. */
  pastWorkers: WorkAreaWorker[];
}

/** The "click a customer → who's on it" view. Returns null for a nonexistent id → 404. */
export async function getWorkAreaDetail(workAreaId: string): Promise<WorkAreaDetail | null> {
  const today = helsinkiToday();

  const area = await prisma.workArea.findUnique({
    where: { id: workAreaId },
    select: { id: true, name: true, active: true, version: true, site: { select: { id: true, name: true } } }
  });
  if (!area) {
    return null;
  }

  const assignments = await prisma.siteAssignment.findMany({
    where: { workAreaId, employee: { employments: { some: { active: true } } } },
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'desc' }],
    select: {
      isPrimary: true,
      validFrom: true,
      validTo: true,
      employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true } },
      templateVersion: { select: { template: { select: { name: true } } } }
    }
  });

  const toWorker = (a: (typeof assignments)[number]): WorkAreaWorker => ({
    employeeId: a.employee.id,
    employeeNumber: a.employee.employeeNumber,
    name: `${a.employee.firstName} ${a.employee.lastName}`,
    isPrimary: a.isPrimary,
    templateName: a.templateVersion?.template.name ?? null,
    validFrom: a.validFrom.toISOString().slice(0, 10),
    validTo: a.validTo ? a.validTo.toISOString().slice(0, 10) : null
  });
  const isCurrent = (a: (typeof assignments)[number]) => a.validFrom <= today && (a.validTo === null || a.validTo > today);

  const past = assignments.filter((a) => !isCurrent(a));
  past.sort((x, y) => (y.validTo?.getTime() ?? 0) - (x.validTo?.getTime() ?? 0));

  return {
    id: area.id,
    name: area.name,
    active: area.active,
    version: area.version,
    site: area.site,
    currentWorkers: assignments.filter(isCurrent).map(toWorker),
    pastWorkers: past.slice(0, 30).map(toWorker)
  };
}
