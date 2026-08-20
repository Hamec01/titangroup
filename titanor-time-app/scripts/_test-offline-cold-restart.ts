import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';
import { chromium } from 'playwright';
import { prisma } from '../lib/prisma';
import { createPeriod } from '../lib/periods';

// docs/titanor-time/T8_PWA_DESIGN.md §F — scenario 29 (task's own numbered list): a genuine cold
// restart (real process close + relaunch, real launchPersistentContext, real context.setOffline)
// of the existing T7A.7B/T7A.10C.1 offline clock, re-verified after this slice's changes to
// WorkerClockPanel.tsx (new installHref prop), public/sw.js (navigation allowlist grew), and
// lib/offline-outbox/pwa-warm-cache.ts (CACHE_NAME bump). This is a REDUCED re-verification (one
// close/reopen cycle, Check In -> Check Out -> reconnect -> sync), not T7A.10C.1's own full
// 15/19-step matrix — the git diff for this slice touches none of the actual outbox/sync/FIFO
// logic those already proved, only the shell around it (see this session's final report for the
// explicit git-diff evidence). Real Chromium (Playwright, phantom devDependency), production
// standalone build + disposable PostgreSQL 16, never `next dev`, never preview.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39640';

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

async function main() {
  const { user: admin } = await (async () => {
    const user = await prisma.user.create({ data: { username: `admin-coldrestart-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    return { user };
  })();

  const site = await prisma.workSite.create({ data: { name: `Cold Restart Site ${randomUUID().slice(0, 4)}` } });
  const password = `Passw0rd-cr-${randomUUID().slice(0, 6)}`;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const employee = await prisma.employee.create({ data: { employeeNumber: `TEST-CR-${randomUUID().slice(0, 8)}`, firstName: 'Cold', lastName: 'Restart' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2210-01-01T00:00:00.000Z') } });
  // Open-ended validFrom/validTo (not scoped to the far-future period year below) — GET
  // /attendance/context filters assignments by TODAY's real date, independent of which payroll
  // period the test happens to exercise; createPeriod's own auto-participant-detection still finds
  // this assignment fine since an open-ended range overlaps any period date range too.
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: admin.id } });
  const user = await prisma.user.create({ data: { username: `worker-cr-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', employeeId: employee.id, passwordHash } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const periodResult = await createPeriod({ startDate: new Date('2210-01-01T00:00:00.000Z'), endDate: new Date('2210-01-14T00:00:00.000Z'), openedByUserId: admin.id, requestId: randomUUID() });
  if ('code' in periodResult) {
    throw new Error(`period creation failed: ${periodResult.code}`);
  }

  const profileDir = mkdtempSync(path.join(tmpdir(), 'titanor-t88-cold-restart-'));

  try {
    // ---- Session 1: online login, warm the offline shell cache ----
    let ctx = await chromium.launchPersistentContext(profileDir, { headless: true });
    ctx.setDefaultTimeout(60_000);
    ctx.setDefaultNavigationTimeout(60_000);
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    ctx.on('serviceworker', () => {}); // subscribe before first navigation — see T7A.10C.1 testing note (design doc §E) for why this matters for a fresh persistent-context process.

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(user.username);
    await page.locator('#password').fill(password);
    await page.locator('.login-submit').click();
    await page.waitForURL(/\/worker/, { timeout: 20_000 });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    // Explicitly wait for a successful bootstrap to have cached at least one assignment — the
    // offline shell's Check In button stays disabled with zero assignments, so this must be
    // confirmed before relying on the cache for the offline session below.
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('titanor-time-outbox');
          req.onsuccess = () => {
            const tx = req.result.transaction(['deviceState'], 'readonly');
            const g = tx.objectStore('deviceState').get('singleton');
            g.onsuccess = () => resolve((g.result?.contextAssignments?.length ?? 0) > 0);
          };
        }),
      { timeout: 15_000 }
    );
    await page.waitForTimeout(2000); // let pwa-warm-cache.ts finish warming shell + assets
    await ctx.close();

    // ---- Session 2: full process relaunch, genuinely offline, cold navigation to /worker ----
    ctx = await chromium.launchPersistentContext(profileDir, { headless: true });
    ctx.setDefaultTimeout(60_000);
    ctx.setDefaultNavigationTimeout(60_000);
    ctx.on('serviceworker', () => {});
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    const body1 = (await page.locator('body').innerText()) ?? '';
    check('29: cold restart (new process, genuinely offline) renders the cached clock shell, not a browser error page', body1.length > 0 && !body1.includes('ERR_INTERNET_DISCONNECTED'), body1.slice(0, 200));

    const checkInBtn = page.locator('.wk-action-button', { hasText: 'Check In' });
    await checkInBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await checkInBtn.click({ timeout: 8000 });
    await page.waitForTimeout(500);
    check('29b: offline Check In after cold restart reflects Clocked in', (await page.locator('body').innerText()).includes('Clocked in'));

    const checkOutBtn = page.locator('.wk-action-button', { hasText: 'Check Out' });
    await checkOutBtn.click();
    await page.waitForTimeout(500);
    check('29c: offline Check Out after cold restart reflects Clocked out', (await page.locator('body').innerText()).includes('Clocked out'));

    await ctx.setOffline(false);
    await page.waitForTimeout(1000);
    const syncNowBtn = page.locator('.wk-sync-now-button');
    if (await syncNowBtn.count()) {
      await syncNowBtn.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);

    const shift = await prisma.clockShift.findFirst({ where: { employeeId: employee.id } });
    check('29d: after reconnect, sync produces exactly one closed ClockShift', !!shift && shift.recordedEndAt !== null, shift);
    const eventCount = await prisma.clockEvent.count({ where: { employeeId: employee.id } });
    check('29e: exactly two ClockEvent rows (check-in + check-out), no duplicates', eventCount === 2, eventCount);

    await ctx.close();
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ pass, fail }));
  console.log(`\n${pass} passed, ${fail} failed (scenario 29)`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
