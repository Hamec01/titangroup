import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildOperationalOverview, parseOverviewQuery, type OverviewPeriod } from '../lib/attendance-overview';

const prisma = new PrismaClient();
let checks = 0;

function check(value: unknown, message: string): asserts value {
  checks += 1;
  if (!value) throw new Error(`FAIL ${checks}: ${message}`);
}

function helsinkiToday(): Date {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  return new Date(`${date}T00:00:00.000Z`);
}

async function clockEvent(employeeId: string, siteId: string, operationType: 'CHECK_IN' | 'CHECK_OUT', at: Date) {
  const id = randomUUID();
  await prisma.clockEvent.create({
    data: {
      id,
      employeeId,
      siteId,
      operationType,
      clientCapturedAt: at,
      capturedOffline: false,
      serverReceivedAt: at,
      effectiveAt: at,
      gpsVerification: 'NOT_VERIFIED',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: createHash('sha256').update(id).digest('hex'),
      requestId: randomUUID()
    }
  });
  return id;
}

async function employee(firstName: string, lastName: string, active = true) {
  const row = await prisma.employee.create({
    data: { employeeNumber: `TODAY-${randomUUID().slice(0, 8)}`, firstName, lastName }
  });
  await prisma.employment.create({
    data: active
      ? { employeeId: row.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') }
      : { employeeId: row.id, active: false, startDate: new Date('2020-01-01T00:00:00Z'), endDate: new Date('2020-12-31T00:00:00Z'), deactivationReason: 'test fixture' }
  });
  return row;
}

async function main() {
  const nativeEmptyFilters = parseOverviewQuery(
    { q: '  Anna   Working ', periodId: '', siteId: '', state: '', employeeId: '', page: null, pageSize: null },
    { allowEmployeeId: true }
  );
  check(nativeEmptyFilters.ok && nativeEmptyFilters.filters.q === 'Anna Working', 'native empty selects are absent filters and search whitespace is normalized');
  const malformedFilter = parseOverviewQuery(
    { q: null, periodId: null, siteId: 'not-a-uuid', state: null, employeeId: null, page: null, pageSize: null },
    { allowEmployeeId: true }
  );
  check(!malformedFilter.ok && !!malformedFilter.fieldErrors.siteId, 'non-empty malformed UUID still fails validation');

  const today = helsinkiToday();
  const now = new Date();
  const admin = await prisma.user.create({ data: { username: `today-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const alpha = await prisma.workSite.create({ data: { name: `Alpha Yard ${randomUUID().slice(0, 4)}` } });
  const beta = await prisma.workSite.create({ data: { name: `Beta Tower ${randomUUID().slice(0, 4)}` } });
  const northHall = await prisma.workArea.create({ data: { siteId: alpha.id, name: 'North Hall' } });
  const periodRow = await prisma.payrollPeriod.create({
    data: { startDate: today, endDate: new Date(today.getTime() + 6 * 86_400_000), status: 'OPEN', openedByUserId: admin.id }
  });
  const period: OverviewPeriod = {
    id: periodRow.id,
    startDate: today.toISOString().slice(0, 10),
    endDate: new Date(today.getTime() + 6 * 86_400_000).toISOString().slice(0, 10),
    status: 'OPEN'
  };

  const working = await employee('Anna', 'Working');
  const finished = await employee('Boris', 'Finished');
  const notStarted = await employee('Carla', 'Waiting');
  await employee('Inactive', 'Hidden', false);

  await prisma.siteAssignment.create({
    data: { employeeId: working.id, siteId: alpha.id, workAreaId: northHall.id, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00Z'), assignedByUserId: admin.id }
  });
  await prisma.siteAssignment.create({
    data: { employeeId: finished.id, siteId: beta.id, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00Z'), assignedByUserId: admin.id }
  });

  const openAt = new Date(now.getTime() - 37 * 60_000);
  const openEvent = await clockEvent(working.id, alpha.id, 'CHECK_IN', openAt);
  await prisma.employeeOpenShift.create({
    data: { employeeId: working.id, openedByClockEventId: openEvent, siteId: alpha.id, workAreaId: northHall.id, openedAt: openAt }
  });

  const firstStart = new Date(today.getTime() + 7 * 3_600_000);
  const firstEnd = new Date(firstStart.getTime() + 31 * 60_000);
  const secondStart = new Date(today.getTime() + 9 * 3_600_000);
  const secondEnd = new Date(secondStart.getTime() + 29 * 60_000);
  for (const [start, end] of [[firstStart, firstEnd], [secondStart, secondEnd]] as const) {
    const checkInEventId = await clockEvent(finished.id, beta.id, 'CHECK_IN', start);
    const checkOutEventId = await clockEvent(finished.id, beta.id, 'CHECK_OUT', end);
    await prisma.clockShift.create({
      data: { employeeId: finished.id, siteId: beta.id, checkInEventId, checkOutEventId, recordedStartAt: start, recordedEndAt: end }
    });
  }
  await prisma.attendanceException.create({
    data: { type: 'GPS_NOT_VERIFIED', employeeId: finished.id, occurredAt: now, status: 'OPEN' }
  });

  const scope = { siteIds: null, excludeEmployeeId: null, includeConflicts: true };
  const result = await prisma.$transaction(
    (tx) => buildOperationalOverview(tx, { page: 1, pageSize: 20 }, scope, period, today),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );

  check(result.summary.totalWorkers === 3, 'default owner view includes every active worker, including no-site/no-participant worker');
  check(result.summary.workingNow === 1, 'working-now count');
  check(result.summary.finishedToday === 1, 'finished-today count');
  check(result.summary.notStartedToday === 1, 'not-started count');
  check(result.summary.needsAttention === 1, 'attention count');
  check(result.items.map((item) => item.todayStatus).join(',') === 'WORKING,FINISHED,NOT_STARTED', 'useful status ordering');
  const workingItem = result.items.find((item) => item.employee.id === working.id)!;
  const finishedItem = result.items.find((item) => item.employee.id === finished.id)!;
  check(workingItem.todayWorkedMinutes >= 36 && workingItem.todayWorkedMinutes <= 38, 'open shift contributes live minutes');
  check(workingItem.currentAssignments[0]?.workArea?.name === 'North Hall', 'current work area is present');
  check(finishedItem.todayWorkedMinutes === 60, 'all finished shifts today are summed');
  check(finishedItem.needsAttention && finishedItem.openExceptionCount === 1, 'worker issue is visible');

  for (const q of ['Anna Working', working.employeeNumber, alpha.name, 'North Hall', 'north hall']) {
    const searched = await prisma.$transaction(
      (tx) => buildOperationalOverview(tx, { q, page: 1, pageSize: 20 }, scope, period, today),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    check(searched.totalItems === 1 && searched.items[0]?.employee.id === working.id, `search matches ${q}`);
  }

  const siteFiltered = await prisma.$transaction(
    (tx) => buildOperationalOverview(tx, { siteId: beta.id, page: 1, pageSize: 20 }, scope, period, today),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  check(siteFiltered.totalItems === 1 && siteFiltered.items[0]?.employee.id === finished.id, 'site filter narrows workers');

  const pagedSearch = await prisma.$transaction(
    (tx) => buildOperationalOverview(tx, { q: 'Waiting', page: 1, pageSize: 1 }, scope, period, today),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  check(pagedSearch.totalItems === 1 && pagedSearch.items[0]?.employee.id === notStarted.id, 'search runs before pagination');

  const serialized = JSON.stringify(result);
  for (const forbidden of ['latitude', 'longitude', 'payloadHash', 'requestId', 'deviceInstallationId', 'password']) {
    check(!serialized.includes(forbidden), `response excludes ${forbidden}`);
  }

  console.log(`PASS ${checks}/${checks}: owner Today dashboard service`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
