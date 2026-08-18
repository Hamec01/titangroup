import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';

// T7A.10C.1 FOLLOW-UP — fixture seed for the PWA cache/offline-shell Playwright verification pass.
// Creates one ACTIVE worker with two current site assignments (for Switch Site regression) and an
// OPEN period, prints tokens/ids as JSON so a separate (ephemeral, not-committed) Playwright script
// can drive the browser against them. Mirrors scripts/_test-overview.ts's makeUser pattern.

async function makeUser(username: string, roleNames: string[], employeeId: string | null = null) {
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
  for (const roleName of roleNames) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: createHash('sha256').update(rawToken).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, rawToken };
}

function helsinkiToday(): Date {
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  return new Date(`${isoDate}T00:00:00.000Z`);
}

async function main() {
  const admin = await prisma.user.create({ data: { username: `pwa-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });

  const siteA = await prisma.workSite.create({ data: { name: `PWA Site A ${randomUUID().slice(0, 4)}` } });
  const siteB = await prisma.workSite.create({ data: { name: `PWA Site B ${randomUUID().slice(0, 4)}` } });
  const assignmentStart = new Date('2020-01-01T00:00:00.000Z');

  const employee = await prisma.employee.create({ data: { employeeNumber: `TEST-PWA-${randomUUID().slice(0, 8)}`, firstName: 'Pwa', lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: assignmentStart } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: siteA.id, isPrimary: true, validFrom: assignmentStart, validTo: null, assignedByUserId: admin.id } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: siteB.id, isPrimary: false, validFrom: assignmentStart, validTo: null, assignedByUserId: admin.id } });

  const today = helsinkiToday();
  const period = await prisma.payrollPeriod.create({ data: { startDate: today, endDate: new Date(today.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: admin.id } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: employee.id, expected: true } });

  const { rawToken: workerToken } = await makeUser('pwaworker', ['WORKER'], employee.id);

  console.log(JSON.stringify({ workerToken, employeeId: employee.id, siteAId: siteA.id, siteBId: siteB.id, periodId: period.id }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
