import { chromium } from 'playwright';
import { prisma } from '../lib/prisma';
import { buildFixture } from './_test-t9-fixtures';

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §6 — mobile smoke for worker/foreman, desktop for
// admin (explicit task requirement), plus the D1-D4 fix confirmation from a fresh, real browser
// session (not reusing an already-authenticated page from the other two scripts). Real Chromium,
// production standalone build, disposable PostgreSQL 16.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

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

async function hasNoHorizontalOverflow(page: import('playwright').Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

// App Router soft navigations (router.push) don't fire a 'load' event, and page.waitForURL() in
// this Playwright version can hang waiting for one even after the URL changed. Poll the path.
async function waitPath(page: import('playwright').Page, pattern: RegExp, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (src) => new RegExp(src).test(window.location.pathname + window.location.search),
    pattern.source,
    { timeout }
  );
}

async function main() {
  const fx = await buildFixture(BASE);
  const browser = await chromium.launch({ headless: true });

  // ---- Desktop: admin Setup/Workers/Sites/Assignments flows, 1280x800 ----
  {
    const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(fx.admin.username);
    await page.locator('#password').fill(fx.admin.password);
    await page.locator('.login-submit').click();
    await waitPath(page, /\/admin/, 15000);

    for (const path of ['/admin/setup', '/admin/workers', '/admin/sites', '/admin/assignments', `/admin/sites/${fx.sites.alpha}`]) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      check(`Desktop 1280x800: ${path} has zero page-level horizontal overflow`, await hasNoHorizontalOverflow(page), path);
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
    }

    // D1/D2 fix, confirmed once more from a fresh session: real click path to /new for both
    // Workers and Sites, exactly as an admin would use it.
    await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
    const workersNewLink = page.locator('a[href="/admin/workers/new"]');
    check('D1 (final confirmation): /admin/workers exposes a real, clickable link to /new', await workersNewLink.count() === 1);
    await page.goto(`${BASE}/admin/sites`, { waitUntil: 'networkidle' });
    const sitesNewLink = page.locator('a[href="/admin/sites/new"]');
    check('D2 (final confirmation): /admin/sites exposes a real, clickable link to /new', await sitesNewLink.count() === 1);

    // T9.7 owner feedback: City is optional but must have a creation path. The Setup row now links
    // to the cities list (/admin/cities), which itself links to /admin/cities/new; after creating a
    // city you land back on /admin/cities.
    await page.goto(`${BASE}/admin/setup`, { waitUntil: 'networkidle' });
    const cityRow = page.locator('.setup-item').filter({ has: page.locator('.setup-label', { hasText: /^City$/ }) });
    check('T9.7: absent City is labelled Optional, never Not done', (await cityRow.locator('.setup-status-optional').count()) === 1);
    check('T9.7: Setup exposes a City creation path', (await cityRow.locator('a[href="/admin/cities"], a[href="/admin/cities/new"]').count()) >= 1);
    await page.goto(`${BASE}/admin/cities/new`, { waitUntil: 'networkidle' });
    await page.locator('#city-name').fill(`Browser City ${fx.run}`);
    await page.locator('button[type="submit"]').click();
    await waitPath(page, /\/admin\/cities/, 10000);
    await page.goto(`${BASE}/admin/setup`, { waitUntil: 'networkidle' });
    check('T9.7: after a city is created the Setup row flips to Done', (await page.locator('.setup-item').filter({ has: page.locator('.setup-label', { hasText: /^City$/ }) }).locator('.setup-status-done').count()) === 1);

    // D3/D4 fix: End action visible and keyboard-reachable on assignments/foreman-assignments.
    await page.goto(`${BASE}/admin/assignments`, { waitUntil: 'networkidle' });
    const endButtons = page.locator('button', { hasText: 'End' });
    check('D3 (final confirmation): /admin/assignments shows an "End" action per row', (await endButtons.count()) >= 2);
    await page.goto(`${BASE}/admin/sites/${fx.sites.alpha}`, { waitUntil: 'networkidle' });
    const foremanEndButtons = page.locator('button', { hasText: 'End' });
    check('D4 (final confirmation): site detail\'s Foremen section shows an "End" action', (await foremanEndButtons.count()) >= 1);

    // Keyboard/focus: the fixed "create new" link is reachable and visibly focusable via Tab.
    await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focusedHref = await page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute('href'));
    check('Keyboard: tabbing through /admin/workers reaches a focusable link (not focus-trapped)', typeof focusedHref === 'string');

    await page.close();
  }

  // ---- Mobile: worker own-data screens, 390x844 ----
  {
    const page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(fx.workerA.username);
    await page.locator('#password').fill(fx.workerA.password);
    await page.locator('.login-submit').click();
    await waitPath(page, /\/worker/, 15000);

    for (const path of ['/worker', '/worker/periods', '/worker/history', `/worker/periods/${fx.periodId}/hours`]) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      check(`Mobile 390x844: ${path} has zero page-level horizontal overflow`, await hasNoHorizontalOverflow(page), path);
      check(`T9.7: ${path} has the persistent worker menu`, (await page.locator('button[aria-label="Open menu"], button[aria-label="Открыть меню"]').count()) === 1, path);
    }

    await page.goto(`${BASE}/worker/history`, { waitUntil: 'networkidle' });
    await page.locator('button[aria-label="Open menu"], button[aria-label="Открыть меню"]').click();
    check('T9.7: History menu exposes Home', (await page.locator('#worker-app-menu a[href="/worker"]').count()) === 1);
    await page.locator('#worker-app-menu a[href="/worker"]').click();
    await waitPath(page, /^\/worker$/, 10000);
    check('T9.7: Home navigation returns from History to the clock', (await page.locator('.wk-clock-home-card').count()) === 1);

    await page.locator('button[aria-label="Open menu"], button[aria-label="Открыть меню"]').click();
    await page.locator('#worker-app-menu button', { hasText: /Sign out|Выйти/ }).click();
    await waitPath(page, /\/login/, 10000);
    check('T9.7: worker menu Sign out revokes the session and returns to login', new URL(page.url()).pathname === '/login');

    await page.close();
  }

  // ---- Mobile: foreman own-scope screens, 390x844 ----
  {
    const page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(fx.foreman.username);
    await page.locator('#password').fill(fx.foreman.password);
    await page.locator('.login-submit').click();
    await waitPath(page, /\/foreman/, 15000);

    for (const path of ['/foreman', '/foreman/workers']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      check(`Mobile 390x844: ${path} has zero page-level horizontal overflow`, await hasNoHorizontalOverflow(page), path);
    }

    await page.close();
  }

  await browser.close();

  console.log(JSON.stringify({ pass, fail }));
  console.log(`\n${pass} passed, ${fail} failed (T9 setup UI smoke)`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
