import { Prisma, AbsenceType, DayType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { effectiveReportedRangesBatch, resolveOverlapsForAffectedShifts, provenanceValuesEqual, type ProvenanceValues } from '@/lib/attendance-reported-projection';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 "CorrectionRequest"/"CorrectionDraft*" +
// 02_ROLE_PERMISSION_MATRIX.md §2.9 — T7.9, first UI slice confirmed ADMIN-only
// (correction.request + correction.draft.edit + correction.approve all here; WORKER/FOREMAN
// correction.request forms are a later, separate step). The draft-edit/day-patch logic below
// mirrors lib/worker-timesheets.ts's patchWorkerTimesheetDay closely — same day-state rules,
// same segment/break validation, same resolution of sourceAssignmentId — just against
// CorrectionDraft* tables instead of TimesheetDraft*. CorrectionDraft has no plannedShift
// entity of its own (§4.5: corrections compare only against basedOnVersionId, never a plan).

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================================
// correction.request
// ============================================================================

export type RequestCorrectionError = { code: 'TIMESHEET_NOT_FOUND' } | { code: 'INVALID_STATE_TRANSITION' } | { code: 'CORRECTION_ALREADY_OPEN' };

export interface RequestCorrectionResult {
  id: string;
  timesheetId: string;
  status: 'PENDING';
}

/**
 * Corrections only ever target a FINAL_APPROVED timesheet (§4.7 "Поток": the flow ends with
 * TimesheetVersion(source=CORRECTION), Timesheet.status stays FINAL_APPROVED — there would be
 * nothing to "correct" via this path otherwise, a DRAFT/SUBMITTED/RETURNED/FOREMAN_APPROVED
 * timesheet is edited through the normal draft, not a correction).
 *
 * CORRECTION_ALREADY_OPEN is an app-level guard, not schema-mandated: nothing in the doc
 * forbids two open CorrectionRequests on the same timesheet at once, but allowing it would let
 * two drafts race to freeze two different resultingVersions from the same basedOnVersionId —
 * confusing, not useful. One request open (status NOT IN (APPROVED, REJECTED)) at a time.
 */
export async function requestCorrection(timesheetId: string, requestedByUserId: string, reason: string, requestId: string): Promise<RequestCorrectionResult | RequestCorrectionError> {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId }, select: { status: true } });
  if (!timesheet) {
    return { code: 'TIMESHEET_NOT_FOUND' };
  }
  if (timesheet.status !== 'FINAL_APPROVED') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  const openRequest = await prisma.correctionRequest.findFirst({
    where: { timesheetId, status: { notIn: ['APPROVED', 'REJECTED'] } },
    select: { id: true }
  });
  if (openRequest) {
    return { code: 'CORRECTION_ALREADY_OPEN' };
  }

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.correctionRequest.create({
      data: { timesheetId, requestedByUserId, reason, status: 'PENDING' }
    });

    await createAuditEvent(tx, {
      actorUserId: requestedByUserId,
      eventType: 'CORRECTION_REQUESTED',
      entityType: 'CORRECTION_REQUEST',
      entityId: request.id,
      requestId,
      beforeValue: null,
      afterValue: { id: request.id, timesheetId, reason }
    });

    return request;
  });

  return { id: created.id, timesheetId, status: 'PENDING' };
}

// ============================================================================
// correction.draft.edit — "open" step (idempotent get-or-create)
// ============================================================================

export type OpenCorrectionDraftError = { code: 'NOT_FOUND' } | { code: 'INVALID_STATE_TRANSITION' };

export interface OpenCorrectionDraftResult {
  correctionRequestId: string;
  draftId: string;
  status: 'DRAFT_OPEN';
}

/**
 * PENDING → DRAFT_OPEN: creates the CorrectionDraft, fixes basedOnVersionId to the timesheet's
 * current (FINAL_APPROVED) version, and copies that version's day/segment/break content in as
 * the starting point — mirrors lib/review-scopes.ts's reinitializeDraftFromVersion, minus the
 * planned-shift step (no CorrectionDraftPlannedShift table exists). Already DRAFT_OPEN → returns
 * the existing draft unchanged (idempotent re-open, not an error) — anything else (SUBMITTED,
 * APPROVED, REJECTED) is not re-openable from here.
 */
export async function openCorrectionDraft(correctionRequestId: string, actorUserId: string, requestId: string): Promise<OpenCorrectionDraftResult | OpenCorrectionDraftError> {
  const request = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { id: true, status: true, draftId: true, timesheetId: true, timesheet: { select: { employeeId: true, currentVersionId: true } } }
  });
  if (!request) {
    return { code: 'NOT_FOUND' };
  }
  if (request.status === 'DRAFT_OPEN' && request.draftId) {
    return { correctionRequestId, draftId: request.draftId, status: 'DRAFT_OPEN' };
  }
  if (request.status !== 'PENDING' || !request.timesheet.currentVersionId) {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  const basedOnVersionId = request.timesheet.currentVersionId;
  const employeeId = request.timesheet.employeeId;

  const draftId = await prisma.$transaction(async (tx) => {
    const draft = await tx.correctionDraft.create({
      data: { correctionRequestId, employeeId, basedOnVersionId, openedByUserId: actorUserId }
    });

    const days = await tx.timesheetDay.findMany({
      where: { timesheetVersionId: basedOnVersionId },
      select: {
        date: true,
        dayType: true,
        confirmedZero: true,
        sourceAbsenceId: true,
        note: true,
        segments: {
          select: {
            siteId: true,
            workAreaId: true,
            sourceAssignmentId: true,
            startAt: true,
            endAt: true,
            originClockShiftFragmentId: true,
            breaks: { select: { startAt: true, endAt: true, paid: true } }
          }
        }
      }
    });

    for (const day of days) {
      const newDay = await tx.correctionDraftDay.create({
        data: { draftId: draft.id, date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, sourceAbsenceId: day.sourceAbsenceId, note: day.note }
      });
      for (const seg of day.segments) {
        const newSegment = await tx.correctionDraftSegment.create({
          data: {
            draftDayId: newDay.id,
            draftId: draft.id,
            employeeId,
            date: day.date,
            startAt: seg.startAt,
            endAt: seg.endAt,
            siteId: seg.siteId,
            workAreaId: seg.workAreaId,
            sourceAssignmentId: seg.sourceAssignmentId,
            // §15 п.8 — without this, clock provenance is lost the moment a correction draft is
            // opened, before the worker/admin ever touches the day (same lesson as
            // reinitializeDraftFromVersion, lib/review-scopes.ts).
            originClockShiftFragmentId: seg.originClockShiftFragmentId
          }
        });
        if (seg.breaks.length > 0) {
          await tx.correctionDraftBreakSegment.createMany({
            data: seg.breaks.map((b) => ({ draftSegmentId: newSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
          });
        }
      }
    }

    await tx.correctionRequest.update({ where: { id: correctionRequestId }, data: { draftId: draft.id, status: 'DRAFT_OPEN' } });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CORRECTION_DRAFT_OPENED',
      entityType: 'CORRECTION_REQUEST',
      entityId: correctionRequestId,
      requestId,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: 'DRAFT_OPEN', draftId: draft.id, basedOnVersionId }
    });

    return draft.id;
  });

  return { correctionRequestId, draftId, status: 'DRAFT_OPEN' };
}

// ============================================================================
// correction.draft.edit — day-patch step (repeatable, same shape as
// lib/worker-timesheets.ts's PatchDayInput/patchWorkerTimesheetDay)
// ============================================================================

function classifyDayStateViolation(dayType: string, confirmedZero: boolean, hasSegments: boolean): 'DAY_TYPE_CONFLICT' | 'DAY_STATE_CONFLICT' | null {
  if (dayType !== 'WORK' && hasSegments) {
    return 'DAY_TYPE_CONFLICT';
  }
  if (confirmedZero && (hasSegments || dayType !== 'WORK')) {
    return 'DAY_STATE_CONFLICT';
  }
  return null;
}

const ABSENCE_DAY_TYPES = new Set(['SICK_LEAVE', 'VACATION', 'UNPAID_LEAVE', 'OTHER']);

/** EX-XX ex_correction_draft_segment_time_overlap — same untyped-error shape as the sibling EX constraints. */
export function isCorrectionSegmentOverlapViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientUnknownRequestError && error.message.includes('23P01') && error.message.includes('ex_correction_draft_segment_time_overlap');
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
  originClockShiftFragmentId?: string | null;
}

export interface PatchDayInput {
  dayType?: string;
  confirmedZero?: boolean;
  note?: string | null;
  segments?: PatchSegmentInput[];
}

export interface CorrectionDaySegmentView {
  id: string;
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  originClockShiftFragmentId: string | null;
  breaks: { id: string; startAt: string; endAt: string; paid: boolean }[];
}

export interface CorrectionDayView {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  segments: CorrectionDaySegmentView[];
}

export type PatchCorrectionDayError =
  | { code: 'NOT_FOUND' }
  | { code: 'FORBIDDEN' }
  | { code: 'INVALID_STATE_TRANSITION' }
  | { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { code: 'DAY_TYPE_REQUIRES_ABSENCE' }
  | { code: 'DAY_TYPE_CONFLICT' }
  | { code: 'DAY_STATE_CONFLICT' }
  | { code: 'SITE_NOT_ASSIGNED'; siteId: string }
  | { code: 'WORK_SEGMENT_OVERLAP' };

/**
 * §15 п.9 — clock provenance validation for an already-open correction draft: an incoming
 * `originClockShiftFragmentId` is only accepted if it's already live on THIS draft's THIS day
 * (`previousLive`, read under lock, before any mutation) — the same membership discipline as
 * worker PATCH (§10.2 шаг 2a), applied here to `CorrectionDraftSegment` instead of
 * `TimesheetDraftSegment`. No `ClockShiftAdjustment` is written at this stage — the correction
 * isn't approved yet (§15 п.7 does that, at freeze time).
 *
 * §15 п.9 locking — every DB read that affects ownership/state/day-validation/write happens
 * inside one transaction, behind `Employee` → `Timesheet` → `CorrectionDraft FOR UPDATE` (same
 * canonical-order discipline as §10.3/§8.1, `CorrectionDraft` standing in the `TimesheetDraft`
 * position for this flow) taken first; only the two purely request-shape checks that never touch
 * the DB (segment-list self-overlap, break bounds, duplicate origin) run before the transaction.
 * The one unavoidable pre-lock read is `correctionRequestId → timesheetId/employeeId` — routing
 * information only (which rows to lock), never a status/ownership decision; status and `draftId`
 * are re-read fresh under the lock below.
 */
export async function patchCorrectionDraftDay(correctionRequestId: string, date: Date, input: PatchDayInput): Promise<CorrectionDayView | PatchCorrectionDayError> {
  if (input.segments !== undefined) {
    const sortedSegments = [...input.segments].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    for (let i = 1; i < sortedSegments.length; i++) {
      if (sortedSegments[i].startAt < sortedSegments[i - 1].endAt) {
        return { code: 'WORK_SEGMENT_OVERLAP' };
      }
    }

    const seenOriginIds = new Set<string>();
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
      if (segment.originClockShiftFragmentId) {
        if (seenOriginIds.has(segment.originClockShiftFragmentId)) {
          return { code: 'VALIDATION_ERROR', fieldErrors: { originClockShiftFragmentId: ['duplicate origin in segments[]'] } };
        }
        seenOriginIds.add(segment.originClockShiftFragmentId);
      }
    }
  }

  const routing = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { timesheetId: true, timesheet: { select: { employeeId: true } } }
  });
  if (!routing) {
    return { code: 'NOT_FOUND' };
  }
  const employeeId = routing.timesheet.employeeId;

  try {
    const updatedDay = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${routing.timesheetId}::uuid FOR UPDATE`;

      const request = await tx.correctionRequest.findUniqueOrThrow({ where: { id: correctionRequestId }, select: { status: true, draftId: true } });
      if (request.status !== 'DRAFT_OPEN' || !request.draftId) {
        return { code: 'INVALID_STATE_TRANSITION' as const };
      }
      const draftId = request.draftId;

      await tx.$queryRaw`SELECT id FROM "CorrectionDraft" WHERE id = ${draftId}::uuid FOR UPDATE`;

      const currentDay = await tx.correctionDraftDay.findUnique({
        where: { draftId_date: { draftId, date } },
        select: { id: true, dayType: true, confirmedZero: true, segments: { select: { id: true } } }
      });
      if (!currentDay) {
        return { code: 'VALIDATION_ERROR' as const, fieldErrors: { date: ["not within this correction draft's base version"] } };
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
          return { code: 'DAY_TYPE_REQUIRES_ABSENCE' as const };
        }
        const absence = await tx.absence.findFirst({
          where: { employeeId, status: 'APPROVED', type: input.dayType as AbsenceType, startDate: { lte: date }, endDate: { gte: date } },
          select: { id: true }
        });
        if (!absence) {
          return { code: 'DAY_TYPE_REQUIRES_ABSENCE' as const };
        }
        resolvedAbsenceId = absence.id;
      }

      const previousLiveRows = await tx.correctionDraftSegment.findMany({
        where: { draftDayId: currentDay.id, originClockShiftFragmentId: { not: null } },
        select: { originClockShiftFragmentId: true }
      });
      const previousLiveOriginIds = new Set(previousLiveRows.map((s) => s.originClockShiftFragmentId as string));

      const resolvedSegments: { segment: PatchSegmentInput; sourceAssignmentId: string }[] = [];
      if (input.segments !== undefined) {
        for (const segment of input.segments) {
          if (segment.originClockShiftFragmentId && !previousLiveOriginIds.has(segment.originClockShiftFragmentId)) {
            return { code: 'FORBIDDEN' as const };
          }

          // Historical date (a correction may target any past period) — the same validFrom/validTo
          // window check as the regular draft-day patch resolves correctly regardless of "today",
          // since it only ever compares against the segment's own `date`, never the current date.
          const assignment = await tx.siteAssignment.findFirst({
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
            return { code: 'SITE_NOT_ASSIGNED' as const, siteId: segment.siteId };
          }
          resolvedSegments.push({ segment, sourceAssignmentId: assignment.id });
        }
      }

      if (input.segments !== undefined) {
        await tx.correctionDraftSegment.deleteMany({ where: { draftDayId: currentDay.id } });
      }

      await tx.correctionDraftDay.update({
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
          const createdSegment = await tx.correctionDraftSegment.create({
            data: {
              draftDayId: currentDay.id,
              draftId,
              employeeId,
              date,
              startAt: segment.startAt,
              endAt: segment.endAt,
              siteId: segment.siteId,
              workAreaId: segment.workAreaId,
              sourceAssignmentId,
              originClockShiftFragmentId: segment.originClockShiftFragmentId ?? null
            }
          });
          if (segment.breaks.length > 0) {
            await tx.correctionDraftBreakSegment.createMany({
              data: segment.breaks.map((b) => ({ draftSegmentId: createdSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
            });
          }
        }
      }

      return tx.correctionDraftDay.findUniqueOrThrow({
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
              originClockShiftFragmentId: true,
              breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
            }
          }
        }
      });
    });

    if ('code' in updatedDay) {
      return updatedDay;
    }

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
        originClockShiftFragmentId: s.originClockShiftFragmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    };
  } catch (error) {
    if (isCorrectionSegmentOverlapViolation(error)) {
      return { code: 'WORK_SEGMENT_OVERLAP' };
    }
    throw error;
  }
}

// ============================================================================
// correction.submit
// ============================================================================

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface ProjectionBreak {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}
interface ProjectionSegment {
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  startAt: Date;
  endAt: Date;
  breaks: ProjectionBreak[];
}
interface ProjectionDay {
  date: Date;
  dayType: string;
  confirmedZero: boolean;
  sourceAbsenceId: string | null;
  note: string | null;
  segments: ProjectionSegment[];
}

/**
 * 03_...§4.7 "canonicalCorrectionProjection() — отдельная функция, не переиспользование
 * contentHash scope": the WHOLE timesheet (every day/segment/break), not one SITE/NON_SITE
 * scope's subset of fields — used only for correction.submit's materialChanged gate, never for
 * TimesheetReviewScope's contentHash.
 */
function canonicalCorrectionProjection(days: ProjectionDay[]): unknown {
  return days
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      sourceAbsenceId: d.sourceAbsenceId,
      note: d.note,
      segments: d.segments
        .slice()
        .sort((a, b) => a.siteId.localeCompare(b.siteId) || a.startAt.getTime() - b.startAt.getTime())
        .map((s) => ({
          siteId: s.siteId,
          workAreaId: s.workAreaId,
          sourceAssignmentId: s.sourceAssignmentId,
          startAt: s.startAt.toISOString(),
          endAt: s.endAt.toISOString(),
          breaks: s.breaks
            .slice()
            .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
            .map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
        }))
    }));
}

async function loadProjectionDaysFromDraft(tx: Prisma.TransactionClient, draftId: string): Promise<ProjectionDay[]> {
  const days = await tx.correctionDraftDay.findMany({
    where: { draftId },
    select: {
      date: true,
      dayType: true,
      confirmedZero: true,
      sourceAbsenceId: true,
      note: true,
      segments: {
        select: {
          siteId: true,
          workAreaId: true,
          sourceAssignmentId: true,
          startAt: true,
          endAt: true,
          breaks: { select: { startAt: true, endAt: true, paid: true } }
        }
      }
    }
  });
  return days;
}

async function loadProjectionDaysFromVersion(tx: Prisma.TransactionClient, timesheetVersionId: string): Promise<ProjectionDay[]> {
  const days = await tx.timesheetDay.findMany({
    where: { timesheetVersionId },
    select: {
      date: true,
      dayType: true,
      confirmedZero: true,
      sourceAbsenceId: true,
      note: true,
      segments: {
        select: {
          siteId: true,
          workAreaId: true,
          sourceAssignmentId: true,
          startAt: true,
          endAt: true,
          breaks: { select: { startAt: true, endAt: true, paid: true } }
        }
      }
    }
  });
  return days;
}

export type SubmitCorrectionError = { code: 'NOT_FOUND' } | { code: 'INVALID_STATE_TRANSITION' } | { code: 'NO_CORRECTION_CHANGES' };

export interface SubmitCorrectionResult {
  correctionRequestId: string;
  status: 'SUBMITTED';
}

export async function submitCorrection(correctionRequestId: string, requestId: string): Promise<SubmitCorrectionResult | SubmitCorrectionError> {
  const request = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { status: true, draftId: true, draftOwner: { select: { id: true, basedOnVersionId: true, openedByUserId: true } } }
  });
  if (!request || !request.draftOwner) {
    return { code: 'NOT_FOUND' };
  }
  if (request.status !== 'DRAFT_OPEN') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const draftDays = await loadProjectionDaysFromDraft(tx, request.draftOwner!.id);
    const baseDays = await loadProjectionDaysFromVersion(tx, request.draftOwner!.basedOnVersionId);

    const draftProjection = canonicalCorrectionProjection(draftDays);
    const baseProjection = canonicalCorrectionProjection(baseDays);

    if (canonicalStringify(draftProjection) === canonicalStringify(baseProjection)) {
      return { code: 'NO_CORRECTION_CHANGES' as const };
    }

    await tx.correctionDraft.update({ where: { id: request.draftOwner!.id }, data: { submittedAt: new Date() } });
    await tx.correctionRequest.update({ where: { id: correctionRequestId }, data: { status: 'SUBMITTED' } });

    await createAuditEvent(tx, {
      actorUserId: request.draftOwner!.openedByUserId,
      eventType: 'CORRECTION_SUBMITTED',
      entityType: 'CORRECTION_REQUEST',
      entityId: correctionRequestId,
      requestId,
      beforeValue: { status: 'DRAFT_OPEN' },
      afterValue: { status: 'SUBMITTED' }
    });

    return { code: 'SUBMITTED' as const };
  });

  if (outcome.code === 'NO_CORRECTION_CHANGES') {
    return { code: 'NO_CORRECTION_CHANGES' };
  }
  return { correctionRequestId, status: 'SUBMITTED' };
}

// ============================================================================
// correction.approve (decision: APPROVED or REJECTED)
// ============================================================================

export type DecideCorrectionError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_STATE_TRANSITION' }
  | { code: 'SELF_APPROVAL_FORBIDDEN' }
  | { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

export interface DecideCorrectionResult {
  correctionRequestId: string;
  status: 'APPROVED' | 'REJECTED';
  resultingVersionId: string | null;
}

/**
 * §4.7: "correction.approve требует decidedByUserId != CorrectionDraft.openedByUserId (четыре
 * глаза), кроме approvalOverride=true (только SUPER_ADMIN, с overrideReason,
 * AuditEvent(CORRECTION_SELF_APPROVED_OVERRIDE))." Applied to both outcomes (APPROVED and
 * REJECTED) — both are exercised through the same decision action, and self-review defeats the
 * "second pair of eyes" purpose either way.
 *
 * §15 п.7 locking — `Employee` → `Timesheet` → `CorrectionRequest FOR UPDATE` (canonical order,
 * §8.1, `CorrectionRequest` standing in the "draft/correction rows" position) taken first; status,
 * ownership, `currentVersionId`, and the self-approval check are all re-read fresh under the lock,
 * never trusted from the pre-lock routing read.
 *
 * On APPROVED: freezes the draft into a new TimesheetVersion(source=CORRECTION) — same
 * day/segment/break freeze order as lib/worker-timesheets.ts's submitWorkerTimesheet (no
 * TimesheetPlannedShift step here, CorrectionDraft has none), now also copying
 * `originClockShiftFragmentId` onto each frozen WorkSegment. Timesheet.status stays FINAL_APPROVED
 * (§4.7) — no TimesheetReviewScope is created, corrections don't re-enter review. Before switching
 * `currentVersionId`, `beforeOriginFragmentIds` (from the OLD current version's WorkSegment) and
 * `beforeRangesByShift` (§9.1a snapshot) are captured; after the freeze and switch,
 * `ClockShiftAdjustment` rows are written for every provenance origin that actually changed
 * (EDITED/REMOVED/RESTORED_TO_RECORDED, attributed to the real `deciderUserId` — never SYSTEM),
 * and the shared `resolveOverlapsForAffectedShifts` (§9.1a) resolves OVERLAPPING_SHIFT transitions
 * for every affected shift — SYSTEM is used only inside that helper's own automatic resolution,
 * never as the ClockShiftAdjustment author. If PayrollPeriod.status = EXPORTED at this moment,
 * CorrectionRequest.pendingExport is set — ExportBatch itself isn't built yet (period.export,
 * deferred), so this just marks the row for whenever that lands. REJECTED never reaches any of
 * this — no WorkSegment, ClockShiftAdjustment, or overlap-transition is ever created for it.
 */
export async function decideCorrection(
  correctionRequestId: string,
  decision: 'APPROVED' | 'REJECTED',
  deciderUserId: string,
  approvalOverride: boolean,
  overrideReason: string | null,
  requestId: string
): Promise<DecideCorrectionResult | DecideCorrectionError> {
  if (approvalOverride && (!overrideReason || overrideReason.trim().length === 0)) {
    return { code: 'VALIDATION_ERROR', fieldErrors: { overrideReason: ['required when approvalOverride is true'] } };
  }

  const routing = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { timesheetId: true, timesheet: { select: { employeeId: true } } }
  });
  if (!routing) {
    return { code: 'NOT_FOUND' };
  }
  const employeeId = routing.timesheet.employeeId;

  const outcome = await prisma.$transaction(async (tx): Promise<DecideCorrectionError | { status: 'REJECTED' | 'APPROVED'; resultingVersionId: string | null }> => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${routing.timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "CorrectionRequest" WHERE id = ${correctionRequestId}::uuid FOR UPDATE`;

    const request = await tx.correctionRequest.findUniqueOrThrow({
      where: { id: correctionRequestId },
      select: {
        status: true,
        reason: true,
        timesheetId: true,
        draftOwner: { select: { id: true, employeeId: true, openedByUserId: true } },
        timesheet: { select: { employeeId: true, currentVersionId: true, periodId: true, period: { select: { status: true } } } }
      }
    });
    if (!request.draftOwner) {
      return { code: 'NOT_FOUND' as const };
    }
    if (request.status !== 'SUBMITTED') {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }
    if (!approvalOverride && deciderUserId === request.draftOwner.openedByUserId) {
      return { code: 'SELF_APPROVAL_FORBIDDEN' as const };
    }

    const draftId = request.draftOwner.id;

    if (decision === 'REJECTED') {
      await tx.correctionRequest.update({
        where: { id: correctionRequestId },
        data: { status: 'REJECTED', decidedByUserId: deciderUserId, decidedAt: new Date() }
      });

      await createAuditEvent(tx, {
        actorUserId: deciderUserId,
        eventType: 'CORRECTION_REJECTED',
        entityType: 'CORRECTION_REQUEST',
        entityId: correctionRequestId,
        requestId,
        beforeValue: { status: 'SUBMITTED' },
        afterValue: { status: 'REJECTED' }
      });

      return { status: 'REJECTED' as const, resultingVersionId: null };
    }

    const oldVersionId = request.timesheet.currentVersionId;

    // §15 п.7 — before-origin snapshot, from the OLD current version's WorkSegment, taken before
    // any mutation. Every origin appearing in the correction draft is already guaranteed (§15 п.9
    // membership check, applied when the draft's segments were edited) to trace back to a
    // fragment that was live in this same OLD version — so beforeOriginFragmentIds always
    // includes every afterOriginFragmentId, and no fragment ever appears only in "after" (no new
    // origin binding is ever created outside the materializer).
    const beforeWorkSegments = oldVersionId
      ? await tx.workSegment.findMany({
          where: { timesheetVersionId: oldVersionId, originClockShiftFragmentId: { not: null } },
          select: { originClockShiftFragmentId: true, startAt: true, endAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true }
        })
      : [];
    const beforeByFragment = new Map(beforeWorkSegments.map((s) => [s.originClockShiftFragmentId as string, s]));

    const days = await tx.correctionDraftDay.findMany({
      where: { draftId },
      select: {
        date: true,
        dayType: true,
        confirmedZero: true,
        sourceAbsenceId: true,
        note: true,
        segments: {
          select: {
            siteId: true,
            workAreaId: true,
            sourceAssignmentId: true,
            startAt: true,
            endAt: true,
            originClockShiftFragmentId: true,
            breaks: { select: { startAt: true, endAt: true, paid: true } }
          }
        }
      }
    });

    const afterByFragment = new Map<string, ProvenanceValues>();
    for (const day of days) {
      for (const seg of day.segments) {
        if (seg.originClockShiftFragmentId) {
          afterByFragment.set(seg.originClockShiftFragmentId, { startAt: seg.startAt, endAt: seg.endAt, siteId: seg.siteId, workAreaId: seg.workAreaId, sourceAssignmentId: seg.sourceAssignmentId });
        }
      }
    }

    const affectedFragmentIds = [...new Set([...beforeByFragment.keys(), ...afterByFragment.keys()])];
    const fragmentsById = new Map<
      string,
      { id: string; clockShiftId: string; employeeId: string; recordedStartAt: Date; recordedEndAt: Date; siteId: string; workAreaId: string | null; sourceAssignmentId: string | null }
    >();
    if (affectedFragmentIds.length > 0) {
      const fragmentRows = await tx.clockShiftFragment.findMany({
        where: { id: { in: affectedFragmentIds } },
        select: { id: true, clockShiftId: true, employeeId: true, recordedStartAt: true, recordedEndAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true }
      });
      for (const f of fragmentRows) {
        fragmentsById.set(f.id, f);
      }
    }
    const affectedShiftIds = [...new Set(affectedFragmentIds.map((id) => fragmentsById.get(id)!.clockShiftId))];
    const beforeRangesByShift = await effectiveReportedRangesBatch(tx, affectedShiftIds);

    const lastVersion = await tx.timesheetVersion.findFirst({
      where: { timesheetId: request.timesheetId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true }
    });
    const versionNumber = (lastVersion?.versionNumber ?? 0) + 1;

    const version = await tx.timesheetVersion.create({
      data: { timesheetId: request.timesheetId, employeeId, versionNumber, source: 'CORRECTION', createdByUserId: deciderUserId }
    });

    for (const day of days) {
      const newDay = await tx.timesheetDay.create({
        data: { timesheetVersionId: version.id, date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, sourceAbsenceId: day.sourceAbsenceId, note: day.note }
      });
      for (const seg of day.segments) {
        // WorkSegment's composite FK requires a matching TimesheetPlannedShift(timesheetVersionId,
        // date, sourceAssignmentId) row to already exist (same lesson as submitWorkerTimesheet) —
        // corrections have no planned-shift concept of their own, so a zero-planned placeholder
        // row is frozen first, purely to satisfy the FK; plannedStartAt/EndAt stay NULL (matches
        // the "no plan" shape already used for non-working days elsewhere in this schema).
        await tx.timesheetPlannedShift.upsert({
          where: { timesheetVersionId_date_sourceAssignmentId: { timesheetVersionId: version.id, date: day.date, sourceAssignmentId: seg.sourceAssignmentId } },
          create: { timesheetVersionId: version.id, employeeId, date: day.date, siteId: seg.siteId, sourceAssignmentId: seg.sourceAssignmentId, plannedBreakMinutes: 0 },
          update: {}
        });
        const newSegment = await tx.workSegment.create({
          data: {
            timesheetDayId: newDay.id,
            timesheetVersionId: version.id,
            employeeId,
            date: day.date,
            startAt: seg.startAt,
            endAt: seg.endAt,
            siteId: seg.siteId,
            workAreaId: seg.workAreaId,
            sourceAssignmentId: seg.sourceAssignmentId,
            crossesMidnight: formatDate(seg.endAt) !== formatDate(day.date),
            originClockShiftFragmentId: seg.originClockShiftFragmentId
          }
        });
        if (seg.breaks.length > 0) {
          await tx.breakSegment.createMany({
            data: seg.breaks.map((b) => ({ workSegmentId: newSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
          });
        }
      }
    }

    await tx.timesheet.update({ where: { id: request.timesheetId }, data: { currentVersionId: version.id } });

    // §15 п.7 — after the freeze/switch: write ClockShiftAdjustment for every origin whose
    // provenance-relevant values actually changed, attributed to the real approver, never SYSTEM.
    for (const fragmentId of affectedFragmentIds) {
      const before = beforeByFragment.get(fragmentId);
      const after = afterByFragment.get(fragmentId);
      if (before && after && provenanceValuesEqual(before, after)) {
        continue;
      }
      const frag = fragmentsById.get(fragmentId)!;
      const recorded: ProvenanceValues = { startAt: frag.recordedStartAt, endAt: frag.recordedEndAt, siteId: frag.siteId, workAreaId: frag.workAreaId, sourceAssignmentId: frag.sourceAssignmentId };
      const beforeValues: ProvenanceValues = before ?? recorded;
      const changeType: 'EDITED' | 'RESTORED_TO_RECORDED' | 'REMOVED' = !after ? 'REMOVED' : provenanceValuesEqual(after, recorded) ? 'RESTORED_TO_RECORDED' : 'EDITED';

      await tx.clockShiftAdjustment.create({
        data: {
          clockShiftFragmentId: fragmentId,
          clockShiftId: frag.clockShiftId,
          employeeId: frag.employeeId,
          changeType,
          changedByUserId: deciderUserId,
          beforeStartAt: beforeValues.startAt,
          beforeEndAt: beforeValues.endAt,
          beforeSiteId: beforeValues.siteId,
          beforeWorkAreaId: beforeValues.workAreaId,
          beforeSourceAssignmentId: beforeValues.sourceAssignmentId,
          afterStartAt: after?.startAt ?? null,
          afterEndAt: after?.endAt ?? null,
          afterSiteId: after?.siteId ?? null,
          afterWorkAreaId: after?.workAreaId ?? null,
          afterSourceAssignmentId: after?.sourceAssignmentId ?? null,
          reason: request.reason,
          requestId
        }
      });
    }

    if (affectedShiftIds.length > 0) {
      await resolveOverlapsForAffectedShifts(tx, affectedShiftIds, beforeRangesByShift, requestId);
    }

    const pendingExport = request.timesheet.period.status === 'EXPORTED';

    await tx.correctionRequest.update({
      where: { id: correctionRequestId },
      data: {
        status: 'APPROVED',
        decidedByUserId: deciderUserId,
        decidedAt: new Date(),
        resultingVersionId: version.id,
        approvalOverride,
        overrideReason: approvalOverride ? overrideReason : null,
        pendingExport
      }
    });

    if (approvalOverride) {
      await createAuditEvent(tx, {
        actorUserId: deciderUserId,
        eventType: 'CORRECTION_SELF_APPROVED_OVERRIDE',
        entityType: 'CORRECTION_REQUEST',
        entityId: correctionRequestId,
        requestId,
        reason: overrideReason,
        beforeValue: { status: 'SUBMITTED' },
        afterValue: { status: 'APPROVED', resultingVersionId: version.id, override: true }
      });
    } else {
      await createAuditEvent(tx, {
        actorUserId: deciderUserId,
        eventType: 'CORRECTION_APPROVED',
        entityType: 'CORRECTION_REQUEST',
        entityId: correctionRequestId,
        requestId,
        beforeValue: { status: 'SUBMITTED' },
        afterValue: { status: 'APPROVED', resultingVersionId: version.id }
      });
    }

    return { status: 'APPROVED' as const, resultingVersionId: version.id };
  });

  if ('code' in outcome) {
    return outcome;
  }

  return { correctionRequestId, status: outcome.status, resultingVersionId: outcome.resultingVersionId };
}

// ============================================================================
// Reads
// ============================================================================

export interface CorrectionListItem {
  id: string;
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  status: string;
  reason: string;
  createdAt: string;
}

export async function listCorrections(status?: string): Promise<CorrectionListItem[]> {
  const requests = await prisma.correctionRequest.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      timesheetId: true,
      status: true,
      reason: true,
      createdAt: true,
      timesheet: { select: { employeeId: true, employee: { select: { firstName: true, lastName: true } } } }
    }
  });
  return requests.map((r) => ({
    id: r.id,
    timesheetId: r.timesheetId,
    employeeId: r.timesheet.employeeId,
    employeeName: `${r.timesheet.employee.firstName} ${r.timesheet.employee.lastName}`,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt.toISOString()
  }));
}

export interface CorrectionDetail {
  id: string;
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  status: string;
  reason: string;
  draftId: string | null;
  basedOnVersionId: string | null;
  openedByUserId: string | null;
  decidedByUserId: string | null;
  resultingVersionId: string | null;
  approvalOverride: boolean;
  overrideReason: string | null;
  days: CorrectionDayView[];
}

export async function getCorrectionDetail(correctionRequestId: string): Promise<CorrectionDetail | null> {
  const request = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: {
      id: true,
      timesheetId: true,
      status: true,
      reason: true,
      draftId: true,
      decidedByUserId: true,
      resultingVersionId: true,
      approvalOverride: true,
      overrideReason: true,
      timesheet: { select: { employeeId: true, employee: { select: { firstName: true, lastName: true } } } },
      draftOwner: {
        select: {
          id: true,
          basedOnVersionId: true,
          openedByUserId: true,
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
                  originClockShiftFragmentId: true,
                  breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
                }
              }
            }
          }
        }
      }
    }
  });
  if (!request) {
    return null;
  }

  return {
    id: request.id,
    timesheetId: request.timesheetId,
    employeeId: request.timesheet.employeeId,
    employeeName: `${request.timesheet.employee.firstName} ${request.timesheet.employee.lastName}`,
    status: request.status,
    reason: request.reason,
    draftId: request.draftId,
    basedOnVersionId: request.draftOwner?.basedOnVersionId ?? null,
    openedByUserId: request.draftOwner?.openedByUserId ?? null,
    decidedByUserId: request.decidedByUserId,
    resultingVersionId: request.resultingVersionId,
    approvalOverride: request.approvalOverride,
    overrideReason: request.overrideReason,
    days: (request.draftOwner?.days ?? []).map((d) => ({
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
        originClockShiftFragmentId: s.originClockShiftFragmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    }))
  };
}
