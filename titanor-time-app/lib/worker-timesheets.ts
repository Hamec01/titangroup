import { Prisma, AbsenceType, DayType } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §9 — read-only timesheet/draft/version views
// (ЭТАП 7 sub-task 3a). §9's ownership rule: "сервер проверяет, что этот Timesheet.employeeId
// принадлежит вызывающему (403 FORBIDDEN иначе, не 404, чтобы не спутать «чужой» с «не существует»)".

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type TimesheetAccessError = { code: 'NOT_FOUND' } | { code: 'FORBIDDEN' };

async function loadOwnTimesheet(
  employeeId: string,
  timesheetId: string
): Promise<{ timesheet: { id: string; employeeId: string; periodId: string; status: string; currentVersionId: string | null } } | { error: TimesheetAccessError }> {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId } });
  if (!timesheet) {
    return { error: { code: 'NOT_FOUND' } };
  }
  if (timesheet.employeeId !== employeeId) {
    return { error: { code: 'FORBIDDEN' } };
  }
  return { timesheet };
}

export interface TimesheetSummary {
  timesheetId: string;
  periodId: string;
  status: string;
  currentVersionId: string | null;
}

export async function getWorkerTimesheetSummary(employeeId: string, timesheetId: string): Promise<TimesheetSummary | TimesheetAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  const t = result.timesheet;
  return { timesheetId: t.id, periodId: t.periodId, status: t.status, currentVersionId: t.currentVersionId };
}

export interface BreakView {
  id: string;
  startAt: string;
  endAt: string;
  paid: boolean;
}

export interface SegmentView {
  id: string;
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  breaks: BreakView[];
}

export interface PlannedShiftView {
  date: string;
  siteId: string;
  sourceAssignmentId: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  plannedBreakMinutes: number;
}

export interface DraftDayView {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  segments: SegmentView[];
}

export interface TimesheetDraftView {
  days: DraftDayView[];
  plannedShifts: PlannedShiftView[];
}

export type DraftAccessError = TimesheetAccessError | { code: 'DRAFT_NOT_EDITABLE' };

/** Only when Timesheet.status IN (DRAFT, RETURNED) — draft content is physically emptied on submit (03_...§4.6). */
export async function getWorkerTimesheetDraft(employeeId: string, timesheetId: string): Promise<TimesheetDraftView | DraftAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  if (result.timesheet.status !== 'DRAFT' && result.timesheet.status !== 'RETURNED') {
    return { code: 'DRAFT_NOT_EDITABLE' };
  }

  const draft = await prisma.timesheetDraft.findUnique({
    where: { timesheetId },
    select: {
      days: {
        orderBy: { date: 'asc' },
        select: {
          date: true,
          dayType: true,
          confirmedZero: true,
          segments: {
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              startAt: true,
              endAt: true,
              siteId: true,
              workAreaId: true,
              sourceAssignmentId: true,
              breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
            }
          }
        }
      },
      plannedShifts: {
        orderBy: { date: 'asc' },
        select: { date: true, siteId: true, sourceAssignmentId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
      }
    }
  });

  // TimesheetDraft is created in the same triple as Timesheet itself (03_...§4.6) — always exists; this is defensive only.
  if (!draft) {
    return { days: [], plannedShifts: [] };
  }

  return {
    days: draft.days.map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      segments: d.segments.map((s) => ({
        id: s.id,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        sourceAssignmentId: s.sourceAssignmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    })),
    plannedShifts: draft.plannedShifts.map((p) => ({
      date: formatDate(p.date),
      siteId: p.siteId,
      sourceAssignmentId: p.sourceAssignmentId,
      plannedStartAt: p.plannedStartAt ? p.plannedStartAt.toISOString() : null,
      plannedEndAt: p.plannedEndAt ? p.plannedEndAt.toISOString() : null,
      plannedBreakMinutes: p.plannedBreakMinutes
    }))
  };
}

export interface VersionDayView {
  date: string;
  dayType: string;
  segments: SegmentView[];
}

export interface TimesheetCurrentVersionView {
  versionId: string;
  versionNumber: number;
  days: VersionDayView[];
  plannedShifts: PlannedShiftView[];
  reviewScopes: { scopeType: string; siteId: string | null; status: string }[];
}

/**
 * Available in ANY Timesheet status, unlike .../draft — but currentVersionId is only ever set
 * once timesheet.submit runs (not built yet, a later ЭТАП 7 sub-task), so this always returns
 * 404 TIMESHEET_NOT_FOUND today; that's the contract's own documented behavior for "table de
 * table has never been submitted", not a bug. `reviewScopes` is always `[]` for the same
 * reason TimesheetReviewScope doesn't exist as a model yet — no scope can exist before the
 * review subsystem does.
 */
export async function getWorkerTimesheetCurrentVersion(employeeId: string, timesheetId: string): Promise<TimesheetCurrentVersionView | TimesheetAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  if (!result.timesheet.currentVersionId) {
    return { code: 'NOT_FOUND' };
  }

  const version = await prisma.timesheetVersion.findUnique({
    where: { id: result.timesheet.currentVersionId },
    select: {
      id: true,
      versionNumber: true,
      days: {
        orderBy: { date: 'asc' },
        select: {
          date: true,
          dayType: true,
          segments: {
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              startAt: true,
              endAt: true,
              siteId: true,
              workAreaId: true,
              sourceAssignmentId: true,
              breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
            }
          }
        }
      },
      plannedShifts: {
        orderBy: { date: 'asc' },
        select: { date: true, siteId: true, sourceAssignmentId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
      }
    }
  });

  if (!version) {
    return { code: 'NOT_FOUND' };
  }

  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    days: version.days.map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      segments: d.segments.map((s) => ({
        id: s.id,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        sourceAssignmentId: s.sourceAssignmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    })),
    plannedShifts: version.plannedShifts.map((p) => ({
      date: formatDate(p.date),
      siteId: p.siteId,
      sourceAssignmentId: p.sourceAssignmentId,
      plannedStartAt: p.plannedStartAt ? p.plannedStartAt.toISOString() : null,
      plannedEndAt: p.plannedEndAt ? p.plannedEndAt.toISOString() : null,
      plannedBreakMinutes: p.plannedBreakMinutes
    })),
    reviewScopes: []
  };
}

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.6 "Правило состояния дня" — the only three valid
// (dayType, confirmedZero, hasSegments) combinations, collapsed to a violation classifier.
// Segment-axis violation takes priority over confirmedZero-axis when a request could trigger
// both (e.g. dayType changed to non-WORK while segments still present) — matches the doc's own
// listed error precedence (DAY_TYPE_CONFLICT examples all involve segments on a non-WORK day).
function classifyDayStateViolation(dayType: string, confirmedZero: boolean, hasSegments: boolean): 'DAY_TYPE_CONFLICT' | 'DAY_STATE_CONFLICT' | null {
  if (dayType !== 'WORK' && hasSegments) {
    return 'DAY_TYPE_CONFLICT';
  }
  if (confirmedZero && (hasSegments || dayType !== 'WORK')) {
    return 'DAY_STATE_CONFLICT';
  }
  return null;
}

// The four AbsenceType values are a strict subset of DayType (DayType adds WORK and
// PUBLIC_HOLIDAY) — 03_DATA_MODEL_ERD.md §4.2 "Унификация dayType". PUBLIC_HOLIDAY has no
// AbsenceType counterpart at all, which is exactly why it can never be justified by an Absence
// and therefore always falls through to DAY_TYPE_REQUIRES_ABSENCE below — no special case needed.
const ABSENCE_DAY_TYPES = new Set(['SICK_LEAVE', 'VACATION', 'UNPAID_LEAVE', 'OTHER']);

/**
 * EX-04 (`ex_timesheet_draft_segment_time_overlap`, 05_RAW_SQL_REGISTER.md) — same untyped-error
 * shape as EX-02/EX-03. Service-side pre-validation below prevents this in the normal case; this
 * is defense-in-depth for a genuine concurrent write to the same draft/day.
 */
export function isSegmentOverlapViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('23P01') &&
    error.message.includes('ex_timesheet_draft_segment_time_overlap')
  );
}

export interface PatchBreakInput {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}

export interface PatchSegmentInput {
  startAt: Date;
  endAt: Date;
  siteId: string;
  workAreaId: string | null;
  breaks: PatchBreakInput[];
}

export interface PatchDayInput {
  dayType?: string;
  confirmedZero?: boolean;
  note?: string | null;
  segments?: PatchSegmentInput[];
}

export type PatchDayError =
  | TimesheetAccessError
  | { code: 'DRAFT_NOT_EDITABLE' }
  | { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { code: 'DAY_TYPE_REQUIRES_ABSENCE' }
  | { code: 'DAY_TYPE_CONFLICT' }
  | { code: 'DAY_STATE_CONFLICT' }
  | { code: 'SITE_NOT_ASSIGNED'; siteId: string }
  | { code: 'WORK_SEGMENT_OVERLAP' };

/**
 * PATCH /api/worker/timesheets/:timesheetId/days/:date (04_...§9). Only the fields present in
 * `input` are changed; `segments`, when present, is the day's FULL final segment list (not a
 * per-siteId delta) — a segment whose siteId is missing from the new array is deleted.
 *
 * Write order matters for the DB's own BEFORE ROW triggers (TRG-05/06, 03_...§4.6 "Concurrency-
 * safe реализация"): segments are always deleted before the day row is updated, and re-inserted
 * only after — zero segments is valid against every (dayType, confirmedZero) combination, so
 * that ordering can never itself trip either trigger, regardless of which direction the day's
 * state is transitioning.
 *
 * `affectedSitePairs` → TimesheetReviewProposal resolution (03_...§4.6) is NOT implemented here —
 * TimesheetReviewScope/Proposal are not schema yet (a later ЭТАП 7 sub-task); `resolvedProposals`
 * is always `[]`, which is correct today, not a stub — no proposal can exist before that
 * subsystem does.
 */
export async function patchWorkerTimesheetDay(
  employeeId: string,
  timesheetId: string,
  date: Date,
  input: PatchDayInput
): Promise<(DraftDayView & { resolvedProposals: never[] }) | PatchDayError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  if (result.timesheet.status !== 'DRAFT' && result.timesheet.status !== 'RETURNED') {
    return { code: 'DRAFT_NOT_EDITABLE' };
  }

  const draft = await prisma.timesheetDraft.findUnique({ where: { timesheetId }, select: { id: true } });
  if (!draft) {
    return { code: 'NOT_FOUND' };
  }

  const currentDay = await prisma.timesheetDraftDay.findUnique({
    where: { draftId_date: { draftId: draft.id, date } },
    select: { id: true, dayType: true, confirmedZero: true, segments: { select: { id: true } } }
  });
  if (!currentDay) {
    // Not named in 04_...§9's error list — a date outside this timesheet's own period never got
    // a TimesheetDraftDay row in the first place (period.create/assignment.create both generate
    // exactly one per period day), so this is a client input problem, not a missing-resource one.
    return { code: 'VALIDATION_ERROR', fieldErrors: { date: ['not within this timesheet\'s period'] } };
  }

  const finalDayType = input.dayType ?? currentDay.dayType;
  const finalConfirmedZero = input.confirmedZero ?? currentDay.confirmedZero;
  const hasSegments = input.segments !== undefined ? input.segments.length > 0 : currentDay.segments.length > 0;

  const stateViolation = classifyDayStateViolation(finalDayType, finalConfirmedZero, hasSegments);
  if (stateViolation) {
    return { code: stateViolation };
  }

  let resolvedAbsenceId: string | null = null;
  if (input.dayType !== undefined && input.dayType !== 'WORK') {
    if (!ABSENCE_DAY_TYPES.has(input.dayType)) {
      return { code: 'DAY_TYPE_REQUIRES_ABSENCE' };
    }
    const absence = await prisma.absence.findFirst({
      where: { employeeId, status: 'APPROVED', type: input.dayType as AbsenceType, startDate: { lte: date }, endDate: { gte: date } },
      select: { id: true }
    });
    if (!absence) {
      return { code: 'DAY_TYPE_REQUIRES_ABSENCE' };
    }
    resolvedAbsenceId = absence.id;
  }

  const resolvedSegments: { segment: PatchSegmentInput; sourceAssignmentId: string }[] = [];
  if (input.segments !== undefined) {
    const sortedSegments = [...input.segments].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    for (let i = 1; i < sortedSegments.length; i++) {
      if (sortedSegments[i].startAt < sortedSegments[i - 1].endAt) {
        return { code: 'WORK_SEGMENT_OVERLAP' };
      }
    }

    for (const segment of input.segments) {
      const sortedBreaks = [...segment.breaks].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      for (const b of sortedBreaks) {
        if (b.startAt < segment.startAt || b.endAt > segment.endAt) {
          return { code: 'VALIDATION_ERROR', fieldErrors: { breaks: ['must be entirely within its segment'] } };
        }
      }
      for (let i = 1; i < sortedBreaks.length; i++) {
        if (sortedBreaks[i].startAt < sortedBreaks[i - 1].endAt) {
          return { code: 'VALIDATION_ERROR', fieldErrors: { breaks: ['must not overlap each other within the same segment'] } };
        }
      }

      const assignment = await prisma.siteAssignment.findFirst({
        where: {
          employeeId,
          siteId: segment.siteId,
          workAreaId: segment.workAreaId,
          validFrom: { lte: date },
          OR: [{ validTo: null }, { validTo: { gte: date } }]
        },
        select: { id: true }
      });
      if (!assignment) {
        return { code: 'SITE_NOT_ASSIGNED', siteId: segment.siteId };
      }
      resolvedSegments.push({ segment, sourceAssignmentId: assignment.id });
    }
  }

  try {
    const updatedDay = await prisma.$transaction(async (tx) => {
      if (input.segments !== undefined) {
        await tx.timesheetDraftSegment.deleteMany({ where: { draftDayId: currentDay.id } });
      }

      await tx.timesheetDraftDay.update({
        where: { id: currentDay.id },
        data: {
          ...(input.dayType !== undefined ? { dayType: input.dayType as DayType } : {}),
          ...(input.confirmedZero !== undefined ? { confirmedZero: input.confirmedZero } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.dayType !== undefined ? { sourceAbsenceId: resolvedAbsenceId } : {})
        }
      });

      if (input.segments !== undefined && resolvedSegments.length > 0) {
        for (const { segment, sourceAssignmentId } of resolvedSegments) {
          const createdSegment = await tx.timesheetDraftSegment.create({
            data: {
              draftDayId: currentDay.id,
              draftId: draft.id,
              employeeId,
              date,
              startAt: segment.startAt,
              endAt: segment.endAt,
              siteId: segment.siteId,
              workAreaId: segment.workAreaId,
              sourceAssignmentId
            }
          });
          if (segment.breaks.length > 0) {
            await tx.timesheetDraftBreakSegment.createMany({
              data: segment.breaks.map((b) => ({ draftSegmentId: createdSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
            });
          }
        }
      }

      await tx.timesheetDraft.update({ where: { id: draft.id }, data: { contentRevision: { increment: 1 } } });

      return tx.timesheetDraftDay.findUniqueOrThrow({
        where: { id: currentDay.id },
        select: {
          date: true,
          dayType: true,
          confirmedZero: true,
          segments: {
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              startAt: true,
              endAt: true,
              siteId: true,
              workAreaId: true,
              sourceAssignmentId: true,
              breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
            }
          }
        }
      });
    });

    return {
      date: formatDate(updatedDay.date),
      dayType: updatedDay.dayType,
      confirmedZero: updatedDay.confirmedZero,
      segments: updatedDay.segments.map((s) => ({
        id: s.id,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        sourceAssignmentId: s.sourceAssignmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      })),
      resolvedProposals: []
    };
  } catch (error) {
    if (isSegmentOverlapViolation(error)) {
      return { code: 'WORK_SEGMENT_OVERLAP' };
    }
    throw error;
  }
}
