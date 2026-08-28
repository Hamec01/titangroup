import { Prisma, AbsenceType, DayType, SubmissionSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { effectiveReportedRangesBatch, resolveOverlapsForAffectedShifts, provenanceValuesEqual, type ProvenanceValues } from '@/lib/attendance-reported-projection';
import { submitWorkerTimesheetCore } from '@/lib/worker-timesheets';

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
 * Two timesheet states can carry a CorrectionRequest:
 *   - FINAL_APPROVED — the original post-approval correction (§4.7 "Поток"): the flow ends with
 *     TimesheetVersion(source=CORRECTION) and Timesheet.status stays FINAL_APPROVED. Applied via
 *     decideCorrection() with its four-eyes / approvalOverride / export-coupling rules.
 *   - SUBMITTED / FOREMAN_APPROVED — Task A (admin pre-final edit, 2026-08-27): the admin fixes a
 *     worker's still-under-review timesheet in place. Applied via applyInReviewCorrection(), which
 *     freezes a CORRECTION version authored by the admin and sends the timesheet BACK to SUBMITTED
 *     for a fresh review pass (owner decision: "обратно в очередь"). No four-eyes on the apply
 *     itself — the subsequent review IS the second pair of eyes; no export coupling — the period
 *     is still OPEN.
 * A DRAFT/RETURNED timesheet is still edited through the normal worker draft, never a correction.
 *
 * CORRECTION_ALREADY_OPEN is an app-level guard, not schema-mandated: nothing in the doc
 * forbids two open CorrectionRequests on the same timesheet at once, but allowing it would let
 * two drafts race to freeze two different resultingVersions from the same basedOnVersionId —
 * confusing, not useful. One request open (status NOT IN (APPROVED, REJECTED)) at a time.
 */
const CORRECTABLE_TIMESHEET_STATUSES = new Set(['SUBMITTED', 'FOREMAN_APPROVED', 'FINAL_APPROVED']);

/**
 * T12 — `directEdit` turns this into a no-reason admin direct edit (only valid for the in-review
 * path — SUBMITTED / FOREMAN_APPROVED). `reason` is stored empty, the CorrectionRequest row is
 * flagged, and applyInReviewCorrection later freezes a source=ADMIN_EDIT version with no worker
 * notice. A FINAL_APPROVED correction can never be a directEdit (decideCorrection ignores the flag).
 */
export async function requestCorrection(
  timesheetId: string,
  requestedByUserId: string,
  reason: string,
  requestId: string,
  opts: { directEdit?: boolean } = {}
): Promise<RequestCorrectionResult | RequestCorrectionError> {
  const directEdit = opts.directEdit === true;
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId }, select: { status: true } });
  if (!timesheet) {
    return { code: 'TIMESHEET_NOT_FOUND' };
  }
  if (!CORRECTABLE_TIMESHEET_STATUSES.has(timesheet.status)) {
    return { code: 'INVALID_STATE_TRANSITION' };
  }
  // A direct edit only makes sense while the period is still open and the timesheet under review —
  // never against a FINAL_APPROVED timesheet (that path has export coupling + four-eyes).
  if (directEdit && timesheet.status === 'FINAL_APPROVED') {
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
      data: { timesheetId, requestedByUserId, reason: directEdit ? '' : reason, status: 'PENDING', directEdit }
    });

    await createAuditEvent(tx, {
      actorUserId: requestedByUserId,
      eventType: directEdit ? 'TIMESHEET_ADMIN_EDIT_STARTED' : 'CORRECTION_REQUESTED',
      entityType: 'CORRECTION_REQUEST',
      entityId: request.id,
      requestId,
      beforeValue: null,
      afterValue: { id: request.id, timesheetId, reason: directEdit ? null : reason, directEdit }
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

/** Copy a TimesheetVersion's day/segment/break content into a (freshly emptied) CorrectionDraft —
 * the correction's starting point. Mirrors lib/review-scopes.ts's reinitializeDraftFromVersion. */
async function seedCorrectionDraftFromVersion(tx: Prisma.TransactionClient, draftId: string, employeeId: string, versionId: string): Promise<void> {
  await tx.correctionDraftDay.deleteMany({ where: { draftId } });

  const days = await tx.timesheetDay.findMany({
    where: { timesheetVersionId: versionId },
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
      data: { draftId, date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, sourceAbsenceId: day.sourceAbsenceId, note: day.note }
    });
    for (const seg of day.segments) {
      const newSegment = await tx.correctionDraftSegment.create({
        data: {
          draftDayId: newDay.id,
          draftId,
          employeeId,
          date: day.date,
          startAt: seg.startAt,
          endAt: seg.endAt,
          siteId: seg.siteId,
          workAreaId: seg.workAreaId,
          sourceAssignmentId: seg.sourceAssignmentId,
          // §15 п.8 — keep clock provenance so it isn't lost the moment the draft is opened.
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
}

/**
 * PENDING → DRAFT_OPEN: creates the CorrectionDraft, fixes basedOnVersionId to the timesheet's
 * current version, and copies that version's content in as the starting point.
 *
 * Already DRAFT_OPEN: idempotent re-open — BUT if the timesheet's current version has moved on
 * since the draft was opened (T12 — the worker was returned the timesheet and resubmitted a new
 * version while a stale admin edit sat open), the draft is re-seeded from the new current version
 * so "Продолжить исправление" never shows content that disagrees with the timesheet card.
 * Anything else (SUBMITTED, APPROVED, REJECTED) is not re-openable from here.
 */
export async function openCorrectionDraft(correctionRequestId: string, actorUserId: string, requestId: string): Promise<OpenCorrectionDraftResult | OpenCorrectionDraftError> {
  const request = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { id: true, status: true, draftId: true, timesheetId: true, timesheet: { select: { employeeId: true, currentVersionId: true } }, draftOwner: { select: { id: true, basedOnVersionId: true } } }
  });
  if (!request) {
    return { code: 'NOT_FOUND' };
  }
  const currentVersionId = request.timesheet.currentVersionId;
  const employeeId = request.timesheet.employeeId;

  if (request.status === 'DRAFT_OPEN' && request.draftOwner) {
    if (currentVersionId && request.draftOwner.basedOnVersionId !== currentVersionId) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CorrectionRequest" WHERE id = ${correctionRequestId}::uuid FOR UPDATE`;
        await seedCorrectionDraftFromVersion(tx, request.draftOwner!.id, employeeId, currentVersionId);
        await tx.correctionDraft.update({ where: { id: request.draftOwner!.id }, data: { basedOnVersionId: currentVersionId } });
        await createAuditEvent(tx, {
          actorUserId,
          eventType: 'CORRECTION_DRAFT_RESEEDED',
          entityType: 'CORRECTION_REQUEST',
          entityId: correctionRequestId,
          requestId,
          beforeValue: { basedOnVersionId: request.draftOwner!.basedOnVersionId },
          afterValue: { basedOnVersionId: currentVersionId }
        });
      });
    }
    return { correctionRequestId, draftId: request.draftOwner.id, status: 'DRAFT_OPEN' };
  }
  if (request.status !== 'PENDING' || !currentVersionId) {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  const basedOnVersionId = currentVersionId;

  const draftId = await prisma.$transaction(async (tx) => {
    const draft = await tx.correctionDraft.create({
      data: { correctionRequestId, employeeId, basedOnVersionId, openedByUserId: actorUserId }
    });
    await seedCorrectionDraftFromVersion(tx, draft.id, employeeId, basedOnVersionId);
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
 * `originClockShiftFragmentId` is accepted when it's already live on THIS draft's THIS day
 * (`previousLive`, read under lock, before any mutation) — the same membership discipline as
 * worker PATCH (§10.2 шаг 2a). The single narrow extension is §9.5 FINAL_APPROVED late sync: a
 * fragment with a matching OPEN `LATE_SYNC_AFTER_SUBMIT` for this employee/timesheet/date may be
 * bound for the first time here because the automatic materializer intentionally created no live
 * segment. No `ClockShiftAdjustment` is written at this stage — the correction isn't approved
 * yet (§15 п.7 does that, at freeze time).
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
export async function patchCorrectionDraftDay(
  correctionRequestId: string,
  date: Date,
  input: PatchDayInput,
  actorUserId?: string
): Promise<CorrectionDayView | PatchCorrectionDayError> {
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
        if (absence) {
          resolvedAbsenceId = absence.id;
        } else if (actorUserId) {
          // Task C (2026-08-27) — the admin marks a day «Больничный / Отпуск / Неоплачиваемый /
          // Другое» straight from the timesheet review, with an optional note. There is no
          // separate absence-approval workflow yet, so record a one-day APPROVED Absence here
          // (by this admin) that justifies the day type — same row lib/periods.ts's overlay
          // would consume. WORK <- non-WORK just drops sourceAbsenceId; the Absence row is left
          // (harmless, and still the audit trail of what the admin decided).
          const created = await tx.absence.create({
            data: {
              employeeId,
              type: input.dayType as AbsenceType,
              startDate: date,
              endDate: date,
              status: 'APPROVED',
              note: input.note ?? null,
              createdByUserId: actorUserId,
              approvedByUserId: actorUserId,
              approvedAt: new Date(),
              // ck_absence_status_metadata_shape requires both to be JSON arrays for an APPROVED
              // Absence. The regular overlay engine (lib/periods.ts) fills these when it stamps a
              // period's draft days; here the admin applies the day directly through the
              // correction (CorrectionDraftDay.sourceAbsenceId), so nothing was overlaid and there
              // are no conflicts.
              overlayAppliedDates: [],
              overlayConflicts: []
            }
          });
          await createAuditEvent(tx, {
            actorUserId,
            eventType: 'ABSENCE_CREATED',
            entityType: 'ABSENCE',
            entityId: created.id,
            requestId: correctionRequestId,
            beforeValue: null,
            afterValue: { employeeId, type: input.dayType, date: formatDate(date), viaTimesheetReview: true }
          });
          resolvedAbsenceId = created.id;
        } else {
          return { code: 'DAY_TYPE_REQUIRES_ABSENCE' as const };
        }
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
            // §9.5 "FINAL_APPROVED — явно не reopen" / task §I — a genuinely new late-arriving
            // fragment was never live in any prior version (so it can never appear in
            // previousLiveOriginIds), but is still legitimately referenceable here if it's the
            // origin of an OPEN LATE_SYNC_AFTER_SUBMIT exception belonging to THIS employee/
            // timesheet/date. Any other foreign fragment remains FORBIDDEN — this does not weaken
            // the ordinary provenance-membership check above, only adds one narrowly-scoped
            // additional allowance.
            const lateSyncMatch = await tx.attendanceException.findFirst({
              where: {
                type: 'LATE_SYNC_AFTER_SUBMIT',
                status: 'OPEN',
                employeeId,
                timesheetId: routing.timesheetId,
                clockShiftFragmentId: segment.originClockShiftFragmentId,
                clockShiftFragment: { date }
              },
              select: { id: true }
            });
            if (!lateSyncMatch) {
              return { code: 'FORBIDDEN' as const };
            }
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
// Task A — apply an admin's inline correction to a SUBMITTED / FOREMAN_APPROVED timesheet
// ============================================================================

export type ApplyInReviewCorrectionError = { code: 'NOT_FOUND' } | { code: 'INVALID_STATE_TRANSITION' };

export interface ApplyInReviewCorrectionResult {
  correctionRequestId: string;
  resultingVersionId: string;
  versionNumber: number;
  timesheetStatus: 'SUBMITTED';
}

/**
 * Task A (2026-08-27) — the pre-final counterpart of decideCorrection(). The admin opened a
 * CorrectionRequest on a still-under-review timesheet (requestCorrection now accepts SUBMITTED /
 * FOREMAN_APPROVED), edited days via patchCorrectionDraftDay, submitted it, and hit "Применить
 * изменения". This:
 *   1. rebuilds the worker's own TimesheetDraft from the CorrectionDraft content (days) plus the
 *      current version's planned shifts — the submit-freeze needs them, and WorkSegment's
 *      composite FK requires a matching TimesheetDraftPlannedShift per (date, sourceAssignmentId),
 *      so a zero placeholder is written for any assignment/date the plan doesn't cover (same trick
 *      decideCorrection uses on TimesheetPlannedShift);
 *   2. calls submitWorkerTimesheetCore with versionSource=CORRECTION + note=reason +
 *      forceScopesPending — freezes exactly one new TimesheetVersion, recreates every review scope
 *      as PENDING, and sets Timesheet.status = SUBMITTED ("обратно в очередь" — owner decision);
 *   3. closes the CorrectionRequest (APPROVED, resultingVersionId, decidedBy = the admin).
 *
 * No four-eyes / approvalOverride (unlike decideCorrection): the subsequent review pass IS the
 * second pair of eyes. No export coupling: a pre-final timesheet's period is still OPEN. The
 * "no actual changes" case can't reach here — submitCorrection already rejects it with
 * NO_CORRECTION_CHANGES before the correction reaches status SUBMITTED.
 */
export async function applyInReviewCorrection(
  correctionRequestId: string,
  adminUserId: string,
  requestId: string
): Promise<ApplyInReviewCorrectionResult | ApplyInReviewCorrectionError> {
  const routing = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { timesheetId: true, timesheet: { select: { employeeId: true } } }
  });
  if (!routing) {
    return { code: 'NOT_FOUND' };
  }
  const { timesheetId } = routing;
  const employeeId = routing.timesheet.employeeId;

  const outcome = await prisma.$transaction(async (tx): Promise<ApplyInReviewCorrectionError | { resultingVersionId: string; versionNumber: number }> => {
    // §8.1 canonical lock order: Employee -> Timesheet -> draft/correction rows.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "CorrectionRequest" WHERE id = ${correctionRequestId}::uuid FOR UPDATE`;

    const request = await tx.correctionRequest.findUniqueOrThrow({
      where: { id: correctionRequestId },
      select: {
        status: true,
        reason: true,
        directEdit: true,
        draftOwner: { select: { id: true } },
        timesheet: { select: { status: true, currentVersionId: true, draft: { select: { id: true } } } }
      }
    });
    if (!request.draftOwner || !request.timesheet.draft) {
      return { code: 'NOT_FOUND' as const };
    }
    if (request.status !== 'SUBMITTED') {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }
    if (request.timesheet.status !== 'SUBMITTED' && request.timesheet.status !== 'FOREMAN_APPROVED') {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }
    const currentVersionId = request.timesheet.currentVersionId;
    if (!currentVersionId) {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }
    const workerDraftId = request.timesheet.draft.id;
    const correctionDraftId = request.draftOwner.id;

    // --- 1. Rebuild the worker's TimesheetDraft from the correction content + the current plan ---
    await tx.timesheetDraftDay.deleteMany({ where: { draftId: workerDraftId } });
    await tx.timesheetDraftPlannedShift.deleteMany({ where: { draftId: workerDraftId } });

    const correctionDays = await tx.correctionDraftDay.findMany({
      where: { draftId: correctionDraftId },
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

    const versionPlannedShifts = await tx.timesheetPlannedShift.findMany({
      where: { timesheetVersionId: currentVersionId },
      select: { date: true, siteId: true, sourceAssignmentId: true, templateVersionDayId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
    });

    const plannedByKey = new Map<
      string,
      { date: Date; siteId: string; sourceAssignmentId: string; templateVersionDayId: string | null; plannedStartAt: Date | null; plannedEndAt: Date | null; plannedBreakMinutes: number }
    >();
    for (const p of versionPlannedShifts) {
      plannedByKey.set(`${formatDate(p.date)}::${p.sourceAssignmentId}`, p);
    }
    // Zero-planned placeholder for any (date, sourceAssignmentId) the correction touches that the
    // current plan doesn't cover — mirrors decideCorrection's TimesheetPlannedShift.upsert.
    for (const day of correctionDays) {
      for (const seg of day.segments) {
        const key = `${formatDate(day.date)}::${seg.sourceAssignmentId}`;
        if (!plannedByKey.has(key)) {
          plannedByKey.set(key, { date: day.date, siteId: seg.siteId, sourceAssignmentId: seg.sourceAssignmentId, templateVersionDayId: null, plannedStartAt: null, plannedEndAt: null, plannedBreakMinutes: 0 });
        }
      }
    }
    if (plannedByKey.size > 0) {
      await tx.timesheetDraftPlannedShift.createMany({
        data: [...plannedByKey.values()].map((p) => ({
          draftId: workerDraftId,
          employeeId,
          date: p.date,
          siteId: p.siteId,
          sourceAssignmentId: p.sourceAssignmentId,
          templateVersionDayId: p.templateVersionDayId,
          plannedStartAt: p.plannedStartAt,
          plannedEndAt: p.plannedEndAt,
          plannedBreakMinutes: p.plannedBreakMinutes
        }))
      });
    }

    for (const day of correctionDays) {
      const newDay = await tx.timesheetDraftDay.create({
        data: { draftId: workerDraftId, date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, sourceAbsenceId: day.sourceAbsenceId, note: day.note }
      });
      for (const seg of day.segments) {
        const newSegment = await tx.timesheetDraftSegment.create({
          data: {
            draftDayId: newDay.id,
            draftId: workerDraftId,
            employeeId,
            date: day.date,
            startAt: seg.startAt,
            endAt: seg.endAt,
            siteId: seg.siteId,
            workAreaId: seg.workAreaId,
            sourceAssignmentId: seg.sourceAssignmentId,
            originClockShiftFragmentId: seg.originClockShiftFragmentId
          }
        });
        if (seg.breaks.length > 0) {
          await tx.timesheetDraftBreakSegment.createMany({
            data: seg.breaks.map((b) => ({ draftSegmentId: newSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
          });
        }
      }
    }

    await tx.timesheetDraft.update({ where: { id: workerDraftId }, data: { basedOnVersionId: currentVersionId } });

    // --- 2. Freeze via the normal submit path: new version, all scopes PENDING, status SUBMITTED ---
    // T12 — a directEdit freezes source=ADMIN_EDIT with no note, so the worker's period screen shows
    // NO "Часы исправил администратор" notice; a normal correction stays source=CORRECTION + reason.
    const submit = await submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, requestId, SubmissionSource.MANUAL, {
      versionSource: request.directEdit ? 'ADMIN_EDIT' : 'CORRECTION',
      versionNote: request.directEdit ? null : request.reason,
      forceScopesPending: true
    });

    // --- 3. Close the correction ---
    await tx.correctionRequest.update({
      where: { id: correctionRequestId },
      data: { status: 'APPROVED', decidedByUserId: adminUserId, decidedAt: new Date(), resultingVersionId: submit.versionId }
    });

    await createAuditEvent(tx, {
      actorUserId: adminUserId,
      eventType: request.directEdit ? 'TIMESHEET_ADMIN_EDIT' : 'CORRECTION_APPROVED',
      entityType: 'CORRECTION_REQUEST',
      entityId: correctionRequestId,
      requestId,
      beforeValue: { status: 'SUBMITTED', timesheetStatus: request.timesheet.status },
      afterValue: { status: 'APPROVED', resultingVersionId: submit.versionId, timesheetStatus: 'SUBMITTED', appliedInReview: true, directEdit: request.directEdit }
    });

    return { resultingVersionId: submit.versionId, versionNumber: submit.versionNumber };
  });

  if ('code' in outcome) {
    return outcome;
  }
  return { correctionRequestId, resultingVersionId: outcome.resultingVersionId, versionNumber: outcome.versionNumber, timesheetStatus: 'SUBMITTED' };
}

export type DiscardInReviewCorrectionError = { code: 'NOT_FOUND' } | { code: 'INVALID_STATE_TRANSITION' };

/**
 * Task A — the admin started an inline correction on a SUBMITTED/FOREMAN_APPROVED timesheet, then
 * changed their mind. Marks the CorrectionRequest REJECTED (never applied, no version frozen);
 * the orphaned CorrectionDraft is harmless and left in place, same as a rejected post-final
 * correction's draft. Frees the timesheet for a fresh correction (CORRECTION_ALREADY_OPEN checks
 * status NOT IN (APPROVED, REJECTED)).
 */
export async function discardInReviewCorrection(
  correctionRequestId: string,
  adminUserId: string,
  requestId: string
): Promise<{ correctionRequestId: string; status: 'REJECTED' } | DiscardInReviewCorrectionError> {
  const routing = await prisma.correctionRequest.findUnique({
    where: { id: correctionRequestId },
    select: { timesheetId: true, timesheet: { select: { employeeId: true } } }
  });
  if (!routing) {
    return { code: 'NOT_FOUND' };
  }
  const { timesheetId } = routing;
  const employeeId = routing.timesheet.employeeId;

  const outcome = await prisma.$transaction(async (tx): Promise<DiscardInReviewCorrectionError | { status: 'REJECTED' }> => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "CorrectionRequest" WHERE id = ${correctionRequestId}::uuid FOR UPDATE`;

    const request = await tx.correctionRequest.findUniqueOrThrow({
      where: { id: correctionRequestId },
      select: { status: true, timesheet: { select: { status: true } } }
    });
    if (request.status !== 'PENDING' && request.status !== 'DRAFT_OPEN') {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }
    if (request.timesheet.status !== 'SUBMITTED' && request.timesheet.status !== 'FOREMAN_APPROVED') {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }

    await tx.correctionRequest.update({
      where: { id: correctionRequestId },
      data: { status: 'REJECTED', decidedByUserId: adminUserId, decidedAt: new Date() }
    });
    await createAuditEvent(tx, {
      actorUserId: adminUserId,
      eventType: 'CORRECTION_REJECTED',
      entityType: 'CORRECTION_REQUEST',
      entityId: correctionRequestId,
      requestId,
      beforeValue: { status: request.status },
      afterValue: { status: 'REJECTED', appliedInReview: true, discarded: true }
    });
    return { status: 'REJECTED' as const };
  });

  if ('code' in outcome) {
    return outcome;
  }
  return { correctionRequestId, status: 'REJECTED' };
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
        timesheet: {
          select: {
            employeeId: true,
            status: true,
            currentVersionId: true,
            periodId: true,
            period: { select: { status: true } },
            // §"Отложенный корректирующий экспорт" (03_DATA_MODEL_ERD.md) — pendingExport must
            // reflect whether this correction is actually representable in a future export
            // snapshot, not just "was the period already EXPORTED". An excluded participant
            // (expected=false) is structurally never part of any export population (FULL or
            // CORRECTION, T8_REPORTS_DESIGN.md §BA/§BC) — read here, under the same FOR UPDATE
            // lock as the rest of this authoritative state, not via a separate unlocked pre-read.
            participant: { select: { expected: true } }
          }
        }
      }
    });
    if (!request.draftOwner) {
      return { code: 'NOT_FOUND' as const };
    }
    if (request.status !== 'SUBMITTED') {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }
    // decideCorrection is the FINAL_APPROVED-only path (four-eyes, approvalOverride, export
    // coupling). A correction opened on a SUBMITTED/FOREMAN_APPROVED timesheet (Task A) is applied
    // through applyInReviewCorrection() instead and must never reach here.
    if (request.timesheet.status !== 'FINAL_APPROVED') {
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
    // any mutation. Ordinarily every after-origin was already live in this version. The one
    // intentional exception is §9.5's FINAL_APPROVED late-sync flow: an OPEN
    // LATE_SYNC_AFTER_SUBMIT permits the correction draft to bind a newly arrived fragment that
    // the automatic materializer was explicitly forbidden to insert into the final draft.
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
      const frag = fragmentsById.get(fragmentId)!;
      const recorded: ProvenanceValues = { startAt: frag.recordedStartAt, endAt: frag.recordedEndAt, siteId: frag.siteId, workAreaId: frag.workAreaId, sourceAssignmentId: frag.sourceAssignmentId };
      // Binding a FINAL_APPROVED late fragment at its exact recorded values changes no effective
      // reported provenance: before correction, a SETTLED fragment with no adjustment already
      // projects its recorded range; after correction the frozen segment says the same thing.
      // Do not manufacture a RESTORED_TO_RECORDED adjustment for that no-op binding.
      if (after && provenanceValuesEqual(before ?? recorded, after)) {
        continue;
      }
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

    // §9.5 "Разрешение LATE_SYNC_AFTER_SUBMIT" / task §I — the FINAL_APPROVED counterpart of
    // lib/worker-timesheets.ts's own resubmit-time resolution: a fragment's exception resolves
    // the moment it's actually frozen into a live WorkSegment of a new (CORRECTION) version.
    // `afterByFragment` already IS the set of origins this new version actually contains.
    const frozenOriginFragmentIds = new Set(afterByFragment.keys());
    if (frozenOriginFragmentIds.size > 0) {
      const openLateSyncExceptions = await tx.attendanceException.findMany({
        where: { type: 'LATE_SYNC_AFTER_SUBMIT', status: 'OPEN', employeeId, timesheetId: request.timesheetId },
        select: { id: true, clockShiftFragmentId: true }
      });
      const resolvableIds = openLateSyncExceptions.filter((e) => e.clockShiftFragmentId !== null && frozenOriginFragmentIds.has(e.clockShiftFragmentId)).map((e) => e.id);
      if (resolvableIds.length > 0) {
        // §13 — same reserved SYSTEM actor guard as everywhere else this project resolves an
        // exception structurally rather than through a human resolution action.
        const systemActor = await tx.user.findFirst({
          where: { userKind: 'SYSTEM', username: 'system.scheduler' },
          select: { id: true, status: true, passwordHash: true, employeeId: true }
        });
        if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
          throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
        }
        await tx.attendanceException.updateMany({
          where: { id: { in: resolvableIds } },
          data: { status: 'RESOLVED', resolvedByUserId: systemActor.id, resolvedAt: new Date(), resolutionNote: 'resolved by correction approval' }
        });
      }
    }

    // pendingExport means "a real export snapshot could cover this correction and hasn't yet" —
    // never just "this correction was approved after the period became EXPORTED". An excluded
    // participant's correction can never appear in any FULL/CORRECTION snapshot (population is
    // always expected=true only), so it must never be marked pending either — see the T8.4B
    // FOLLOW-UP note in T8_REPORTS_DESIGN.md.
    const pendingExport = request.timesheet.period.status === 'EXPORTED' && request.timesheet.participant.expected === true;

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
  directEdit: boolean;
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
      directEdit: true,
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
    directEdit: r.directEdit,
    createdAt: r.createdAt.toISOString()
  }));
}

export interface CorrectionDetail {
  id: string;
  timesheetId: string;
  /** Task A — SUBMITTED/FOREMAN_APPROVED means this is an in-review admin edit (apply via
   * applyInReviewCorrection); FINAL_APPROVED means the classic post-approval correction. */
  timesheetStatus: string;
  employeeId: string;
  employeeName: string;
  status: string;
  reason: string;
  /** T12 — no-reason admin direct edit (reason is empty, no worker notice on apply). */
  directEdit: boolean;
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
      directEdit: true,
      draftId: true,
      decidedByUserId: true,
      resultingVersionId: true,
      approvalOverride: true,
      overrideReason: true,
      timesheet: { select: { employeeId: true, status: true, employee: { select: { firstName: true, lastName: true } } } },
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
    timesheetStatus: request.timesheet.status,
    employeeId: request.timesheet.employeeId,
    employeeName: `${request.timesheet.employee.firstName} ${request.timesheet.employee.lastName}`,
    status: request.status,
    reason: request.reason,
    directEdit: request.directEdit,
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
