import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { roundReportedInterval } from '@/lib/reporting/time-rounding';
import { createAuditEvent } from '@/lib/audit';
import { overlapCandidates, overlapExists, resolveOverlapTransition } from '@/lib/attendance-reported-projection';
import { computePlannedShiftForAssignmentDate, toTemplateWeekday, helsinkiWallClockToUtc, type TemplateDayInput } from '@/lib/periods';
import { reinitializeDraftFromVersion } from '@/lib/review-scopes';
import { autoCloseOpenCorrectionsForTimesheet } from '@/lib/corrections';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.4/§9.5 — materializeClockShift. Called
// inline from online Check Out (§9.2 step k) and Switch Site (§9.3), or from the internal catch-up
// scan below (no cron/scheduler wiring in this slice — see module footer). "*Core" takes an
// existing Prisma.TransactionClient and never touches the global `prisma` inside a transaction;
// only the public wrapper opens its own `prisma.$transaction(...)`.

// ---------------------------------------------------------------------------------------------
// Helsinki calendar helpers — DST-safe, never UTC-midnight as a stand-in for Helsinki midnight.
// ---------------------------------------------------------------------------------------------

function helsinkiCalendarDate(instant: Date): Date {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(instant);
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function dayAfter(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

/** §9.4 step 2 — "UTC-момент начала календарного дня, СЛЕДУЮЩЕГО за P.endDate, в Europe/Helsinki".
 * Exported for reuse by lib/attendance-auto-submit.ts (§9.6 "issue 3" open-shift relevance check)
 * — same exact calculation, not a second copy. */
export function periodEndExclusive(period: { endDate: Date }): Date {
  const next = dayAfter(period.endDate);
  return helsinkiWallClockToUtc(next, next); // `next`'s own UTC h/m/s are already 0 — serves as its own "00:00" timeOfDay argument.
}

// ---------------------------------------------------------------------------------------------
// Result contract (§L) — MaterializationResult, safe-equivalent naming documented here.
// ---------------------------------------------------------------------------------------------

export type MaterializationResult =
  | { kind: 'MATERIALIZED' }
  | { kind: 'FINAL_APPROVED_SETTLED' } // MATERIALIZED, but at least one fragment settled via the FINAL_APPROVED exemption (no live segment ever created for it)
  | { kind: 'ALREADY_MATERIALIZED' }
  | { kind: 'BLOCKED_OVERLAP' }
  | { kind: 'PENDING_SOURCE_ASSIGNMENT' } // whole-shift ClockShift.sourceAssignmentId IS NULL — materialization not attempted at all
  | { kind: 'PENDING_PERIOD_OR_TIMESHEET' } // §9.4 step 3 — no PayrollPeriod/actionable Timesheet covers some part of the range; zero fragments written
  | { kind: 'PENDING_FRAGMENT_PROJECTION' }; // fragments exist, but at least one blocks the gate: unresolved per-fragment sourceAssignmentId, missing TimesheetDraftDay, or DAY_TYPE_CONFLICT

// ---------------------------------------------------------------------------------------------
// Phase 0 — overlap gate (§9.4 step 0). Reuses the existing shared helpers verbatim (§9.1a) —
// no separate overlap logic. Caller must already hold Employee FOR UPDATE.
// ---------------------------------------------------------------------------------------------

async function overlapGateBlocked(tx: Prisma.TransactionClient, clockShiftId: string, requestId: string): Promise<boolean> {
  const candidates = await overlapCandidates(tx, clockShiftId);
  for (const candidateShiftId of candidates) {
    const afterOverlaps = await overlapExists(tx, clockShiftId, candidateShiftId);
    await resolveOverlapTransition(tx, clockShiftId, candidateShiftId, false, afterOverlaps, clockShiftId, requestId);
  }
  const blockingCount = await tx.attendanceException.count({
    where: { type: 'OVERLAPPING_SHIFT', status: 'OPEN', OR: [{ clockShiftId }, { relatedClockShiftId: clockShiftId }] }
  });
  return blockingCount > 0;
}

// ---------------------------------------------------------------------------------------------
// Phase 1 — plan (§9.4 steps 1-3) + batch insert of missing fragments (§9.4 steps 4-7).
// ---------------------------------------------------------------------------------------------

interface FragmentPlanItem {
  index: number;
  periodId: string;
  timesheetId: string;
  start: Date;
  end: Date;
  date: Date;
}

type FragmentPlanResult = { ok: true; items: FragmentPlanItem[] } | { ok: false; reason: 'PERIOD_BOUNDARY_SPAN' | 'STALE_ASSIGNMENT' };

/**
 * §9.4 step 2 — half-open sweep of [recordedStartAt, recordedEndAt). Each iteration re-derives
 * the period from the Helsinki calendar date of `cursor` (same technique already used by
 * lib/attendance-clock.ts's resolveTimesheetForInstant) — segmentEnd > cursor is guaranteed by
 * construction (see design doc proof), so no fragment can ever be zero-length.
 */
async function planFragments(tx: Prisma.TransactionClient, employeeId: string, recordedStartAt: Date, recordedEndAt: Date): Promise<FragmentPlanResult> {
  const items: FragmentPlanItem[] = [];
  let cursor = recordedStartAt;
  let index = 0;

  while (cursor.getTime() < recordedEndAt.getTime()) {
    const calDate = helsinkiCalendarDate(cursor);
    const period = await tx.payrollPeriod.findFirst({
      where: {
        startDate: { lte: calDate },
        endDate: { gte: calDate },
        participants: { some: { employeeId, expected: true } }
      },
      select: { id: true, endDate: true }
    });
    if (!period) {
      return { ok: false, reason: items.length > 0 ? 'PERIOD_BOUNDARY_SPAN' : 'STALE_ASSIGNMENT' };
    }
    const timesheet = await tx.timesheet.findUnique({ where: { employeeId_periodId: { employeeId, periodId: period.id } }, select: { id: true } });
    if (!timesheet) {
      return { ok: false, reason: items.length > 0 ? 'PERIOD_BOUNDARY_SPAN' : 'STALE_ASSIGNMENT' };
    }
    const endExclusive = periodEndExclusive(period);
    const segmentEnd = recordedEndAt.getTime() < endExclusive.getTime() ? recordedEndAt : endExclusive;
    items.push({ index, periodId: period.id, timesheetId: timesheet.id, start: cursor, end: segmentEnd, date: calDate });
    cursor = segmentEnd;
    index += 1;
  }

  return { ok: true, items };
}

/** Find-or-create a single shift-level (clockShiftFragmentId=NULL) OPEN exception — dedup guard for coverage-failure cases with no natural unique constraint (§D "не создавать бесконечные дубли"). */
async function ensureShiftLevelException(
  tx: Prisma.TransactionClient,
  clockShiftId: string,
  employeeId: string,
  type: 'PERIOD_BOUNDARY_SPAN' | 'STALE_ASSIGNMENT',
  occurredAt: Date
): Promise<void> {
  const existing = await tx.attendanceException.findFirst({
    where: { clockShiftId, clockShiftFragmentId: null, type, status: 'OPEN' },
    select: { id: true }
  });
  if (existing) {
    return;
  }
  await tx.attendanceException.create({ data: { type, employeeId, clockShiftId, clockShiftFragmentId: null, occurredAt, status: 'OPEN' } });
}

async function resolveActiveAssignment(tx: Prisma.TransactionClient, employeeId: string, siteId: string, workAreaId: string | null, date: Date): Promise<string | null> {
  const assignment = await tx.siteAssignment.findFirst({
    where: { employeeId, siteId, workAreaId, validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] },
    select: { id: true }
  });
  return assignment?.id ?? null;
}

interface InsertedFragmentInfo {
  id: string;
  index: number;
  periodId: string;
  timesheetId: string;
}

/**
 * §9.4 steps 4-7 — locks Timesheet/TimesheetDraft for every involved period (canonical order,
 * ascending Timesheet.id), then batch-inserts every MISSING fragment as one multi-row raw INSERT
 * with an explicit ON CONFLICT target (defense-in-depth, not the primary correctness mechanism —
 * the ClockShift FOR UPDATE lock already serializes this). Never a per-row loop — the
 * FOR EACH STATEMENT coverage trigger must see the complete row set in one statement.
 */
async function lockPeriodsAndInsertMissingFragments(
  tx: Prisma.TransactionClient,
  clockShiftId: string,
  employeeId: string,
  siteId: string,
  workAreaId: string | null,
  plan: FragmentPlanItem[]
): Promise<InsertedFragmentInfo[]> {
  const timesheetIds = [...new Set(plan.map((p) => p.timesheetId))].sort();
  // Canonical lock positions are global, not interleaved per period: acquire every Timesheet
  // (position 5) first, then every corresponding TimesheetDraft (position 6), preserving the
  // same Timesheet.id order in both passes. Taking Draft(A) before Timesheet(B) would invert the
  // documented order for a multi-period shift and could form a deadlock with another workflow.
  for (const timesheetId of timesheetIds) {
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
  }
  const drafts: Array<{ id: string }> = [];
  for (const timesheetId of timesheetIds) {
    drafts.push(await tx.timesheetDraft.findUniqueOrThrow({ where: { timesheetId }, select: { id: true } }));
  }
  for (const draft of drafts) {
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
  }

  const existingFragments = await tx.clockShiftFragment.findMany({ where: { clockShiftId }, select: { fragmentIndex: true } });
  const existingIndices = new Set(existingFragments.map((f) => f.fragmentIndex));
  const missing = plan.filter((p) => !existingIndices.has(p.index));

  if (missing.length > 0) {
    const withIds: Array<FragmentPlanItem & { id: string; sourceAssignmentId: string | null }> = [];
    for (const p of missing) {
      const sourceAssignmentId = await resolveActiveAssignment(tx, employeeId, siteId, workAreaId, p.date);
      withIds.push({ ...p, id: randomUUID(), sourceAssignmentId });
    }
    const rows = withIds.map(
      (p) =>
        Prisma.sql`(${p.id}::uuid, ${clockShiftId}::uuid, ${employeeId}::uuid, ${p.index}, ${p.periodId}::uuid, ${p.timesheetId}::uuid, ${p.date}, ${p.start}, ${p.end}, ${siteId}::uuid, ${workAreaId}::uuid, ${p.sourceAssignmentId}::uuid, now())`
    );
    await tx.$executeRaw`
      INSERT INTO "ClockShiftFragment"
        (id, "clockShiftId", "employeeId", "fragmentIndex", "payrollPeriodId", "timesheetId", "date", "recordedStartAt", "recordedEndAt", "siteId", "workAreaId", "sourceAssignmentId", "createdAt")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("clockShiftId", "fragmentIndex") DO NOTHING
    `;
  }

  const allFragments = await tx.clockShiftFragment.findMany({ where: { clockShiftId }, orderBy: { fragmentIndex: 'asc' }, select: { id: true, fragmentIndex: true, payrollPeriodId: true, timesheetId: true } });
  return allFragments.map((f) => ({ id: f.id, index: f.fragmentIndex, periodId: f.payrollPeriodId, timesheetId: f.timesheetId }));
}

// ---------------------------------------------------------------------------------------------
// §J — chronology exception fragment-linking, run immediately after Phase 1 succeeds (linked to
// fragment CREATION, not to Phase 2's later segment-insertion success — a fragment that later
// blocks on day-state/assignment must still receive the link).
// ---------------------------------------------------------------------------------------------

async function linkChronologyExceptionIfProvisional(tx: Prisma.TransactionClient, clockShiftId: string, endAtProvisional: boolean, fragments: InsertedFragmentInfo[]): Promise<void> {
  if (!endAtProvisional || fragments.length === 0) {
    return;
  }
  const openException = await tx.attendanceException.findFirst({
    where: { type: 'CHECKOUT_CHRONOLOGY_ANOMALY', clockShiftId, clockShiftFragmentId: null, status: 'OPEN' },
    select: { id: true }
  });
  if (!openException) {
    return; // already linked by an earlier pass, or never created — no-op either way.
  }
  const lastFragment = fragments[fragments.length - 1];
  await tx.attendanceException.update({ where: { id: openException.id }, data: { clockShiftFragmentId: lastFragment.id } });
}

// ---------------------------------------------------------------------------------------------
// §K — PERIOD_BOUNDARY_SPAN, one row per distinct period, deduped per (clockShiftId, periodId).
// ---------------------------------------------------------------------------------------------

async function ensurePeriodBoundaryExceptions(tx: Prisma.TransactionClient, clockShiftId: string, employeeId: string, occurredAt: Date, fragments: InsertedFragmentInfo[]): Promise<void> {
  const distinctPeriods = new Map<string, InsertedFragmentInfo>();
  for (const f of fragments) {
    if (!distinctPeriods.has(f.periodId)) {
      distinctPeriods.set(f.periodId, f);
    }
  }
  if (distinctPeriods.size < 2) {
    return;
  }
  for (const [periodId, fragment] of distinctPeriods) {
    const existing = await tx.attendanceException.findFirst({
      where: { type: 'PERIOD_BOUNDARY_SPAN', clockShiftId, payrollPeriodId: periodId, status: 'OPEN' },
      select: { id: true }
    });
    if (existing) {
      continue;
    }
    await tx.attendanceException.create({
      data: { type: 'PERIOD_BOUNDARY_SPAN', employeeId, clockShiftId, clockShiftFragmentId: fragment.id, payrollPeriodId: periodId, timesheetId: fragment.timesheetId, occurredAt, status: 'OPEN' }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 2 — per-fragment planned-shift/live-segment projection + §9.5 late-sync status matrix.
// ---------------------------------------------------------------------------------------------

async function resolveSystemActor(tx: Prisma.TransactionClient): Promise<string> {
  // §13 — same reserved SYSTEM actor lookup/validation as lib/worker-timesheets.ts and
  // lib/attendance-reported-projection.ts; a materializer pass that would otherwise attribute a
  // reopen/audit to a non-existent or malformed SYSTEM row must roll back entirely instead.
  const systemActor = await tx.user.findFirst({
    where: { userKind: 'SYSTEM', username: 'system.scheduler' },
    select: { id: true, status: true, passwordHash: true, employeeId: true }
  });
  if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
    throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
  }
  return systemActor.id;
}

async function ensureFragmentException(tx: Prisma.TransactionClient, fragment: { id: string; employeeId: string; timesheetId: string; payrollPeriodId: string; recordedStartAt: Date; clockShiftId: string }, type: 'STALE_ASSIGNMENT', detail: Prisma.InputJsonValue): Promise<void> {
  const existing = await tx.attendanceException.findFirst({
    where: { type, clockShiftFragmentId: fragment.id, status: 'OPEN' },
    select: { id: true }
  });
  if (existing) {
    return;
  }
  await tx.attendanceException.create({
    data: { type, employeeId: fragment.employeeId, timesheetId: fragment.timesheetId, payrollPeriodId: fragment.payrollPeriodId, occurredAt: fragment.recordedStartAt, clockShiftId: fragment.clockShiftId, clockShiftFragmentId: fragment.id, status: 'OPEN', detail }
  });
}

interface Phase2Outcome {
  anyBlocked: boolean;
  anyFinalApprovedSettled: boolean;
}

/**
 * §9.4 step 8 + §9.5. Iterates every fragment of the shift (pre-existing and freshly inserted
 * alike). `reportedProjectionState==='SETTLED'` is checked first as an idempotent short-circuit —
 * a FINAL_APPROVED-exempt fragment never gets a live segment (§9.4 step 8f), so the design's own
 * step 8b ("already has a live segment") would never catch it on a repeat pass; without this
 * explicit SETTLED check, every repeat materializer pass would re-run the exemption branch and
 * re-create its LATE_SYNC_AFTER_SUBMIT exception/audit event indefinitely.
 */
async function projectFragments(tx: Prisma.TransactionClient, clockShiftId: string, employeeId: string, requestId: string, fragmentIds: string[]): Promise<Phase2Outcome> {
  let anyBlocked = false;
  let anyFinalApprovedSettled = false;
  let cachedSystemActorId: string | null = null;
  const systemActor = async (): Promise<string> => {
    if (!cachedSystemActorId) {
      cachedSystemActorId = await resolveSystemActor(tx);
    }
    return cachedSystemActorId;
  };

  for (const fragmentId of fragmentIds) {
    const fragment = await tx.clockShiftFragment.findUniqueOrThrow({ where: { id: fragmentId } });

    if (fragment.reportedProjectionState === 'SETTLED') {
      continue; // idempotent skip — see doc comment above.
    }
    if (fragment.sourceAssignmentId === null) {
      // Phase 1 deliberately inserts the complete coverage set even when a per-period
      // assignment cannot be resolved. Record the actionable blocker here (once per fragment)
      // before leaving the fragment PENDING for CONFIRM_SOURCE_ASSIGNMENT.
      await ensureFragmentException(tx, fragment, 'STALE_ASSIGNMENT', { reason: 'fragment_source_assignment_not_found' });
      anyBlocked = true;
      continue; // §9.4 step 8a — wait for CONFIRM_SOURCE_ASSIGNMENT.
    }

    const alreadyLive = await tx.timesheetDraftSegment.findFirst({ where: { originClockShiftFragmentId: fragment.id }, select: { id: true } });
    if (alreadyLive) {
      continue; // §9.4 step 8b — no-op, segment already exists (normal repeat pass, or reinit copy).
    }

    const draft = await tx.timesheetDraft.findUniqueOrThrow({ where: { timesheetId: fragment.timesheetId }, select: { id: true, basedOnVersionId: true } });

    // §9.4 step 8e/§9.5 — late-sync status matrix, evaluated fresh under the already-held lock.
    // Deliberately runs BEFORE both the TimesheetDraftPlannedShift upsert (step 8c) and the
    // TimesheetDraftDay lookup (step 8d): a genuinely fresh SUBMITTED/FOREMAN_APPROVED timesheet
    // has an EMPTY draft (submitWorkerTimesheetCore clears TimesheetDraftDay AND
    // TimesheetDraftPlannedShift on every submit, §9.6) — reinitializeDraftFromVersion, part of
    // the reopen procedure itself, is what repopulates both from the frozen version. Two
    // concrete failure modes if this ran later instead: (1) step 8d would see "missing draft
    // day" on every first-ever late fragment and never actually reach the reopen meant to fix
    // that; (2) step 8c's own upsert would pre-create a TimesheetDraftPlannedShift row that
    // reinitializeDraftFromVersion's own unprotected `createMany` (no skipDuplicates) would then
    // collide with on the SAME (draftId, date, sourceAssignmentId) key. The design's own step
    // lettering (c,d,e,f,g) is a reference list, not a literal execution order — its own "e:
    // выполнить §9.5 ПЕРЕД следующим шагом" annotation already signals ordering needs care here.
    const timesheet = await tx.timesheet.findUniqueOrThrow({ where: { id: fragment.timesheetId }, select: { status: true, currentVersionId: true, lastReturnedReason: true } });

    if (timesheet.status === 'FINAL_APPROVED') {
      await tx.attendanceException.create({
        data: {
          type: 'LATE_SYNC_AFTER_SUBMIT',
          employeeId,
          timesheetId: fragment.timesheetId,
          payrollPeriodId: fragment.payrollPeriodId,
          occurredAt: fragment.recordedStartAt,
          clockShiftId,
          clockShiftFragmentId: fragment.id,
          status: 'OPEN',
          detail: { timesheetStatus: 'FINAL_APPROVED' }
        }
      });
      const actorId = await systemActor();
      await createAuditEvent(tx, {
        actorUserId: actorId,
        eventType: 'TIMESHEET_SYSTEM_REOPEN_SKIPPED_FINAL_APPROVED',
        entityType: 'TIMESHEET',
        entityId: fragment.timesheetId,
        requestId,
        beforeValue: null,
        afterValue: { status: 'FINAL_APPROVED', clockShiftFragmentId: fragment.id }
      });
      await tx.clockShiftFragment.update({ where: { id: fragment.id }, data: { reportedProjectionState: 'SETTLED' } });
      anyFinalApprovedSettled = true;
      continue; // §9.5 — live segment never inserted for FINAL_APPROVED.
    }

    const needsReopen = timesheet.status === 'SUBMITTED' || timesheet.status === 'FOREMAN_APPROVED';
    const continuingLateEpisode = timesheet.status === 'RETURNED' && timesheet.lastReturnedReason === 'SYSTEM_LATE_SYNC_REOPEN';

    if (needsReopen) {
      const actorId = await systemActor();
      await tx.timesheet.update({
        where: { id: fragment.timesheetId },
        data: { status: 'RETURNED', lastReturnedReason: 'SYSTEM_LATE_SYNC_REOPEN', systemReopenGeneration: { increment: 1 }, systemReopenAt: new Date() }
      });
      if (draft.basedOnVersionId !== timesheet.currentVersionId && timesheet.currentVersionId) {
        await reinitializeDraftFromVersion(tx, draft.id, employeeId, timesheet.currentVersionId);
      }
      // T12 — a late clock sync moved the timesheet; any open admin edit is now on a stale version.
      await autoCloseOpenCorrectionsForTimesheet(tx, fragment.timesheetId, requestId, null, 'TIMESHEET_REOPENED');
      await createAuditEvent(tx, {
        actorUserId: actorId,
        eventType: 'TIMESHEET_SYSTEM_REOPENED',
        entityType: 'TIMESHEET',
        entityId: fragment.timesheetId,
        requestId,
        beforeValue: { status: timesheet.status },
        afterValue: { status: 'RETURNED', reason: 'late_clock_sync', clockShiftFragmentId: fragment.id }
      });
    }
    if (needsReopen || continuingLateEpisode) {
      // §9.5 "Второй late fragment до resubmit" — generalized: any fragment landing while the
      // timesheet is still within the SAME unresolved late-sync episode gets its own exception,
      // even when this particular fragment didn't itself trigger the reopen.
      await tx.attendanceException.create({
        data: { type: 'LATE_SYNC_AFTER_SUBMIT', employeeId, timesheetId: fragment.timesheetId, payrollPeriodId: fragment.payrollPeriodId, occurredAt: fragment.recordedStartAt, clockShiftId, clockShiftFragmentId: fragment.id, status: 'OPEN' }
      });
    }

    // §9.4 step 8c — TimesheetDraftPlannedShift find-or-create, shared formula with
    // period.create/assignment.create. Runs AFTER the reopen above (see comment before the
    // status matrix) — upsert(update:{}) safely no-ops if reinitializeDraftFromVersion already
    // created this exact (draftId, date, sourceAssignmentId) row from the frozen version.
    const assignment = await tx.siteAssignment.findUniqueOrThrow({ where: { id: fragment.sourceAssignmentId }, select: { templateVersionId: true } });
    let templateDay: TemplateDayInput | null = null;
    if (assignment.templateVersionId) {
      templateDay = await tx.workScheduleTemplateVersionDay.findUnique({
        where: { templateVersionId_weekday: { templateVersionId: assignment.templateVersionId, weekday: toTemplateWeekday(fragment.date) } }
      });
    }
    const computed = computePlannedShiftForAssignmentDate(templateDay, fragment.date);
    await tx.timesheetDraftPlannedShift.upsert({
      where: { draftId_date_sourceAssignmentId: { draftId: draft.id, date: fragment.date, sourceAssignmentId: fragment.sourceAssignmentId } },
      create: { draftId: draft.id, employeeId, date: fragment.date, siteId: fragment.siteId, sourceAssignmentId: fragment.sourceAssignmentId, ...computed },
      update: {}
    });

    // §9.4 step 8d — TimesheetDraftDay find-only, never create. Runs AFTER the reopen above so a
    // just-reinitialized draft's days are already visible to this lookup.
    const draftDay = await tx.timesheetDraftDay.findUnique({ where: { draftId_date: { draftId: draft.id, date: fragment.date } } });
    if (!draftDay) {
      await ensureFragmentException(tx, fragment, 'STALE_ASSIGNMENT', { reason: 'missing_timesheet_draft_day' });
      anyBlocked = true;
      continue;
    }

    // §9.4 step 8g precheck — day-state, before attempting the INSERT.
    const dayState = await tx.timesheetDraftDay.findUniqueOrThrow({ where: { id: draftDay.id }, select: { dayType: true, confirmedZero: true } });
    if (dayState.dayType !== 'WORK' || dayState.confirmedZero) {
      await ensureFragmentException(tx, fragment, 'STALE_ASSIGNMENT', { reason: 'DAY_TYPE_CONFLICT', currentDayType: dayState.dayType });
      anyBlocked = true;
      continue;
    }

    const reportedInterval = roundReportedInterval(fragment.recordedStartAt, fragment.recordedEndAt);
    await tx.timesheetDraftSegment.create({
      data: {
        draftDayId: draftDay.id,
        draftId: draft.id,
        employeeId,
        date: fragment.date,
        startAt: reportedInterval.startAt,
        endAt: reportedInterval.endAt,
        siteId: fragment.siteId,
        workAreaId: fragment.workAreaId,
        sourceAssignmentId: fragment.sourceAssignmentId,
        originClockShiftFragmentId: fragment.id
      }
    });
    await tx.timesheetDraft.update({ where: { id: draft.id }, data: { contentRevision: { increment: 1 } } });
    await tx.clockShiftFragment.update({ where: { id: fragment.id }, data: { reportedProjectionState: 'SETTLED' } });
  }

  return { anyBlocked, anyFinalApprovedSettled };
}

// ---------------------------------------------------------------------------------------------
// §9.4 step 9 — materializationState gate, conditional UPDATE (defense-in-depth trigger backs
// this at the DB level too, §4.1).
// ---------------------------------------------------------------------------------------------

async function attemptMaterializedTransition(tx: Prisma.TransactionClient, clockShiftId: string): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE "ClockShift" cs
    SET "materializationState" = 'MATERIALIZED'
    WHERE cs.id = ${clockShiftId}::uuid
      AND cs."materializationState" = 'PENDING'
      AND EXISTS (SELECT 1 FROM "ClockShiftFragment" f WHERE f."clockShiftId" = cs.id)
      AND NOT EXISTS (
        SELECT 1 FROM "ClockShiftFragment" f
        WHERE f."clockShiftId" = cs.id
          AND (f."sourceAssignmentId" IS NULL OR f."reportedProjectionState" <> 'SETTLED')
      )
  `;
  return updated > 0;
}

// ---------------------------------------------------------------------------------------------
// Core — assumes canonical locks are already held by the caller (Employee, ClockShift FOR
// UPDATE). Idempotent: re-checks materializationState/sourceAssignmentId itself.
// ---------------------------------------------------------------------------------------------

export async function materializeClockShiftCore(tx: Prisma.TransactionClient, clockShiftId: string, requestId: string): Promise<MaterializationResult> {
  const shift = await tx.clockShift.findUniqueOrThrow({
    where: { id: clockShiftId },
    select: { employeeId: true, siteId: true, workAreaId: true, sourceAssignmentId: true, recordedStartAt: true, recordedEndAt: true, endAtProvisional: true, materializationState: true }
  });

  if (shift.materializationState === 'MATERIALIZED') {
    return { kind: 'ALREADY_MATERIALIZED' };
  }
  if (shift.sourceAssignmentId === null) {
    return { kind: 'PENDING_SOURCE_ASSIGNMENT' };
  }

  if (await overlapGateBlocked(tx, clockShiftId, requestId)) {
    return { kind: 'BLOCKED_OVERLAP' };
  }

  const plan = await planFragments(tx, shift.employeeId, shift.recordedStartAt, shift.recordedEndAt);
  if (!plan.ok) {
    await ensureShiftLevelException(tx, clockShiftId, shift.employeeId, plan.reason, shift.recordedStartAt);
    return { kind: 'PENDING_PERIOD_OR_TIMESHEET' };
  }

  const fragments = await lockPeriodsAndInsertMissingFragments(tx, clockShiftId, shift.employeeId, shift.siteId, shift.workAreaId, plan.items);
  await linkChronologyExceptionIfProvisional(tx, clockShiftId, shift.endAtProvisional, fragments);
  await ensurePeriodBoundaryExceptions(tx, clockShiftId, shift.employeeId, shift.recordedStartAt, fragments);

  const { anyBlocked, anyFinalApprovedSettled } = await projectFragments(
    tx,
    clockShiftId,
    shift.employeeId,
    requestId,
    fragments.map((f) => f.id)
  );

  if (anyBlocked) {
    return { kind: 'PENDING_FRAGMENT_PROJECTION' };
  }

  const materialized = await attemptMaterializedTransition(tx, clockShiftId);
  if (!materialized) {
    // Gate re-check found a blocker our own per-fragment loop didn't (defensive — should not
    // normally diverge from anyBlocked above, since both read the same underlying rows).
    return { kind: 'PENDING_FRAGMENT_PROJECTION' };
  }
  return anyFinalApprovedSettled ? { kind: 'FINAL_APPROVED_SETTLED' } : { kind: 'MATERIALIZED' };
}

// ---------------------------------------------------------------------------------------------
// Public wrapper — opens its own transaction, canonical locks (Employee → ClockShift), then
// hands off to core. Used by the catch-up scan below; inline callers (Check Out/Switch Site)
// call *Core directly inside their own already-open transaction instead (§B).
// ---------------------------------------------------------------------------------------------

export async function materializeClockShift(clockShiftId: string, requestId: string): Promise<MaterializationResult> {
  const shift = await prisma.clockShift.findUniqueOrThrow({ where: { id: clockShiftId }, select: { employeeId: true } });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${shift.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ClockShift" WHERE id = ${clockShiftId}::uuid FOR UPDATE`;
    return materializeClockShiftCore(tx, clockShiftId, requestId);
  });
}

// ---------------------------------------------------------------------------------------------
// Catch-up — service-level export only, no route/cron/background loop wired to it in this
// slice. Each candidate is its own isolated transaction (via materializeClockShift above); one
// candidate's failure never touches another's already-committed or not-yet-attempted state.
// ---------------------------------------------------------------------------------------------

export async function scanPendingClockShiftIds(limit = 500): Promise<string[]> {
  const rows = await prisma.clockShift.findMany({
    where: { materializationState: 'PENDING', sourceAssignmentId: { not: null } },
    select: { id: true },
    take: limit
  });
  return rows.map((r) => r.id);
}

export type CatchUpPassEntry = { clockShiftId: string; result: MaterializationResult } | { clockShiftId: string; error: string };

export async function runMaterializerCatchUpPass(limit = 500): Promise<CatchUpPassEntry[]> {
  const requestId = randomUUID();
  const candidates = await scanPendingClockShiftIds(limit);
  const entries: CatchUpPassEntry[] = [];
  for (const clockShiftId of candidates) {
    try {
      const result = await materializeClockShift(clockShiftId, requestId);
      entries.push({ clockShiftId, result });
    } catch (err) {
      entries.push({ clockShiftId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return entries;
}
