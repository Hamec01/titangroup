// Direct lib-level test (no HTTP server needed) for the Admin Notification Center generation
// service — task spec §37E. Talks straight to Prisma against whatever DATABASE_URL points at
// (run against a disposable throwaway Postgres, same convention as every other _test-*.ts here).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { ensureQualificationNotifications, listActiveNotificationsForAdmin, dismissAdminNotification } from '../lib/qualification-notifications';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

function daysFromNow(n: number): Date {
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() + n);
  return utcMidnight;
}

async function makeEmployee(numberSuffix: string): Promise<string> {
  const employee = await prisma.employee.create({
    data: { employeeNumber: `QNTEST-${numberSuffix}-${randomUUID().slice(0, 6)}`, firstName: 'Test', lastName: `Worker${numberSuffix}` }
  });
  return employee.id;
}

async function makeAdmin(usernameSuffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({
    data: {
      username: `qntest_admin_${usernameSuffix}_${randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      locale: 'EN',
      userRoles: { create: { roleId: role.id } }
    }
  });
  return user.id;
}

async function main(): Promise<void> {
  const adminA = await makeAdmin('a');
  const adminB = await makeAdmin('b');

  // --- 60/14/expiry thresholds fire once each, no daily duplicates ---
  const employeeSoon = await makeEmployee('soon');
  const qualSoon = await prisma.employeeQualification.create({
    data: { employeeId: employeeSoon, name: 'Custom Soon Card', expiresOn: daysFromNow(45) }
  });
  await ensureQualificationNotifications();
  await ensureQualificationNotifications();
  await ensureQualificationNotifications();
  const soonNotifications = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualSoon.id, resolvedAt: null } });
  check('60-day threshold fires exactly once across repeated ticks', soonNotifications.length === 1 && soonNotifications[0].type === 'QUALIFICATION_EXPIRING_SOON' && soonNotifications[0].threshold === 60, soonNotifications);

  const employeeCritical = await makeEmployee('critical');
  const qualCritical = await prisma.employeeQualification.create({
    data: { employeeId: employeeCritical, name: 'Custom Critical Card', expiresOn: daysFromNow(10) }
  });
  await ensureQualificationNotifications();
  const criticalNotifications = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualCritical.id, resolvedAt: null } });
  check('14-day threshold fires exactly once', criticalNotifications.length === 1 && criticalNotifications[0].type === 'QUALIFICATION_CRITICAL' && criticalNotifications[0].threshold === 14, criticalNotifications);

  const employeeExpired = await makeEmployee('expired');
  const qualExpired = await prisma.employeeQualification.create({
    data: { employeeId: employeeExpired, name: 'Custom Expired Card', expiresOn: daysFromNow(-3) }
  });
  await ensureQualificationNotifications();
  const expiredNotifications = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualExpired.id, resolvedAt: null } });
  check('expiry threshold fires exactly once', expiredNotifications.length === 1 && expiredNotifications[0].type === 'QUALIFICATION_EXPIRED' && expiredNotifications[0].threshold === 0, expiredNotifications);

  // --- Expiry extension resolves old urgency, and a later re-breach starts a fresh cycle ---
  const employeeExtend = await makeEmployee('extend');
  const qualExtend = await prisma.employeeQualification.create({
    data: { employeeId: employeeExtend, name: 'Custom Extend Card', expiresOn: daysFromNow(5) }
  });
  await ensureQualificationNotifications();
  const beforeExtend = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualExtend.id, resolvedAt: null } });
  check('extend fixture: critical notification created before extension', beforeExtend.length === 1 && beforeExtend[0].type === 'QUALIFICATION_CRITICAL');

  await prisma.employeeQualification.update({ where: { id: qualExtend.id }, data: { expiresOn: daysFromNow(400) } });
  await ensureQualificationNotifications();
  const afterExtend = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualExtend.id, resolvedAt: null } });
  const resolvedAfterExtend = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualExtend.id, resolvedAt: { not: null } } });
  check('extension past all thresholds resolves the active notification', afterExtend.length === 0, afterExtend);
  check('resolved notification kept for history (resolvedAt set, not deleted)', resolvedAfterExtend.length === 1, resolvedAfterExtend);

  await prisma.employeeQualification.update({ where: { id: qualExtend.id }, data: { expiresOn: daysFromNow(30) } });
  await ensureQualificationNotifications();
  const newCycle = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualExtend.id, resolvedAt: null } });
  check('re-breaching a threshold after resolution starts a fresh cycle', newCycle.length === 1 && newCycle[0].type === 'QUALIFICATION_EXPIRING_SOON', newCycle);

  // --- MISSING_EXPIRY: dedup on (employeeQualificationId, type, threshold=null) ---
  const catalogRequired = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'OCCUPATIONAL_SAFETY_CARD' } });
  const employeeMissing = await makeEmployee('missing');
  const qualMissing = await prisma.employeeQualification.create({
    data: { employeeId: employeeMissing, definitionId: catalogRequired.id, name: catalogRequired.nameEn, expiresOn: null }
  });
  await ensureQualificationNotifications();
  await ensureQualificationNotifications();
  const missingNotifications = await prisma.adminNotification.findMany({ where: { employeeQualificationId: qualMissing.id, resolvedAt: null } });
  check('MISSING_EXPIRY dedups correctly (threshold=null)', missingNotifications.length === 1 && missingNotifications[0].type === 'QUALIFICATION_MISSING_EXPIRY', missingNotifications);

  // --- Two admins see the same active notification; dismiss is per-admin ---
  const listA1 = await listActiveNotificationsForAdmin(adminA);
  const listB1 = await listActiveNotificationsForAdmin(adminB);
  const criticalIdA = listA1.find((n) => n.employeeId === employeeCritical)?.id;
  const criticalIdB = listB1.find((n) => n.employeeId === employeeCritical)?.id;
  check('two admins both see the same active notification', Boolean(criticalIdA) && criticalIdA === criticalIdB, { criticalIdA, criticalIdB });

  if (criticalIdA) {
    const dismissResult = await dismissAdminNotification(criticalIdA, adminA);
    check('dismiss by admin A succeeds', dismissResult.ok);

    const listA2 = await listActiveNotificationsForAdmin(adminA);
    const listB2 = await listActiveNotificationsForAdmin(adminB);
    check('dismiss by A removes it from A\'s list', !listA2.some((n) => n.id === criticalIdA));
    check('dismiss by A does NOT remove it from B\'s list', listB2.some((n) => n.id === criticalIdA));

    // Dismiss cannot target another user's state: dismissing again as B creates B's OWN
    // dismissal row, never mutates A's — verified via the underlying table directly.
    await dismissAdminNotification(criticalIdA, adminB);
    const dismissalRows = await prisma.adminNotificationDismissal.findMany({ where: { notificationId: criticalIdA } });
    const dismissedUserIds = dismissalRows.map((r) => r.userId).sort();
    check('dismiss cannot target another user\'s state — each admin has their own row', dismissedUserIds.length === 2 && dismissedUserIds.includes(adminA) && dismissedUserIds.includes(adminB), dismissalRows);
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
