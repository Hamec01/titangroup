import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import { chromium } from 'playwright';
import { prisma } from '../lib/prisma';
import { createPeriod } from '../lib/periods';

// Regression for the offline-shell locale clobber: opening the cached PWA shell used to overwrite
// the stored RU/EN/FI choice with the RU placeholder (AppLocaleProvider persisted the transient
// default before OfflineShellClient's own effect read localStorage). Fix: AppLocaleProvider gained
// `persist` and the offline shell passes `persist={false}`.
//
// Verifies, for each of RU / EN / legacy-FI(→RU): after a genuine cold restart (real process close
// + relaunch, real setOffline), the cached shell renders in the user's language AND the stored
// locale key is left intact. Touches only locale rendering — no clock/outbox/IDB/device-binding.
// Production standalone build + disposable PostgreSQL 16.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39641';
const STORAGE_KEY = 'titanor-time-locale';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

// A string that renders on the offline shell's clocked-out screen, per locale. `wk-main-action`'s
// aria-label is `t.checkIn` — 'Check in' (EN) / 'Отметить приход' (RU).
const EXPECT: Record<string, { ariaLabel: RegExp; storedAfter: string; periodYear: number }> = {
  RU: { ariaLabel: /отметить приход/i, storedAfter: 'RU', periodYear: 2213 },
  EN: { ariaLabel: /check in/i, storedAfter: 'EN', periodYear: 2214 },
  FI: { ariaLabel: /отметить приход/i, storedAfter: 'RU', periodYear: 2215 } // legacy FI folds to RU everywhere
};

async function makeWorker(localeValue: 'EN' | 'RU' | 'FI') {
  const tag = randomUUID().slice(0, 6);
  const year = EXPECT[localeValue].periodYear;
  const admin = await prisma.user.create({ data: { username: `admin-loc-${tag}`, status: 'ACTIVE', locale: 'EN' } });
  await prisma.userRole.create({ data: { userId: admin.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } })).id } });
  const site = await prisma.workSite.create({ data: { name: `Loc Site ${tag}` } });
  const password = `Passw0rd-loc-${tag}`;
  const employee = await prisma.employee.create({ data: { employeeNumber: `TEST-LOC-${tag}`, firstName: 'Loc', lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: admin.id } });
  // User.locale is a raw string column; 'FI' is a legacy value the app folds to RU.
  const user = await prisma.user.create({ data: { username: `worker-loc-${tag}`, status: 'ACTIVE', locale: localeValue, employeeId: employee.id, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } })).id } });
  const period = await createPeriod({ startDate: new Date(`${year}-01-01T00:00:00.000Z`), endDate: new Date(`${year}-01-14T00:00:00.000Z`), openedByUserId: admin.id, requestId: randomUUID() });
  if ('code' in period) throw new Error(`period: ${period.code}`);
  return { username: user.username, password };
}

async function runLocale(localeValue: keyof typeof EXPECT) {
  const { username, password } = await makeWorker(localeValue);
  const profileDir = mkdtempSync(path.join(tmpdir(), `titanor-shell-locale-${localeValue}-`));
  const expect = EXPECT[localeValue];
  try {
    // Session 1 — online login (writes the resolved locale to localStorage), warm the shell.
    let ctx = await chromium.launchPersistentContext(profileDir, { headless: true, permissions: ['geolocation'], geolocation: { latitude: 60.1699, longitude: 24.9384 } });
    ctx.setDefaultTimeout(60_000);
    ctx.setDefaultNavigationTimeout(60_000);
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    ctx.on('serviceworker', () => {});
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('.login-submit').click();
    await page.waitForURL(/\/worker/, { timeout: 20_000 });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    await page.waitForFunction(
      () => new Promise((resolve) => {
        const req = indexedDB.open('titanor-time-outbox');
        req.onsuccess = () => {
          const g = req.result.transaction(['deviceState'], 'readonly').objectStore('deviceState').get('singleton');
          g.onsuccess = () => resolve((g.result?.contextAssignments?.length ?? 0) > 0);
        };
      }),
      { timeout: 15_000 }
    );
    await page.waitForTimeout(2000);
    const storedOnline = await page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEY);
    check(`${localeValue}: online visit persisted the resolved locale`, storedOnline === expect.storedAfter, storedOnline);
    await ctx.close();

    // Session 2 — full relaunch, genuinely offline, cold navigation to /worker.
    ctx = await chromium.launchPersistentContext(profileDir, { headless: true, permissions: ['geolocation'], geolocation: { latitude: 60.1699, longitude: 24.9384 } });
    ctx.setDefaultTimeout(60_000);
    ctx.setDefaultNavigationTimeout(60_000);
    ctx.on('serviceworker', () => {});
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker`, { waitUntil: 'domcontentloaded' });
    const mainAction = page.locator('.wk-main-action');
    await mainAction.waitFor({ state: 'visible', timeout: 15_000 });
    const ariaLabel = (await mainAction.getAttribute('aria-label')) ?? '';
    check(`${localeValue}: cold offline shell renders in the expected language`, expect.ariaLabel.test(ariaLabel), { ariaLabel, expected: String(expect.ariaLabel) });
    const storedOffline = await page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEY);
    check(`${localeValue}: opening the offline shell did not clobber the stored locale`, storedOffline === expect.storedAfter, { storedOffline, expected: expect.storedAfter });
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    check(`${localeValue}: <html lang> matches`, htmlLang === (expect.storedAfter === 'RU' ? 'ru' : 'en'), htmlLang);
    await ctx.close();
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function main() {
  for (const loc of ['RU', 'EN', 'FI'] as (keyof typeof EXPECT)[]) {
    await runLocale(loc);
  }
  console.log(JSON.stringify({ pass, fail }));
  console.log(`\n${pass} passed, ${fail} failed (offline shell locale)`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
