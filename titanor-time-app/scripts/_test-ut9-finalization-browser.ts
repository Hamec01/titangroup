// UT9-B-fixup (Titanor Time — единый путь принятия часов) — real Chromium browser QA for the two
// user-journey pieces the owner asked to prove end-to-end rather than only at the API layer:
//  1. clicking the TIMESHEET_AWAITING_APPROVAL notification lands the admin in the new «Табель»
//     scoped to the exact employeeId + period (components/admin/NotificationCenter.tsx's handleView);
//  2. "Принять всю неделю" for a worker split across two customers in one week — scoped to the EXACT
//     week (not the admin's current, possibly much wider, visible date range — UT9-B-fixup #1) —
//     shows both customers in preview, confirms both in one commit, and the Timesheet becomes
//     FINAL_APPROVED, with a clear success result in the UI.
// Needs a standalone server (TEST_BASE_URL) started with TIMESHEETS_LEDGER_UI_ENABLED=1,
// CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY and IDEMPOTENCY_ENCRYPTION_KEY set, against a
// disposable PostgreSQL 16.

import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const DESKTOP = { width: 1440, height: 900 };
const PASSWORD = 'Ut9FixupBrowserQaPassw0rd!23';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
  }
}

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let adminUserId = '';
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2040, 0, 2) + weekSlot * 14 * 86400000); // 2040-01-02 is a Monday
  weekSlot += 1;
  return d;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function endOf(d: Date): string {
  return isoDate(new Date(d.getTime() + 6 * 86400000));
}

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `UT9FIX-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `UT9FIX-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `UT9FIX-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}

/** One period+timesheet+DRAFT (never submitted) with a single day's segment at (siteId, workAreaId)
 *  on `day` — cheap "filler" data: a real WEEKLY_CUSTOMER_SLICE entry the ledger will return, without
 *  the cost of a full submitWorkerTimesheetCore transactional submit. Used only to prove the target
 *  week's rows are found by EXACT (employeeId, weekStart..weekEnd) scoping regardless of how much
 *  OTHER data this same worker has in the admin's currently-selected wider date range. */
async function buildFillerDraftDay(employeeId: string, siteId: string, workAreaId: string | null, sourceAssignmentId: string, monday: Date) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: monday, siteId, sourceAssignmentId, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 12), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: monday, startAt: at(monday, 7), endAt: at(monday, 12), siteId, workAreaId, sourceAssignmentId } });
}

async function buildDraftDay(employeeId: string, siteId: string, workAreaId: string | null, sourceAssignmentId: string, draftId: string, day: Date) {
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId, date: day, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId, employeeId, date: day, siteId, sourceAssignmentId, plannedStartAt: at(day, 7), plannedEndAt: at(day, 15), plannedBreakMinutes: 0 } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId, employeeId, date: day, startAt: at(day, 7), endAt: at(day, 15), siteId, workAreaId, sourceAssignmentId } });
}

async function seed() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `ut9fix-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  // ---- Scenario 1: notification click-through ----------------------------------------------------
  const site1 = await mkSite('N1');
  const wa1 = await mkWorkArea(site1.id, 'N1');
  const monday1 = nextMonday();
  const worker1 = await mkWorker('Notif');
  const asg1 = await mkAssignment(worker1.id, site1.id, wa1.id);
  const period1 = await prisma.payrollPeriod.create({ data: { startDate: monday1, endDate: new Date(monday1.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period1.id, employeeId: worker1.id, expected: true } });
  const ts1 = await prisma.timesheet.create({ data: { employeeId: worker1.id, periodId: period1.id, status: 'DRAFT' } });
  const draft1 = await prisma.timesheetDraft.create({ data: { timesheetId: ts1.id, employeeId: worker1.id } });
  await buildDraftDay(worker1.id, site1.id, wa1.id, asg1.id, draft1.id, monday1);
  const { submitWorkerTimesheetCore } = await import('../lib/worker-timesheets');
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${worker1.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts1.id}::uuid FOR UPDATE`;
    const { SubmissionSource } = await import('@prisma/client');
    await submitWorkerTimesheetCore(tx, worker1.id, ts1.id, adminUserId, randomUUID(), SubmissionSource.MANUAL);
  });
  const { ensureTimesheetApprovalNotifications } = await import('../lib/timesheet-approval-notifications');
  await ensureTimesheetApprovalNotifications();

  // ---- Scenario 2: whole week, two customers, plus "displacement" filler weeks --------------------
  const siteA = await mkSite('WA');
  const waA = await mkWorkArea(siteA.id, 'WA');
  const siteB = await mkSite('WB');
  const waB = await mkWorkArea(siteB.id, 'WB');
  const siteFiller = await mkSite('Filler');
  const waFiller = await mkWorkArea(siteFiller.id, 'Filler');
  const worker2 = await mkWorker('Week');
  const asgFiller = await mkAssignment(worker2.id, siteFiller.id, waFiller.id, true);
  const asgA = await mkAssignment(worker2.id, siteA.id, waA.id, false);
  const asgB = await mkAssignment(worker2.id, siteB.id, waB.id, false);

  // Three EARLIER weeks of filler data for the SAME worker at a THIRD, unrelated customer — all
  // inside the wide date range the browser test below will select — proving they are neither
  // pulled into the whole-week selection nor able to push the target week's own rows out of it.
  const fillerMondays: Date[] = [];
  for (let i = 0; i < 3; i++) {
    const m = nextMonday();
    fillerMondays.push(m);
    await buildFillerDraftDay(worker2.id, siteFiller.id, waFiller.id, asgFiller.id, m);
  }

  // The TARGET week — customer A on Monday, customer B on Tuesday (a day split between customers),
  // both real, both submitted.
  const targetMonday = nextMonday();
  const targetTuesday = new Date(targetMonday.getTime() + 86400000);
  const period2 = await prisma.payrollPeriod.create({ data: { startDate: targetMonday, endDate: new Date(targetMonday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period2.id, employeeId: worker2.id, expected: true } });
  const ts2 = await prisma.timesheet.create({ data: { employeeId: worker2.id, periodId: period2.id, status: 'DRAFT' } });
  const draft2 = await prisma.timesheetDraft.create({ data: { timesheetId: ts2.id, employeeId: worker2.id } });
  await buildDraftDay(worker2.id, siteA.id, waA.id, asgA.id, draft2.id, targetMonday);
  await buildDraftDay(worker2.id, siteB.id, waB.id, asgB.id, draft2.id, targetTuesday);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${worker2.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts2.id}::uuid FOR UPDATE`;
    const { SubmissionSource } = await import('@prisma/client');
    await submitWorkerTimesheetCore(tx, worker2.id, ts2.id, adminUserId, randomUUID(), SubmissionSource.MANUAL);
  });

  return { admin, worker1, period1, ts1, worker2, ts2, fillerMondays, targetMonday, targetTuesday };
}

async function main() {
  const fx = await seed();
  const cookie = await login(BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: DESKTOP });
  await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // ---------------------------------------------------------------------------------------------
  // 1. Notification click-through — bell -> drawer -> "Открыть табель" -> exact employeeId+period.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets`, { waitUntil: 'networkidle' });
    // components/admin/ReviewQueueIndicator.tsx (the OLD queue's own header bell) reuses the exact
    // same .notif-bell-button/.notif-drawer classes as components/admin/NotificationCenter.tsx —
    // disambiguated via the aria-label text, which only NotificationCenter's ever contains
    // "уведомлени" (ReviewQueueIndicator's own says "табелей на утверждении").
    const bell = page.locator('.notif-bell-button[aria-label*="уведомлени"]');
    await bell.waitFor({ state: 'visible', timeout: 10000 });
    await bell.click();
    const drawer = page.locator('.notif-drawer');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
    const items = page.locator('.notif-drawer-item');
    const count = await items.count();
    let targetIndex = -1;
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).locator('.notif-drawer-item-name').innerText().catch(() => '');
      if (text.includes('Notif')) {
        targetIndex = i;
        break;
      }
    }
    check('1: the TIMESHEET_AWAITING_APPROVAL notification for our worker is present in the drawer', targetIndex !== -1, await items.allInnerTexts());
    if (targetIndex !== -1) {
      await items.nth(targetIndex).locator('.notif-drawer-item-link').click();
      await page.waitForURL((u) => u.searchParams.get('employeeId') === fx.worker1.id, { timeout: 10000 });
      const url = new URL(page.url());
      check('1b: clicking the notification lands on /admin/timesheets with the exact employeeId', url.pathname === '/admin/timesheets' && url.searchParams.get('employeeId') === fx.worker1.id, page.url());
      check('1c: ...and the exact period start/end', url.searchParams.get('startDate') === isoDate(fx.period1.startDate) && url.searchParams.get('endDate') === isoDate(fx.period1.endDate), page.url());
      await page.waitForLoadState('networkidle');
      await page.locator('.ledger-row-summary').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const rowText = await page.locator('.ledger-row-summary').first().innerText().catch(() => '');
      check(
        '1d: the resulting page actually shows this exact worker\'s row (not just a URL change)',
        rowText.includes('Notif'),
        { rowText, url: page.url() }
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 2. "Принять всю неделю" — scoped to the EXACT week, resistant to filler data from earlier weeks
  //    within the same wide admin-selected date range (UT9-B-fixup #1).
  // ---------------------------------------------------------------------------------------------
  {
    // A WIDE range covering every filler week AND the target week — the admin's current, broad view.
    const wideStart = isoDate(fx.fillerMondays[0]);
    const wideEnd = endOf(fx.targetMonday);
    await page.goto(`${BASE}/admin/timesheets?startDate=${wideStart}&endDate=${wideEnd}&employeeSearch=Week`, { waitUntil: 'networkidle' });

    const rows = page.locator('.ledger-row-summary');
    const rowCount = await rows.count();
    check('2: the wide range shows more than 2 rows for this worker (filler weeks present)', rowCount > 2, rowCount);

    // Find and expand the TARGET week's row specifically (by its own week-start text).
    let targetRowIndex = -1;
    for (let i = 0; i < rowCount; i++) {
      const weekText = await rows.nth(i).locator('.ledger-row-week').innerText().catch(() => '');
      if (weekText.trim() === isoDate(fx.targetMonday)) {
        targetRowIndex = i;
        break;
      }
    }
    check('2b: the target week\'s own row is present among the filler rows', targetRowIndex !== -1, targetRowIndex);
    await rows.nth(targetRowIndex).click();
    await page.waitForTimeout(150);

    // Intercept the actual network request "Принять всю неделю" fires — the direct, precise proof
    // that it is scoped to startDate=weekStart/endDate=weekEnd (this row's own week), never the wide
    // admin-selected range above.
    const expandedPanel = page.locator('.ledger-expanded').first();
    const weekButton = expandedPanel.locator('.ledger-approve-action button', { hasText: 'Принять всю неделю' });
    await weekButton.waitFor({ state: 'visible', timeout: 5000 });

    const requestPromise = page.waitForRequest((req) => req.url().includes('/api/admin/time-ledger?') && req.method() === 'GET');
    await weekButton.click();
    const request = await requestPromise;
    const reqUrl = new URL(request.url());
    check('2c: the whole-week request is scoped to the EXACT week (startDate=weekStart)', reqUrl.searchParams.get('startDate') === isoDate(fx.targetMonday), request.url());
    check('2d: ...and endDate=weekEnd (never the wide admin-selected range)', reqUrl.searchParams.get('endDate') === endOf(fx.targetMonday), request.url());
    check('2e: ...and the exact employeeId', reqUrl.searchParams.get('employeeId') === fx.worker2.id, request.url());

    const bar = page.locator('.ledger-mass-bar');
    await bar.waitFor({ state: 'visible', timeout: 10000 });
    const barText = await bar.innerText();
    check('2f: exactly 2 items selected (both customers of the target week — none of the 3 filler weeks)', barText.includes('Выбрано: 2'), barText);

    await bar.locator('.ledger-mass-bar-actions .ledger-approve-button').click();
    const preview = page.locator('.ledger-mass-preview');
    await preview.waitFor({ state: 'visible', timeout: 10000 });
    const previewText = await preview.innerText();
    check('2g: the preview shows the worker\'s own name (whole-week context, not a customer name)', previewText.includes('Week'), previewText);
    check('2h: the preview summary reflects exactly 2 week-parts (both customers, never the 3 filler weeks)', previewText.includes('2 недел'), previewText);

    const commitButton = preview.locator('.ledger-approve-button');
    await commitButton.click();
    await page
      .waitForFunction(() => document.querySelector('.ledger-mass-bar')?.textContent?.includes('подтверждено') ?? false, { timeout: 15000 })
      .catch(() => {});
    const finalBarText = await bar.innerText().catch(() => '');
    check('2i: a clear, understandable success result appears in the UI', finalBarText.includes('подтверждено'), finalBarText);

    const freshTs = await prisma.timesheet.findUniqueOrThrow({ where: { id: fx.ts2.id }, select: { status: true } });
    check('2j: the Timesheet became FINAL_APPROVED as an atomic consequence of the single commit', freshTs.status === 'FINAL_APPROVED', freshTs.status);
    const itemA = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: fx.ts2.id, approvalState: 'CURRENT' } });
    check('2k: exactly 2 CURRENT approval items exist (both customers actually confirmed)', itemA === 2, itemA);
  }

  check('9: zero unexpected console errors', consoleErrors.length === 0, consoleErrors);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
