import { prisma } from '@/lib/prisma';

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
