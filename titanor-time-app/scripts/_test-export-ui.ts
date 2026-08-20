import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { prisma } from '../lib/prisma';
import { requestCorrection, openCorrectionDraft, patchCorrectionDraftDay, submitCorrection, decideCorrection } from '../lib/corrections';
import { createExportBatch } from '../lib/csv-export';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4C" §CB — permanent browser regression for
// the CSV export admin UI. Real Chromium (Playwright), production standalone build + disposable
// PostgreSQL 16 (TEST_BASE_URL), never `next dev`, never the preview deployment. Scenario numbers
// below match the task's own 1-46 list.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39620';

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

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ============================================================================
// Fixtures (same idioms as scripts/_test-csv-export.ts)
// ============================================================================

async function makeUserWithRole(tag: string, roleName: string) {
  const user = await prisma.user.create({ data: { username: `${roleName.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}

async function makeCustomRoleUser(tag: string, permissionCodes: string[]) {
  const role = await prisma.role.create({ data: { name: `T84CUI_${randomUUID().slice(0, 18)}` } });
  const grants: { code: string; rolePermissionId: string }[] = [];
  for (const code of permissionCodes) {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code } });
    const rp = await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    grants.push({ code, rolePermissionId: rp.id });
  }
  const user = await prisma.user.create({ data: { username: `custom-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token, grants };
}

async function revokeGrant(rolePermissionId: string) {
  await prisma.rolePermission.delete({ where: { id: rolePermissionId } });
}

// app/admin/layout.tsx gates every /admin/* page by the LITERAL role name ADMIN/SUPER_ADMIN before
// any page-level permission check ever runs (documented architectural fact, T8.3B) — a custom role
// without that exact name never reaches page.tsx at all, so it cannot be used to test "has
// export.read but not the create permissions" or "export.read revoked". The only way to exercise
// those states is to temporarily revoke/restore specific grants on the real, shared ADMIN role
// itself, run the assertions, then put the grants back — safe here because this whole script runs
// strictly sequentially, never concurrently with another script touching the same role.
async function withTemporaryRevocation<T>(permissionCodes: string[], fn: () => Promise<T>): Promise<T> {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  const removed: { permissionId: string }[] = [];
  for (const code of permissionCodes) {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code } });
    const rp = await prisma.rolePermission.findFirstOrThrow({ where: { roleId: role.id, permissionId: perm.id } });
    await prisma.rolePermission.delete({ where: { id: rp.id } });
    removed.push({ permissionId: perm.id });
  }
  try {
    return await fn();
  } finally {
    await prisma.rolePermission.createMany({ data: removed.map((r) => ({ roleId: role.id, permissionId: r.permissionId })) });
  }
}

let fixtureAdmin: { id: string };
async function ensureAdminUser() {
  if (fixtureAdmin) return fixtureAdmin;
  const { user } = await makeUserWithRole('fixture', 'ADMIN');
  fixtureAdmin = user;
  return user;
}

async function makeEmployee(tag: string, overrides: { employeeNumber?: string; firstName?: string; lastName?: string } = {}) {
  const emp = await prisma.employee.create({
    data: {
      employeeNumber: overrides.employeeNumber ?? `TEST-T84CUI-${tag}-${randomUUID().slice(0, 8)}`,
      firstName: overrides.firstName ?? tag,
      lastName: overrides.lastName ?? 'Worker'
    }
  });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function makeSite(tag: string, overrides: { name?: string } = {}) {
  return prisma.workSite.create({ data: { name: overrides.name ?? `T84CUI Site ${tag} ${randomUUID().slice(0, 4)}` } });
}

async function makeAssignment(employeeId: string, siteId: string, validFrom: Date, validTo: Date | null) {
  const admin = await ensureAdminUser();
  return prisma.siteAssignment.create({ data: { employeeId, siteId, isPrimary: true, validFrom, validTo, assignedByUserId: admin.id } });
}

async function makePeriod(startDate: Date, endDate: Date, status: 'OPEN' | 'LOCKED' | 'EXPORTED' = 'OPEN') {
  const admin = await ensureAdminUser();
  const period = await prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: admin.id } });
  if (status === 'LOCKED' || status === 'EXPORTED') {
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: admin.id } });
  }
  if (status === 'EXPORTED') {
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'EXPORTED', exportedAt: new Date() } });
  }
  return prisma.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } });
}

async function makeParticipant(periodId: string, employeeId: string, expected = true) {
  if (expected) {
    return prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId, expected: true } });
  }
  const admin = await ensureAdminUser();
  return prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId, expected: false, exclusionReason: 'test exclusion', excludedByUserId: admin.id, excludedAt: new Date() } });
}

interface BreakInput {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}

const versionDayCache = new Map<string, { id: string }>();
async function ensureVersionDay(versionId: string, date: Date) {
  const key = `${versionId}:${date.toISOString().slice(0, 10)}`;
  const cached = versionDayCache.get(key);
  if (cached) return cached;
  const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: versionId, date, dayType: 'WORK', confirmedZero: false } });
  versionDayCache.set(key, day);
  return day;
}
const versionPlanCache = new Map<string, { id: string }>();
async function ensureVersionPlannedShift(versionId: string, employeeId: string, date: Date, siteId: string, sourceAssignmentId: string) {
  const key = `${versionId}:${date.toISOString().slice(0, 10)}:${sourceAssignmentId}`;
  const cached = versionPlanCache.get(key);
  if (cached) return cached;
  const ps = await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: versionId, employeeId, date, siteId, sourceAssignmentId, plannedBreakMinutes: 0 } });
  versionPlanCache.set(key, ps);
  return ps;
}
async function addVersionSegment(version: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = []) {
  const day = await ensureVersionDay(version.id, date);
  await ensureVersionPlannedShift(version.id, employeeId, date, siteId, sourceAssignmentId);
  const seg = await prisma.workSegment.create({ data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId, crossesMidnight: false } });
  for (const b of breaks) {
    await prisma.breakSegment.create({ data: { workSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  }
  return seg;
}

async function makeFinalApprovedWorker(
  tag: string,
  siteId: string,
  period: { id: string; startDate: Date; endDate: Date },
  overrides: { employeeNumber?: string; firstName?: string; lastName?: string; expected?: boolean } = {}
) {
  const admin = await ensureAdminUser();
  const emp = await makeEmployee(tag, overrides);
  const asg = await makeAssignment(emp.id, siteId, period.startDate, period.endDate);
  await makeParticipant(period.id, emp.id, overrides.expected ?? true);
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' } });
  await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
  return { employee: emp, assignment: asg, timesheet: ts, version };
}

async function makeApprovedCorrection(
  timesheetId: string,
  requesterUserId: string,
  deciderUserId: string,
  date: Date,
  segments: { siteId: string; startAt: Date; endAt: Date; breaks?: BreakInput[] }[]
) {
  const req = await requestCorrection(timesheetId, requesterUserId, 'test correction', randomUUID());
  if ('code' in req) throw new Error(`requestCorrection failed: ${JSON.stringify(req)}`);
  const open = await openCorrectionDraft(req.id, requesterUserId, randomUUID());
  if ('code' in open) throw new Error(`openCorrectionDraft failed: ${JSON.stringify(open)}`);
  const patch = await patchCorrectionDraftDay(req.id, date, {
    segments: segments.map((s) => ({ startAt: s.startAt, endAt: s.endAt, siteId: s.siteId, workAreaId: null, breaks: (s.breaks ?? []).map((b) => ({ startAt: b.startAt, endAt: b.endAt, paid: b.paid })) }))
  });
  if ('code' in patch) throw new Error(`patchCorrectionDraftDay failed: ${JSON.stringify(patch)}`);
  const submit = await submitCorrection(req.id, randomUUID());
  if ('code' in submit) throw new Error(`submitCorrection failed: ${JSON.stringify(submit)}`);
  const decide = await decideCorrection(req.id, 'APPROVED', deciderUserId, false, null, randomUUID());
  if ('code' in decide) throw new Error(`decideCorrection failed: ${JSON.stringify(decide)}`);
  return { correctionRequestId: req.id, resultingVersionId: decide.resultingVersionId! };
}

const PERIOD_ANCHOR_DAYS = 1000 + Math.floor(Math.random() * 50000);
let periodSlot = 0;
function nextPeriodDates(): { startDate: Date; endDate: Date } {
  periodSlot += 1;
  const start = new Date(Date.UTC(2000, 0, 1) + (PERIOD_ANCHOR_DAYS + periodSlot * 20) * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return { startDate: start, endDate: end };
}

// ============================================================================
// Playwright helpers
// ============================================================================

let cacheBustCounter = 0;

/** Playwright/Chromium was observed to occasionally serve a cached response for the exact same
 * URL string within one browser process even with `Cache-Control: no-store` sent by the server
 * (confirmed via raw `fetch()` against the same server/cookie always returning the fresh, correct
 * response) — a real find during this task, not a product bug (see T8_REPORTS_DESIGN.md Addendum
 * "T8.4C" §CB testing note). Every navigation whose assertions depend on server-side state that
 * just changed (permission revocation, a just-created export, etc.) goes through this helper
 * instead of a bare `page.goto()`, appending a unique cache-busting query param each time. Plain
 * `page.goto()` is still used directly for the few tests that specifically exercise real browser
 * navigation mechanics (reload/back/forward, item 8) where identical URLs are the whole point.
 */
async function gotoFresh(page: Page, url: string) {
  cacheBustCounter += 1;
  const sep = url.includes('?') ? '&' : '?';
  const res = await page.goto(`${url}${sep}_cb=${cacheBustCounter}`);
  // Route-level loading.tsx streams in first and is swapped for the real content once the Server
  // Component finishes; 'load' can fire before that swap is visible to a one-shot innerText() read.
  // Waiting for networkidle (no client fetches on these pages besides the swap script) makes the
  // subsequent bodyText()/h1Text() read deterministic instead of racing the stream.
  await page.waitForLoadState('networkidle');
  return res;
}

async function newPageAs(context: BrowserContext, token: string | null): Promise<Page> {
  if (token) {
    await context.addCookies([{ name: 'tt_session', value: token, url: BASE }]);
  }
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[${page.url()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(`[${page.url()}] ${err.message}`);
  });
  return page;
}

async function freshContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  // Generous default — a disposable-Postgres-backed standalone server under this host's shared
  // load, combined with Next.js's own Link prefetch storm on every admin nav (every sidebar link
  // prefetches its RSC payload on mount), occasionally pushes a single request/action well past
  // Playwright's normal defaults even though nothing is actually stuck — not a product bug.
  ctx.setDefaultTimeout(60_000);
  ctx.setDefaultNavigationTimeout(60_000);
  return ctx;
}

// The legacy string-selector page.textContent()/page.$eval() APIs were observed to hang
// indefinitely against this app's streaming SSR output even once hydration had visibly completed
// (h1 present, no console/page errors) — the modern Locator API (page.locator(...).textContent())
// does not have this issue and is used everywhere in this script instead.
async function h1Text(page: Page): Promise<string> {
  return (await page.locator('h1').first().textContent()) ?? '';
}
async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText()) ?? '';
}

async function main() {
  const browser = await chromium.launch();

  const admin = await makeUserWithRole('admin', 'ADMIN');
  const admin2 = await makeUserWithRole('admin2', 'ADMIN');
  const admin3 = await makeUserWithRole('admin3', 'ADMIN');
  const superAdmin = await makeUserWithRole('sa', 'SUPER_ADMIN');
  const worker = await makeUserWithRole('worker', 'WORKER');
  const foreman = await makeUserWithRole('foreman', 'FOREMAN');

  // ============================================================================
  // 1-5: permissions/roles
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export`);
    check('1: ADMIN sees the export history page', (await h1Text(page)).includes('CSV exports'), await page.title());
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, superAdmin.token);
    await gotoFresh(page, `${BASE}/admin/export`);
    check('2: SUPER_ADMIN sees the export history page', (await h1Text(page)).includes('CSV exports'), null);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await gotoFresh(page, `${BASE}/admin/export`);
    const body = await bodyText(page);
    check('3: WORKER denied (admin layout gate)', body.includes('Access denied'), body.slice(0, 200));
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, foreman.token);
    await gotoFresh(page, `${BASE}/admin/export`);
    const body = await bodyText(page);
    check('3: FOREMAN denied (admin layout gate)', body.includes('Access denied'), body.slice(0, 200));
    await ctx.close();
  }
  {
    // 4: export.read revoked -> denied on next request. Dedicated ADMIN-role user (admin3), and the
    // grant is revoked/restored on the real shared ADMIN role (see withTemporaryRevocation) — a
    // custom role without the literal ADMIN/SUPER_ADMIN name never even reaches page.tsx (blocked
    // earlier by app/admin/layout.tsx's own role-name gate, which has no <h1> to find at all).
    await withTemporaryRevocation(['export.read'], async () => {
      const ctx = await freshContext(browser);
      const page = await newPageAs(ctx, admin3.token);
      await gotoFresh(page, `${BASE}/admin/export`);
      const body = await bodyText(page);
      check('4: export.read revoked blocks the very next request', body.includes('Access denied') || body.includes('permission'), body.slice(0, 200));
      await ctx.close();
    });
    // Confirm the restore actually took effect (same user, same role, fresh request).
    const ctxAfter = await freshContext(browser);
    const pageAfter = await newPageAs(ctxAfter, admin3.token);
    await gotoFresh(pageAfter, `${BASE}/admin/export`);
    check('4 (restore check): export.read restored grants access again', (await h1Text(pageAfter)).includes('CSV exports'), null);
    await ctxAfter.close();
  }
  {
    // 5: read-only permission combination (export.read present, period.export/export.create absent)
    // sees history, not create — same temporary-revocation technique, on the same real ADMIN role.
    await withTemporaryRevocation(['period.export', 'export.create'], async () => {
      const ctx = await freshContext(browser);
      const page = await newPageAs(ctx, admin3.token);
      await gotoFresh(page, `${BASE}/admin/export`);
      const body = await bodyText(page);
      check('5: read-only sees history section', body.includes('History'), null);
      check('5: read-only sees "no permission" note, not a create button', body.includes('do not have permission to create exports'), null);
      const createButtons = await page.locator('button:has-text("Create")').count();
      check('5: no active Create button anywhere in the DOM for read-only user', createButtons === 0, createButtons);
      await ctx.close();
    });
  }

  // ============================================================================
  // 6-11: history / filter / pagination / URL
  // ============================================================================
  let historyPeriodA: Awaited<ReturnType<typeof makePeriod>>;
  let historyPeriodB: Awaited<ReturnType<typeof makePeriod>>;
  let historyBatchA: any;
  let historyBatchB: any;
  {
    const { startDate: sdA, endDate: edA } = nextPeriodDates();
    historyPeriodA = await makePeriod(sdA, edA, 'LOCKED');
    const siteA = await makeSite('HistA');
    const workerA = await makeFinalApprovedWorker('HistA', siteA.id, historyPeriodA);
    await addVersionSegment(workerA.version, workerA.employee.id, siteA.id, workerA.assignment.id, new Date(sdA), new Date(sdA.getTime() + 8 * 3600000), new Date(sdA.getTime() + 16 * 3600000));
    const resultA = await createExportBatch(historyPeriodA.id, admin.user.id, randomUUID());
    if ('code' in resultA) throw new Error(`fixture FULL export failed: ${JSON.stringify(resultA)}`);
    historyBatchA = resultA.batch;

    const { startDate: sdB, endDate: edB } = nextPeriodDates();
    historyPeriodB = await makePeriod(sdB, edB, 'LOCKED');
    const siteB = await makeSite('HistB');
    const workerB = await makeFinalApprovedWorker('HistB', siteB.id, historyPeriodB);
    await addVersionSegment(workerB.version, workerB.employee.id, siteB.id, workerB.assignment.id, new Date(sdB), new Date(sdB.getTime() + 8 * 3600000), new Date(sdB.getTime() + 16 * 3600000));
    const resultB = await createExportBatch(historyPeriodB.id, admin.user.id, randomUUID());
    if ('code' in resultB) throw new Error(`fixture FULL export failed: ${JSON.stringify(resultB)}`);
    historyBatchB = resultB.batch;
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export`);
    const body = await bodyText(page);
    check('6: all-period history shows batches from multiple periods', body.includes('History'), null);
    const linksToA = await page.locator(`a[href="/admin/export/${historyBatchA.id}"]`).count();
    const linksToB = await page.locator(`a[href="/admin/export/${historyBatchB.id}"]`).count();
    check('6: unfiltered history includes both fixture periods\' batches', linksToA > 0 && linksToB > 0, { linksToA, linksToB });
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${historyPeriodA.id}`);
    const body = await bodyText(page);
    check('7: period filter in URL restricts history to that period', body.includes(historyBatchA.fileName) || (await page.locator(`a[href="/admin/export/${historyBatchA.id}"]`).count()) > 0, null);
    const linksToB = await page.locator(`a[href="/admin/export/${historyBatchB.id}"]`).count();
    check('7: period filter excludes other periods\' batches', linksToB === 0, linksToB);
    await ctx.close();
  }
  {
    // 8: reload/back/forward preserve the URL-driven filter state.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await page.goto(`${BASE}/admin/export?periodId=${historyPeriodA.id}`);
    await page.reload();
    check('8: reload preserves filtered URL', page.url().includes(`periodId=${historyPeriodA.id}`), page.url());
    await page.goto(`${BASE}/admin/export?periodId=${historyPeriodB.id}`);
    // Next.js's App Router intercepts the popstate event from back/forward and performs a
    // client-side (SPA) navigation — goBack()/goForward() only wait for the browser's own 'load'
    // event, which does not reliably correspond to that async RSC re-render finishing. waitForURL()
    // waits for the actual URL (which Next.js updates once its client navigation completes) instead.
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get('periodId') === historyPeriodA.id, { timeout: 30000 });
    check('8: back navigates to the previous filter', page.url().includes(`periodId=${historyPeriodA.id}`), page.url());
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get('periodId') === historyPeriodB.id, { timeout: 30000 });
    check('8: forward returns to the later filter', page.url().includes(`periodId=${historyPeriodB.id}`), page.url());
    await ctx.close();
  }
  {
    // 9: invalid period/page/pageSize -> inline banner, not 500.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    const resMalformedPeriod = await gotoFresh(page, `${BASE}/admin/export?periodId=not-a-uuid`);
    check('9: malformed periodId -> non-500 response', (resMalformedPeriod?.status() ?? 0) < 500, resMalformedPeriod?.status());
    check('9: malformed periodId shows inline validation banner', (await bodyText(page)).toLowerCase().includes('invalid'), null);

    const resMalformedPage = await gotoFresh(page, `${BASE}/admin/export?page=not-a-number`);
    check('9: malformed page -> non-500 response', (resMalformedPage?.status() ?? 0) < 500, resMalformedPage?.status());
    check('9: malformed page shows inline validation banner', (await bodyText(page)).toLowerCase().includes('invalid'), null);

    const resMalformedPageSize = await gotoFresh(page, `${BASE}/admin/export?pageSize=0`);
    check('9: malformed pageSize -> non-500 response', (resMalformedPageSize?.status() ?? 0) < 500, resMalformedPageSize?.status());
    check('9: malformed pageSize shows inline validation banner', (await bodyText(page)).toLowerCase().includes('invalid'), null);
    await ctx.close();
  }
  {
    // 10: empty history — a genuinely fresh, never-exported period.
    const { startDate, endDate } = nextPeriodDates();
    const emptyPeriod = await makePeriod(startDate, endDate, 'LOCKED');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${emptyPeriod.id}`);
    const body = await bodyText(page);
    check('10: empty history for a period with no exports yet', body.includes('No exports yet'), body.slice(0, 300));
    await ctx.close();
  }
  let manyPeriodId = '';
  let manyPeriodFullBatchId = '';
  {
    // 11: pagination preserves filters — periodId stays in pagination links.
    const { startDate, endDate } = nextPeriodDates();
    const manyPeriod = await makePeriod(startDate, endDate, 'LOCKED');
    manyPeriodId = manyPeriod.id;
    const site = await makeSite('Page11');
    let firstWorker: Awaited<ReturnType<typeof makeFinalApprovedWorker>> | null = null;
    for (let i = 0; i < 3; i++) {
      const worker = await makeFinalApprovedWorker(`Page11-${i}`, site.id, manyPeriod);
      if (i === 0) firstWorker = worker;
      await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));
    }
    // One FULL then repeated correction cycles to accumulate multiple batches on the SAME period.
    const full = await createExportBatch(manyPeriod.id, admin.user.id, randomUUID());
    if ('code' in full) throw new Error(`fixture FULL failed: ${JSON.stringify(full)}`);
    manyPeriodFullBatchId = full.batch.id;
    // Re-querying by a firstName pattern (e.g. "Page11-0") is ambiguous on a disposable DB that has
    // already accumulated fixture rows from an earlier run of this same script — use the worker
    // captured directly from this run's own loop instead.
    const tsForCorrections = await prisma.timesheet.findFirstOrThrow({ where: { employeeId: firstWorker!.employee.id, periodId: manyPeriod.id } });
    for (let i = 0; i < 2; i++) {
      await makeApprovedCorrection(tsForCorrections.id, admin.user.id, admin2.user.id, new Date(startDate), [{ siteId: site.id, startAt: new Date(startDate.getTime() + 8 * 3600000), endAt: new Date(startDate.getTime() + (10 + i) * 3600000) }]);
      const corr = await createExportBatch(manyPeriod.id, admin.user.id, randomUUID());
      if ('code' in corr) throw new Error(`fixture CORRECTION failed: ${JSON.stringify(corr)}`);
    }

    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${manyPeriod.id}&pageSize=1`);
    const nextLink = page.locator('a:has-text("Next")');
    check('11: pagination present with pageSize=1 and 3 batches', (await nextLink.count()) > 0, null);
    if ((await nextLink.count()) > 0) {
      const href = await nextLink.first().getAttribute('href');
      check('11: pagination link preserves periodId filter', (href ?? '').includes(`periodId=${manyPeriod.id}`), href);
      check('11: pagination link preserves pageSize', (href ?? '').includes('pageSize=1'), href);
    }
    await ctx.close();
  }

  // ============================================================================
  // 12-20: create flow (OPEN/LOCKED/EXPORTED), success, FULL/CORRECTION, predecessor
  // ============================================================================
  const capturedIdempotencyKeys: string[] = [];

  {
    // 12: OPEN period -> create disabled/explained, no button rendered at all.
    const { startDate, endDate } = nextPeriodDates();
    const openPeriod = await makePeriod(startDate, endDate, 'OPEN');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${openPeriod.id}`);
    const body = await bodyText(page);
    check('12: OPEN period explains locking is required', body.includes('Lock the period before exporting'), null);
    const buttons = await page.locator('button:has-text("Create")').count();
    check('12: OPEN period renders no Create button', buttons === 0, buttons);
    await ctx.close();
  }

  let period13Id = '';
  let batch13Id = '';
  let batch13Hash = '';
  {
    // 13: LOCKED -> FULL export via the UI create button.
    const { startDate, endDate } = nextPeriodDates();
    const period13 = await makePeriod(startDate, endDate, 'LOCKED');
    period13Id = period13.id;
    const site13 = await makeSite('P13');
    const worker13 = await makeFinalApprovedWorker('P13', site13.id, period13);
    await addVersionSegment(worker13.version, worker13.employee.id, site13.id, worker13.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));

    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/admin\/periods\/[^/]+\/export$/.test(new URL(req.url()).pathname)) {
        const key = req.headers()['idempotency-key'];
        if (key) capturedIdempotencyKeys.push(key);
      }
    });
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period13Id}`);
    await page.locator('button:has-text("Create full CSV export")').click();
    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    // Success also triggers router.refresh() (a background RSC re-fetch of the whole page); wait for
    // that to settle before touching anything in the tree, or a Locator resolved mid-refresh can be
    // detached and reattached out from under an in-flight click.
    await page.waitForLoadState('networkidle');
    const successText = await page.locator('.exp-create-success').innerText();
    check('13: LOCKED period create button produces a FULL export', successText.includes('Full export'), successText);

    const viewLink = page.locator('.exp-create-success a', { hasText: 'View details' });
    const viewHref = await viewLink.getAttribute('href');
    check('13: success panel View details link points at /admin/export/:id', /^\/admin\/export\/[0-9a-f-]+$/.test(viewHref ?? ''), viewHref);
    batch13Id = (viewHref ?? '').split('/').pop() ?? '';

    // 16: success View details link actually navigates to the new batch's detail page. Next.js's
    // client-side navigation briefly shows app/admin/export/[batchId]/loading.tsx's own "Export
    // batch" h1 before the streamed Server Component content swaps in — networkidle alone doesn't
    // reliably outlast that swap, so wait for the real heading text directly instead.
    await viewLink.click();
    await page.locator('h1', { hasText: /Full export|Correction export/ }).waitFor({ state: 'visible', timeout: 30000 });
    const h1 = await h1Text(page);
    check("16: success View details link navigates to the new batch's detail page", h1.includes('Full export'), h1);
    const hashText = await page.locator('.exp-hash').first().innerText();
    batch13Hash = hashText.trim();

    await ctx.close();
  }

  {
    // 14: the underlying period actually became EXPORTED — checked from a FRESH page load (the
    // create control itself intentionally stays on its sticky success view, rule 6).
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period13Id}`);
    const hasCorrectionButton = (await page.locator('button:has-text("Create correction CSV export")').count()) > 0;
    check('14: period flips to EXPORTED after a FULL export, seen on next load', hasCorrectionButton, null);
    await ctx.close();
  }

  {
    // 15: the newly created batch appears in the unfiltered history.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export`);
    const link = await page.locator(`a[href="/admin/export/${batch13Id}"]`).count();
    check('15: newly created export appears in unfiltered history', link > 0, link);
    await ctx.close();
  }

  {
    // 17 & 18: Download CSV link downloads the exact stored bytes with the right headers, and the
    // SHA-256 the server sends matches both the recomputed hash and the hash shown on the detail page.
    // Uses the context's APIRequestContext (shares cookies with the page) instead of page.goto(),
    // since a Content-Disposition: attachment response aborts a normal browser navigation.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch13Id}`);
    const downloadHref = await page.locator('a', { hasText: 'Download CSV' }).getAttribute('href');
    check('17: detail page has a Download CSV link', !!downloadHref, downloadHref);

    const apiRes = await ctx.request.get(`${BASE}${downloadHref}`);
    check('18: download response is 200', apiRes.status() === 200, apiRes.status());
    const headers = apiRes.headers();
    check('18: download Content-Type is text/csv', (headers['content-type'] ?? '').includes('text/csv'), headers['content-type']);
    check('18: download Content-Disposition is an attachment', (headers['content-disposition'] ?? '').includes('attachment'), headers['content-disposition']);
    const serverHash = headers['x-content-sha256'] ?? '';
    const bodyBuf = await apiRes.body();
    const recomputedHash = createHash('sha256').update(bodyBuf).digest('hex');
    check('18: X-Content-SHA256 header matches the recomputed hash of the downloaded bytes', serverHash === recomputedHash, { serverHash, recomputedHash });
    check('18: downloaded hash matches the hash shown on the detail page', serverHash === batch13Hash, { serverHash, batch13Hash });
    await ctx.close();
  }

  {
    // 19: EXPORTED period with no pending correction -> exact human NOTHING_TO_EXPORT text.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${historyPeriodA.id}`);
    await page.locator('button:has-text("Create correction CSV export")').click();
    await page.locator('.exp-error-banner').waitFor({ state: 'visible', timeout: 30000 });
    const errText = await page.locator('.exp-error-banner').innerText();
    check(
      '19: EXPORTED period with nothing pending shows the exact human NOTHING_TO_EXPORT text',
      errText.trim() === 'No approved corrections are waiting for export. The latest CSV remains current.',
      errText
    );
    await ctx.close();
  }

  let period20Id = '';
  let batch20FullId = '';
  let batch20FullHashAtCreation = '';
  let batch20CorrectionId = '';
  let correction20RequestId = '';
  {
    // 20: an approved, expected, pending correction -> a genuine CORRECTION export via the UI.
    const { startDate, endDate } = nextPeriodDates();
    const period20 = await makePeriod(startDate, endDate, 'LOCKED');
    period20Id = period20.id;
    const site20 = await makeSite('P20');
    const worker20 = await makeFinalApprovedWorker('P20', site20.id, period20);
    await addVersionSegment(worker20.version, worker20.employee.id, site20.id, worker20.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));

    const full20 = await createExportBatch(period20.id, admin.user.id, randomUUID());
    if ('code' in full20) throw new Error(`fixture FULL (period20) failed: ${JSON.stringify(full20)}`);
    batch20FullId = full20.batch.id;
    batch20FullHashAtCreation = full20.batch.fileHash;

    const correction20 = await makeApprovedCorrection(worker20.timesheet.id, admin.user.id, admin2.user.id, new Date(startDate), [
      { siteId: site20.id, startAt: new Date(startDate.getTime() + 8 * 3600000), endAt: new Date(startDate.getTime() + 11 * 3600000) }
    ]);
    correction20RequestId = correction20.correctionRequestId;

    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/admin\/periods\/[^/]+\/export$/.test(new URL(req.url()).pathname)) {
        const key = req.headers()['idempotency-key'];
        if (key) capturedIdempotencyKeys.push(key);
      }
    });
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period20Id}`);
    await page.locator('button:has-text("Create correction CSV export")').click();
    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForLoadState('networkidle');
    const successText = await page.locator('.exp-create-success').innerText();
    check('20: approved pending correction produces a CORRECTION export via the UI', successText.includes('Correction export'), successText);
    const viewHref = await page.locator('.exp-create-success a', { hasText: 'View details' }).getAttribute('href');
    batch20CorrectionId = (viewHref ?? '').split('/').pop() ?? '';
    await ctx.close();
  }

  // ============================================================================
  // 21-25: replacement-snapshot presentation, predecessor link, covered count, item
  // pagination, old-FULL-still-downloads-byte-identically
  // ============================================================================
  {
    // 21: CORRECTION batches are visibly marked "Full replacement snapshot" — both on their own
    // detail page and on the history card.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch20CorrectionId}`);
    const detailBadge = await page.locator('.exp-replacement-badge').count();
    check('21: CORRECTION detail page shows the replacement-snapshot badge', detailBadge > 0, detailBadge);

    await gotoFresh(page, `${BASE}/admin/export`);
    const historyCard = page.locator('li.exp-history-card', { has: page.locator(`a[href="/admin/export/${batch20CorrectionId}"]`) });
    const historyBadge = await historyCard.locator('.exp-replacement-badge').count();
    check('21: CORRECTION history card shows the replacement-snapshot badge', historyBadge > 0, historyBadge);
    await ctx.close();
  }

  {
    // 22: the CORRECTION batch's "Corrects" link points at its predecessor FULL batch.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch20CorrectionId}`);
    const correctsLink = page.locator('a', { hasText: 'previous batch' });
    const correctsHref = await correctsLink.getAttribute('href');
    check('22: predecessor link points at the FULL batch that was corrected', correctsHref === `/admin/export/${batch20FullId}`, correctsHref);

    await correctsLink.click();
    // Not the broad /Full export|Correction export/ pattern used elsewhere — the CURRENT page here
    // is itself the CORRECTION detail (h1 already reads "Correction export..."), so that pattern
    // would match instantly, before navigation even starts. "Full export" alone is unambiguous: it
    // is not a substring of the current page's own heading.
    await page.locator('h1', { hasText: 'Full export' }).waitFor({ state: 'visible', timeout: 30000 });
    const h1 = await h1Text(page);
    check('22: predecessor link actually navigates to the FULL batch\'s detail page', h1.includes('Full export'), h1);
    await ctx.close();
  }

  {
    // 23: covered correction count and the covered correction request's own link.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch20CorrectionId}`);
    const body = await bodyText(page);
    const normalized = body.replace(/\s+/g, ' ');
    check('23: covered correction count is shown and correct', /covered corrections\s*1\b/i.test(normalized), normalized.slice(0, 400));
    const correctionLink = await page.locator(`a[href="/admin/corrections/${correction20RequestId}"]`).count();
    check('23: covered correction request links to its own detail page', correctionLink > 0, correctionLink);
    await ctx.close();
  }

  {
    // 24: detail item pagination (reusing the 3-row manyPeriod FULL batch from item 11's fixture).
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${manyPeriodFullBatchId}?pageSize=1`);
    const nextLink = page.locator('a:has-text("Next")');
    check('24: detail item list paginates with pageSize=1', (await nextLink.count()) > 0, null);
    if ((await nextLink.count()) > 0) {
      const href = await nextLink.first().getAttribute('href');
      check('24: item pagination link preserves pageSize', (href ?? '').includes('pageSize=1'), href);
    }
    await ctx.close();
  }

  {
    // 25: the old FULL batch still downloads byte-identically after a later correction was applied
    // on top of it — proves immutability, not just that a download succeeds.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch20FullId}`);
    const downloadHref = await page.locator('a', { hasText: 'Download CSV' }).getAttribute('href');
    const apiRes = await ctx.request.get(`${BASE}${downloadHref}`);
    const recomputedHash = createHash('sha256').update(await apiRes.body()).digest('hex');
    check(
      '25: old FULL batch downloads byte-identically after a later correction batch exists',
      recomputedHash === batch20FullHashAtCreation,
      { recomputedHash, batch20FullHashAtCreation }
    );
    await ctx.close();
  }

  // ============================================================================
  // 26-31: double-click / delayed-response / network-unknown / retry / idempotency-key reuse
  // ============================================================================
  async function doubleClickNative(page: Page, buttonText: string) {
    await page.evaluate((text) => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
      btn?.click();
      btn?.click();
    }, buttonText);
  }

  async function makeLockedPeriodWithWorker(tag: string) {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite(tag);
    const worker = await makeFinalApprovedWorker(tag, site.id, period);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));
    return period;
  }

  {
    // 26: a normal (fast, no artificial delay) double-click produces exactly one POST and one batch.
    const period26 = await makeLockedPeriodWithWorker('P26');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    const requestsSeen: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/admin\/periods\/[^/]+\/export$/.test(new URL(req.url()).pathname)) {
        requestsSeen.push(req.url());
        const key = req.headers()['idempotency-key'];
        if (key) capturedIdempotencyKeys.push(key);
      }
    });
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period26.id}`);
    await doubleClickNative(page, 'Create full CSV export');
    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    check('26: normal double-click sends exactly one POST', requestsSeen.length === 1, requestsSeen.length);
    const batchCount = await prisma.exportBatch.count({ where: { periodId: period26.id } });
    check('26: normal double-click creates exactly one ExportBatch', batchCount === 1, batchCount);
    await ctx.close();
  }

  {
    // 27: a double-click while the first response is artificially delayed still sends exactly one
    // POST — the synchronous pendingRef guard blocks the second click before React even re-renders
    // the disabled button.
    const period27 = await makeLockedPeriodWithWorker('P27');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    const requestsSeen: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/admin\/periods\/[^/]+\/export$/.test(new URL(req.url()).pathname)) {
        requestsSeen.push(req.url());
        const key = req.headers()['idempotency-key'];
        if (key) capturedIdempotencyKeys.push(key);
      }
    });
    await page.route('**/api/admin/periods/*/export', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period27.id}`);
    await doubleClickNative(page, 'Create full CSV export');
    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    check('27: delayed-response double-click still sends exactly one POST', requestsSeen.length === 1, requestsSeen.length);
    const batchCount = await prisma.exportBatch.count({ where: { periodId: period27.id } });
    check('27: delayed-response double-click creates exactly one ExportBatch', batchCount === 1, batchCount);
    await ctx.close();
  }

  let period28Id = '';
  let key28First = '';
  let body28First = '';
  {
    // 28: a lost response (simulated network failure via route.abort()) shows the "result unknown"
    // state, keeps the same frozen attempt, and never silently reaches the server.
    const period28 = await makeLockedPeriodWithWorker('P28');
    period28Id = period28.id;
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await page.route('**/api/admin/periods/*/export', async (route) => {
      key28First = route.request().headers()['idempotency-key'] ?? '';
      body28First = route.request().postData() ?? '';
      await route.abort('failed');
    });
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period28Id}`);
    await page.locator('button:has-text("Create full CSV export")').click();
    await page.locator('.exp-network-unknown').waitFor({ state: 'visible', timeout: 30000 });
    const unknownText = await page.locator('.exp-network-unknown').innerText();
    check('28: a lost response shows the "result unknown" state with a Retry button', unknownText.includes('Connection problem') && unknownText.includes('Retry'), unknownText);
    const batchCountBeforeRetry = await prisma.exportBatch.count({ where: { periodId: period28Id } });
    check('28: no ExportBatch exists yet — the aborted request never reached the server', batchCountBeforeRetry === 0, batchCountBeforeRetry);

    // 29: Retry sends a byte-identical request — same Idempotency-Key, same body — and this time
    // it's allowed through to succeed.
    let key28Second = '';
    let body28Second = '';
    await page.unroute('**/api/admin/periods/*/export');
    await page.route('**/api/admin/periods/*/export', async (route) => {
      key28Second = route.request().headers()['idempotency-key'] ?? '';
      body28Second = route.request().postData() ?? '';
      capturedIdempotencyKeys.push(key28Second);
      await route.continue();
    });
    await page.locator('button:has-text("Retry")').click();
    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    check('29: Retry reuses the exact same Idempotency-Key as the lost attempt', key28Second === key28First && key28First.length > 0, { key28First, key28Second });
    check('29: Retry sends the exact same request body', body28Second === body28First, { body28First, body28Second });
    await ctx.close();
  }

  {
    // 30: the replayed success reconciles with history — exactly one ExportBatch exists for the
    // period even though the client believed the first attempt's outcome was unknown.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period28Id}`);
    const link = await page.locator(`a:has-text("View details")`).count();
    check('30: the retried export appears in history', link > 0, link);
    const batchCount = await prisma.exportBatch.count({ where: { periodId: period28Id } });
    check('30: exactly one ExportBatch exists after retry reconciliation (no duplicate)', batchCount === 1, batchCount);
    await ctx.close();
  }

  {
    // 31: every separate create attempt across this whole run used its own, never-reused
    // Idempotency-Key (rule: a fresh UUID per handleCreate() call, never per click).
    const unique = new Set(capturedIdempotencyKeys);
    check('31: every captured create attempt used a distinct Idempotency-Key', unique.size === capturedIdempotencyKeys.length && capturedIdempotencyKeys.length >= 5, {
      totalCaptured: capturedIdempotencyKeys.length,
      uniqueCount: unique.size
    });
  }

  // ============================================================================
  // 32-35: mocked/forced HTTP error responses -> exact human-safe text, never raw server internals
  // ============================================================================
  {
    const { startDate, endDate } = nextPeriodDates();
    const period32 = await makePeriod(startDate, endDate, 'LOCKED');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period32.id}`);

    async function mockAndClick(mock: (route: Route) => Promise<void>): Promise<string> {
      await page.unroute('**/api/admin/periods/*/export').catch(() => {});
      await page.route('**/api/admin/periods/*/export', mock);
      await page.locator('button:has-text("Create full CSV export")').click();
      await page.locator('.exp-error-banner').waitFor({ state: 'visible', timeout: 30000 });
      return (await page.locator('.exp-error-banner').innerText()).trim();
    }

    const forbiddenText = await mockAndClick((route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'raw-server-internal-should-never-render' } }) })
    );
    check('32: mocked FORBIDDEN shows the exact human-safe text', forbiddenText === 'You no longer have permission to create exports.', forbiddenText);

    const notAuthText = await mockAndClick((route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_AUTHENTICATED', message: 'raw-server-internal-should-never-render' } }) })
    );
    check('33: mocked NOT_AUTHENTICATED shows the exact human-safe text', notAuthText === 'Your session has expired — please log in again.', notAuthText);

    const csrfText = await mockAndClick((route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CSRF_REJECTED', message: 'raw-server-internal-should-never-render' } }) })
    );
    check('34: mocked CSRF_REJECTED shows the exact human-safe text', csrfText === 'Your session needs a refresh — please reload the page and try again.', csrfText);

    const malformedText = await mockAndClick((route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'not json{{{' }));
    check('35: malformed/non-JSON response body falls back to the generic safe message', malformedText === 'Something went wrong. Please try again.', malformedText);

    const serverErrText = await mockAndClick((route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    check('35: bare 5xx with no recognizable error code falls back to the generic safe message', serverErrText === 'Something went wrong. Please try again.', serverErrText);

    const rawMessageLeak = [forbiddenText, notAuthText, csrfText, malformedText, serverErrText].some((t) => t.includes('raw-server-internal'));
    check('32-35: the raw server error message text never appears in the UI', !rawMessageLeak, { forbiddenText, notAuthText, csrfText });

    await page.unroute('**/api/admin/periods/*/export').catch(() => {});
    await ctx.close();
  }

  // ============================================================================
  // 36-38: keyboard operability, focus visibility, aria-live announcements
  // ============================================================================
  {
    const period36 = await makeLockedPeriodWithWorker('P36');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await page.route('**/api/admin/periods/*/export', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period36.id}`);

    const button = page.locator('button:has-text("Create full CSV export")');
    // 37: focus visibility — a real <button> element that accepts focus and isn't stripped of every
    // focus indicator (either the browser's default outline or a custom box-shadow ring is fine).
    await button.focus();
    const focusStyle = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outlineStyle: s.outlineStyle, boxShadow: s.boxShadow, tagName: el.tagName };
    });
    check('37: Create button is a real, keyboard-focusable <button> with a visible focus indicator', focusStyle.tagName === 'BUTTON' && (focusStyle.outlineStyle !== 'none' || focusStyle.boxShadow !== 'none'), focusStyle);

    // 36: keyboard operability — Enter on the focused button activates it, same as a click.
    await page.keyboard.press('Enter');
    await page.locator('.exp-sr-announce', { hasText: 'Creating export' }).waitFor({ state: 'visible', timeout: 10000 });
    const duringText = await page.locator('.exp-sr-announce').innerText();
    check('36: pressing Enter on the focused Create button activates it (keyboard operability)', duringText.includes('Creating export'), duringText);
    // 38: aria-live progress announcement.
    check('38: aria-live region announces progress ("Creating export…")', duringText.includes('Creating export'), duringText);

    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    // Once status flips to 'success', ExportCreateControl swaps to a different JSX return path
    // where .exp-sr-announce no longer exists — the wrapping .exp-create-success div itself carries
    // aria-live="polite" and contains the final result text instead.
    const afterText = await page.locator('.exp-create-success').innerText();
    check('38: aria-live region announces the final result on success', afterText.toLowerCase().includes('export created'), afterText);
    await ctx.close();
  }

  // ============================================================================
  // 39-40: desktop / mobile 390x844 — no page-level horizontal overflow
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoFresh(page, `${BASE}/admin/export`);
    const overflowHistory = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('39: desktop (1280px) history page has no page-level horizontal overflow', overflowHistory <= 1, overflowHistory);
    await gotoFresh(page, `${BASE}/admin/export/${manyPeriodFullBatchId}`);
    const overflowDetail = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('39: desktop (1280px) detail page has no page-level horizontal overflow', overflowDetail <= 1, overflowDetail);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFresh(page, `${BASE}/admin/export`);
    const overflowHistory = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('40: mobile 390x844 history page has no page-level horizontal overflow', overflowHistory <= 1, overflowHistory);
    await gotoFresh(page, `${BASE}/admin/export/${manyPeriodFullBatchId}`);
    const overflowDetail = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('40: mobile 390x844 detail page has no page-level horizontal overflow', overflowDetail <= 1, overflowDetail);
    await ctx.close();
  }

  // ============================================================================
  // 41: direct navigation to a malformed/missing batchId -> safe not-found state
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/not-a-uuid`);
    const body1 = await bodyText(page);
    check('41: malformed batchId shows the safe not-found state', body1.includes('No export batch with this id'), body1.slice(0, 300));
    check('41: malformed batchId response leaks no stack trace', !body1.includes('.ts:') && !body1.toLowerCase().includes('prismaclient'), null);

    await gotoFresh(page, `${BASE}/admin/export/${randomUUID()}`);
    const body2 = await bodyText(page);
    check('41: well-formed but nonexistent batchId shows the same safe not-found state', body2.includes('No export batch with this id'), body2.slice(0, 300));
    await ctx.close();
  }

  // ============================================================================
  // 42: zero-row export
  // ============================================================================
  let batch42Id = '';
  {
    const { startDate, endDate } = nextPeriodDates();
    const period42 = await makePeriod(startDate, endDate, 'LOCKED');
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export?periodId=${period42.id}`);
    await page.locator('button:has-text("Create full CSV export")').click();
    await page.locator('.exp-create-success').waitFor({ state: 'visible', timeout: 30000 });
    const viewHref = await page.locator('.exp-create-success a', { hasText: 'View details' }).getAttribute('href');
    batch42Id = (viewHref ?? '').split('/').pop() ?? '';
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch42Id}`);
    const body = await bodyText(page);
    const normalized = body.replace(/\s+/g, ' ');
    check('42: zero-row export shows the exact zero-rows message', body.includes('This export has no rows (zero worked hours for this period).'), body.slice(0, 400));
    check('42: zero-row export shows Rows: 0 in the metadata', /rows\s*0\b/i.test(normalized), normalized.slice(0, 300));
    await ctx.close();
  }

  // ============================================================================
  // 43: Unicode (Finnish + Russian) names render correctly, no mojibake
  // ============================================================================
  let batch43Id = '';
  {
    const { startDate, endDate } = nextPeriodDates();
    const period43 = await makePeriod(startDate, endDate, 'LOCKED');
    const site43 = await makeSite('P43', { name: 'Työmaa №1 — Москва' });
    const worker43 = await makeFinalApprovedWorker('P43', site43.id, period43, { firstName: 'Äiti Björk-Ñ', lastName: 'Иванова' });
    await addVersionSegment(worker43.version, worker43.employee.id, site43.id, worker43.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));
    const full43 = await createExportBatch(period43.id, admin.user.id, randomUUID());
    if ('code' in full43) throw new Error(`fixture FULL (period43) failed: ${JSON.stringify(full43)}`);
    batch43Id = full43.batch.id;

    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch43Id}`);
    const body = await bodyText(page);
    check(
      '43: Finnish/Russian Unicode names render correctly with no mojibake',
      body.includes('Äiti Björk-Ñ') && body.includes('Иванова') && body.includes('Työmaa №1 — Москва'),
      body.slice(0, 600)
    );
    await ctx.close();
  }

  // ============================================================================
  // 44-45: forbidden-field HTML/props scan, no raw CSV content embedded in the DOM
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await gotoFresh(page, `${BASE}/admin/export/${batch20CorrectionId}`);
    const detailHtml = await page.content();
    // Free-text field that must never be shown (correction reason) plus JSON-key forms of fields
    // the DTOs deliberately never expose (device/GPS/audit identifiers, raw request/payload hashes).
    const forbiddenSubstrings = ['test correction', '"deviceInstallationId"', '"deviceSequence"', '"payloadHash"', '"requestId"', '"latitude"', '"longitude"'];
    const leakedDetail = forbiddenSubstrings.filter((s) => detailHtml.includes(s));
    check('44: no forbidden fields (correction reason, device/GPS/audit ids) appear in the detail page HTML', leakedDetail.length === 0, leakedDetail);

    const downloadHref = await page.locator('a', { hasText: 'Download CSV' }).getAttribute('href');
    const apiRes = await ctx.request.get(`${BASE}${downloadHref}`);
    const csvText = (await apiRes.body()).toString('utf-8');
    const firstDataLine = csvText.split('\n').find((l) => l.trim().length > 0 && !l.toLowerCase().startsWith('employee'));
    check('45: the raw CSV content itself is not embedded anywhere in the detail page HTML', !!firstDataLine && !detailHtml.includes(firstDataLine.trim()), firstDataLine);

    await gotoFresh(page, `${BASE}/admin/export`);
    const historyHtml = await page.content();
    const leakedHistory = forbiddenSubstrings.filter((s) => historyHtml.includes(s));
    check('44: no forbidden fields appear in the history page HTML either', leakedHistory.length === 0, leakedHistory);
    check('45: the raw CSV content is not embedded in the history page HTML either', !firstDataLine || !historyHtml.includes(firstDataLine.trim()), null);
    await ctx.close();
  }

  // ============================================================================
  // 46: zero console errors / hydration warnings across the entire run
  // ============================================================================
  {
    // Chromium logs a console 'error' for every non-2xx/aborted network response as a browser-level
    // diagnostic (e.g. "Failed to load resource: the server responded with a status of 403") even
    // when the application handles it perfectly gracefully — and items 19/28/32-35 deliberately
    // provoke exactly those responses to test the human-safe error UI. Those are expected browser
    // noise, not application bugs; only unexpected console.error output (real React/app errors)
    // should fail this check.
    const unexpectedConsoleErrors = consoleErrors.filter((e) => !/Failed to load resource:/.test(e));
    check('46: zero unexpected browser console errors were observed across the whole run', unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors.slice(0, 10));
    check('46: zero uncaught page errors were observed across the whole run', pageErrors.length === 0, pageErrors.slice(0, 10));
  }

  console.log(`\n${pass} passed, ${fail} failed (scenarios 1-46)`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
