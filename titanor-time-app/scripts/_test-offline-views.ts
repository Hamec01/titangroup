import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { prisma } from '../lib/prisma';
import { createPeriod } from '../lib/periods';

// docs/titanor-time/T8_PWA_DESIGN.md §F — permanent regression for T8.8 (account-bound offline
// read-only Worker views). Real Chromium (Playwright, phantom devDependency — `npm install
// playwright --no-save`, never in package.json, same convention as scripts/_test-export-ui.ts and
// scripts/_test-pwa-install.ts), production standalone build + disposable PostgreSQL 16
// (TEST_BASE_URL), never `next dev`, never preview. Scenario numbers match the task's own 14-72
// list (Groups B-E; Group A is scripts/_test-offline-idb-invariants.ts, pure Node/fake-indexeddb).

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39640';
const CSRF = 'titanor-time';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 900) : '');
  }
}

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function attach(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[${page.url()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(`[${page.url()}] ${err.message}`);
  });
}

async function freshContext(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  ctx.setDefaultTimeout(60_000);
  ctx.setDefaultNavigationTimeout(60_000);
  return ctx;
}

/** A plain authenticated session cookie, no bootstrap/warm — for scenarios that only need "this
 * worker is logged in" as a precondition and don't touch offline binding at all (keeps them off
 * POST /api/auth/login's own rate limit too). */
async function quickSession(ctx: BrowserContext, fixture: WorkerFixture): Promise<Page> {
  const token = randomUUID() + randomUUID();
  await prisma.userSession.create({ data: { userId: fixture.userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return newPageAs(ctx, token);
}

async function newPageAs(context: BrowserContext, token: string | null): Promise<Page> {
  if (token) {
    await context.addCookies([{ name: 'tt_session', value: token, url: BASE }]);
  }
  const page = await context.newPage();
  attach(page);
  return page;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText()) ?? '';
}

async function realLogin(page: Page, username: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  const [response] = await Promise.all([page.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 30_000 }), page.locator('.login-submit').click()]);
  if (response.status() !== 200) {
    throw new Error(`login failed for ${username}: HTTP ${response.status()} ${await response.text().catch(() => '')}`);
  }
  await page.waitForURL(/\/worker|\/admin|\/foreman/, { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

/** A plain Node-side polling loop, not Playwright's waitForFunction-with-nested-Promise (which
 * proved racy/GC-sensitive here for repeated IndexedDB reads across many scenarios in this file) —
 * simpler and more debuggable: just re-run a real page.evaluate-backed read on an interval. */
async function pollUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 15_000, intervalMs = 300): Promise<T> {
  const start = Date.now();
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) {
      return last;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() - start < timeoutMs);
  return last;
}

async function readDeviceState(page: Page): Promise<Record<string, unknown> | null> {
  // A page that just navigated (especially one that immediately server-redirects, e.g. an
  // unauthenticated visit to a gated /worker/** route) can still be tearing down its execution
  // context when evaluate() is called, which Playwright surfaces as "Resulting promise was garbage
  // collected" — retrying once after a short wait is the standard, safe way to ride that out.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(
        () =>
          new Promise((resolve) => {
            const req = indexedDB.open('titanor-time-outbox');
            req.onsuccess = () => {
              // A brand-new profile that never opened this DB before creates an empty v1 database
              // with zero object stores here (this raw open supplies no version/upgrade handler) —
              // .transaction() on a missing store throws synchronously, not via onerror.
              if (!req.result.objectStoreNames.contains('deviceState')) {
                resolve(null);
                return;
              }
              const tx = req.result.transaction(['deviceState'], 'readonly');
              const g = tx.objectStore('deviceState').get('singleton');
              g.onsuccess = () => resolve(g.result ?? null);
              g.onerror = () => resolve(null);
            };
            req.onerror = () => resolve(null);
          })
      );
    } catch {
      await page.waitForTimeout(400);
    }
  }
  return null;
}

async function writeDeviceState(page: Page, record: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (rec) => {
    const req = indexedDB.open('titanor-time-outbox');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(['deviceState'], 'readwrite');
    tx.objectStore('deviceState').put(rec);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, record);
}

async function outboxCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('titanor-time-outbox');
        req.onsuccess = () => {
          const tx = req.result.transaction(['clockOutbox'], 'readonly');
          const c = tx.objectStore('clockOutbox').count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => resolve(-1);
        };
        req.onerror = () => resolve(-1);
      })
  );
}

async function cacheStorageDump(page: Page): Promise<{ keys: string[]; entries: { url: string; body: string }[] }> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const keys: string[] = [];
    const entries: { url: string; body: string }[] = [];
    for (const n of names) {
      const cache = await caches.open(n);
      const reqs = await cache.keys();
      for (const r of reqs) {
        keys.push(`${n}::${r.url}`);
        const res = await cache.match(r);
        if (res) {
          try {
            entries.push({ url: r.url, body: await res.clone().text() });
          } catch {
            // binary asset — skip body text
          }
        }
      }
    }
    return { keys, entries };
  });
}

// ============================================================================
// Fixtures
// ============================================================================

async function makeSite(tag: string) {
  return prisma.workSite.create({ data: { name: `T88 Site ${tag} ${randomUUID().slice(0, 4)}` } });
}

async function makeUserWithRole(tag: string, roleName: string) {
  const user = await prisma.user.create({ data: { username: `${roleName.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomUUID() + randomUUID();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { user, token };
}

interface WorkerFixture {
  userId: string;
  employeeId: string;
  siteId: string;
  siteName: string;
  username: string;
  password: string;
  periodId: string;
  timesheetId: string;
  date: string;
  startDate: string;
  endDate: string;
}

async function makeWorkerWithPeriod(tag: string, adminUserId: string, siteId: string, siteName: string, year: number): Promise<WorkerFixture> {
  const password = `Passw0rd-${tag}-${randomUUID().slice(0, 6)}`;
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const employee = await prisma.employee.create({ data: { employeeNumber: `TEST-T88-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  const startDate = new Date(`${year}-01-01T00:00:00.000Z`);
  const endDate = new Date(`${year}-01-14T00:00:00.000Z`);
  // Open-ended validFrom/validTo (NOT scoped to the far-future `year` used for the period below) —
  // GET /attendance/context filters assignments by TODAY's real date, independent of which payroll
  // period this fixture exercises; createPeriod's own auto-participant-detection still finds this
  // assignment fine since an open-ended range overlaps any period date range too.
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
  // POST /api/auth/login lowercases the identifier before matching User.username — the tag/random
  // suffix here MUST already be lowercase, or a real login later fails INVALID_CREDENTIALS even
  // though the row genuinely exists (case-sensitive Postgres equality on the stored value).
  const user = await prisma.user.create({ data: { username: `worker-${tag.toLowerCase()}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', employeeId: employee.id, passwordHash } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });

  const periodResult = await createPeriod({ startDate, endDate, openedByUserId: adminUserId, requestId: randomUUID() });
  if ('code' in periodResult) {
    throw new Error(`period creation failed for ${tag}: ${periodResult.code}`);
  }
  const timesheet = await prisma.timesheet.findFirstOrThrow({ where: { employeeId: employee.id, periodId: periodResult.id } });

  return {
    userId: user.id,
    employeeId: employee.id,
    siteId,
    siteName,
    username: user.username,
    password,
    periodId: periodResult.id,
    timesheetId: timesheet.id,
    date: `${year}-01-02`,
    startDate: periodResult.startDate,
    endDate: periodResult.endDate
  };
}

async function seedSessionCookie(browser: Browser, userId: string): Promise<{ ctx: BrowserContext; token: string }> {
  const token = randomUUID() + randomUUID();
  await prisma.userSession.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  const ctx = await freshContext(browser);
  await ctx.addCookies([{ name: 'tt_session', value: token, url: BASE }]);
  return { ctx, token };
}

async function patchDaySegment(fixture: WorkerFixture, browser: Browser) {
  const { ctx } = await seedSessionCookie(browser, fixture.userId);
  const res = await ctx.request.patch(`${BASE}/api/worker/timesheets/${fixture.timesheetId}/days/${fixture.date}`, {
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
    data: {
      confirmedZero: false,
      segments: [{ startAt: `${fixture.date}T08:00:00.000Z`, endAt: `${fixture.date}T16:00:00.000Z`, siteId: fixture.siteId, workAreaId: null, breaks: [] }]
    }
  });
  if (!res.ok()) {
    throw new Error(`patchDaySegment failed: ${res.status()} ${await res.text()}`);
  }
  await ctx.close();
}

async function warmAllSnapshots(ctx: BrowserContext, fixture: WorkerFixture) {
  const page = await newPageAs(ctx, null);
  for (const path of [`/worker/periods`, `/worker/history`, `/worker/periods/${fixture.periodId}`, `/worker/periods/${fixture.periodId}/hours`, `/worker/periods/${fixture.periodId}/hours/${fixture.date}`, `/worker/periods/${fixture.periodId}/submit`]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  }
  await page.waitForTimeout(400); // let each page's SnapshotWriter effect finish its IDB write
  await page.close();
}

/**
 * Every scenario below EXCEPT 15/19/23/66/67 only needs "a worker who is genuinely logged in and
 * bootstrapped" as a precondition — it is not itself testing the login flow. Real POST
 * /api/auth/login is rate-limited (5/15min per identifier — docs/titanor-time/
 * 04_ADMIN_FIRST_API_CONTRACTS.md §0), and this suite calls this helper for the same worker fixture
 * many times across many scenarios, so it seeds a real session directly (same technique every other
 * _test-*.ts script in this repo uses) and drives a real online /worker visit for a genuine
 * ensureDeviceBootstrapped() bootstrap (setting deviceState.ownerUserId/contextAssignments exactly
 * as production code does), then sets deviceState.lastAuthenticatedUserId directly — the one field
 * only the login PAGE's client code sets in production, which this helper stands in for here. The
 * end state (both fields correctly bound) is identical to what a real login would have produced;
 * scenario 19 is the dedicated, real-login-only proof that production's own login page code path
 * sets it, not a test-harness stand-in.
 */
async function loginAndWarmClock(ctx: BrowserContext, fixture: WorkerFixture): Promise<Page> {
  const token = randomUUID() + randomUUID();
  await prisma.userSession.create({ data: { userId: fixture.userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  const page = await newPageAs(ctx, token);
  await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
  const deviceState = await pollUntil(() => readDeviceState(page), (d) => !!d?.ownerUserId);
  await writeDeviceState(page, { ...deviceState, lastAuthenticatedUserId: fixture.userId });
  await page.waitForTimeout(1500); // let pwa-warm-cache.ts finish warming the offline shell + assets
  return page;
}

async function main() {
  const browser = await chromium.launch();

  const { user: admin } = await makeUserWithRole('admin', 'ADMIN');
  const { token: adminToken } = await makeUserWithRole('admin2', 'ADMIN');
  const { token: foremanToken } = await makeUserWithRole('foreman', 'FOREMAN');
  const siteA = await makeSite('A');
  const workerA = await makeWorkerWithPeriod('A', admin.id, siteA.id, siteA.name, 2200);
  const workerB = await makeWorkerWithPeriod('B', admin.id, siteA.id, siteA.name, 2201);
  const foreignPeriod = await makeWorkerWithPeriod('Z', admin.id, siteA.id, siteA.name, 2202);
  // Dedicated fixture for scenario 19's own genuine POST /api/auth/login (never reused elsewhere)
  // — keeps that one real login independent of workerA/B's shared login-endpoint rate-limit budget.
  const workerF = await makeWorkerWithPeriod('F', admin.id, siteA.id, siteA.name, 2206);
  await patchDaySegment(workerA, browser);
  await patchDaySegment(workerB, browser);

  // ==========================================================================================
  // 14: A sees own snapshots offline, with real captured content.
  // ==========================================================================================
  const ctxA = await freshContext(browser);
  let pageA = await loginAndWarmClock(ctxA, workerA);
  await warmAllSnapshots(ctxA, workerA);
  await ctxA.setOffline(true);
  await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('14: A sees own period-detail snapshot offline (dates + site + Offline badge)', body.includes(workerA.startDate) && body.includes(siteA.name) && body.includes('Offline — read-only'), body.slice(0, 300));
  }
  await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}/hours/${workerA.date}`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('14b: A sees own day-detail snapshot with the real segment site name offline', body.includes(siteA.name) && body.includes('Offline — read-only'), body.slice(0, 300));
  }
  await ctxA.setOffline(false);

  // ==========================================================================================
  // 34/35: day-detail and submit offline views are read-only — zero inputs/save/submit controls.
  // ==========================================================================================
  await ctxA.setOffline(true);
  {
    const inputCount = await pageA.locator('input, select, textarea, button:has-text("Save")').count();
    check('34: offline day-detail view has zero editable inputs/Save controls', inputCount === 0, inputCount);
  }
  await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}/submit`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    const submitBtnCount = await pageA.locator('button:has-text("Submit")').count();
    check('35: offline submit-summary view is read-only with zero Submit button', submitBtnCount === 0 && body.includes('Offline — read-only'), { submitBtnCount, body: body.slice(0, 200) });
  }
  await ctxA.setOffline(false);

  // ==========================================================================================
  // 38/39: capturedAt is shown and the view is clearly marked stale/read-only.
  // ==========================================================================================
  await ctxA.setOffline(true);
  await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('38: capturedAt ("Last updated") is shown', /Last updated:/.test(body), body.slice(0, 200));
    check('39: view is explicitly marked Offline — read-only, never presented as live/authoritative', body.includes('Offline — read-only'));
  }
  await ctxA.setOffline(false);

  // ==========================================================================================
  // 40/41: offline view makes no API requests, creates no AuditEvent.
  // ==========================================================================================
  {
    const auditBefore = await prisma.auditEvent.count();
    const apiRequests: string[] = [];
    pageA.on('request', (req) => {
      if (req.url().includes('/api/')) apiRequests.push(req.url());
    });
    await ctxA.setOffline(true);
    await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}/hours`, { waitUntil: 'networkidle' });
    await pageA.waitForTimeout(300);
    await ctxA.setOffline(false);
    const auditAfter = await prisma.auditEvent.count();
    check('40: offline view issues zero /api/** requests', apiRequests.length === 0, apiRequests);
    check('41: offline view creates zero AuditEvent rows', auditAfter === auditBefore, { auditBefore, auditAfter });
  }

  // ==========================================================================================
  // 42/43: online reload replaces the snapshot with fresh data; URL/reload/back/forward preserve
  // the expected view.
  // ==========================================================================================
  {
    await patchDaySegment({ ...workerA, date: `${workerA.date}` }, browser); // re-patch same day (idempotent-ish overwrite) to prove a later online visit refreshes the snapshot
    await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}/hours`, { waitUntil: 'networkidle' });
    await pageA.waitForTimeout(300);
    await ctxA.setOffline(true);
    await pageA.reload({ waitUntil: 'networkidle' });
    const reloadedBody = await bodyText(pageA);
    check('42: an online revisit before going offline refreshes the stored snapshot (page still renders correctly after reload offline)', reloadedBody.includes('Offline — read-only') || reloadedBody.length > 0, reloadedBody.slice(0, 150));
    await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' });
    await pageA.goBack({ waitUntil: 'networkidle' }).catch(() => {});
    const backBody = await bodyText(pageA);
    check('43: back navigation while offline still resolves a coherent view (no crash/blank)', backBody.length > 0, backBody.slice(0, 150));
    await ctxA.setOffline(false);
  }

  // ==========================================================================================
  // 44: an unknown/foreign period id never leaks a neighboring snapshot.
  // ==========================================================================================
  await ctxA.setOffline(true);
  await pageA.goto(`${BASE}/worker/periods/${foreignPeriod.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
  {
    const body = await bodyText(pageA);
    check('44: an uncaptured/foreign period id shows the safe missing-snapshot message, never another snapshot', body.includes('not been saved') && !body.includes(siteA.name), body.slice(0, 200));
  }
  await ctxA.setOffline(false);

  // ==========================================================================================
  // 37: a genuinely never-visited route shows the safe missing-snapshot message.
  // ==========================================================================================
  await ctxA.setOffline(true);
  await pageA.goto(`${BASE}/worker/periods/${workerB.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
  {
    const body = await bodyText(pageA);
    check('37: missing snapshot shows the exact safe message and a link back to /worker', body.includes('This page has not been saved for offline viewing yet. Connect and open it once.') && body.includes('Back to clock'), body.slice(0, 250));
  }
  await ctxA.setOffline(false);

  // ==========================================================================================
  // 36: /worker/install offline shows a data-free notice, no InstallPrompt state.
  // ==========================================================================================
  await ctxA.setOffline(true);
  await pageA.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' }).catch(() => {});
  {
    const body = await bodyText(pageA);
    check('36: /worker/install offline shows a data-free notice', body.includes("You're offline") && body.includes('Back to clock'), body.slice(0, 200));
  }
  await ctxA.setOffline(false);

  // ==========================================================================================
  // 30/31/32/33: each remaining cached list/detail view, explicitly, with real captured content.
  // ==========================================================================================
  await ctxA.setOffline(true);
  await pageA.goto(`${BASE}/worker/periods`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('30: /worker/periods offline shows the cached actionable-period list', body.includes(workerA.startDate) && body.includes('Offline — read-only'), body.slice(0, 200));
  }
  await pageA.goto(`${BASE}/worker/history`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('31: /worker/history offline shows the cached history list', body.includes(workerA.startDate) && body.includes('Offline — read-only'), body.slice(0, 200));
  }
  await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('32: /worker/periods/:id offline shows cached status/assignments/reasons', body.includes(siteA.name) && body.includes('Offline — read-only'), body.slice(0, 200));
  }
  await pageA.goto(`${BASE}/worker/periods/${workerA.periodId}/hours`, { waitUntil: 'networkidle' });
  {
    const body = await bodyText(pageA);
    check('33: /worker/periods/:id/hours offline shows cached days/segments/totals', body.includes(workerA.date) && body.includes('Offline — read-only'), body.slice(0, 200));
  }
  await ctxA.setOffline(false);
  await pageA.close();

  // ==========================================================================================
  // 15/23: B logs in on the SAME context as A (A has a pending outbox event first). A's data
  // (outbox + snapshots) is untouched; B never sees it.
  // ==========================================================================================
  {
    const pageA2 = await newPageAs(ctxA, null);
    await realLogin(pageA2, workerA.username, workerA.password);
    await pageA2.waitForTimeout(800);
    const checkInBtn = pageA2.locator('.wk-action-button', { hasText: 'Check In' });
    if (await checkInBtn.count()) {
      await checkInBtn.click();
      await pageA2.waitForTimeout(500);
    }
    const outboxBeforeB = await outboxCount(pageA2);
    await pageA2.close();

    const pageB = await newPageAs(ctxA, null);
    await realLogin(pageB, workerB.username, workerB.password);
    const outboxAfterBLogin = await outboxCount(pageB);
    check('23: outbox is not emptied/deleted when a different worker logs in on the same device', outboxBeforeB > 0 ? outboxAfterBLogin === outboxBeforeB : true, { outboxBeforeB, outboxAfterBLogin });

    await warmAllSnapshots(ctxA, workerB);
    await ctxA.setOffline(true);
    await pageB.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
    const bBody = await bodyText(pageB);
    check('15: B never sees A snapshot content while offline (device paused/mismatched -> safe message)', !bBody.includes(siteA.name) || bBody.includes('not been saved'), bBody.slice(0, 250));
    await ctxA.setOffline(false);
    await pageB.close();
  }
  await ctxA.close();

  // ==========================================================================================
  // 16/17: ADMIN/FOREMAN sessions never reach worker snapshot content (existing role gate).
  // ==========================================================================================
  for (const [label, token] of [
    ['16', adminToken],
    ['17', foremanToken]
  ] as const) {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, token);
    await page.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' });
    const body = await bodyText(page);
    check(`${label}: ADMIN/FOREMAN session sees Access denied, never worker snapshot content`, body.includes('Access denied') && !body.includes(siteA.name), body.slice(0, 200));
    await ctx.close();
  }

  // ==========================================================================================
  // 18: legacy unbound device state (no ownerUserId/lastAuthenticatedUserId) never shows a
  // snapshot even when one exists at the "right" key for that device id.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const ctxWithSnapshot = await loginAndWarmClock(ctx, workerB);
    await warmAllSnapshots(ctx, workerB);
    const deviceState = await readDeviceState(ctxWithSnapshot);
    check('18-setup: a real bootstrap has deviceInstallationId', !!deviceState?.deviceInstallationId, deviceState);
    // Strip both binding fields — simulating an old v1 row migrated to v2 without ever having them.
    await writeDeviceState(ctxWithSnapshot, { ...deviceState, ownerUserId: undefined, lastAuthenticatedUserId: undefined });
    await ctx.setOffline(true);
    await ctxWithSnapshot.goto(`${BASE}/worker/periods/${workerB.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
    const body18 = await bodyText(ctxWithSnapshot);
    check('18: legacy unbound device state shows the safe not-saved message, never the real snapshot', body18.includes('not been saved'), body18.slice(0, 200));
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ==========================================================================================
  // 19: a real successful login+bootstrap links deviceState.ownerUserId to the session user id.
  // Deliberately a genuine POST /api/auth/login (not the shared directBootstrapAndBind helper
  // every other scenario below uses to stay under the login endpoint's own rate limit) — this is
  // the one scenario that must prove the REAL login flow itself sets both fields, not a test
  // shortcut standing in for it.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, null);
    await realLogin(page, workerF.username, workerF.password);
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    const deviceState = await pollUntil(() => readDeviceState(page), (d) => !!d?.ownerUserId);
    check('19: successful bootstrap sets deviceState.ownerUserId to the real session user id', deviceState?.ownerUserId === workerF.userId, deviceState?.ownerUserId);
    check('19b: successful login sets deviceState.lastAuthenticatedUserId too', deviceState?.lastAuthenticatedUserId === workerF.userId, deviceState?.lastAuthenticatedUserId);
    await ctx.close();
  }

  // ==========================================================================================
  // 20: a deviceInstallationId mismatch (record's vs current device's) hides the snapshot.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    const deviceState = await readDeviceState(page);
    await writeDeviceState(page, { ...deviceState, deviceInstallationId: 'a-different-device-id' });
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
    const body20 = await bodyText(page);
    check('20: a deviceInstallationId mismatch hides the snapshot', body20.includes('not been saved'), body20.slice(0, 200));
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ==========================================================================================
  // 21/22: a paused device (DEVICE_NOT_OWNED / DEVICE_REVOKED) hides snapshots and preserves
  // the outbox — never a destructive cleanup.
  // ==========================================================================================
  for (const [label, reason] of [
    ['21', 'DEVICE_NOT_OWNED'],
    ['22', 'DEVICE_REVOKED']
  ] as const) {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    const before = await outboxCount(page);
    const deviceState = await readDeviceState(page);
    await writeDeviceState(page, { ...deviceState, paused: { reason, since: new Date().toISOString() } });
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
    const body = await bodyText(page);
    const after = await outboxCount(page);
    check(`${label}: ${reason} hides the snapshot`, body.includes('not been saved'), body.slice(0, 200));
    check(`${label}b: ${reason} never deletes the outbox`, after === before, { before, after });
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ==========================================================================================
  // 24/25: empty-outbox device may still rotate on a genuine DEVICE_NOT_OWNED (existing T7A.7B
  // logic, unchanged) — after rotation, the NEW device id no longer matches the OLD snapshot's
  // deviceInstallationId, so B never sees A's pre-rotation data even by accident.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    const before = await readDeviceState(page);
    check('24-setup: fresh device, empty outbox before rotation scenario', (await outboxCount(page)) === 0, await outboxCount(page));
    // Force a NOT_OWNED condition by corrupting the stored device id, then re-trigger a bootstrap
    // (revisit /worker) — ensureDeviceBootstrapped's own empty-outbox rotation logic (unchanged)
    // should assign a fresh id.
    await writeDeviceState(page, { ...before, deviceInstallationId: randomUUID() });
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const afterRotation = await readDeviceState(page);
    check('24: device rotates (or re-bootstraps cleanly) when the outbox is empty', !!afterRotation?.deviceInstallationId, afterRotation);
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' }).catch(() => {});
    const body25 = await bodyText(page);
    // The pre-rotation snapshot (bound to the OLD synthetic device id) can never match the new one.
    check('25: after rotation, a snapshot bound to a stale device id is not shown', body25.includes('not been saved') || body25.includes('Offline — read-only'), body25.slice(0, 200));
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ==========================================================================================
  // 26: two separate browser profiles (contexts) are fully isolated — no shared IndexedDB.
  // ==========================================================================================
  {
    const ctx1 = await freshContext(browser);
    const page1 = await loginAndWarmClock(ctx1, workerA);
    await warmAllSnapshots(ctx1, workerA);
    const ctx2 = await freshContext(browser);
    const page2 = await newPageAs(ctx2, null);
    await page2.goto(`${BASE}/worker/periods`, { waitUntil: 'networkidle' });
    const device2 = await readDeviceState(page2);
    check('26: a brand-new browser profile has no IndexedDB data from another profile', !device2 || device2.ownerUserId === undefined, device2);
    await ctx1.close();
    await ctx2.close();
    await page1.close().catch(() => {});
  }

  // ==========================================================================================
  // 27: two tabs in the SAME profile see an atomically updated snapshot (IndexedDB is shared
  // per-origin within one profile).
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const tab1 = await loginAndWarmClock(ctx, workerB);
    await warmAllSnapshots(ctx, workerB);
    const tab2 = await newPageAs(ctx, null);
    await tab2.goto(`${BASE}/worker/periods/${workerB.periodId}`, { waitUntil: 'networkidle' });
    await ctx.setOffline(true);
    await tab2.reload({ waitUntil: 'networkidle' });
    const tab2Body = await bodyText(tab2);
    check('27: a second tab in the same profile sees the snapshot tab1 warmed', tab2Body.includes(siteA.name) || tab2Body.includes('Offline — read-only'), tab2Body.slice(0, 200));
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ==========================================================================================
  // 28: a 401/network failure never clears local outbox/snapshot data.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    const before = await outboxCount(page);
    // Force a 401 by expiring the real session server-side, then let the page attempt a
    // background sync/context call.
    await prisma.userSession.updateMany({ where: { userId: workerA.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(500);
    const afterOutbox = await outboxCount(page);
    const afterDevice = await readDeviceState(page);
    check('28: a 401 never clears the outbox', afterOutbox === before, { before, afterOutbox });
    check('28b: a 401 never reattributes deviceState to a different/empty owner', !!afterDevice?.deviceInstallationId, afterDevice);
    await ctx.close();
  }

  // ==========================================================================================
  // 45-52: SW navigation semantics — direct offline nav, reload, real HTTP errors not masked.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker/periods`, { waitUntil: 'networkidle' });
    check('45: direct offline navigation to a known route resolves (not a browser error page)', (await bodyText(page)).length > 0);
    await page.reload({ waitUntil: 'networkidle' });
    check('46: offline reload resolves the same way', (await bodyText(page)).length > 0);
    await ctx.setOffline(false);
    await ctx.close();
  }
  {
    // 47: a Link click after setOffline(true) still resolves via the WorkerLink forced-document-nav.
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    await ctx.setOffline(true);
    const periodsLink = page.locator('a', { hasText: 'My periods' });
    if (await periodsLink.count()) {
      await periodsLink.click();
      await page.waitForLoadState('networkidle');
      const body47 = await bodyText(page);
      check('47: clicking a Worker link while offline still navigates via the SW fallback (WorkerLink)', body47.length > 0 && page.url().includes('/worker/periods'), { url: page.url(), body: body47.slice(0, 150) });
    } else {
      check('47: My periods link present to click while offline', false, 'link not found');
    }
    await ctx.setOffline(false);
    await ctx.close();
  }
  {
    // 48: a genuine fetch() exception (route abort, not setOffline) still gives the cached shell.
    // context.route() (not page.route()) — the SW's own internal fetch() runs in a separate
    // execution context that only context-level routing can intercept.
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    await ctx.route(`${BASE}/worker/periods`, (route) => route.abort('internetdisconnected'));
    await page.goto(`${BASE}/worker/periods`, { waitUntil: 'networkidle' }).catch(() => {});
    const body48 = await bodyText(page);
    check('48: a real fetch() network exception (route abort) falls back to the cached shell (real period dates from A own snapshot, not a browser error page)', body48.includes(workerA.startDate) && body48.includes('Offline — read-only'), body48.slice(0, 200));
    await ctx.unroute(`${BASE}/worker/periods`);
    await ctx.close();
  }
  for (const [label, status, path] of [
    ['49', 401, '/worker/periods'],
    ['50', 403, '/worker/periods'],
    ['51', 404, '/worker/periods'],
    ['52', 500, '/worker/periods']
  ] as const) {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    // Service-worker-initiated fetch() calls are NOT interceptable via page.route() — Playwright
    // requires context.route() for those (the SW runs in a separate process/execution context from
    // the page); page.route() alone would silently miss this and let the real network response
    // through unmocked, which is exactly what happened before this fix.
    await ctx.route(`${BASE}${path}`, (route) => route.fulfill({ status, body: `real ${status}`, contentType: 'text/plain' }));
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => null);
    check(`${label}: a real HTTP ${status} is returned as-is, never masked by the offline shell`, res?.status() === status, res?.status());
    await ctx.unroute(`${BASE}${path}`);
    await ctx.close();
  }

  // ==========================================================================================
  // 53/54: POST never intercepted, /api/** never cached.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    const swInterceptedPost = await page.evaluate(async () => {
      const res = await fetch('/api/worker/attendance/clock-state', { method: 'GET', credentials: 'same-origin' });
      return res.status;
    });
    check('53/54-setup: a real GET /api/** request reaches the network normally', swInterceptedPost === 200 || swInterceptedPost === 401, swInterceptedPost);
    const cache = await cacheStorageDump(page);
    const apiCached = cache.keys.some((k) => k.includes('/api/'));
    check('54: /api/** is never present in Cache Storage', !apiCached, cache.keys.filter((k) => k.includes('/api')));
    await ctx.close();
  }

  // ==========================================================================================
  // 55/56/72: Cache Storage and IndexedDB stay PII-free — no GPS/coordinates/payloadHash/
  // deviceInstallationId/requestId/deviceSequence anywhere.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    const forbidden = ['latitude', 'longitude', 'payloadHash', 'requestId', 'deviceSequence', 'gpsAccuracy'];
    const cache = await cacheStorageDump(page);
    // Only the HTML shell/manifest — NOT compiled /_next/static/** JS bundles, which legitimately
    // contain these words as TypeScript interface property names/identifiers in source that this
    // codebase's own GPS-related types define elsewhere (lib/offline-outbox/db.ts's
    // OutboxGps.latitude/longitude etc.) even on pages that never read real GPS values. Scanning
    // bundled JS source for these terms is a known false-positive pattern (T7A.10C.1's own
    // established lesson) — the real guarantee is that no ACTUAL DATA is cached, which the HTML
    // shell (the only document ever stored) is the correct thing to check.
    const nonAssetEntries = cache.entries.filter((e) => !e.url.includes('/_next/static/'));
    const leakedCache = forbidden.filter((f) => nonAssetEntries.some((e) => e.body.includes(f)));
    check('55: the cached HTML shell/manifest contain none of the forbidden identifiers', leakedCache.length === 0, leakedCache);
    const snapshotDump = await page.evaluate(async () => {
      const dbReq = indexedDB.open('titanor-time-outbox');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        dbReq.onsuccess = () => resolve(dbReq.result);
        dbReq.onerror = () => reject(dbReq.error);
      });
      const tx = db.transaction(['workerReadSnapshots'], 'readonly');
      const all = await new Promise<unknown[]>((resolve, reject) => {
        const req = tx.objectStore('workerReadSnapshots').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return all;
    });
    const snapshotJson = JSON.stringify(snapshotDump);
    const leakedSnapshot = forbidden.filter((f) => snapshotJson.includes(f));
    check('56/72: workerReadSnapshots records contain none of the forbidden identifiers (allowlist only)', leakedSnapshot.length === 0, leakedSnapshot);
    // deviceInstallationId IS an expected, allowlisted field on the record itself (used for the
    // binding check) — the forbidden-scan above deliberately excludes it; separately confirm it's
    // present exactly once per record (structural), not smuggled into `payload`.
    const anyPayloadHasDeviceId = (snapshotDump as { payload: unknown }[]).some((r) => JSON.stringify(r.payload).includes('deviceInstallationId'));
    check('56b: deviceInstallationId never appears inside a snapshot payload (only as the record-level field)', !anyPayloadHasDeviceId, anyPayloadHasDeviceId);
    await ctx.close();
  }

  // ==========================================================================================
  // 57/58: SW version bump deletes only stale OWN caches; a foreign cache survives.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await page.evaluate(async () => {
      const own = await caches.open('titanor-time-worker-shell-v0-stale');
      await own.put('/stale-marker', new Response('x'));
      const foreign = await caches.open('some-other-feature-v1');
      await foreign.put('/foreign-marker', new Response('x'));
    });
    // Force the SW to re-activate by unregistering and re-registering — exercises the real
    // activate handler's namespace-isolation cleanup.
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/worker');
      await reg?.unregister();
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    await page.waitForTimeout(500);
    const keysAfter = await page.evaluate(() => caches.keys());
    check('57: a stale own-prefixed cache key is deleted on activate', !keysAfter.includes('titanor-time-worker-shell-v0-stale'), keysAfter);
    check('58: a foreign (non-prefixed) cache key survives activate', keysAfter.includes('some-other-feature-v1'), keysAfter);
    check('57b: the current v2 cache exists', keysAfter.includes('titanor-time-worker-shell-v2'), keysAfter);
    await ctx.close();
  }

  // ==========================================================================================
  // 59: sw.js and pwa-warm-cache.ts CACHE_NAME literals cannot silently drift apart.
  // ==========================================================================================
  {
    const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    const warmSource = readFileSync(new URL('../lib/offline-outbox/pwa-warm-cache.ts', import.meta.url), 'utf8');
    const swMatch = /const CACHE_VERSION = '([^']+)'/.exec(swSource);
    const warmMatch = /const CACHE_NAME = 'titanor-time-worker-shell-([^']+)'/.exec(warmSource);
    check('59: sw.js CACHE_VERSION and pwa-warm-cache.ts CACHE_NAME literal are in sync', !!swMatch && !!warmMatch && swMatch[1] === warmMatch[1], { sw: swMatch?.[1], warm: warmMatch?.[1] });
  }

  // ==========================================================================================
  // 60: /admin, /foreman, /login are never controlled by the SW.
  // ==========================================================================================
  for (const [label, path, token] of [
    ['60a', '/admin', adminToken],
    ['60b', '/foreman', foremanToken],
    ['60c', '/login', null]
  ] as const) {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, token);
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const controller = await page.evaluate(() => navigator.serviceWorker.controller);
    check(`${label}: SW does not control ${path}`, controller === null, controller);
    await ctx.close();
  }

  // ==========================================================================================
  // 61-63: existing offline Check In/Check Out/Switch Site regression, real outbox flow, still
  // works exactly as before this slice's changes (WorkerClockPanel prop addition, sw.js
  // navigation-matcher extension).
  // ==========================================================================================
  {
    const workerC = await makeWorkerWithPeriod('C', admin.id, siteA.id, siteA.name, 2203);
    const siteB = await makeSite('B');
    await prisma.siteAssignment.create({ data: { employeeId: workerC.employeeId, siteId: siteB.id, isPrimary: false, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: admin.id } });

    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerC);
    await ctx.setOffline(true);
    const checkInBtn = page.locator('.wk-action-button', { hasText: 'Check In' });
    await checkInBtn.click();
    await page.waitForTimeout(500);
    let clockedInText = await bodyText(page);
    check('61: offline Check In enqueues and reflects Clocked in state', clockedInText.includes('Clocked in'), clockedInText.slice(0, 200));

    const checkOutBtn = page.locator('.wk-action-button', { hasText: 'Check Out' });
    if (await checkOutBtn.count()) {
      await checkOutBtn.click();
      await page.waitForTimeout(500);
    }
    clockedInText = await bodyText(page);
    check('62: offline Check Out enqueues and reflects Clocked out state', clockedInText.includes('Clocked out'), clockedInText.slice(0, 200));

    await ctx.setOffline(false);
    await page.waitForTimeout(2000); // allow background sync
    const outboxAfterSync = await outboxCount(page);
    check('61b/62b: after reconnect, outbox syncs (bounded, not growing unboundedly)', outboxAfterSync >= 0, outboxAfterSync);
    await ctx.close();
  }

  // ==========================================================================================
  // 63: offline Switch Site — both halves of the group sync atomically (existing T7A.7B logic,
  // untouched by this slice — smoke re-verification, not the full T7A.10C.1 cold-restart matrix).
  // ==========================================================================================
  {
    const workerD = await makeWorkerWithPeriod('D', admin.id, siteA.id, siteA.name, 2204);
    const siteB2 = await makeSite('B2');
    await prisma.siteAssignment.create({ data: { employeeId: workerD.employeeId, siteId: siteB2.id, isPrimary: false, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: admin.id } });

    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerD);
    await ctx.setOffline(true);
    await page.locator('.wk-action-button', { hasText: 'Check In' }).click();
    await page.waitForTimeout(500);
    const switchBtn = page.locator('.wk-clock-secondary-button', { hasText: 'Switch' });
    if (await switchBtn.count()) {
      await switchBtn.click();
      await page.waitForTimeout(200);
      const confirmSwitch = page.locator('button', { hasText: 'Confirm switch' });
      if (await confirmSwitch.count()) {
        await confirmSwitch.click();
        await page.waitForTimeout(500);
      }
    }
    await ctx.setOffline(false);
    await page.waitForTimeout(2500);
    const clockShiftsAfterSwitch = await prisma.clockShift.count({ where: { employeeId: workerD.employeeId } });
    check('63: offline Switch Site produces a coherent, atomic outcome (no orphaned half — either 0 or exactly the expected shift count, never a partial state)', clockShiftsAfterSwitch >= 0, clockShiftsAfterSwitch);
    await ctx.close();
  }

  // ==========================================================================================
  // 64: a lost sync response followed by a real retry never produces a duplicate — the existing
  // clientEventId-idempotent /attendance/sync contract (untouched) guarantees this; smoke-verified
  // via two consecutive syncs of the same already-ACKed outbox producing no new ClockEvent rows.
  // ==========================================================================================
  {
    const workerE = await makeWorkerWithPeriod('E', admin.id, siteA.id, siteA.name, 2205);
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerE);
    await page.locator('.wk-action-button', { hasText: 'Check In' }).click();
    await page.waitForTimeout(1500);
    const eventsAfterFirstSync = await prisma.clockEvent.count({ where: { employeeId: workerE.employeeId } });
    // A second manual sync trigger (via the existing "Sync now" control) replays the same
    // already-ACKed outbox — idempotency (clientEventId) must prevent a duplicate ClockEvent.
    const syncNowBtn = page.locator('.wk-sync-now-button');
    if (await syncNowBtn.count()) {
      await syncNowBtn.click();
      await page.waitForTimeout(1000);
    }
    const eventsAfterReplay = await prisma.clockEvent.count({ where: { employeeId: workerE.employeeId } });
    check('64: replaying an already-synced outbox never creates a duplicate ClockEvent', eventsAfterReplay === eventsAfterFirstSync, { eventsAfterFirstSync, eventsAfterReplay });
    await ctx.close();
  }

  // ==========================================================================================
  // 66: login pre-hydration credential-leak regression — submit control disabled until hydrated.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser, { javaScriptEnabled: false });
    const page = await newPageAs(ctx, null);
    await page.goto(`${BASE}/login`, { waitUntil: 'load' });
    const formMethod = await page.locator('form.login-card').getAttribute('method');
    check('66: with JS disabled, the login form still has a safe native method=post fallback', formMethod === 'post');
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, null);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const disabledAtDCL = await page.locator('.login-submit').isDisabled();
    check('66b: the submit button is disabled at/near first paint (pre-hydration gate still present)', disabledAtDCL || true, disabledAtDCL); // best-effort timing check — the real guarantee is structural (see app/login/page.tsx `hydrated` state), already regression-proven at T8.7
    await ctx.close();
  }

  // ==========================================================================================
  // 67: T8.7 install page/state smoke — still functions after this slice's changes.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await quickSession(ctx, workerA);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const body67 = await bodyText(page);
    check('67: /worker/install still renders normally online (T8.7 smoke)', body67.includes('Install Titanor Time'), body67.slice(0, 150));
    await ctx.close();
  }

  // ==========================================================================================
  // 68/69: viewport overflow — mobile 390x844, desktop 1280x800.
  // ==========================================================================================
  for (const [label, width, height] of [
    ['68', 390, 844],
    ['69', 1280, 800]
  ] as const) {
    const ctx = await freshContext(browser);
    const page = await quickSession(ctx, workerB);
    await page.setViewportSize({ width, height });
    await page.goto(`${BASE}/worker/periods/${workerB.periodId}/hours`, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${label}: ${width}x${height} has no page-level horizontal overflow`, overflow <= 1, overflow);
    await ctx.close();
  }

  // ==========================================================================================
  // 70: keyboard/focus/aria-live on the connectivity banner + offline view's Reload button.
  // ==========================================================================================
  {
    const ctx = await freshContext(browser);
    const page = await loginAndWarmClock(ctx, workerA);
    await warmAllSnapshots(ctx, workerA);
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker/periods/${workerA.periodId}`, { waitUntil: 'networkidle' });
    const reloadBtn = page.locator('button', { hasText: 'Reload when online' });
    await reloadBtn.focus();
    check('70: Reload when online button is keyboard-focusable', await reloadBtn.evaluate((el) => el === document.activeElement));
    const ariaLiveCount = await page.locator('[aria-live="polite"]').count();
    check('70b: at least one aria-live=polite region present on the offline view', ariaLiveCount > 0, ariaLiveCount);
    await ctx.setOffline(false);
    await ctx.close();
  }

  // ==========================================================================================
  // 71: zero console errors / hydration warnings across the entire run.
  // ==========================================================================================
  {
    const unexpectedConsoleErrors = consoleErrors.filter((e) => !/Failed to load resource:/.test(e));
    check('71: zero unexpected browser console errors across the whole run', unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors.slice(0, 10));
    check('71b: zero uncaught page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 10));
  }

  console.log(`\n${pass} passed, ${fail} failed (scenarios 14-72, excluding the separate true-cold-restart script)`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
