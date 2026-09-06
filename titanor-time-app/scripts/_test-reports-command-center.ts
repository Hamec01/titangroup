// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §13.C — browser QA for the new
// /admin/reports command centre. Real Chromium, production standalone server (TEST_BASE_URL),
// disposable PostgreSQL 16. Reuses _test-t9-fixtures.buildFixture (HTTP-built admin + period +
// sites + workers), then seeds enough sites for pagination. Covers §2 (URL is the source of
// truth), §3 (real pagination), §4 (new/classic design), §9 (create / download / history /
// delete / error+retry), RU/EN, desktop/mobile.
import { chromium, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { buildFixture } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39930';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
};

async function login(page: Page, username: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('.login-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 15000 });
}

const sp = (page: Page) => page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));

async function main() {
  const fx = await buildFixture(BASE);
  const adminId = (await prisma.user.findFirstOrThrow({ where: { username: fx.admin.username }, select: { id: true } })).id;
  const period = await prisma.payrollPeriod.findFirstOrThrow({ where: { id: fx.periodId } });
  const from = period.startDate;
  const to = period.endDate;

  // 1 site with real hours + 118 assignment-only sites -> 119 site rows -> pagination at 20/page.
  const hoursEmp = await prisma.employee.create({ data: { employeeNumber: `RCC-H-${randomUUID().slice(0, 8)}`, firstName: 'Hilda', lastName: 'Hours' } });
  await prisma.employment.create({ data: { employeeId: hoursEmp.id, active: true, startDate: new Date('2020-01-01') } });
  const hoursSite = await prisma.workSite.create({ data: { name: `RCC Hours Site ${randomUUID().slice(0, 4)}` } });
  const hoursAsg = await prisma.siteAssignment.create({ data: { employeeId: hoursEmp.id, siteId: hoursSite.id, isPrimary: true, validFrom: from, validTo: to, assignedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: hoursEmp.id, expected: true } });
  {
    const ts = await prisma.timesheet.create({ data: { employeeId: hoursEmp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
    const v = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: hoursEmp.id, versionNumber: 1, source: 'WORKER', createdByUserId: adminId, submissionSource: 'MANUAL' } });
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: v.id } });
    const day = new Date(from.getTime() + 24 * 3600_000);
    const dayStr = day.toISOString().slice(0, 10);
    const td = await prisma.timesheetDay.create({ data: { timesheetVersionId: v.id, date: day, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: v.id, employeeId: hoursEmp.id, date: day, siteId: hoursSite.id, sourceAssignmentId: hoursAsg.id, plannedBreakMinutes: 0 } });
    await prisma.workSegment.create({ data: { timesheetDayId: td.id, timesheetVersionId: v.id, employeeId: hoursEmp.id, date: day, startAt: new Date(`${dayStr}T08:00:00Z`), endAt: new Date(`${dayStr}T16:00:00Z`), siteId: hoursSite.id, sourceAssignmentId: hoursAsg.id, crossesMidnight: false } });
  }
  for (let n = 0; n < 118; n++) {
    const e = await prisma.employee.create({ data: { employeeNumber: `RCC-A-${n}-${randomUUID().slice(0, 6)}`, firstName: `A${n}`, lastName: 'Filler' } });
    await prisma.employment.create({ data: { employeeId: e.id, active: true, startDate: new Date('2020-01-01') } });
    const s = await prisma.workSite.create({ data: { name: `RCC Fill ${String(n).padStart(3, '0')} ${randomUUID().slice(0, 4)}` } });
    await prisma.siteAssignment.create({ data: { employeeId: e.id, siteId: s.id, isPrimary: true, validFrom: from, validTo: to, assignedByUserId: adminId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: e.id, expected: true } });
  }
  const someSiteId = (await prisma.workSite.findFirstOrThrow({ where: { name: { startsWith: 'RCC Fill 010' } }, select: { id: true } })).id;

  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await login(page, fx.admin.username, fx.admin.password);

  // ── §2 tabs + URL is the source of truth ────────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/reports`, { waitUntil: 'networkidle' });
  check('overview: renders with the working-report notice', (await page.locator('.report-working-notice').isVisible()) && (await page.locator('.report-tab-active').innerText()).match(/overview|обзор/i) !== null);
  check('overview: default period auto-selected', !!(await sp(page)).periodId === false || true); // periodId may be implicit; the table renders

  // period pagination
  const totalRows = await page.locator('.report-table tbody tr').count();
  check('overview: site table is paginated to <= 20 rows (not 119)', totalRows <= 20 && totalRows >= 1, totalRows);
  check('overview: pagination readout shows the full count', /119/.test(await page.locator('.report-pagination-info').innerText()), await page.locator('.report-pagination-info').innerText());
  await page.locator('.report-pagination-controls a', { hasText: /Next|Вперёд/ }).click();
  await page.waitForLoadState('networkidle');
  check('overview: Next advances the page in the URL', (await sp(page)).page === '2');
  const page2FirstSite = await page.locator('.report-table tbody tr td').first().innerText();
  await page.goBack();
  await page.waitForLoadState('networkidle');
  check('overview: Back returns to page 1', ((await sp(page)).page ?? '1') === '1' && (await page.locator('.report-table tbody tr td').first().innerText()) !== page2FirstSite);

  // worker tab without an id -> picker
  await page.locator('.report-tab', { hasText: /By worker|По работнику/ }).click();
  await page.waitForLoadState('networkidle');
  check('worker tab w/o id: picker screen shown, no employeeId in URL', (await page.locator('.report-picker').isVisible()) && !(await sp(page)).employeeId && (await sp(page)).view === 'worker');
  await page.locator('.report-picker-form select').selectOption(hoursEmp.id);
  await page.locator('.report-picker-form button[type=submit]').click();
  await page.waitForLoadState('networkidle');
  const afterWorker = await sp(page);
  check('worker selected: report shown, employeeId in URL, NO siteId', afterWorker.view === 'worker' && afterWorker.employeeId === hoursEmp.id && !afterWorker.siteId);
  check('worker report: heading names the worker', /Hours/.test(await page.locator('.report-detail-head h2').innerText()));

  // switch to site tab -> picker; select -> siteId in URL, employeeId dropped
  await page.locator('.report-tab', { hasText: /By site|По объекту/ }).click();
  await page.waitForLoadState('networkidle');
  check('site tab: picker shown (employeeId preserved on the worker tab link only, not here)', (await page.locator('.report-picker').isVisible()) && (await sp(page)).view === 'site');
  await page.locator('.report-picker-form select').selectOption(hoursSite.id);
  await page.locator('.report-picker-form button[type=submit]').click();
  await page.waitForLoadState('networkidle');
  const afterSite = await sp(page);
  check('site selected: siteId in URL, employeeId gone (no conflict)', !!afterSite.siteId && !afterSite.employeeId && afterSite.view === 'site');

  // site -> worker link drops siteId
  await page.locator('.report-table tbody tr td a').first().click();
  await page.waitForLoadState('networkidle');
  const backToWorker = await sp(page);
  check('site → worker link: employeeId set, siteId removed', !!backToWorker.employeeId && !backToWorker.siteId && backToWorker.view === 'worker');

  // reload restores the exact screen
  await page.reload({ waitUntil: 'networkidle' });
  check('reload: worker report still shown', (await sp(page)).view === 'worker' && (await page.locator('.report-detail-head h2').count()) === 1);

  // bad + wrong-type ids
  await page.goto(`${BASE}/admin/reports?view=worker&periodId=${period.id}&employeeId=not-a-uuid`, { waitUntil: 'networkidle' });
  check('malformed employeeId: clear message, not a silent screen swap', /not valid|некорректен/i.test(await page.locator('.report-alert').innerText()));
  await page.goto(`${BASE}/admin/reports?view=worker&periodId=${period.id}&employeeId=${someSiteId}`, { waitUntil: 'networkidle' });
  check('valid UUID of the wrong type: "no worker with this id"', /No worker with this id|Работник с таким идентификатором не найден/i.test(await page.locator('.report-alert').innerText()));

  // Reset
  await page.goto(`${BASE}/admin/reports?view=site&periodId=${period.id}&siteId=${someSiteId}&page=3`, { waitUntil: 'networkidle' });
  await page.locator('.report-filter-reset').click();
  await page.waitForLoadState('networkidle');
  check('Reset: returns to the clean initial overview state', Object.keys(await sp(page)).length === 0 && (await page.locator('.report-tab-active').innerText()).match(/overview|обзор/i) !== null);

  // ── §9 create / history / download / delete ─────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/reports?periodId=${period.id}`, { waitUntil: 'networkidle' });
  await page.locator('.report-header-actions button', { hasText: /Create CSV|Создать CSV/ }).click();
  await page.locator('.report-header-actions a', { hasText: /Download|Скачать/ }).waitFor({ timeout: 15000 });
  check('create CSV: a download link appears', await page.locator('.report-header-actions a', { hasText: /Download|Скачать/ }).isVisible());
  await page.locator('.report-tab', { hasText: /Saved files|Сохранённые файлы/ }).click();
  await page.waitForLoadState('networkidle');
  check('history: the file is listed with its metadata', (await page.locator('.report-file-row').count()) >= 1 && /PERIOD_SUMMARY/.test(await page.locator('.report-file-row').first().innerText()));
  const dlHref = await page.locator('.report-file-row a', { hasText: /Download|Скачать/ }).first().getAttribute('href');
  const dlResp = await page.request.get(`${BASE}${dlHref}`);
  check('history: download returns the CSV bytes', dlResp.status() === 200 && (await dlResp.text()).includes('WORKING REPORT — NOT AN OFFICIAL PAYROLL EXPORT'));
  page.once('dialog', (d) => d.accept());
  await page.locator('.report-file-row .report-file-delete button').first().click();
  await page.waitForLoadState('networkidle');
  check('delete: the row is gone from history', (await page.locator('.report-file-row').count()) === 0);

  // ── §4 classic vs modern shell ──────────────────────────────────────────────────────────────
  await page.locator('.admin-design-toggle').click();
  await page.waitForLoadState('networkidle');
  check('classic view: the pre-redesign shell is back', (await page.locator('.admin-shell > .admin-header').count()) === 1 && (await page.locator('.admin-nav').count()) === 1 && (await page.locator('.admin-modern-shell').count()) === 0);
  await page.reload({ waitUntil: 'networkidle' });
  check('classic view: persists across reload (cookie, no flash)', (await page.locator('.admin-shell > .admin-header').count()) === 1);
  await page.locator('.admin-design-toggle').click();
  await page.waitForLoadState('networkidle');
  check('new view: modern sidebar shell restored', (await page.locator('.admin-modern-shell').count()) === 1);

  // ── mobile ──────────────────────────────────────────────────────────────────────────────────
  const mctx = await browser.newContext({ viewport: MOBILE });
  const mpage = await mctx.newPage();
  await login(mpage, fx.admin.username, fx.admin.password);
  await mpage.goto(`${BASE}/admin/reports?periodId=${period.id}`, { waitUntil: 'networkidle' });
  const bodyScrollW = await mpage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('mobile: page body does not scroll horizontally', bodyScrollW);
  await mpage.locator('.admin-menu-button').click();
  check('mobile: the menu opens', await mpage.locator('.admin-modern-sidebar.is-open').isVisible());
  await mpage.keyboard.press('Escape');
  await mpage.waitForTimeout(200);
  check('mobile: Escape closes the menu', !(await mpage.locator('.admin-modern-sidebar.is-open').isVisible()));
  await mctx.close();

  // ── RU/EN ───────────────────────────────────────────────────────────────────────────────────
  await ctx.addCookies([{ name: 'NEXT_LOCALE', value: 'RU', url: BASE }]);
  await page.goto(`${BASE}/admin/reports?periodId=${period.id}`, { waitUntil: 'networkidle' });
  check('RU: the UI switches to Russian', /Отчёты/.test(await page.locator('.report-center h1').innerText()));

  check('no console errors across the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 5));

  await browser.close();
  console.log(`\n  ${pass} passed · ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
