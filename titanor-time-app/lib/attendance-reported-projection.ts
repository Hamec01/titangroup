import { Prisma } from '@prisma/client';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.1a — the single shared implementation of
// reported-range projection and OVERLAPPING_SHIFT occurrence resolution, used identically by
// worker PATCH (§10.2) and correction.approve (§15 п.7); a future materializer/Check-Out slice
// (§9.2/§9.4) is meant to call the same functions, not reimplement the formulas. Every export
// here takes the caller's own Prisma.TransactionClient and never touches the global `prisma`
// singleton — callers are responsible for the canonical lock order (§8.1), specifically holding
// `Employee FOR UPDATE` before calling resolveOverlapTransition (Инвариант 3, §8.3: the
// ux_attendance_exception_overlap_pair_open conflict key is only pre-serialized by that lock).

export interface ReportedRange {
  start: Date;
  end: Date;
}

// §10.2 / §15 п.7 — the recorded-vs-reported provenance value tuple compared by both worker PATCH
// and correction.approve to decide whether a clock-origin segment actually changed, and whether
// that change is EDITED or an exact RESTORED_TO_RECORDED.
export interface ProvenanceValues {
  startAt: Date;
  endAt: Date;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string | null;
}

export function provenanceValuesEqual(a: ProvenanceValues, b: ProvenanceValues): boolean {
  return (
    a.startAt.getTime() === b.startAt.getTime() &&
    a.endAt.getTime() === b.endAt.getTime() &&
    a.siteId === b.siteId &&
    a.workAreaId === b.workAreaId &&
    a.sourceAssignmentId === b.sourceAssignmentId
  );
}

function rangesOverlap(a: ReportedRange[], b: ReportedRange[]): boolean {
  for (const r1 of a) {
    for (const r2 of b) {
      if (r1.start < r2.end && r2.start < r1.end) {
        return true;
      }
    }
  }
  return false;
}

/**
 * §9.1a effectiveReportedRanges, batched over several shifts at once (overlapCandidates' own
 * "без N+1" requirement) — one query per source table, not one per shift. Per fragment: the live
 * projection (TimesheetDraftSegment for DRAFT/RETURNED, WorkSegment at exactly
 * Timesheet.currentVersionId for SUBMITTED+) if it exists; otherwise a provisional raw fallback
 * only while reportedProjectionState='PENDING' (fragment still awaiting its first projection) —
 * a SETTLED fragment with no live segment is an authoritative empty contribution (removed by a
 * provenance edit, or FINAL_APPROVED-exempted), never re-introduced as raw. A ClockShift with no
 * fragments at all (never materialized) falls back to its own raw recordedStartAt/recordedEndAt.
 */
export async function effectiveReportedRangesBatch(tx: Prisma.TransactionClient, clockShiftIds: string[]): Promise<Map<string, ReportedRange[]>> {
  const result = new Map<string, ReportedRange[]>();
  if (clockShiftIds.length === 0) {
    return result;
  }

  const shifts = await tx.clockShift.findMany({
    where: { id: { in: clockShiftIds } },
    select: { id: true, recordedStartAt: true, recordedEndAt: true }
  });

  const fragments = await tx.clockShiftFragment.findMany({
    where: { clockShiftId: { in: clockShiftIds } },
    select: { id: true, clockShiftId: true, timesheetId: true, recordedStartAt: true, recordedEndAt: true, reportedProjectionState: true }
  });

  const fragmentsByShift = new Map<string, typeof fragments>();
  for (const f of fragments) {
    const list = fragmentsByShift.get(f.clockShiftId) ?? [];
    list.push(f);
    fragmentsByShift.set(f.clockShiftId, list);
  }

  const fragmentIds = fragments.map((f) => f.id);
  const timesheetIds = [...new Set(fragments.map((f) => f.timesheetId))];

  const timesheets = timesheetIds.length > 0
    ? await tx.timesheet.findMany({ where: { id: { in: timesheetIds } }, select: { id: true, status: true, currentVersionId: true } })
    : [];
  const timesheetById = new Map(timesheets.map((t) => [t.id, t]));

  const draftSegments = fragmentIds.length > 0
    ? await tx.timesheetDraftSegment.findMany({
        where: { originClockShiftFragmentId: { in: fragmentIds } },
        select: { originClockShiftFragmentId: true, startAt: true, endAt: true, draft: { select: { timesheetId: true } } }
      })
    : [];
  const draftSegByFragment = new Map(draftSegments.map((s) => [s.originClockShiftFragmentId as string, s]));

  const workSegments = fragmentIds.length > 0
    ? await tx.workSegment.findMany({
        where: { originClockShiftFragmentId: { in: fragmentIds } },
        select: { originClockShiftFragmentId: true, startAt: true, endAt: true, timesheetVersionId: true }
      })
    : [];
  const workSegsByFragment = new Map<string, typeof workSegments>();
  for (const s of workSegments) {
    const key = s.originClockShiftFragmentId as string;
    const list = workSegsByFragment.get(key) ?? [];
    list.push(s);
    workSegsByFragment.set(key, list);
  }

  for (const shift of shifts) {
    const shiftFragments = fragmentsByShift.get(shift.id);
    if (!shiftFragments || shiftFragments.length === 0) {
      result.set(shift.id, [{ start: shift.recordedStartAt, end: shift.recordedEndAt }]);
      continue;
    }

    const ranges: ReportedRange[] = [];
    for (const fragment of shiftFragments) {
      const timesheet = timesheetById.get(fragment.timesheetId);
      let liveRange: ReportedRange | null = null;

      if (timesheet && (timesheet.status === 'DRAFT' || timesheet.status === 'RETURNED')) {
        const seg = draftSegByFragment.get(fragment.id);
        if (seg && seg.draft.timesheetId === fragment.timesheetId) {
          liveRange = { start: seg.startAt, end: seg.endAt };
        }
      } else if (timesheet) {
        const candidates = workSegsByFragment.get(fragment.id) ?? [];
        const seg = candidates.find((s) => s.timesheetVersionId === timesheet.currentVersionId);
        if (seg) {
          liveRange = { start: seg.startAt, end: seg.endAt };
        }
      }

      if (liveRange) {
        ranges.push(liveRange);
      } else if (fragment.reportedProjectionState === 'PENDING') {
        ranges.push({ start: fragment.recordedStartAt, end: fragment.recordedEndAt });
      }
      // else: SETTLED with no live projection — authoritative empty contribution, nothing added.
    }
    result.set(shift.id, ranges);
  }

  return result;
}

export async function effectiveReportedRanges(tx: Prisma.TransactionClient, clockShiftId: string): Promise<ReportedRange[]> {
  const map = await effectiveReportedRangesBatch(tx, [clockShiftId]);
  return map.get(clockShiftId) ?? [];
}

export async function overlapExists(tx: Prisma.TransactionClient, clockShiftIdA: string, clockShiftIdB: string): Promise<boolean> {
  const map = await effectiveReportedRangesBatch(tx, [clockShiftIdA, clockShiftIdB]);
  return rangesOverlap(map.get(clockShiftIdA) ?? [], map.get(clockShiftIdB) ?? []);
}

/** §9.1a — canonicalization on INSERT, not in the index; standard uuid btree order, which for
 * canonical lowercase-hyphenated uuid text (always what Postgres/Prisma returns) matches plain
 * string comparison byte-for-byte. */
export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * §9.1a overlapCandidates(X) — full employee-scoped scan, no temporal pre-filter (an unproven
 * 72h-window assumption was removed in revision 3.2.4): every other ClockShift of this employee,
 * confirmed by authoritative effectiveReportedRanges overlap, unioned with any shift already
 * forming an OPEN/DISMISSED OVERLAPPING_SHIFT pair with X (so a pair whose physical overlap has
 * already disappeared still gets a chance to auto-resolve). Callers must compute afterOverlaps
 * per candidate explicitly (via overlapExists or their own batch-loaded ranges) — membership in
 * this result does not by itself imply a current overlap.
 */
export async function overlapCandidates(tx: Prisma.TransactionClient, clockShiftId: string): Promise<string[]> {
  const shift = await tx.clockShift.findUniqueOrThrow({ where: { id: clockShiftId }, select: { employeeId: true } });

  const candidateShifts = await tx.clockShift.findMany({
    where: { employeeId: shift.employeeId, id: { not: clockShiftId } },
    select: { id: true }
  });
  const candidateShiftIds = candidateShifts.map((s) => s.id);

  const xRanges = await effectiveReportedRanges(tx, clockShiftId);
  const candidateRangesById = await effectiveReportedRangesBatch(tx, candidateShiftIds);

  const overlapping = candidateShiftIds.filter((y) => rangesOverlap(xRanges, candidateRangesById.get(y) ?? []));

  const existingPairs = await tx.attendanceException.findMany({
    where: {
      type: 'OVERLAPPING_SHIFT',
      status: { in: ['OPEN', 'DISMISSED'] },
      OR: [{ clockShiftId }, { relatedClockShiftId: clockShiftId }]
    },
    select: { clockShiftId: true, relatedClockShiftId: true }
  });
  const existingPairShiftIds = existingPairs.map((p) => (p.clockShiftId === clockShiftId ? p.relatedClockShiftId! : p.clockShiftId!));

  return [...new Set([...overlapping, ...existingPairShiftIds])];
}

async function resolveSystemActorId(tx: Prisma.TransactionClient): Promise<string> {
  // §13 — the reserved SYSTEM actor; ck_user_system_shape already guarantees this shape at the DB
  // level when the row exists at all, but an automatic overlap resolution that would otherwise
  // silently attribute to a non-existent/malformed actor must never proceed — the whole calling
  // transaction rolls back instead (same stable identifier as lib/worker-timesheets.ts's
  // late-sync resolution).
  const systemActor = await tx.user.findFirst({
    where: { userKind: 'SYSTEM', username: 'system.scheduler' },
    select: { id: true, status: true, passwordHash: true, employeeId: true }
  });
  if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
    throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
  }
  return systemActor.id;
}

/**
 * §9.1a resolveOverlapTransition — the single occurrence-history state machine for
 * AttendanceException(type=OVERLAPPING_SHIFT), driven purely by the (beforeOverlaps,
 * afterOverlaps) pair the caller computed from its own before/after range snapshots. `a`/`b` may
 * arrive in either order — canonicalPair fixes (clockShiftId, relatedClockShiftId) on write, so a
 * concurrent call with the arguments swapped resolves to the same row via the ordinary partial
 * unique index (ux_attendance_exception_overlap_pair_open) and an explicit ON CONFLICT target.
 * Every SYSTEM-attributed mutation (auto-resolve) resolves and validates the real system.scheduler
 * actor itself, immediately before writing it — a caller never passes an actor id in.
 */
export async function resolveOverlapTransition(
  tx: Prisma.TransactionClient,
  a: string,
  b: string,
  beforeOverlaps: boolean,
  afterOverlaps: boolean,
  triggeringClockShiftId: string,
  requestId: string
): Promise<void> {
  const [lo, hi] = canonicalPair(a, b);

  if (!beforeOverlaps && !afterOverlaps) {
    return;
  }

  const latestRow = await tx.attendanceException.findFirst({
    where: { type: 'OVERLAPPING_SHIFT', clockShiftId: lo, relatedClockShiftId: hi },
    orderBy: { createdAt: 'desc' }
  });

  if (!beforeOverlaps && afterOverlaps) {
    const genuinelyNew = !latestRow || latestRow.status === 'RESOLVED' || (latestRow.status === 'DISMISSED' && latestRow.overlapEndedAt !== null);
    if (!genuinelyNew) {
      return;
    }
    const triggerShift = await tx.clockShift.findUniqueOrThrow({ where: { id: triggeringClockShiftId }, select: { employeeId: true, recordedStartAt: true } });
    await tx.$executeRaw`
      INSERT INTO "AttendanceException" (type, "employeeId", "occurredAt", "clockShiftId", "relatedClockShiftId", status, "overlapEndedAt", detail)
      VALUES ('OVERLAPPING_SHIFT', ${triggerShift.employeeId}::uuid, ${triggerShift.recordedStartAt}, ${lo}::uuid, ${hi}::uuid, 'OPEN', NULL, ${JSON.stringify({ triggeringClockShiftId })}::jsonb)
      ON CONFLICT ("clockShiftId", "relatedClockShiftId") WHERE type = 'OVERLAPPING_SHIFT' AND status = 'OPEN' DO NOTHING
    `;
    return;
  }

  if (beforeOverlaps && afterOverlaps) {
    // continuing occurrence, whatever its status — idempotent no-op by construction.
    return;
  }

  // beforeOverlaps && !afterOverlaps
  if (latestRow && latestRow.status === 'OPEN') {
    const systemActorId = await resolveSystemActorId(tx);
    await tx.attendanceException.update({
      where: { id: latestRow.id },
      data: {
        status: 'RESOLVED',
        overlapEndedAt: new Date(),
        resolvedAt: new Date(),
        resolvedByUserId: systemActorId,
        resolutionNote: 'resolved automatically — reported edit removed the overlap'
      }
    });
    await createAuditEvent(tx, {
      actorUserId: systemActorId,
      eventType: 'OVERLAPPING_SHIFT_AUTO_RESOLVED',
      entityType: 'ATTENDANCE_EXCEPTION',
      entityId: latestRow.id,
      requestId,
      beforeValue: { status: 'OPEN' },
      afterValue: { status: 'RESOLVED', clockShiftId: lo, relatedClockShiftId: hi }
    });
    return;
  }
  if (latestRow && latestRow.status === 'DISMISSED' && latestRow.overlapEndedAt === null) {
    await tx.attendanceException.update({ where: { id: latestRow.id }, data: { overlapEndedAt: new Date() } });
  }
}

/**
 * §10.2 шаг 6 / §15 п.7 — the one reported-transition hook shared by worker PATCH and
 * correction.approve, so neither reimplements the affected-shift/candidate/processedPairs loop
 * independently. `beforeRangesByShift` must be a snapshot taken by the caller BEFORE its own
 * mutation (worker PATCH: before delete-all/recreate; correction.approve: before currentVersionId
 * switches) — reused here as-is for any affected shift, and as the "before" side of a candidate
 * that is itself also affected by the same call (symmetric before/after, issue 3.2.3/4). Any
 * shift not in the snapshot is assumed untouched by this transaction — its current state already
 * is its own "before".
 */
export async function resolveOverlapsForAffectedShifts(
  tx: Prisma.TransactionClient,
  affectedShiftIds: string[],
  beforeRangesByShift: Map<string, ReportedRange[]>,
  requestId: string
): Promise<void> {
  const processedPairs = new Set<string>();
  for (const affectedShiftId of affectedShiftIds) {
    const afterRanges = await effectiveReportedRanges(tx, affectedShiftId);
    const beforeRanges = beforeRangesByShift.get(affectedShiftId) ?? [];
    const candidates = await overlapCandidates(tx, affectedShiftId);

    for (const candidateShiftId of candidates) {
      const [lo, hi] = canonicalPair(affectedShiftId, candidateShiftId);
      const pairKey = `${lo}:${hi}`;
      if (processedPairs.has(pairKey)) {
        continue;
      }
      processedPairs.add(pairKey);

      const candidateBeforeRanges = beforeRangesByShift.has(candidateShiftId) ? beforeRangesByShift.get(candidateShiftId)! : await effectiveReportedRanges(tx, candidateShiftId);
      const candidateAfterRanges = await effectiveReportedRanges(tx, candidateShiftId);

      const beforeOverlaps = rangesOverlap(beforeRanges, candidateBeforeRanges);
      const afterOverlaps = rangesOverlap(afterRanges, candidateAfterRanges);

      await resolveOverlapTransition(tx, affectedShiftId, candidateShiftId, beforeOverlaps, afterOverlaps, affectedShiftId, requestId);
    }
  }
}
