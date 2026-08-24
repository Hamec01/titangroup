// Browser QA for Qualifications Matrix + Admin Notification Center + Custom Report (task spec
// §39). Real Chromium via playwright (existing devDependency, no new browser framework added —
// see scripts/_test-t9-setup-ui.ts for the established pattern this follows). Reuses
// scripts/_test-t9-fixtures.ts's buildFixture() for a realistic company (admin/worker/site/
// period) instead of hand-rolling auth/setup again.
import { chromium, type ConsoleMessage } from 'playwright';
import { prisma } from '../lib/prisma';
import { buildFixture, login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39912';
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function main(): Promise<void> {
  const fx = await buildFixture(BASE);

  // --- Qualification fixtures: a range of statuses so the matrix/notifications have real content ---
  const safety = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'OCCUPATIONAL_SAFETY_CARD' } });
  const welding = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'EN_ISO_9606_1' } });
  const today = new Date();
  const days = (n: number) => new Date(today.getTime() + n * 86400000);

  await prisma.employeeQualification.create({ data: { employeeId: fx.workerA.employeeId, definitionId: safety.id, name: safety.nameEn, expiresOn: days(10), verificationState: 'SELF_REPORTED' } }); // CRITICAL
  await prisma.employeeQualification.create({ data: { employeeId: fx.workerA.employeeId, definitionId: welding.id, name: welding.nameEn, expiresOn: days(200), verificationState: 'VERIFIED' } }); // VALID
  await prisma.employeeQualification.create({ data: { employeeId: fx.workerB.employeeId, definitionId: safety.id, name: safety.nameEn, expiresOn: days(-3), verificationState: 'SELF_REPORTED' } }); // EXPIRED
  // workerDualRole / others intentionally left with no qualifications (MISSING).

  const browser = await chromium.launch({ headless: true });

  // ============================== DESKTOP ==============================
  {
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(fx.admin.username);
    await page.locator('#password').fill(fx.admin.password);
    await page.locator('.login-submit').click();
    await page.waitForURL(/\/admin/, { timeout: 15000 });

    // --- /admin/qualifications ---
    await page.goto(`${BASE}/admin/qualifications`, { waitUntil: 'networkidle' });
    check('matrix: page title visible', await page.locator('h1').first().isVisible());
    const chipButtons = page.locator('.qual-chip-button');
    const chipCount = await chipButtons.count();
    if (chipCount === 0) {
      console.log('DEBUG matrix page text:', (await page.locator('body').innerText()).slice(0, 1500));
    }
    check('matrix: at least one qualification chip rendered', chipCount > 0, chipCount);
    if (chipCount > 0) {
      await chipButtons.first().click();
      const popover = page.locator('.qual-chip-popover').first();
      check('matrix: chip popover opens on click', await popover.isVisible());
      await page.keyboard.press('Escape');
      check('matrix: chip popover closes on Escape', !(await popover.isVisible().catch(() => false)));
    }
    // Filter usability: apply a search filter.
    await page.locator('#qm-search').fill(fx.workerA.employeeId.slice(0, 0)); // no-op fill, ensures field usable
    await page.selectOption('#qm-status', 'CRITICAL');
    await page.getByRole('button', { name: /Apply|Применить/ }).click();
    await page.waitForLoadState('networkidle');
    check('matrix: status filter navigates with query param', page.url().includes('status=CRITICAL'));
    const bodyWidthDesktopMatrix = await page.evaluate(() => document.documentElement.scrollWidth);
    check('matrix desktop: no horizontal overflow', bodyWidthDesktopMatrix <= DESKTOP_VIEWPORT.width + 1, bodyWidthDesktopMatrix);

    // --- /admin/reports/custom ---
    await page.goto(`${BASE}/admin/reports/custom`, { waitUntil: 'networkidle' });
    check('custom report: form visible', await page.locator('form[action="/api/admin/reports/custom/export"]').isVisible());
    await page.locator('#cr-date-from').fill('2020-01-01');
    await page.locator('#cr-date-to').fill('2020-01-02');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: /Generate report|Сформировать отчёт/ }).click()]);
    check('custom report: generates a download (empty-range PDF)', download.suggestedFilename().startsWith('titanor-time-report_') && download.suggestedFilename().endsWith('.pdf'), download.suggestedFilename());
    const bodyWidthDesktopCustom = await page.evaluate(() => document.documentElement.scrollWidth);
    check('custom report desktop: no horizontal overflow', bodyWidthDesktopCustom <= DESKTOP_VIEWPORT.width + 1, bodyWidthDesktopCustom);

    // --- Notification center: bell / drawer / dismiss ---
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500); // initial notification fetch
    const bell = page.locator('.notif-bell-button');
    check('notification bell: visible in header', await bell.isVisible());
    const badge = page.locator('.notif-badge');
    const hasBadge = await badge.isVisible().catch(() => false);
    check('notification bell: badge shows a count when active notifications exist', hasBadge);
    await bell.click();
    const drawer = page.locator('.notif-drawer');
    check('notification drawer: opens on bell click', await drawer.isVisible());
    const drawerItemCount = await page.locator('.notif-drawer-item').count();
    check('notification drawer: shows at least one item', drawerItemCount > 0, drawerItemCount);
    if (drawerItemCount > 0) {
      const beforeCount = await page.locator('.notif-drawer-item').count();
      await page.locator('.notif-drawer-item-dismiss').first().click();
      await page.waitForTimeout(400);
      const afterCount = await page.locator('.notif-drawer-item').count();
      check('notification drawer: dismiss removes the item from the list', afterCount === beforeCount - 1, { beforeCount, afterCount });
    }
    await page.keyboard.press('Escape');
    check('notification drawer: closes on Escape', !(await drawer.isVisible().catch(() => false)));

    // --- Toast on refetch of a genuinely new notification (simulates §29 focus-refresh) ---
    const freshEmployee = await prisma.employee.create({ data: { employeeNumber: `QAT-${Date.now()}`, firstName: 'Toast', lastName: 'Test' } });
    await prisma.employeeQualification.create({ data: { employeeId: freshEmployee.id, definitionId: safety.id, name: safety.nameEn, expiresOn: days(5), verificationState: 'SELF_REPORTED' } });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(800);
    const toastCount = await page.locator('.notif-toast').count();
    check('toast: appears for a genuinely new notification after focus refetch', toastCount > 0, toastCount);
    if (toastCount > 0) {
      const toastCloseButtons = page.locator('.notif-toast-actions button').last();
      await toastCloseButtons.first().click();
    }

    check('desktop: zero console errors across all pages visited', consoleErrors.length === 0, consoleErrors);
    check('desktop: zero uncaught page errors (no hydration crashes)', pageErrors.length === 0, pageErrors);

    await context.close();
  }

  // ============================== MOBILE (390x844) ==============================
  {
    const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const cookie = await login(BASE, fx.admin.username, fx.admin.password);
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);

    await page.goto(`${BASE}/admin/qualifications`, { waitUntil: 'networkidle' });
    // Scoped to this task's own content card, not document.documentElement — the pre-existing
    // .admin-nav-inner (width: max-content, untouched by this task) already overflows a 390px
    // viewport on its own with zero qualifications-matrix content involved (verified directly:
    // it's the only wide element on a plain /admin page too), so a whole-page scrollWidth check
    // would fail on that pre-existing, out-of-scope condition instead of testing this task's UI.
    const matrixCardWidth = await page.evaluate(() => document.querySelector('.setup-card')?.scrollWidth ?? 0);
    check('matrix mobile: own content card has no horizontal overflow', matrixCardWidth <= MOBILE_VIEWPORT.width + 1, matrixCardWidth);

    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const mobileBell = page.locator('.notif-bell-button');
    if (await mobileBell.isVisible()) {
      await mobileBell.click();
      const mobileDrawer = page.locator('.notif-drawer');
      check('notification drawer mobile: opens', await mobileDrawer.isVisible());
      const drawerWidth = await mobileDrawer.evaluate((el) => el.scrollWidth);
      check('notification drawer mobile: drawer panel itself has no horizontal overflow', drawerWidth <= MOBILE_VIEWPORT.width - 15, drawerWidth);
      // Backdrop/outside click closes it too (click far outside the panel).
      await page.mouse.click(5, 5);
      check('notification drawer mobile: closes on outside click', !(await mobileDrawer.isVisible().catch(() => false)));
    }

    check('mobile: zero console errors', consoleErrors.length === 0, consoleErrors);
    await context.close();
  }

  // ============================== Worker profile qualification picker (desktop) ==============================
  {
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const cookie = await login(BASE, fx.workerA.username, fx.workerA.password);
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    await page.goto(`${BASE}/worker/profile`, { waitUntil: 'networkidle' });
    const addButton = page.getByRole('button', { name: /Add card|Добавить карточку/ }).first();
    if (await addButton.isVisible().catch(() => false)) {
      await addButton.click();
      const catalogSelect = page.locator('#qualification-catalog');
      await catalogSelect.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('#qualification-catalog')?.querySelectorAll('option').length !== 1, { timeout: 5000 }).catch(() => {});
      const optionCount = await catalogSelect.locator('option').count();
      check('worker profile: qualification catalog picker populated', optionCount > 1, optionCount);
    } else {
      check('worker profile: add-card button present', false);
    }
    check('worker profile: zero console errors', consoleErrors.length === 0, consoleErrors);
    await context.close();
  }

  await browser.close();

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
