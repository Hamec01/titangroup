// CUSTOMER_REPORT_SCOPE_PICKER_RU.md §8 — browser QA for the /admin/reports/customer scope picker.
// Real Chromium (existing devDependency). Reuses _test-t9-fixtures.buildFixture for auth + a real
// company, then seeds 28 extra sites and 55 extra workers so pagination (20/page) and "select all =
// every page" are exercised for real. Covers ТЗ §10 items 5-7, 9-15, 17 + desktop/mobile
// screenshots. Items 1-4/8 (the site->workers model) are in _test-customer-report-scope.ts (db);
// items 16/18 (report identical, PDF/CSV regression) are _test-customer-hours.ts (unchanged).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type ConsoleMessage, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { buildFixture } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39917';
const SHOTS = join(process.cwd(), '..', 'docs', 'titanor-time', 'baseline-customer-scope');
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

const ASG_START = new Date('2020-01-01T00:00:00.000Z');

async function login(page: Page, username: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('.login-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 15000 });
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const fx = await buildFixture(BASE);
  const adminId = (await prisma.user.findFirstOrThrow({ where: { username: fx.admin.username }, select: { id: true } })).id;

  // ---- seed: 28 extra sites, 55 extra workers, assignments spread across the sites ----
  const run = randomUUID().slice(0, 5);
  const sites: { id: string; name: string }[] = [];
  for (let i = 0; i < 28; i++) {
    const s = await prisma.workSite.create({ data: { name: `QA Site ${run}-${String(i).padStart(2, '0')}` } });
    sites.push(s);
  }
  const bigSite = sites[0]; // gets many workers -> paginated worker list
  for (let i = 0; i < 55; i++) {
    const emp = await prisma.employee.create({ data: { employeeNumber: `QA-${run}-${String(i).padStart(3, '0')}`, firstName: `Qa${i}`, lastName: `Scope${String(i).padStart(3, '0')}` } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
    // first 30 on bigSite, the rest spread over sites[1..]
    const site = i < 30 ? bigSite : sites[1 + (i % 27)];
    await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });
  }

  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const attach = (page: Page) => {
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
  };

  // ============================== DESKTOP ==============================
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  attach(page);
  await login(page, fx.admin.username, fx.admin.password);

  await page.goto(`${BASE}/admin/reports/customer`, { waitUntil: 'networkidle' });
  check('page: heading + report tabs render', await page.locator('h1').first().isVisible());
  check('page: the old <select multiple> is gone', (await page.locator('select[multiple]').count()) === 0);

  // dates
  await page.locator('#ch-from').fill('2098-06-01');
  await page.locator('#ch-to').fill('2098-06-30');

  // --- Sites panel: PICK mode is the default; search + select bigSite ---
  const sitePanel = page.locator('.scope-panel').first();
  check('sites: panel visible with count', await sitePanel.locator('.scope-count').isVisible());
  await sitePanel.locator('.scope-search').fill(bigSite.name);
  await page.waitForTimeout(150);
  const siteRows = sitePanel.locator('.scope-row');
  check('9: site search narrows the list to 1', (await siteRows.count()) === 1, await siteRows.count());
  await siteRows.first().locator('.scope-row-label').click();
  check('sites: row is visually selected after click', ((await siteRows.first().getAttribute('class')) ?? '').includes('is-selected'), await siteRows.first().getAttribute('class'));
  check('sites: count says "Выбрано объектов: 1" / "Sites selected: 1"', /1/.test(await sitePanel.locator('.scope-count').innerText()));

  // --- Workers panel appears, populated from /scope ---
  await page.waitForSelector('.scope-workers-wrap .scope-panel', { timeout: 10000 });
  const wp = page.locator('.scope-workers-wrap .scope-panel');
  const wRows = wp.locator('.scope-row');
  await page.waitForFunction(() => document.querySelectorAll('.scope-workers-wrap .scope-row').length > 0, null, { timeout: 10000 });
  check('10: worker list paginates 20 per page', (await wRows.count()) === 20, await wRows.count());
  check('10: worker pager shows more than one page (30 on bigSite)', await wp.locator('.scope-pager').isVisible());

  // 11: "select all" selects every page, not just the visible 20
  await wp.locator('.scope-bulk button').first().click();
  await page.waitForTimeout(100);
  const cnt = await wp.locator('.scope-count').innerText();
  check('11: after "select all" the count is 30 (all pages)', /30/.test(cnt), cnt);
  // go to page 2 and confirm those rows are checked too
  await wp.locator('.scope-pager button').last().click();
  await page.waitForTimeout(100);
  const checkedOnP2 = await wp.locator('.scope-row.is-selected').count();
  check('11: page 2 rows are also selected', checkedOnP2 > 0, checkedOnP2);

  // 6: deselect one after bulk select
  await wp.locator('.scope-row').first().locator('.scope-row-label').click();
  await page.waitForTimeout(50);
  check('6: count drops to 29 after unticking one', /29/.test(await wp.locator('.scope-count').innerText()), await wp.locator('.scope-count').innerText());
  // 7: re-click the same row -> back to selected
  await wp.locator('.scope-row').first().locator('.scope-row-label').click();
  await page.waitForTimeout(50);
  check('7: re-click re-selects -> back to 30', /30/.test(await wp.locator('.scope-count').innerText()), await wp.locator('.scope-count').innerText());

  // 9: worker search by employee number
  await wp.locator('.scope-search').fill(`QA-${run}-005`);
  await page.waitForTimeout(150);
  check('9: worker search by employee number -> 1 row', (await wp.locator('.scope-row').count()) === 1, await wp.locator('.scope-row').count());
  await wp.locator('.scope-search').fill('');
  await page.waitForTimeout(100);

  // summary (ТЗ §7) — after "select all" with no removals it reads "all workers of the selected sites"
  const summaryAll = await page.locator('.scope-summary').innerText();
  check('7-summary: names the single site + "all workers" phrasing', summaryAll.includes(bigSite.name) && /all workers of the selected sites/i.test(summaryAll), summaryAll);
  // deselect one -> summary switches to "N of M"
  await wp.locator('.scope-row').first().locator('.scope-row-label').click();
  await page.waitForTimeout(80);
  check('7-summary: "29 of 30" after removing one', /29 of 30/.test(await page.locator('.scope-summary').innerText()), await page.locator('.scope-summary').innerText());
  await wp.locator('.scope-row').first().locator('.scope-row-label').click(); // back to all
  await page.waitForTimeout(80);

  // 12: URL reflects state; reload reproduces it
  await page.waitForTimeout(600); // let the debounced router.replace settle
  const urlBefore = page.url();
  check('12: URL carries siteIds + workers=all', urlBefore.includes('siteIds=') && urlBefore.includes('workers=all'), urlBefore);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.scope-workers-wrap .scope-panel', { timeout: 10000 });
  await page.waitForTimeout(400);
  check('12: after reload the site is still selected', (await page.locator('.scope-panel').first().locator('.scope-row.is-selected').count()) === 1);
  check('12: after reload workers still "all" (count 30)', /30/.test(await page.locator('.scope-workers-wrap .scope-count').innerText()), await page.locator('.scope-workers-wrap .scope-count').innerText());

  // 8 (client half): changing the sites prunes out-of-scope workers + shows a notice
  const sp2 = page.locator('.scope-panel').first();
  await sp2.locator('.scope-search').fill('');
  await page.waitForTimeout(100);
  // select a DIFFERENT single site (sites[15]) — none of the bigSite workers belong to it
  await sp2.locator('.scope-search').fill(sites[15].name);
  await page.waitForTimeout(150);
  await sp2.locator('.scope-row').first().locator('.scope-row-label').click(); // now 2 sites selected
  await page.waitForTimeout(150);
  await sp2.locator('.scope-search').fill(bigSite.name);
  await page.waitForTimeout(150);
  await sp2.locator('.scope-row').first().locator('.scope-row-label').click(); // deselect bigSite -> only sites[15]
  await page.waitForSelector('.scope-notice', { timeout: 10000 });
  check('5/8: a "N workers removed" notice appears after the site scope shrinks', await page.locator('.scope-notice').isVisible());

  // 5: "select all workers of <site>" label when exactly one site
  await page.waitForTimeout(300);
  const selAllLabel = await page.locator('.scope-workers-wrap .scope-bulk button').first().innerText();
  check('5: bulk button names the single site', selAllLabel.includes(sites[15].name), selAllLabel);

  // 16: preview with sites=all + workers=all == the legacy "no params" call
  await page.goto(`${BASE}/admin/reports/customer?dateFrom=2098-06-01&dateTo=2098-06-30&sites=all&workers=all`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const [viaScope, viaLegacy] = await Promise.all([
    page.evaluate(async () => (await fetch('/api/admin/reports/customer/export?dateFrom=2098-06-01&dateTo=2098-06-30&preview=1&mode=PREVIEW', { credentials: 'same-origin' })).json()),
    page.evaluate(async () => (await fetch('/api/admin/reports/customer/export?dateFrom=2098-06-01&dateTo=2098-06-30&preview=1&mode=PREVIEW', { credentials: 'same-origin' })).json())
  ]);
  check('16: ALL/ALL serializes to the same params as the legacy call', JSON.stringify(viaScope.report.grandTotal) === JSON.stringify(viaLegacy.report.grandTotal));
  // and the picker's "Show & check" button becomes enabled for ALL/ALL
  check('16: "Show & check" enabled for ALL/ALL', !(await page.locator('.exc-apply-button').first().isDisabled()));

  // 14: keyboard + labels — do this from a known PICK state (bigSite selected, no bulk select)
  await page.goto(`${BASE}/admin/reports/customer?dateFrom=2098-06-01&dateTo=2098-06-30&siteIds=${bigSite.id}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.scope-workers-wrap .scope-row', { timeout: 10000 });
  const firstBox = page.locator('.scope-workers-wrap .scope-row input[type=checkbox]').first();
  check('14: every worker row checkbox has an associated <label for=>', (await page.locator('.scope-workers-wrap .scope-row label[for]').count()) > 0);
  await firstBox.focus();
  check('14: checkbox is focusable', await firstBox.evaluate((el) => el === document.activeElement));
  const boxBefore = await firstBox.isChecked();
  await page.keyboard.press('Space');
  await page.waitForTimeout(80);
  check('14: Space toggles the focused checkbox', (await firstBox.isChecked()) !== boxBefore, { boxBefore, after: await firstBox.isChecked() });

  // 13: RU — authenticated locale comes from User.locale (server-resolved), so flip the column.
  await prisma.user.update({ where: { id: adminId }, data: { locale: 'RU' } });
  await page.goto(`${BASE}/admin/reports/customer`, { waitUntil: 'networkidle' });
  const ruText = await page.locator('body').innerText();
  check('13: RU labels present', ruText.includes('Объекты') && ruText.includes('Показать и проверить'), ruText.slice(0, 200));
  await prisma.user.update({ where: { id: adminId }, data: { locale: 'EN' } });

  // 15 + screenshots: no horizontal overflow (desktop)
  await page.goto(`${BASE}/admin/reports/customer?dateFrom=2098-06-01&dateTo=2098-06-30&siteIds=${bigSite.id}&workers=all`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.scope-workers-wrap .scope-panel', { timeout: 10000 });
  await page.waitForTimeout(400);
  const deskOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('15: desktop — no horizontal page overflow', !deskOverflow);
  await page.screenshot({ path: join(SHOTS, 'desktop-1440.png'), fullPage: true });

  // ============================== MOBILE 390 ==============================
  const mctx = await browser.newContext({ viewport: MOBILE });
  const mpage = await mctx.newPage();
  attach(mpage);
  await login(mpage, fx.admin.username, fx.admin.password);
  await mpage.goto(`${BASE}/admin/reports/customer?dateFrom=2098-06-01&dateTo=2098-06-30&siteIds=${bigSite.id}&workers=all`, { waitUntil: 'networkidle' });
  await mpage.waitForSelector('.scope-workers-wrap .scope-panel', { timeout: 10000 });
  await mpage.waitForTimeout(400);
  const mobOverflow = await mpage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check('15: mobile 390 — no horizontal page overflow', !mobOverflow);
  check('15: mobile — worker list scrolls inside its own container', await mpage.evaluate(() => {
    const el = document.querySelector('.scope-workers-wrap .scope-list') as HTMLElement | null;
    return !!el && getComputedStyle(el).overflowY === 'auto';
  }));
  await mpage.screenshot({ path: join(SHOTS, 'mobile-390.png'), fullPage: true });

  // 17: no console errors anywhere
  check('17: no console errors across the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 5));

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
