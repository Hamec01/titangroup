// "Перенести часы другому заказчику" (owner 2026-10-15) — re-attribute hours ALREADY recorded for a
// worker on some days from one customer (work area, or "no customer") to another customer on the
// SAME site, e.g. a worker who clocked "без заказчика" on 13–14 Oct while actually working for
// Aros Marine. Times and breaks never change — only the customer the hours belong to.
//
// How (one transaction, per-employee lifecycle lock, then Employee → Timesheet → TimesheetDraft rows):
//  1. Only weeks whose timesheet is still DRAFT / RETURNED are moved automatically. A submitted /
//     approved week is refused (TIMESHEET_SUBMITTED + its dates) — those go through the regular
//     correction flow, never rewritten silently.
//  2. Each moved day needs an assignment to the target customer covering it (the reference every
//     timesheet segment keeps). Days not covered get a historical assignment for exactly that run of
//     days: not primary, Check-In disabled, same schedule template as the hours' current assignment.
//  3. Clock-origin hours are re-attributed through the clock-fragment edit core
//     (applyClockShiftFragmentReasonEdit) so the ClockShiftAdjustment provenance chain records it and
//     a later re-sync keeps it; manually entered segments are updated directly.
//  4. One AuditEvent HOURS_MOVED_TO_CUSTOMER lists every moved segment. Weekly customer approvals of
//     the affected weeks become "changed after approval" by their own fingerprint, nothing else.

import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { createAssignmentInTx } from '@/lib/assignments';
import { acquireEmployeeLifecycleLock } from '@/lib/assignment-lock';
import { applyClockShiftFragmentReasonEdit } from '@/lib/clock-shift-fragment-edit';

export const MAX_MOVE_DATES = 62;

export class MoveHoursError extends Error {
  constructor(public code: 'VALIDATION_ERROR' | 'SITE_NOT_FOUND' | 'CUSTOMER_NOT_FOUND' | 'CUSTOMER_DISABLED' | 'SAME_CUSTOMER' | 'NOTHING_TO_MOVE' | 'TIMESHEET_SUBMITTED' | 'MOVE_FAILED', public dates: string[] = []) {
    super(code);
  }
}

export interface MoveHoursInput {
  employeeId: string;
  siteId: string;
  fromWorkAreaId: string | null;
  toWorkAreaId: string | null;
  dates: string[];
  actorUserId: string;
  requestId: string;
}

export interface MoveHoursResult {
  movedSegments: number;
  movedMinutes: number;
  dates: string[];
  createdAssignmentIds: string[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ONE_DAY = 86400000;

/** Consecutive runs of ISO dates: ['2026-10-13','2026-10-14','2026-10-16'] → [[13,14],[16,16]]. */
export function dateRuns(dates: string[]): Array<[string, string]> {
  const sorted = [...new Set(dates)].sort();
  const runs: Array<[string, string]> = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && Date.parse(d) - Date.parse(last[1]) === ONE_DAY) last[1] = d;
    else runs.push([d, d]);
  }
  return runs;
}

/** What would move — for the confirmation summary. Read-only. */
export async function previewMoveHours(input: Omit<MoveHoursInput, 'actorUserId' | 'requestId'>) {
  const segments = await prisma.timesheetDraftSegment.findMany({
    where: { employeeId: input.employeeId, siteId: input.siteId, workAreaId: input.fromWorkAreaId, date: { in: input.dates.map(day) } },
    select: { date: true, startAt: true, endAt: true, draft: { select: { timesheet: { select: { status: true } } } } }
  });
  const minutes = segments.reduce((sum, s) => sum + Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60000), 0);
  const submittedDates = [...new Set(segments.filter((s) => !['DRAFT', 'RETURNED'].includes(s.draft.timesheet.status)).map((s) => iso(s.date)))].sort();
  return { segmentCount: segments.length, grossMinutes: minutes, dates: [...new Set(segments.map((s) => iso(s.date)))].sort(), submittedDates };
}

export async function moveHoursToCustomer(input: MoveHoursInput): Promise<MoveHoursResult> {
  if (!input.dates.length || input.dates.length > MAX_MOVE_DATES || input.dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new MoveHoursError('VALIDATION_ERROR');
  if (input.fromWorkAreaId === input.toWorkAreaId) throw new MoveHoursError('SAME_CUSTOMER');
  const site = await prisma.workSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) throw new MoveHoursError('SITE_NOT_FOUND');
  if (input.toWorkAreaId) {
    const target = await prisma.workArea.findFirst({ where: { id: input.toWorkAreaId, siteId: input.siteId }, select: { active: true } });
    if (!target) throw new MoveHoursError('CUSTOMER_NOT_FOUND');
    if (!target.active) throw new MoveHoursError('CUSTOMER_DISABLED');
  }
  if (input.fromWorkAreaId && !(await prisma.workArea.findFirst({ where: { id: input.fromWorkAreaId, siteId: input.siteId }, select: { id: true } }))) throw new MoveHoursError('CUSTOMER_NOT_FOUND');

  const reason = 'Перенос часов другому заказчику';
  return prisma.$transaction(async (tx) => {
    await acquireEmployeeLifecycleLock(tx, input.employeeId);
    const segments = await tx.timesheetDraftSegment.findMany({
      where: { employeeId: input.employeeId, siteId: input.siteId, workAreaId: input.fromWorkAreaId, date: { in: input.dates.map(day) } },
      select: { id: true, draftId: true, date: true, startAt: true, endAt: true, sourceAssignmentId: true, originClockShiftFragmentId: true, draft: { select: { timesheetId: true, timesheet: { select: { status: true } } } } },
      orderBy: [{ date: 'asc' }, { startAt: 'asc' }]
    });
    if (!segments.length) throw new MoveHoursError('NOTHING_TO_MOVE');
    const submitted = [...new Set(segments.filter((s) => !['DRAFT', 'RETURNED'].includes(s.draft.timesheet.status)).map((s) => iso(s.date)))].sort();
    if (submitted.length) throw new MoveHoursError('TIMESHEET_SUBMITTED', submitted);

    // Canonical row-lock order of the timesheet write paths: Employee → Timesheet → TimesheetDraft.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${input.employeeId}::uuid FOR UPDATE`;
    const timesheetIds = [...new Set(segments.map((s) => s.draft.timesheetId))].sort();
    for (const id of timesheetIds) await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${id}::uuid FOR UPDATE`;
    for (const id of timesheetIds) await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${id}::uuid FOR UPDATE`;

    // 2. target assignment coverage
    const movedDates = [...new Set(segments.map((s) => iso(s.date)))].sort();
    const targetAssignments = await tx.siteAssignment.findMany({
      where: { employeeId: input.employeeId, siteId: input.siteId, workAreaId: input.toWorkAreaId, validFrom: { lte: day(movedDates[movedDates.length - 1]) }, OR: [{ validTo: null }, { validTo: { gte: day(movedDates[0]) } }] },
      select: { id: true, validFrom: true, validTo: true }
    });
    const covering = (date: string) => targetAssignments.find((a) => a.validFrom <= day(date) && (a.validTo === null || a.validTo >= day(date)));
    const uncovered = movedDates.filter((d) => !covering(d));
    const sourceTemplate = await tx.siteAssignment.findUnique({ where: { id: segments[0].sourceAssignmentId }, select: { templateVersionId: true } });
    const createdAssignmentIds: string[] = [];
    const now = new Date();
    for (const [from, to] of dateRuns(uncovered)) {
      const { assignment } = await createAssignmentInTx(tx, {
        employeeId: input.employeeId,
        siteId: input.siteId,
        workAreaId: input.toWorkAreaId,
        templateVersionId: sourceTemplate?.templateVersionId ?? null,
        validFrom: day(from),
        validTo: day(to),
        isPrimary: false,
        assignedByUserId: input.actorUserId
      });
      await tx.siteAssignment.update({ where: { id: assignment.id }, data: { clockInDisabledAt: now, endedReason: reason } });
      targetAssignments.push({ id: assignment.id, validFrom: assignment.validFrom, validTo: assignment.validTo });
      createdAssignmentIds.push(assignment.id);
    }

    // 3. re-attribute each segment
    let movedMinutes = 0;
    const moved: Array<{ segmentId: string; date: string; startAt: string; endAt: string; via: 'CLOCK_FRAGMENT' | 'MANUAL' }> = [];
    for (const segment of segments) {
      const date = iso(segment.date);
      const target = covering(date)!;
      // Every segment references a planned-shift row of its own assignment for that day.
      const plannedKey = { draftId_date_sourceAssignmentId: { draftId: segment.draftId, date: segment.date, sourceAssignmentId: target.id } };
      if (!(await tx.timesheetDraftPlannedShift.findUnique({ where: plannedKey, select: { id: true } }))) {
        const current = await tx.timesheetDraftPlannedShift.findUnique({ where: { draftId_date_sourceAssignmentId: { draftId: segment.draftId, date: segment.date, sourceAssignmentId: segment.sourceAssignmentId } } });
        await tx.timesheetDraftPlannedShift.create({
          data: {
            draftId: segment.draftId,
            employeeId: input.employeeId,
            date: segment.date,
            siteId: input.siteId,
            sourceAssignmentId: target.id,
            templateVersionDayId: current?.templateVersionDayId ?? null,
            plannedStartAt: current?.plannedStartAt ?? null,
            plannedEndAt: current?.plannedEndAt ?? null,
            plannedBreakMinutes: current?.plannedBreakMinutes ?? 0,
            plannedBreakPaid: current?.plannedBreakPaid ?? false
          }
        });
      }
      if (segment.originClockShiftFragmentId) {
        // Pass the segment's CURRENT reported times explicitly: the edit core otherwise falls back to
        // the fragment's raw recorded instants and would undo the time rounding of the reported shift.
        const outcome = await applyClockShiftFragmentReasonEdit(tx, input.actorUserId, input.employeeId, segment.originClockShiftFragmentId, { startAt: segment.startAt, endAt: segment.endAt, workAreaId: input.toWorkAreaId }, reason, input.requestId);
        if (outcome.kind !== 'APPLIED' && outcome.kind !== 'NO_CHANGE') throw new MoveHoursError('MOVE_FAILED', [date]);
      } else {
        await tx.timesheetDraftSegment.update({ where: { id: segment.id }, data: { workAreaId: input.toWorkAreaId, sourceAssignmentId: target.id } });
        await tx.timesheetDraft.update({ where: { id: segment.draftId }, data: { contentRevision: { increment: 1 } } });
      }
      movedMinutes += Math.round((segment.endAt.getTime() - segment.startAt.getTime()) / 60000);
      moved.push({ segmentId: segment.id, date, startAt: segment.startAt.toISOString(), endAt: segment.endAt.toISOString(), via: segment.originClockShiftFragmentId ? 'CLOCK_FRAGMENT' : 'MANUAL' });
    }

    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'HOURS_MOVED_TO_CUSTOMER',
      entityType: 'EMPLOYEE',
      entityId: input.employeeId,
      requestId: input.requestId,
      beforeValue: { siteId: input.siteId, workAreaId: input.fromWorkAreaId },
      afterValue: { siteId: input.siteId, workAreaId: input.toWorkAreaId, dates: movedDates, segments: moved, grossMinutes: movedMinutes, createdAssignmentIds },
      reason
    });
    return { movedSegments: segments.length, movedMinutes, dates: movedDates, createdAssignmentIds };
  }, { timeout: 60000 });
}

