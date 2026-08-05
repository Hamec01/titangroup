import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';

async function makeUser(username: string, roleNames: string[]) {
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  for (const roleName of roleNames) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(rawToken).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, rawToken };
}

async function main() {
  const { user: admin1, rawToken: admin1Token } = await makeUser('admin1', ['ADMIN']);
  const { user: admin2, rawToken: admin2Token } = await makeUser('admin2', ['ADMIN']);
  const { user: superadmin, rawToken: superadminToken } = await makeUser('superadmin', ['SUPER_ADMIN']);

  const site = await prisma.workSite.create({ data: { name: `Corr Site ${randomUUID().slice(0, 4)}` } });
  const assignmentStart = new Date('2020-01-01T00:00:00.000Z');

  async function makeFinalApprovedTimesheet(tag: string) {
    const emp = await prisma.employee.create({ data: { employeeNumber: `TEST-CORR-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: assignmentStart } });
    const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: assignmentStart, validTo: null, assignedByUserId: admin1.id } });

    const dayBase = new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 3000) * 86400000 * 20);
    const period = await prisma.payrollPeriod.create({ data: { startDate: dayBase, endDate: new Date(dayBase.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: admin1.id } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
    const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin1.id } });
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
    const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: version.id, date: dayBase, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: version.id, employeeId: emp.id, date: dayBase, siteId: site.id, sourceAssignmentId: asg.id, plannedBreakMinutes: 0 } });
    await prisma.workSegment.create({
      data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId: emp.id, date: dayBase, startAt: new Date(dayBase.getTime() + 8 * 3600000), endAt: new Date(dayBase.getTime() + 16 * 3600000), siteId: site.id, sourceAssignmentId: asg.id, crossesMidnight: false }
    });

    return { timesheetId: ts.id, date: dayBase.toISOString().slice(0, 10) };
  }

  const ts1 = await makeFinalApprovedTimesheet('A');
  const ts2 = await makeFinalApprovedTimesheet('B');

  console.log(
    JSON.stringify(
      { admin1Token, admin2Token, superadminToken, ts1Id: ts1.timesheetId, ts1Date: ts1.date, ts2Id: ts2.timesheetId, ts2Date: ts2.date },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
