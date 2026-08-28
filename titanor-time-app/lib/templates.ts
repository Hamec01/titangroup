import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 (Рабочие шаблоны) — shared by the API
// routes and the /admin/templates* Server Component pages, same pattern as lib/sites.ts.
// "Current version" is always the row with the highest versionNumber for a template — templates
// are append-only (POST creates version 1, PATCH creates version 2, 3, ...), so the latest row is
// fetched via orderBy+take:1 on the versions relation rather than a separate query per template
// (Prisma batches this into one additional query, not N+1).

export const TEMPLATE_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
export const TEMPLATE_MAX_NAME_LENGTH = 255;
export const TEMPLATE_MAX_DESCRIPTION_LENGTH = 2000;

export interface TemplateDayInput {
  weekday: number;
  isWorkingDay: boolean;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  plannedBreakMinutes: number;
  // T10-D — true = the customer pays the planned lunch (no auto-deduction). Default false = the
  // Finnish norm: a long worked day with no logged break has plannedBreakMinutes deducted.
  plannedBreakPaid: boolean;
}

/** "HH:MM" (or "HH:MM:SS") wall-clock string -> a Date on 1970-01-01 UTC, the same shape Prisma reads/writes for a `@db.Time(0)` column. Shared by POST (create version 1) and PATCH (create version N+1) — the day/time invariants must never diverge between them. */
export function parseTemplateTimeToDate(value: string): Date {
  const normalized = value.length === 5 ? `${value}:00` : value;
  return new Date(`1970-01-01T${normalized}Z`);
}

/** The reverse of parseTemplateTimeToDate — mirrors the read direction already used by getTemplateDetail. */
function formatTimeOfDay(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  const hh = String(value.getUTCHours()).padStart(2, '0');
  const mm = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * docs/titanor-time/03_DATA_MODEL_ERD.md §4.5 + 05_RAW_SQL_REGISTER.md CK-06/07/08 — the shape
 * rules below (working day needs both times + non-negative break; non-working day needs neither
 * time and a zero break) are enforced by real DB CHECK constraints on
 * WorkScheduleTemplateVersionDay. This re-validates the same shape up front purely to return a
 * clean 400 VALIDATION_ERROR instead of surfacing a raw 23514 constraint violation — shared by
 * POST and PATCH so the two routes can never drift onto different rules for the same table.
 */
export function validateTemplateDays(rawDays: unknown): { days: TemplateDayInput[] } | { error: string } {
  if (!Array.isArray(rawDays) || rawDays.length !== 7) {
    return { error: 'must be an array of exactly 7 entries' };
  }

  const days: TemplateDayInput[] = [];
  const seenWeekdays = new Set<number>();

  for (const raw of rawDays) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'each entry must be an object' };
    }
    const { weekday, isWorkingDay, plannedStartTime, plannedEndTime, plannedBreakMinutes, plannedBreakPaid } = raw as Record<string, unknown>;

    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: 'weekday must be an integer 0-6 (0=Mon..6=Sun)' };
    }
    if (seenWeekdays.has(weekday)) {
      return { error: `duplicate weekday ${weekday}` };
    }
    seenWeekdays.add(weekday);

    if (typeof isWorkingDay !== 'boolean') {
      return { error: 'isWorkingDay must be a boolean' };
    }
    if (typeof plannedBreakMinutes !== 'number' || !Number.isInteger(plannedBreakMinutes) || plannedBreakMinutes < 0) {
      return { error: 'plannedBreakMinutes must be a non-negative integer' };
    }
    // T10-D — optional; absent is treated as false (Finnish unpaid-lunch norm), so older clients
    // and existing callers keep working unchanged.
    if (plannedBreakPaid !== undefined && typeof plannedBreakPaid !== 'boolean') {
      return { error: `weekday ${weekday}: plannedBreakPaid must be a boolean` };
    }
    const breakPaid = plannedBreakPaid === true;

    if (isWorkingDay) {
      if (typeof plannedStartTime !== 'string' || !TEMPLATE_TIME_PATTERN.test(plannedStartTime)) {
        return { error: `weekday ${weekday}: plannedStartTime required (HH:MM) for a working day` };
      }
      if (typeof plannedEndTime !== 'string' || !TEMPLATE_TIME_PATTERN.test(plannedEndTime)) {
        return { error: `weekday ${weekday}: plannedEndTime required (HH:MM) for a working day` };
      }
      days.push({ weekday, isWorkingDay: true, plannedStartTime, plannedEndTime, plannedBreakMinutes, plannedBreakPaid: breakPaid });
    } else {
      if (plannedStartTime !== undefined && plannedStartTime !== null) {
        return { error: `weekday ${weekday}: plannedStartTime must be empty for a non-working day` };
      }
      if (plannedEndTime !== undefined && plannedEndTime !== null) {
        return { error: `weekday ${weekday}: plannedEndTime must be empty for a non-working day` };
      }
      if (plannedBreakMinutes !== 0) {
        return { error: `weekday ${weekday}: plannedBreakMinutes must be 0 for a non-working day` };
      }
      days.push({ weekday, isWorkingDay: false, plannedStartTime: null, plannedEndTime: null, plannedBreakMinutes: 0, plannedBreakPaid: false });
    }
  }

  if (seenWeekdays.size !== 7) {
    return { error: 'days must cover weekday 0-6 exactly once each' };
  }

  return { days };
}

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
  plannedBreakPaid: boolean;
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
            select: { weekday: true, isWorkingDay: true, plannedStartTime: true, plannedEndTime: true, plannedBreakMinutes: true, plannedBreakPaid: true }
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
      plannedBreakMinutes: day.plannedBreakMinutes,
      plannedBreakPaid: day.plannedBreakPaid
    }))
  };
}

/** True if `input` (already-validated request days) describes exactly the same 7 days as `existing` (current version's stored rows) — used to detect a genuine no-op PATCH that must not create a new version. */
function daysEqual(
  existing: { weekday: number; isWorkingDay: boolean; plannedStartTime: Date | null; plannedEndTime: Date | null; plannedBreakMinutes: number; plannedBreakPaid: boolean }[],
  input: TemplateDayInput[]
): boolean {
  if (existing.length !== input.length) {
    return false;
  }
  const existingByWeekday = new Map(existing.map((d) => [d.weekday, d]));
  for (const day of input) {
    const prior = existingByWeekday.get(day.weekday);
    if (!prior) {
      return false;
    }
    if (prior.isWorkingDay !== day.isWorkingDay || prior.plannedBreakMinutes !== day.plannedBreakMinutes || prior.plannedBreakPaid !== day.plannedBreakPaid) {
      return false;
    }
    const priorStart = prior.plannedStartTime?.getTime() ?? null;
    const newStart = day.plannedStartTime ? parseTemplateTimeToDate(day.plannedStartTime).getTime() : null;
    if (priorStart !== newStart) {
      return false;
    }
    const priorEnd = prior.plannedEndTime?.getTime() ?? null;
    const newEnd = day.plannedEndTime ? parseTemplateTimeToDate(day.plannedEndTime).getTime() : null;
    if (priorEnd !== newEnd) {
      return false;
    }
  }
  return true;
}

export interface UpdateTemplateInput {
  templateId: string;
  expectedVersionNumber: number;
  /** undefined = leave the name unchanged. */
  name?: string;
  /** undefined = leave the description unchanged; null = clear it; string = set it. */
  description?: string | null;
  /** undefined = leave the template active state unchanged. */
  active?: boolean;
  /** undefined = copy the previous version's 7 days verbatim into the new version. */
  days?: TemplateDayInput[];
  actorUserId: string;
  requestId: string;
}

export type UpdateTemplateResult =
  | { code: 'TEMPLATE_NOT_FOUND' }
  | { code: 'VERSION_CONFLICT' }
  | { changed: boolean; detail: TemplateDetail };

/**
 * docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 PATCH — creates a new immutable
 * WorkScheduleTemplateVersion, never rewrites an existing one. `SELECT ... FOR UPDATE` on the
 * parent WorkScheduleTemplate row (same pattern as lib/periods.ts/lib/review-scopes.ts/
 * lib/activation.ts — see those files' own "FOR UPDATE" comments) serializes concurrent PATCHes:
 * the current max(versionNumber) is only safe to compare against expectedVersionNumber once this
 * lock is held, otherwise two concurrent callers could both read version 1 and both "win",
 * producing two version-2 rows. A genuine no-op (requested name/description/days all identical to
 * the locked current state) intentionally creates neither a new version nor an AuditEvent — every
 * other case (metadata-only or days-only or both) creates exactly one new version, copying the
 * previous version's days verbatim when `days` wasn't part of the request.
 */
export async function updateTemplate(input: UpdateTemplateInput): Promise<UpdateTemplateResult> {
  return prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "WorkScheduleTemplate" WHERE id = ${input.templateId}::uuid FOR UPDATE`;
    if (lockedRows.length === 0) {
      return { code: 'TEMPLATE_NOT_FOUND' } as const;
    }

    const template = await tx.workScheduleTemplate.findUniqueOrThrow({ where: { id: input.templateId } });

    const currentVersion = await tx.workScheduleTemplateVersion.findFirst({
      where: { templateId: input.templateId },
      orderBy: { versionNumber: 'desc' },
      include: { days: true }
    });
    // Defensive only — every WorkScheduleTemplate gets its first version created atomically in
    // the same transaction as POST /api/admin/templates, so this can never actually be empty.
    if (!currentVersion) {
      return { code: 'TEMPLATE_NOT_FOUND' } as const;
    }

    if (currentVersion.versionNumber !== input.expectedVersionNumber) {
      return { code: 'VERSION_CONFLICT' } as const;
    }

    const newName = input.name !== undefined ? input.name : template.name;
    const newDescription = input.description !== undefined ? input.description : template.description;
    const newActive = input.active !== undefined ? input.active : template.active;
    const metadataChanged = newName !== template.name || newDescription !== template.description;
    const activeChanged = newActive !== template.active;
    const daysChanged = input.days !== undefined && !daysEqual(currentVersion.days, input.days);

    const daysToPersist: TemplateDayInput[] =
      input.days !== undefined
        ? input.days
        : currentVersion.days.map((day) => ({
            weekday: day.weekday,
            isWorkingDay: day.isWorkingDay,
            plannedStartTime: formatTimeOfDay(day.plannedStartTime),
            plannedEndTime: formatTimeOfDay(day.plannedEndTime),
            plannedBreakMinutes: day.plannedBreakMinutes,
            plannedBreakPaid: day.plannedBreakPaid
          }));
    const sortedDays = daysToPersist.slice().sort((a, b) => a.weekday - b.weekday);

    if (!metadataChanged && !activeChanged && !daysChanged) {
      return {
        changed: false,
        detail: {
          id: template.id,
          name: template.name,
          description: template.description,
          active: template.active,
          currentVersionId: currentVersion.id,
          currentVersionNumber: currentVersion.versionNumber,
          days: sortedDays
        }
      };
    }

    if (metadataChanged || activeChanged) {
      await tx.workScheduleTemplate.update({ where: { id: template.id }, data: { name: newName, description: newDescription, active: newActive } });
    }

    if (!metadataChanged && !daysChanged) {
      await createAuditEvent(tx, {
        actorUserId: input.actorUserId,
        eventType: 'TEMPLATE_UPDATED',
        entityType: 'WORK_SCHEDULE_TEMPLATE',
        entityId: template.id,
        requestId: input.requestId,
        beforeValue: { versionNumber: currentVersion.versionNumber, active: template.active },
        afterValue: { versionNumber: currentVersion.versionNumber, active: newActive, activeChanged: true }
      });
      return {
        changed: true,
        detail: {
          id: template.id,
          name: template.name,
          description: template.description,
          active: newActive,
          currentVersionId: currentVersion.id,
          currentVersionNumber: currentVersion.versionNumber,
          days: sortedDays
        }
      };
    }

    const newVersionNumber = currentVersion.versionNumber + 1;
    const newVersion = await tx.workScheduleTemplateVersion.create({
      data: { templateId: template.id, versionNumber: newVersionNumber, createdByUserId: input.actorUserId, effectiveFrom: new Date() }
    });

    await tx.workScheduleTemplateVersionDay.createMany({
      data: daysToPersist.map((day) => ({
        templateVersionId: newVersion.id,
        weekday: day.weekday,
        isWorkingDay: day.isWorkingDay,
        plannedStartTime: day.plannedStartTime ? parseTemplateTimeToDate(day.plannedStartTime) : null,
        plannedEndTime: day.plannedEndTime ? parseTemplateTimeToDate(day.plannedEndTime) : null,
        plannedBreakMinutes: day.plannedBreakMinutes,
        plannedBreakPaid: day.plannedBreakPaid
      }))
    });

    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'TEMPLATE_UPDATED',
      entityType: 'WORK_SCHEDULE_TEMPLATE',
      entityId: template.id,
      requestId: input.requestId,
      beforeValue: { versionNumber: currentVersion.versionNumber, name: template.name, description: template.description, active: template.active },
      afterValue: { versionNumber: newVersionNumber, name: newName, description: newDescription, active: newActive, metadataChanged, activeChanged, daysChanged }
    });

    return {
      changed: true,
      detail: {
        id: template.id,
        name: newName,
        description: newDescription,
        active: newActive,
        currentVersionId: newVersion.id,
        currentVersionNumber: newVersionNumber,
        days: sortedDays
      }
    };
  });
}
