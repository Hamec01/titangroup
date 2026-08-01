import { prisma } from '@/lib/prisma';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 (GET /api/admin/workers) —
// shared by the API route and the /admin/workers Server Component page, same
// pattern as lib/setup-status.ts.

export interface WorkerListItem {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  active: boolean;
  currentAssignments: { siteId: string; siteName: string; isPrimary: boolean }[];
}

export interface WorkerListResult {
  items: WorkerListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * Calendar date "today" in Europe/Helsinki, as a UTC-midnight Date usable
 * against `@db.Date` columns. Project-wide convention per
 * 03_DATA_MODEL_ERD.md (date fields are Europe/Helsinki calendar days, not
 * host-local or UTC) — the host running this code is not guaranteed to be in
 * that timezone (see IMPLEMENTATION_STATUS.md §10 for a past incident caused
 * by assuming otherwise).
 */
function helsinkiToday(): Date {
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  return new Date(`${isoDate}T00:00:00.000Z`);
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
        employments: { where: { active: true }, select: { id: true }, take: 1 },
        siteAssignments: {
          where: {
            validFrom: { lte: today },
            OR: [{ validTo: null }, { validTo: { gte: today } }]
          },
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
    active: employee.employments.length > 0,
    currentAssignments: employee.siteAssignments.map((assignment) => ({
      siteId: assignment.site.id,
      siteName: assignment.site.name,
      isPrimary: assignment.isPrimary
    }))
  }));

  return {
    items,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}
