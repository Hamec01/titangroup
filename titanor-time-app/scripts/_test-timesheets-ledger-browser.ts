// UT4-B (Titanor Time — единый табель) — real Chromium browser QA for the new /admin/timesheets
// page. Needs a standalone server (TEST_BASE_URL) started with TIMESHEETS_LEDGER_UI_ENABLED=1
// against a disposable PostgreSQL 16. TEST_BASE_URL_LEGACY (optional) points at a SECOND server
// started WITHOUT the flag — since the flag is a plain env var read at process start, one running
// server can only ever show one of the two pages; the legacy-page check is skipped (not failed)
// when that second URL isn't provided, exactly like the whole browser lane already skips when
// TEST_BASE_URL itself is absent.

import { randomUUID } from 'node:crypto';
import { chromium, type ConsoleMessage, type Page, type Request as PlaywrightRequest } from 'playwright';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { SubmissionSource } from '@prisma/client';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const LEGACY_BASE = process.env.TEST_BASE_URL_LEGACY || null;
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const PASSWORD = 'LedgerQaPassw0rd!23';

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
  const d = new Date(Date.UTC(2033, 0, 3) + weekSlot * 14 * 86400000); // 2033-01-03 is a Monday
  weekSlot += 1;
  return d;
}

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `BR-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, name: string) {
  return prisma.workArea.create({ data: { siteId, name } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `BR-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}

interface SegSpec {
  startHour: number;
  endHour: number;
  breaks?: { startHour: number; endHour: number; paid: boolean }[];
}

async function mkPeriod(monday: Date) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminUserId, lockedAt: new Date(), lockedByUserId: adminUserId } });
  return period;
}

async function buildAndSubmitOneDay(employeeId: string, siteId: string, workAreaId: string | null, monday: Date, segs: SegSpec[]) {
  const period = await mkPeriod(monday);
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  const asg = await mkAssignment(employeeId, siteId, workAreaId);

  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: monday, siteId, sourceAssignmentId: asg.id, plannedStartAt: at(monday, segs[0].startHour), plannedEndAt: at(monday, segs[segs.length - 1].endHour), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  for (const s of segs) {
    const seg = await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: monday, startAt: at(monday, s.startHour), endAt: at(monday, s.endHour), siteId, workAreaId, sourceAssignmentId: asg.id } });
    for (const b of s.breaks ?? []) {
      await prisma.timesheetDraftBreakSegment.create({ data: { draftSegmentId: seg.id, startAt: at(monday, b.startHour), endAt: at(monday, b.endHour), paid: b.paid } });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, ts.id, adminUserId, randomUUID(), SubmissionSource.MANUAL);
  });
  return { periodId: period.id, timesheetId: ts.id, monday };
}

async function seed() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `br-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const site1 = await mkSite('s1');
  const wa1 = await mkWorkArea(site1.id, `Aros Marine ${randomUUID().slice(0, 4)}`);
  const w1a = await mkWorker('W1a');
  const w1b = await mkWorker('W1b');
  const monday = nextMonday();

  // w1a: one day, an explicit PAID break plus the auto-unpaid deduction (gross >= 360 min threshold).
  const fx1a = await buildAndSubmitOneDay(w1a.id, site1.id, wa1.id, monday, [{ startHour: 7, endHour: 17, breaks: [{ startHour: 12, endHour: 12.25, paid: true }, { startHour: 15, endHour: 15.25, paid: false }] }]);
  // w1b: same customer/week, a SPLIT shift — two separate intervals in one day.
  const fx1b = await buildAndSubmitOneDay(w1b.id, site1.id, wa1.id, monday, [
    { startHour: 7, endHour: 11 },
    { startHour: 13, endHour: 17 }
  ]);

  // No-customer slice (workAreaId null).
  const w3 = await mkWorker('W3');
  const fx3 = await buildAndSubmitOneDay(w3.id, site1.id, null, monday, [{ startHour: 8, endHour: 16 }]);

  // SOURCE_ERROR — a non-draft Timesheet with no currentVersionId/draft at all.
  const w4 = await mkWorker('W4');
  const period4 = await mkPeriod(monday);
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period4.id, employeeId: w4.id, expected: true } });
  const ts4 = await prisma.timesheet.create({ data: { employeeId: w4.id, periodId: period4.id, status: 'SUBMITTED', currentVersionId: null } });

  // NOT_SUBMITTED — a participant with no Timesheet at all.
  const w5 = await mkWorker('W5');
  const period5 = await mkPeriod(monday);
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period5.id, employeeId: w5.id, expected: true } });

  // Same customer NAME on two different sites — must never be merged.
  const sharedName = `SharedCo ${randomUUID().slice(0, 5)}`;
  const siteA = await mkSite('sa');
  const siteB = await mkSite('sb');
  const waA = await mkWorkArea(siteA.id, sharedName);
  const waB = await mkWorkArea(siteB.id, sharedName);
  const w6a = await mkWorker('W6a');
  const w6b = await mkWorker('W6b');
  const fx6a = await buildAndSubmitOneDay(w6a.id, siteA.id, waA.id, monday, [{ startHour: 8, endHour: 16 }]);
  const fx6b = await buildAndSubmitOneDay(w6b.id, siteB.id, waB.id, monday, [{ startHour: 8, endHour: 16 }]);

  return { admin, monday, site1, wa1, w1a, w1b, fx1a, fx1b, w3, fx3, w4, ts4, w5, sharedName, siteA, siteB, waA, waB, w6a, w6b, fx6a, fx6b };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function endOf(d: Date): string {
  return isoDate(new Date(d.getTime() + 6 * 86400000));
}
/** dd.mm.yyyy — matches LedgerTopBar.tsx's own formatRangeDisplay() for the RU locale. */
function ddmm(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

async function main() {
  const fx = await seed();
  const cookie = await login(BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
  const rangeQs = `startDate=${isoDate(fx.monday)}&endDate=${endOf(fx.monday)}`;

  const browser = await chromium.launch({ headless: true });

  // =============================================================================================
  // DESKTOP — flag ON, the new page.
  // =============================================================================================
  {
    const context = await browser.newContext({ viewport: DESKTOP });
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const requests: { method: string; url: string }[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('request', (r: PlaywrightRequest) => {
      // UT4-B-fixup #6 needs BOTH /api/ calls and any request back to the page's own path (which
      // would indicate an unwanted Next.js RSC server re-render triggered by a URL change) — every
      // existing check below already filters this array down to '/api/...' itself, so broadening
      // capture here does not change any of their results.
      const u = r.url();
      if (u.includes('/api/') || u.includes('/admin/timesheets')) requests.push({ method: r.method(), url: u });
    });

    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    check('new page: .ledger-view renders (flag ON, new UI active)', (await page.locator('.ledger-view').count()) > 0);

    // --- point: SSR initial data without a duplicate first fetch ---
    const requestsAtLoad = requests.filter((r) => r.url.includes('/api/admin/time-ledger') && !r.url.includes('filter-options')).length;
    check(
      'SSR: no duplicate first client fetch to /api/admin/time-ledger on initial load',
      requestsAtLoad === 0,
      requests.map((r) => r.url)
    );

    // --- global summary vs page subtotal (workAreaId filter -> exactly w1a+w1b, 2 workers) ---
    const summaryText = await page.locator('.ledger-summary-strip').innerText();
    check('summary: shows 2 workers for this customer (global, exact)', /2\s*работ/i.test(summaryText), summaryText);
    const groupSubtotalText = await page.locator('.ledger-group-subtotal').first().innerText();
    check('group: subtotal is explicitly labelled "на этой странице"', /на этой странице/i.test(groupSubtotalText), groupSubtotalText);
    check('group: page subtotal also shows 2 (both rows fit on one default page)', /2\s*работ/i.test(groupSubtotalText), groupSubtotalText);

    // --- UT4-B-fixup #6: one filter change -> exactly ONE ledger computation. router.replace()
    // would make Next.js re-render the Server Component (a second, wasted getTimeLedger() call)
    // alongside this component's own client fetch; navigate() now uses raw History API instead, so
    // only the client fetch below should ever run. ---
    const requestsBeforeFilterChange = requests.length;
    await page.locator('.ledger-filter-field select').nth(1).selectOption('ready'); // 2nd select = status
    await page.waitForLoadState('networkidle');
    const newRequestsAfterFilterChange = requests.slice(requestsBeforeFilterChange);
    // UT7-B-fixup #2 — a filter change now fires TWO parallel requests by design: the main ledger and
    // the SEPARATE, bounded historical-approvals list (see customer-hours-history.ts's header comment
    // for why it is deliberately its own call, never folded into the main ledger response). Each is
    // checked for its own "exactly one, not zero, not duplicated" invariant independently.
    const ledgerApiCallsAfterFilterChange = newRequestsAfterFilterChange.filter((r) => r.url.includes('/api/admin/time-ledger') && !r.url.includes('filter-options') && !r.url.includes('historical-approvals'));
    check(
      'filter change: exactly one /api/admin/time-ledger request fires (not zero, not duplicated)',
      ledgerApiCallsAfterFilterChange.length === 1,
      newRequestsAfterFilterChange.map((r) => r.url)
    );
    const historicalApiCallsAfterFilterChange = newRequestsAfterFilterChange.filter((r) => r.url.includes('/api/admin/time-ledger/historical-approvals'));
    check(
      'filter change: exactly one /api/admin/time-ledger/historical-approvals request fires alongside it',
      historicalApiCallsAfterFilterChange.length === 1,
      newRequestsAfterFilterChange.map((r) => r.url)
    );
    const pageRerenderRequestsAfterFilterChange = newRequestsAfterFilterChange.filter((r) => r.url.includes('/admin/timesheets') && !r.url.includes('/api/'));
    check(
      'filter change: no duplicate page/RSC request runs alongside the client fetch',
      pageRerenderRequestsAfterFilterChange.length === 0,
      newRequestsAfterFilterChange.map((r) => r.url)
    );
    const urlAfterFilterChange = new URL(page.url());
    check('filter change: URL still reflects the new filter (History API kept the address bar in sync)', urlAfterFilterChange.searchParams.get('status') === 'ready', page.url());

    // --- force pagination with pageSize=1 and re-check summary != page subtotal ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}&pageSize=1`, { waitUntil: 'networkidle' });
    const summaryText2 = await page.locator('.ledger-summary-strip').innerText();
    check('pagination: global summary STILL shows 2 workers even with pageSize=1', /2\s*работ/i.test(summaryText2), summaryText2);
    const groupSubtotalText2 = await page.locator('.ledger-group-subtotal').first().innerText();
    check(
      'pagination: page subtotal shows only 1 (bounded by pageSize=1) -- proves it is NOT the same number as global summary',
      /1\s*работ/i.test(groupSubtotalText2),
      groupSubtotalText2
    );
    check('pagination: pagination nav is visible', (await page.locator('.ledger-pagination').count()) > 0);

    // --- page 2 preserves filters, and customer/site options don't disappear ---
    await page.locator('.ledger-pagination button', { hasText: /Далее|Next/i }).click();
    await page.waitForFunction(() => new URLSearchParams(window.location.search).get('page') === '2', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
    const url2 = new URL(page.url());
    check('page 2: URL still carries workAreaId filter', url2.searchParams.get('workAreaId') === fx.wa1.id, page.url());
    check('page 2: URL page=2', url2.searchParams.get('page') === '2', page.url());
    const firstSelectId = await page.locator('.ledger-filter-field select').first().getAttribute('id');
    const siteSelectOptionsCount = await page.locator(`#${firstSelectId}`).locator('option').count();
    check('page 2: site filter dropdown still has its full option list (not derived from page rows)', siteSelectOptionsCount > 1, siteSelectOptionsCount);

    // --- reload preserves filters (URL is the source of truth) ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}&status=ready`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const urlAfterReload = new URL(page.url());
    check(
      'reload: filters survive a full page reload',
      urlAfterReload.searchParams.get('workAreaId') === fx.wa1.id && urlAfterReload.searchParams.get('status') === 'ready',
      page.url()
    );

    // --- Back/Forward restores the screen ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.goBack({ waitUntil: 'networkidle' });
    const urlAfterBack = new URL(page.url());
    check(
      'Back: restores the ledger screen with its filter',
      urlAfterBack.pathname === '/admin/timesheets' && urlAfterBack.searchParams.get('workAreaId') === fx.wa1.id,
      page.url()
    );

    // --- expansion does not change URL or page ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    const urlBeforeExpand = page.url();
    await page.locator('.ledger-row-summary').first().click();
    await page.waitForTimeout(150);
    check('expansion: URL unchanged after opening a row', page.url() === urlBeforeExpand, { before: urlBeforeExpand, after: page.url() });
    check('expansion: Mon-Sun table is visible (all 7 days)', (await page.locator('.ledger-days-table tbody tr').count()) >= 7);
    const daysText = await page.locator('.ledger-days-table').innerText();
    check('expansion: shows an EMPTY day (— for a day with no segments)', /—/.test(daysText), daysText.slice(0, 200));

    // --- paid/unpaid/auto-break + split shift (w1b's two intervals) ---
    // collapse w1a, expand w1b's row instead
    await page.locator('.ledger-row-summary').first().click();
    const rows = page.locator('.ledger-row-summary');
    const w1bIndex = await findRowIndexByText(rows, 'W1b');
    await rows.nth(w1bIndex).click();
    await page.waitForTimeout(150);
    const w1bDaysText = await page.locator('.ledger-row').nth(w1bIndex).locator('.ledger-days-table').innerText();
    // Segment hours are stored as UTC and DISPLAYED as Europe/Helsinki wall-clock (utcIsoToHelsinkiTime)
    // -- winter EET is UTC+2, so the fixture's 07-11/13-17 UTC segments render as 09-13/15-19.
    check(
      'split shift: w1b shows TWO segment rows for the same day (09-13 and 15-19 Helsinki)',
      w1bDaysText.includes('09:00') && w1bDaysText.includes('13:00') && w1bDaysText.includes('15:00') && w1bDaysText.includes('19:00'),
      w1bDaysText
    );

    // re-open w1a for paid/unpaid check
    await rows.nth(w1bIndex).click();
    const w1aIndex = await findRowIndexByText(rows, 'W1a');
    await rows.nth(w1aIndex).click();
    await page.waitForTimeout(150);
    const w1aDaysText = await page.locator('.ledger-row').nth(w1aIndex).locator('.ledger-days-table').innerText();
    check("paid/unpaid: shows both a paid and an unpaid break marker for w1a's day", /опл\.|paid/i.test(w1aDaysText) && /неопл\.|unpaid/i.test(w1aDaysText), w1aDaysText);

    // --- diagnostics collapsed by default, no technical terms in the main visible text ---
    const mainVisibleText = await page.locator('.ledger-view').innerText();
    check(
      'no technical terms visible before opening Диагностика',
      !/fingerprint|canonical|SUPERSEDED/i.test(mainVisibleText.replace(/Диагностика[\s\S]*/, '')),
      'leaked technical term'
    );
    await page.locator('.ledger-diagnostics summary').first().click();
    const diagText = await page.locator('.ledger-diagnostics').first().innerText();
    check('Диагностика reveals the fingerprint once opened', diagText.length > 20, diagText);

    // --- null customer -> "Без заказчика" ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=none`, { waitUntil: 'networkidle' });
    const noCustomerText = await page.locator('.ledger-group-title').first().innerText();
    check('workAreaId=none renders "Без заказчика"', noCustomerText.includes('Без заказчика'), noCustomerText);

    // --- same customer NAME, different sites -> two distinct groups ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&employeeSearch=W6`, { waitUntil: 'networkidle' });
    const groupTitles = await page.locator('.ledger-group-title').allInnerTexts();
    const sharedNameGroups = groupTitles.filter((t) => t.includes(fx.sharedName));
    check('same customer name on 2 sites -> 2 distinct groups (never merged)', sharedNameGroups.length === 2, groupTitles);

    // --- UT4-B-fixup #4: customer combobox — real ARIA semantics + keyboard selection (ArrowDown, Enter) ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}`, { waitUntil: 'networkidle' });
    const customerInput = page.locator('.ledger-combobox input');
    await customerInput.click();
    await customerInput.fill('Aros Marine');
    await page.waitForTimeout(400); // 220ms debounce + fetch round-trip
    check('combobox: role=combobox while closed-vs-open is tracked via aria-expanded', (await customerInput.getAttribute('role')) === 'combobox');
    check('combobox: aria-expanded=true while the list is open', (await customerInput.getAttribute('aria-expanded')) === 'true');
    const listboxId = await customerInput.getAttribute('aria-controls');
    check('combobox: aria-controls points to a real role=listbox element', !!listboxId && (await page.locator(`#${listboxId}[role="listbox"]`).count()) > 0, listboxId);
    // highlightedIndex starts at 0 ("Any customer", the default highlight); each ArrowDown ADVANCES
    // one step, so with exactly one live search result (comboOptions = [Any, Без заказчика, Aros
    // Marine], length 3), 2 presses lands on index 2 (Aros Marine) -- a 3rd would wrap back to 0.
    await customerInput.press('ArrowDown'); // advance to "Без заказчика" (index 1)
    await customerInput.press('ArrowDown'); // advance to the live search result (index 2, fx.wa1 = Aros Marine)
    const activeDescendant = await customerInput.getAttribute('aria-activedescendant');
    check('combobox: aria-activedescendant is set and matches an option in the listbox', !!activeDescendant && (await page.locator(`#${activeDescendant}[role="option"]`).count()) > 0, activeDescendant);
    await customerInput.press('Enter');
    await page.waitForFunction((wa1Id) => new URLSearchParams(window.location.search).get('workAreaId') === wa1Id, fx.wa1.id, { timeout: 5000 }).catch(() => {});
    const urlAfterComboboxSelect = new URL(page.url());
    check('combobox: Enter selects the highlighted option -> workAreaId lands in the URL', urlAfterComboboxSelect.searchParams.get('workAreaId') === fx.wa1.id, page.url());
    check('combobox: selected customer stays visibly displayed in the input', (await customerInput.inputValue()).includes('Aros Marine'), await customerInput.inputValue());

    // --- UT4-B-fixup #4: Back/Forward never leaves a stale-looking selected customer. Two real
    // navigations to different workAreaId values, then Back -- Next.js's soft App Router navigation
    // reconciles the SAME LedgerFilterBar instance with new props rather than remounting it, which
    // is exactly the scenario that used to leave selectedCustomer's local state stuck on the
    // PREVIOUS page's value. ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    check('staleness: customer input shows Aros Marine on direct load', (await customerInput.inputValue()).includes('Aros Marine'), await customerInput.inputValue());
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=none`, { waitUntil: 'networkidle' });
    check('staleness: customer input shows "Без заказчика" on the second page', (await customerInput.inputValue()).includes('Без заказчика'), await customerInput.inputValue());
    await page.goBack({ waitUntil: 'networkidle' });
    const urlAfterBackForCombobox = new URL(page.url());
    check('staleness: URL after Back is the Aros Marine page again', urlAfterBackForCombobox.searchParams.get('workAreaId') === fx.wa1.id, page.url());
    await page.waitForFunction(() => (document.querySelector('.ledger-combobox input') as HTMLInputElement | null)?.value.includes('Aros Marine') ?? false, { timeout: 5000 }).catch(() => {});
    check('staleness: after Back, the customer input shows Aros Marine again, NOT the stale "Без заказчика" from the previous page', (await customerInput.inputValue()).includes('Aros Marine'), await customerInput.inputValue());

    // --- NOT_SUBMITTED section ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&employeeSearch=W5`, { waitUntil: 'networkidle' });
    check('NOT_SUBMITTED section visible for a participant with no timesheet', (await page.locator('.ledger-section-details', { hasText: /Ещё не сдали/i }).count()) > 0);

    // --- SOURCE_ERROR section, never hidden, never shown as 0h ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&employeeSearch=W4`, { waitUntil: 'networkidle' });
    const sourceErrorSection = page.locator('.ledger-section-details-danger');
    check('SOURCE_ERROR section is visible', (await sourceErrorSection.count()) > 0);
    const sourceErrorText = await sourceErrorSection.innerText();
    check('SOURCE_ERROR section never says "0h"/"0 ч"', !/\b0\s*(h|ч)\b/i.test(sourceErrorText), sourceErrorText);

    // --- all-time mode ---
    await page.goto(`${BASE}/admin/timesheets?allTime=true&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    check('all-time: page renders without error', (await page.locator('.ledger-view').count()) > 0);
    check('all-time: arrows/weeks buttons disabled (nothing to page through)', await page.locator('.ledger-arrow-button').first().isDisabled());
    const allTimeSummary = await page.locator('.ledger-summary-strip').innerText();
    check('all-time: still finds the same 2 workers via the exact global summary', /2\s*работ/i.test(allTimeSummary), allTimeSummary);

    // --- UT4-B-fixup #1: a mid-week partial date range normalizes to the full Helsinki week it
    // touches, rather than being rejected. Real assertions, not just a <body> presence check: the
    // ledger view renders, no error banner, the displayed range shows the full Mon-Sun week, and
    // the SAME real fixture data appears as the equivalent full-week request. ---
    const wednesday = isoDate(new Date(fx.monday.getTime() + 2 * 86400000));
    await page.goto(`${BASE}/admin/timesheets?startDate=${wednesday}&endDate=${wednesday}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    check('partial range: .ledger-view renders (not rejected)', (await page.locator('.ledger-view').count()) > 0);
    check('partial range: no error banner shown', (await page.locator('.ledger-error-banner').count()) === 0);
    const partialRangeDisplay = await page.locator('.ledger-range-display').innerText();
    check(
      'partial range: displayed range is the normalized full Mon-Sun week, not the raw single day',
      partialRangeDisplay.includes(ddmm(isoDate(fx.monday))) && partialRangeDisplay.includes(ddmm(endOf(fx.monday))),
      { displayed: partialRangeDisplay, expectedMonday: ddmm(isoDate(fx.monday)), expectedSunday: ddmm(endOf(fx.monday)) }
    );
    const partialRangeSummary = await page.locator('.ledger-summary-strip').innerText();
    check('partial range: summary is present and finds the same 2 real workers as the full-week request', /2\s*работ/i.test(partialRangeSummary), partialRangeSummary);
    check('partial range: at least one real row rendered', (await page.locator('.ledger-row').count()) > 0);

    // Snapshot console-error count BEFORE the intentional 409 mock below -- a mocked 409 response
    // legitimately logs a "Failed to load resource: 409" browser console message, which must not
    // count against the real "zero console errors" assertion made at the end of this block.
    const consoleErrorsBeforeMock = consoleErrors.length;

    // --- 409 retry, via a mocked response on the NEXT fetch only ---
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    let mocked = false;
    await page.route('**/api/admin/time-ledger?*', async (route) => {
      if (!mocked) {
        mocked = true;
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TIME_LEDGER_READ_CHANGED_DURING_QUERY', message: 'stale', requestId: randomUUID() } }) });
      } else {
        await route.continue();
      }
    });
    await page.locator('.ledger-pill-button', { hasText: '2 нед' }).click();
    const retryBanner = page.locator('.ledger-error-banner-retry');
    let bannerAppeared = true;
    await retryBanner.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      bannerAppeared = false;
    });
    check('409: a retry banner appears', bannerAppeared && (await retryBanner.count()) > 0);
    check('409: OLD data stays visible underneath the banner (not wiped)', (await page.locator('.ledger-row').count()) > 0);
    await page.locator('.ledger-error-banner-retry button').click();
    await retryBanner.first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    check('409: after Reload, the banner clears', (await page.locator('.ledger-error-banner-retry').count()) === 0);
    await page.unroute('**/api/admin/time-ledger?*');

    // --- only GET requests anywhere on this page (UT4 has no mutation) ---
    const nonGet = requests.filter((r) => r.method !== 'GET');
    check('no POST/PATCH/DELETE requests anywhere during this session', nonGet.length === 0, nonGet);

    const bodyWidthDesktop = await page.evaluate(() => document.documentElement.scrollWidth);
    check('desktop: no horizontal page overflow', bodyWidthDesktop <= DESKTOP.width + 1, bodyWidthDesktop);
    check('desktop: zero console errors (excluding the intentionally-mocked 409)', consoleErrorsBeforeMock === 0, consoleErrors.slice(0, consoleErrorsBeforeMock));
    check('desktop: zero uncaught page errors', pageErrors.length === 0, pageErrors);

    await context.close();
  }

  // =============================================================================================
  // MOBILE (390x844) — filter drawer, cards, keyboard/focus, no overflow.
  // =============================================================================================
  {
    const context = await browser.newContext({ viewport: MOBILE });
    await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });

    // hours/status visible without expanding
    const rowText = await page.locator('.ledger-row-summary').first().innerText();
    check('mobile: hours and status visible on the closed row card', /\d/.test(rowText) && rowText.length > 10, rowText);

    // filter drawer: open, focus, Escape, focus return
    const toggle = page.locator('.ledger-filters-toggle');
    await toggle.click();
    await page.waitForTimeout(150);
    check('mobile: filter drawer opens as a dialog', (await page.locator('.ledger-filter-panel.is-open[role="dialog"]').count()) > 0);
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    check('mobile: focus moves into the drawer on open', focusedTag === 'INPUT' || focusedTag === 'SELECT' || focusedTag === 'BUTTON', focusedTag);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('mobile: Escape closes the drawer', (await page.locator('.ledger-filter-panel.is-open').count()) === 0);
    const focusedAfterClose = await page.evaluate(() => document.activeElement?.className);
    check('mobile: focus returns to the Filters toggle button after Escape', (focusedAfterClose ?? '').includes('ledger-filters-toggle'), focusedAfterClose);

    // --- UT4-B-fixup #2: real keyboard focus trap (aria-modal="true" promises Tab never escapes
    // the drawer into the page behind it) -- Tab from the LAST focusable wraps to the FIRST,
    // Shift+Tab from the FIRST wraps to the LAST, the backdrop is never keyboard-focusable ---
    await toggle.click();
    await page.waitForTimeout(150);
    check('focus trap: drawer re-opens', (await page.locator('.ledger-filter-panel.is-open[role="dialog"]').count()) > 0);
    const backdropTabIndex = await page.locator('.ledger-filter-backdrop').getAttribute('tabindex');
    check('focus trap: backdrop is never keyboard-focusable (no tabindex attribute)', backdropTabIndex === null, backdropTabIndex);

    const lastFocusableHandle = await page.evaluateHandle(() => {
      const panel = document.querySelector('.ledger-filter-panel.is-open');
      const focusable = panel
        ? Array.from(panel.querySelectorAll('input, select, button, a[href], [tabindex]:not([tabindex="-1"])')).filter(
            (el) => !(el as HTMLElement).hasAttribute('disabled') && (el as HTMLElement).offsetParent !== null
          )
        : [];
      return focusable[focusable.length - 1] ?? null;
    });
    const lastFocusableEl = lastFocusableHandle.asElement();
    await lastFocusableEl?.focus();
    const lastClassBefore = await page.evaluate(() => document.activeElement?.className);
    await page.keyboard.press('Tab');
    const focusedAfterTabFromLast = await page.evaluate(() => document.activeElement?.className);
    check(
      'focus trap: Tab from the LAST focusable element wraps to the FIRST (close button), never escaping into the page behind',
      (focusedAfterTabFromLast ?? '').includes('ledger-drawer-close'),
      { before: lastClassBefore, after: focusedAfterTabFromLast }
    );

    await page.keyboard.press('Shift+Tab');
    const focusedAfterShiftTabFromFirst = await page.evaluate(() => document.activeElement?.className);
    check(
      'focus trap: Shift+Tab from the FIRST focusable element wraps to the LAST, never escaping into the page behind',
      (focusedAfterShiftTabFromFirst ?? '').includes('ledger-link-button'),
      focusedAfterShiftTabFromFirst
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check('focus trap: Escape still closes the drawer after Tab-trap interaction', (await page.locator('.ledger-filter-panel.is-open').count()) === 0);
    const focusedAfterCloseAgain = await page.evaluate(() => document.activeElement?.className);
    check('focus trap: focus still returns to the Filters toggle button after Escape', (focusedAfterCloseAgain ?? '').includes('ledger-filters-toggle'), focusedAfterCloseAgain);

    // touch target sizes >= 44px
    const toggleBox = await toggle.boundingBox();
    check('mobile: Filters button >= 44px tall', (toggleBox?.height ?? 0) >= 44, toggleBox);
    const rowToggleBox = await page.locator('.ledger-row-summary').first().boundingBox();
    check('mobile: row toggle >= 44px tall', (rowToggleBox?.height ?? 0) >= 44, rowToggleBox);

    const bodyWidthMobile = await page.evaluate(() => document.documentElement.scrollWidth);
    check('mobile: no horizontal page overflow', bodyWidthMobile <= MOBILE.width + 1, bodyWidthMobile);
    check('mobile: zero console errors', consoleErrors.length === 0, consoleErrors);

    await context.close();
  }

  // =============================================================================================
  // RU/EN.
  // =============================================================================================
  {
    await prisma.user.update({ where: { id: adminUserId }, data: { locale: 'EN' } });
    const context = await browser.newContext({ viewport: DESKTOP });
    const enCookie = await login(BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
    await context.addCookies([{ name: 'tt_session', value: enCookie, url: BASE }]);
    const page = await context.newPage();
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    const enText = await page.locator('.ledger-view').innerText();
    // '.ledger-filters-toggle' ("Filters") is CSS-hidden on desktop by design (mobile-only trigger)
    // -- check desktop-always-visible copy instead: the top-bar button and a filter field label.
    check('EN: key labels are English ("Current week"/"CUSTOMER"/"Ready")', enText.includes('Current week') && enText.includes('CUSTOMER') && /Ready|Not submitted/.test(enText), enText.slice(0, 300));

    await prisma.user.update({ where: { id: adminUserId }, data: { locale: 'RU' } });
    const ruCookie = await login(BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
    const ctxRu = await browser.newContext({ viewport: DESKTOP });
    await ctxRu.addCookies([{ name: 'tt_session', value: ruCookie, url: BASE }]);
    const pageRu = await ctxRu.newPage();
    await pageRu.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa1.id}`, { waitUntil: 'networkidle' });
    const ruText = await pageRu.locator('.ledger-view').innerText();
    check('RU: key labels are Russian ("Текущая неделя"/"ЗАКАЗЧИК"-style copy)', ruText.includes('Текущая неделя') && ruText.includes('ЗАКАЗЧИК'), ruText.slice(0, 300));

    await context.close();
    await ctxRu.close();
  }

  await browser.close();

  // =============================================================================================
  // Flag OFF -> legacy page (optional second server).
  // =============================================================================================
  if (LEGACY_BASE) {
    const legacyCookie = await login(LEGACY_BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
    const browser2 = await chromium.launch({ headless: true });
    const context = await browser2.newContext({ viewport: DESKTOP });
    await context.addCookies([{ name: 'tt_session', value: legacyCookie, url: LEGACY_BASE }]);
    const page = await context.newPage();
    await page.goto(`${LEGACY_BASE}/admin/timesheets`, { waitUntil: 'networkidle' });
    check('flag OFF: legacy page renders (no .ledger-view)', (await page.locator('.ledger-view').count()) === 0);
    // The shared browser-test DB has no FOREMAN_APPROVED-status timesheet (the default legacy
    // view), so the table itself may legitimately be empty ("Пусто.") -- check the legacy page's
    // own card wrapper instead, which renders in both the empty and non-empty case.
    check('flag OFF: legacy page card wrapper present', (await page.locator('.setup-card.worker-card').count()) > 0);
    const legacyBodyText = await page.locator('.setup-card.worker-card').innerText();
    check('flag OFF: legacy page shows the OLD status-tab labels (never new ledger copy)', /Готов|Ready for final approval|Пусто|total/i.test(legacyBodyText), legacyBodyText.slice(0, 200));
    await browser2.close();
  } else {
    console.log('  SKIPPED flag-off legacy-page check — TEST_BASE_URL_LEGACY not set (needs a second standalone server started WITHOUT TIMESHEETS_LEDGER_UI_ENABLED).');
  }

  console.log(JSON.stringify({ pass, fail }));
}

async function findRowIndexByText(rows: ReturnType<Page['locator']>, text: string): Promise<number> {
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const t = await rows.nth(i).innerText();
    if (t.includes(text)) return i;
  }
  throw new Error(`row containing "${text}" not found`);
}

main()
  .then(() => {
    if (fail > 0) process.exit(1);
  })
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
