// Auto-close an abandoned shift (owner ask 2026-08-28). Covers resolveAutoCloseEndAt (pure) and
// runAbandonedShiftAutoCloseTick end-to-end (frozen ClockShift + SHIFT_AUTO_CLOSED_MAX_DURATION +
// inline materialize), plus annotateAutoClosedShiftWithLateCheckOut.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL) and the reserved
// system.scheduler actor (present in every seeded DB).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { ensureEmployeePeriodCore } from '../lib/periods';
import { runAbandonedShiftAutoCloseTick, resolveAutoCloseEndAt, annotateAutoClosedShiftWithLateCheckOut } from '../lib/attendance-abandoned-shift';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

const HOUR = 3_600_000;

async function checkInEvent(employeeId: string, siteId: string, assignmentId: string | null, at: Date) {
  return prisma.clockEvent.create({
    data: {
      id: randomUUID(),
      employeeId,
      operationType: 'CHECK_IN',
      siteId,
      sourceAssignmentId: assignmentId,
      clientCapturedAt: at,
      capturedOffline: false,
      effectiveAt: at,
      gpsVerification: 'NOT_VERIFIED',
      gpsUnavailableReason: 'POSITION_UNAVAILABLE',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      requestId: randomUUID()
    }
  });
}

/** admin + fresh employee + site + (optional) template + assignment + OPEN period + timesheet +
 *  a CHECK_IN ClockEvent and an EmployeeOpenShift opened at `openedAt`. */
async function makeOpenShift(opts: { openedAt: Date; withTemplate: boolean; templateEndHour?: number }) {
  const admin = await prisma.user.create({ data: { username: `ac_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `AC-${randomUUID().slice(0, 8)}`, firstName: 'A', lastName: 'C' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  const site = await prisma.workSite.create({ data: { name: `AC site ${randomUUID().slice(0, 5)}` } });

  let templateVersionId: string | null = null;
  if (opts.withTemplate) {
    const tpl = await prisma.workScheduleTemplate.create({ data: { name: `AC ${randomUUID().slice(0, 6)}` } });
    const v = await prisma.workScheduleTemplateVersion.create({ data: { templateId: tpl.id, versionNumber: 1, createdByUserId: admin.id, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') } });
    const endHour = opts.templateEndHour ?? 17;
    await prisma.workScheduleTemplateVersionDay.createMany({
      data: Array.from({ length: 7 }, (_, weekday) => ({
        templateVersionId: v.id,
        weekday,
        isWorkingDay: true,
        plannedStartTime: new Date('1970-01-01T07:00:00Z'),
        plannedEndTime: new Date(`1970-01-01T${String(endHour).padStart(2, '0')}:00:00Z`),
        plannedBreakMinutes: 0
      }))
    });
    templateVersionId = v.id;
  }

  const asg = await prisma.siteAssignment.create({
    data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: new Date('2020-01-01'), validTo: null, assignedByUserId: admin.id, templateVersionId }
  });

  // OPEN period covering openedAt (± a few days), unique per fixture (fresh employee → no overlap).
  const dayMs = 86_400_000;
  const startDate = new Date(Date.UTC(opts.openedAt.getUTCFullYear(), opts.openedAt.getUTCMonth(), opts.openedAt.getUTCDate()) - 3 * dayMs);
  const endDate = new Date(startDate.getTime() + 9 * dayMs);
  const period = await prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: admin.id } });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId: emp.id, startDate, endDate });
  });

  const checkIn = await checkInEvent(emp.id, site.id, asg.id, opts.openedAt);
  await prisma.employeeOpenShift.create({
    data: { employeeId: emp.id, openedByClockEventId: checkIn.id, siteId: site.id, sourceAssignmentId: asg.id, openedAt: opts.openedAt }
  });

  return { admin, emp, site, asg, period, checkInId: checkIn.id };
}

async function main() {
  // ---- resolveAutoCloseEndAt (pure) ----
  {
    const openedAt = new Date('2033-06-15T11:00:00Z');
    const templateEndTime = new Date('1970-01-01T17:00:00Z');
    const r1 = resolveAutoCloseEndAt({ openedAt, maxShiftDurationHours: 16, fallbackHours: 8, templateEndTime });
    // 2033-06-15 17:00 Helsinki (EEST +3) = 14:00Z, which is 3 h after openedAt and under the 16 h cap.
    check('template end in range -> TEMPLATE', r1.source === 'TEMPLATE' && r1.endAt.toISOString() === '2033-06-15T14:00:00.000Z', r1);

    // template end already before check-in -> fallback
    const lateOpen = new Date('2033-06-15T20:00:00Z');
    const r2 = resolveAutoCloseEndAt({ openedAt: lateOpen, maxShiftDurationHours: 16, fallbackHours: 8, templateEndTime });
    check('template end before check-in -> FALLBACK (openedAt + 8h)', r2.source === 'FALLBACK' && r2.endAt.getTime() === lateOpen.getTime() + 8 * HOUR, r2);

    // no template -> fallback, capped at maxShiftDurationHours
    const r3 = resolveAutoCloseEndAt({ openedAt, maxShiftDurationHours: 6, fallbackHours: 8, templateEndTime: null });
    check('no template, fallback > cap -> capped at maxShiftDurationHours', r3.source === 'FALLBACK' && r3.endAt.getTime() === openedAt.getTime() + 6 * HOUR, r3);

    // template end beyond the cap -> fallback
    const r4 = resolveAutoCloseEndAt({ openedAt, maxShiftDurationHours: 2, fallbackHours: 8, templateEndTime });
    check('template end beyond cap -> FALLBACK capped', r4.source === 'FALLBACK' && r4.endAt.getTime() === openedAt.getTime() + 2 * HOUR, r4);
  }

  const now = new Date('2033-06-16T09:00:00Z');

  // ---- 1. template-driven auto-close, end to end ----
  {
    const f = await makeOpenShift({ openedAt: new Date('2033-06-15T11:00:00Z'), withTemplate: true, templateEndHour: 17 });
    const res = await runAbandonedShiftAutoCloseTick({ now });
    check('1: pass closed at least this one', res.closed >= 1 && res.closedFromTemplate >= 1, res);

    const openShift = await prisma.employeeOpenShift.findUnique({ where: { employeeId: f.emp.id } });
    check('1: EmployeeOpenShift deleted', openShift === null);

    const shift = await prisma.clockShift.findUniqueOrThrow({ where: { checkInEventId: f.checkInId } });
    check('1: ClockShift force-closed by SYSTEM, provisional', shift.checkOutEventId === null && shift.forceClosedByUserId !== null && shift.endAtProvisional === true, shift);
    check('1: recordedEndAt = template planned end (14:00Z)', shift.recordedEndAt.toISOString() === '2033-06-15T14:00:00.000Z', shift.recordedEndAt.toISOString());
    check('1: materialized', shift.materializationState === 'MATERIALIZED', shift.materializationState);

    const seg = await prisma.timesheetDraftSegment.findFirst({ where: { originClockShiftFragment: { clockShiftId: shift.id } } });
    check('1: draft segment projected (3h worked)', !!seg && seg!.endAt.getTime() - seg!.startAt.getTime() === 3 * HOUR, seg);

    const exc = await prisma.attendanceException.findFirstOrThrow({ where: { type: 'SHIFT_AUTO_CLOSED_MAX_DURATION', clockEventId: f.checkInId } });
    check('1: exception OPEN, endSource TEMPLATE', exc.status === 'OPEN' && (exc.detail as Record<string, unknown>).endSource === 'TEMPLATE', exc.detail);

    const audit = await prisma.auditEvent.findFirst({ where: { eventType: 'CLOCK_SHIFT_AUTO_CLOSED', entityId: shift.id } });
    check('1: CLOCK_SHIFT_AUTO_CLOSED audit written', !!audit);

    // idempotent — a second pass does nothing new
    const res2 = await runAbandonedShiftAutoCloseTick({ now });
    const stillOne = await prisma.clockShift.count({ where: { checkInEventId: f.checkInId } });
    check('1: second pass is a no-op for this shift', stillOne === 1, { res2 });
  }

  // ---- 2. no template -> FALLBACK end ----
  {
    const openedAt = new Date('2033-06-15T10:00:00Z');
    const f = await makeOpenShift({ openedAt, withTemplate: false });
    await runAbandonedShiftAutoCloseTick({ now });
    const shift = await prisma.clockShift.findUniqueOrThrow({ where: { checkInEventId: f.checkInId } });
    check('2: no-template end = openedAt + 8h', shift.recordedEndAt.getTime() === openedAt.getTime() + 8 * HOUR, shift.recordedEndAt.toISOString());
    const exc = await prisma.attendanceException.findFirstOrThrow({ where: { type: 'SHIFT_AUTO_CLOSED_MAX_DURATION', clockEventId: f.checkInId } });
    check('2: endSource FALLBACK', (exc.detail as Record<string, unknown>).endSource === 'FALLBACK', exc.detail);
  }

  // ---- 3. shift not yet old enough -> skipped ----
  {
    const f = await makeOpenShift({ openedAt: new Date(now.getTime() - 5 * HOUR), withTemplate: true });
    const res = await runAbandonedShiftAutoCloseTick({ now });
    const openShift = await prisma.employeeOpenShift.findUnique({ where: { employeeId: f.emp.id } });
    check('3: a 5h-old shift is left open', openShift !== null, res);
    const shift = await prisma.clockShift.findUnique({ where: { checkInEventId: f.checkInId } });
    check('3: no ClockShift created', shift === null);
  }

  // ---- 4. annotateAutoClosedShiftWithLateCheckOut stamps the real time ----
  {
    const openedAt = new Date('2033-06-15T11:00:00Z');
    const f = await makeOpenShift({ openedAt, withTemplate: true, templateEndHour: 17 });
    await runAbandonedShiftAutoCloseTick({ now });
    const realCheckOutAt = new Date('2033-06-16T05:30:00Z'); // came back next morning, after auto-close
    const fakeEventId = randomUUID();
    await prisma.$transaction((tx) => annotateAutoClosedShiftWithLateCheckOut(tx, f.emp.id, realCheckOutAt, fakeEventId));
    const exc = await prisma.attendanceException.findFirstOrThrow({ where: { type: 'SHIFT_AUTO_CLOSED_MAX_DURATION', clockEventId: f.checkInId } });
    const d = exc.detail as Record<string, unknown>;
    check('4: exception detail carries realCheckOutAt', d.realCheckOutAt === realCheckOutAt.toISOString() && d.realCheckOutClockEventId === fakeEventId, d);
    check('4: exception still OPEN (admin reconciles)', exc.status === 'OPEN');
  }

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
