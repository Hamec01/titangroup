// UT7-B / UT7-B-fixup #2 / UT7-B-fixup-2 (Titanor Time — единый табель) — real Chromium browser QA
// for the "было / стало" diff panel inside a raised row of /admin/timesheets, INCLUDING the
// historical rows fixup #2 added for a removed slice / an unreadable source: both must be genuinely
// visible, expandable rows in the real UI (found and clicked the same way as any normal row), never
// verified only via a direct page.request.get() against the API. Block 8 (UT7-B-fixup-2 #1/#2) uses
// page.route() to deliberately fail the historical-approvals endpoint and proves the main ledger
// (rows/filters/approve) keeps working regardless, a filter change clears the previous filter's
// stale historical rows rather than leaving them on screen, a non-blocking warning appears, and a
// retry recovers. Needs a standalone server (TEST_BASE_URL) started with
// TIMESHEETS_LEDGER_UI_ENABLED=1, CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY and
// IDEMPOTENCY_ENCRYPTION_KEY set, against a disposable PostgreSQL 16.

import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import argon2 from 'argon2';
import { SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, reopenWorkerTimesheetForEdits } from '../lib/worker-timesheets';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const DESKTOP = { width: 1440, height: 900 };
const PASSWORD = 'DiffPanelQaPassw0rd!23';

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
  const d = new Date(Date.UTC(2036, 0, 7) + weekSlot * 14 * 86400000); // 2036-01-07 is a Monday
  weekSlot += 1;
  return d;
}

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `DIFB-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, name: string) {
  return prisma.workArea.create({ data: { siteId, name } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `DIFB-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}
async function buildDraft(employeeId: string, siteId: string, workAreaId: string | null, monday: Date) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  const asg = await mkAssignment(employeeId, siteId, workAreaId);
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: monday, siteId, sourceAssignmentId: asg.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 15), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: monday, startAt: at(monday, 7), endAt: at(monday, 15), siteId, workAreaId, sourceAssignmentId: asg.id } });
  return { period, ts, draft };
}
async function submitTimesheet(employeeId: string, timesheetId: string, source: SubmissionSource = SubmissionSource.MANUAL) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;
    return submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), source);
  });
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function endOf(d: Date): string {
  return isoDate(new Date(d.getTime() + 6 * 86400000));
}
async function findRowIndexByText(rows: ReturnType<Page['locator']>, text: string): Promise<number> {
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const t = await rows.nth(i).innerText();
    if (t.includes(text)) return i;
  }
  return -1;
}

async function approveViaUi(page: Page, rows: ReturnType<Page['locator']>, name: string) {
  const idx = await findRowIndexByText(rows, name);
  await rows.nth(idx).click();
  await page.waitForTimeout(150);
  const row = page.locator('.ledger-row').nth(idx);
  const button = row.locator('.ledger-approve-button');
  await button.click();
  // The fixture's period stays OPEN (required elsewhere for reopenWorkerTimesheetForEdits to work),
  // so every fresh submission carries an EDIT_WINDOW_STILL_OPEN warning -> the two-click
  // "Всё равно подтвердить" flow, never the clean one-click auto-chain.
  const warningConfirm = row.locator('.ledger-approve-warning-confirm .ledger-approve-button');
  await warningConfirm.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if ((await warningConfirm.count()) > 0) {
    await warningConfirm.click();
  }
  await page.waitForFunction(
    (i) => {
      const rowsEl = document.querySelectorAll('.ledger-row-summary');
      return rowsEl[i]?.textContent?.includes('Подтверждено') ?? false;
    },
    idx,
    { timeout: 10000 }
  ).catch(() => {});
  // Collapse again so the next lookup starts clean.
  await rows.nth(idx).click();
  await page.waitForTimeout(100);
}

async function seed() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `difb-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const site = await mkSite('s1');
  const wa = await mkWorkArea(site.id, `Aros Marine ${randomUUID().slice(0, 4)}`);
  const monday = nextMonday();

  // wChanged — approved, then edited+resubmitted (07:00-15:00 -> 07:00-17:00, +2h) -> CHANGED_AFTER_APPROVAL.
  const wChanged = await mkWorker('WChanged');
  const changedDraft = await buildDraft(wChanged.id, site.id, wa.id, monday);
  await submitTimesheet(wChanged.id, changedDraft.ts.id);

  // wUnchanged — approved, never touched again -> stays APPROVED (green), same week/customer group.
  const wUnchanged = await mkWorker('WUnchanged');
  const unchangedDraft = await buildDraft(wUnchanged.id, site.id, wa.id, monday);
  await submitTimesheet(wUnchanged.id, unchangedDraft.ts.id);

  // wRemoved — approved, then all segments deleted and resubmitted -> SLICE_REMOVED.
  const wRemoved = await mkWorker('WRemoved');
  const removedDraft = await buildDraft(wRemoved.id, site.id, wa.id, monday);
  await submitTimesheet(wRemoved.id, removedDraft.ts.id);

  // wUnreadable — approved, then its currentVersionId corrupted directly (simulating a technical
  // read failure that has nothing to do with a real content change).
  const wUnreadable = await mkWorker('WUnreadable');
  const unreadableDraft = await buildDraft(wUnreadable.id, site.id, wa.id, monday);
  await submitTimesheet(wUnreadable.id, unreadableDraft.ts.id);

  return { admin, site, wa, monday, wChanged, changedDraft, wUnchanged, wRemoved, removedDraft, wUnreadable, unreadableDraft };
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

  const rangeQs = `startDate=${isoDate(fx.monday)}&endDate=${endOf(fx.monday)}&workAreaId=${fx.wa.id}`;

  // Approve all four rows first (clean, one-click flow already proven by UT5-B's own browser test).
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    for (const name of ['WChanged', 'WUnchanged', 'WRemoved', 'WUnreadable']) {
      await approveViaUi(page, rows, name);
    }
    const approvedCount = await prisma.customerHoursApprovalItem.count({ where: { approvalState: 'CURRENT' } });
    check('0: all four rows approved', approvedCount >= 4, approvedCount);
  }

  // Change wChanged's hours (extend by 2h) and resubmit.
  {
    await reopenWorkerTimesheetForEdits(fx.wChanged.id, fx.changedDraft.ts.id, adminUserId, randomUUID());
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: fx.changedDraft.draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(fx.monday, 17) } });
    await submitTimesheet(fx.wChanged.id, fx.changedDraft.ts.id);
  }
  // Remove wRemoved's hours entirely and resubmit.
  {
    await reopenWorkerTimesheetForEdits(fx.wRemoved.id, fx.removedDraft.ts.id, adminUserId, randomUUID());
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: fx.removedDraft.draft.id } });
    await submitTimesheet(fx.wRemoved.id, fx.removedDraft.ts.id);
  }
  // Corrupt wUnreadable's canonical source directly (SUBMITTED but currentVersionId nulled).
  {
    await prisma.timesheet.update({ where: { id: fx.unreadableDraft.ts.id }, data: { currentVersionId: null } });
  }

  // ---------------------------------------------------------------------------------------------
  // 1. Changed row: diff panel shows "было / стало", the changed date, and a delta.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const idx = await findRowIndexByText(rows, 'WChanged');
    await rows.nth(idx).click();
    const diffPanel = page.locator('.ledger-row').nth(idx).locator('.ledger-diff-panel');
    await diffPanel.waitFor({ state: 'visible', timeout: 10000 });
    const diffText = await diffPanel.innerText();
    check('1: diff panel shows "Было" and "Стало"', diffText.includes('Было') && diffText.includes('Стало'), diffText);
    check('1b: diff panel shows a delta (Разница)', diffText.includes('Разница'), diffText);
    check('1c: diff panel shows the changed date', diffText.includes('Изменившиеся дни'), diffText);
    check('1d: diff panel shows who/when approved', diffText.includes('Подтвердил'), diffText);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Removed slice — a SUBMITTED timesheet with zero segments anywhere produces no
  //    WEEKLY_CUSTOMER_SLICE row at all (pre-existing ledger behaviour). UT7-B-fixup #2: the approval
  //    history for this exact logical key must still be VISIBLE and EXPANDABLE as a real row in the
  //    UI (not just reachable via a direct API call) — a fresh page load picks up the new historical
  //    row from GET /api/admin/time-ledger/historical-approvals, merged into this customer's group.
  // ---------------------------------------------------------------------------------------------
  {
    const rows = page.locator('.ledger-row-summary');
    const idx = await findRowIndexByText(rows, 'WRemoved');
    check('2: the removed-slice row IS now visible in the ledger (a real, clickable historical row)', idx !== -1, idx);
    const rowText = await rows.nth(idx).innerText();
    check('2b: the row shows the "removed after confirmation" status text', rowText.includes('Часы удалены после подтверждения'), rowText);

    await rows.nth(idx).click();
    const diffPanel = page.locator('.ledger-row').nth(idx).locator('.ledger-diff-panel');
    await diffPanel.waitFor({ state: 'visible', timeout: 10000 });
    const diffText = await diffPanel.innerText();
    check('2c: expanding the historical row shows the SLICE_REMOVED diff note', diffText.includes('Эти часы были полностью удалены'), diffText);
    check('2d: the expanded panel still shows who/when approved (the old confirmation, not lost)', diffText.includes('Подтвердил'), diffText);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Source unreadable — a corrupted currentVersionId (status stays SUBMITTED) makes the whole
  //    Timesheet route into the pre-existing, separate SourceErrorRow section (no normal
  //    WEEKLY_CUSTOMER_SLICE row). UT7-B-fixup #2: the CURRENT approval item itself is left
  //    completely untouched by this (fixup #1 — a read failure must never mass-supersede), yet it
  //    must still surface as a visible, expandable historical row of its own.
  // ---------------------------------------------------------------------------------------------
  {
    const rows = page.locator('.ledger-row-summary');
    const idx = await findRowIndexByText(rows, 'WUnreadable');
    check('3: the source-unreadable row IS visible in the ledger as a historical row', idx !== -1, idx);
    const rowText = await rows.nth(idx).innerText();
    check('3b: the row shows the "source currently unavailable" status text', rowText.includes('Источник часов сейчас недоступен'), rowText);

    await rows.nth(idx).click();
    const diffPanel = page.locator('.ledger-row').nth(idx).locator('.ledger-diff-panel');
    await diffPanel.waitFor({ state: 'visible', timeout: 10000 });
    const diffText = await diffPanel.innerText();
    check('3c: expanding it shows the SOURCE_UNREADABLE diff note (never mistaken for a real content change)', diffText.includes('не удаётся прочитать текущие данные'), diffText);

    const stillCurrentCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: fx.unreadableDraft.ts.id, approvalState: 'CURRENT' } });
    check('3d: the underlying CustomerHoursApprovalItem is genuinely still CURRENT (never touched by the read failure)', stillCurrentCount === 1, stillCurrentCount);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Unchanged row (WUnchanged): no diff panel at all, still shows "Подтверждено".
  // ---------------------------------------------------------------------------------------------
  {
    const rows = page.locator('.ledger-row-summary');
    const idx = await findRowIndexByText(rows, 'WUnchanged');
    const rowTextBefore = await rows.nth(idx).innerText();
    check('4: WUnchanged still shows Подтверждено (untouched rows stay confirmed)', rowTextBefore.includes('Подтверждено'), rowTextBefore);
    await rows.nth(idx).click();
    const diffPanelCount = await page.locator('.ledger-row').nth(idx).locator('.ledger-diff-panel').count();
    check('4b: no diff panel is rendered for an unchanged/approved row', diffPanelCount === 0, diffPanelCount);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Re-confirm the changed row via the existing approve button; a real refetch shows it approved
  //    again, and the diff panel (now comparing against the freshly-approved snapshot) disappears.
  // ---------------------------------------------------------------------------------------------
  {
    const rows = page.locator('.ledger-row-summary');
    const idx = await findRowIndexByText(rows, 'WChanged');
    const row = page.locator('.ledger-row').nth(idx);
    const button = row.locator('.ledger-approve-button');
    check('5: the existing re-confirm button is present and enabled for a changed row', (await button.count()) > 0 && (await button.isEnabled()));
    await button.click();
    const warningConfirm = row.locator('.ledger-approve-warning-confirm .ledger-approve-button');
    await warningConfirm.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if ((await warningConfirm.count()) > 0) {
      await warningConfirm.click();
    }
    await page.waitForFunction(
      (i) => {
        const rowsEl = document.querySelectorAll('.ledger-row-summary');
        return rowsEl[i]?.textContent?.includes('Подтверждено') ?? false;
      },
      idx,
      { timeout: 10000 }
    ).catch(() => {});
    const rowTextAfter = await page.locator('.ledger-row-summary').nth(idx).innerText();
    check('5b: re-confirming a changed row succeeds (real refetch shows Подтверждено)', rowTextAfter.includes('Подтверждено'), rowTextAfter);
    const currentCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: fx.changedDraft.ts.id, approvalState: 'CURRENT' } });
    check('5c: exactly one CURRENT item for the re-confirmed slice', currentCount === 1, currentCount);
  }

  // ---------------------------------------------------------------------------------------------
  // 6. "Сегодня" / worker-facing pages are completely unaffected by this feature.
  // ---------------------------------------------------------------------------------------------
  {
    const res = await page.goto(`${BASE}/foreman`, { waitUntil: 'networkidle' }).catch(() => null);
    check('6: an unrelated page still loads normally (no regression from this feature)', res !== null && res.status() < 500);
  }

  check('7: zero unexpected console errors', consoleErrors.length === 0, consoleErrors);

  // ---------------------------------------------------------------------------------------------
  // 8. UT7-B-fixup-2 #1/#2 — a failing historical-approvals endpoint never breaks the main ledger,
  //    and a client-side filter change clears the PREVIOUS filter's historical rows / shows a
  //    non-blocking warning rather than leaving stale rows on screen. Deliberately placed after
  //    check 7 (the aborted network requests this block injects surface as console noise Chromium
  //    itself logs for a failed resource load, which would otherwise pollute that unrelated check).
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const rowsBefore = page.locator('.ledger-row-summary');
    const removedIdxBefore = await findRowIndexByText(rowsBefore, 'WRemoved');
    check('8: WRemoved historical row visible before the injected failure', removedIdxBefore !== -1, removedIdxBefore);

    // Make every subsequent historical-approvals request fail at the network level.
    await page.route('**/api/admin/time-ledger/historical-approvals**', (route) => route.abort());

    // A client-side filter change that keeps status compatible (no status select touched) — types
    // into the employee-search box; every fixture worker's firstName starts with 'W', so this
    // genuinely changes the filter (a real client fetch, not a no-op) without hiding anyone.
    const searchInput = page.locator('.ledger-filter-field input[type="text"]').first();
    await searchInput.fill('W');
    await page.waitForTimeout(500); // debounce + fetch round-trip

    // Main ledger still works: a normal row for this (still-compatible) filter is still shown.
    const rowsAfter = page.locator('.ledger-row-summary');
    const changedIdxAfter = await findRowIndexByText(rowsAfter, 'WChanged');
    check('8b: the main ledger still renders normal rows while the historical fetch is failing', changedIdxAfter !== -1, changedIdxAfter);

    // A non-blocking warning is shown for the historical load failure specifically.
    const warning = page.locator('.ledger-historical-warning');
    await warning.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check('8c: a non-blocking historical-load-error warning is shown', (await warning.count()) > 0, await warning.count());

    // The PREVIOUS filter's stale historical row (WRemoved) must NOT still be shown under the new
    // filter — the fetch failed, so it must be cleared, never left over as if still valid.
    const removedIdxAfter = await findRowIndexByText(rowsAfter, 'WRemoved');
    check('8d: the stale WRemoved historical row from the PREVIOUS filter is gone, not left over', removedIdxAfter === -1, removedIdxAfter);

    // Recover: let requests succeed again, click the warning's own retry button.
    await page.unroute('**/api/admin/time-ledger/historical-approvals**');
    const retryButton = warning.locator('.ledger-retry-button');
    await retryButton.click();
    // Wait for the actual refetch to land (WRemoved's row text reappearing), not just for the
    // warning to clear — setHistoricalError(false) happens synchronously on click, well before the
    // async refetch itself resolves and repopulates historicalRows.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('.ledger-row-summary')).some((el) => el.textContent?.includes('WRemoved')),
      { timeout: 10000 }
    ).catch(() => {});
    const warningAfterRetry = await page.locator('.ledger-historical-warning').count();
    check('8e: retry clears the warning once the historical fetch works again', warningAfterRetry === 0, warningAfterRetry);
    const rowsAfterRetry = page.locator('.ledger-row-summary');
    const removedIdxAfterRetry = await findRowIndexByText(rowsAfterRetry, 'WRemoved');
    check('8f: WRemoved historical row reappears after a successful retry', removedIdxAfterRetry !== -1, removedIdxAfterRetry);
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
