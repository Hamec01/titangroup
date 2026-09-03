// R15-D7 Deploy F — browser QA for /admin/reports/customer ("Часы заказчику"). Real Chromium.
// Reuses _test-t9-fixtures.buildFixture, then seeds ONE site with TWO customers + 25 workers so
// the 20/page worker list, cross-page selection, search, and the two-customer isolation are
// exercised for real. Covers spec §8 items 1, 6, 7, 10 + the export gates + RU/EN + URL round-trip.
// The per-customer minute maths (items 2-5, 8, 9) are in _test-customer-hours.ts (db lane).

import { chromium, type ConsoleMessage, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { SubmissionSource } from '@prisma/client';
import { buildFixture } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39917';
const DESKTOP = { width: 1440, height: 900 };

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
};

const ASG_START = new Date('2020-01-01T00:00:00.000Z');
const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);

async function login(page: Page, username: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('.login-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 15000 });
}

async function main(): Promise<void> {
  const fx = await buildFixture(BASE);
  const adminId = (await prisma.user.findFirstOrThrow({ where: { username: fx.admin.username }, select: { id: true } })).id;
  const run = randomUUID().slice(0, 5);

  const site = await prisma.workSite.create({ data: { name: `F-QA ${run}` } });
  const waAros = await prisma.workArea.create({ data: { siteId: site.id, name: `Aros Marine ${run}`, active: true } });
  const waMeyer = await prisma.workArea.create({ data: { siteId: site.id, name: `Meyer Yard ${run}`, active: false } }); // disabled -> still reportable

  const day = new Date(Date.UTC(2099, 8, 7));
  const period = await prisma.payrollPeriod.create({ data: { startDate: day, endDate: new Date(day.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });

  // 22 workers on Aros (paginates: 20/page), 3 on Meyer. All FINAL_APPROVED so a client export is allowed.
  const arosNumbers: string[] = [];
  for (let i = 0; i < 25; i++) {
    const wa = i < 22 ? waAros : waMeyer;
    const emp = await prisma.employee.create({ data: { employeeNumber: `FQA-${run}-${String(i).padStart(2, '0')}`, firstName: `Qa${i}`, lastName: `F${String(i).padStart(2, '0')}` } });
    if (i < 22) arosNumbers.push(emp.employeeNumber);
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
    const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: wa.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
    const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: day, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: at(day, 7), plannedEndAt: at(day, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: day, startAt: at(day, 7), endAt: at(day, 15), siteId: site.id, workAreaId: wa.id, sourceAssignmentId: asg.id } });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
      await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
    });
    await prisma.timesheet.update({ where: { id: ts.id }, data: { status: 'FINAL_APPROVED' } });
  }

  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  page.on('console', (m: ConsoleMessage) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('response', async (r) => {
    if (r.url().includes('/reports/customer/scope') && r.url().includes('preview')) {
      console.log('  [scope preview]', r.status(), (await r.text()).slice(0, 400));
    }
  });
  await login(page, fx.admin.username, fx.admin.password);

  await page.goto(`${BASE}/admin/reports/customer`, { waitUntil: 'networkidle' });
  check('page: heading renders, no free-text customer input', await page.locator('h1').first().isVisible() && (await page.locator('input[name="customer"]').count()) === 0);

  await page.locator('#ch-from').fill('2099-09-07');
  await page.waitForTimeout(150);
  await page.locator('#ch-to').fill('2099-09-13');
  await page.waitForTimeout(150);
  await page.waitForFunction(() => {
    const s = new URL(location.href).searchParams;
    return s.get('dateFrom') === '2099-09-07' && s.get('dateTo') === '2099-09-13';
  }, undefined, { timeout: 4000 });
  await page.locator('#ch-customer-search').fill(`Aros Marine ${run}`);
  await page.waitForTimeout(600);
  const arosRow = page.locator(`[data-testid="ch-customer-results"] input[data-wa="${waAros.id}"]`);
  await arosRow.waitFor({ timeout: 6000 });
  check('search: "Aros Marine" finds the Aros customer', (await arosRow.count()) === 1);
  await arosRow.click();
  await page.waitForFunction((id) => (new URL(location.href).searchParams.get('waIds') ?? '').includes(id), waAros.id, { timeout: 5000 });
  check('URL carries waIds after selecting a customer', (await page.evaluate(() => new URL(location.href).searchParams.get('waIds')))?.includes(waAros.id) ?? false);

  // per-customer card
  await page.waitForSelector('[data-testid="ch-customer-card"]', { timeout: 8000 });
  const cardText = await page.locator('[data-testid="ch-customer-card"]').first().innerText();
  check('card: shows the Aros customer + site + 22 assigned + total hours', cardText.includes('Aros Marine') && cardText.includes(site.name) && /22/.test(cardText) && /165 h|165 ч/.test(cardText), cardText.slice(0, 200));

  // worker list: 22 Aros workers -> 20/page + a 2nd page
  await page.waitForSelector('[data-testid="ch-worker-table"] tbody tr', { timeout: 8000 });
  const page1Rows = await page.locator('[data-testid="ch-worker-table"] tbody tr').count();
  check('worker list: page 1 shows exactly 20 rows', page1Rows === 20, page1Rows);
  check('worker list: page indicator "1 / 2"', (await page.locator('body').innerText()).match(/1\s*\/\s*2/) !== null);
  check('worker list: NO Meyer worker leaks into the Aros report', !(await page.locator('[data-testid="ch-worker-table"]').innerText()).includes(`FQA-${run}-24`));

  // select-all + go to page 2 -> selection persists across pages
  await page.locator('fieldset', { has: page.locator('[data-testid="ch-worker-table"]') }).getByRole('button', { name: 'Select all', exact: true }).click();
  await page.getByRole('button', { name: '›', exact: true }).click();
  await page.waitForTimeout(300);
  const page2Checked = await page.locator('[data-testid="ch-worker-table"] tbody input[type=checkbox]:checked').count();
  const page2Total = await page.locator('[data-testid="ch-worker-table"] tbody tr').count();
  check('worker selection persists onto page 2 (all checked)', page2Checked === page2Total && page2Total === 2, { page2Checked, page2Total });

  // export gate: with an active customer + all FINAL, PDF is allowed
  const pdfLink = page.locator('[data-testid="ch-pdf"]');
  check('export: Download PDF enabled (customer chosen, all final-approved)', (await pdfLink.getAttribute('aria-disabled')) === 'false');
  check('export: the PDF href targets mode=FINAL', ((await pdfLink.getAttribute('href')) ?? '').includes('mode=FINAL'));

  // add the "no customer" internal toggle -> client PDF must be blocked
  await page.locator('label', { hasText: /no customer|без заказчика/i }).locator('input[type=checkbox]').click();
  await page.waitForTimeout(500);
  check('export: after "no customer" toggle the client PDF is blocked with a reason', (await pdfLink.getAttribute('aria-disabled')) === 'true' && (await page.locator('[data-testid="ch-export-blocked"]').innerText()).length > 0);
  await page.locator('label', { hasText: /no customer|без заказчика/i }).locator('input[type=checkbox]').click();
  await page.waitForTimeout(400);

  // CSV / PDF minutes agree with the UI: fetch the CSV, check the GRAND/CUSTOMER total
  const waIds = await page.evaluate(() => new URL(location.href).searchParams.get('waIds'));
  const csvRes = await page.request.get(`${BASE}/api/admin/reports/customer/export?dateFrom=2099-09-07&dateTo=2099-09-13&waIds=${waIds}&format=CSV&mode=FINAL`);
  check('export: CSV downloads 200', csvRes.status() === 200);
  const csv = await csvRes.text();
  // 22 workers × 450 min = 9900 min
  check('export: CSV CUSTOMER_TOTAL = 9900 min (matches 22 × 7h30) and no Meyer', csv.includes(',9900,') && !csv.includes('Meyer Yard'), csv.split('\r\n').find((l) => l.includes('CUSTOMER_TOTAL')));

  // URL round-trip: reload keeps the selection
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="ch-customer-card"]', { timeout: 8000 });
  check('reload: the Aros selection + dates survive a full reload', (await page.locator('[data-testid="ch-customer-card"]').first().innerText()).includes('Aros Marine') && (await page.locator('#ch-from').inputValue()) === '2099-09-07');

  // Back/Forward: navigate away and back
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.goBack({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="ch-customer-card"]', { timeout: 8000 });
  check('Back: returns to the customer report with the selection intact', (await page.evaluate(() => new URL(location.href).searchParams.get('waIds')))?.includes(waAros.id) ?? false);

  // RU/EN: the same page in Russian (NEXT_LOCALE cookie)
  const ctxRu = await browser.newContext({ viewport: DESKTOP });
  const ruPage = await ctxRu.newPage();
  await login(ruPage, fx.admin.username, fx.admin.password);
  const origin = new URL(BASE);
  await ctxRu.addCookies([{ name: 'NEXT_LOCALE', value: 'RU', domain: origin.hostname, path: '/' }]);
  await ruPage.goto(`${BASE}/admin/reports/customer?dateFrom=2099-09-07&dateTo=2099-09-13&waIds=${waAros.id}`, { waitUntil: 'networkidle' });
  const ruText = await ruPage.locator('body').innerText();
  check('RU: key labels are Russian ("Заказчик" / "Часы заказчику")', ruText.includes('Заказчик') && ruText.includes('Часы заказчику'), ruText.slice(0, 160));
  await ctxRu.close();

  check('no console errors on the customer report page', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  await browser.close();
  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
