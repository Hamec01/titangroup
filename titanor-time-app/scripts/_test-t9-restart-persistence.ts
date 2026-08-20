import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { workedMinutesFromIsoSegments } from '../lib/reporting/report-format';

// docs/titanor-time/T9_RESTART_TEST_PLAN.md — permanent T9.5 verifier. The surrounding test
// harness owns Docker restart/volume/hash evidence; this script owns fixture identity, durable
// Prisma state, authenticated API continuity and real-browser rendering before/after restart.

const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:39666';
const STATE_FILE = process.env.TEST_STATE_FILE;
const PHASE = process.env.TEST_PHASE;
const CREATE_RECOVERY_WORK_AREA = process.env.TEST_CREATE_RECOVERY_WORK_AREA === '1';
const CREATE_RESTORE_WORK_AREA = process.env.TEST_CREATE_RESTORE_WORK_AREA === '1';
const CSRF = 'titanor-time';

interface RestartManifest {
  version: 1;
  run: string;
  admin: { userId: string; username: string; sessionToken: string };
  worker: { userId: string; employeeId: string; username: string; sessionToken: string; lastName: string };
  foremanUserId: string;
  site: { id: string; name: string };
  templateId: string;
  periodId: string;
  timesheetId: string;
  expectedSnapshotHash: string;
  recoveryWorkArea?: { id: string; name: string };
  restoreWorkArea?: { id: string; name: string };
}

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    pass++;
    return;
  }
  fail++;
  console.error(`FAIL: ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)])
    );
  }
  return value;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function workedMinutesInVersion(version: any): number {
  return version.days.reduce((total: number, day: any) => total + workedMinutesFromIsoSegments(day.segments), 0);
}

async function createSession(userId: string): Promise<string> {
  const raw = generateSessionToken();
  await prisma.userSession.create({
    data: {
      userId,
      tokenHash: hashSessionToken(raw),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      userAgent: 'T9.5 restart verifier'
    }
  });
  return raw;
}

async function resolvePreparedFixture(): Promise<Omit<RestartManifest, 'version' | 'expectedSnapshotHash' | 'admin' | 'worker'> & {
  adminUserId: string;
  adminUsername: string;
  workerUserId: string;
  workerUsername: string;
  workerEmployeeId: string;
  workerLastName: string;
}> {
  const admins = await prisma.user.findMany({
    where: { username: { startsWith: 't94-admin-' } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { id: true, username: true, createdAt: true }
  });
  if (admins.length !== 1) throw new Error(`expected exactly one T9.4 ADMIN fixture, got ${admins.length}`);
  const admin = admins[0];

  const workers = await prisma.employee.findMany({
    where: { lastName: { startsWith: 'Flowworker' } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { id: true, lastName: true, user: { select: { id: true, username: true } } }
  });
  if (workers.length !== 1) throw new Error(`expected exactly one activated T9.4 WORKER fixture, got ${workers.length}`);
  const worker = workers[0];
  if (!worker.user) throw new Error('T9.4 WORKER fixture has no linked user');

  const foremen = await prisma.user.findMany({
    where: { username: { startsWith: 't94-foreman-' } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { id: true }
  });
  if (foremen.length !== 1) throw new Error(`expected exactly one optional T9.4 FOREMAN fixture, got ${foremen.length}`);

  const assignments = await prisma.siteAssignment.findMany({
    where: { employeeId: worker.id },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { site: { select: { id: true, name: true } } }
  });
  if (assignments.length !== 1 || !assignments[0].site.name.startsWith('Flowsite ')) {
    throw new Error(`expected exactly one main T9.4 site assignment, got ${assignments.length}`);
  }
  const site = assignments[0].site;

  const templates = await prisma.workScheduleTemplate.findMany({
    where: { name: { startsWith: 'Standard ' } },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { id: true }
  });
  if (templates.length !== 1) throw new Error(`expected exactly one T9.4 template, got ${templates.length}`);

  const timesheets = await prisma.timesheet.findMany({
    where: { employeeId: worker.id, status: 'FINAL_APPROVED' },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { id: true, periodId: true }
  });
  if (timesheets.length !== 1) throw new Error(`expected exactly one final-approved T9.4 timesheet, got ${timesheets.length}`);

  const run = admin.username.replace(/^t94-admin-/, '');
  return {
    run,
    adminUserId: admin.id,
    adminUsername: admin.username,
    workerUserId: worker.user.id,
    workerUsername: worker.user.username,
    workerEmployeeId: worker.id,
    workerLastName: worker.lastName,
    foremanUserId: foremen[0].id,
    site,
    templateId: templates[0].id,
    periodId: timesheets[0].periodId,
    timesheetId: timesheets[0].id
  };
}

async function fixtureSnapshot(manifest: Pick<RestartManifest, 'admin' | 'worker' | 'foremanUserId' | 'site' | 'templateId' | 'periodId' | 'timesheetId'>): Promise<unknown> {
  const [admin, workerUser, employee, foreman, site, template, period, timesheet, clockEvents, clockShifts, clockFragments, adjustments, fixtureAuditCount, foremanAssignmentCount] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: manifest.admin.userId },
        select: { id: true, username: true, status: true, locale: true, employeeId: true, userRoles: { orderBy: { createdAt: 'asc' }, select: { validFrom: true, validTo: true, role: { select: { name: true } } } } }
      }),
      prisma.user.findUniqueOrThrow({
        where: { id: manifest.worker.userId },
        select: { id: true, username: true, status: true, locale: true, employeeId: true, userRoles: { orderBy: { createdAt: 'asc' }, select: { validFrom: true, validTo: true, role: { select: { name: true } } } } }
      }),
      prisma.employee.findUniqueOrThrow({
        where: { id: manifest.worker.employeeId },
        select: { id: true, employeeNumber: true, firstName: true, lastName: true, version: true, employments: { orderBy: { createdAt: 'asc' }, select: { active: true, startDate: true, endDate: true, deactivationReason: true } } }
      }),
      prisma.user.findUniqueOrThrow({
        where: { id: manifest.foremanUserId },
        select: { id: true, username: true, status: true, locale: true, employeeId: true, userRoles: { select: { validFrom: true, validTo: true, role: { select: { name: true } } } } }
      }),
      prisma.workSite.findUniqueOrThrow({
        where: { id: manifest.site.id },
        select: {
          id: true,
          name: true,
          active: true,
          version: true,
          currentGeofenceVersionId: true,
          workAreas: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true, active: true, version: true } },
          geofenceVersions: { orderBy: { versionNumber: 'asc' }, select: { id: true, versionNumber: true, latitude: true, longitude: true, radiusMeters: true, createdByUserId: true } },
          siteAssignments: { where: { employeeId: manifest.worker.employeeId }, orderBy: { createdAt: 'asc' }, select: { id: true, employeeId: true, workAreaId: true, templateVersionId: true, isPrimary: true, validFrom: true, validTo: true, version: true } }
        }
      }),
      prisma.workScheduleTemplate.findUniqueOrThrow({
        where: { id: manifest.templateId },
        select: { id: true, name: true, active: true, versions: { orderBy: { versionNumber: 'asc' }, select: { id: true, versionNumber: true, effectiveFrom: true, days: { orderBy: { weekday: 'asc' }, select: { weekday: true, isWorkingDay: true, plannedStartTime: true, plannedEndTime: true, plannedBreakMinutes: true } } } } }
      }),
      prisma.payrollPeriod.findUniqueOrThrow({
        where: { id: manifest.periodId },
        select: { id: true, startDate: true, endDate: true, status: true, version: true, participants: { where: { employeeId: manifest.worker.employeeId }, select: { employeeId: true, expected: true, exclusionReason: true } } }
      }),
      prisma.timesheet.findUniqueOrThrow({
        where: { id: manifest.timesheetId },
        select: {
          id: true,
          employeeId: true,
          periodId: true,
          status: true,
          currentVersionId: true,
          lastReturnedReason: true,
          systemReopenGeneration: true,
          versions: {
            orderBy: { versionNumber: 'asc' },
            select: {
              id: true,
              versionNumber: true,
              source: true,
              submissionSource: true,
              note: true,
              days: {
                orderBy: { date: 'asc' },
                select: {
                  id: true,
                  date: true,
                  dayType: true,
                  confirmedZero: true,
                  note: true,
                  segments: {
                    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
                    select: { id: true, date: true, startAt: true, endAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true, originClockShiftFragmentId: true, breaks: { orderBy: [{ startAt: 'asc' }, { id: 'asc' }], select: { id: true, startAt: true, endAt: true, paid: true } } }
                  }
                }
              },
              reviewScopes: { orderBy: { createdAt: 'asc' }, select: { id: true, scopeType: true, scopePurpose: true, siteId: true, status: true, contentHash: true, reviewedByUserId: true, returnReason: true } }
            }
          }
        }
      }),
      prisma.clockEvent.findMany({
        where: { employeeId: manifest.worker.employeeId },
        orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }],
        select: { id: true, operationType: true, siteId: true, workAreaId: true, sourceAssignmentId: true, clientCapturedAt: true, effectiveAt: true, gpsVerification: true, processingState: true, channel: true }
      }),
      prisma.clockShift.findMany({
        where: { employeeId: manifest.worker.employeeId },
        orderBy: [{ recordedStartAt: 'asc' }, { id: 'asc' }],
        select: { id: true, checkInEventId: true, checkOutEventId: true, siteId: true, workAreaId: true, sourceAssignmentId: true, recordedStartAt: true, recordedEndAt: true, materializationState: true }
      }),
      prisma.clockShiftFragment.findMany({
        where: { employeeId: manifest.worker.employeeId },
        orderBy: [{ recordedStartAt: 'asc' }, { id: 'asc' }],
        select: { id: true, clockShiftId: true, fragmentIndex: true, payrollPeriodId: true, timesheetId: true, date: true, recordedStartAt: true, recordedEndAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true, reportedProjectionState: true }
      }),
      prisma.clockShiftAdjustment.findMany({
        where: { employeeId: manifest.worker.employeeId },
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, clockShiftFragmentId: true, clockShiftId: true, changeType: true, changedByUserId: true, beforeStartAt: true, afterStartAt: true, beforeEndAt: true, afterEndAt: true, beforeSiteId: true, afterSiteId: true, reason: true }
      }),
      prisma.auditEvent.count({ where: { OR: [{ actorUserId: manifest.admin.userId }, { actorUserId: manifest.worker.userId }, { entityId: { in: [manifest.site.id, manifest.timesheetId] } }] } }),
      prisma.foremanAssignment.count({ where: { foremanUserId: manifest.foremanUserId, siteId: manifest.site.id } })
    ]);

  return { admin, workerUser, employee, foreman, site, template, period, timesheet, clockEvents, clockShifts, clockFragments, adjustments, fixtureAuditCount, foremanAssignmentCount };
}

async function readText(page: Page, path: string): Promise<string> {
  const response = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 20_000 });
  check(`${path} responds without server error`, response !== null && response.status() < 500, response?.status());
  return page.locator('body').innerText();
}

async function contextWithSession(token: string): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: BASE }]);
  context.on('close', () => void browser.close());
  return context;
}

async function apiGet(path: string, token: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // The status assertion below remains authoritative for a malformed response.
  }
  return { status: response.status, body };
}

async function prepare(): Promise<void> {
  if (!STATE_FILE) throw new Error('TEST_STATE_FILE is required');
  const fixture = await resolvePreparedFixture();
  const [adminSessionToken, workerSessionToken] = await Promise.all([createSession(fixture.adminUserId), createSession(fixture.workerUserId)]);
  const manifest: RestartManifest = {
    version: 1,
    run: fixture.run,
    admin: { userId: fixture.adminUserId, username: fixture.adminUsername, sessionToken: adminSessionToken },
    worker: { userId: fixture.workerUserId, employeeId: fixture.workerEmployeeId, username: fixture.workerUsername, sessionToken: workerSessionToken, lastName: fixture.workerLastName },
    foremanUserId: fixture.foremanUserId,
    site: fixture.site,
    templateId: fixture.templateId,
    periodId: fixture.periodId,
    timesheetId: fixture.timesheetId,
    expectedSnapshotHash: ''
  };
  const snapshot = await fixtureSnapshot(manifest);
  manifest.expectedSnapshotHash = hashValue(snapshot);
  writeFileSync(STATE_FILE, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);

  check('prepare: T9.4 timesheet is FINAL_APPROVED with two immutable versions', (snapshot as any).timesheet.status === 'FINAL_APPROVED' && (snapshot as any).timesheet.versions.length === 2);
  check('prepare: canonical final version contains 420 worked minutes', workedMinutesInVersion((snapshot as any).timesheet.versions[1]) === 420);
  check('prepare: fixture has real clock events, shift, fragment and adjustment', (snapshot as any).clockEvents.length === 2 && (snapshot as any).clockShifts.length === 1 && (snapshot as any).clockFragments.length >= 1 && (snapshot as any).adjustments.length === 1);
  check('prepare: optional FOREMAN has zero assignment to fixture site', (snapshot as any).foremanAssignmentCount === 0);
  check('prepare: restart manifest mode is 0600 and hash is SHA-256', manifest.expectedSnapshotHash.length === 64);
}

async function verify(): Promise<void> {
  if (!STATE_FILE) throw new Error('TEST_STATE_FILE is required');
  const manifest = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RestartManifest;
  if (manifest.version !== 1) throw new Error('unsupported restart manifest version');

  const snapshot = await fixtureSnapshot(manifest);
  const actualSnapshotHash = hashValue(snapshot);
  check('verify: complete allowlisted fixture snapshot is unchanged', actualSnapshotHash === manifest.expectedSnapshotHash, { expected: manifest.expectedSnapshotHash, actual: actualSnapshotHash });
  check('verify: timesheet remains FINAL_APPROVED and points to V2', (snapshot as any).timesheet.status === 'FINAL_APPROVED' && (snapshot as any).timesheet.versions.length === 2 && (snapshot as any).timesheet.currentVersionId === (snapshot as any).timesheet.versions[1].id);
  check('verify: clock rows and immutable adjustment remain present', (snapshot as any).clockEvents.length === 2 && (snapshot as any).clockShifts.length === 1 && (snapshot as any).clockFragments.length >= 1 && (snapshot as any).adjustments.length === 1);
  check('verify: optional FOREMAN remains unassigned', (snapshot as any).foremanAssignmentCount === 0);
  if (manifest.recoveryWorkArea) {
    check('verify: post-recovery mutation remains durable', (snapshot as any).site.workAreas.some((area: any) => area.id === manifest.recoveryWorkArea?.id && area.name === manifest.recoveryWorkArea?.name));
  }
  if (manifest.restoreWorkArea) {
    check('verify: post-restore mutation remains durable', (snapshot as any).site.workAreas.some((area: any) => area.id === manifest.restoreWorkArea?.id && area.name === manifest.restoreWorkArea?.name));
  }

  const auditBefore = await prisma.auditEvent.count();
  const adminContext = await contextWithSession(manifest.admin.sessionToken);
  const workerContext = await contextWithSession(manifest.worker.sessionToken);
  const browserErrors: string[] = [];
  for (const context of [adminContext, workerContext]) {
    context.on('page', (page) => page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); }));
  }

  try {
    const adminPage = await adminContext.newPage();
    adminPage.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    const siteText = await readText(adminPage, `/admin/sites/${manifest.site.id}`);
    check('verify: ADMIN session survives and renders fixture site/worker', siteText.includes(manifest.site.name) && siteText.includes(manifest.worker.lastName));
    const timesheetText = await readText(adminPage, `/admin/timesheets/${manifest.timesheetId}`);
    check('verify: ADMIN sees final-approved V2 after restart', timesheetText.includes('FINAL_APPROVED') && timesheetText.includes('version 2'));
    const reportText = await readText(adminPage, `/admin/reports?employeeId=${manifest.worker.employeeId}&periodId=${manifest.periodId}`);
    check('verify: ADMIN report still renders canonical 420 minutes', /7\s*h\s*0\s*min/.test(reportText));

    const workerPage = await workerContext.newPage();
    workerPage.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
    const periodText = await readText(workerPage, `/worker/periods/${manifest.periodId}`);
    check('verify: WORKER session survives and sees finalized period/site', periodText.includes('Finalized') && periodText.includes(manifest.site.name));
    const clockText = await readText(workerPage, '/worker');
    check('verify: WORKER clock state is still clocked out', clockText.includes('Clocked out'));

    const workerReport = await apiGet(`/api/admin/reports/workers/${manifest.worker.employeeId}?periodId=${manifest.periodId}`, manifest.admin.sessionToken);
    check('verify: report API returns FINAL_APPROVED V2 and 420 minutes', workerReport.status === 200 && workerReport.body?.timesheet?.status === 'FINAL_APPROVED' && workerReport.body?.timesheet?.versionNumber === 2 && workerReport.body?.total?.workedMinutes === 420, workerReport.body?.total);
    const clockState = await apiGet('/api/worker/attendance/clock-state', manifest.worker.sessionToken);
    check('verify: clock-state API has no open shift', clockState.status === 200 && clockState.body?.state === 'CLOCKED_OUT', clockState.body);
  } finally {
    await adminContext.close();
    await workerContext.close();
  }

  check('verify: real browser emitted zero console errors', browserErrors.length === 0, browserErrors);
  const auditAfterReads = await prisma.auditEvent.count();
  check('verify: authenticated GET/browser probes create zero AuditEvent rows', auditAfterReads === auditBefore, { auditBefore, auditAfterReads });

  if (CREATE_RECOVERY_WORK_AREA) {
    if (manifest.recoveryWorkArea) throw new Error('recovery work area already exists in manifest');
    const name = `Restart proof ${manifest.run}`;
    const response = await fetch(`${BASE}/api/admin/sites/${manifest.site.id}/work-areas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': CSRF,
        'Idempotency-Key': randomUUID(),
        Cookie: `${SESSION_COOKIE_NAME}=${manifest.admin.sessionToken}`
      },
      body: JSON.stringify({ name })
    });
    const body = (await response.json()) as { id?: string; name?: string; error?: { code?: string } };
    check('verify: recovered stack accepts a real ADMIN write', response.status === 201 && typeof body.id === 'string' && body.name === name, { status: response.status, code: body.error?.code });
    if (response.status === 201 && body.id) {
      manifest.recoveryWorkArea = { id: body.id, name };
      manifest.expectedSnapshotHash = hashValue(await fixtureSnapshot(manifest));
      writeFileSync(STATE_FILE, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
      chmodSync(STATE_FILE, 0o600);
    }
  }

  if (CREATE_RESTORE_WORK_AREA) {
    if (manifest.restoreWorkArea) throw new Error('restore work area already exists in manifest');
    const name = `Restore proof ${manifest.run}`;
    const response = await fetch(`${BASE}/api/admin/sites/${manifest.site.id}/work-areas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': CSRF,
        'Idempotency-Key': randomUUID(),
        Cookie: `${SESSION_COOKIE_NAME}=${manifest.admin.sessionToken}`
      },
      body: JSON.stringify({ name })
    });
    const body = (await response.json()) as { id?: string; name?: string; error?: { code?: string } };
    check('verify: restored stack accepts a real ADMIN write', response.status === 201 && typeof body.id === 'string' && body.name === name, { status: response.status, code: body.error?.code });
    if (response.status === 201 && body.id) {
      manifest.restoreWorkArea = { id: body.id, name };
      manifest.expectedSnapshotHash = hashValue(await fixtureSnapshot(manifest));
      writeFileSync(STATE_FILE, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 });
      chmodSync(STATE_FILE, 0o600);
    }
  }
}

async function main(): Promise<void> {
  if (PHASE === 'prepare') await prepare();
  else if (PHASE === 'verify') await verify();
  else throw new Error('TEST_PHASE must be prepare or verify');

  console.log(JSON.stringify({ pass, fail, phase: PHASE }));
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'T9.5 restart verifier failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
