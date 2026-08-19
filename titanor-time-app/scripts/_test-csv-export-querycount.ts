import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" — F.55/F.56/F.57. Proves createExportBatch
// (lib/csv-export.ts) issues a bounded, non-growing number of SQL statements as the expected-
// participant count grows (1/50/200 workers), that ExportItem insertion is one bulk createMany (not
// a per-worker/per-row loop), and captures EXPLAIN ANALYZE for the two set-based reads whose plans
// matter most at scale (Timesheet lock/read, WorkSegment bulk read). Same technique as the existing
// scripts/_test-overview-querycount.ts: a dedicated PrismaClient with event-based query logging,
// installed on `globalThis` BEFORE importing lib/csv-export.ts so lib/prisma.ts's own
// `globalForPrisma.prisma ?? new PrismaClient()` picks up this already-instrumented instance instead
// of constructing its own uninstrumented one — no source change to lib/csv-export.ts needed to make
// it accept an injected client.

const instrumented = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
(globalThis as unknown as { prisma: PrismaClient }).prisma = instrumented;
let queryCount = 0;
const queries: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(instrumented as any).$on('query', (e: { query: string }) => {
  queryCount++;
  queries.push(e.query);
});

let periodSlot = 1000 + Math.floor(Math.random() * 20000);

async function seed(n: number) {
  const admin = await instrumented.user.create({ data: { username: `qc-csv-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const site = await instrumented.workSite.create({ data: { name: `QC CSV Site ${randomUUID().slice(0, 4)}` } });
  const start = new Date(Date.UTC(2000, 0, 1) + periodSlot * 20 * 86400000);
  periodSlot += 1;
  const end = new Date(start.getTime() + 6 * 86400000);
  const period = await instrumented.payrollPeriod.create({ data: { startDate: start, endDate: end, status: 'OPEN', openedByUserId: admin.id } });
  await instrumented.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: admin.id } });

  const employeeIds = Array.from({ length: n }, () => randomUUID());
  const assignmentIds = Array.from({ length: n }, () => randomUUID());
  const timesheetIds = Array.from({ length: n }, () => randomUUID());
  const versionIds = Array.from({ length: n }, () => randomUUID());
  const dayIds = Array.from({ length: n }, () => randomUUID());
  const planIds = Array.from({ length: n }, () => randomUUID());

  await instrumented.employee.createMany({ data: employeeIds.map((id, i) => ({ id, employeeNumber: `QC-CSV-${randomUUID().slice(0, 10)}`, firstName: `QC${i}`, lastName: 'Worker' })) });
  await instrumented.employment.createMany({ data: employeeIds.map((employeeId) => ({ employeeId, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') })) });
  await instrumented.siteAssignment.createMany({ data: employeeIds.map((employeeId, i) => ({ id: assignmentIds[i], employeeId, siteId: site.id, isPrimary: true, validFrom: start, validTo: end, assignedByUserId: admin.id })) });
  await instrumented.payrollPeriodParticipant.createMany({ data: employeeIds.map((employeeId) => ({ periodId: period.id, employeeId, expected: true })) });
  await instrumented.timesheet.createMany({ data: employeeIds.map((employeeId, i) => ({ id: timesheetIds[i], employeeId, periodId: period.id, status: 'FINAL_APPROVED' })) });
  await instrumented.timesheetVersion.createMany({ data: employeeIds.map((employeeId, i) => ({ id: versionIds[i], timesheetId: timesheetIds[i], employeeId, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' })) });
  await Promise.all(employeeIds.map((_, i) => instrumented.timesheet.update({ where: { id: timesheetIds[i] }, data: { currentVersionId: versionIds[i] } })));
  await instrumented.timesheetDay.createMany({ data: employeeIds.map((_, i) => ({ id: dayIds[i], timesheetVersionId: versionIds[i], date: start, dayType: 'WORK', confirmedZero: false })) });
  await instrumented.timesheetPlannedShift.createMany({ data: employeeIds.map((employeeId, i) => ({ id: planIds[i], timesheetVersionId: versionIds[i], employeeId, date: start, siteId: site.id, sourceAssignmentId: assignmentIds[i], plannedBreakMinutes: 0 })) });
  await instrumented.workSegment.createMany({
    data: employeeIds.map((employeeId, i) => ({
      timesheetDayId: dayIds[i],
      timesheetVersionId: versionIds[i],
      employeeId,
      date: start,
      startAt: new Date(start.getTime() + 8 * 3600000),
      endAt: new Date(start.getTime() + 16 * 3600000),
      siteId: site.id,
      sourceAssignmentId: assignmentIds[i],
      crossesMidnight: false
    }))
  });

  return { periodId: period.id, adminId: admin.id };
}

async function explainAnalyze(periodId: string, versionIds: string[]) {
  const rows = await instrumented.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
    `EXPLAIN ANALYZE SELECT * FROM "WorkSegment" WHERE "timesheetVersionId" = ANY($1::uuid[])`,
    versionIds
  );
  console.log('\nEXPLAIN ANALYZE — WorkSegment bulk read (200-worker fixture):');
  for (const r of rows) console.log(' ', r['QUERY PLAN']);

  const rows2 = await instrumented.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
    `EXPLAIN ANALYZE SELECT id FROM "Timesheet" WHERE "periodId" = $1::uuid AND "employeeId" = ANY(SELECT "employeeId" FROM "PayrollPeriodParticipant" WHERE "periodId" = $1::uuid AND expected = true) ORDER BY id FOR UPDATE`,
    periodId
  );
  console.log('\nEXPLAIN ANALYZE — Timesheet lock query (200-worker fixture):');
  for (const r of rows2) console.log(' ', r['QUERY PLAN']);
}

async function main() {
  // Deferred until here (not a top-level await, which esbuild/tsx's CJS output doesn't support) —
  // still happens strictly after the globalThis.prisma override above, so lib/prisma.ts's module
  // load still picks up the instrumented client.
  const { createExportBatch } = await import('../lib/csv-export');

  const counts: number[] = [];
  let lastPeriodId = '';
  let lastVersionIds: string[] = [];
  for (const n of [1, 50, 200]) {
    const { periodId, adminId } = await seed(n);
    queryCount = 0;
    queries.length = 0;
    const result = await createExportBatch(periodId, adminId, randomUUID());
    if ('code' in result) {
      throw new Error(`createExportBatch failed at n=${n}: ${JSON.stringify(result)}`);
    }
    console.log(`n=${n} workers -> ${queryCount} SQL statements, rowCount=${result.batch.rowCount}`);
    const exportItemInserts = queries.filter((q) => q.includes('ExportItem'));
    console.log(`n=${n} -> ${exportItemInserts.length} statement(s) touching ExportItem (must be 1, not ${n})`);
    if (exportItemInserts.length !== 1) {
      console.log('All queries:', JSON.stringify(queries, null, 2));
      throw new Error(`Expected exactly 1 ExportItem insert statement at n=${n}, got ${exportItemInserts.length}`);
    }
    counts.push(queryCount);
    if (n === 200) {
      lastPeriodId = periodId;
      const versions = await instrumented.timesheetVersion.findMany({ where: { timesheet: { periodId } }, select: { id: true } });
      lastVersionIds = versions.map((v) => v.id);
    }
  }

  const [c1, c50, c200] = counts;
  console.log(JSON.stringify({ c1, c50, c200 }));
  // n=1 is not a fair baseline (some conditional branches only engage once there's more than a
  // trivial amount of data) — the real bounded-ness claim is c50 === c200: query count must not
  // grow between 50 and 200 expected participants.
  if (c50 !== c200) {
    throw new Error(`Query count is NOT bounded: n=50 -> ${c50}, n=200 -> ${c200} (expected equal)`);
  }
  console.log(`\nBounded query count confirmed: n=50 and n=200 both issue ${c50} SQL statements.`);

  await explainAnalyze(lastPeriodId, lastVersionIds);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => instrumented.$disconnect());
