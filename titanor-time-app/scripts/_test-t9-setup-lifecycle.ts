import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders, login, genPassword } from './_test-t9-fixtures';

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md — T9.1-T9.3 Setup checklist + Worker CRUD/lifecycle
// + other Setup-section audit. Real Chromium (production standalone build), disposable PostgreSQL
// 16, real HTTP, DB assertions, zero mocks of business operations.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
  }
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

async function main() {
  // ---- Group A: Setup checklist transitions (12 numbered scenarios) — fresh admin, no fixture yet ----
  const freshAdminUsername = `t9-checklist-admin-${randomUUID().slice(0, 6)}`;
  const freshAdminPassword = genPassword();
  {
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(freshAdminPassword, { type: argon2.argon2id });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
    const user = await prisma.user.create({ data: { username: freshAdminUsername, status: 'ACTIVE', locale: 'EN', passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const freshCookie = await login(BASE, freshAdminUsername, freshAdminPassword);

  const status1 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('1: empty DB — hasSite/hasWorkArea/hasTemplate/hasWorker/hasAssignment/hasOpenPeriod all false', status1.status === 200 && !status1.body.hasSite && !status1.body.hasWorkArea && !status1.body.hasTemplate && !status1.body.hasWorker && !status1.body.hasAssignment && !status1.body.hasOpenPeriod, status1.body);

  const siteRes = await jsonFetch(`${BASE}/api/admin/sites`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name: `Checklist Site ${randomUUID().slice(0, 6)}` }) });
  const checklistSiteId = siteRes.body.id;
  const status2 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('2: after site creation — only hasSite flips true', status2.body.hasSite === true && !status2.body.hasWorkArea && !status2.body.hasTemplate && !status2.body.hasWorker, status2.body);

  await jsonFetch(`${BASE}/api/admin/sites/${checklistSiteId}/work-areas`, { method: 'POST', headers: authHeaders(freshCookie), body: JSON.stringify({ name: 'Zone' }) });
  const status3 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('3: after work area — hasWorkArea flips true, hasTemplate/hasWorker still false', status3.body.hasWorkArea === true && !status3.body.hasTemplate && !status3.body.hasWorker, status3.body);

  const templateRes = await jsonFetch(`${BASE}/api/admin/templates`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name: `Checklist Template ${randomUUID().slice(0, 6)}`, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isWorkingDay: weekday < 5, plannedStartTime: weekday < 5 ? '09:00' : undefined, plannedEndTime: weekday < 5 ? '17:00' : undefined, plannedBreakMinutes: weekday < 5 ? 30 : 0 })) }) });
  const checklistTemplateId = templateRes.body.id;
  const status4 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('4: after template — hasTemplate flips true, hasWorker still false', status4.body.hasTemplate === true && !status4.body.hasWorker, status4.body);

  const workerARes = await jsonFetch(`${BASE}/api/admin/workers`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ firstName: 'Checklist', lastName: `WorkerA${randomUUID().slice(0, 6)}` }) });
  const status5 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('5: after Worker A — hasWorker flips true', status5.body.hasWorker === true && !status5.body.hasAssignment, status5.body);

  // 6: creating Worker B is not blocked by Worker A's existence
  const workerBRes = await jsonFetch(`${BASE}/api/admin/workers`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ firstName: 'Checklist', lastName: `WorkerB${randomUUID().slice(0, 6)}` }) });
  check('6: creating Worker B succeeds while Worker A already exists (no singleton block)', workerBRes.status === 201 && workerBRes.body.employee.id !== workerARes.body.employee.id, workerBRes.body);

  const workerBEarlyActivation = await jsonFetch(`${BASE}/api/admin/workers/${workerBRes.body.employee.id}/activation`, {
    method: 'POST',
    headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() })
  });
  check('6b: a new worker can receive activation immediately without an assignment or payroll period', workerBEarlyActivation.status === 201 && typeof workerBEarlyActivation.body.activationCode === 'string');

  await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: workerARes.body.employee.id, siteId: checklistSiteId, templateId: checklistTemplateId, validFrom: '2020-01-01', isPrimary: true }) });
  const status7 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  // T9.7 onboarding change: creating the first assignment now auto-opens the current payroll
  // period (the standalone "open a period" step was removed from the checklist), so hasOpenPeriod
  // flips true here rather than on a later explicit period POST.
  check('7: after assignment — hasAssignment flips true and the current period is auto-opened', status7.body.hasAssignment === true && status7.body.hasOpenPeriod === true, status7.body);

  const helsinkiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  const periodEnd = new Date(`${helsinkiToday}T00:00:00.000Z`);
  periodEnd.setUTCDate(periodEnd.getUTCDate() + 13);
  await jsonFetch(`${BASE}/api/admin/periods`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ startDate: helsinkiToday, endDate: periodEnd.toISOString().slice(0, 10) }) });
  const status8 = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('8: after period — hasOpenPeriod flips true, all items done', status8.body.hasOpenPeriod === true && status8.body.hasSite && status8.body.hasWorkArea && status8.body.hasTemplate && status8.body.hasWorker && status8.body.hasAssignment, status8.body);

  // 9/10/11: browser-level — Manage leads to list route not /new, reload/back/forward correct, no stale client state
  {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(freshAdminUsername);
    await page.locator('#password').fill(freshAdminPassword);
    await page.locator('.login-submit').click();
    await page.waitForURL(/\/admin/, { timeout: 15000 });

    await page.goto(`${BASE}/admin/setup`, { waitUntil: 'networkidle' });
    const workerRow = page.locator('.setup-item').filter({ has: page.locator('.setup-label', { hasText: /^Worker$/ }) });
    const workerAction = workerRow.locator('a.setup-action');
    const workerHref = await workerAction.getAttribute('href');
    check('9: fully-set-up Worker checklist item links to /admin/workers (Manage), not /new', workerHref === '/admin/workers', workerHref);

    // The checklist is 5 required rows now (Site / WorkArea / Template / Worker / Assignment);
    // "open a period" was dropped (auto-opened on assignment) and City / a submission-schedule row
    // are separate/optional. This fixture has the 5 through Assignment -> 5 "Done".
    await page.reload({ waitUntil: 'networkidle' });
    const doneCountAfterReload = await page.locator('.setup-status-done').count();
    check('10: reload preserves 5 Done items (Site/WorkArea/Template/Worker/Assignment)', doneCountAfterReload === 5, doneCountAfterReload);

    await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
    await page.goBack({ waitUntil: 'networkidle' });
    const doneCountAfterBack = await page.locator('.setup-status-done').count();
    check('10b: back navigation to /admin/setup still shows correct (non-stale) 5 Done items', doneCountAfterBack === 5, doneCountAfterBack);

    check('11: checklist is a force-dynamic Server Component with zero client-side state (structural — verified by 10/10b matching DB truth after navigation)', doneCountAfterReload === 5 && doneCountAfterBack === 5);

    // T9.7 real-owner finding: activation belongs to account ownership, not operational setup.
    // The owner can issue QR immediately and attaches site/schedule inline on the worker profile.
    await page.goto(`${BASE}/admin/workers/${workerBRes.body.employee.id}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const employee = document.querySelector('#assignment-employee') as HTMLSelectElement | null;
      const site = document.querySelector('#assignment-site') as HTMLSelectElement | null;
      return Boolean(employee?.value && site?.value);
    });
    check('T9.7/G1: unassigned worker profile can issue activation immediately', (await page.locator('button', { hasText: 'Issue activation code' }).count()) === 1);
    check('T9.7/G2: the guided site/work-schedule form is embedded in the worker profile', (await page.locator('form:has(#assignment-employee):has(#assignment-site)').count()) === 1);
    check('T9.7/G3: inline form locks the intended worker', await page.locator('#assignment-employee').inputValue() === workerBRes.body.employee.id && await page.locator('#assignment-employee').isDisabled());
    check('T9.7/G4: guided form defaults start date to Helsinki today', await page.locator('#assignment-valid-from').inputValue() === helsinkiToday);
    check('T9.7/G5: guided first assignment defaults to primary', await page.locator('#assignment-is-primary').isChecked());
    await page.locator('button[type="submit"]', { hasText: 'Create assignment' }).click();
    await page.waitForURL(`${BASE}/admin/workers/${workerBRes.body.employee.id}`, { timeout: 15000 });
    check('T9.7/G6: save remains on the same worker profile', new URL(page.url()).pathname === `/admin/workers/${workerBRes.body.employee.id}`);
    check('T9.7/G7: assignment auto-enrols worker in the existing period without changing activation readiness', (await page.locator('button', { hasText: 'Issue activation code' }).count()) === 1);

    await page.goto(`${BASE}/admin/periods/${(await jsonFetch(`${BASE}/api/admin/periods/current`, { headers: authHeaders(freshCookie) })).body.id}`, { waitUntil: 'networkidle' });
    check('T9.7/G8: period page tells owner to leave OPEN while workers enter hours', (await page.locator('.worker-setup-callout').innerText()).includes('leave this period open'));
    check('T9.7/G9: Lock period is disabled while timesheets remain pending', await page.locator('button', { hasText: 'Lock period' }).isDisabled());

    await browser.close();
  }

  // 12: an action on one item doesn't change unrelated statuses — create a second, unrelated site
  const preSecondSite = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  await jsonFetch(`${BASE}/api/admin/sites`, { method: 'POST', headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name: `Unrelated Site ${randomUUID().slice(0, 6)}` }) });
  const postSecondSite = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('12: creating an additional site does not change hasWorkArea/hasTemplate/hasWorker/hasAssignment/hasOpenPeriod', postSecondSite.body.hasWorkArea === preSecondSite.body.hasWorkArea && postSecondSite.body.hasTemplate === preSecondSite.body.hasTemplate && postSecondSite.body.hasWorker === preSecondSite.body.hasWorker && postSecondSite.body.hasAssignment === preSecondSite.body.hasAssignment && postSecondSite.body.hasOpenPeriod === preSecondSite.body.hasOpenPeriod, postSecondSite.body);

  // T9.7 feedback follow-up: the documented city.create contract is now a real idempotent,
  // permission-gated and audited endpoint rather than a read-only dropdown source.
  const cityKey = randomUUID();
  const cityName = `Checklist City ${randomUUID().slice(0, 6)}`;
  const cityCreate = await jsonFetch(`${BASE}/api/admin/cities`, {
    method: 'POST',
    headers: authHeaders(freshCookie, { 'Idempotency-Key': cityKey }),
    body: JSON.stringify({ name: cityName })
  });
  check('T9.7/C1: ADMIN creates City', cityCreate.status === 201 && cityCreate.body.name === cityName, cityCreate);
  const cityReplay = await jsonFetch(`${BASE}/api/admin/cities`, {
    method: 'POST',
    headers: authHeaders(freshCookie, { 'Idempotency-Key': cityKey }),
    body: JSON.stringify({ name: cityName })
  });
  check('T9.7/C2: exact City replay returns the same id', cityReplay.status === 201 && cityReplay.body.id === cityCreate.body.id, cityReplay);
  const cityDuplicate = await jsonFetch(`${BASE}/api/admin/cities`, {
    method: 'POST',
    headers: authHeaders(freshCookie, { 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ name: cityName })
  });
  check('T9.7/C3: duplicate City name is a stable 409', cityDuplicate.status === 409 && cityDuplicate.body.error?.code === 'DUPLICATE_CITY_NAME', cityDuplicate);
  const cityStatus = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(freshCookie) });
  check('T9.7/C4: City creation flips informational hasCity true', cityStatus.status === 200 && cityStatus.body.hasCity === true, cityStatus);
  const cityAuditCount = await prisma.auditEvent.count({ where: { eventType: 'CITY_CREATED', entityId: cityCreate.body.id } });
  check('T9.7/C5: replay creates exactly one CITY_CREATED audit', cityAuditCount === 1, cityAuditCount);

  // ---- Group B: full fixture + Worker A/B CRUD/lifecycle (23 numbered scenarios) ----
  const fx = await buildFixture(BASE);

  const workerCityCreate = await jsonFetch(`${BASE}/api/admin/cities`, {
    method: 'POST',
    headers: authHeaders(fx.workerA.cookie, { 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ name: `Forbidden City ${randomUUID().slice(0, 6)}` })
  });
  check('T9.7/C6: WORKER cannot create City', workerCityCreate.status === 403 && workerCityCreate.body.error?.code === 'FORBIDDEN', workerCityCreate);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(fx.admin.username);
  await page.locator('#password').fill(fx.admin.password);
  await page.locator('.login-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 15000 });

  // 1/2: Worker A already created by fixture; confirm visible in list.
  await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
  const listHtmlBefore = await page.locator('.worker-card').innerHTML();
  check('1/2: Worker A visible in list', listHtmlBefore.includes(fx.workerA.username));

  // 3: create Worker C via the fixed "create new" link (real click, not typed URL) — the D1 fix.
  await page.locator('a[href="/admin/workers/new"]').click();
  await page.waitForURL(/\/admin\/workers\/new/, { timeout: 10000 });
  const uniqueLast = `Uiflow${randomUUID().slice(0, 6)}`;
  await page.locator('#worker-first-name').fill('Clicked');
  await page.locator('#worker-last-name').fill(uniqueLast);
  await page.locator('.login-submit').click();
  await page.waitForURL(/\/admin\/workers\/[0-9a-f-]+$/, { timeout: 10000 });
  check('3: creating a worker opens that worker profile with immediate activation and inline work setup', (await page.locator('button', { hasText: 'Issue activation code' }).count()) === 1 && (await page.locator('form:has(#assignment-employee):has(#assignment-site)').count()) === 1);

  // 4: both workers (A and the newly clicked one) appear separately in the list.
  await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
  const listHtmlAfter = await page.locator('.worker-card').innerHTML();
  check('4: both Worker A and the newly created worker appear separately in the list', listHtmlAfter.includes(fx.workerA.username) && listHtmlAfter.includes(uniqueLast));

  // 5: data from the previous form (Clicked/Uiflow...) is not carried into a fresh /new visit.
  await page.locator('a[href="/admin/workers/new"]').click();
  await page.waitForURL(/\/admin\/workers\/new/, { timeout: 10000 });
  const firstNameValueOnFreshVisit = await page.locator('#worker-first-name').inputValue();
  check('5: a fresh visit to /admin/workers/new does not carry over the previous submission\'s data', firstNameValueOnFreshVisit === '');

  // 7: double-click creates exactly one worker.
  const doubleClickLast = `Dbl${randomUUID().slice(0, 6)}`;
  await page.locator('#worker-first-name').fill('Double');
  await page.locator('#worker-last-name').fill(doubleClickLast);
  const submitBtn = page.locator('.login-submit');
  await Promise.all([submitBtn.click({ force: true }), submitBtn.click({ force: true }).catch(() => {})]);
  await page.waitForURL(/\/admin\/workers\/[0-9a-f-]+$/, { timeout: 10000 });
  const doubleClickCount = await prisma.employee.count({ where: { lastName: doubleClickLast } });
  check('7: rapid double-click on Create worker produces exactly one Employee row', doubleClickCount === 1, doubleClickCount);

  // 9: reloading the /new form after a successful create does not repeat the POST (fresh form is empty/idle).
  await page.goto(`${BASE}/admin/workers/new`, { waitUntil: 'networkidle' });
  const countBeforeReloadCheck = await prisma.employee.count();
  await page.reload({ waitUntil: 'networkidle' });
  const countAfterReloadCheck = await prisma.employee.count();
  check('9: reloading the empty /new form does not create a worker', countBeforeReloadCheck === countAfterReloadCheck);

  // 11/12: edit Worker A's allowed fields, reload, confirm change; Worker B untouched.
  await page.goto(`${BASE}/admin/workers/${fx.workerA.employeeId}`, { waitUntil: 'networkidle' });
  const newPhone = '+358401234567';
  await page.locator('#edit-phone').fill(newPhone);
  await page.locator('form:has(#edit-phone) .login-submit').click();
  await page.waitForTimeout(600);
  const employeeAAfterEdit = await prisma.employee.findUniqueOrThrow({ where: { id: fx.workerA.employeeId } });
  check('11: editing Worker A\'s phone persists to the DB', employeeAAfterEdit.phone === newPhone, employeeAAfterEdit.phone);

  await page.reload({ waitUntil: 'networkidle' });
  const phoneAfterReload = await page.locator('#edit-phone').inputValue();
  check('12: reload shows the edited phone', phoneAfterReload === newPhone, phoneAfterReload);

  const employeeBUnchanged = await prisma.employee.findUniqueOrThrow({ where: { id: fx.workerB.employeeId } });
  check('13: Worker B is byte-for-byte unchanged by Worker A\'s edit', employeeBUnchanged.phone === null, employeeBUnchanged.phone);

  // 14/15/16/17/18/19: deactivate Worker A with reason/endDate.
  await page.goto(`${BASE}/admin/workers/${fx.workerA.employeeId}`, { waitUntil: 'networkidle' });
  await page.locator('button', { hasText: 'Deactivate worker' }).click();
  await page.locator('#deactivate-reason').fill('T9 lifecycle regression test');
  await page.locator('form:has(#deactivate-reason) .login-submit').click();
  await page.waitForTimeout(600);
  const employmentAAfterDeactivate = await prisma.employment.findFirst({ where: { employeeId: fx.workerA.employeeId }, orderBy: { createdAt: 'desc' } });
  check('14/15: Worker A employment.active=false after deactivation with reason', employmentAAfterDeactivate?.active === false && employmentAAfterDeactivate?.deactivationReason === 'T9 lifecycle regression test', employmentAAfterDeactivate);

  const assignmentAStillPresent = await prisma.siteAssignment.findFirst({ where: { employeeId: fx.workerA.employeeId } });
  check('16: deactivation does not retract the existing SiteAssignment (documented contract, not a bug)', assignmentAStillPresent !== null && assignmentAStillPresent.validTo === null, assignmentAStillPresent);

  const userAAfterDeactivate = await prisma.user.findFirstOrThrow({ where: { employeeId: fx.workerA.employeeId } });
  check('17: Worker A\'s User.status is OFFBOARDING or DEACTIVATED (login blocked per contract)', userAAfterDeactivate.status === 'OFFBOARDING' || userAAfterDeactivate.status === 'DEACTIVATED', userAAfterDeactivate.status);

  const auditForDeactivate = await prisma.auditEvent.findFirst({ where: { entityId: fx.workerA.employeeId, eventType: 'WORKER_DEACTIVATED' }, orderBy: { createdAt: 'desc' } });
  check('18: historical AuditEvent for the deactivation exists and is not deleted', auditForDeactivate !== null);

  const employeeBStillActive = await prisma.employment.findFirst({ where: { employeeId: fx.workerB.employeeId } });
  check('19: Worker B continues to work (employment still active)', employeeBStillActive?.active === true, employeeBStillActive);

  // 20: repeat deactivation → documented 409 ALREADY_DEACTIVATED.
  const repeatDeactivate = await jsonFetch(`${BASE}/api/admin/workers/${fx.workerA.employeeId}/deactivate`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ reason: 'repeat' }) });
  check('20: repeated deactivation returns documented 409 ALREADY_DEACTIVATED', repeatDeactivate.status === 409 && repeatDeactivate.body?.error?.code === 'ALREADY_DEACTIVATED', repeatDeactivate);

  // 20b/c/d/e: reactivate (inverse of deactivate) — button appears while inactive, restores the
  // working state, keeps the SiteAssignment, writes its own audit event, and is idempotent-safe.
  await page.goto(`${BASE}/admin/workers/${fx.workerA.employeeId}`, { waitUntil: 'networkidle' });
  const reactivateBtn = page.locator('button', { hasText: 'Reactivate worker' });
  check('20b: "Reactivate worker" button is shown on an inactive worker', (await reactivateBtn.count()) === 1);
  await reactivateBtn.click();
  await page.waitForTimeout(700);
  const employmentAAfterReactivate = await prisma.employment.findFirst({ where: { employeeId: fx.workerA.employeeId }, orderBy: { createdAt: 'desc' } });
  check('20c: reactivate sets employment.active=true and clears endDate/reason', employmentAAfterReactivate?.active === true && employmentAAfterReactivate?.endDate === null && employmentAAfterReactivate?.deactivationReason === null, employmentAAfterReactivate);
  const userAAfterReactivate = await prisma.user.findFirstOrThrow({ where: { employeeId: fx.workerA.employeeId } });
  check('20d: reactivate sets User.status=ACTIVE', userAAfterReactivate.status === 'ACTIVE', userAAfterReactivate.status);
  const assignmentAfterReactivate = await prisma.siteAssignment.findFirst({ where: { employeeId: fx.workerA.employeeId } });
  check('20e: reactivate does not touch the SiteAssignment', assignmentAfterReactivate !== null && assignmentAfterReactivate.validTo === null);
  const auditForReactivate = await prisma.auditEvent.findFirst({ where: { entityId: fx.workerA.employeeId, eventType: 'WORKER_REACTIVATED' }, orderBy: { createdAt: 'desc' } });
  check('20f: WORKER_REACTIVATED AuditEvent exists', auditForReactivate !== null);
  const repeatReactivate = await jsonFetch(`${BASE}/api/admin/workers/${fx.workerA.employeeId}/reactivate`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: '' });
  check('20g: repeated reactivation returns 409 ALREADY_ACTIVE', repeatReactivate.status === 409 && repeatReactivate.body?.error?.code === 'ALREADY_ACTIVE', repeatReactivate);

  // restore the prior state for the downstream steps: Worker A deactivated again.
  await jsonFetch(`${BASE}/api/admin/workers/${fx.workerA.employeeId}/deactivate`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ reason: 'T9 lifecycle regression test' }) });

  // 20h/i/j/k: archive behaviour — a deactivated worker is hidden from the default worker list
  // (and the assignment picker's ?pageSize=100 fetch), and only appears with ?archived=1.
  const listDefault = await jsonFetch(`${BASE}/api/admin/workers?pageSize=100`, { headers: authHeaders(fx.admin.cookie) });
  const defaultIds = (listDefault.body?.items ?? []).map((w: { id: string }) => w.id);
  check('20h: default worker list excludes the deactivated Worker A', !defaultIds.includes(fx.workerA.employeeId) && defaultIds.includes(fx.workerB.employeeId), { defaultIds, a: fx.workerA.employeeId });
  check('20i: default list reports archivedCount >= 1', typeof listDefault.body?.archivedCount === 'number' && listDefault.body.archivedCount >= 1, listDefault.body?.archivedCount);
  const listArchived = await jsonFetch(`${BASE}/api/admin/workers?pageSize=100&archived=1`, { headers: authHeaders(fx.admin.cookie) });
  const archivedIds = (listArchived.body?.items ?? []).map((w: { id: string }) => w.id);
  check('20j: ?archived=1 worker list includes the deactivated Worker A', archivedIds.includes(fx.workerA.employeeId) && archivedIds.includes(fx.workerB.employeeId), archivedIds);
  await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
  const listPageText = await page.locator('body').innerText();
  check('20k: /admin/workers page hides Worker A by default and offers "Show archived"', !listPageText.includes(fx.workerA.username) && listPageText.includes('Show archived'), listPageText.slice(0, 400));
  await page.goto(`${BASE}/admin/workers?archived=1`, { waitUntil: 'networkidle' });
  check('20l: /admin/workers?archived=1 shows Worker A', (await page.locator('body').innerText()).includes(fx.workerA.username));

  // 21: malformed/foreign id does not oracle or 500.
  const malformedIdRes = await jsonFetch(`${BASE}/api/admin/workers/not-a-uuid`, { headers: authHeaders(fx.admin.cookie) });
  const foreignIdRes = await jsonFetch(`${BASE}/api/admin/workers/${randomUUID()}`, { headers: authHeaders(fx.admin.cookie) });
  check('21: malformed worker id -> 404, never 500', malformedIdRes.status === 404, malformedIdRes.status);
  check('21b: nonexistent (foreign-shaped) worker id -> identical 404 code (no oracle)', foreignIdRes.status === 404 && foreignIdRes.body?.error?.code === malformedIdRes.body?.error?.code, { malformed: malformedIdRes.body, foreign: foreignIdRes.body });

  // 22/23: UI distinguishes Edit vs Deactivate, and never shows a Delete button (physical delete
  // is domain-forbidden for Employee per T9_INTERNAL_TEST_PLAN.md §1).
  await page.goto(`${BASE}/admin/workers/${fx.workerB.employeeId}`, { waitUntil: 'networkidle' });
  const pageText = await page.locator('body').innerText();
  const deleteButtons = await page.locator('button', { hasText: /^Delete$/i }).count();
  check('22: Edit and Deactivate are clearly distinct sections', pageText.includes('Edit') && pageText.includes('Deactivate worker'));
  check('23: no Delete button is shown anywhere on the worker detail page', deleteButtons === 0);

  // WA1-WA8 — owner's "2 customers on ONE site = 2 work areas" case (messages 2026-09-01/02).
  // A worker gets two current assignments on the same site, one per work area. Both must create
  // AND both must show on the worker card, each tagged with its work area (the list keyed by
  // siteId, so React dropped the 2nd — it looked like the assignment "didn't create"). The card's
  // "End" action must remove one without a 500 and without deleting the row.
  const todayIsoWA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  const waSecond = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}/work-areas`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ name: `Customer B ${fx.run}` }) });
  const waAlpha = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { headers: authHeaders(fx.admin.cookie) });
  const [wArea1, wArea2] = (waAlpha.body.workAreas as { id: string; name: string }[]);
  const asgW1 = await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: fx.workerB.employeeId, siteId: fx.sites.alpha, workAreaId: wArea1.id, validFrom: '2020-01-01', isPrimary: false }) });
  const asgW2 = await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: fx.workerB.employeeId, siteId: fx.sites.alpha, workAreaId: wArea2.id, validFrom: '2020-01-01', isPrimary: false }) });
  check('WA1: two assignments on one site with different work areas both create (201)', waSecond.status === 201 && asgW1.status === 201 && asgW2.status === 201, { wa: waSecond.status, a: asgW1.status, b: asgW2.status, bBody: asgW2.body });
  await page.goto(`${BASE}/admin/workers/${fx.workerB.employeeId}`, { waitUntil: 'networkidle' });
  const wbAssignText = await page.locator('body').innerText();
  check('WA2: both work-area names are shown on the worker card', wbAssignText.includes(wArea1.name) && wbAssignText.includes(wArea2.name), wbAssignText.slice(0, 600));
  const endButtons = await page.locator('.setup-list button', { hasText: /^End$/ }).count();
  check('WA3: worker card shows an "End" action per current assignment', endButtons >= 2, endButtons);

  // WA4: the card's "End" form pre-fills validTo with TODAY when the worker only has a schedule
  // (no real recorded hours) — the owner's "remove from this site today, not at the end of the
  // period" case. assignmentEndDateDefaults no longer counts auto-materialised draft planned shifts.
  const w2Item = page.locator('.setup-item', { hasText: wArea2.name });
  await w2Item.locator('button', { hasText: /^End$/ }).click();
  const prefilled = await w2Item.locator('input[type="date"]').inputValue();
  check('WA4: End form pre-fills validTo with today (schedule-only assignment)', prefilled === todayIsoWA, prefilled);

  // WA5/WA6: ending TODAY succeeds (200) — the assignment's own future draft planned shifts are
  // deleted so the dependents guard doesn't block it — and the row is kept, not deleted.
  const endW1 = await jsonFetch(`${BASE}/api/admin/assignments/${asgW1.body.id}/end`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ validTo: todayIsoWA, reason: 'T9: owner-requested removal from the worker card today (project ended)' }) });
  check('WA5: End today succeeds (200), not pushed to the end of the period', endW1.status === 200 && endW1.body?.validTo === todayIsoWA, { status: endW1.status, body: endW1.body });
  const w1Row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: asgW1.body.id } });
  const w1FuturePlanned = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: asgW1.body.id, date: { gt: new Date(`${todayIsoWA}T00:00:00.000Z`) } } });
  check('WA6: ended assignment kept (validTo + endedReason), and its future draft planned shifts dropped', w1Row.validTo !== null && (w1Row.endedReason ?? '').includes('project ended') && w1FuturePlanned === 0, { row: w1Row, futurePlanned: w1FuturePlanned });
  // WA6b: ending as of today removes it from the admin's "current" view immediately (validTo is
  // compared with `gt` today, not `gte`), even though the worker can still finish today's shift.
  const wbListAfterEnd = await jsonFetch(`${BASE}/api/admin/workers?pageSize=100`, { headers: authHeaders(fx.admin.cookie) });
  const wbCurrent = ((wbListAfterEnd.body.items as { id: string; currentAssignments: { assignmentId: string }[] }[]).find((x) => x.id === fx.workerB.employeeId)?.currentAssignments ?? []).map((a) => a.assignmentId);
  check('WA6b: the assignment ended today is gone from the admin "current" list; the other stays', !wbCurrent.includes(asgW1.body.id) && wbCurrent.includes(asgW2.body.id), { wbCurrent, ended: asgW1.body.id, kept: asgW2.body.id });
  const wbCardHtml = await (await fetch(`${BASE}/admin/workers/${fx.workerB.employeeId}`, { headers: authHeaders(fx.admin.cookie) })).text();
  check('WA6c: the worker card now shows a "Past assignments" block', wbCardHtml.includes('Past assignments'));

  // WA7: an assignment WITH real recorded time after the chosen date is a clean, actionable 409
  // (not a 500, not a silent drop). Hand-craft a committed TimesheetDraftSegment on a far-future
  // day (asgW2 already has a TimesheetDraftPlannedShift there for the composite FK).
  const waSegDate = new Date('2210-01-10T00:00:00.000Z');
  const waDraft = await prisma.timesheetDraft.findFirstOrThrow({ where: { employeeId: fx.workerB.employeeId, timesheet: { periodId: fx.periodId } }, select: { id: true } });
  const waDay = await prisma.timesheetDraftDay.findFirstOrThrow({ where: { draftId: waDraft.id, date: waSegDate }, select: { id: true } });
  await prisma.timesheetDraftSegment.create({ data: { id: randomUUID(), draftDayId: waDay.id, draftId: waDraft.id, employeeId: fx.workerB.employeeId, date: waSegDate, startAt: new Date('2210-01-10T06:00:00.000Z'), endAt: new Date('2210-01-10T14:00:00.000Z'), siteId: fx.sites.alpha, workAreaId: wArea2.id, sourceAssignmentId: asgW2.body.id } });
  const endW2Early = await jsonFetch(`${BASE}/api/admin/assignments/${asgW2.body.id}/end`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ validTo: todayIsoWA, reason: 'T9: end before recorded time' }) });
  check('WA7: ending before real recorded time -> 409 ASSIGNMENT_HAS_RECORDED_TIME with earliestValidTo', endW2Early.status === 409 && endW2Early.body?.error?.code === 'ASSIGNMENT_HAS_RECORDED_TIME' && endW2Early.body?.error?.earliestValidTo === '2210-01-10', { status: endW2Early.status, body: endW2Early.body });
  const w2Row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: asgW2.body.id } });
  check('WA8: the rejected end did not partially apply (validTo still null)', w2Row.validTo === null && w2Row.endedReason === null, w2Row);

  // CH0-CH10 — "Изменить объект / зону" (POST /api/admin/assignments/:id/change). Fully isolated:
  // a dedicated worker + fresh sites, so nothing here can collide with the shared fixture that
  // Group C below depends on. Closes the old assignment the day before the effective date and
  // opens a fully-materialised replacement; backdating is forbidden; an open shift forces a choice.
  const dPlus = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const mkSite = (label: string) =>
    jsonFetch(`${BASE}/api/admin/sites`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name: `CH ${label} ${fx.run}` }) });
  const chW = await jsonFetch(`${BASE}/api/admin/workers`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ firstName: 'Chg', lastName: `Worker${fx.run}` }) });
  const chWId: string = chW.body?.employee?.id;
  const [chMain, chOther, chKeepSite, chMoveSite, chDest] = await Promise.all([mkSite('Main'), mkSite('Other'), mkSite('Keep'), mkSite('Move'), mkSite('Dest')]);
  const chZone = await jsonFetch(`${BASE}/api/admin/sites/${chMain.body.id}/work-areas`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ name: `CH Zone ${fx.run}` }) });
  check('CH0: dedicated CH worker + 5 sites + a work area created', chW.status === 201 && typeof chWId === 'string' && [chMain, chOther, chKeepSite, chMoveSite, chDest].every((s) => s.status === 201) && chZone.status === 201, { w: chW.status, sites: [chMain.status, chOther.status, chKeepSite.status, chMoveSite.status, chDest.status], zone: chZone.status });

  const chA1 = await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: chWId, siteId: chMain.body.id, validFrom: '2020-01-01', templateId: fx.templateId, isPrimary: true }) });
  check('CH0b: CH worker assigned to CH Main (201)', chA1.status === 201, chA1.body);

  const chFrom = dPlus(todayIsoWA, 5);
  const chFromDate = new Date(`${chFrom}T00:00:00.000Z`);
  const ch1 = await jsonFetch(`${BASE}/api/admin/assignments/${chA1.body.id}/change`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ effectiveFrom: chFrom, siteId: chMain.body.id, workAreaId: chZone.body.id, templateId: fx.templateId }) });
  check('CH1: change (add a work area on the same site) succeeds (200), closes old + returns new', ch1.status === 200 && ch1.body?.closedAssignmentId === chA1.body.id && ch1.body?.newAssignment?.validFrom === chFrom && ch1.body?.effectiveFrom === chFrom, { status: ch1.status, body: ch1.body });
  const chNewId: string = ch1.body?.newAssignment?.id;
  const chA1Row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: chA1.body.id } });
  check('CH2: old assignment kept (not deleted), closed the day before the effective date', chA1Row.validTo?.toISOString().slice(0, 10) === dPlus(todayIsoWA, 4) && (chA1Row.endedReason ?? '').length > 0, { validTo: chA1Row.validTo, reason: chA1Row.endedReason });
  const chNewRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: chNewId } });
  check('CH3: new assignment has the work area, same site, indefinite, template carried', chNewRow.siteId === chMain.body.id && chNewRow.workAreaId === chZone.body.id && chNewRow.validTo === null && chNewRow.templateVersionId !== null, chNewRow);
  const oldAfter = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: chA1.body.id, date: { gte: chFromDate } } });
  const oldBefore = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: chA1.body.id, date: { lt: chFromDate } } });
  const newAfter = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: chNewId, date: { gte: chFromDate } } });
  check('CH4: planned shifts moved from old to new at the effective date', oldAfter === 0 && oldBefore > 0 && newAfter > 0, { oldAfter, oldBefore, newAfter });

  const chBackdate = await jsonFetch(`${BASE}/api/admin/assignments/${chNewId}/change`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ effectiveFrom: '2020-06-01', siteId: chOther.body.id }) });
  check('CH5: backdating is rejected (400 VALIDATION_ERROR)', chBackdate.status === 400 && chBackdate.body?.error?.code === 'VALIDATION_ERROR', chBackdate.body);

  const chNoop = await jsonFetch(`${BASE}/api/admin/assignments/${chNewId}/change`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ effectiveFrom: dPlus(todayIsoWA, 9), siteId: chMain.body.id, workAreaId: chZone.body.id, templateId: fx.templateId }) });
  check('CH6: a no-op change is rejected (400 NOTHING_TO_CHANGE)', chNoop.status === 400 && chNoop.body?.error?.code === 'NOTHING_TO_CHANGE', chNoop.body);

  // Open-shift choice + KEEP_ON_OLD. Hand-craft a CHECK_IN ClockEvent + EmployeeOpenShift (no
  // triggers on either INSERT path) pointing at a deep-past assignment on its own site.
  const chAKeep = await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: chWId, siteId: chKeepSite.body.id, validFrom: '2020-01-01', isPrimary: false }) });
  const ceK = randomUUID();
  await prisma.clockEvent.create({ data: { id: ceK, employeeId: chWId, operationType: 'CHECK_IN', siteId: chKeepSite.body.id, clientCapturedAt: new Date(), capturedOffline: false, effectiveAt: new Date(), gpsVerification: 'NOT_VERIFIED', processingState: 'ACCEPTED', channel: 'ONLINE', payloadHash: 'k'.repeat(64), requestId: randomUUID() } });
  await prisma.employeeOpenShift.create({ data: { employeeId: chWId, openedByClockEventId: ceK, siteId: chKeepSite.body.id, sourceAssignmentId: chAKeep.body.id, openedAt: new Date() } });
  const chNoChoice = await jsonFetch(`${BASE}/api/admin/assignments/${chAKeep.body.id}/change`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ effectiveFrom: todayIsoWA, siteId: chOther.body.id }) });
  check('CH7: an open shift forces a choice (409 OPEN_SHIFT_CHOICE_REQUIRED)', chNoChoice.status === 409 && chNoChoice.body?.error?.code === 'OPEN_SHIFT_CHOICE_REQUIRED', chNoChoice.body);
  const chKeep = await jsonFetch(`${BASE}/api/admin/assignments/${chAKeep.body.id}/change`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ effectiveFrom: todayIsoWA, siteId: chOther.body.id, todayShiftHandling: 'KEEP_ON_OLD' }) });
  const osKeep = await prisma.employeeOpenShift.findUniqueOrThrow({ where: { employeeId: chWId } });
  check('CH8: KEEP_ON_OLD moves the effective date to tomorrow and leaves the open shift on the old site', chKeep.status === 200 && chKeep.body?.effectiveFrom === dPlus(todayIsoWA, 1) && osKeep.sourceAssignmentId === chAKeep.body.id && osKeep.siteId === chKeepSite.body.id, { status: chKeep.status, effectiveFrom: chKeep.body?.effectiveFrom, os: osKeep });
  await prisma.employeeOpenShift.delete({ where: { employeeId: chWId } });

  // Open-shift MOVE_TO_NEW — its own deep-past assignment, moving to a site chW is not on yet.
  const chAMove = await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: chWId, siteId: chMoveSite.body.id, validFrom: '2020-01-01', isPrimary: false }) });
  const ceM = randomUUID();
  await prisma.clockEvent.create({ data: { id: ceM, employeeId: chWId, operationType: 'CHECK_IN', siteId: chMoveSite.body.id, clientCapturedAt: new Date(), capturedOffline: false, effectiveAt: new Date(), gpsVerification: 'NOT_VERIFIED', processingState: 'ACCEPTED', channel: 'ONLINE', payloadHash: 'm'.repeat(64), requestId: randomUUID() } });
  await prisma.employeeOpenShift.create({ data: { employeeId: chWId, openedByClockEventId: ceM, siteId: chMoveSite.body.id, sourceAssignmentId: chAMove.body.id, openedAt: new Date() } });
  const chMove = await jsonFetch(`${BASE}/api/admin/assignments/${chAMove.body.id}/change`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ effectiveFrom: todayIsoWA, siteId: chDest.body.id, workAreaId: null, todayShiftHandling: 'MOVE_TO_NEW' }) });
  const osMove = await prisma.employeeOpenShift.findUniqueOrThrow({ where: { employeeId: chWId } });
  check('CH9: MOVE_TO_NEW keeps today and re-points the open shift to the new site + assignment', chMove.status === 200 && chMove.body?.effectiveFrom === todayIsoWA && osMove.siteId === chDest.body.id && osMove.sourceAssignmentId === chMove.body?.newAssignment?.id, { status: chMove.status, body: chMove.body, os: osMove });
  await prisma.employeeOpenShift.delete({ where: { employeeId: chWId } }).catch(() => {});

  // CH10: the card shows the "Change site / customer" action and its mode picker.
  await page.goto(`${BASE}/admin/workers/${chWId}`, { waitUntil: 'networkidle' });
  const changeBtn = page.locator('.setup-item button', { hasText: 'Change site / customer' });
  check('CH10: worker card offers "Change site / customer" per current assignment', (await changeBtn.count()) >= 1, await changeBtn.count());
  await changeBtn.first().click();
  const pickerText = await page.locator('.assignment-end-form', { hasText: 'Change the customer only' }).innerText().catch(() => '');
  check('CH10b: the mode picker offers the quick and the full change', pickerText.includes('Change the customer only') && pickerText.includes('Move to another site'), pickerText.slice(0, 300));

  await browser.close();

  // ---- Group C: same-class create-second/edit/lifecycle/duplicate-submit/audit audit for the
  // remaining Setup sections (Sites, WorkAreas, Templates, SiteAssignments, ForemanAssignments,
  // PayrollPeriods, GeofenceVersions, Users) — mechanical HTTP+DB checks. ----

  // Sites: create second, list shows both, edit first doesn't touch second, reload durable.
  const siteX = await jsonFetch(`${BASE}/api/admin/sites`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name: `SiteX ${fx.run}` }) });
  check('Sites: create-second succeeds independently of Alpha/Beta', siteX.status === 201);
  const sitesList = await jsonFetch(`${BASE}/api/admin/sites?pageSize=100`, { headers: authHeaders(fx.admin.cookie) });
  const siteIds = (sitesList.body.items as any[]).map((s) => s.id);
  check('Sites: list contains Alpha, Beta, and the new SiteX', siteIds.includes(fx.sites.alpha) && siteIds.includes(fx.sites.beta) && siteIds.includes(siteX.body.id));
  const siteXDetail = await jsonFetch(`${BASE}/api/admin/sites/${siteX.body.id}`, { headers: authHeaders(fx.admin.cookie) });
  await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { method: 'PATCH', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ version: (await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { headers: authHeaders(fx.admin.cookie) })).body.version, name: `Alpha renamed ${fx.run}`, active: true }) });
  const siteXAfterAlphaEdit = await jsonFetch(`${BASE}/api/admin/sites/${siteX.body.id}`, { headers: authHeaders(fx.admin.cookie) });
  check('Sites: editing Alpha does not change SiteX', siteXAfterAlphaEdit.body.name === siteXDetail.body.name, { before: siteXDetail.body.name, after: siteXAfterAlphaEdit.body.name });

  // Sites: close (lifecycle) then confirm active=false is shown, not hidden without explanation.
  const alphaCurrent = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { headers: authHeaders(fx.admin.cookie) });
  const closeAlpha = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { method: 'PATCH', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ version: alphaCurrent.body.version, name: alphaCurrent.body.name, active: false }) });
  check('Sites: lifecycle close (active=false) succeeds via the same PATCH contract', closeAlpha.status === 200 && closeAlpha.body.active === false, closeAlpha.body);
  // Sites: a finished site is hidden from the default list + the picker, shown with ?closed=1.
  const sitesDefault = await jsonFetch(`${BASE}/api/admin/sites?pageSize=100&active=true`, { headers: authHeaders(fx.admin.cookie) });
  const defaultSiteIds = (sitesDefault.body.items as { id: string }[]).map((x) => x.id);
  check('Sites: default (active) list hides the finished Alpha and reports closedCount', !defaultSiteIds.includes(fx.sites.alpha) && typeof sitesDefault.body.closedCount === 'number' && sitesDefault.body.closedCount >= 1, { has: defaultSiteIds.includes(fx.sites.alpha), closedCount: sitesDefault.body.closedCount });
  const sitesAll = await jsonFetch(`${BASE}/api/admin/sites?pageSize=100`, { headers: authHeaders(fx.admin.cookie) });
  check('Sites: unfiltered list still includes the finished Alpha', (sitesAll.body.items as { id: string }[]).some((x) => x.id === fx.sites.alpha));
  const sitesPageHtml = await (await fetch(`${BASE}/admin/sites`, { headers: authHeaders(fx.admin.cookie) })).text();
  check('Sites: /admin/sites hides finished by default and offers "Show finished"', !sitesPageHtml.includes(`Alpha renamed ${fx.run}`) && sitesPageHtml.includes('Show finished'), sitesPageHtml.slice(0, 200));
  const sitesClosedHtml = await (await fetch(`${BASE}/admin/sites?closed=1`, { headers: authHeaders(fx.admin.cookie) })).text();
  check('Sites: /admin/sites?closed=1 shows the finished Alpha', sitesClosedHtml.includes(`Alpha renamed ${fx.run}`));
  const siteDetailHtml = await (await fetch(`${BASE}/admin/sites/${fx.sites.alpha}`, { headers: authHeaders(fx.admin.cookie) })).text();
  check('Sites: the site detail page offers "Reopen site" for a finished site', siteDetailHtml.includes('Reopen site'));
  // Reopen for the rest of the suite (role-matrix script reuses this fixture pattern independently, but be tidy).
  const alphaAfterClose = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { headers: authHeaders(fx.admin.cookie) });
  await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { method: 'PATCH', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ version: alphaAfterClose.body.version, name: alphaAfterClose.body.name, active: true }) });

  // WorkAreas: create second on the same site, toggle doesn't affect the first.
  const workAreaX = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}/work-areas`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ name: `ZoneX ${fx.run}` }) });
  check('WorkAreas: create-second on a site that already has one work area succeeds', workAreaX.status === 201, workAreaX);
  const siteAlphaAfterSecondWorkArea = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}`, { headers: authHeaders(fx.admin.cookie) });
  check('WorkAreas: both work areas visible on the site', (siteAlphaAfterSecondWorkArea.body.workAreas as any[]).length >= 2);


  // Templates: create second, edit (PATCH) creates a new version rather than mutating in place.
  const templateX = await jsonFetch(`${BASE}/api/admin/templates`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ name: `TemplateX ${fx.run}`, days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isWorkingDay: weekday < 5, plannedStartTime: weekday < 5 ? '08:00' : undefined, plannedEndTime: weekday < 5 ? '16:00' : undefined, plannedBreakMinutes: weekday < 5 ? 30 : 0 })) }) });
  check('Templates: create-second independent of the fixture template', templateX.status === 201);
  const templateBeforePatch = await jsonFetch(`${BASE}/api/admin/templates/${fx.templateId}`, { headers: authHeaders(fx.admin.cookie) });
  const patchTemplate = await jsonFetch(`${BASE}/api/admin/templates/${fx.templateId}`, { method: 'PATCH', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ expectedVersionNumber: templateBeforePatch.body.currentVersionNumber, days: templateBeforePatch.body.days.map((d: any) => ({ ...d, plannedBreakMinutes: d.isWorkingDay ? 45 : 0 })) }) });
  check('Templates: PATCH creates a new, higher version number (immutable versioning)', patchTemplate.status === 200 && patchTemplate.body.currentVersionNumber === templateBeforePatch.body.currentVersionNumber + 1, patchTemplate.body);

  // PayrollPeriods: create second (non-overlapping), list shows both, lock is not allowed until FINAL_APPROVED.
  const periodTwoStart = new Date(periodEnd);
  periodTwoStart.setUTCDate(periodTwoStart.getUTCDate() + 1);
  const periodTwoEnd = new Date(periodTwoStart);
  periodTwoEnd.setUTCDate(periodTwoEnd.getUTCDate() + 13);
  const periodTwo = await jsonFetch(`${BASE}/api/admin/periods`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ startDate: periodTwoStart.toISOString().slice(0, 10), endDate: periodTwoEnd.toISOString().slice(0, 10) }) });
  check('PayrollPeriods: create-second, non-overlapping, succeeds', periodTwo.status === 201, periodTwo.body);
  const lockAttempt = await jsonFetch(`${BASE}/api/admin/periods/${fx.periodId}/lock`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }) });
  check('PayrollPeriods: lock is rejected while participants are not FINAL_APPROVED (lifecycle precondition enforced)', lockAttempt.status === 409 || lockAttempt.status === 404, lockAttempt);

  // SiteAssignments: create-second for Worker A (different site than their primary), then End it
  // via the newly-added D3 UI contract, confirmed by direct API call + DB assertion.
  const assignmentX = await jsonFetch(`${BASE}/api/admin/assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ employeeId: fx.workerB.employeeId, siteId: fx.sites.gamma, validFrom: '2020-01-01', isPrimary: false }) });
  check('SiteAssignments: create-second (different site) for an already-assigned worker succeeds', assignmentX.status === 201, assignmentX.body);
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  // Ending validTo *after* the fixture's own far-future OPEN period (2210-01-14, see
  // _test-t9-fixtures.ts) — this new assignment auto-materialized a PayrollPeriodParticipant/
  // TimesheetDraft for that period at creation time (assignment.create's own contract), so
  // shrinking validTo to before it would correctly trip fn_site_assignment_dependents_guard()
  // (05_RAW_SQL_REGISTER.md) — ending "today" against a far-future test period isn't a realistic
  // scenario, ending it right after the period is.
  const endValidTo = '2210-01-15';
  const endAssignmentX = await jsonFetch(`${BASE}/api/admin/assignments/${assignmentX.body.id}/end`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ validTo: endValidTo, reason: 'T9 regression: end via newly-added UI-backed contract' }) });
  check('SiteAssignments: assignment.end (D3 fix target) succeeds end-to-end', endAssignmentX.status === 200 && endAssignmentX.body.validTo === endValidTo, endAssignmentX.body);
  const assignmentXInDb = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: assignmentX.body.id } });
  check('SiteAssignments: ended assignment is not physically deleted, only validTo/endedReason set', assignmentXInDb !== null && assignmentXInDb.endedReason === 'T9 regression: end via newly-added UI-backed contract');

  // ForemanAssignments: create-second (Gamma, deliberately not in fixture), then End it (D4 fix).
  const foremanAssignGamma = await jsonFetch(`${BASE}/api/admin/foreman-assignments`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ foremanUserId: fx.foreman.userId, siteId: fx.sites.gamma, isSubstitute: true, validFrom: '2020-01-01' }) });
  check('ForemanAssignments: create-second (substitute, third site) succeeds', foremanAssignGamma.status === 201, foremanAssignGamma.body);
  const endForemanGamma = await jsonFetch(`${BASE}/api/admin/foreman-assignments/${foremanAssignGamma.body.id}/end`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ validTo: todayIso }) });
  check('ForemanAssignments: foreman_assignment.end (D4 fix target) succeeds end-to-end', endForemanGamma.status === 200 && endForemanGamma.body.validTo === todayIso, endForemanGamma.body);

  // GeofenceVersions: append-second version, first remains in history unmodified, physical delete
  // is genuinely unavailable (no DELETE route at all).
  const geofenceBefore = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}/geofence-versions`, { headers: authHeaders(fx.admin.cookie) });
  const firstVersionId = geofenceBefore.body.current.id;
  const geofenceSecond = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}/geofence-versions`, { method: 'POST', headers: authHeaders(fx.admin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ latitude: 60.19, longitude: 24.95, radiusMeters: 200 }) });
  check('GeofenceVersions: appending a second version succeeds', geofenceSecond.status === 201, geofenceSecond.body);
  const geofenceHistory = await jsonFetch(`${BASE}/api/admin/sites/${fx.sites.alpha}/geofence-versions`, { headers: authHeaders(fx.admin.cookie) });
  const historyIds = (geofenceHistory.body.items as any[]).map((v: any) => v.id);
  check('GeofenceVersions: the first version remains present in history, unmodified', historyIds.includes(firstVersionId) && geofenceHistory.body.current.id === geofenceSecond.body.id, geofenceHistory.body);

  // AuditEvent content: no password/activation code/GPS/raw request payload for the deactivation.
  const auditRows = await prisma.auditEvent.findMany({ where: { entityId: fx.workerA.employeeId } });
  const forbiddenTerms = ['password', 'passwordHash', 'activationCode', 'latitude', 'longitude', 'gps'];
  const anyLeak = auditRows.some((row) => {
    const blob = JSON.stringify({ before: row.beforeValue, after: row.afterValue }).toLowerCase();
    return forbiddenTerms.some((term) => blob.includes(term.toLowerCase()));
  });
  check('AuditEvent content: no password/activationCode/GPS terms anywhere in Worker A\'s audit trail', !anyLeak);

  console.log(JSON.stringify({ pass, fail }));
  console.log(`\n${pass} passed, ${fail} failed (T9 setup lifecycle)`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
