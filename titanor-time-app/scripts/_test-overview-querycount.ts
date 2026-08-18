import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { buildOperationalOverview } from '../lib/attendance-overview';

// T7A.9A §11 ТЗ — proves the getForemanOverview N+1 fix and the admin overview's own query layer
// stay O(1) in SQL round trips as the worker count grows, not O(N). Seeds N workers directly (no
// HTTP layer — this is instrumentation, not an HTTP smoke test; see scripts/_test-overview.ts for
// the HTTP-level fixture/verification script) and counts Prisma `query` events around a single
// buildOperationalOverview() call inside the same REPEATABLE READ transaction the real routes use.

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
let queryCount = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('query', () => {
  queryCount++;
});

let periodSlot = 0;

async function seed(n: number) {
  const admin = await prisma.user.create({ data: { username: `qc-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const site = await prisma.workSite.create({ data: { name: `QC Site ${randomUUID().slice(0, 4)}` } });
  const assignmentStart = new Date('2020-01-01T00:00:00.000Z');
  // "today" for clock-state purposes is the real Helsinki today (buildOperationalOverview only
  // uses this for the FINISHED_TODAY window); the PERIOD's own date range just needs to not
  // overlap any other period (EX-03) — each call gets its own non-overlapping historical slot.
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date()) + 'T00:00:00.000Z');
  const periodStart = new Date(Date.UTC(2000, 0, 1) + periodSlot * 30 * 86400000);
  const periodEnd = new Date(periodStart.getTime() + 6 * 86400000);
  periodSlot += 1;
  const period = await prisma.payrollPeriod.create({ data: { startDate: periodStart, endDate: periodEnd, status: 'OPEN', openedByUserId: admin.id } });

  for (let i = 0; i < n; i++) {
    const emp = await prisma.employee.create({ data: { employeeNumber: `TEST-QC-${randomUUID().slice(0, 8)}`, firstName: `QC${i}`, lastName: 'Worker' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: assignmentStart } });
    await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: assignmentStart, validTo: null, assignedByUserId: admin.id } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });

    // Every third worker gets an open shift, every third a submitted timesheet with a review
    // scope (the exact shape that used to drive the N+1 loop), every third an open exception.
    if (i % 3 === 0) {
      const evtId = randomUUID();
      await prisma.clockEvent.create({
        data: { id: evtId, employeeId: emp.id, operationType: 'CHECK_IN', siteId: site.id, clientCapturedAt: new Date(), capturedOffline: false, serverReceivedAt: new Date(), effectiveAt: new Date(), gpsVerification: 'NOT_VERIFIED', processingState: 'ACCEPTED', channel: 'ONLINE', payloadHash: createHash('sha256').update(evtId).digest('hex'), requestId: randomUUID() }
      });
      await prisma.employeeOpenShift.create({ data: { employeeId: emp.id, openedByClockEventId: evtId, siteId: site.id, openedAt: new Date() } });
    } else if (i % 3 === 1) {
      const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'SUBMITTED' } });
      const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' } });
      await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
      await prisma.timesheetReviewScope.create({ data: { timesheetVersionId: version.id, scopeType: 'SITE', siteId: site.id, status: 'PENDING', contentHash: randomUUID() } });
    } else {
      await prisma.attendanceException.create({ data: { type: 'GPS_NOT_VERIFIED', employeeId: emp.id, payrollPeriodId: period.id, occurredAt: new Date(), status: 'OPEN' } });
    }
  }

  return { period: { id: period.id, startDate: periodStart.toISOString().slice(0, 10), endDate: periodEnd.toISOString().slice(0, 10), status: 'OPEN' }, today };
}

async function run(n: number) {
  const { period, today } = await seed(n);
  queryCount = 0;
  await prisma.$transaction(
    async (tx) => {
      await buildOperationalOverview(tx, { page: 1, pageSize: 100 }, { siteIds: null, excludeEmployeeId: null, includeConflicts: true }, period, today);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  console.log(`n=${n} workers -> ${queryCount} SQL statements (buildOperationalOverview + tx overhead)`);
  return queryCount;
}

async function main() {
  const counts: number[] = [];
  for (const n of [1, 50, 200]) {
    counts.push(await run(n));
  }
  const [c1, c50, c200] = counts;
  console.log(JSON.stringify({ c1, c50, c200 }));
  // n=1 is not a fair baseline against n=50/200: with only 1 employee, only one of the three
  // fixture branches (i%3) fires, so several bulk queries short-circuit to `Promise.resolve([])`
  // on an empty id list and never execute. The real O(1)-vs-O(N) proof is n=50 vs n=200, where all
  // three branches are represented in both and only IN-list *sizes* differ, not query *count*.
  if (c200 !== c50) {
    console.error(`FAIL: query count grew from n=50 (${c50}) to n=200 (${c200}) — expected exactly equal (bounded, not O(N)).`);
    process.exit(1);
  }
  console.log(`PASS: query count bounded at ${c50} statements for both n=50 and n=200 (n=1 baseline: ${c1}, fewer branches populated).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
