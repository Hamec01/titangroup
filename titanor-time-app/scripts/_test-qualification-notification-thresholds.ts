// Worker Dossier feature (2026-08-26, task spec §23-26/§52) — the new 60/14/7/expired
// four-checkpoint threshold chain: exact day boundaries (7/8/14/15/60/61), and a single
// qualification walking through all four thresholds as its expiry approaches, each dismiss not
// blocking the next (more urgent) threshold from firing.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { helsinkiCalendarDateAsUtcMidnight } from '../lib/attendance-clock';
import { ensureQualificationNotifications, dismissAdminNotification, listActiveNotificationsForAdmin } from '../lib/qualification-notifications';

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

// Anchor to the SAME calendar basis the notification code uses — Europe/Helsinki calendar day at
// UTC midnight (lib/qualification-notifications.ts: `today = helsinkiCalendarDateAsUtcMidnight(...)`,
// diff via diffCalendarDays). Using a plain UTC "today" here made the boundary matrix off by one
// whenever the runner started between 21:00–24:00 UTC (Helsinki already on the next date).
function daysFromNow(n: number): Date {
  const today = helsinkiCalendarDateAsUtcMidnight(new Date());
  today.setUTCDate(today.getUTCDate() + n);
  return today;
}

async function makeEmployee(suffix: string): Promise<string> {
  const employee = await prisma.employee.create({ data: { employeeNumber: `QTTEST-${suffix}-${randomUUID().slice(0, 6)}`, firstName: 'Threshold', lastName: `Test${suffix}` } });
  return employee.id;
}

async function makeAdmin(suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({ data: { username: `qttest_admin_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function activeFor(qualId: string) {
  return prisma.adminNotification.findMany({ where: { employeeQualificationId: qualId, resolvedAt: null } });
}

async function main(): Promise<void> {
  const admin = await makeAdmin('a');

  // --- Exact boundary matrix: days -> expected {type, threshold} ---
  const boundaries: { days: number; type: string; threshold: number }[] = [
    { days: 61, type: 'NONE', threshold: -1 }, // handled separately below (no notification)
    { days: 60, type: 'QUALIFICATION_EXPIRING_SOON', threshold: 60 },
    { days: 15, type: 'QUALIFICATION_EXPIRING_SOON', threshold: 60 },
    { days: 14, type: 'QUALIFICATION_CRITICAL', threshold: 14 },
    { days: 8, type: 'QUALIFICATION_CRITICAL', threshold: 14 },
    { days: 7, type: 'QUALIFICATION_CRITICAL', threshold: 7 },
    { days: 1, type: 'QUALIFICATION_CRITICAL', threshold: 7 },
    { days: 0, type: 'QUALIFICATION_CRITICAL', threshold: 7 },
    { days: -1, type: 'QUALIFICATION_EXPIRED', threshold: 0 }
  ];

  for (const b of boundaries) {
    const employeeId = await makeEmployee(`b${b.days}`);
    const qual = await prisma.employeeQualification.create({ data: { employeeId, name: `Boundary ${b.days}`, expiresOn: daysFromNow(b.days) } });
    await ensureQualificationNotifications();
    const active = await activeFor(qual.id);
    if (b.type === 'NONE') {
      check(`days=${b.days}: no active notification (still VALID)`, active.length === 0, active);
    } else {
      check(`days=${b.days}: exactly one active notification`, active.length === 1, active);
      check(`days=${b.days}: type=${b.type}`, active[0]?.type === b.type, active[0]?.type);
      check(`days=${b.days}: threshold=${b.threshold}`, active[0]?.threshold === b.threshold, active[0]?.threshold);
    }
  }

  // --- Full walk: one qualification crossing 60 -> 14 -> 7 -> expired, dismiss never blocks the next tier ---
  const walkEmployee = await makeEmployee('walk');
  const walkQual = await prisma.employeeQualification.create({ data: { employeeId: walkEmployee, name: 'Walking Card', expiresOn: daysFromNow(45) } });

  await ensureQualificationNotifications();
  let active = await activeFor(walkQual.id);
  check('walk: starts at 60-day tier', active.length === 1 && active[0].type === 'QUALIFICATION_EXPIRING_SOON' && active[0].threshold === 60, active);
  const list60 = await listActiveNotificationsForAdmin(admin);
  const id60 = list60.find((n) => n.employeeId === walkEmployee)?.id;
  check('walk: 60-day notification visible to admin', Boolean(id60));
  if (id60) {
    const dismissResult = await dismissAdminNotification(id60, admin);
    check('walk: dismiss 60-day succeeds', dismissResult.ok);
  }

  await prisma.employeeQualification.update({ where: { id: walkQual.id }, data: { expiresOn: daysFromNow(10) } });
  await ensureQualificationNotifications();
  active = await activeFor(walkQual.id);
  check('walk: 14-day tier appears after dismissing 60-day (dismiss did not block it)', active.length === 1 && active[0].type === 'QUALIFICATION_CRITICAL' && active[0].threshold === 14, active);
  const list14 = await listActiveNotificationsForAdmin(admin);
  const id14 = list14.find((n) => n.employeeId === walkEmployee)?.id;
  check('walk: 14-day notification visible to admin (fresh, not the dismissed 60-day one)', Boolean(id14) && id14 !== id60);
  if (id14) await dismissAdminNotification(id14, admin);

  await prisma.employeeQualification.update({ where: { id: walkQual.id }, data: { expiresOn: daysFromNow(5) } });
  await ensureQualificationNotifications();
  active = await activeFor(walkQual.id);
  check('walk: 7-day tier appears after dismissing 14-day', active.length === 1 && active[0].type === 'QUALIFICATION_CRITICAL' && active[0].threshold === 7, active);
  const list7 = await listActiveNotificationsForAdmin(admin);
  const id7 = list7.find((n) => n.employeeId === walkEmployee)?.id;
  check('walk: 7-day notification visible to admin', Boolean(id7));
  if (id7) await dismissAdminNotification(id7, admin);

  await prisma.employeeQualification.update({ where: { id: walkQual.id }, data: { expiresOn: daysFromNow(-2) } });
  await ensureQualificationNotifications();
  active = await activeFor(walkQual.id);
  check('walk: expired tier appears after dismissing 7-day', active.length === 1 && active[0].type === 'QUALIFICATION_EXPIRED' && active[0].threshold === 0, active);

  // Resolved history: all four earlier tiers should be resolved (not deleted).
  const resolvedHistory = await prisma.adminNotification.findMany({ where: { employeeQualificationId: walkQual.id, resolvedAt: { not: null } } });
  check('walk: three earlier tiers resolved (60/14/7), kept for history', resolvedHistory.length === 3, resolvedHistory.length);

  // --- Repeated ensure() calls never duplicate the current tier ---
  await ensureQualificationNotifications();
  await ensureQualificationNotifications();
  const activeFinal = await activeFor(walkQual.id);
  check('repeated ensure() does not duplicate the active (expired) notification', activeFinal.length === 1, activeFinal);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
