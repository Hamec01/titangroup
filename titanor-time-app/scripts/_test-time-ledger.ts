// UT3-B (Titanor Time — единый табель и подтверждение часов по заказчику) — real-Postgres coverage
// for lib/reporting/time-ledger.ts's getTimeLedger(): draft/placeholder semantics, blockers/
// warnings, approval matching (incl. the SUPERSEDED-only branch), fast vs chunked mode, exact
// all-time summary/pagination, the two-pass consistency check (409 regression), and query-count
// properties. Needs a disposable PostgreSQL 16 (DATABASE_URL) with every migration applied.
//
// Every scenario tags its own employees/sites with a unique string so assertions can find "my own"
// rows inside a shared disposable database without needing full isolation between blocks.

import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient, SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import {
  getTimeLedger,
  TimeLedgerReadChangedError,
  type LedgerActor,
  type NormalizedTimeLedgerQuery,
  type WeeklyCustomerSliceRow,
  type SourceErrorRow
} from '../lib/reporting/time-ledger';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 800) : '');
  }
}

// -------------------------------------------------------------------------------------------------
// Fixture builders.
// -------------------------------------------------------------------------------------------------

let adminUserId = '';
let adminActor: LedgerActor;

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `TL-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `TL-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `TL-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}

/** EmployeeOpenShift.employeeId is that table's own primary key — one open shift per employee at
 *  most — so this replaces any existing open shift for the employee, matching real clock-in
 *  semantics closely enough for a fixture. */
async function mkOpenShift(employeeId: string, siteId: string, workAreaId: string | null, openedAt: Date) {
  const evtId = randomUUID();
  await prisma.clockEvent.create({
    data: {
      id: evtId,
      employeeId,
      operationType: 'CHECK_IN',
      siteId,
      clientCapturedAt: openedAt,
      capturedOffline: false,
      serverReceivedAt: openedAt,
      effectiveAt: openedAt,
      gpsVerification: 'NOT_VERIFIED',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: createHash('sha256').update(evtId).digest('hex'),
      requestId: randomUUID()
    }
  });
  return prisma.employeeOpenShift.create({ data: { employeeId, openedByClockEventId: evtId, siteId, workAreaId, openedAt } });
}

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);

let weekSlot = 0;
/** Every call returns a fresh, never-reused Monday, far enough apart that no two fixtures' periods
 *  ever overlap for the same or different employees. */
function nextMonday(): Date {
  const d = new Date(Date.UTC(2030, 0, 7) + weekSlot * 14 * 86400000);
  weekSlot += 1;
  return d;
}

interface DraftDaySpec {
  day: Date;
  siteId: string;
  workAreaId: string | null;
  assignmentId: string;
  confirmedZero?: boolean;
  noSegment?: boolean;
}

async function buildDraft(employeeId: string, days: DraftDaySpec[], periodStatus: 'OPEN' | 'LOCKED' = 'OPEN', existingPeriod?: { id: string }) {
  const anchor = days[0].day;
  const period = existingPeriod ?? (await prisma.payrollPeriod.create({ data: { startDate: anchor, endDate: new Date(anchor.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } }));
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });

  for (const d of days) {
    if (d.noSegment) {
      await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: d.day, dayType: 'OTHER', confirmedZero: d.confirmedZero ?? false } });
      continue;
    }
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: d.day, siteId: d.siteId, sourceAssignmentId: d.assignmentId, plannedStartAt: at(d.day, 7), plannedEndAt: at(d.day, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: d.day, dayType: 'WORK', confirmedZero: d.confirmedZero ?? false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: d.day, startAt: at(d.day, 7), endAt: at(d.day, 15), siteId: d.siteId, workAreaId: d.workAreaId, sourceAssignmentId: d.assignmentId } });
  }
  if (periodStatus === 'LOCKED' && !existingPeriod) {
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: adminUserId } });
  }
  return { period, ts, draft };
}

async function submitDraft(employeeId: string, timesheetId: string, source: SubmissionSource = SubmissionSource.MANUAL) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), source);
  });
}

/** One worker, one real 07:00-15:00 worked day at (siteId, workAreaId), submitted. Returns the
 *  fresh employee/site/workArea/timesheet ids plus the fixture's Monday. `periodStatus` LOCKED
 *  keeps the "edit window still open" warning from firing on fixtures that don't want to test it. */
async function oneWorkedWeek(tag: string, opts: { periodStatus?: 'OPEN' | 'LOCKED'; source?: SubmissionSource; site?: { id: string }; workArea?: { id: string } | null } = {}) {
  const site = opts.site ?? (await mkSite(tag));
  const workArea = opts.workArea !== undefined ? opts.workArea : await mkWorkArea(site.id, tag);
  const emp = await mkWorker(tag);
  const asg = await mkAssignment(emp.id, site.id, workArea?.id ?? null);
  const monday = nextMonday();
  const { period, ts } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea?.id ?? null, assignmentId: asg.id }], opts.periodStatus ?? 'LOCKED');
  await submitDraft(emp.id, ts.id, opts.source ?? SubmissionSource.MANUAL);
  return { site, workArea, employee: emp, timesheetId: ts.id, periodId: period.id, monday };
}

function baseQuery(overrides: Partial<NormalizedTimeLedgerQuery> = {}): NormalizedTimeLedgerQuery {
  return {
    allTime: false,
    requestedRange: null,
    employeeSearch: null,
    workAreaId: null,
    siteId: null,
    status: 'all',
    onlyIssues: false,
    onlyChangedAfterApproval: false,
    submissionState: 'all',
    submissionSource: 'all',
    page: 1,
    pageSize: 50,
    ...overrides
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekRangeQuery(monday: Date, overrides: Partial<NormalizedTimeLedgerQuery> = {}): NormalizedTimeLedgerQuery {
  return baseQuery({ requestedRange: { startDate: isoDate(monday), endDate: isoDate(new Date(monday.getTime() + 6 * 86400000)) }, ...overrides });
}

function findSliceRow(rows: WeeklyCustomerSliceRow[], employeeId: string): WeeklyCustomerSliceRow | undefined {
  return rows.find((r) => r.logicalKey.employeeId === employeeId);
}
function allSliceRows(result: { customerGroups: { rows: WeeklyCustomerSliceRow[] }[] }): WeeklyCustomerSliceRow[] {
  return result.customerGroups.flatMap((g) => g.rows);
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `tl-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;
  adminActor = { userId: admin.id, employeeId: null };

  // =================================================================================================
  // Block A — draft / placeholder semantics.
  // =================================================================================================

  // A1: DRAFT with real segments, never submitted -> a real WEEKLY_CUSTOMER_SLICE, submissionState NOT_SUBMITTED.
  {
    const site = await mkSite('a1');
    const workArea = await mkWorkArea(site.id, 'a1');
    const emp = await mkWorker('A1Worker');
    const asg = await mkAssignment(emp.id, site.id, workArea.id);
    const monday = nextMonday();
    await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }], 'LOCKED');

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'A1Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), emp.id);
    check('A1: draft-with-real-segments produces a WEEKLY_CUSTOMER_SLICE row', !!row, result);
    check('A1: submissionState is NOT_SUBMITTED for a DRAFT-sourced slice', row?.submissionState === 'NOT_SUBMITTED', row);
    check('A1: workedMinutes = 450 (07:00-15:00 minus 30 min auto lunch)', row?.workedMinutes === 450, row?.workedMinutes);
    check('A1: no false blockers/warnings on a clean draft slice (LOCKED period)', row?.blockers.length === 0 && row?.warnings.length === 0, row);
    check('A1: approvalState READY with no approval history and no issues', row?.approvalState === 'READY', row?.approvalState);
  }

  // A2: empty DRAFT (Timesheet+TimesheetDraft, zero real days) -> NOT_SUBMITTED placeholder, timesheetId set.
  {
    const emp = await mkWorker('A2Worker');
    const monday = nextMonday();
    const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
    await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'A2Worker' }), adminActor);
    check('A2: empty draft produces exactly one NOT_SUBMITTED row', result.notSubmitted.length === 1, result.notSubmitted);
    check('A2: NOT_SUBMITTED carries the real timesheetId + DRAFT status', result.notSubmitted[0]?.timesheetId === ts.id && result.notSubmitted[0]?.timesheetStatus === 'DRAFT', result.notSubmitted[0]);
  }

  // A3: participant with literally no Timesheet row -> NOT_SUBMITTED placeholder, timesheetId null.
  {
    const emp = await mkWorker('A3Worker');
    const monday = nextMonday();
    const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'A3Worker' }), adminActor);
    check('A3: missing-timesheet participant produces exactly one NOT_SUBMITTED row', result.notSubmitted.length === 1, result.notSubmitted);
    check('A3: NOT_SUBMITTED has timesheetId null (never had a Timesheet at all)', result.notSubmitted[0]?.timesheetId === null, result.notSubmitted[0]);
    check('A3: weeksCovered includes this fixture week', result.notSubmitted[0]?.weeksCovered.includes(isoDate(monday)), result.notSubmitted[0]);
  }

  // =================================================================================================
  // Block B — submitted lifecycle + approval matching.
  // =================================================================================================

  let b1Fingerprint = '';
  let b1: Awaited<ReturnType<typeof oneWorkedWeek>>;

  // B1: SUBMITTED, no approval history, no issues -> READY.
  {
    b1 = await oneWorkedWeek('B1Worker');
    const result = await getTimeLedger(weekRangeQuery(b1.monday, { employeeSearch: 'B1Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), b1.employee.id);
    check('B1: submitted, no history, no issues -> READY', row?.approvalState === 'READY', row);
    check('B1: submissionState SUBMITTED for a VERSION-sourced slice', row?.submissionState === 'SUBMITTED', row?.submissionState);
    check('B1: canonicalSource.dataSource CURRENT_VERSION, submissionSource MANUAL', row?.canonicalSource.dataSource === 'CURRENT_VERSION' && row?.canonicalSource.submissionSource === 'MANUAL', row?.canonicalSource);
    b1Fingerprint = row!.currentFingerprint;
  }

  // B2: CURRENT approval item with the REAL matching fingerprint -> APPROVED.
  {
    const batch = await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: adminUserId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 1, workedMinutes: 450 } });
    await prisma.customerHoursApprovalItem.create({
      data: {
        batchId: batch.id,
        timesheetId: b1.timesheetId,
        employeeId: b1.employee.id,
        siteId: b1.site.id,
        workAreaId: b1.workArea!.id,
        weekStart: b1.monday,
        weekEnd: new Date(b1.monday.getTime() + 6 * 86400000),
        sourceKind: 'VERSION',
        sourceId: randomUUID(),
        fingerprint: b1Fingerprint,
        workedMinutes: 450,
        grossMinutes: 480,
        breakMinutes: 30,
        snapshot: {}
      }
    });
    const result = await getTimeLedger(weekRangeQuery(b1.monday, { employeeSearch: 'B1Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), b1.employee.id);
    check('B2: CURRENT approval item with matching fingerprint -> APPROVED', row?.approvalState === 'APPROVED', row);
    check('B2: currentApprovalItem.fingerprint matches', row?.currentApprovalItem?.fingerprint === b1Fingerprint, row?.currentApprovalItem);
  }

  // B3: CURRENT approval item with a MISMATCHED fingerprint -> CHANGED_AFTER_APPROVAL.
  {
    const worker = await oneWorkedWeek('B3Worker');
    const pre = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'B3Worker' }), adminActor);
    const preRow = findSliceRow(allSliceRows(pre), worker.employee.id)!;
    const batch = await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: adminUserId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 1, workedMinutes: 450 } });
    await prisma.customerHoursApprovalItem.create({
      data: { batchId: batch.id, timesheetId: worker.timesheetId, employeeId: worker.employee.id, siteId: worker.site.id, workAreaId: worker.workArea!.id, weekStart: worker.monday, weekEnd: new Date(worker.monday.getTime() + 6 * 86400000), sourceKind: 'VERSION', sourceId: randomUUID(), fingerprint: 'a'.repeat(64), workedMinutes: 450, grossMinutes: 480, breakMinutes: 30, snapshot: {} }
    });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'B3Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('B3: CURRENT approval item, mismatched fingerprint -> CHANGED_AFTER_APPROVAL', row?.approvalState === 'CHANGED_AFTER_APPROVAL', { preFingerprint: preRow.currentFingerprint, row });
  }

  // B4: only a SUPERSEDED item exists, its fingerprint MATCHES the current slice -> NEEDS_ATTENTION + supersededFingerprintMatch.
  {
    const worker = await oneWorkedWeek('B4Worker');
    const pre = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'B4Worker' }), adminActor);
    const preRow = findSliceRow(allSliceRows(pre), worker.employee.id)!;
    const batch = await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: adminUserId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 1, workedMinutes: 450 } });
    await prisma.customerHoursApprovalItem.create({
      data: {
        batchId: batch.id,
        timesheetId: worker.timesheetId,
        employeeId: worker.employee.id,
        siteId: worker.site.id,
        workAreaId: worker.workArea!.id,
        weekStart: worker.monday,
        weekEnd: new Date(worker.monday.getTime() + 6 * 86400000),
        sourceKind: 'VERSION',
        sourceId: randomUUID(),
        fingerprint: preRow.currentFingerprint,
        workedMinutes: 450,
        grossMinutes: 480,
        breakMinutes: 30,
        snapshot: {},
        approvalState: 'SUPERSEDED',
        supersededAt: new Date(),
        supersededBySourceId: randomUUID()
      }
    });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'B4Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('B4: SUPERSEDED-only, matching fingerprint -> NEEDS_ATTENTION', row?.approvalState === 'NEEDS_ATTENTION', row);
    check('B4: supersededFingerprintMatch = true', row?.supersededFingerprintMatch === true, row);
    check('B4: SUPERSEDED_FINGERPRINT_MATCH warning present', row?.warnings.some((w) => w.code === 'SUPERSEDED_FINGERPRINT_MATCH') ?? false, row?.warnings);
  }

  // B5: only a SUPERSEDED item exists, fingerprint DIFFERENT -> CHANGED_AFTER_APPROVAL, not NEEDS_ATTENTION.
  {
    const worker = await oneWorkedWeek('B5Worker');
    const batch = await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: adminUserId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 1, workedMinutes: 450 } });
    await prisma.customerHoursApprovalItem.create({
      data: {
        batchId: batch.id,
        timesheetId: worker.timesheetId,
        employeeId: worker.employee.id,
        siteId: worker.site.id,
        workAreaId: worker.workArea!.id,
        weekStart: worker.monday,
        weekEnd: new Date(worker.monday.getTime() + 6 * 86400000),
        sourceKind: 'VERSION',
        sourceId: randomUUID(),
        fingerprint: 'b'.repeat(64),
        workedMinutes: 450,
        grossMinutes: 480,
        breakMinutes: 30,
        snapshot: {},
        approvalState: 'SUPERSEDED',
        supersededAt: new Date(),
        supersededBySourceId: randomUUID()
      }
    });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'B5Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('B5: SUPERSEDED-only, mismatched fingerprint -> CHANGED_AFTER_APPROVAL (not NEEDS_ATTENTION)', row?.approvalState === 'CHANGED_AFTER_APPROVAL', row);
    check('B5: supersededFingerprintMatch = false', row?.supersededFingerprintMatch === false, row);
  }

  // =================================================================================================
  // Block C — SOURCE_ERROR (canonical-source invariant failure).
  // =================================================================================================

  {
    const emp = await mkWorker('C1Worker');
    const monday = nextMonday();
    const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    // A non-draft status with no currentVersionId and no TimesheetVersion at all — structurally
    // impossible via the real submit/approve flow, simulating data corruption the read API must
    // surface, never mask.
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'SUBMITTED', currentVersionId: null } });

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'C1Worker' }), adminActor);
    check('C1: canonical-source failure produces exactly one SOURCE_ERROR row', result.sourceErrors.length === 1, result.sourceErrors);
    const err = result.sourceErrors[0] as SourceErrorRow | undefined;
    check('C1: SOURCE_ERROR carries the real timesheetId, workedMinutes null, approvable false', err?.timesheetId === ts.id && err?.workedMinutes === null && err?.approvable === false, err);
    check('C1: reason is the clean invariant identifier, not a stack trace', (err?.reason ?? '').includes('REPORT_CANONICAL_SOURCE_INVARIANT_FAILURE') && !(err?.reason ?? '').includes('    at '), err?.reason);
    check('C1: summary.sourceErrorCount = 1 for this scoped query', result.summary.sourceErrorCount === 1, result.summary);
  }

  // =================================================================================================
  // Block D — blockers.
  // =================================================================================================

  // D1: self-approval forbidden.
  {
    const site = await mkSite('d1');
    const workArea = await mkWorkArea(site.id, 'd1');
    const emp = await mkWorker('D1Worker');
    const selfUser = await prisma.user.create({ data: { username: `tl-self-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId: emp.id, userRoles: { create: { roleId: role.id } } } });
    const asg = await mkAssignment(emp.id, site.id, workArea.id);
    const monday = nextMonday();
    const { ts } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }], 'LOCKED');
    await submitDraft(emp.id, ts.id);

    const selfActor: LedgerActor = { userId: selfUser.id, employeeId: emp.id };
    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'D1Worker' }), selfActor);
    const row = findSliceRow(allSliceRows(result), emp.id);
    check('D1: self-approval blocked, blockers include SELF_APPROVAL_FORBIDDEN', row?.blockers.some((b) => b.code === 'SELF_APPROVAL_FORBIDDEN') ?? false, row?.blockers);
    check('D1: selfApprovalBlocked = true, eligibility.canApprove = false', row?.selfApprovalBlocked === true && row?.eligibility.canApprove === false, row);

    // Same data, viewed by an unrelated admin -> no self-approval blocker.
    const other = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'D1Worker' }), adminActor);
    const otherRow = findSliceRow(allSliceRows(other), emp.id);
    check('D1: a DIFFERENT admin viewing the same slice sees no self-approval blocker', otherRow?.selfApprovalBlocked === false, otherRow);
  }

  // D2: open correction request blocks.
  {
    const worker = await oneWorkedWeek('D2Worker');
    await prisma.correctionRequest.create({ data: { timesheetId: worker.timesheetId, requestedByUserId: adminUserId, reason: 'fixture', status: 'PENDING' } });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'D2Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('D2: open correction request -> OPEN_CORRECTION_REQUEST blocker', row?.blockers.some((b) => b.code === 'OPEN_CORRECTION_REQUEST') ?? false, row?.blockers);
    check('D2: eligibility.canApprove = false', row?.eligibility.canApprove === false, row);
  }

  // =================================================================================================
  // Block E — warnings.
  // =================================================================================================

  // E1: open attendance exception in-week -> warning (generic type).
  {
    const worker = await oneWorkedWeek('E1Worker');
    await prisma.attendanceException.create({ data: { type: 'GPS_NOT_VERIFIED', employeeId: worker.employee.id, timesheetId: worker.timesheetId, occurredAt: at(worker.monday, 10), status: 'OPEN' } });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'E1Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('E1: open attendance exception -> OPEN_ATTENDANCE_EXCEPTION_GPS_NOT_VERIFIED warning', row?.warnings.some((w) => w.code === 'OPEN_ATTENDANCE_EXCEPTION_GPS_NOT_VERIFIED') ?? false, row?.warnings);
    check('E1: a warning-only row is still approvable (no blockers)', row?.eligibility.canApprove === true, row);
  }

  // E1b: EXCESSIVE_SHIFT_DURATION is just another OPEN exception type — no separate reimplementation needed (point 5).
  {
    const worker = await oneWorkedWeek('E1bWorker');
    await prisma.attendanceException.create({ data: { type: 'EXCESSIVE_SHIFT_DURATION', employeeId: worker.employee.id, timesheetId: worker.timesheetId, occurredAt: at(worker.monday, 10), status: 'OPEN' } });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'E1bWorker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('E1b: EXCESSIVE_SHIFT_DURATION surfaces via the generic open-exception path', row?.warnings.some((w) => w.code === 'OPEN_ATTENDANCE_EXCEPTION_EXCESSIVE_SHIFT_DURATION') ?? false, row?.warnings);
  }

  // E1c: a RESOLVED exception never warns, and one outside the week never warns.
  {
    const worker = await oneWorkedWeek('E1cWorker');
    await prisma.attendanceException.create({ data: { type: 'GPS_NOT_VERIFIED', employeeId: worker.employee.id, timesheetId: worker.timesheetId, occurredAt: at(worker.monday, 10), status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: adminUserId } });
    await prisma.attendanceException.create({ data: { type: 'GPS_NOT_VERIFIED', employeeId: worker.employee.id, timesheetId: worker.timesheetId, occurredAt: at(new Date(worker.monday.getTime() + 30 * 86400000), 10), status: 'OPEN' } });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'E1cWorker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('E1c: RESOLVED / out-of-week exceptions never produce a warning', row?.warnings.length === 0, row?.warnings);
  }

  // E2: AUTO submission -> warning.
  {
    const worker = await oneWorkedWeek('E2Worker', { source: SubmissionSource.AUTO });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'E2Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('E2: AUTO submission -> AUTOMATIC_SUBMISSION warning', row?.warnings.some((w) => w.code === 'AUTOMATIC_SUBMISSION') ?? false, row?.warnings);
    check('E2: canonicalSource.submissionSource = AUTO', row?.canonicalSource.submissionSource === 'AUTO', row?.canonicalSource);
  }

  // E3: period still OPEN, within edit window -> EDIT_WINDOW_STILL_OPEN warning.
  {
    const worker = await oneWorkedWeek('E3Worker', { periodStatus: 'OPEN' });
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'E3Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('E3: OPEN period within edit window -> EDIT_WINDOW_STILL_OPEN warning', row?.warnings.some((w) => w.code === 'EDIT_WINDOW_STILL_OPEN') ?? false, row?.warnings);
    check('E3: approvalState downgraded from READY to NEEDS_ATTENTION by the warning', row?.approvalState === 'NEEDS_ATTENTION', row?.approvalState);
  }

  // E4: confirmedZero belonging to a DIFFERENT customer's day never bleeds into this slice's warnings.
  {
    const site = await mkSite('e4');
    const waReal = await mkWorkArea(site.id, 'e4real');
    const waZero = await mkWorkArea(site.id, 'e4zero');
    const emp = await mkWorker('E4Worker');
    const asgReal = await mkAssignment(emp.id, site.id, waReal.id);
    const asgZero = await mkAssignment(emp.id, site.id, waZero.id, false);
    const monday = nextMonday();
    const zeroDay = new Date(monday.getTime() + 86400000); // Tuesday, different day, different customer
    const { ts } = await buildDraft(
      emp.id,
      [
        { day: monday, siteId: site.id, workAreaId: waReal.id, assignmentId: asgReal.id },
        { day: zeroDay, siteId: site.id, workAreaId: waZero.id, assignmentId: asgZero.id, noSegment: true, confirmedZero: true }
      ],
      'LOCKED'
    );
    await submitDraft(emp.id, ts.id);

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'E4Worker' }), adminActor);
    const rows = allSliceRows(result).filter((r) => r.logicalKey.employeeId === emp.id);
    const realRow = rows.find((r) => r.logicalKey.workAreaId === waReal.id);
    check('E4: the real-hours slice exists and has exactly one day', !!realRow && realRow.displayDays.filter((d) => d.segments.length > 0).length === 1, realRow);
    check('E4: no CONFIRMED_ZERO_DAY_PRESENT warning bleeds from the OTHER customer\'s confirmedZero day', !(realRow?.warnings.some((w) => w.code === 'CONFIRMED_ZERO_DAY_PRESENT') ?? true), realRow?.warnings);
  }

  // E5: UT4-B-fixup #3 — displayDays now carries the same canonical grossMinutes/breakMinutes/
  // workedMinutes as the slice, sourced from WeeklyCustomerSlice.dayTotals through
  // buildDisplayDaysForSlice, never a second independent per-segment UI recomputation.
  {
    const worker = await oneWorkedWeek('E5Worker');
    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'E5Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    const workedDay = row?.displayDays.find((d) => d.segments.length > 0);
    check('E5: the one real day is found among the padded 7 displayDays', !!workedDay, row?.displayDays);
    check('E5: displayDays day gross/break/worked satisfy gross = worked + break', workedDay ? workedDay.grossMinutes === workedDay.workedMinutes + workedDay.breakMinutes : false, workedDay);
    check('E5: displayDays day matches the slice-level totals (single-day slice)', workedDay?.grossMinutes === row?.grossMinutes && workedDay?.breakMinutes === row?.breakMinutes && workedDay?.workedMinutes === row?.workedMinutes, { day: workedDay, row });
    check('E5: displayDays day workedMinutes = 450 (07:00-15:00 minus 30 min auto lunch, same as row.workedMinutes)', workedDay?.workedMinutes === 450, workedDay);
    const emptyDays = row?.displayDays.filter((d) => d.segments.length === 0) ?? [];
    check('E5: every padded empty day carries zero gross/break/worked minutes', emptyDays.every((d) => d.grossMinutes === 0 && d.breakMinutes === 0 && d.workedMinutes === 0), emptyDays);
  }

  // =================================================================================================
  // Block F — partial-range normalization, wide explicit range, all-time cross-chunk sort, exact
  // pre-pagination summary, and Tier-2 filters.
  // =================================================================================================

  // F1: a 1-day partial request normalizes to the full Helsinki week and yields the SAME fingerprint as the full-week request.
  {
    const wednesday = new Date(b1.monday.getTime() + 2 * 86400000);
    const partial = baseQuery({ requestedRange: { startDate: isoDate(wednesday), endDate: isoDate(wednesday) }, employeeSearch: 'B1Worker' });
    const result = await getTimeLedger(partial, adminActor);
    check('F1: effectiveWeekRange normalizes a 1-day request to the full Mon-Sun week', result.effectiveWeekRange?.startDate === isoDate(b1.monday) && result.effectiveWeekRange?.endDate === isoDate(new Date(b1.monday.getTime() + 6 * 86400000)), result.effectiveWeekRange);
    const row = findSliceRow(allSliceRows(result), b1.employee.id);
    check('F1: fingerprint is the same full-week fingerprint regardless of the partial request window', row?.currentFingerprint === b1Fingerprint, { got: row?.currentFingerprint, want: b1Fingerprint });
  }

  // F2: explicit wide range (> 4 weeks, not allTime) -> chunked mode, still finds both fixtures.
  {
    const w1 = await oneWorkedWeek('F2Wide');
    const w2Monday = new Date(w1.monday.getTime() + 5 * 7 * 86400000); // 5 weeks later
    const site2 = await mkSite('f2b');
    const wa2 = await mkWorkArea(site2.id, 'f2b');
    const emp2 = await mkWorker('F2Wide');
    const asg2 = await mkAssignment(emp2.id, site2.id, wa2.id);
    const { ts: ts2 } = await buildDraft(emp2.id, [{ day: w2Monday, siteId: site2.id, workAreaId: wa2.id, assignmentId: asg2.id }], 'LOCKED');
    await submitDraft(emp2.id, ts2.id);

    const wideEnd = new Date(w2Monday.getTime() + 6 * 86400000);
    const result = await getTimeLedger(baseQuery({ requestedRange: { startDate: isoDate(w1.monday), endDate: isoDate(wideEnd) }, employeeSearch: 'F2Wide' }), adminActor);
    check('F2: explicit >4-week range still finds both fixtures (chunked path)', result.summary.sliceCount === 2, result.summary);
    const weeks = Math.round((new Date(result.effectiveWeekRange!.endDate).getTime() - new Date(result.effectiveWeekRange!.startDate).getTime()) / (7 * 86400000)) + 1;
    check('F2: effectiveWeekRange spans more than 4 weeks (confirms chunked, not fast, boundary)', weeks > 4, weeks);
  }

  // F3: allTime cross-chunk global sort — the comparator's real primary key (siteId) must win
  // globally even when the chunk that sorts FIRST is scanned LAST. The comparator sorts by
  // siteId (a UUID), not by site name (site names aren't resolved until the page is hydrated, long
  // after the whole-history sort), so this deliberately assigns the LEXICALLY SMALLER siteId to the
  // LATER-scanned period and the LARGER one to the EARLIER-scanned period -- the one arrangement a
  // "sort within chunk, concatenate" implementation would get wrong.
  {
    const siteX = await mkSite('f3x');
    const siteY = await mkSite('f3y');
    const [smallerSite, largerSite] = siteX.id < siteY.id ? [siteX, siteY] : [siteY, siteX];

    const earlyMonday = nextMonday(); // scanned FIRST (chunked path orders periods by startDate asc)
    const lateMonday = new Date(earlyMonday.getTime() + 400 * 7 * 86400000); // scanned LAST, ~400 weeks later

    const waLarger = await mkWorkArea(largerSite.id, 'f3-larger');
    const empLarger = await mkWorker('F3LargerWorker');
    const asgLarger = await mkAssignment(empLarger.id, largerSite.id, waLarger.id);
    const { ts: tsLarger } = await buildDraft(empLarger.id, [{ day: earlyMonday, siteId: largerSite.id, workAreaId: waLarger.id, assignmentId: asgLarger.id }], 'LOCKED');
    await submitDraft(empLarger.id, tsLarger.id);

    const waSmaller = await mkWorkArea(smallerSite.id, 'f3-smaller');
    const empSmaller = await mkWorker('F3SmallerWorker');
    const asgSmaller = await mkAssignment(empSmaller.id, smallerSite.id, waSmaller.id);
    const { ts: tsSmaller } = await buildDraft(empSmaller.id, [{ day: lateMonday, siteId: smallerSite.id, workAreaId: waSmaller.id, assignmentId: asgSmaller.id }], 'LOCKED');
    await submitDraft(empSmaller.id, tsSmaller.id);

    const result = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'F3' }), adminActor, { chunkSize: 1 });
    const rows = allSliceRows(result);
    const idxSmaller = rows.findIndex((r) => r.logicalKey.siteId === smallerSite.id);
    const idxLarger = rows.findIndex((r) => r.logicalKey.siteId === largerSite.id);
    check('F3: both cross-chunk fixtures are present', idxSmaller >= 0 && idxLarger >= 0, { idxSmaller, idxLarger, rows: rows.map((r) => r.logicalKey.siteId) });
    check(
      "F3: the LATER-scanned chunk's smaller-siteId entry still sorts FIRST globally (true two-pass sort, not sort-within-chunk)",
      idxSmaller < idxLarger,
      { idxSmaller, idxLarger, smallerSiteId: smallerSite.id, largerSiteId: largerSite.id }
    );
  }

  // F4: exact pre-pagination summary in allTime/chunked mode with pageSize=1.
  {
    const site = await mkSite('f4');
    const workArea = await mkWorkArea(site.id, 'f4');
    const monday1 = nextMonday();
    const monday2 = new Date(monday1.getTime() + 50 * 7 * 86400000);
    for (const [tag, monday] of [['F4Worker1', monday1] as const, ['F4Worker2', monday2] as const]) {
      const emp = await mkWorker(tag);
      const asg = await mkAssignment(emp.id, site.id, workArea.id);
      const { ts } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }], 'LOCKED');
      await submitDraft(emp.id, ts.id);
    }
    const result = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'F4Worker', page: 1, pageSize: 1 }), adminActor, { chunkSize: 1 });
    check('F4: pagination returns exactly 1 row per page', allSliceRows(result).length === 1, allSliceRows(result).length);
    check('F4: totalItems = 2 (both fixtures), totalPages = 2', result.pagination.totalItems === 2 && result.pagination.totalPages === 2, result.pagination);
    check('F4: summary reflects BOTH entries, not just the current page (workedMinutes = 900)', result.summary.workedMinutes === 900 && result.summary.sliceCount === 2, result.summary);
  }

  // F5: Tier-2 filters — status/onlyIssues/submissionSource/siteId/workAreaId.
  {
    const allNoFilter = await getTimeLedger(baseQuery({ allTime: true }), adminActor, { chunkSize: 5 });
    const b4Row = () => allSliceRows(allNoFilter).find((r) => r.employeeName.includes('B4Worker'));
    check('F5 baseline: B4 (NEEDS_ATTENTION) is visible with status=all', !!b4Row(), b4Row());

    const needsAttentionOnly = await getTimeLedger(baseQuery({ allTime: true, status: 'needs_attention' }), adminActor, { chunkSize: 5 });
    check('F5: status=needs_attention includes B4 (NEEDS_ATTENTION)', allSliceRows(needsAttentionOnly).some((r) => r.employeeName.includes('B4Worker')), 'missing');
    check('F5: status=needs_attention excludes B2 (APPROVED)', !allSliceRows(needsAttentionOnly).some((r) => r.employeeName.includes('B1Worker')), 'leaked APPROVED row');

    const changedOnly = await getTimeLedger(baseQuery({ allTime: true, onlyChangedAfterApproval: true }), adminActor, { chunkSize: 5 });
    check('F5: onlyChangedAfterApproval includes B3 and B5', allSliceRows(changedOnly).some((r) => r.employeeName.includes('B3Worker')) && allSliceRows(changedOnly).some((r) => r.employeeName.includes('B5Worker')), allSliceRows(changedOnly).map((r) => r.employeeName));
    check('F5: onlyChangedAfterApproval excludes a clean READY row', !allSliceRows(changedOnly).some((r) => r.employeeName.includes('A1Worker')), 'leaked');

    const issuesOnly = await getTimeLedger(baseQuery({ allTime: true, onlyIssues: true }), adminActor, { chunkSize: 5 });
    check('F5: onlyIssues includes D2 (open correction blocker)', allSliceRows(issuesOnly).some((r) => r.employeeName.includes('D2Worker')), 'missing');
    check('F5: onlyIssues includes E1 (open exception warning)', allSliceRows(issuesOnly).some((r) => r.employeeName.includes('E1Worker') && !r.employeeName.includes('E1c') && !r.employeeName.includes('E1b')), 'missing');

    const autoOnly = await getTimeLedger(baseQuery({ allTime: true, submissionSource: 'auto' }), adminActor, { chunkSize: 5 });
    check('F5: submissionSource=auto includes E2 (AUTO)', allSliceRows(autoOnly).some((r) => r.employeeName.includes('E2Worker')), 'missing');
    check('F5: submissionSource=auto excludes B1 (MANUAL)', !allSliceRows(autoOnly).some((r) => r.employeeName.includes('B1Worker')), 'leaked');

    const siteFiltered = await getTimeLedger(baseQuery({ allTime: true, siteId: b1.site.id }), adminActor, { chunkSize: 5 });
    check('F5: siteId filter includes only that site\'s rows', allSliceRows(siteFiltered).every((r) => r.logicalKey.siteId === b1.site.id), allSliceRows(siteFiltered).map((r) => r.logicalKey.siteId));
    check('F5: siteId filter finds B1\'s row', allSliceRows(siteFiltered).some((r) => r.logicalKey.employeeId === b1.employee.id), 'missing');

    const workAreaFiltered = await getTimeLedger(baseQuery({ allTime: true, workAreaId: b1.workArea!.id }), adminActor, { chunkSize: 5 });
    check('F5: workAreaId filter includes only that work area\'s rows, and excludes NOT_SUBMITTED/SOURCE_ERROR', workAreaFiltered.notSubmitted.length === 0 && workAreaFiltered.sourceErrors.length === 0 && allSliceRows(workAreaFiltered).every((r) => r.logicalKey.workAreaId === b1.workArea!.id), { notSubmitted: workAreaFiltered.notSubmitted.length, sourceErrors: workAreaFiltered.sourceErrors.length });

    // Point 2 — status=not_submitted must ALSO surface real DRAFT/RETURNED slices
    // (submissionState=NOT_SUBMITTED), not just placeholder NotSubmittedRow entries.
    const notSubmittedOnly = await getTimeLedger(baseQuery({ allTime: true, status: 'not_submitted' }), adminActor, { chunkSize: 5 });
    check('F5: status=not_submitted includes placeholder rows (A2/A3)', notSubmittedOnly.notSubmitted.length >= 2, notSubmittedOnly.notSubmitted.length);
    check(
      'F5: status=not_submitted also includes a REAL draft slice (A1, submissionState=NOT_SUBMITTED)',
      allSliceRows(notSubmittedOnly).some((r) => r.employeeName.includes('A1Worker') && r.submissionState === 'NOT_SUBMITTED'),
      allSliceRows(notSubmittedOnly).map((r) => ({ name: r.employeeName, state: r.submissionState }))
    );
    check('F5: status=not_submitted excludes a real SUBMITTED slice (B1)', !allSliceRows(notSubmittedOnly).some((r) => r.employeeName.includes('B1Worker')), 'leaked');
  }

  // F6: notSubmittedWorkerCount dedup — one worker with TWO draft customer slices (different work
  // areas, same timesheet) counts once, not twice (point 3).
  {
    const site = await mkSite('f6dedup');
    const waX = await mkWorkArea(site.id, 'f6dedupX');
    const waY = await mkWorkArea(site.id, 'f6dedupY');
    const emp = await mkWorker('F6DedupWorker');
    const asgX = await mkAssignment(emp.id, site.id, waX.id);
    const asgY = await mkAssignment(emp.id, site.id, waY.id, false);
    const monday = nextMonday();
    await buildDraft(
      emp.id,
      [
        { day: monday, siteId: site.id, workAreaId: waX.id, assignmentId: asgX.id },
        { day: new Date(monday.getTime() + 86400000), siteId: site.id, workAreaId: waY.id, assignmentId: asgY.id }
      ],
      'LOCKED'
    );

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'F6DedupWorker' }), adminActor);
    const rows = allSliceRows(result).filter((r) => r.logicalKey.employeeId === emp.id);
    check('F6-dedup: worker produced two distinct draft customer slices', rows.length === 2, rows.map((r) => r.logicalKey.workAreaId));
    check('F6-dedup: notSubmittedWorkerCount counts this worker ONCE, not twice', result.summary.notSubmittedWorkerCount === 1, result.summary);
  }

  // =================================================================================================
  // Block J — OPEN_SHIFT blocker (point 5): only fires for the exact (employee, site, workArea,
  // week) the open shift actually belongs to — never bleeds into an unrelated customer or week.
  // =================================================================================================

  {
    const site = await mkSite('j1');
    const waTarget = await mkWorkArea(site.id, 'j1-target');
    const waOther = await mkWorkArea(site.id, 'j1-other');
    const emp = await mkWorker('J1Worker');
    const asgTarget = await mkAssignment(emp.id, site.id, waTarget.id);
    const asgOther = await mkAssignment(emp.id, site.id, waOther.id, false);
    const monday = nextMonday();
    // Two real slices for the SAME employee/week: one at waTarget (the open shift's own customer),
    // one at waOther (a different customer) — only the former may ever see the blocker.
    const { ts } = await buildDraft(
      emp.id,
      [
        { day: monday, siteId: site.id, workAreaId: waTarget.id, assignmentId: asgTarget.id },
        { day: new Date(monday.getTime() + 86400000), siteId: site.id, workAreaId: waOther.id, assignmentId: asgOther.id }
      ],
      'LOCKED'
    );
    await submitDraft(emp.id, ts.id);
    await mkOpenShift(emp.id, site.id, waTarget.id, at(monday, 20));

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'J1Worker' }), adminActor);
    const rows = allSliceRows(result).filter((r) => r.logicalKey.employeeId === emp.id);
    const targetRow = rows.find((r) => r.logicalKey.workAreaId === waTarget.id);
    const otherRow = rows.find((r) => r.logicalKey.workAreaId === waOther.id);
    check('J1: OPEN_SHIFT blocks the slice it actually belongs to (same employee/site/customer/week)', targetRow?.blockers.some((b) => b.code === 'OPEN_SHIFT') ?? false, targetRow?.blockers);
    check('J1: eligibility.canApprove = false on the blocked slice', targetRow?.eligibility.canApprove === false, targetRow);
    check('J1: OPEN_SHIFT does NOT bleed into a different customer slice for the same employee/week', !(otherRow?.blockers.some((b) => b.code === 'OPEN_SHIFT') ?? false), otherRow?.blockers);
  }

  // J2: an open shift OUTSIDE the slice's own week never blocks it.
  {
    const worker = await oneWorkedWeek('J2Worker');
    const farAway = new Date(worker.monday.getTime() + 30 * 86400000);
    await mkOpenShift(worker.employee.id, worker.site.id, worker.workArea!.id, farAway);

    const result = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'J2Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), worker.employee.id);
    check('J2: an open shift outside this slice\'s own week never blocks it', !(row?.blockers.some((b) => b.code === 'OPEN_SHIFT') ?? true), row?.blockers);
  }

  // =================================================================================================
  // Block K — PLAN_ACTUAL_MISMATCH warning (point 6), VERSION-sourced slices only, via the existing
  // batch helper computeSiteScopeHasExceptionBulk (never a separately invented formula).
  // =================================================================================================

  {
    const site = await mkSite('k1');
    const workArea = await mkWorkArea(site.id, 'k1');
    const emp = await mkWorker('K1Worker');
    const asg = await mkAssignment(emp.id, site.id, workArea.id);
    const monday = nextMonday();
    const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
    const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
    // Planned 07:00-15:00 (8h), ACTUAL segment 07:00-17:00 (10h) — a deliberate plan/actual mismatch.
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: monday, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: monday, startAt: at(monday, 7), endAt: at(monday, 17), siteId: site.id, workAreaId: workArea.id, sourceAssignmentId: asg.id } });
    await submitDraft(emp.id, ts.id);

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'K1Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), emp.id);
    check('K1: a real plan/actual mismatch -> PLAN_ACTUAL_MISMATCH warning', row?.warnings.some((w) => w.code === 'PLAN_ACTUAL_MISMATCH') ?? false, row?.warnings);
  }

  // K2: a matching plan/actual (B1's own fixture) never gets a false PLAN_ACTUAL_MISMATCH.
  {
    const result = await getTimeLedger(weekRangeQuery(b1.monday, { employeeSearch: 'B1Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), b1.employee.id);
    check('K2: matching plan/actual never produces a false PLAN_ACTUAL_MISMATCH', !(row?.warnings.some((w) => w.code === 'PLAN_ACTUAL_MISMATCH') ?? true), row?.warnings);
  }

  // K3: a DRAFT-sourced slice never gets PLAN_ACTUAL_MISMATCH — deferred by design (point 6: no
  // separately-invented, incompatible formula for a draft). A1Worker's own draft fixture (Block A1)
  // has planned=actual anyway, so this specifically proves the code path is skipped for DRAFT
  // sources, not merely that the underlying data happens to match.
  {
    const site = await mkSite('k3');
    const workArea = await mkWorkArea(site.id, 'k3');
    const emp = await mkWorker('K3Worker');
    const asg = await mkAssignment(emp.id, site.id, workArea.id);
    const monday = nextMonday();
    // Same deliberate planned-vs-actual mismatch as K1, but left as a DRAFT (never submitted).
    await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }], 'LOCKED');
    const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { startDate: monday } });
    const ts = await prisma.timesheet.findFirstOrThrow({ where: { periodId: period.id, employeeId: emp.id } });
    const draft = await prisma.timesheetDraft.findFirstOrThrow({ where: { timesheetId: ts.id } });
    const day = await prisma.timesheetDraftDay.findFirstOrThrow({ where: { draftId: draft.id, date: monday } });
    await prisma.timesheetDraftSegment.updateMany({ where: { draftDayId: day.id }, data: { endAt: at(monday, 20) } }); // stretch actual to 07:00-20:00 vs an 07:00-15:00 plan

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'K3Worker' }), adminActor);
    const row = findSliceRow(allSliceRows(result), emp.id);
    check('K3: a DRAFT-sourced slice never gets PLAN_ACTUAL_MISMATCH, even with a real planned/actual mismatch present', !(row?.warnings.some((w) => w.code === 'PLAN_ACTUAL_MISMATCH') ?? true), row?.warnings);
  }

  // =================================================================================================
  // Block L — onlyIssues explicit three-way semantics (point 7): SOURCE_ERROR and NOT_SUBMITTED
  // always pass; a real slice passes only when it actually carries a blocker/warning.
  // =================================================================================================

  {
    const issuesOnly = await getTimeLedger(baseQuery({ allTime: true, onlyIssues: true }), adminActor, { chunkSize: 5 });
    check('L: onlyIssues=true keeps SOURCE_ERROR (C1) — a real, unresolved problem', issuesOnly.sourceErrors.some((e) => e.employeeName.includes('C1Worker')), issuesOnly.sourceErrors.map((e) => e.employeeName));
    check('L: onlyIssues=true keeps placeholder NOT_SUBMITTED rows (A2/A3)', issuesOnly.notSubmitted.length > 0, issuesOnly.notSubmitted.length);
    check(
      'L: onlyIssues=true EXCLUDES a clean draft slice with zero blockers/warnings (A1 — sourceKind=DRAFT alone is not an issue)',
      !allSliceRows(issuesOnly).some((r) => r.employeeName.includes('A1Worker')),
      allSliceRows(issuesOnly)
        .filter((r) => r.employeeName.includes('A1Worker'))
        .map((r) => ({ blockers: r.blockers, warnings: r.warnings }))
    );
  }

  // =================================================================================================
  // Block M — siteId excludes any entry whose site attribution cannot be proven (point 8):
  // SOURCE_ERROR and a timesheet-backed (empty-draft) NOT_SUBMITTED placeholder are both excluded
  // under an active siteId filter; a genuinely site-attributed participant-backed NOT_SUBMITTED
  // still passes.
  // =================================================================================================

  {
    const siteFiltered = await getTimeLedger(baseQuery({ allTime: true, siteId: b1.site.id }), adminActor, { chunkSize: 5 });
    check('M: siteId filter excludes SOURCE_ERROR rows (site attribution unprovable)', siteFiltered.sourceErrors.length === 0, siteFiltered.sourceErrors);
    check(
      'M: siteId filter excludes a timesheet-backed (empty-draft) NOT_SUBMITTED placeholder (A2)',
      !siteFiltered.notSubmitted.some((r) => r.employeeName.includes('A2Worker')),
      siteFiltered.notSubmitted.map((r) => r.employeeName)
    );
  }

  // M2: a participant-backed NOT_SUBMITTED with a REAL, provable site assignment still passes an
  // active siteId filter for that exact site.
  {
    const site = await mkSite('m2');
    const emp = await mkWorker('M2Worker');
    await mkAssignment(emp.id, site.id, null);
    const monday = nextMonday();
    const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });

    const result = await getTimeLedger(weekRangeQuery(monday, { employeeSearch: 'M2Worker', siteId: site.id }), adminActor);
    check('M2: a genuinely site-attributed participant-backed NOT_SUBMITTED still passes the siteId filter', result.notSubmitted.some((r) => r.employeeName.includes('M2Worker')), result.notSubmitted);
  }

  // =================================================================================================
  // Block N — pagination.page always echoes the request; a page beyond the last is empty, never a
  // silent duplicate of the last page (point 9).
  // =================================================================================================

  {
    const result = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'B1Worker', page: 999, pageSize: 10 }), adminActor, { chunkSize: 5 });
    check('N: pagination.page echoes the REQUESTED page (999), not a clamped last page', result.pagination.page === 999, result.pagination);
    check('N: a page beyond the last has zero rows (not a copy of the last page)', allSliceRows(result).length === 0 && result.notSubmitted.length === 0 && result.sourceErrors.length === 0, result);
    check('N: totalItems/totalPages still reflect the true (small) result set', result.pagination.totalItems >= 1 && result.pagination.totalPages >= 1 && result.pagination.totalPages < 999, result.pagination);
  }

  // =================================================================================================
  // Block G — the two-pass consistency check (409 regression).
  // =================================================================================================

  {
    const worker = await oneWorkedWeek('G1Worker');
    const pre = await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'G1Worker' }), adminActor);
    const preRow = findSliceRow(allSliceRows(pre), worker.employee.id)!;
    check('G1 setup: fast-path pre-query finds the slice', !!preRow);

    let hookFired = false;
    let thrown: unknown = null;
    try {
      await getTimeLedger(
        baseQuery({ allTime: true, siteId: worker.site.id, page: 1, pageSize: 10 }),
        adminActor,
        {
          chunkSize: 1,
          afterDescriptorPass: async () => {
            hookFired = true;
            const batch = await prisma.customerHoursApprovalBatch.create({ data: { approvedByUserId: adminUserId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: {}, itemCount: 1, workedMinutes: preRow.workedMinutes } });
            await prisma.customerHoursApprovalItem.create({
              data: {
                batchId: batch.id,
                timesheetId: preRow.logicalKey.timesheetId,
                employeeId: preRow.logicalKey.employeeId,
                siteId: preRow.logicalKey.siteId,
                workAreaId: preRow.logicalKey.workAreaId,
                weekStart: new Date(`${preRow.logicalKey.weekStart}T00:00:00.000Z`),
                weekEnd: new Date(`${preRow.logicalKey.weekEnd}T00:00:00.000Z`),
                sourceKind: preRow.canonicalSource.sourceKind,
                sourceId: preRow.canonicalSource.sourceId,
                sourceRevision: preRow.canonicalSource.sourceKind === 'DRAFT' ? BigInt(preRow.canonicalSource.sourceRevision ?? '0') : null,
                fingerprint: preRow.currentFingerprint,
                workedMinutes: preRow.workedMinutes,
                grossMinutes: preRow.grossMinutes,
                breakMinutes: preRow.breakMinutes,
                snapshot: {}
              }
            });
          }
        },
        prisma
      );
    } catch (err) {
      thrown = err;
    }
    check('G1: afterDescriptorPass hook fired exactly once between Pass 1 and Pass 2', hookFired);
    check('G1: a mutation between passes throws TimeLedgerReadChangedError (whole-response 409)', thrown instanceof TimeLedgerReadChangedError, thrown);
    check('G1: the error names the affected entry key', thrown instanceof TimeLedgerReadChangedError && thrown.affectedEntryKeys.length === 1, thrown instanceof TimeLedgerReadChangedError ? thrown.affectedEntryKeys : thrown);
  }

  // G2: the afterDescriptorPass hook is structurally inapplicable to (never fires in) the fast path.
  {
    const worker = await oneWorkedWeek('G2Worker');
    let hookFired = false;
    await getTimeLedger(weekRangeQuery(worker.monday, { employeeSearch: 'G2Worker' }), adminActor, { afterDescriptorPass: async () => { hookFired = true; } });
    check('G2: afterDescriptorPass never fires on the fast path (no time gap to guard)', !hookFired);
  }

  // =================================================================================================
  // Block H — query-count properties.
  // =================================================================================================

  const qcPrisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  let qcCount = 0;
  (qcPrisma as unknown as { $on: (event: 'query', cb: () => void) => void }).$on('query', () => {
    qcCount += 1;
  });

  async function seedFastPathWorkers(n: number, tag: string) {
    const site = await mkSite(`qc-${tag}`);
    const workArea = await mkWorkArea(site.id, `qc-${tag}`);
    const monday = nextMonday();
    for (let i = 0; i < n; i++) {
      const emp = await mkWorker(`QC${tag}-${i}`);
      const asg = await mkAssignment(emp.id, site.id, workArea.id);
      const { ts } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }], 'LOCKED');
      await submitDraft(emp.id, ts.id);
    }
    return { monday };
  }

  // H1: fast path — query count must not scale with worker count (5 vs 50).
  {
    const { monday: monday5 } = await seedFastPathWorkers(5, 'h1a');
    qcCount = 0;
    const r5 = await getTimeLedger(weekRangeQuery(monday5, { employeeSearch: 'QCh1a-' }), adminActor, {}, qcPrisma);
    const qc5 = qcCount;
    check('H1: n=5 fast-path query returns 5 slice rows', r5.summary.sliceCount === 5, r5.summary);

    const { monday: monday50 } = await seedFastPathWorkers(50, 'h1b');
    qcCount = 0;
    const r50 = await getTimeLedger(weekRangeQuery(monday50, { employeeSearch: 'QCh1b-' }), adminActor, {}, qcPrisma);
    const qc50 = qcCount;
    check('H1: n=50 fast-path query returns 50 slice rows', r50.summary.sliceCount === 50, r50.summary);

    console.log(`  H1 query counts: n=5 -> ${qc5} SQL statements, n=50 -> ${qc50} SQL statements`);
    // A generous absolute tolerance, not a percentage: real O(n) scaling for 5->50 workers would add
    // dozens of statements (one per extra worker at minimum), dwarfing ordinary run-to-run jitter.
    check('H1: fast-path query count does not scale with worker count (bounded, not O(n))', Math.abs(qc50 - qc5) <= 15, { qc5, qc50 });
  }

  // H2: chunked path — query count tracks chunk count, not entries-per-chunk.
  {
    async function seedChunked(perPeriod: number, periodsCount: number, tag: string) {
      const site = await mkSite(`ch-${tag}`);
      const workArea = await mkWorkArea(site.id, `ch-${tag}`);
      for (let p = 0; p < periodsCount; p++) {
        const monday = nextMonday();
        // All `perPeriod` workers share ONE PayrollPeriod (created once, LOCKED once, reused by every
        // buildDraft call below) so this scenario's chunk count is periodsCount, not periodsCount*perPeriod.
        const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
        for (let i = 0; i < perPeriod; i++) {
          const emp = await mkWorker(`CH${tag}-${p}-${i}`);
          const asg = await mkAssignment(emp.id, site.id, workArea.id);
          const { ts } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }], 'LOCKED', period);
          await submitDraft(emp.id, ts.id);
        }
      }
    }

    // Seed BOTH groups before measuring either query, so the global period/chunk count seen by
    // both getTimeLedger calls below is identical — only entries-per-chunk differs (1 vs 8).
    await seedChunked(1, 3, 'x1');
    await seedChunked(8, 3, 'x2');

    qcCount = 0;
    const rX1 = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'CHx1-' }), adminActor, { chunkSize: 1 }, qcPrisma);
    const qcX1 = qcCount;

    qcCount = 0;
    const rX2 = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'CHx2-' }), adminActor, { chunkSize: 1 }, qcPrisma);
    const qcX2 = qcCount;

    check('H2: x1 sliceCount = 3 (1 worker x 3 periods)', rX1.summary.sliceCount === 3, rX1.summary);
    check('H2: x2 sliceCount = 24 (8 workers x 3 periods)', rX2.summary.sliceCount === 24, rX2.summary);
    console.log(`  H2 query counts (same chunk count, different entries/chunk): x1(1/period) -> ${qcX1}, x2(8/period) -> ${qcX2}`);
    check('H2: chunked query count tracks chunk count, not entries-per-chunk (1 vs 8 workers/period, same chunk count)', Math.abs(qcX1 - qcX2) <= 15, { qcX1, qcX2 });
  }

  await qcPrisma.$disconnect();

  // =================================================================================================
  // Block I — empty all-time range contract.
  // =================================================================================================

  {
    const result = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'NO-SUCH-WORKER-TAG-XYZ' }), adminActor, { chunkSize: 5 });
    check('I: empty allTime result has zeroed summary and no rows, no crash', result.summary.entryCount === 0 && result.customerGroups.length === 0 && result.notSubmitted.length === 0 && result.sourceErrors.length === 0, result);
    // Point 9 — an honest empty page: totalItems=0 AND totalPages=0, never a fictitious "1 page of 0 items".
    check('I: pagination reports totalItems=0, totalPages=0 (point 9 — no fictitious page)', result.pagination.totalItems === 0 && result.pagination.totalPages === 0, result.pagination);
    check('I: allTime=true and effectiveWeekRange is null', result.allTime === true && result.effectiveWeekRange === null, { allTime: result.allTime, effectiveWeekRange: result.effectiveWeekRange });
    // Point 4 — allTime with zero surviving entries must report dataRange=null, never the raw
    // (pre-filter) extent of every period the server happens to have.
    check('I: allTime with zero matching entries -> dataRange=null (point 4)', result.dataRange === null, result.dataRange);
  }

  // I2: dataRange for an EXPLICIT (non-allTime) range is always null, per the accepted contract —
  // the caller already knows the range it asked for (point 4).
  {
    const result = await getTimeLedger(weekRangeQuery(b1.monday, { employeeSearch: 'B1Worker' }), adminActor);
    check('I2: explicit-range dataRange is always null', result.dataRange === null, result.dataRange);
  }

  // I3: allTime WITH matching entries computes a real dataRange from the full filtered entry set
  // (slice weekStart/weekEnd), not from the raw unfiltered period list (point 4).
  {
    const result = await getTimeLedger(baseQuery({ allTime: true, employeeSearch: 'B1Worker' }), adminActor, { chunkSize: 5 });
    check(
      'I3: allTime dataRange with real matches spans exactly B1\'s own week',
      result.dataRange?.startDate === isoDate(b1.monday) && result.dataRange?.endDate === isoDate(new Date(b1.monday.getTime() + 6 * 86400000)),
      result.dataRange
    );
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
