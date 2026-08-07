import { prisma } from '@/lib/prisma';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 (Рабочие шаблоны) — shared by the API
// routes and the /admin/templates* Server Component pages, same pattern as lib/sites.ts.
// "Current version" is always the row with the highest versionNumber for a template — templates
// are append-only (POST creates version 1, a future PATCH would create version 2, etc.), so the
// latest row is fetched via orderBy+take:1 on the versions relation rather than a separate query
// per template (Prisma batches this into one additional query, not N+1).

export interface TemplateListItem {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  workingDaysCount: number;
}

export interface TemplateListResult {
  items: TemplateListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export async function listTemplates(page: number, pageSize: number): Promise<TemplateListResult> {
  const [totalItems, templates] = await Promise.all([
    prisma.workScheduleTemplate.count(),
    prisma.workScheduleTemplate.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        description: true,
        active: true,
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          select: {
            id: true,
            versionNumber: true,
            _count: { select: { days: { where: { isWorkingDay: true } } } }
          }
        }
      }
    })
  ]);

  const items: TemplateListItem[] = templates.map((template) => {
    const current = template.versions[0] as (typeof template.versions)[number] | undefined;
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      active: template.active,
      currentVersionId: current?.id ?? null,
      currentVersionNumber: current?.versionNumber ?? null,
      workingDaysCount: current?._count.days ?? 0
    };
  });

  return { items, page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}

export interface TemplateDetailDay {
  weekday: number;
  isWorkingDay: boolean;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  plannedBreakMinutes: number;
}

export interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  currentVersionId: string;
  currentVersionNumber: number;
  days: TemplateDetailDay[];
}

/** `WorkScheduleTemplateVersionDay.plannedStartTime`/`plannedEndTime` come back from Prisma as a Date on 1970-01-01 (the `@db.Time(0)` column) — mirrors parseTimeToDate in app/api/admin/templates/route.ts, read direction. */
function formatTimeOfDay(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  const hh = String(value.getUTCHours()).padStart(2, '0');
  const mm = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export async function getTemplateDetail(templateId: string): Promise<TemplateDetail | null> {
  const template = await prisma.workScheduleTemplate.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      name: true,
      description: true,
      active: true,
      versions: {
        orderBy: { versionNumber: 'desc' },
        take: 1,
        select: {
          id: true,
          versionNumber: true,
          days: {
            orderBy: { weekday: 'asc' },
            select: { weekday: true, isWorkingDay: true, plannedStartTime: true, plannedEndTime: true, plannedBreakMinutes: true }
          }
        }
      }
    }
  });

  const current = template?.versions[0];
  if (!template || !current) {
    return null;
  }

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    active: template.active,
    currentVersionId: current.id,
    currentVersionNumber: current.versionNumber,
    days: current.days.map((day) => ({
      weekday: day.weekday,
      isWorkingDay: day.isWorkingDay,
      plannedStartTime: formatTimeOfDay(day.plannedStartTime),
      plannedEndTime: formatTimeOfDay(day.plannedEndTime),
      plannedBreakMinutes: day.plannedBreakMinutes
    }))
  };
}
