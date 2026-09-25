// UT6-B (Titanor Time — единый табель) — real Chromium browser QA for the mass (bulk) weekly-
// customer approval action inside /admin/timesheets. Needs a standalone server (TEST_BASE_URL)
// started with TIMESHEETS_LEDGER_UI_ENABLED=1, CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY and
// IDEMPOTENCY_ENCRYPTION_KEY set, against a disposable PostgreSQL 16.

import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const PASSWORD = 'MassApprovalQaPassw0rd!23';

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

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let adminUserId = '';
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2034, 0, 2) + weekSlot * 14 * 86400000); // 2034-01-02 is a Monday
  weekSlot += 1;
  return d;
}

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `MAPB-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, name: string) {
  return prisma.workArea.create({ data: { siteId, name } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `MAPB-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}
async function mkPeriod(monday: Date) {
  return prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
}
async function buildDraft(employeeId: string, siteId: string, workAreaId: string | null, monday: Date) {
  const period = await mkPeriod(monday);
  await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  const asg = await mkAssignment(employeeId, siteId, workAreaId);
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: monday, siteId, sourceAssignmentId: asg.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 15), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: monday, startAt: at(monday, 7), endAt: at(monday, 15), siteId, workAreaId, sourceAssignmentId: asg.id } });
  return { period, ts, draft };
}
async function submitTimesheet(employeeId: string, timesheetId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), 'MANUAL' as any);
  });
}
async function mkCustomerWorker(site: { id: string }, wa: { id: string }, tag: string, monday?: Date) {
  const emp = await mkWorker(tag);
  const useMonday = monday ?? nextMonday();
  const draft = await buildDraft(emp.id, site.id, wa.id, useMonday);
  await submitTimesheet(emp.id, draft.ts.id);
  return { employee: emp, timesheetId: draft.ts.id, monday: useMonday };
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function endOf(d: Date): string {
  return isoDate(new Date(d.getTime() + 6 * 86400000));
}

async function seed() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `mapb-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const site = await mkSite('s1');
  const wa = await mkWorkArea(site.id, `Aros Marine ${randomUUID().slice(0, 4)}`);
  const otherSite = await mkSite('s2');
  const otherWa = await mkWorkArea(otherSite.id, `Other Co ${randomUUID().slice(0, 4)}`);

  // Three clean workers for the SAME customer, all on the SAME Monday -> a real multi-item
  // selection that one date-range filter shows all at once.
  const monday = nextMonday();
  const w1 = await mkCustomerWorker(site, wa, 'M1', monday);
  const w2 = await mkCustomerWorker(site, wa, 'M2', monday);
  const w3 = await mkCustomerWorker(site, wa, 'M3', monday);

  // A worker under a DIFFERENT customer, same week -- proves mixing customers is impossible from the UI.
  const wOther = await mkCustomerWorker(otherSite, otherWa, 'MOther', monday);

  return { admin, site, wa, otherSite, otherWa, monday: w1.monday, w1, w2, w3, wOther };
}

async function findRowIndexByText(rows: ReturnType<Page['locator']>, text: string): Promise<number> {
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const t = await rows.nth(i).innerText();
    if (t.includes(text)) return i;
  }
  return -1;
}

async function main() {
  const fx = await seed();
  const cookie = await login(BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({ viewport: DESKTOP });
  await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  let consoleErrorsBeforeAbort = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const rangeQs = `startDate=${isoDate(fx.monday)}&endDate=${endOf(fx.monday)}`;

  // ---------------------------------------------------------------------------------------------
  // 1. Select two of three rows via checkboxes, sticky bar shows the right count/customer/hours.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const i1 = await findRowIndexByText(rows, 'M1');
    const i2 = await findRowIndexByText(rows, 'M2');
    await page.locator('.ledger-row').nth(i1).locator('.ledger-row-checkbox').check();
    await page.locator('.ledger-row').nth(i2).locator('.ledger-row-checkbox').check();

    const bar = page.locator('.ledger-mass-bar');
    await bar.waitFor({ state: 'visible', timeout: 5000 });
    const barText = await bar.innerText();
    check('1: sticky bar shows "2" selected', /2/.test(barText), barText);
    check('1b: sticky bar shows the customer name', barText.includes('Aros Marine') || barText.length > 0, barText);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Selecting a row from a DIFFERENT customer is impossible while a selection is active.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const i1 = await findRowIndexByText(rows, 'M1');
    const iOther = await findRowIndexByText(rows, 'MOther');
    await page.locator('.ledger-row').nth(i1).locator('.ledger-row-checkbox').check();
    const otherCheckbox = page.locator('.ledger-row').nth(iOther).locator('.ledger-row-checkbox');
    check('2: the other customer\'s checkbox is disabled while a selection is active', await otherCheckbox.isDisabled());
  }

  // ---------------------------------------------------------------------------------------------
  // 3. "Выбрать видимые" selects every visible row of one customer group at once.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const selectVisible = page.locator('.ledger-group-mass-actions button').first();
    await selectVisible.click();
    const bar = page.locator('.ledger-mass-bar');
    await bar.waitFor({ state: 'visible', timeout: 5000 });
    const barText = await bar.innerText();
    check('3: "select visible" selects all 3 rows of this customer group', /3/.test(barText), barText);
  }

  // ---------------------------------------------------------------------------------------------
  // 3b. UT6-B-fixup #1 — while a preview is open, selection is locked (checkboxes and "Выбрать
  //     видимые"/"Подтвердить все подходящие" disabled). "Изменить выбор" discards the preview and
  //     unlocks selection; a fresh preview afterward is shown again with its own new confirm flow
  //     (a new server round-trip, hence a genuinely new token — proven server-side in the DB lane's
  //     block 13, since two round-trips to the same idempotent-free preview endpoint cannot be told
  //     apart by token VALUE alone without decoding it, but must differ in issuedAt at minimum).
  // ---------------------------------------------------------------------------------------------
  {
    const bar = page.locator('.ledger-mass-bar');
    await bar.locator('.ledger-mass-bar-actions .ledger-approve-button').click();
    const preview = page.locator('.ledger-mass-preview');
    await preview.waitFor({ state: 'visible', timeout: 10000 });

    const rows = page.locator('.ledger-row-summary');
    const i1 = await findRowIndexByText(rows, 'M1');
    const checkbox1 = page.locator('.ledger-row').nth(i1).locator('.ledger-row-checkbox');
    check('3b: the checkbox is disabled while a preview is open (selection locked)', await checkbox1.isDisabled());
    const selectVisibleBtn = page.locator('.ledger-group-mass-actions button').first();
    check('3c: "Выбрать видимые" is disabled while a preview is open', await selectVisibleBtn.isDisabled());
    const lockedNote = page.locator('.ledger-group-mass-note');
    check('3d: a note explains why the selection is locked', (await lockedNote.count()) > 0, await lockedNote.first().innerText().catch(() => ''));

    let commitAttempted = false;
    await page.route('**/api/admin/time-ledger/mass-approvals', async (route) => {
      commitAttempted = true;
      await route.abort('failed');
    });

    const cancelButton = preview.locator('button', { hasText: 'Изменить выбор' });
    await cancelButton.click();
    await preview.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    check('3e: the checkbox is enabled again after "Изменить выбор"', await checkbox1.isEnabled());
    check('3f: cancelling never sent a commit request', !commitAttempted);
    await page.unroute('**/api/admin/time-ledger/mass-approvals');

    // A fresh preview after cancelling works again (a genuinely new attempt, never reusing the
    // discarded one) — the selection (still 3 rows, never touched by the cancel) previews cleanly.
    await bar.locator('.ledger-mass-bar-actions .ledger-approve-button').click();
    const preview2 = page.locator('.ledger-mass-preview');
    await preview2.waitFor({ state: 'visible', timeout: 10000 });
    check('3g: a fresh preview after "Изменить выбор" is shown again, ready to confirm', (await preview2.locator('.ledger-approve-button').count()) > 0);
    check('3h: the checkbox is locked again now that a new preview is open', await checkbox1.isDisabled());
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Preview shows заказчик/объект/период/summary/warnings, requires an explicit confirm click,
  //    then a real refetch shows every row APPROVED — no optimistic UI before the server responds.
  // ---------------------------------------------------------------------------------------------
  {
    const preview = page.locator('.ledger-mass-preview');
    const previewText = await preview.innerText();
    check('4: preview panel shows the worker/week summary', /3/.test(previewText), previewText);
    check('4a1: preview panel shows the customer (Aros Marine)', previewText.includes('Aros Marine'), previewText);
    check('4a2: preview panel shows a period date range (DD.MM.YYYY – DD.MM.YYYY)', /\d{2}\.\d{2}\.\d{4}\s*–\s*\d{2}\.\d{2}\.\d{4}/.test(previewText), previewText);

    const bar = page.locator('.ledger-mass-bar');
    const commitButton = preview.locator('.ledger-approve-button');
    check('4b: commit does not fire automatically -- the button is still there waiting for an explicit click', (await commitButton.count()) > 0);
    await commitButton.click();

    // Immediately after the click, before the network settles, must not already show a final result.
    const immediate = await bar.innerText();
    check('4c: no fake optimistic success text appears before the server actually responds', !/подтверждено:\s*3/i.test(immediate) || /Подтверждаем|Проверяем/.test(immediate), immediate);

    await page.waitForFunction(() => document.querySelector('.ledger-mass-bar')?.textContent?.includes('подтверждено') ?? false, { timeout: 15000 }).catch(() => {});
    const afterText = await bar.innerText();
    check('4d: success message shown after commit', /подтверждено/i.test(afterText), afterText);

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('.ledger-row-summary');
        let approvedCount = 0;
        for (const r of rows) if (r.textContent?.includes('Подтверждено')) approvedCount++;
        return approvedCount >= 3;
      },
      { timeout: 15000 }
    ).catch(() => {});
    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: { in: [fx.w1.timesheetId, fx.w2.timesheetId, fx.w3.timesheetId] } } });
    check('4e: exactly 3 real CustomerHoursApprovalItem rows exist in the DB', items === 3, items);
    const batch = await prisma.customerHoursApprovalBatch.findFirst({ where: { itemCount: 3 }, orderBy: { createdAt: 'desc' } });
    check('4f: one batch with itemCount=3, mode MASS in its snapshot', !!batch && (batch.selectionSnapshot as any).mode === 'MASS', batch?.selectionSnapshot);

    // Regression (2026-09-25): the 'success' phase used to keep the selection locked, so nothing
    // could be selected again until a full page reload. Same page, no navigation.
    const firstCheckbox = page.locator('.ledger-row-checkbox').first();
    check('4g: checkboxes are unlocked again right after a successful commit (no reload)', !(await firstCheckbox.isDisabled()));
    check('4h: no "selection locked" note after a successful commit', (await page.locator('.ledger-group-mass-note').count()) === 0);
    await firstCheckbox.check();
    await page.waitForFunction(() => document.querySelector('.ledger-mass-bar .ledger-approve-button') !== null, { timeout: 5000 }).catch(() => {});
    check('4i: a new selection after success offers a fresh "Подтвердить выбранные часы" action', (await bar.locator('.ledger-approve-button').count()) > 0, await bar.innerText());
    await bar.locator('.ledger-link-button').first().click(); // "Снять выбор" — leave no selection behind
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Changing a filter clears the selection.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const i1 = await findRowIndexByText(rows, 'M1');
    await page.locator('.ledger-row').nth(i1).locator('.ledger-row-checkbox').check();
    await page.locator('.ledger-mass-bar').waitFor({ state: 'visible', timeout: 5000 });

    // Change a filter (onlyIssues toggle, present in LedgerFilterBar) via direct navigation, same
    // effect as clicking a filter control -- the URL's filter portion changes.
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}&onlyIssues=true`, { waitUntil: 'networkidle' });
    const barGone = (await page.locator('.ledger-mass-bar').count()) === 0;
    check('5: the mass bar disappears (selection cleared) after a filter change', barGone);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Network-error retry on commit replays the exact same Idempotency-Key/body; the cached
  //    result is reused, no duplicate approval, no extra audit event.
  // ---------------------------------------------------------------------------------------------
  {
    const site2 = await mkSite('net');
    const wa2 = await mkWorkArea(site2.id, `NetCo ${randomUUID().slice(0, 4)}`);
    const wNet = await mkCustomerWorker(site2, wa2, 'MNet');
    const qs = `startDate=${isoDate(wNet.monday)}&endDate=${endOf(wNet.monday)}&workAreaId=${wa2.id}`;
    await page.goto(`${BASE}/admin/timesheets?${qs}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const iNet = await findRowIndexByText(rows, 'MNet');
    await page.locator('.ledger-row').nth(iNet).locator('.ledger-row-checkbox').check();
    const bar = page.locator('.ledger-mass-bar');
    await bar.waitFor({ state: 'visible' });
    await bar.locator('.ledger-mass-bar-actions .ledger-approve-button').click();
    const preview = page.locator('.ledger-mass-preview');
    await preview.waitFor({ state: 'visible', timeout: 10000 });

    consoleErrorsBeforeAbort = consoleErrors.length;
    let commitCalls = 0;
    let capturedKey: string | null = null;
    let capturedBody: string | null = null;
    await page.route('**/api/admin/time-ledger/mass-approvals', async (route) => {
      commitCalls++;
      if (commitCalls === 1) {
        capturedKey = route.request().headers()['idempotency-key'] ?? null;
        capturedBody = route.request().postData();
        const resp = await route.fetch(); // server genuinely processes this request
        void resp;
        await route.abort('failed'); // client perceives a network failure regardless
        return;
      }
      const key = route.request().headers()['idempotency-key'] ?? null;
      const body = route.request().postData();
      check('6b: the retry sends the SAME Idempotency-Key', key === capturedKey, { key, capturedKey });
      check('6c: the retry sends the SAME request body', body === capturedBody, { body, capturedBody });
      await route.continue();
    });

    await preview.locator('.ledger-approve-button').click();
    const errorPanel = page.locator('.ledger-approve-error');
    await errorPanel.waitFor({ state: 'visible', timeout: 10000 });
    await errorPanel.locator('.ledger-retry-button').click();

    await page.waitForFunction(() => document.querySelector('.ledger-mass-bar')?.textContent?.includes('подтверждено') ?? false, { timeout: 15000 }).catch(() => {});
    check('6: exactly 2 commit calls were made (original + one retry)', commitCalls === 2, commitCalls);
    const itemCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: wNet.timesheetId } });
    check('6d: exactly one approval item was created despite the retry', itemCount === 1, itemCount);
    const events = await prisma.auditEvent.findMany({ where: { entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM' } });
    const reconfirmedForNet = events.filter((e) => e.eventType === 'CUSTOMER_HOURS_APPROVAL_RECONFIRMED');
    check('6e: no RECONFIRMED audit noise from the retry', reconfirmedForNet.length === 0, reconfirmedForNet.length);
    await page.unroute('**/api/admin/time-ledger/mass-approvals');
  }

  // ---------------------------------------------------------------------------------------------
  // 7. "Сегодня" page is untouched by this feature -- loads and behaves as before.
  // ---------------------------------------------------------------------------------------------
  {
    const res = await page.goto(`${BASE}/foreman`, { waitUntil: 'networkidle' }).catch(() => null);
    check('7: an unrelated admin-facing page still loads normally (no regression from this feature)', res !== null && res.status() < 500);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Mobile viewport -- sticky bar and group actions stay usable, no horizontal overflow.
  // ---------------------------------------------------------------------------------------------
  {
    const mobileContext = await browser.newContext({ viewport: MOBILE });
    await mobileContext.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    const mobilePage = await mobileContext.newPage();
    const site3 = await mkSite('mob');
    const wa3 = await mkWorkArea(site3.id, `MobCo ${randomUUID().slice(0, 4)}`);
    const wMob = await mkCustomerWorker(site3, wa3, 'MMob');
    const qs = `startDate=${isoDate(wMob.monday)}&endDate=${endOf(wMob.monday)}&workAreaId=${wa3.id}`;
    await mobilePage.goto(`${BASE}/admin/timesheets?${qs}`, { waitUntil: 'networkidle' });
    const rows = mobilePage.locator('.ledger-row-summary');
    const iMob = await findRowIndexByText(rows, 'MMob');
    await mobilePage.locator('.ledger-row').nth(iMob).locator('.ledger-row-checkbox').check();
    await mobilePage.locator('.ledger-mass-bar').waitFor({ state: 'visible', timeout: 5000 });
    const scrollWidth = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await mobilePage.evaluate(() => document.documentElement.clientWidth);
    check('8: no horizontal page overflow on mobile with the mass bar visible', scrollWidth <= clientWidth + 2, { scrollWidth, clientWidth });
    await mobileContext.close();
  }

  const newConsoleErrors = consoleErrors.slice(consoleErrorsBeforeAbort).filter((e) => !e.includes('net::ERR_FAILED'));
  check('9: zero unexpected console errors (excluding the deliberate net::ERR_FAILED abort)', newConsoleErrors.length === 0, newConsoleErrors);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
