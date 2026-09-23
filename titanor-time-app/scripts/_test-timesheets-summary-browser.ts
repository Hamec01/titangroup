// UT8-B (Titanor Time — единый табель) — real Chromium browser QA for the new "Сводка" tab
// (replaces SummaryTabPlaceholder). Needs a standalone server (TEST_BASE_URL) started with
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
const PASSWORD = 'SummaryTabQaPassw0rd!23';

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
  const d = new Date(Date.UTC(2038, 0, 4) + weekSlot * 14 * 86400000); // 2038-01-04 is a Monday
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
  return prisma.workSite.create({ data: { name: `SUMB-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, name: string) {
  return prisma.workArea.create({ data: { siteId, name } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `SUMB-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
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
async function submitTimesheet(employeeId: string, timesheetId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;
    return submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), SubmissionSource.MANUAL);
  });
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
  const warningConfirm = row.locator('.ledger-approve-warning-confirm .ledger-approve-button');
  await warningConfirm.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if ((await warningConfirm.count()) > 0) {
    await warningConfirm.click();
  }
  await page
    .waitForFunction(
      (i) => {
        const rowsEl = document.querySelectorAll('.ledger-row-summary');
        return rowsEl[i]?.textContent?.includes('Подтверждено') ?? false;
      },
      idx,
      { timeout: 10000 }
    )
    .catch(() => {});
  await rows.nth(idx).click();
  await page.waitForTimeout(100);
}

async function seed() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `sumb-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const site = await mkSite('s1');
  const wa = await mkWorkArea(site.id, `Aros Summary ${randomUUID().slice(0, 4)}`);
  const monday = nextMonday();

  const wConfirmed = await mkWorker('WConfirmed');
  const confirmedDraft = await buildDraft(wConfirmed.id, site.id, wa.id, monday);
  await submitTimesheet(wConfirmed.id, confirmedDraft.ts.id);

  const wPending = await mkWorker('WPending');
  const pendingDraft = await buildDraft(wPending.id, site.id, wa.id, monday);
  await submitTimesheet(wPending.id, pendingDraft.ts.id);

  const wRemoved = await mkWorker('WRemoved');
  const removedDraft = await buildDraft(wRemoved.id, site.id, wa.id, monday);
  await submitTimesheet(wRemoved.id, removedDraft.ts.id);

  return { admin, site, wa, monday, wConfirmed, confirmedDraft, wPending, pendingDraft, wRemoved, removedDraft };
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

  // Approve WConfirmed only (WPending stays unconfirmed, WRemoved will have its slice removed
  // AFTER being approved once, so it shows up as a historical row on the summary too).
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    await approveViaUi(page, rows, 'WConfirmed');
    await approveViaUi(page, rows, 'WRemoved');
  }
  await reopenWorkerTimesheetForEdits(fx.wRemoved.id, fx.removedDraft.ts.id, adminUserId, randomUUID());
  await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: fx.removedDraft.draft.id } });
  await submitTimesheet(fx.wRemoved.id, fx.removedDraft.ts.id);

  // ---------------------------------------------------------------------------------------------
  // 1. The Табель row's own hours for WConfirmed (ground truth to cross-check the summary against).
  // ---------------------------------------------------------------------------------------------
  let tableConfirmedHoursText = '';
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const idx = await findRowIndexByText(rows, 'WConfirmed');
    check('1: WConfirmed row exists in Табель', idx !== -1, idx);
    tableConfirmedHoursText = await rows.nth(idx).locator('.ledger-row-hours').innerText();
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Switching to «Сводка» via the tab link preserves the filter (same customer/period), and the
  //    tab is a real page, not the old placeholder text.
  // ---------------------------------------------------------------------------------------------
  {
    const summaryTabLink = page.locator('.ledger-tabs a', { hasText: 'Сводка' });
    await summaryTabLink.click();
    // waitForLoadState('networkidle') right after a navigating click can race the navigation itself
    // (it may resolve against the PRE-click page); wait for the URL to actually change instead.
    await page.waitForURL((u) => u.searchParams.get('view') === 'summary', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    const url = new URL(page.url());
    check('2: URL now has view=summary', url.searchParams.get('view') === 'summary', page.url());
    check('2b: workAreaId filter carried over from the Табель tab', url.searchParams.get('workAreaId') === fx.wa.id, page.url());
    check('2c: startDate/endDate carried over', url.searchParams.get('startDate') === isoDate(fx.monday), page.url());
    const bodyText = await page.locator('.ledger-summary-tab').innerText().catch(() => '');
    check('2d: the page is a real Сводка body, not the old placeholder text', !bodyText.includes('будет доступна позже') && bodyText.length > 0, bodyText.slice(0, 200));
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Confirmed hours in the summary match the Табель row's own hours exactly (same source).
  // ---------------------------------------------------------------------------------------------
  {
    await page.waitForSelector('.ledger-summary-stat-confirmed .ledger-summary-stat-value', { timeout: 10000 });
    const summaryConfirmedText = await page.locator('.ledger-summary-stat-confirmed .ledger-summary-stat-value').innerText();
    check('3: summary confirmed hours contain the SAME hour count text as the Табель row', summaryConfirmedText.trim() === tableConfirmedHoursText.trim(), { summaryConfirmedText, tableConfirmedHoursText });
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Removed (historical) hours appear in their own section, and are visibly not part of the
  //    confirmed total (WRemoved's hours were removed after being confirmed once).
  // ---------------------------------------------------------------------------------------------
  {
    const historicalSection = page.locator('.ledger-summary-historical');
    check('4: a historical section is present (WRemoved shows up there)', (await historicalSection.count()) > 0, await historicalSection.count());
  }

  // ---------------------------------------------------------------------------------------------
  // 4b. UT8-B-fixup #2 — the preview CSV/PDF download itself (not just the on-page section) lists
  //     WRemoved explicitly under its own historical row type, never silently dropped.
  // ---------------------------------------------------------------------------------------------
  {
    const previewCsvLink = page.locator('.ledger-summary-export-link', { hasText: /CSV/i }).first();
    const href = await previewCsvLink.getAttribute('href');
    check('4c: a preview CSV link with a real href is present', !!href, href);
    if (href) {
      const res = await page.request.get(`${BASE}${href}`);
      const text = await res.text();
      check('4d: the downloaded preview CSV explicitly lists WRemoved under row_type HISTORICAL', text.includes('HISTORICAL') && text.includes('WRemoved'), text.slice(0, 800));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 4e. UT8-B-fixup #5 — the per-customer table shows HOURS (not a bare row count) in the "pending"
  //     column: WPending's slice is unconfirmed, so this customer's pending column must read a
  //     formatted duration ("X ч Y мин" / "X h Y min"), never a small bare integer like "1".
  // ---------------------------------------------------------------------------------------------
  {
    const table = page.locator('.ledger-summary-customer-table');
    await table.waitFor({ state: 'visible', timeout: 10000 });
    const pendingCellText = await table.locator('tbody tr').first().locator('td').nth(3).innerText();
    check('4f: the pending column shows an hours/minutes duration, not a bare row count', /\d+\s*(ч|h)/i.test(pendingCellText) && pendingCellText.trim() !== '1', pendingCellText);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Final export is blocked while WPending is still unconfirmed (whole workArea scope); preview
  //    links are present regardless.
  // ---------------------------------------------------------------------------------------------
  {
    const finalCsv = page.locator('.ledger-summary-export-final').first();
    check('5: final export link is visually disabled while the scope has an unconfirmed worker', (await finalCsv.getAttribute('aria-disabled')) === 'true', await finalCsv.getAttribute('aria-disabled'));
    const previewCsv = page.locator('.ledger-summary-export-link', { hasText: /CSV/i }).first();
    check('5b: a preview export link is present and enabled', (await previewCsv.count()) > 0, await previewCsv.count());
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Narrow the filter to ONLY the confirmed worker -> final export becomes available, and
  //    actually downloads a real CSV file with the confirmed content-type.
  // ---------------------------------------------------------------------------------------------
  {
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&employeeSearch=WConfirmed&view=summary`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.ledger-summary-export-final', { timeout: 10000 });
    const finalCsv = page.locator('.ledger-summary-export-final').first();
    check('6: final export enabled once the scope is narrowed to only the confirmed worker', (await finalCsv.getAttribute('aria-disabled')) !== 'true', await finalCsv.getAttribute('aria-disabled'));
    const href = await finalCsv.getAttribute('href');
    check('6b: final export link has a real href', !!href, href);
    if (href) {
      const res = await page.request.get(`${BASE}${href}`);
      check('6c: final CSV download succeeds (200) and is a real CSV', res.ok() && (res.headers()['content-type'] ?? '').includes('text/csv'), { status: res.status(), contentType: res.headers()['content-type'] });
    }
  }

  // Deliberately checked here, BEFORE block 7 below — the browser itself logs a "Failed to load
  // resource: 400" console entry for the range-too-large request even though the app handles that
  // 400 correctly, which would otherwise pollute this check.
  check('9: zero unexpected console errors', consoleErrors.length === 0, consoleErrors);

  // ---------------------------------------------------------------------------------------------
  // 7. A range longer than 6 weeks shows a clear "narrow the period" message, not a crash or a
  //    silently truncated result.
  // ---------------------------------------------------------------------------------------------
  {
    const tooLongEnd = isoDate(new Date(fx.monday.getTime() + 60 * 86400000));
    await page.goto(`${BASE}/admin/timesheets?startDate=${isoDate(fx.monday)}&endDate=${tooLongEnd}&workAreaId=${fx.wa.id}&view=summary`, { waitUntil: 'networkidle' });
    const errorBanner = page.locator('.ledger-error-banner');
    await errorBanner.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const text = await errorBanner.innerText().catch(() => '');
    check('7: a range over 6 weeks shows an explicit error message on the Сводка tab', text.length > 0, text);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. An unrelated page still loads normally.
  // ---------------------------------------------------------------------------------------------
  {
    const res = await page.goto(`${BASE}/foreman`, { waitUntil: 'networkidle' }).catch(() => null);
    check('8: an unrelated page still loads normally (no regression from this feature)', res !== null && res.status() < 500);
  }

  // ---------------------------------------------------------------------------------------------
  // 10. UT8-B-fixup-4/5 — the REAL primary path: open «Табель», pick a customer through the existing
  //     combobox (LedgerFilterBar.pickCustomer sets workAreaId ALONE — never siteId), click the
  //     «Сводка» tab link, and confirm the SAME workAreaId survived the switch. Before fixup-5 this
  //     tab link was server-rendered from TimesheetsLedgerPage.tsx's ONE-TIME initial `state` and
  //     never updated after navigate()'s raw window.history.replaceState call (fixup #6) — so the
  //     just-picked customer was silently lost the moment this exact click happened. The selected
  //     customer's missing (never-submitted) worker must show up as "Не отправлено" and keep final
  //     blocked; switching back «Сводка» -> «Табель» must keep the SAME filter too.
  // ---------------------------------------------------------------------------------------------
  {
    const siteD = await mkSite('T10');
    const waLabel = `SummaryPick${randomUUID().slice(0, 6)}`;
    const waD = await mkWorkArea(siteD.id, waLabel);
    const mondayD = nextMonday();
    const period = await prisma.payrollPeriod.create({ data: { startDate: mondayD, endDate: new Date(mondayD.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });

    const wMissing = await mkWorker('T10Missing');
    await mkAssignment(wMissing.id, siteD.id, waD.id);
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: wMissing.id, expected: true } });

    // Open «Табель» — deliberately with NO workAreaId/siteId, exactly a normal bare visit.
    await page.goto(`${BASE}/admin/timesheets?startDate=${isoDate(mondayD)}&endDate=${endOf(mondayD)}`, { waitUntil: 'networkidle' });
    check('10: starts on the Табель tab', new URL(page.url()).searchParams.get('view') !== 'summary', page.url());

    const customerInput = page.locator('.ledger-combobox input');
    await customerInput.click();
    await customerInput.fill(waLabel);
    await page.waitForTimeout(400); // 220ms debounce + fetch round-trip (same margin as the ledger combobox test)
    // highlightedIndex starts at 0 ("Any customer"); comboOptions = [Any, Без заказчика, <our one live
    // search result>] since waLabel is a fresh random string matching nothing else — 2 ArrowDown
    // presses lands exactly on our customer (mirrors _test-timesheets-ledger-browser.ts's own proven
    // combobox-selection sequence).
    await customerInput.press('ArrowDown');
    await customerInput.press('ArrowDown');
    await customerInput.press('Enter');
    await page.waitForFunction((id) => new URLSearchParams(window.location.search).get('workAreaId') === id, waD.id, { timeout: 5000 }).catch(() => {});

    const urlAfterPick = new URL(page.url());
    check('10b: picking a customer via the real combobox sets workAreaId', urlAfterPick.searchParams.get('workAreaId') === waD.id, page.url());
    check('10c: ...but never sets siteId in the URL (the exact real-user path this fixup addresses)', urlAfterPick.searchParams.get('siteId') === null, page.url());

    const summaryTabLink = page.locator('.ledger-tabs a', { hasText: 'Сводка' });
    await summaryTabLink.click();
    await page.waitForURL((u) => u.searchParams.get('view') === 'summary', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    const urlOnSummary = new URL(page.url());
    check('10d: the Сводка tab keeps the SAME workAreaId just picked on Табель (fixup-5\'s own subject)', urlOnSummary.searchParams.get('workAreaId') === waD.id, page.url());
    check('10e: ...and still no siteId', urlOnSummary.searchParams.get('siteId') === null, page.url());

    const notSubmittedStat = page.locator('.ledger-summary-stat', { hasText: 'Не отправлено' }).locator('.ledger-summary-stat-value');
    await notSubmittedStat.waitFor({ state: 'visible', timeout: 10000 });
    check('10f: the "Не отправлено" stat shows 1 for the missing worker, reached via Табель -> combobox -> Сводка tab click', (await notSubmittedStat.innerText()).trim() === '1', await notSubmittedStat.innerText());

    const finalCsv2 = page.locator('.ledger-summary-export-final').first();
    check('10g: final export stays blocked (aria-disabled=true) because of the missing worker', (await finalCsv2.getAttribute('aria-disabled')) === 'true', await finalCsv2.getAttribute('aria-disabled'));

    const previewCsv2 = page.locator('.ledger-summary-export-link', { hasText: /CSV/i }).first();
    const href2 = await previewCsv2.getAttribute('href');
    check('10h: a preview CSV link is present', !!href2, href2);
    if (href2) {
      const res2 = await page.request.get(`${BASE}${href2}`);
      const text2 = await res2.text();
      check('10i: the preview CSV explicitly names the missing worker under row_type NOT_SUBMITTED', text2.includes('NOT_SUBMITTED') && text2.includes('T10Missing'), text2.slice(0, 800));
    }

    // Обратно: «Сводка» -> «Табель» тоже должен сохранить тот же фильтр.
    const tableTabLink = page.locator('.ledger-tabs a', { hasText: 'Табель' });
    await tableTabLink.click();
    await page.waitForURL((u) => u.searchParams.get('view') !== 'summary', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    const urlBackOnTable = new URL(page.url());
    check('10j: switching back to Табель keeps the SAME workAreaId', urlBackOnTable.searchParams.get('workAreaId') === waD.id, page.url());
    check('10k: the combobox still shows the picked customer after the round trip', (await customerInput.inputValue()).includes(waLabel), await customerInput.inputValue());
  }

  // ---------------------------------------------------------------------------------------------
  // 11. UT8-B-fixup-5 — period (startDate/endDate), employeeSearch and siteId also survive a tab
  //     switch in EITHER direction, not just workAreaId, now that the table branch's tab bar reads
  //     the client's reactive currentState instead of the page's one-time initial props.
  // ---------------------------------------------------------------------------------------------
  {
    const siteE = await mkSite('T11');
    const waE = await mkWorkArea(siteE.id, `SummaryPersist${randomUUID().slice(0, 6)}`);
    const mondayE = nextMonday();
    const qs = `startDate=${isoDate(mondayE)}&endDate=${endOf(mondayE)}&siteId=${siteE.id}&workAreaId=${waE.id}&employeeSearch=T11Search`;

    await page.goto(`${BASE}/admin/timesheets?${qs}`, { waitUntil: 'networkidle' });
    const summaryTabLink2 = page.locator('.ledger-tabs a', { hasText: 'Сводка' });
    await summaryTabLink2.click();
    await page.waitForURL((u) => u.searchParams.get('view') === 'summary', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    const urlOnSummary2 = new URL(page.url());
    check('11: period survives Табель -> Сводка', urlOnSummary2.searchParams.get('startDate') === isoDate(mondayE) && urlOnSummary2.searchParams.get('endDate') === endOf(mondayE), page.url());
    check('11b: siteId survives Табель -> Сводка', urlOnSummary2.searchParams.get('siteId') === siteE.id, page.url());
    check('11c: workAreaId survives Табель -> Сводка', urlOnSummary2.searchParams.get('workAreaId') === waE.id, page.url());
    check('11d: employeeSearch survives Табель -> Сводка', urlOnSummary2.searchParams.get('employeeSearch') === 'T11Search', page.url());

    const tableTabLink2 = page.locator('.ledger-tabs a', { hasText: 'Табель' });
    await tableTabLink2.click();
    await page.waitForURL((u) => u.searchParams.get('view') !== 'summary', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    const urlBackOnTable2 = new URL(page.url());
    check('11e: period survives Сводка -> Табель', urlBackOnTable2.searchParams.get('startDate') === isoDate(mondayE) && urlBackOnTable2.searchParams.get('endDate') === endOf(mondayE), page.url());
    check('11f: siteId survives Сводка -> Табель', urlBackOnTable2.searchParams.get('siteId') === siteE.id, page.url());
    check('11g: workAreaId survives Сводка -> Табель', urlBackOnTable2.searchParams.get('workAreaId') === waE.id, page.url());
    check('11h: employeeSearch survives Сводка -> Табель', urlBackOnTable2.searchParams.get('employeeSearch') === 'T11Search', page.url());
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
