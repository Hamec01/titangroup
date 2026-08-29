// T15.3 (2026-08-29) — Worker Notification Center: the timesheet-deadline notice is generated on
// GET, escalates INFO -> WARNING when overdue (clearing dismissals), is dismissible per account,
// and resolves once the timesheet is submitted.
// Direct-route-handler style. Needs a disposable PostgreSQL 16 (DATABASE_URL) with migrations
// through 20260829200000 applied and a CompanyAttendancePolicy singleton row.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { GET as listRoute } from '../app/api/worker/notifications/route';
import { POST as dismissRoute } from '../app/api/worker/notifications/[notificationId]/dismiss/route';
import { syncWorkerDeadlineNotifications } from '../lib/worker-notifications';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

async function makeWorker(username: string) {
  const employee = await prisma.employee.create({ data: { employeeNumber: `WN-${randomUUID().slice(0, 8)}`, firstName: 'Notif', lastName: 'Worker' } });
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } });
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId: employee.id, userRoles: { create: { roleId: role.id } } } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { user, employeeId: employee.id, token };
}

function listReq(token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new NextRequest('http://localhost/api/worker/notifications', { method: 'GET', headers });
}
function dismissReq(token: string | null, csrf = true) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  if (csrf) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest('http://localhost/api/worker/notifications/x/dismiss', { method: 'POST', headers });
}
const dParams = (id: string) => ({ params: Promise.resolve({ notificationId: id }) });

// A period whose edit cutoff is `daysFromNow` days away (cutoff = helsinki (endDate + policy grace) 23:59).
function periodEndForDeadline(daysFromNow: number, cutoffGraceDays: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Math.round(daysFromNow) - cutoffGraceDays);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function makeOpenDraftTimesheet(employeeId: string, adminId: string, endDate: Date) {
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 6);
  const period = await prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  return { period, ts };
}

async function main() {
  const policy = await prisma.companyAttendancePolicy.findFirstOrThrow({ select: { cutoffDaysAfterPeriodEnd: true } });
  const grace = policy.cutoffDaysAfterPeriodEnd;
  const admin = await prisma.user.create({ data: { username: `wn-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });

  // 1. no timesheet at all -> no notification
  const w0 = await makeWorker('wn-none');
  check('1: no draft timesheet -> GET returns []', (await (await listRoute(listReq(w0.token))).json()).items.length === 0);

  // 2. deadline far away (10 days) -> no notification yet
  const wFar = await makeWorker('wn-far');
  await makeOpenDraftTimesheet(wFar.employeeId, admin.id, periodEndForDeadline(10, grace));
  check('2: deadline 10 days away -> GET returns []', (await (await listRoute(listReq(wFar.token))).json()).items.length === 0);

  // 3. deadline in 2 days -> one INFO notice
  const wSoon = await makeWorker('wn-soon');
  const soon = await makeOpenDraftTimesheet(wSoon.employeeId, admin.id, periodEndForDeadline(2, grace));
  const r3 = await listRoute(listReq(wSoon.token));
  const j3 = await r3.json();
  check('3: deadline in 2 days -> one notice, INFO, deadlineAt set', j3.items.length === 1 && j3.items[0].severity === 'INFO' && !!j3.items[0].deadlineAt && j3.items[0].type === 'TIMESHEET_DEADLINE_APPROACHING', j3.items);
  const noticeId = j3.items[0].id;

  // 3b. idempotent — a second GET does not create a duplicate
  await listRoute(listReq(wSoon.token));
  check('3b: still exactly one active row for the period', (await prisma.workerNotification.count({ where: { employeeId: wSoon.employeeId, resolvedAt: null } })) === 1);

  // 4. dismiss -> gone for this user
  const rD = await dismissRoute(dismissReq(wSoon.token), dParams(noticeId));
  check('4: dismiss -> 200', rD.status === 200);
  check('4b: GET now returns [] for this user', (await (await listRoute(listReq(wSoon.token))).json()).items.length === 0);
  check('4c: the row is still active (dismissal is per-user, not a resolve)', (await prisma.workerNotification.count({ where: { id: noticeId, resolvedAt: null } })) === 1);

  // 5. escalation: push the deadline into the past -> WARNING + dismissal cleared -> re-surfaces
  await prisma.payrollPeriod.update({ where: { id: soon.period.id }, data: { endDate: periodEndForDeadline(-2, grace) } });
  await syncWorkerDeadlineNotifications(wSoon.employeeId);
  const j5 = await (await listRoute(listReq(wSoon.token))).json();
  check('5: overdue notice re-surfaces as WARNING even though it was dismissed', j5.items.length === 1 && j5.items[0].severity === 'WARNING' && j5.items[0].id === noticeId, j5.items);

  // 6. submit the timesheet -> notice resolved
  await prisma.timesheet.update({ where: { id: soon.ts.id }, data: { status: 'SUBMITTED' } });
  await syncWorkerDeadlineNotifications(wSoon.employeeId);
  check('6: after submit -> GET []', (await (await listRoute(listReq(wSoon.token))).json()).items.length === 0);
  check('6b: the row is resolved', (await prisma.workerNotification.findUniqueOrThrow({ where: { id: noticeId } })).resolvedAt !== null);

  // 7. one worker's dismissal never touches another worker's own notice
  const wA = await makeWorker('wn-a');
  await makeOpenDraftTimesheet(wA.employeeId, admin.id, periodEndForDeadline(1, grace));
  const wB = await makeWorker('wn-b');
  await makeOpenDraftTimesheet(wB.employeeId, admin.id, periodEndForDeadline(1, grace));
  const aNoticeId = (await (await listRoute(listReq(wA.token))).json()).items[0].id;
  await dismissRoute(dismissReq(wA.token), dParams(aNoticeId));
  check('7: A dismissed -> A sees []', (await (await listRoute(listReq(wA.token))).json()).items.length === 0);
  check('7b: B still sees B\'s own notice', (await (await listRoute(listReq(wB.token))).json()).items.length === 1);

  // 8. cross-employee dismiss -> 404, plus auth/CSRF gates
  check('8: B dismissing A\'s notice -> 404', (await dismissRoute(dismissReq(wB.token), dParams(aNoticeId))).status === 404);
  check('8b: no session -> 401', (await listRoute(listReq(null))).status === 401);
  check('8c: dismiss without CSRF -> 403', (await dismissRoute(dismissReq(wB.token, false), dParams(aNoticeId))).status === 403);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
