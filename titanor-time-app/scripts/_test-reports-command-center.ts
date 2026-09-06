// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §13.C — browser QA for the new
// /admin/reports command centre. Real Chromium, production standalone server (TEST_BASE_URL),
// disposable PostgreSQL 16. Self-contained fixtures (direct Prisma — works on a fresh DB and on a
// restored real-data copy alike, so this doubles as the preview acceptance run). Covers §2 (URL
// is the source of truth), §3 (real pagination), §4 (new/classic design), §9 (create / download /
// history / delete), RU/EN, desktop/mobile.
import { chromium, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';

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
  const run = randomUUID().slice(0, 6);
  const username = `rcc-admin-${run}`;
  const password = `Rcc-preview-${randomUUID().slice(0, 10)}`;
  const admin = await prisma.user.create({
    data: { username, status: 'ACTIVE', locale: 'EN', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) }
  });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
  const adminId = admin.id;
  const fx = { admin: { username, password } };

  const period = await prisma.payrollPeriod.create({
    data: { startDate: new Date('2096-04-06'), endDate: new Date('2096-04-19'), status: 'OPEN', openedByUserId: adminId }
  });
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
  let someSiteId = '';
  for (let n = 0; n < 34; n++) {
    const e = await prisma.employee.create({ data: { employeeNumber: `RCC-A-${n}-${randomUUID().slice(0, 6)}`, firstName: `A${n}`, lastName: 'Filler' } });
    await prisma.employment.create({ data: { employeeId: e.id, active: true, startDate: new Date('2020-01-01') } });
    const s = await prisma.workSite.create({ data: { name: `RCC Fill ${String(n).padStart(3, '0')} ${randomUUID().slice(0, 4)}` } });
    if (n === 10) someSiteId = s.id;
    await prisma.siteAssignment.create({ data: { employeeId: e.id, siteId: s.id, isPrimary: true, validFrom: from, validTo: to, assignedByUserId: adminId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: e.id, expected: true } });
  }
  const TOTAL_SITES = 35; // 34 assignment-only + 1 hours site
  const REPORTS = `${BASE}/admin/reports?periodId=${period.id}`;

  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await login(page, fx.admin.username, fx.admin.password);

  const clickNav = async (locator: import('playwright').Locator, urlRe: RegExp) => {
    await Promise.all([page.waitForURL(urlRe, { timeout: 20000 }), locator.click()]);
    await page.waitForLoadState('networkidle');
  };

  // ── §2 tabs + URL is the source of truth ────────────────────────────────────────────────────
  await page.goto(REPORTS, { waitUntil: 'networkidle' });
  check('overview: renders with the working-report notice', (await page.locator('.report-working-notice').isVisible()) && (await page.locator('.report-tab-active').innerText()).match(/overview|обзор/i) !== null);

  // period pagination — parse the actual total (the restored copy may hold extra real sites)
  const infoText = await page.locator('.report-pagination-info').innerText();
  const total = Number(infoText.match(/of (\d+)|из (\d+)/)?.slice(1).find(Boolean) ?? 0);
  const expectedPages = Math.ceil(total / 20);
  check('overview: site table is paginated to 20 rows', (await page.locator('.report-table tbody tr').count()) === 20, infoText);
  check('overview: readout shows the full count and page maths', total >= TOTAL_SITES && new RegExp(`(page|страница) 1 (of|из) ${expectedPages}`).test(infoText), infoText);
  const page1FirstSite = await page.locator('.report-table tbody tr td').first().innerText();
  await clickNav(page.locator('.report-pagination-controls a', { hasText: /Next|Вперёд/ }), /[?&]page=2\b/);
  check('overview: Next advances page in the URL and changes the rows', (await sp(page)).page === '2' && (await page.locator('.report-table tbody tr td').first().innerText()) !== page1FirstSite);
  await Promise.all([page.waitForURL((u) => !/[?&]page=2\b/.test(u.href), { timeout: 20000 }), page.goBack()]);
  await page.waitForLoadState('networkidle');
  check('overview: Back returns to page 1', ((await sp(page)).page ?? '1') === '1' && (await page.locator('.report-table tbody tr td').first().innerText()) === page1FirstSite);

  // worker tab without an id -> picker
  await clickNav(page.locator('.report-tab', { hasText: /By worker|По работнику/ }), /view=worker/);
  check('worker tab w/o id: picker screen shown, no employeeId in URL', (await page.locator('.report-picker').isVisible()) && !(await sp(page)).employeeId && (await sp(page)).view === 'worker');
  await page.locator('.report-picker-form select').selectOption(hoursEmp.id);
  await clickNav(page.locator('.report-picker-form button[type=submit]'), new RegExp(`employeeId=${hoursEmp.id}`));
  const afterWorker = await sp(page);
  check('worker selected: report shown, employeeId in URL, NO siteId', afterWorker.view === 'worker' && afterWorker.employeeId === hoursEmp.id && !afterWorker.siteId);
  check('worker report: heading names the worker', /Hours/.test(await page.locator('.report-detail-head h2').innerText()));

  // switch to site tab -> picker; select -> siteId in URL, employeeId dropped
  await clickNav(page.locator('.report-tab', { hasText: /By site|По объекту/ }), /view=site/);
  check('site tab: picker shown, employeeId dropped (no conflict possible)', (await page.locator('.report-picker').isVisible()) && (await sp(page)).view === 'site' && !(await sp(page)).employeeId);
  await page.locator('.report-picker-form select').selectOption(hoursSite.id);
  await clickNav(page.locator('.report-picker-form button[type=submit]'), new RegExp(`siteId=${hoursSite.id}`));
  const afterSite = await sp(page);
  check('site selected: siteId in URL, employeeId gone (no conflict)', !!afterSite.siteId && !afterSite.employeeId && afterSite.view === 'site');

  // site -> worker link drops siteId
  await clickNav(page.locator('.report-table tbody tr td a').first(), /view=worker/);
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
  await clickNav(page.locator('.report-filter-reset'), /\/admin\/reports$/);
  check('Reset: returns to the clean initial overview state', Object.keys(await sp(page)).length === 0 && (await page.locator('.report-tab-active').innerText()).match(/overview|обзор/i) !== null);

  // ── §9 create / history / download / delete ─────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/reports?periodId=${period.id}`, { waitUntil: 'networkidle' });
  await page.locator('.report-header-actions button', { hasText: /Create CSV|Создать CSV/ }).click();
  await page.locator('.report-header-actions a', { hasText: /Download|Скачать/ }).waitFor({ timeout: 20000 });
  check('create CSV: a download link appears', await page.locator('.report-header-actions a', { hasText: /Download|Скачать/ }).isVisible());
  await clickNav(page.locator('.report-tab', { hasText: /Saved files|Сохранённые файлы/ }), /view=files/);
  await page.waitForSelector('.report-file-row', { timeout: 10000 });
  check('history: the file is listed with its metadata', (await page.locator('.report-file-row').count()) >= 1 && /PERIOD_SUMMARY/.test(await page.locator('.report-file-row').first().innerText()));
  const dlHref = await page.locator('.report-file-row a', { hasText: /Download|Скачать/ }).first().getAttribute('href');
  // Fetch from INSIDE the page — the tt_session cookie is same-origin only for the page context.
  const dl = await page.evaluate(async (href) => {
    const r = await fetch(href, { credentials: 'same-origin' });
    return { status: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), body: await r.text() };
  }, dlHref!);
  check(
    'history: download returns the CSV bytes with a safe disposition',
    dl.status === 200 && (dl.ct ?? '').startsWith('text/csv') && /filename\*=UTF-8''/.test(dl.cd ?? '') && dl.body.includes('WORKING REPORT — NOT AN OFFICIAL PAYROLL EXPORT'),
    { status: dl.status, ct: dl.ct, cd: dl.cd }
  );
  const beforeDelete = await page.locator('.report-file-row').count();
  page.once('dialog', (d) => d.accept());
  await page.locator('.report-file-row .report-file-delete button').first().click();
  await page.waitForFunction((n) => document.querySelectorAll('.report-file-row').length < n, beforeDelete, { timeout: 10000 });
  check('delete: the row is gone from history', (await page.locator('.report-file-row').count()) === beforeDelete - 1);

  // ── §4 classic vs modern shell ──────────────────────────────────────────────────────────────
  await Promise.all([page.waitForSelector('.admin-shell > .admin-header', { timeout: 15000 }), page.locator('.admin-design-toggle').click()]);
  check('classic view: the pre-redesign shell is back', (await page.locator('.admin-shell > .admin-header').count()) === 1 && (await page.locator('.admin-nav').count()) === 1 && (await page.locator('.admin-modern-shell').count()) === 0);
  await page.reload({ waitUntil: 'networkidle' });
  check('classic view: persists across reload (cookie, no flash)', (await page.locator('.admin-shell > .admin-header').count()) === 1);
  await Promise.all([page.waitForSelector('.admin-modern-shell', { timeout: 15000 }), page.locator('.admin-design-toggle').click()]);
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
  // resolveAppLocale() uses User.locale for an authenticated session (re-read fresh each request),
  // so switch it at the source rather than via the NEXT_LOCALE cookie.
  check('EN: the UI is English before the switch', /Reports/.test(await page.locator('.report-center h1').innerText()));
  await prisma.user.update({ where: { id: adminId }, data: { locale: 'RU' } });
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
