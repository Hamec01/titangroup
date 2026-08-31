import { randomUUID, randomBytes } from 'node:crypto';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { prisma } from '../lib/prisma';
import { bootstrapSuperAdmin } from './bootstrap-super-admin';

// docs/titanor-time/T9_FULL_FLOW_TEST_PLAN.md — T9.4 full end-to-end business workflow. Real
// Chromium, production standalone build, disposable PostgreSQL 16, real HTTP, DB assertions, zero
// mocks of business operations (GPS position mocking via context.setGeolocation() is the one
// explicitly-allowed device-coordinate emulation).

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39660';
const CSRF = 'titanor-time';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 800) : '');
  }
}

function genPassword(): string {
  return randomBytes(16).toString('base64url');
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, body };
}

function authHeaders(cookie: string, extra?: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Requested-With': CSRF, Cookie: `tt_session=${cookie}`, ...extra };
}

async function login(base: string, identifier: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
    body: JSON.stringify({ identifier, password })
  });
  if (!res.ok) throw new Error(`login failed for ${identifier}: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie?.match(/tt_session=([^;]+)/);
  if (!match) throw new Error(`no session cookie for ${identifier}`);
  return match[1];
}

// Next.js App Router soft navigations (router.push) don't fire a 'load' event, and
// page.waitForURL() in this Playwright version can hang waiting for one even after the URL has
// changed. Polling location.pathname+search is reliable for both soft and hard navigations.
async function waitPath(page: Page, pattern: RegExp, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (src) => new RegExp(src).test(window.location.pathname + window.location.search),
    pattern.source,
    { timeout }
  );
}

async function uiLogin(page: Page, identifier: string, password: string, expectUrlPattern: RegExp): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.locator('.login-submit').click();
  await waitPath(page, expectUrlPattern);
}

function forbiddenAuditTerms(): string[] {
  return ['latitude', 'longitude', 'gps', 'password', 'passwordhash', 'cookie', 'token', 'payloadhash', 'requestid', 'devicesequence'];
}

function auditBlobIsClean(row: { beforeValue: unknown; afterValue: unknown }): boolean {
  const blob = JSON.stringify({ before: row.beforeValue, after: row.afterValue }).toLowerCase();
  return !forbiddenAuditTerms().some((term) => blob.includes(term));
}

async function main() {
  const run = randomUUID().slice(0, 6);
  const geo = { latitude: 60.1699, longitude: 24.9384 }; // Helsinki — arbitrary fixed point, matches the fixture's own geofence center.

  // ---- Phase 0: SUPER_ADMIN (bootstrap) + ADMIN (same accepted primitive, T9.1-T9.3 precedent) ----
  const superAdminUsername = `t94-super-${run}`;
  const superAdminPassword = genPassword();
  await bootstrapSuperAdmin({ username: superAdminUsername, email: null, locale: 'EN', dryRun: false, password: superAdminPassword });

  const adminUsername = `t94-admin-${run}`;
  const adminPassword = genPassword();
  {
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
    const user = await prisma.user.create({ data: { username: adminUsername, status: 'ACTIVE', locale: 'EN', passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  const browser = await chromium.launch({ headless: true });

  // ======================= A. ADMIN — setup (real browser, real forms) =======================
  const adminCtx = await browser.newContext();
  await adminCtx.grantPermissions(['geolocation']);
  const admin = await adminCtx.newPage();
  await uiLogin(admin, adminUsername, adminPassword, /\/admin/);

  const siteName = `Flowsite ${run}`;
  await admin.goto(`${BASE}/admin/sites/new`, { waitUntil: 'networkidle' });
  await admin.locator('#site-name').fill(siteName);
  await admin.locator('.login-submit').click();
  await waitPath(admin, /\/admin\/setup/);
  const createdSite = await prisma.workSite.findFirstOrThrow({ where: { name: siteName } });
  const siteId = createdSite.id;
  check('A2: site created via real UI form, redirected to /admin/setup', /^[0-9a-f-]{36}$/.test(siteId), siteId);

  // A14: double-click idempotency proof on a genuinely idempotent create form — a throwaway
  // second site, not the main fixture site, so it never interferes with the rest of the flow.
  {
    const dblSiteName = `Flowsite-dbl ${run}`;
    await admin.goto(`${BASE}/admin/sites/new`, { waitUntil: 'networkidle' });
    await admin.locator('#site-name').fill(dblSiteName);
    const submitBtn = admin.locator('.login-submit');
    await Promise.all([submitBtn.click({ force: true }), submitBtn.click({ force: true }).catch(() => {})]);
    await waitPath(admin, /\/admin\/setup/, 15000);
    const dblCount = await prisma.workSite.count({ where: { name: dblSiteName } });
    check('A14: rapid double-click on an idempotent create form (site) produces exactly one row', dblCount === 1, dblCount);
  }

  await admin.goto(`${BASE}/admin/sites/${siteId}`, { waitUntil: 'networkidle' });
  const workAreaName = `Zone ${run}`;
  await admin.locator('#work-area-name').fill(workAreaName);
  await admin.locator('button', { hasText: 'Add work area' }).click();
  await admin.getByText(workAreaName, { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  check('A3: work area created via real UI form', await admin.locator('body').innerText().then((t) => t.includes(workAreaName)));

  await admin.locator('#geofence-latitude').fill(String(geo.latitude));
  await admin.locator('#geofence-longitude').fill(String(geo.longitude));
  await admin.locator('#geofence-radius').fill('150');
  await admin.locator('button', { hasText: /Set geofence|Create new geofence version/ }).click();
  await admin.getByText(/150 m/).first().waitFor({ state: 'visible', timeout: 10000 });
  const geofenceSectionText = await admin.locator('body').innerText();
  check('A4: geofence set via real UI form', geofenceSectionText.includes('150 m') || geofenceSectionText.includes('radius 150'), geofenceSectionText.slice(geofenceSectionText.indexOf('Geofence'), geofenceSectionText.indexOf('Geofence') + 300));

  const templateName = `Standard ${run}`;
  await admin.goto(`${BASE}/admin/templates/new`, { waitUntil: 'networkidle' });
  await admin.locator('#template-name').fill(templateName);
  await admin.locator('.login-submit').click();
  await waitPath(admin, /\/admin\/setup/, 15000);
  check('A5: template created via real UI form', true);

  const workerLastName = `Flowworker${run}`;
  await admin.goto(`${BASE}/admin/workers/new`, { waitUntil: 'networkidle' });
  await admin.locator('#worker-first-name').fill('Flow');
  await admin.locator('#worker-last-name').fill(workerLastName);
  await admin.locator('.login-submit').click();
  // T9.7 onboarding: creating a worker now opens that worker's profile, not /admin/setup.
  await waitPath(admin, /\/admin\/workers\/[0-9a-f-]{36}$/, 15000);
  const workerEmployee = await prisma.employee.findFirstOrThrow({ where: { lastName: workerLastName } });
  const workerUser = await prisma.user.findFirstOrThrow({ where: { employeeId: workerEmployee.id } });
  // UI-created workers now default to the RU locale; this flow test asserts the English worker
  // strings, so pin this one worker to EN (the RU rendering has its own coverage in
  // _test-offline-views). Not a behaviour change — locale is a per-user setting.
  await prisma.user.update({ where: { id: workerUser.id }, data: { locale: 'EN' } });
  check('A6: worker created via real UI form', true, workerEmployee.id);

  await admin.goto(`${BASE}/admin/assignments/new`, { waitUntil: 'networkidle' });
  await admin.locator('#assignment-employee').selectOption({ value: workerEmployee.id });
  await admin.locator('#assignment-site').selectOption({ value: siteId });
  await admin.locator('#assignment-valid-from').fill('2020-01-01');
  await admin.locator('#assignment-is-primary').check();
  await admin.locator('.login-submit').click();
  await waitPath(admin, /\/admin\/setup/, 15000);
  const assignmentRow = await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: workerEmployee.id, siteId } });
  check('A7: worker assigned to site via real UI form', true, assignmentRow.id);

  const foremanUsername = `t94-foreman-${run}`;
  await admin.goto(`${BASE}/admin/users/new`, { waitUntil: 'networkidle' });
  await admin.locator('#user-username').fill(foremanUsername);
  const foremanActivationResponsePromise = admin.waitForResponse((r) => r.url().includes('/activation') && r.request().method() === 'POST');
  await admin.locator('.login-submit').click();
  const foremanActivationResponse = await foremanActivationResponsePromise;
  const foremanActivationBody = (await foremanActivationResponse.json()) as { activationCode: string };
  const foremanCode = foremanActivationBody.activationCode;
  const foremanUser = await prisma.user.findFirstOrThrow({ where: { username: foremanUsername } });
  check('A8a: standalone foreman created via real UI form with auto-issued activation code', typeof foremanCode === 'string' && foremanCode.length > 0);

  const foremanAssignmentCount = await prisma.foremanAssignment.count({ where: { foremanUserId: foremanUser.id, siteId } });
  check('A8b: optional foreman deliberately has NO assignment to the fixture site', foremanAssignmentCount === 0, foremanAssignmentCount);

  const helsinkiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  const periodEndDate = new Date(`${helsinkiToday}T00:00:00.000Z`);
  periodEndDate.setUTCDate(periodEndDate.getUTCDate() + 13);
  const periodEnd = periodEndDate.toISOString().slice(0, 10);
  await admin.goto(`${BASE}/admin/periods/new`, { waitUntil: 'networkidle' });
  await admin.locator('#period-start').fill(helsinkiToday);
  await admin.locator('#period-end').fill(periodEnd);
  await admin.locator('.login-submit').click();
  await waitPath(admin, /\/admin\/periods\/[0-9a-f-]{36}$/, 15000);
  const periodRow = await prisma.payrollPeriod.findFirstOrThrow({ where: { startDate: new Date(`${helsinkiToday}T00:00:00.000Z`) } });
  const periodId = periodRow.id;
  check('A9: OPEN payroll period covering today created via real UI form', periodRow.status === 'OPEN', periodRow.status);

  await admin.goto(`${BASE}/admin/workers/${workerEmployee.id}`, { waitUntil: 'networkidle' });
  const workerActivationResponsePromise = admin.waitForResponse((r) => r.url().includes('/activation') && r.request().method() === 'POST');
  await admin.locator('button', { hasText: 'Issue activation code' }).click();
  const workerActivationResponse = await workerActivationResponsePromise;
  const workerActivationBody = (await workerActivationResponse.json()) as { activationCode: string };
  const workerCode = workerActivationBody.activationCode;
  check('A10: worker activation code issued via real UI button', typeof workerCode === 'string' && workerCode.length > 0, workerCode);

  // A13: reload proves durable save — site detail still shows the work area/geofence after a fresh navigation.
  await admin.goto(`${BASE}/admin/sites/${siteId}`, { waitUntil: 'networkidle' });
  const siteDetailText = await admin.locator('body').innerText();
  check('A13: reloaded site detail still shows work area + geofence (durable) and no assigned foreman', siteDetailText.includes(workAreaName) && siteDetailText.includes('150 m') && !siteDetailText.includes(`${foremanUsername} ·`));

  // ---- Activate WORKER and FOREMAN (real UI activation flow, throwaway context) ----
  const workerPassword = genPassword();
  const foremanPassword = genPassword();
  {
    const activationCtx = await browser.newContext();
    const p = await activationCtx.newPage();

    await p.goto(`${BASE}/activate/${workerCode}`, { waitUntil: 'networkidle' });
    const workerActivateText = await p.locator('body').innerText();
    check('A11a: /activate/[token] confirms the correct worker identity', workerActivateText.includes('Flow') && workerActivateText.includes(workerLastName[0]));
    await p.locator('a.login-submit', { hasText: 'Continue' }).click();
    await waitPath(p, /\/set-password/, 10000);
    await p.locator('#password').fill(workerPassword);
    await p.locator('#confirm-password').fill(workerPassword);
    await p.locator('button[type="submit"].login-submit').click();
    await p.waitForSelector('text=Account activated', { timeout: 10000 });
    await p.locator('button', { hasText: 'Continue' }).click();
    await waitPath(p, /\/worker/, 10000);
    check('A11b: worker activation completes (auto-login lands on /worker)', p.url().includes('/worker'));

    await p.goto(`${BASE}/activate-account/${foremanCode}`, { waitUntil: 'networkidle' });
    const foremanActivateText = await p.locator('body').innerText();
    check('A12a: /activate-account/[token] confirms a foreman identity page renders', foremanActivateText.includes('Activate'));
    await p.locator('a.login-submit', { hasText: 'Continue' }).click();
    await waitPath(p, /\/set-account-password/, 10000);
    await p.locator('#password').fill(foremanPassword);
    await p.locator('#confirm-password').fill(foremanPassword);
    await p.locator('button[type="submit"].login-submit').click();
    await p.waitForSelector('text=Account activated', { timeout: 10000 });
    await p.locator('button', { hasText: 'Continue' }).click();
    await waitPath(p, /\/foreman/, 10000);
    check('A12b: foreman activation completes (auto-login lands on /foreman)', p.url().includes('/foreman'));

    await activationCtx.close();
  }

  await admin.close();

  // ======================= B. WORKER — first version =======================
  const workerCtx = await browser.newContext();
  await workerCtx.grantPermissions(['geolocation']);
  await workerCtx.setGeolocation(geo);
  const worker = await workerCtx.newPage();
  await uiLogin(worker, workerUser.username, workerPassword, /\/worker/);
  await worker.waitForLoadState('networkidle');
  // 2026 PWA redesign: the clock control is `.wk-main-action`; `.wk-main-action-wrap.out` / `.in`
  // is the language-neutral clocked-out / clocked-in signal.
  const mainAction = worker.locator('.wk-main-action');
  await worker.locator('.wk-main-action-wrap.out').waitFor({ state: 'visible', timeout: 20000 });
  check('B1/B2: worker logs in with the credentials just set and lands on /worker', worker.url().includes('/worker'));

  const checkInText = await worker.locator('body').innerText();
  check('B3: assigned site is offered for check-in', checkInText.includes(siteName));

  await mainAction.click();
  await worker.locator('.wk-main-action-wrap.in').waitFor({ state: 'visible', timeout: 15000 });
  await worker.waitForTimeout(1000);
  const openShiftAfterCheckIn = await prisma.employeeOpenShift.findFirst({ where: { employeeId: workerEmployee.id } });
  const checkInEventCountAfter = await prisma.clockEvent.count({ where: { employeeId: workerEmployee.id, operationType: 'CHECK_IN' } });
  check('B5a: EmployeeOpenShift exists after real Check In (GPS inside geofence)', openShiftAfterCheckIn !== null, openShiftAfterCheckIn);
  check('B5b: exactly one CHECK_IN ClockEvent recorded', checkInEventCountAfter === 1, checkInEventCountAfter);
  check('B5c: UI reflects Clocked in state', (await worker.locator('.wk-main-action-wrap.in').count()) > 0);

  await mainAction.click();
  await worker.locator('.wk-main-action-wrap.out').waitFor({ state: 'visible', timeout: 15000 });
  await worker.waitForTimeout(1000);
  const openShiftAfterCheckOut = await prisma.employeeOpenShift.findFirst({ where: { employeeId: workerEmployee.id } });
  const clockShift = await prisma.clockShift.findFirst({ where: { employeeId: workerEmployee.id } });
  const checkOutEventCountAfter = await prisma.clockEvent.count({ where: { employeeId: workerEmployee.id, operationType: 'CHECK_OUT' } });
  check('B7a: EmployeeOpenShift cleared after Check Out', openShiftAfterCheckOut === null);
  check('B7b: exactly one closed ClockShift, no duplicates', clockShift !== null && clockShift.recordedEndAt !== null && checkOutEventCountAfter === 1, { clockShift, checkOutEventCountAfter });

  await worker.goto(`${BASE}/worker/periods/${periodId}/hours`, { waitUntil: 'networkidle' });
  await worker.locator('.wk-day-item', { hasText: helsinkiToday }).click();
  await waitPath(worker, new RegExp(`/hours/${helsinkiToday}`), 10000);

  // The template auto-selected by /admin/assignments/new (exactly one active template existed)
  // pre-populates a planned segment on working weekdays — remove any pre-existing segment(s) first
  // so the day contains exactly the one segment this scenario controls (deterministic 450/420 min).
  while ((await worker.locator('button', { hasText: 'Remove interval' }).count()) > 0) {
    await worker.locator('button', { hasText: 'Remove interval' }).first().click();
    await worker.waitForTimeout(150);
  }

  await worker.locator('button', { hasText: '+ Add interval' }).click();
  const timeInputsV1 = worker.locator('.wk-time-row input[type="time"]');
  await timeInputsV1.nth(0).fill('08:00');
  await timeInputsV1.nth(1).fill('16:00');
  await worker.locator('button', { hasText: '+ Add break' }).click();
  const breakInputsV1 = worker.locator('.wk-break-row input[type="time"]');
  await breakInputsV1.nth(0).fill('12:00');
  await breakInputsV1.nth(1).fill('12:30');
  // T10/T12: a worker fixing their own draft before sending it is no longer asked for a reason —
  // Save persists directly. The immutable ClockShiftAdjustment is still written server-side, with
  // a default reason.
  await worker.locator('button', { hasText: 'Save' }).click();
  await waitPath(worker, new RegExp(`/hours$`), 10000);
  check('B9/B10: day saved (08:00-16:00, unpaid break 12:00-12:30), redirected to hours list', true);
  const clockAdjustment = await prisma.clockShiftAdjustment.findFirst({ where: { employeeId: workerEmployee.id } });
  check('B10a: a worker self-edit is not gated behind a reason prompt', new URL(worker.url()).pathname.endsWith('/hours'));
  check('B10b: removing the materialized clock interval still records an immutable REMOVED adjustment', clockAdjustment?.changeType === 'REMOVED' && typeof clockAdjustment.reason === 'string' && clockAdjustment.reason.length > 0, clockAdjustment);

  const hoursListTextV1 = await worker.locator('body').innerText();
  check('B10c: worker hours list shows worked 7h 30m, not gross 8h', hoursListTextV1.includes('7h 30m') && !hoursListTextV1.includes('8h ·'));

  await worker.goto(`${BASE}/worker/periods/${periodId}/hours/${helsinkiToday}`, { waitUntil: 'networkidle' });
  const reloadedStart = await worker.locator('.wk-time-row input[type="time"]').nth(0).inputValue();
  const reloadedEnd = await worker.locator('.wk-time-row input[type="time"]').nth(1).inputValue();
  check('B11: reload shows the same saved segment (08:00-16:00)', reloadedStart === '08:00' && reloadedEnd === '16:00', { reloadedStart, reloadedEnd });

  // Direct DB verification of V1's expected worked-minutes formula (450) via the *draft*, since no
  // TimesheetVersion exists yet — the draft's own segments/breaks are what submit() will freeze.
  const timesheetForWorker = await prisma.timesheet.findFirstOrThrow({ where: { employeeId: workerEmployee.id, periodId } });
  const draftDayV1 = await prisma.timesheetDraftSegment.findMany({
    where: { draft: { timesheetId: timesheetForWorker.id }, date: new Date(`${helsinkiToday}T00:00:00.000Z`) },
    include: { breaks: true }
  });
  const draftWorkedMsV1 = draftDayV1.reduce((sum, seg) => {
    const gross = seg.endAt.getTime() - seg.startAt.getTime();
    const unpaid = seg.breaks.filter((b) => !b.paid).reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()), 0);
    return sum + (gross - unpaid);
  }, 0);
  check('B: draft day worked time = 450 minutes before submit (480 gross - 30 unpaid break)', draftWorkedMsV1 / 60000 === 450, draftWorkedMsV1 / 60000);

  await worker.goto(`${BASE}/worker/periods/${periodId}/submit`, { waitUntil: 'networkidle' });
  const submitSummaryV1 = await worker.locator('body').innerText();
  check('B12: submit summary shows canonical worked time 7h 30m', submitSummaryV1.includes('7h 30m total'), submitSummaryV1.slice(0, 300));
  await worker.locator('.wk-action-button', { hasText: 'Submit timesheet' }).click();
  await waitPath(worker, new RegExp(`/worker/periods/${periodId}$`), 10000);

  const timesheetAfterSubmit1 = await prisma.timesheet.findUniqueOrThrow({ where: { id: timesheetForWorker.id } });
  check('B14a: Timesheet.status = SUBMITTED after first submit', timesheetAfterSubmit1.status === 'SUBMITTED', timesheetAfterSubmit1.status);
  const v1 = await prisma.timesheetVersion.findUniqueOrThrow({ where: { id: timesheetAfterSubmit1.currentVersionId! } });
  check('B14b: an immutable TimesheetVersion V1 was created (versionNumber=1)', v1.versionNumber === 1, v1.versionNumber);
  const draftAfterSubmit = await prisma.timesheetDraft.findUnique({ where: { timesheetId: timesheetForWorker.id } });
  const draftDayAfterSubmit = draftAfterSubmit ? await prisma.timesheetDraftDay.findFirst({ where: { draftId: draftAfterSubmit.id, date: new Date(`${helsinkiToday}T00:00:00.000Z`) } }) : null;
  check('B14c: draft is emptied — no longer the source of the SUBMITTED content', draftDayAfterSubmit === null || draftDayAfterSubmit === undefined, draftDayAfterSubmit);

  const v1WorkSegments = await prisma.workSegment.findMany({ where: { timesheetVersionId: v1.id }, include: { breaks: true } });
  const v1WorkedMs = v1WorkSegments.reduce((sum, seg) => {
    const gross = seg.endAt.getTime() - seg.startAt.getTime();
    const unpaid = seg.breaks.filter((b) => !b.paid).reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()), 0);
    return sum + (gross - unpaid);
  }, 0);
  check('B14d: V1 content = 450 worked minutes', v1WorkedMs / 60000 === 450, v1WorkedMs / 60000);

  const v1Scopes = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersionId: v1.id } });
  check('B14e: exactly one SITE review scope created for V1, PENDING', v1Scopes.length === 1 && v1Scopes[0].scopeType === 'SITE' && v1Scopes[0].status === 'PENDING', v1Scopes);

  // Repeated submit must not create V2.
  const repeatSubmit = await jsonFetch(`${BASE}/api/worker/timesheets/${timesheetForWorker.id}/submit`, { method: 'POST', headers: authHeaders(await login(BASE, workerUser.username, workerPassword)) });
  check('B14f: repeated submit is rejected, no second version created', repeatSubmit.status !== 200 && (await prisma.timesheetVersion.count({ where: { timesheetId: timesheetForWorker.id } })) === 1, repeatSubmit.status);

  // ======================= C. ADMIN fallback — return, no foreman assignment =======================
  // The optional FOREMAN exists, but has no assignment and therefore sees no part of this site.
  const foremanCtx = await browser.newContext();
  const foreman = await foremanCtx.newPage();
  await uiLogin(foreman, foremanUser.username, foremanPassword, /\/foreman/);
  await foreman.goto(`${BASE}/foreman/review/standard`, { waitUntil: 'networkidle' });
  const unassignedForemanQueueText = await foreman.locator('body').innerText();
  check('C1: unassigned optional FOREMAN cannot see the worker/site scope', !unassignedForemanQueueText.includes(`Flow ${workerLastName}`) && !unassignedForemanQueueText.includes(siteName));

  const adminCtx2 = await browser.newContext();
  const admin2 = await adminCtx2.newPage();
  await uiLogin(admin2, adminUsername, adminPassword, /\/admin/);
  await admin2.goto(`${BASE}/admin/review-scopes`, { waitUntil: 'networkidle' });
  const v1ReviewRow = admin2.locator('tr', { hasText: `Flow ${workerLastName}` });
  check('C2: ADMIN fallback queue sees the SITE scope without a ForemanAssignment', await v1ReviewRow.count() === 1);
  await v1ReviewRow.locator('a').click();
  await waitPath(admin2, /\/admin\/review-scopes\/[0-9a-f-]+/, 10000);
  const reviewDetailText = await admin2.locator('body').innerText();
  check('C3: ADMIN sees the correct worker/site/version and canonical 7h 30m on the review card', reviewDetailText.includes(`Flow ${workerLastName}`) && reviewDetailText.includes(siteName) && reviewDetailText.includes('version 1') && reviewDetailText.includes('7h 30m'));

  const returnReasonText = `Break duration needs correction ${run}`;
  await admin2.locator('#return-reason').fill(returnReasonText);
  await admin2.locator('button', { hasText: 'Return to worker' }).click();
  await waitPath(admin2, /\/admin\/review-scopes$/, 10000);

  const v1ScopeAfterReturn = await prisma.timesheetReviewScope.findUniqueOrThrow({ where: { id: v1Scopes[0].id } });
  check('C5a: scope transitioned to RETURNED', v1ScopeAfterReturn.status === 'RETURNED', v1ScopeAfterReturn.status);
  const timesheetAfterReturn = await prisma.timesheet.findUniqueOrThrow({ where: { id: timesheetForWorker.id } });
  check('C5b: Timesheet.status = RETURNED', timesheetAfterReturn.status === 'RETURNED', timesheetAfterReturn.status);
  const v1Unchanged = await prisma.timesheetVersion.findUniqueOrThrow({ where: { id: v1.id } });
  const v1SegmentsUnchanged = await prisma.workSegment.count({ where: { timesheetVersionId: v1.id } });
  check('C5c: V1 stays byte-identical (still versionNumber=1, same segment count)', v1Unchanged.versionNumber === 1 && v1SegmentsUnchanged === v1WorkSegments.length);
  check('C5d: return reason stored', v1ScopeAfterReturn.returnReason === returnReasonText, v1ScopeAfterReturn.returnReason);

  const returnAuditRows = await prisma.auditEvent.findMany({ where: { entityType: 'TIMESHEET_REVIEW_SCOPE', entityId: v1Scopes[0].id } });
  check('C5e: AuditEvent for the return contains no GPS/password/cookie/payloadHash/device fields', returnAuditRows.length > 0 && returnAuditRows.every(auditBlobIsClean), returnAuditRows.map((r) => ({ before: r.beforeValue, after: r.afterValue })));

  // ======================= D. WORKER — correction =======================
  await worker.goto(`${BASE}/worker/periods/${periodId}`, { waitUntil: 'networkidle' });
  const returnedPageText = await worker.locator('body').innerText();
  check('D2: worker sees the returned/reopened state and the exact ADMIN review reason', returnedPageText.includes('Open for edits again') && returnedPageText.includes(returnReasonText), returnedPageText.slice(0, 400));

  await worker.goto(`${BASE}/worker/periods/${periodId}/hours/${helsinkiToday}`, { waitUntil: 'networkidle' });
  await worker.locator('.wk-break-row input[type="time"]').nth(1).fill('13:00');
  await worker.locator('button', { hasText: 'Save' }).click();
  await waitPath(worker, new RegExp(`/hours$`), 10000);

  await worker.goto(`${BASE}/worker/periods/${periodId}/hours/${helsinkiToday}`, { waitUntil: 'networkidle' });
  const reloadedBreakEnd = await worker.locator('.wk-break-row input[type="time"]').nth(1).inputValue();
  check('D5: reload shows the corrected break end (13:00)', reloadedBreakEnd === '13:00', reloadedBreakEnd);

  const v1StillUnchangedAfterEdit = await prisma.timesheetVersion.findUniqueOrThrow({ where: { id: v1.id } });
  check('D6: V1 is not modified by editing the new draft', v1StillUnchangedAfterEdit.versionNumber === 1);

  await worker.goto(`${BASE}/worker/periods/${periodId}/submit`, { waitUntil: 'networkidle' });
  await worker.locator('.wk-action-button', { hasText: 'Submit timesheet' }).click();
  await waitPath(worker, new RegExp(`/worker/periods/${periodId}$`), 10000);

  const timesheetAfterResubmit = await prisma.timesheet.findUniqueOrThrow({ where: { id: timesheetForWorker.id } });
  check('D8a: Timesheet.status = SUBMITTED again', timesheetAfterResubmit.status === 'SUBMITTED', timesheetAfterResubmit.status);
  const v2 = await prisma.timesheetVersion.findUniqueOrThrow({ where: { id: timesheetAfterResubmit.currentVersionId! } });
  check('D8b: a NEW immutable TimesheetVersion V2 was created, V2 != V1', v2.id !== v1.id && v2.versionNumber === 2, v2);
  check('D8c: currentVersionId now points to V2', timesheetAfterResubmit.currentVersionId === v2.id);

  const v1AfterResubmitStillThere = await prisma.timesheetVersion.findUniqueOrThrow({ where: { id: v1.id } });
  const v1SegmentsAfterResubmit = await prisma.workSegment.findMany({ where: { timesheetVersionId: v1.id }, include: { breaks: true } });
  const v1WorkedMsAfterResubmit = v1SegmentsAfterResubmit.reduce((sum, seg) => {
    const gross = seg.endAt.getTime() - seg.startAt.getTime();
    const unpaid = seg.breaks.filter((b) => !b.paid).reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()), 0);
    return sum + (gross - unpaid);
  }, 0);
  check('D8d: V1 still exists and still contains 450 worked minutes (immutable)', v1AfterResubmitStillThere !== null && v1WorkedMsAfterResubmit / 60000 === 450, v1WorkedMsAfterResubmit / 60000);

  const v2WorkSegments = await prisma.workSegment.findMany({ where: { timesheetVersionId: v2.id }, include: { breaks: true } });
  const v2WorkedMs = v2WorkSegments.reduce((sum, seg) => {
    const gross = seg.endAt.getTime() - seg.startAt.getTime();
    const unpaid = seg.breaks.filter((b) => !b.paid).reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()), 0);
    return sum + (gross - unpaid);
  }, 0);
  check('D8e: V2 content = 420 worked minutes (480 gross - 60 unpaid break)', v2WorkedMs / 60000 === 420, v2WorkedMs / 60000);

  const v2Scopes = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersionId: v2.id } });
  check('D8f: a new SITE scope was created for V2, PENDING', v2Scopes.length === 1 && v2Scopes[0].scopeType === 'SITE' && v2Scopes[0].status === 'PENDING', v2Scopes);
  const v1ScopeStillReturned = await prisma.timesheetReviewScope.findUniqueOrThrow({ where: { id: v1Scopes[0].id } });
  check('D8g: the old V1 scope is not reused as current — stays RETURNED, points at V1', v1ScopeStillReturned.status === 'RETURNED' && v1ScopeStillReturned.timesheetVersionId === v1.id);

  // ======================= E. ADMIN fallback — approve =======================
  await admin2.goto(`${BASE}/admin/review-scopes`, { waitUntil: 'networkidle' });
  const v2ReviewRow = admin2.locator('tr', { hasText: `Flow ${workerLastName}` });
  await v2ReviewRow.locator('a').click();
  await waitPath(admin2, /\/admin\/review-scopes\/[0-9a-f-]+/, 10000);
  const v2ReviewText = await admin2.locator('body').innerText();
  check('E2: ADMIN fallback sees version 2 and canonical 7h in the review card', v2ReviewText.includes('version 2') && v2ReviewText.includes('7h'), v2ReviewText.slice(0, 250));

  await admin2.locator('button', { hasText: 'Approve' }).click();
  await waitPath(admin2, /\/admin\/review-scopes$/, 10000);

  const v2ScopeAfterApprove = await prisma.timesheetReviewScope.findUniqueOrThrow({ where: { id: v2Scopes[0].id } });
  check('E4a: scope = APPROVED', v2ScopeAfterApprove.status === 'APPROVED', v2ScopeAfterApprove.status);
  const timesheetAfterApprove = await prisma.timesheet.findUniqueOrThrow({ where: { id: timesheetForWorker.id } });
  check('E4b: Timesheet.status = FOREMAN_APPROVED legacy enum after ADMIN completed the sole review scope', timesheetAfterApprove.status === 'FOREMAN_APPROVED', timesheetAfterApprove.status);
  check('E4b2: reviewedByUserId records the ADMIN, proving no foreman action was required', v2ScopeAfterApprove.reviewedByUserId === (await prisma.user.findUniqueOrThrow({ where: { username: adminUsername } })).id, v2ScopeAfterApprove.reviewedByUserId);
  const v1StillImmutableAfterApprove = await prisma.timesheetVersion.count({ where: { id: v1.id } });
  const v2StillImmutableAfterApprove = await prisma.timesheetVersion.count({ where: { id: v2.id } });
  check('E4c: V1 and V2 both still exist, immutable', v1StillImmutableAfterApprove === 1 && v2StillImmutableAfterApprove === 1);

  // Repeated approve must not create a duplicate decision/AuditEvent.
  const approveAuditCountBefore = await prisma.auditEvent.count({ where: { entityId: v2Scopes[0].id } });
  const repeatApprove = await jsonFetch(`${BASE}/api/admin/review-scopes/${v2Scopes[0].id}/approve`, { method: 'POST', headers: authHeaders(await login(BASE, adminUsername, adminPassword)) });
  const approveAuditCountAfter = await prisma.auditEvent.count({ where: { entityId: v2Scopes[0].id } });
  check('E: repeated approve does not create a second AuditEvent', approveAuditCountAfter === approveAuditCountBefore, { before: approveAuditCountBefore, after: approveAuditCountAfter, repeatStatus: repeatApprove.status });

  // ======================= F. ADMIN — final approval =======================
  await admin2.goto(`${BASE}/admin/timesheets`, { waitUntil: 'networkidle' });
  const finalQueueText = await admin2.locator('body').innerText();
  check('F2: timesheet appears in the final-approval queue', finalQueueText.includes(`Flow ${workerLastName}`));
  await admin2.locator('a', { hasText: periodRow.startDate.toISOString().slice(0, 10) }).click();
  await waitPath(admin2, /\/admin\/timesheets\/[0-9a-f-]+/, 10000);
  const finalDetailText = await admin2.locator('body').innerText();
  check('F4/F5: admin sees current V2 as canonical 7h, with no blocking reasons', finalDetailText.includes('Final approve') && finalDetailText.includes('7h') && !finalDetailText.toLowerCase().includes('blocked'));

  await admin2.locator('button', { hasText: 'Final approve' }).click();
  // T12 unified review: Final approve returns to the review hub (/admin/review) rather than the
  // old /admin/timesheets queue.
  await waitPath(admin2, /\/admin\/(review|timesheets)$/, 10000);

  const timesheetAfterFinal = await prisma.timesheet.findUniqueOrThrow({ where: { id: timesheetForWorker.id } });
  check('F6a: Timesheet.status = FINAL_APPROVED', timesheetAfterFinal.status === 'FINAL_APPROVED', timesheetAfterFinal.status);
  check('F6b: currentVersionId still V2', timesheetAfterFinal.currentVersionId === v2.id);
  const versionCountAfterFinal = await prisma.timesheetVersion.count({ where: { timesheetId: timesheetForWorker.id } });
  check('F6c: final approval does not create a new version', versionCountAfterFinal === 2, versionCountAfterFinal);

  const finalApproveAudit = await prisma.auditEvent.findMany({ where: { entityId: timesheetForWorker.id, eventType: 'FINAL_APPROVED' } });
  check('F6d: exactly one FINAL_APPROVED AuditEvent', finalApproveAudit.length === 1, finalApproveAudit.length);
  check('F6e: final-approval AuditEvent has no GPS/password/cookie/payloadHash/device fields', finalApproveAudit.every(auditBlobIsClean));

  // Repeated final approval must be rejected and mutate nothing.
  const repeatFinal = await jsonFetch(`${BASE}/api/admin/timesheets/${timesheetForWorker.id}/final-approve`, { method: 'POST', headers: authHeaders(await login(BASE, adminUsername, adminPassword)) });
  const versionCountAfterRepeatFinal = await prisma.timesheetVersion.count({ where: { timesheetId: timesheetForWorker.id } });
  const finalAuditCountAfterRepeat = await prisma.auditEvent.count({ where: { entityId: timesheetForWorker.id, eventType: 'FINAL_APPROVED' } });
  check('F7: repeated final approval is rejected safely and mutates nothing', repeatFinal.status !== 200 && versionCountAfterRepeatFinal === 2 && finalAuditCountAfterRepeat === 1, repeatFinal.status);

  // ======================= G. ADMIN — reports and reconciliation =======================
  await admin2.goto(`${BASE}/admin/reports?employeeId=${workerEmployee.id}&periodId=${periodId}`, { waitUntil: 'networkidle' });
  const workerReportText = await admin2.locator('body').innerText();
  check('G1: worker report shows the correct worker/site and 420 min worked', workerReportText.includes(`${workerLastName} Flow`) && workerReportText.includes(siteName) && /7\s*h\s*0\s*min/.test(workerReportText), workerReportText.slice(0, 400));

  await admin2.goto(`${BASE}/admin/reports/sites?siteId=${siteId}&periodId=${periodId}`, { waitUntil: 'networkidle' });
  const siteReportText = await admin2.locator('body').innerText();
  check('G2: site report shows the same worker and 420 min worked', siteReportText.includes(`${workerLastName} Flow`) && /7\s*h\s*0\s*min/.test(siteReportText), siteReportText.slice(0, 500));

  await admin2.goto(`${BASE}/admin/reports/periods?periodId=${periodId}`, { waitUntil: 'networkidle' });
  const periodReportText = await admin2.locator('body').innerText();
  check('G3: period report site row + company summary show 420 min worked', /7\s*h\s*0\s*min/.test(periodReportText), periodReportText.slice(0, 400));

  await admin2.goto(`${BASE}/admin?status=FINAL_APPROVED`, { waitUntil: 'networkidle' });
  const overviewText = await admin2.locator('body').innerText();
  check('G4a: operational overview lists the worker with the Final Approved state', overviewText.includes(`Flow ${workerLastName}`) && /final approved/i.test(overviewText));
  // The T9 "Today" dashboard is an operational view of *today's recorded time* (this scenario's
  // clock shift is ~1s, so ~0 min today is correct here) — the reported/canonical period total is
  // verified by the worker/site/period reports above (G1-G3), not by this screen.
  check('G4b: the worker row carries an operational today/status cell, not a UI-recomputed total', /finished|working|not started/i.test(overviewText), overviewText.slice(overviewText.indexOf('Flow'), overviewText.indexOf('Flow') + 200));

  // API-level reconciliation — T8.1 worker total == T8.2 site worker total == T8.3 site/company total.
  const cookieAdmin = await login(BASE, adminUsername, adminPassword);
  const workerReportApi = await jsonFetch(`${BASE}/api/admin/reports/workers/${workerEmployee.id}?periodId=${periodId}`, { headers: authHeaders(cookieAdmin) });
  const siteReportApi = await jsonFetch(`${BASE}/api/admin/reports/sites/${siteId}?periodId=${periodId}`, { headers: authHeaders(cookieAdmin) });
  const periodReportApi = await jsonFetch(`${BASE}/api/admin/reports/periods/${periodId}`, { headers: authHeaders(cookieAdmin) });

  const workerTotalMinutes = workerReportApi.body?.total?.workedMinutes;
  const siteWorkerRow = (siteReportApi.body?.items ?? []).find((i: any) => i.employee?.id === workerEmployee.id);
  const siteTotalMinutes = siteReportApi.body?.summary?.workedMinutes;
  const periodSiteRow = (periodReportApi.body?.sites ?? []).find((s: any) => s.site?.id === siteId);

  check('G5a: T8.1 worker total = 420', workerTotalMinutes === 420, workerTotalMinutes);
  check('G5b: T8.2 site worker row = 420, site summary = 420', siteWorkerRow?.total?.workedMinutes === 420 && siteTotalMinutes === 420, { siteWorkerRow, siteTotalMinutes });
  check('G5c: T8.3 period site row = 420', periodSiteRow?.workedMinutes === 420, periodSiteRow);
  check('G5d: status and currentVersion consistent across every read model', workerReportApi.body?.timesheet?.status === 'FINAL_APPROVED' && workerReportApi.body?.timesheet?.versionNumber === 2, workerReportApi.body?.timesheet);

  // GET-never-writes-AuditEvent, one final pass across the report loads above.
  const auditCountBeforeReportGets = await prisma.auditEvent.count();
  await jsonFetch(`${BASE}/api/admin/reports/workers/${workerEmployee.id}?periodId=${periodId}`, { headers: authHeaders(cookieAdmin) });
  const auditCountAfterReportGets = await prisma.auditEvent.count();
  check('G6: GET report request creates zero new AuditEvent rows', auditCountAfterReportGets === auditCountBeforeReportGets);

  // ======================= Role/security spot-checks within this scenario's real data =======================
  const cookieWorker = await login(BASE, workerUser.username, workerPassword);
  const workerAdminProbe = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(cookieWorker) });
  check('SEC1: WORKER cannot reach admin API', workerAdminProbe.status === 403);
  const workerForemanProbe = await jsonFetch(`${BASE}/api/foreman/overview`, { headers: authHeaders(cookieWorker) });
  check('SEC1b: WORKER cannot reach foreman API', workerForemanProbe.status === 403);

  const cookieForeman = await login(BASE, foremanUser.username, foremanPassword);
  const foremanFinalApproveProbe = await jsonFetch(`${BASE}/api/admin/timesheets/${timesheetForWorker.id}/final-approve`, { method: 'POST', headers: authHeaders(cookieForeman) });
  check('SEC2: FOREMAN cannot perform final approval', foremanFinalApproveProbe.status === 403, foremanFinalApproveProbe);

  const foremanForeignExceptionProbe = await jsonFetch(`${BASE}/api/foreman/reports/sites/${randomUUID()}?periodId=${periodId}`, { headers: authHeaders(cookieForeman) });
  check('SEC3: FOREMAN sees the same safe response for a foreign/nonexistent site (no oracle)', foremanForeignExceptionProbe.status === 404, foremanForeignExceptionProbe);

  const malformedIdProbe = await jsonFetch(`${BASE}/api/admin/workers/not-a-uuid`, { headers: authHeaders(cookieAdmin) });
  check('SEC4: malformed UUID never produces a 500', malformedIdProbe.status !== 500, malformedIdProbe.status);

  const noSessionProbe = await jsonFetch(`${BASE}/api/admin/workers`);
  check('SEC5: no session -> 401', noSessionProbe.status === 401);

  // Self-approval structurally impossible here (foreman account has no linked Employee), but the
  // dedicated T9.3 role-matrix suite already proves the dual-role case exhaustively — not repeated.

  await adminCtx2.close();
  await foremanCtx.close();
  await workerCtx.close();
  await adminCtx.close();
  await browser.close();

  console.log(JSON.stringify({ pass, fail }));
  console.log(`\n${pass} passed, ${fail} failed (T9.4 full flow)`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
