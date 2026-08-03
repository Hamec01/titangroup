import { prisma } from '@/lib/prisma';
import { helsinkiToday } from '@/lib/workers';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 (Объекты) — shared by
// the API routes and the /admin/sites* Server Component pages, same pattern
// as lib/workers.ts.

export interface SiteListItem {
  id: string;
  name: string;
  cityId: string | null;
  active: boolean;
  activeAssignmentsCount: number;
  version: number;
}

export interface SiteListResult {
  items: SiteListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ListSitesFilters {
  search?: string;
  cityId?: string;
  active?: boolean;
  sort?: string;
}

const SORTABLE_FIELDS = new Set(['name', 'createdAt', 'active']);

/** `field:asc`/`field:desc` — falls back to `name:asc` for anything not in SORTABLE_FIELDS, rather than erroring, since sort is a convenience param, not a validated input contract. */
function parseSort(sort: string | undefined): { field: string; direction: 'asc' | 'desc' } {
  if (sort) {
    const [field, direction] = sort.split(':');
    if (SORTABLE_FIELDS.has(field) && (direction === 'asc' || direction === 'desc')) {
      return { field, direction };
    }
  }
  return { field: 'name', direction: 'asc' };
}

export async function listSites(page: number, pageSize: number, filters: ListSitesFilters): Promise<SiteListResult> {
  const today = helsinkiToday();
  const { field, direction } = parseSort(filters.sort);

  const where = {
    ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' as const } } : {}),
    ...(filters.cityId ? { cityId: filters.cityId } : {}),
    ...(filters.active !== undefined ? { active: filters.active } : {})
  };

  const [totalItems, sites] = await Promise.all([
    prisma.workSite.count({ where }),
    prisma.workSite.findMany({
      where,
      orderBy: { [field]: direction },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        cityId: true,
        active: true,
        version: true,
        siteAssignments: {
          where: { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
          select: { id: true }
        }
      }
    })
  ]);

  const items: SiteListItem[] = sites.map((site) => ({
    id: site.id,
    name: site.name,
    cityId: site.cityId,
    active: site.active,
    activeAssignmentsCount: site.siteAssignments.length,
    version: site.version
  }));

  return {
    items,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}

export interface SiteWorkArea {
  id: string;
  name: string;
  active: boolean;
  version: number;
}

export interface SiteActiveAssignment {
  employeeId: string;
  employeeName: string;
  isPrimary: boolean;
  workAreaId: string | null;
  workAreaName: string | null;
}

export interface SiteDetail {
  id: string;
  name: string;
  cityId: string | null;
  address: string | null;
  description: string | null;
  active: boolean;
  // Contract (04_...§3) specifies "foremanAssignments: []" here, but that
  // implies a real ForemanAssignment model, which doesn't exist in the
  // schema yet (that's T6.9's job). Returning a hardcoded empty array under
  // that name would be a decorative fake, not real data — so this exposes
  // the one foreman-related field that genuinely exists today instead.
  // Revisit once ForemanAssignment is built.
  defaultForemanUserId: string | null;
  defaultForemanUsername: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  workAreas: SiteWorkArea[];
  activeAssignments: SiteActiveAssignment[];
}

export async function getSiteDetail(siteId: string): Promise<SiteDetail | null> {
  const today = helsinkiToday();

  const site = await prisma.workSite.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      name: true,
      cityId: true,
      address: true,
      description: true,
      active: true,
      defaultForemanUserId: true,
      defaultForemanUser: { select: { username: true } },
      version: true,
      createdAt: true,
      updatedAt: true,
      workAreas: {
        orderBy: { name: 'asc' },
        select: { id: true, name: true, active: true, version: true }
      },
      siteAssignments: {
        where: { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
        select: {
          isPrimary: true,
          employee: { select: { id: true, firstName: true, lastName: true } },
          workArea: { select: { id: true, name: true } }
        }
      }
    }
  });

  if (!site) {
    return null;
  }

  return {
    id: site.id,
    name: site.name,
    cityId: site.cityId,
    address: site.address,
    description: site.description,
    active: site.active,
    defaultForemanUserId: site.defaultForemanUserId,
    defaultForemanUsername: site.defaultForemanUser?.username ?? null,
    version: site.version,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
    workAreas: site.workAreas,
    activeAssignments: site.siteAssignments.map((assignment) => ({
      employeeId: assignment.employee.id,
      employeeName: `${assignment.employee.firstName} ${assignment.employee.lastName}`,
      isPrimary: assignment.isPrimary,
      workAreaId: assignment.workArea?.id ?? null,
      workAreaName: assignment.workArea?.name ?? null
    }))
  };
}
