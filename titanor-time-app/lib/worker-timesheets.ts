import { createHash } from 'node:crypto';
import { Prisma, AbsenceType, DayType, SubmissionSource } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { helsinkiToday } from '@/lib/workers';
import { effectiveReportedRangesBatch, resolveOverlapsForAffectedShifts, provenanceValuesEqual, type ProvenanceValues } from '@/lib/attendance-reported-projection';

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

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 — "оба returnReason ... сохраняются и видны
// работнику одновременно": a version can have more than one RETURNED scope (two sites returned
// almost simultaneously), so every read here is an array, never a single "the" reason.

export interface CurrentVersionReviewScopeView {
  id: string;
  scopeType: string;
  scopePurpose: string | null;
  siteId: string | null;
  siteName: string | null;
  contextSiteId: string | null;
  contextSiteName: string | null;
  status: string;
  returnReason: string | null;
  reviewedAt: string | null;
}

/**
 * TimesheetReviewScope rows of exactly `timesheetVersionId` — never any other version. This is
 * what makes "old reasons don't show as current after resubmit" automatic: resubmitting creates a
 * new TimesheetVersion (03_...§4.6) with its own fresh (mostly PENDING) scopes and a new
 * Timesheet.currentVersionId; the previous version's now-historical RETURNED scopes are simply a
 * different timesheetVersionId and are never selected here again — no separate "is this stale"
 * check needed, and the old rows are never touched or deleted.
 */
async function loadCurrentVersionReviewScopes(timesheetVersionId: string): Promise<CurrentVersionReviewScopeView[]> {
  const scopes = await prisma.timesheetReviewScope.findMany({
    where: { timesheetVersionId },
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      scopeType: true,
      scopePurpose: true,
      siteId: true,
      contextSiteId: true,
      status: true,
      returnReason: true,
      reviewedAt: true,
      updatedAt: true,
      site: { select: { name: true } },
      contextSite: { select: { name: true } }
    }
  });

  return scopes.map((s) => ({
    id: s.id,
    scopeType: s.scopeType,
    scopePurpose: s.scopePurpose,
    siteId: s.siteId,
    siteName: s.site?.name ?? null,
    contextSiteId: s.contextSiteId,
    contextSiteName: s.contextSite?.name ?? null,
    status: s.status,
    returnReason: s.returnReason,
    // reviewedAt is always set together with returnReason/status=RETURNED by the review write
    // path — updatedAt is only a defensive fallback for the timestamp, never for the reason text
    // itself (a missing reason is never fabricated, see toReturnReasons below).
    reviewedAt: (s.reviewedAt ?? (s.status === 'RETURNED' ? s.updatedAt : null))?.toISOString() ?? null
  }));
}

export interface ReturnReasonView {
  scopeType: string;
  scopePurpose: string | null;
  siteId: string | null;
  siteName: string | null;
  contextSiteId: string | null;
  contextSiteName: string | null;
  reason: string;
  returnedAt: string | null;
}

/** Only scopes that are currently RETURNED with a non-null reason — never a single findFirst, so two returned SITE scopes of the same version both surface. */
function toReturnReasons(scopes: CurrentVersionReviewScopeView[]): ReturnReasonView[] {
  return scopes
    .filter((s) => s.status === 'RETURNED' && s.returnReason !== null)
    .map((s) => ({
      scopeType: s.scopeType,
      scopePurpose: s.scopePurpose,
      siteId: s.siteId,
      siteName: s.siteName,
      contextSiteId: s.contextSiteId,
      contextSiteName: s.contextSiteName,
      reason: s.returnReason!,
      returnedAt: s.reviewedAt
    }));
}

export interface TimesheetSummary {
  timesheetId: string;
  periodId: string;
  status: string;
  currentVersionId: string | null;
  /** RETURNED scopes of currentVersionId only — empty once resubmitted (new version, fresh scopes) or if never returned. */
  returnReasons: ReturnReasonView[];
}

export async function getWorkerTimesheetSummary(employeeId: string, timesheetId: string): Promise<TimesheetSummary | TimesheetAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  const t = result.timesheet;
  const returnReasons = t.currentVersionId ? toReturnReasons(await loadCurrentVersionReviewScopes(t.currentVersionId)) : [];
  return { timesheetId: t.id, periodId: t.periodId, status: t.status, currentVersionId: t.currentVersionId, returnReasons };
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
  confirmedZero: boolean;
  segments: SegmentView[];
}

export interface TimesheetCurrentVersionView {
  versionId: string;
  versionNumber: number;
  days: VersionDayView[];
  plannedShifts: PlannedShiftView[];
  // Additive over 04_ADMIN_FIRST_API_CONTRACTS.md §9's original `{ scopeType, siteId, status }` —
  // scopePurpose/siteName/contextSiteId/contextSiteName/returnReason/reviewedAt added so a worker-
  // facing consumer never has to look up a site name from a bare UUID itself. All scopes of this
  // version, any status — not filtered to RETURNED (callers filter for their own purpose; see
  // getWorkerTimesheetSummary's returnReasons above for the RETURNED-only view).
  reviewScopes: CurrentVersionReviewScopeView[];
}

/**
 * Available in ANY Timesheet status, unlike .../draft — currentVersionId is only ever set once
 * timesheet.submit runs, so this returns 404 TIMESHEET_NOT_FOUND for a never-submitted timesheet;
 * that's the contract's own documented behavior, not a bug. `reviewScopes` is real
 * TimesheetReviewScope data of this exact version (never a stale/other version's rows).
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

  if (!version) {
    return { code: 'NOT_FOUND' };
  }

  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    days: version.days.map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      // Not in 04_...§9's literal response shape for this endpoint (unlike .../draft, which does
      // list it) — added anyway: TimesheetDay really has this column, and omitting it makes a
      // confirmed-zero day indistinguishable from an unfilled one in the read-only view. Purely
      // additive, no existing consumer depends on the narrower shape.
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
    plannedShifts: version.plannedShifts.map((p) => ({
      date: formatDate(p.date),
      siteId: p.siteId,
      sourceAssignmentId: p.sourceAssignmentId,
      plannedStartAt: p.plannedStartAt ? p.plannedStartAt.toISOString() : null,
      plannedEndAt: p.plannedEndAt ? p.plannedEndAt.toISOString() : null,
      plannedBreakMinutes: p.plannedBreakMinutes
    })),
    reviewScopes: await loadCurrentVersionReviewScopes(version.id)
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
  originClockShiftFragmentId?: string | null;
}

export interface PatchDayInput {
  dayType?: string;
  confirmedZero?: boolean;
  note?: string | null;
  segments?: PatchSegmentInput[];
  clockAdjustmentReasons?: Record<string, string>;
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
 * §10.3/§15 п.2 — every DB read that affects ownership/state/day-validation/write happens inside
 * one transaction, behind `Employee` → `Timesheet` → `TimesheetDraft FOR UPDATE` (canonical order,
 * §8.1) taken as the very first actions. Only the two purely request-shape checks that never touch
 * the DB (segment-list self-overlap, break bounds) run before the transaction opens — nothing
 * about them can go stale between a pre-lock read and the write. Status/ownership are re-read
 * fresh under the lock, never trusted from a read taken before it.
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
 *
 * §10.1-10.3 — clock provenance. `segment.originClockShiftFragmentId` is always an echo of a
 * fragment already live on THIS day (`previousLive`, read before any mutation) — the server never
 * creates a new binding here, only the materializer (§9.4) ever does that first insert; an origin
 * not already in `previousLive` is a forbidden identity guess (403, no oracle), never a 404 (which
 * would leak whether the id exists at all). Editing or removing a clock-origin segment's
 * recorded-vs-reported values requires `clockAdjustmentReasons[fragmentId]` and appends one
 * immutable `ClockShiftAdjustment` (EDITED/RESTORED_TO_RECORDED/REMOVED) attributed to the real
 * worker `User`, never SYSTEM. After the existing delete/recreate step, the shared §9.1a helper
 * (`lib/attendance-reported-projection.ts`) resolves OVERLAPPING_SHIFT transitions for every shift
 * whose reported range could have changed — before/after origin fragments unioned, so a pure
 * REMOVED is never dropped from the affected set.
 */
export async function patchWorkerTimesheetDay(
  employeeId: string,
  actorUserId: string,
  timesheetId: string,
  date: Date,
  input: PatchDayInput,
  requestId: string
): Promise<(DraftDayView & { resolvedProposals: never[] }) | PatchDayError> {
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
    }
  }

  try {
    return await prisma.$transaction(async (tx): Promise<(DraftDayView & { resolvedProposals: never[] }) | PatchDayError> => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;

      const timesheet = await tx.timesheet.findUnique({ where: { id: timesheetId }, select: { employeeId: true, status: true } });
      if (!timesheet) {
        return { code: 'NOT_FOUND' };
      }
      if (timesheet.employeeId !== employeeId) {
        return { code: 'FORBIDDEN' };
      }
      if (timesheet.status !== 'DRAFT' && timesheet.status !== 'RETURNED') {
        return { code: 'DRAFT_NOT_EDITABLE' };
      }

      const draft = await tx.timesheetDraft.findUnique({ where: { timesheetId }, select: { id: true } });
      if (!draft) {
        return { code: 'NOT_FOUND' };
      }

      const currentDay = await tx.timesheetDraftDay.findUnique({
        where: { draftId_date: { draftId: draft.id, date } },
        select: { id: true, dayType: true, confirmedZero: true, segments: { select: { id: true } } }
      });
      if (!currentDay) {
        // Not named in 04_...§9's error list — a date outside this timesheet's own period never
        // got a TimesheetDraftDay row in the first place (period.create/assignment.create both
        // generate exactly one per period day), so this is a client input problem, not a
        // missing-resource one.
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
        const absence = await tx.absence.findFirst({
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
        for (const segment of input.segments) {
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
            return { code: 'SITE_NOT_ASSIGNED', siteId: segment.siteId };
          }
          resolvedSegments.push({ segment, sourceAssignmentId: assignment.id });
        }
      }

      // §10.2 — previousLive (before any mutation): fragments already live on this day.
      const previousLiveRows = await tx.timesheetDraftSegment.findMany({
        where: { draftDayId: currentDay.id, originClockShiftFragmentId: { not: null } },
        select: { originClockShiftFragmentId: true, startAt: true, endAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true }
      });
      const previousLive = new Map(previousLiveRows.map((s) => [s.originClockShiftFragmentId as string, s]));

      const incomingOriginIds: string[] = [];
      const seenOriginIds = new Set<string>();
      if (input.segments !== undefined) {
        for (const segment of input.segments) {
          const originId = segment.originClockShiftFragmentId;
          if (!originId) {
            continue;
          }
          if (seenOriginIds.has(originId)) {
            return { code: 'VALIDATION_ERROR', fieldErrors: { originClockShiftFragmentId: ['duplicate origin in segments[]'] } };
          }
          seenOriginIds.add(originId);
          if (!previousLive.has(originId)) {
            return { code: 'FORBIDDEN' };
          }
          incomingOriginIds.push(originId);
        }
      }

      const affectedFragmentIds = [...new Set([...previousLive.keys(), ...incomingOriginIds])];

      const fragmentsById = new Map<
        string,
        { id: string; clockShiftId: string; employeeId: string; recordedStartAt: Date; recordedEndAt: Date; siteId: string; workAreaId: string | null; sourceAssignmentId: string | null }
      >();
      const lastKnownByFragment = new Map<string, ProvenanceValues>();
      if (affectedFragmentIds.length > 0) {
        const fragmentRows = await tx.clockShiftFragment.findMany({
          where: { id: { in: affectedFragmentIds } },
          select: { id: true, clockShiftId: true, employeeId: true, recordedStartAt: true, recordedEndAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true }
        });
        for (const f of fragmentRows) {
          fragmentsById.set(f.id, f);
        }

        const lastAdjustments = await tx.clockShiftAdjustment.findMany({
          where: { clockShiftFragmentId: { in: affectedFragmentIds } },
          orderBy: { changedAt: 'desc' },
          select: { clockShiftFragmentId: true, afterStartAt: true, afterEndAt: true, afterSiteId: true, afterWorkAreaId: true, afterSourceAssignmentId: true }
        });
        for (const adj of lastAdjustments) {
          // previousLive/incoming are always currently-live fragments (never REMOVED — a removed
          // origin can never reappear, §10.2), so the most recent adjustment for any fragment here
          // is always EDITED/RESTORED_TO_RECORDED, whose after* fields are never null.
          if (!lastKnownByFragment.has(adj.clockShiftFragmentId) && adj.afterStartAt && adj.afterEndAt && adj.afterSiteId) {
            lastKnownByFragment.set(adj.clockShiftFragmentId, {
              startAt: adj.afterStartAt,
              endAt: adj.afterEndAt,
              siteId: adj.afterSiteId,
              workAreaId: adj.afterWorkAreaId,
              sourceAssignmentId: adj.afterSourceAssignmentId
            });
          }
        }
      }

      function lastKnownFor(fragmentId: string): ProvenanceValues {
        const known = lastKnownByFragment.get(fragmentId);
        if (known) {
          return known;
        }
        const frag = fragmentsById.get(fragmentId)!;
        return { startAt: frag.recordedStartAt, endAt: frag.recordedEndAt, siteId: frag.siteId, workAreaId: frag.workAreaId, sourceAssignmentId: frag.sourceAssignmentId };
      }

      interface AdjustmentDraft {
        clockShiftFragmentId: string;
        changeType: 'EDITED' | 'RESTORED_TO_RECORDED' | 'REMOVED';
        before: ProvenanceValues;
        after: ProvenanceValues | null;
        reason: string;
      }
      const adjustmentDrafts: AdjustmentDraft[] = [];
      const clockAdjustmentReasons = input.clockAdjustmentReasons ?? {};

      for (const { segment, sourceAssignmentId } of resolvedSegments) {
        const originId = segment.originClockShiftFragmentId;
        if (!originId) {
          continue;
        }
        const lastKnown = lastKnownFor(originId);
        const after: ProvenanceValues = { startAt: segment.startAt, endAt: segment.endAt, siteId: segment.siteId, workAreaId: segment.workAreaId, sourceAssignmentId };
        if (provenanceValuesEqual(lastKnown, after)) {
          continue;
        }
        const reason = clockAdjustmentReasons[originId];
        if (!reason || reason.trim().length === 0) {
          return { code: 'VALIDATION_ERROR', fieldErrors: { [`clockAdjustmentReasons.${originId}`]: ['required when changing a clock-origin segment'] } };
        }
        const frag = fragmentsById.get(originId)!;
        const recorded: ProvenanceValues = { startAt: frag.recordedStartAt, endAt: frag.recordedEndAt, siteId: frag.siteId, workAreaId: frag.workAreaId, sourceAssignmentId: frag.sourceAssignmentId };
        adjustmentDrafts.push({
          clockShiftFragmentId: originId,
          changeType: provenanceValuesEqual(after, recorded) ? 'RESTORED_TO_RECORDED' : 'EDITED',
          before: lastKnown,
          after,
          reason
        });
      }

      if (input.segments !== undefined) {
        for (const [originId, prev] of previousLive) {
          if (seenOriginIds.has(originId)) {
            continue;
          }
          const reason = clockAdjustmentReasons[originId];
          if (!reason || reason.trim().length === 0) {
            return { code: 'VALIDATION_ERROR', fieldErrors: { [`clockAdjustmentReasons.${originId}`]: ['required when removing a clock-origin segment'] } };
          }
          adjustmentDrafts.push({
            clockShiftFragmentId: originId,
            changeType: 'REMOVED',
            before: { startAt: prev.startAt, endAt: prev.endAt, siteId: prev.siteId, workAreaId: prev.workAreaId, sourceAssignmentId: prev.sourceAssignmentId },
            after: null,
            reason
          });
        }
      }

      const affectedShiftIds = [...new Set(affectedFragmentIds.map((id) => fragmentsById.get(id)!.clockShiftId))];
      const beforeRangesByShift = await effectiveReportedRangesBatch(tx, affectedShiftIds);

      for (const adjustment of adjustmentDrafts) {
        const frag = fragmentsById.get(adjustment.clockShiftFragmentId)!;
        await tx.clockShiftAdjustment.create({
          data: {
            clockShiftFragmentId: adjustment.clockShiftFragmentId,
            clockShiftId: frag.clockShiftId,
            employeeId: frag.employeeId,
            changeType: adjustment.changeType,
            changedByUserId: actorUserId,
            beforeStartAt: adjustment.before.startAt,
            beforeEndAt: adjustment.before.endAt,
            beforeSiteId: adjustment.before.siteId,
            beforeWorkAreaId: adjustment.before.workAreaId,
            beforeSourceAssignmentId: adjustment.before.sourceAssignmentId,
            afterStartAt: adjustment.after?.startAt ?? null,
            afterEndAt: adjustment.after?.endAt ?? null,
            afterSiteId: adjustment.after?.siteId ?? null,
            afterWorkAreaId: adjustment.after?.workAreaId ?? null,
            afterSourceAssignmentId: adjustment.after?.sourceAssignmentId ?? null,
            reason: adjustment.reason,
            requestId
          }
        });
      }

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
              sourceAssignmentId,
              originClockShiftFragmentId: segment.originClockShiftFragmentId ?? null
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

      if (affectedShiftIds.length > 0) {
        await resolveOverlapsForAffectedShifts(tx, affectedShiftIds, beforeRangesByShift, requestId);
      }

      const updatedDay = await tx.timesheetDraftDay.findUniqueOrThrow({
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
    });
  } catch (error) {
    if (isSegmentOverlapViolation(error)) {
      return { code: 'WORK_SEGMENT_OVERLAP' };
    }
    throw error;
  }
}

// ============================================================================
// timesheet.submit (04_...§9, 03_...§4.6) — ЭТАП 7 sub-task 4.
//
// TimesheetReviewProposal doesn't exist yet (created only by scope.return, a later sub-task), so
// the "финальная сверка предложений" step and the 409 UNRESOLVED_PROPOSALS precondition are both
// omitted entirely — not stubbed, genuinely inapplicable: no proposal can exist before that
// subsystem does, on the only reachable transition today (DRAFT/RETURNED → SUBMITTED, and nothing
// has ever produced a RETURNED timesheet yet either).
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

function computeContentHash(projection: unknown): string {
  return createHash('sha256').update(canonicalStringify(projection)).digest('hex');
}

/** Helsinki-local calendar date (YYYY-MM-DD) of a UTC instant — same technique as lib/workers.ts's helsinkiToday(), applied to an arbitrary instant instead of "now". */
function helsinkiLocalDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(instant);
}

interface FrozenBreak {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}
interface FrozenSegment {
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  startAt: Date;
  endAt: Date;
  breaks: FrozenBreak[];
}
interface FrozenDay {
  date: Date;
  dayType: string;
  confirmedZero: boolean;
  note: string | null;
  segments: FrozenSegment[];
}
interface FrozenPlannedShift {
  date: Date;
  siteId: string;
  sourceAssignmentId: string;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  plannedBreakMinutes: number;
}

/** 03_...§4.6 "Каноническая проекция для contentHash" — one SITE scope's content: assignment-groups sorted by sourceAssignmentId, each with plannedShifts (every date in the period∩assignment intersection, including non-working days) and actualDays (only dates with ≥1 WorkSegment). */
function canonicalSiteProjection(siteId: string, days: FrozenDay[], plannedShifts: FrozenPlannedShift[]): unknown {
  const assignmentIds = new Set<string>();
  for (const ps of plannedShifts) {
    if (ps.siteId === siteId) assignmentIds.add(ps.sourceAssignmentId);
  }
  for (const day of days) {
    for (const seg of day.segments) {
      if (seg.siteId === siteId) assignmentIds.add(seg.sourceAssignmentId);
    }
  }

  return [...assignmentIds].sort().map((sourceAssignmentId) => {
    const groupPlannedShifts = plannedShifts
      .filter((ps) => ps.siteId === siteId && ps.sourceAssignmentId === sourceAssignmentId)
      .slice()
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((ps) => ({
        date: formatDate(ps.date),
        plannedStartAt: ps.plannedStartAt ? ps.plannedStartAt.toISOString() : null,
        plannedEndAt: ps.plannedEndAt ? ps.plannedEndAt.toISOString() : null,
        plannedBreakMinutes: ps.plannedBreakMinutes
      }));

    const actualDays = days
      .map((day) => {
        const segs = day.segments.filter((s) => s.siteId === siteId && s.sourceAssignmentId === sourceAssignmentId);
        if (segs.length === 0) {
          return null;
        }
        return {
          date: formatDate(day.date),
          segments: segs
            .slice()
            .sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime())
            .map((s) => ({
              startAt: s.startAt.toISOString(),
              endAt: s.endAt.toISOString(),
              workAreaId: s.workAreaId,
              breaks: s.breaks
                .slice()
                .sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime())
                .map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
            }))
        };
      })
      .filter((d) => d !== null)
      .sort((a, b) => a.date.localeCompare(b.date));

    return { sourceAssignmentId, plannedShifts: groupPlannedShifts, actualDays };
  });
}

/** 03_...§4.6 — NON_SITE(DATA) scope's content: sorted-by-date {date, dayType, note} for type-B days only. */
function canonicalNonSiteDataProjection(nonSiteDataDays: FrozenDay[]): unknown {
  return nonSiteDataDays
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((d) => ({ date: formatDate(d.date), dayType: d.dayType, note: d.note }));
}

/** 03_...§4.6 carry-forward rule: unchanged APPROVED carries forward (with carriedFromScopeId); a RETURNED scope always resets to PENDING; anything else (new site, or contentHash changed) is a fresh PENDING. */
function decideScopeCarryForward(
  previous: { id: string; status: string; contentHash: string } | undefined,
  newContentHash: string
): { status: 'PENDING' | 'APPROVED'; carriedFromScopeId: string | null } {
  if (previous && previous.status === 'APPROVED' && previous.contentHash === newContentHash) {
    return { status: 'APPROVED', carriedFromScopeId: previous.id };
  }
  return { status: 'PENDING', carriedFromScopeId: null };
}

async function resolvePrimarySiteId(tx: Prisma.TransactionClient, employeeId: string): Promise<string | null> {
  const today = helsinkiToday();
  const assignment = await tx.siteAssignment.findFirst({
    where: { employeeId, isPrimary: true, validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
    select: { siteId: true }
  });
  return assignment?.siteId ?? null;
}

export interface SubmitResult {
  timesheetId: string;
  status: 'SUBMITTED';
  versionId: string;
  versionNumber: number;
}

export type SubmitError = TimesheetAccessError | { code: 'INVALID_STATE_TRANSITION' };

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.5/§9.6/§15 п.1 — the single point that
 * ever freezes a TimesheetVersion (manual submit today; auto-submit, §9.6, is a future slice that
 * will call this same function). Takes `tx` from the caller and never opens its own transaction —
 * the caller is responsible for holding `Employee`/`Timesheet`/`TimesheetDraft FOR UPDATE` in
 * canonical order (§8.1) before calling this. Body is otherwise the pre-existing submit logic,
 * unchanged, plus: `submissionSource` is written onto the new version, `TimesheetDraftSegment.
 * originClockShiftFragmentId` is copied onto the frozen `WorkSegment`, and — immediately before
 * returning — any `AttendanceException(LATE_SYNC_AFTER_SUBMIT, OPEN)` of this employee/timesheet/
 * payrollPeriod whose `clockShiftFragmentId` is now represented among this version's frozen
 * `WorkSegment.originClockShiftFragmentId` is resolved (§9.5 "Разрешение LATE_SYNC_AFTER_SUBMIT").
 */
export async function submitWorkerTimesheetCore(
  tx: Prisma.TransactionClient,
  employeeId: string,
  timesheetId: string,
  actorUserId: string,
  requestId: string,
  submissionSource: SubmissionSource
): Promise<SubmitResult> {
  const previousTimesheet = await tx.timesheet.findUniqueOrThrow({ where: { id: timesheetId }, select: { status: true } });
  const previousStatus = previousTimesheet.status;

  const draft = await tx.timesheetDraft.findUniqueOrThrow({
    where: { timesheetId },
    select: {
      id: true,
      timesheet: { select: { periodId: true } },
      days: {
        select: {
          date: true,
          dayType: true,
          confirmedZero: true,
          sourceAbsenceId: true,
          note: true,
          segments: {
            select: {
              startAt: true,
              endAt: true,
              siteId: true,
              workAreaId: true,
              sourceAssignmentId: true,
              originClockShiftFragmentId: true,
              breaks: { select: { startAt: true, endAt: true, paid: true } }
            }
          }
        }
      },
      plannedShifts: {
        select: { date: true, siteId: true, sourceAssignmentId: true, templateVersionDayId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
      }
    }
  });

  const lastVersion = await tx.timesheetVersion.findFirst({
    where: { timesheetId },
    orderBy: { versionNumber: 'desc' },
    select: { id: true, versionNumber: true }
  });
  const versionNumber = (lastVersion?.versionNumber ?? 0) + 1;

  const version = await tx.timesheetVersion.create({
    data: { timesheetId, employeeId, versionNumber, source: 'WORKER', createdByUserId: actorUserId, submissionSource }
  });

  // TimesheetPlannedShift must be frozen before any WorkSegment — WorkSegment's composite FK
  // (timesheetVersionId, date, sourceAssignmentId) requires the matching planned-shift row to
  // already exist, same as TimesheetDraftSegment's FK onto TimesheetDraftPlannedShift (found
  // the hard way on disposable PostgreSQL 16 while testing this function: freezing days/segments
  // first threw P2003 on the very first segment).
  const frozenPlannedShifts: FrozenPlannedShift[] = draft.plannedShifts.map((p) => ({
    date: p.date,
    siteId: p.siteId,
    sourceAssignmentId: p.sourceAssignmentId,
    plannedStartAt: p.plannedStartAt,
    plannedEndAt: p.plannedEndAt,
    plannedBreakMinutes: p.plannedBreakMinutes
  }));
  if (draft.plannedShifts.length > 0) {
    await tx.timesheetPlannedShift.createMany({
      data: draft.plannedShifts.map((p) => ({
        timesheetVersionId: version.id,
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

  const frozenDays: FrozenDay[] = [];
  // §9.5/§15 п.1 — clock-origin fragments actually frozen into a live WorkSegment of this
  // version; feeds the LATE_SYNC_AFTER_SUBMIT resolution scan below.
  const frozenOriginFragmentIds = new Set<string>();
  for (const day of draft.days) {
    const newDay = await tx.timesheetDay.create({
      data: { timesheetVersionId: version.id, date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, sourceAbsenceId: day.sourceAbsenceId, note: day.note }
    });
    const frozenSegments: FrozenSegment[] = [];
    for (const seg of day.segments) {
      const crossesMidnight = helsinkiLocalDate(seg.endAt) !== formatDate(day.date);
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
          originClockShiftFragmentId: seg.originClockShiftFragmentId,
          crossesMidnight
        }
      });
      if (seg.breaks.length > 0) {
        await tx.breakSegment.createMany({
          data: seg.breaks.map((b) => ({ workSegmentId: newSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
        });
      }
      if (seg.originClockShiftFragmentId) {
        frozenOriginFragmentIds.add(seg.originClockShiftFragmentId);
      }
      frozenSegments.push({ siteId: seg.siteId, workAreaId: seg.workAreaId, sourceAssignmentId: seg.sourceAssignmentId, startAt: seg.startAt, endAt: seg.endAt, breaks: seg.breaks });
    }
    frozenDays.push({ date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, note: day.note, segments: frozenSegments });
  }

  // --- Classify days (03_...§4.6, "Алгоритм формирования набора scope") ---
  const siteIdsWithData = new Set<string>();
  for (const day of frozenDays) {
    for (const seg of day.segments) siteIdsWithData.add(seg.siteId);
  }
  const nonSiteDataDays = frozenDays.filter((d) => d.dayType !== 'WORK' || d.confirmedZero);

  const previousSiteScopes = lastVersion
    ? await tx.timesheetReviewScope.findMany({ where: { timesheetVersionId: lastVersion.id, scopeType: 'SITE' }, select: { id: true, siteId: true, status: true, contentHash: true } })
    : [];
  const previousSiteScopeBySite = new Map(previousSiteScopes.map((s) => [s.siteId as string, s]));
  const allSiteIds = new Set<string>([...siteIdsWithData, ...previousSiteScopeBySite.keys()]);

  for (const siteId of allSiteIds) {
    const contentHash = computeContentHash(canonicalSiteProjection(siteId, frozenDays, frozenPlannedShifts));
    const previous = previousSiteScopeBySite.get(siteId);
    const { status, carriedFromScopeId } = decideScopeCarryForward(previous, contentHash);
    await tx.timesheetReviewScope.create({
      data: { timesheetVersionId: version.id, scopeType: 'SITE', siteId, status, contentHash, carriedFromScopeId }
    });
  }

  const previousNonSiteDataScope = lastVersion
    ? await tx.timesheetReviewScope.findFirst({
        where: { timesheetVersionId: lastVersion.id, scopeType: 'NON_SITE', scopePurpose: 'DATA' },
        select: { id: true, status: true, contentHash: true }
      })
    : null;
  const hasNonSiteData = nonSiteDataDays.length > 0;

  if (hasNonSiteData || previousNonSiteDataScope) {
    const contentHash = computeContentHash(canonicalNonSiteDataProjection(nonSiteDataDays));
    const { status, carriedFromScopeId } = decideScopeCarryForward(previousNonSiteDataScope ?? undefined, contentHash);
    const contextSiteId = await resolvePrimarySiteId(tx, employeeId);
    await tx.timesheetReviewScope.create({
      data: { timesheetVersionId: version.id, scopeType: 'NON_SITE', scopePurpose: 'DATA', contextSiteId, status, contentHash, carriedFromScopeId }
    });
  } else if (allSiteIds.size === 0) {
    const contentHash = computeContentHash({ empty: true });
    const contextSiteId = await resolvePrimarySiteId(tx, employeeId);
    await tx.timesheetReviewScope.create({
      data: { timesheetVersionId: version.id, scopeType: 'NON_SITE', scopePurpose: 'EMPTY_FALLBACK', contextSiteId, status: 'PENDING', contentHash }
    });
  }

  // --- Clear draft content (container itself stays) and flip Timesheet status ---
  await tx.timesheetDraftDay.deleteMany({ where: { draftId: draft.id } });
  await tx.timesheetDraftPlannedShift.deleteMany({ where: { draftId: draft.id } });

  await tx.timesheet.update({ where: { id: timesheetId }, data: { status: 'SUBMITTED', currentVersionId: version.id } });

  await createAuditEvent(tx, {
    actorUserId,
    eventType: 'TIMESHEET_SUBMITTED',
    entityType: 'TIMESHEET',
    entityId: timesheetId,
    requestId,
    beforeValue: { status: previousStatus },
    afterValue: { status: 'SUBMITTED', versionId: version.id, versionNumber }
  });

  // §9.5 "Разрешение LATE_SYNC_AFTER_SUBMIT" — structural resolution, not one of the six
  // resolution-actions (§11): a fragment's exception resolves the moment it's actually frozen
  // into a live WorkSegment of a new version. Only queried when this version actually froze at
  // least one clock-origin segment — an ordinary manual submit with none never pays this extra
  // lookup or needs the SYSTEM actor to exist at all.
  if (frozenOriginFragmentIds.size > 0) {
    const openLateSyncExceptions = await tx.attendanceException.findMany({
      where: {
        type: 'LATE_SYNC_AFTER_SUBMIT',
        status: 'OPEN',
        employeeId,
        timesheetId,
        payrollPeriodId: draft.timesheet.periodId
      },
      select: { id: true, clockShiftFragmentId: true }
    });
    const resolvableIds = openLateSyncExceptions
      .filter((e) => e.clockShiftFragmentId !== null && frozenOriginFragmentIds.has(e.clockShiftFragmentId))
      .map((e) => e.id);

    if (resolvableIds.length > 0) {
      // §13 — the reserved SYSTEM actor; ck_user_system_shape (CK-34) already guarantees this
      // shape at the DB level when the row exists at all, but a submit that would otherwise
      // silently resolve exceptions under a non-existent/malformed actor must never proceed —
      // the whole submit transaction rolls back instead (stable identifier, matches the
      // SYSTEM_SCHEDULER_USERNAME_OCCUPIED/SYSTEM_USER_NOT_ELIGIBLE convention elsewhere).
      const systemActor = await tx.user.findFirst({
        where: { userKind: 'SYSTEM', username: 'system.scheduler' },
        select: { id: true, status: true, passwordHash: true, employeeId: true }
      });
      if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
        throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
      }
      await tx.attendanceException.updateMany({
        where: { id: { in: resolvableIds } },
        data: { status: 'RESOLVED', resolvedByUserId: systemActor.id, resolvedAt: new Date(), resolutionNote: 'resolved by resubmission (Vn+1)' }
      });
    }
  }

  return { timesheetId, status: 'SUBMITTED', versionId: version.id, versionNumber };
}

/**
 * Manual submit — thin wrapper (§9.6 "Ручной путь"). Opens the one transaction, takes
 * `Employee` → `Timesheet` → `TimesheetDraft FOR UPDATE` in canonical order (§8.1), re-reads
 * ownership/status under the lock (never trusts a pre-lock read for this decision), then hands
 * off to `submitWorkerTimesheetCore` with `submissionSource=MANUAL`.
 */
export async function submitWorkerTimesheet(employeeId: string, timesheetId: string, actorUserId: string, requestId: string): Promise<SubmitResult | SubmitError> {
  return prisma.$transaction(async (tx): Promise<SubmitResult | SubmitError> => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;

    const fresh = await tx.timesheet.findUnique({ where: { id: timesheetId }, select: { employeeId: true, status: true } });
    if (!fresh) {
      return { code: 'NOT_FOUND' };
    }
    if (fresh.employeeId !== employeeId) {
      return { code: 'FORBIDDEN' };
    }
    if (fresh.status !== 'DRAFT' && fresh.status !== 'RETURNED') {
      return { code: 'INVALID_STATE_TRANSITION' };
    }

    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;

    return submitWorkerTimesheetCore(tx, employeeId, timesheetId, actorUserId, requestId, SubmissionSource.MANUAL);
  });
}
