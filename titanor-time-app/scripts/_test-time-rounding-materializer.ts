import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { ensureEmployeePeriodCore } from '../lib/periods';
import { materializeClockShift } from '../lib/attendance-materializer';

let pass = 0;
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`FAIL: ${label}`); pass += 1; }

async function event(employeeId: string, siteId: string, assignmentId: string, operationType: 'CHECK_IN' | 'CHECK_OUT', effectiveAt: Date) {
  return prisma.clockEvent.create({ data: {
    id: randomUUID(), employeeId, operationType, siteId, sourceAssignmentId: assignmentId,
    clientCapturedAt: effectiveAt, capturedOffline: false, effectiveAt, gpsVerification: 'NOT_VERIFIED',
    gpsUnavailableReason: 'POSITION_UNAVAILABLE', processingState: 'NEEDS_REVIEW', channel: 'ONLINE',
    payloadHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), requestId: randomUUID()
  } });
}

async function main() {
  const actor = await prisma.user.create({ data: { username: `rounding-admin-${randomUUID()}`, status: 'ACTIVE', locale: 'EN' } });
  const employee = await prisma.employee.create({ data: { employeeNumber: `ROUND-${randomUUID()}`, firstName: 'Round', lastName: 'Worker' } });
  const site = await prisma.workSite.create({ data: { name: `Round Site ${randomUUID()}` } });
  const assignment = await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2026-08-01'), assignedByUserId: actor.id } });
  const period = await prisma.payrollPeriod.create({ data: { startDate: new Date('2026-08-17'), endDate: new Date('2026-08-23'), status: 'OPEN', openedByUserId: actor.id } });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employee.id}::uuid FOR UPDATE`;
    await ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId: employee.id, startDate: period.startDate, endDate: period.endDate });
  });
  const start = new Date('2026-08-21T04:52:00Z');
  const end = new Date('2026-08-21T13:18:00Z');
  const checkIn = await event(employee.id, site.id, assignment.id, 'CHECK_IN', start);
  const checkOut = await event(employee.id, site.id, assignment.id, 'CHECK_OUT', end);
  const shift = await prisma.clockShift.create({ data: { employeeId: employee.id, checkInEventId: checkIn.id, checkOutEventId: checkOut.id, siteId: site.id, sourceAssignmentId: assignment.id, recordedStartAt: start, recordedEndAt: end } });
  const result = await materializeClockShift(shift.id, randomUUID());
  check(result.kind === 'MATERIALIZED', `shift materializes (${JSON.stringify(result)})`);
  const segment = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { originClockShiftFragment: { clockShiftId: shift.id } } });
  check(segment.startAt.toISOString() === '2026-08-21T05:00:00.000Z', 'reported Check In rounds nearest 30');
  check(segment.endAt.toISOString() === '2026-08-21T13:30:00.000Z', 'reported Check Out rounds nearest 30');
  const storedShift = await prisma.clockShift.findUniqueOrThrow({ where: { id: shift.id } });
  check(storedShift.recordedStartAt.getTime() === start.getTime() && storedShift.recordedEndAt.getTime() === end.getTime(), 'raw ClockShift remains exact');
  const fragment = await prisma.clockShiftFragment.findFirstOrThrow({ where: { clockShiftId: shift.id } });
  check(fragment.recordedStartAt.getTime() === start.getTime() && fragment.recordedEndAt.getTime() === end.getTime(), 'raw fragment remains exact');

  const shortStart = new Date('2026-08-21T20:01:00Z');
  const shortEnd = new Date('2026-08-21T20:12:00Z');
  const shortIn = await event(employee.id, site.id, assignment.id, 'CHECK_IN', shortStart);
  const shortOut = await event(employee.id, site.id, assignment.id, 'CHECK_OUT', shortEnd);
  const shortShift = await prisma.clockShift.create({ data: { employeeId: employee.id, checkInEventId: shortIn.id, checkOutEventId: shortOut.id, siteId: site.id, sourceAssignmentId: assignment.id, recordedStartAt: shortStart, recordedEndAt: shortEnd } });
  check((await materializeClockShift(shortShift.id, randomUUID())).kind === 'MATERIALIZED', 'short shift materializes');
  const shortSegment = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { originClockShiftFragment: { clockShiftId: shortShift.id } } });
  check(shortSegment.startAt.getTime() === shortStart.getTime() && shortSegment.endAt.getTime() === shortEnd.getTime(), 'collapsed rounding uses exact positive fallback');
  console.log(`PASS: ${pass}/${pass} materializer rounding checks`);
}

main().finally(() => prisma.$disconnect());
