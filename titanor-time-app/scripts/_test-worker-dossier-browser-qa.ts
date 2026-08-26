// Worker Dossier feature (2026-08-26, task spec §59) — real Chromium browser QA via playwright
// (existing devDependency, same pattern as _test-qualifications-browser-qa.ts). Assumes a server
// is already running at TEST_BASE_URL against a disposable DB seeded by
// scripts/_qa-seed-worker-dossier.ts (qa_admin / qa_worker, password QaPassw0rd!23).
import { chromium, type ConsoleMessage } from 'playwright';
import { prisma } from '../lib/prisma';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3931';
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PASSWORD = 'QaPassw0rd!23';

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
  const employee = await prisma.employee.findFirstOrThrow({ where: { employeeNumber: 'QA-0001' } });
  const browser = await chromium.launch({ headless: true });

  // ============================== DESKTOP — ADMIN ==============================
  {
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    const cookie = await login(BASE, 'qa_admin', PASSWORD);
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);

    await page.goto(`${BASE}/admin/workers/${employee.id}/profile`, { waitUntil: 'networkidle' });
    check('admin profile: photo visible', await page.locator('img[src*="/profile/photo"]').first().isVisible());
    check('admin profile: contact email field present', await page.locator('#admin-profile-contact-email').isVisible());
    const emailValue = await page.locator('#admin-profile-contact-email').inputValue();
    check('admin profile: contact email pre-filled from fixture', emailValue === 'qa-worker@example.com', emailValue);
    check('admin profile: address street field present and filled', (await page.locator('#admin-profile-address-street').inputValue()) === 'Testikatu 1');

    // HETU masked by default, Show reveals it.
    const hetuField = page.locator('#admin-profile-personal-identity-code-field');
    const maskedText = await hetuField.first().innerText();
    check('admin profile: HETU shown masked by default', maskedText.includes('••••'), maskedText);
    const showButton = page.getByRole('button', { name: /^Show$/ });
    check('admin profile: Show button present', await showButton.isVisible());
    await showButton.click();
    await page.waitForTimeout(400);
    const revealedText = await hetuField.first().innerText();
    check('admin profile: HETU reveals the real value on click', revealedText.includes('030785-2464'), revealedText);
    const hideButton = page.getByRole('button', { name: /^Hide$/ });
    check('admin profile: button becomes "Hide" after reveal', await hideButton.isVisible());
    await hideButton.click();
    await page.waitForTimeout(200);
    const rehiddenText = await hetuField.first().innerText();
    check('admin profile: HETU re-masks after Hide', rehiddenText.includes('••••') && !rehiddenText.includes('030785-2464'), rehiddenText);

    // Qualification card: image visible, Edit opens metadata form, Verify present for the admin-created card.
    const qualCards = page.locator('.qual-card');
    const qualCardCount = await qualCards.count();
    check('admin profile: at least 2 qualification cards rendered', qualCardCount >= 2, qualCardCount);
    const safetyCard = qualCards.filter({ hasText: 'Occupational Safety Card' }).first();
    check('admin profile: safety card image thumbnail visible', await safetyCard.locator('img').first().isVisible());
    check('admin profile: safety card shows Verified badge (admin-created)', (await safetyCard.innerText()).includes('Verified'));
    await safetyCard.getByRole('button', { name: 'Edit' }).click();
    check('admin profile: Edit opens the metadata form (Save button appears)', await safetyCard.getByRole('button', { name: 'Save' }).isVisible());
    await safetyCard.getByRole('button', { name: 'Cancel' }).click();

    const customCard = qualCards.filter({ hasText: 'Custom QA Certificate' }).first();
    check('admin profile: custom card shows Self-reported badge', (await customCard.innerText()).includes('Self-reported'));
    check('admin profile: custom card has a Verify button', await customCard.getByRole('button', { name: 'Verify' }).isVisible());

    // Dossier download.
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('link', { name: /Download dossier/ }).click()]);
    const suggested = download.suggestedFilename();
    check('admin profile: dossier download filename matches convention', suggested.startsWith('titanor-worker-dossier_') && suggested.endsWith('.pdf'), suggested);

    const bodyWidthDesktop = await page.evaluate(() => document.documentElement.scrollWidth);
    check('admin profile desktop: no horizontal overflow', bodyWidthDesktop <= DESKTOP_VIEWPORT.width + 1, bodyWidthDesktop);

    // Regression: qualifications matrix still renders.
    await page.goto(`${BASE}/admin/qualifications`, { waitUntil: 'networkidle' });
    check('regression: qualifications matrix still renders a chip', (await page.locator('.qual-chip-button').count()) > 0);

    check('admin desktop: zero console errors', consoleErrors.length === 0, consoleErrors);
    check('admin desktop: zero uncaught page errors', pageErrors.length === 0, pageErrors);
    await context.close();
  }

  // ============================== DESKTOP — WORKER OWN ==============================
  {
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const cookie = await login(BASE, 'qa_worker', PASSWORD);
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    await page.goto(`${BASE}/worker/profile`, { waitUntil: 'networkidle' });

    check('worker profile: contact email field present', await page.locator('#profile-contact-email').isVisible());
    check('worker profile: HETU field shows masked value', (await page.locator('#profile-personal-identity-code-field').first().innerText()).includes('••••'));
    check('worker profile: no "Download dossier" link (admin-only)', (await page.getByRole('link', { name: /Download dossier/ }).count()) === 0);

    const qualCards = page.locator('.qual-card');
    const customCard = qualCards.filter({ hasText: 'Custom QA Certificate' }).first();
    check('worker profile: own custom card visible', await customCard.isVisible());
    check('worker profile: own card has no Verify button (workers cannot self-verify)', (await customCard.getByRole('button', { name: 'Verify' }).count()) === 0);
    check('worker profile: own card has an Edit button', await customCard.getByRole('button', { name: 'Edit' }).isVisible());

    const bodyWidthDesktop = await page.evaluate(() => document.documentElement.scrollWidth);
    check('worker profile desktop: no horizontal overflow', bodyWidthDesktop <= DESKTOP_VIEWPORT.width + 1, bodyWidthDesktop);
    check('worker desktop: zero console errors', consoleErrors.length === 0, consoleErrors);
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

    const cookie = await login(BASE, 'qa_admin', PASSWORD);
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    await page.goto(`${BASE}/admin/workers/${employee.id}/profile`, { waitUntil: 'networkidle' });
    const cardWidth = await page.evaluate(() => document.querySelector('.setup-card, main')?.scrollWidth ?? document.documentElement.scrollWidth);
    check('admin profile mobile: main content has no horizontal overflow', cardWidth <= MOBILE_VIEWPORT.width + 20, cardWidth);
    check('admin profile mobile: qualification card visible', await page.locator('.qual-card').first().isVisible());

    check('mobile: zero console errors', consoleErrors.length === 0, consoleErrors);
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
