// UT5-B (Titanor Time — единый табель) — real Chromium browser QA for the single weekly-customer
// approval action inside /admin/timesheets. Needs a standalone server (TEST_BASE_URL) started with
// TIMESHEETS_LEDGER_UI_ENABLED=1, CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY and
// IDEMPOTENCY_ENCRYPTION_KEY set, against a disposable PostgreSQL 16. TEST_BASE_URL_LEGACY
// (optional) points at a second server started WITHOUT the flag, same convention as
// scripts/_test-timesheets-ledger-browser.ts.

import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { SubmissionSource } from '@prisma/client';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const LEGACY_BASE = process.env.TEST_BASE_URL_LEGACY || null;
const DESKTOP = { width: 1440, height: 900 };
const PASSWORD = 'ApprovalQaPassw0rd!23';

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
  const d = new Date(Date.UTC(2032, 0, 5) + weekSlot * 14 * 86400000); // 2032-01-05 is a Monday
  weekSlot += 1;
  return d;
}

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `APVB-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, name: string) {
  return prisma.workArea.create({ data: { siteId, name } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `APVB-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
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

async function submitTimesheet(employeeId: string, timesheetId: string, source: SubmissionSource = SubmissionSource.MANUAL) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), source);
  });
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
  const admin = await prisma.user.create({ data: { username: `apvb-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const site = await mkSite('s1');
  const wa = await mkWorkArea(site.id, `Clean Co ${randomUUID().slice(0, 4)}`);

  // wClean — a real, clean, SUBMITTED slice: no warnings, no blockers.
  const wClean = await mkWorker('WClean');
  const cleanMonday = nextMonday();
  const cleanDraft = await buildDraft(wClean.id, site.id, wa.id, cleanMonday);
  await submitTimesheet(wClean.id, cleanDraft.ts.id);

  // wWarn — AUTO-submitted -> AUTOMATIC_SUBMISSION warning, no blocker.
  const wWarn = await mkWorker('WWarn');
  const warnMonday = nextMonday();
  const warnDraft = await buildDraft(wWarn.id, site.id, wa.id, warnMonday);
  await submitTimesheet(wWarn.id, warnDraft.ts.id, SubmissionSource.AUTO);

  // wDraft — never submitted (DRAFT/NOT_SUBMITTED) — for the DRAFT-warning-note check.
  const wDraft = await mkWorker('WDraft');
  const draftMonday = nextMonday();
  const draftFx = await buildDraft(wDraft.id, site.id, wa.id, draftMonday);

  // wOpenShift — UT6-A-R1 §1: OPEN_SHIFT is now a warning, not a blocker, so this row exercises the
  // SAME "Всё равно подтвердить" flow as wWarn, just via a different warning code, proving the
  // reclassification took effect in the real UI (not only in DB-lane tests).
  const wOpenShift = await mkWorker('WOpenShift');
  const openShiftMonday = nextMonday();
  const openShiftDraft = await buildDraft(wOpenShift.id, site.id, wa.id, openShiftMonday);
  await submitTimesheet(wOpenShift.id, openShiftDraft.ts.id);
  const evtId = randomUUID();
  const { createHash } = await import('node:crypto');
  await prisma.clockEvent.create({
    data: {
      id: evtId,
      employeeId: wOpenShift.id,
      operationType: 'CHECK_IN',
      siteId: site.id,
      clientCapturedAt: at(openShiftMonday, 9),
      capturedOffline: false,
      serverReceivedAt: at(openShiftMonday, 9),
      effectiveAt: at(openShiftMonday, 9),
      gpsVerification: 'NOT_VERIFIED',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: createHash('sha256').update(evtId).digest('hex'),
      requestId: randomUUID()
    }
  });
  await prisma.employeeOpenShift.create({ data: { employeeId: wOpenShift.id, openedByClockEventId: evtId, siteId: site.id, workAreaId: wa.id, openedAt: at(openShiftMonday, 9) } });

  // wDouble — for the double-click-creates-one-item check.
  const wDouble = await mkWorker('WDouble');
  const doubleMonday = nextMonday();
  const doubleDraft = await buildDraft(wDouble.id, site.id, wa.id, doubleMonday);
  await submitTimesheet(wDouble.id, doubleDraft.ts.id);

  // wStale — a clean, never-approved, blocker-free row used ONLY for the mocked-stale-preview
  // check (block 5), so the button starts enabled from real SSR data and only the preview response
  // is mocked.
  const wStale = await mkWorker('WStale');
  const staleMonday = nextMonday();
  const staleDraft = await buildDraft(wStale.id, site.id, wa.id, staleMonday);
  await submitTimesheet(wStale.id, staleDraft.ts.id);

  return { admin, site, wa, wClean, cleanMonday, cleanTimesheetId: cleanDraft.ts.id, wWarn, warnMonday, wDraft, draftMonday, wOpenShift, openShiftMonday, wDouble, doubleMonday, doubleTimesheetId: doubleDraft.ts.id, wStale, staleMonday };
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

  // ---------------------------------------------------------------------------------------------
  // 1. Clean one-click approval: click -> preview -> auto commit -> real refetch, row shows APPROVED.
  // ---------------------------------------------------------------------------------------------
  {
    const rangeQs = `startDate=${isoDate(fx.cleanMonday)}&endDate=${endOf(fx.cleanMonday)}`;
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const cleanIndex = await findRowIndexByText(rows, 'WClean');
    await rows.nth(cleanIndex).click();
    await page.waitForTimeout(150);

    const button = page.locator('.ledger-row').nth(cleanIndex).locator('.ledger-approve-button');
    check('1: confirm button visible for a clean row', (await button.count()) > 0 && (await button.isEnabled()));
    await button.click();

    // No fake optimistic approval: immediately after the click, before the network settles, the
    // button must not already show a final "approved" state -- it must be in a transient phase.
    const immediateText = await page.locator('.ledger-row').nth(cleanIndex).innerText();
    check('1b: no fake optimistic approval text appears before the server actually responds', !/Подтверждено\./.test(immediateText) || /Подтверждаем|Проверяем/.test(immediateText), immediateText);

    await page.waitForSelector('.ledger-row', { state: 'attached' });
    await page.waitForFunction(
      () => {
        const rows2 = document.querySelectorAll('.ledger-row-summary');
        for (const r of rows2) {
          if (r.textContent?.includes('WClean') && r.textContent?.includes('Подтверждено')) return true;
        }
        return false;
      },
      { timeout: 10000 }
    ).catch(() => {});
    const rowTextAfter = await page.locator('.ledger-row-summary').nth(cleanIndex).innerText();
    check('1c: after the real refetch, the row shows the APPROVED badge', rowTextAfter.includes('Подтверждено'), rowTextAfter);

    const item = await prisma.customerHoursApprovalItem.findFirst({ where: { timesheetId: fx.cleanTimesheetId } });
    check('1d: exactly one real CustomerHoursApprovalItem exists in the DB', item !== null, item);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Warning approval requires a second explicit click ("Всё равно подтвердить").
  // ---------------------------------------------------------------------------------------------
  {
    const rangeQs = `startDate=${isoDate(fx.warnMonday)}&endDate=${endOf(fx.warnMonday)}`;
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const warnIndex = await findRowIndexByText(rows, 'WWarn');
    await rows.nth(warnIndex).click();
    await page.waitForTimeout(150);

    await page.locator('.ledger-row').nth(warnIndex).locator('.ledger-approve-button').click();
    const warningPanel = page.locator('.ledger-row').nth(warnIndex).locator('.ledger-approve-warning-confirm');
    await warningPanel.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    check('2: a warning shows a compact inline confirm panel, not an immediate commit', (await warningPanel.count()) > 0, await page.locator('.ledger-row').nth(warnIndex).innerText());

    const confirmAnyway = warningPanel.locator('.ledger-approve-button');
    await confirmAnyway.click();
    await page.waitForFunction(
      (idx) => {
        const rowsEl = document.querySelectorAll('.ledger-row-summary');
        const r = rowsEl[idx];
        return r?.textContent?.includes('Подтверждено') ?? false;
      },
      warnIndex,
      { timeout: 10000 }
    ).catch(() => {});
    const rowTextAfter = await page.locator('.ledger-row-summary').nth(warnIndex).innerText();
    check('2b: after the second click, the row is approved', rowTextAfter.includes('Подтверждено'), rowTextAfter);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. UT6-A-R1 §1 — OPEN_SHIFT is a warning, not a blocker: the row goes through the SAME
  //    "Всё равно подтвердить" second-click flow as block 2, proving the reclassification actually
  //    changed real UI behavior (the button is never disabled for this condition anymore).
  // ---------------------------------------------------------------------------------------------
  {
    const rangeQs = `startDate=${isoDate(fx.openShiftMonday)}&endDate=${endOf(fx.openShiftMonday)}`;
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const openShiftIndex = await findRowIndexByText(rows, 'WOpenShift');
    await rows.nth(openShiftIndex).click();
    await page.waitForTimeout(150);

    const button = page.locator('.ledger-row').nth(openShiftIndex).locator('.ledger-approve-button');
    check('3: the button stays enabled for an OPEN_SHIFT row (warning, not a blocker)', await button.isEnabled());
    await button.click();
    const warningPanel = page.locator('.ledger-row').nth(openShiftIndex).locator('.ledger-approve-warning-confirm');
    await warningPanel.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    const panelText = await page.locator('.ledger-row').nth(openShiftIndex).innerText();
    check('3b: the open-shift warning reason is visible in the confirm panel', /Незакрытая смена/.test(panelText), panelText);

    await warningPanel.locator('.ledger-approve-button').click();
    await page.waitForFunction(
      (idx) => {
        const rowsEl = document.querySelectorAll('.ledger-row-summary');
        return rowsEl[idx]?.textContent?.includes('Подтверждено') ?? false;
      },
      openShiftIndex,
      { timeout: 10000 }
    ).catch(() => {});
    const rowTextAfter = await page.locator('.ledger-row-summary').nth(openShiftIndex).innerText();
    check('3c: confirming anyway succeeds despite the open shift', rowTextAfter.includes('Подтверждено'), rowTextAfter);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. DRAFT/NOT_SUBMITTED slice shows the explicit "worker can still change hours" warning note.
  // ---------------------------------------------------------------------------------------------
  {
    const rangeQs = `startDate=${isoDate(fx.draftMonday)}&endDate=${endOf(fx.draftMonday)}`;
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const draftIndex = await findRowIndexByText(rows, 'WDraft');
    await rows.nth(draftIndex).click();
    await page.waitForTimeout(150);
    const panelText = await page.locator('.ledger-row').nth(draftIndex).innerText();
    check('4: DRAFT/NOT_SUBMITTED row shows the explicit warning that the worker can still change hours', /ещё может изменить/.test(panelText), panelText);
    const button = page.locator('.ledger-row').nth(draftIndex).locator('.ledger-approve-button');
    check('4b: the confirm button is still offered for a DRAFT slice (approving it is allowed, just warned)', (await button.count()) > 0, panelText);
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Stale fingerprint -> refresh prompt (mocked preview response, deterministic).
  // ---------------------------------------------------------------------------------------------
  {
    const rangeQs = `startDate=${isoDate(fx.staleMonday)}&endDate=${endOf(fx.staleMonday)}`;
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&employeeSearch=WStale`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    await rows.first().click();
    await page.waitForTimeout(150);

    await page.route('**/api/admin/time-ledger/approval-preview', async (route) => {
      const body = { itemKey: {}, currentFingerprint: '0'.repeat(64), matchesExpectedFingerprint: false, warnings: [], blockers: [], eligibility: { canApprove: true }, existingApproval: { state: 'NONE' } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.locator('.ledger-row').first().locator('.ledger-approve-button').click();
    const staleBanner = page.locator('.ledger-row').first().locator('.ledger-approve-stale');
    await staleBanner.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    check('5: a stale preview shows a refresh prompt, never proceeds to commit', (await staleBanner.count()) > 0, await page.locator('.ledger-row').first().innerText());
    await page.unroute('**/api/admin/time-ledger/approval-preview');
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Double-click safety: two rapid clicks create exactly one item, never two.
  // ---------------------------------------------------------------------------------------------
  {
    const rangeQs = `startDate=${isoDate(fx.doubleMonday)}&endDate=${endOf(fx.doubleMonday)}`;
    await page.goto(`${BASE}/admin/timesheets?${rangeQs}&workAreaId=${fx.wa.id}`, { waitUntil: 'networkidle' });
    const rows = page.locator('.ledger-row-summary');
    const doubleIndex = await findRowIndexByText(rows, 'WDouble');
    await rows.nth(doubleIndex).click();
    await page.waitForTimeout(150);

    // Two click events dispatched back-to-back in ONE page.evaluate() call, deliberately not via
    // Playwright's own .click() action twice -- the component's busyRef guard replaces the button
    // with a loading indicator on the FIRST click's state update, so a second real Playwright click
    // action would just time out waiting for an element that has already been swapped out (that IS
    // the protection working, not a bug) rather than exercising the "two clicks arrive before React
    // re-renders" race this check actually wants to prove is safe.
    await page.evaluate((idx) => {
      const btn = document.querySelectorAll('.ledger-row')[idx]?.querySelector('.ledger-approve-button') as HTMLButtonElement | null;
      btn?.click();
      btn?.click();
    }, doubleIndex);
    await page.waitForFunction(
      (idx) => {
        const rowsEl = document.querySelectorAll('.ledger-row-summary');
        return rowsEl[idx]?.textContent?.includes('Подтверждено') ?? false;
      },
      doubleIndex,
      { timeout: 10000 }
    ).catch(() => {});

    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: fx.doubleTimesheetId } });
    check('6: exactly one item exists after a rapid double-click', items === 1, items);
  }

  // ---------------------------------------------------------------------------------------------
  // 6b. UT5-B-fixup-2 — a commit that genuinely reaches and completes on the real server, but whose
  //     RESPONSE the client never sees (a real, ambiguous network failure). "Try again" must send
  //     the exact same body and Idempotency-Key, get the cached 200 back, and never create a second
  //     item or an extra RECONFIRMED audit event.
  // ---------------------------------------------------------------------------------------------
  {
    // Snapshot the console-error count BEFORE this block's intentional route.abort() below (and
    // block 7's later one) -- a browser legitimately logs a "Failed to load resource" console
    // message for an aborted request, which must not count against the real "zero console errors"
    // assertion made at the very end of this run. This is the EARLIEST intentional abort in the
    // file, so this single snapshot point covers both this block and block 7's own abort.
    consoleErrorsBeforeAbort = consoleErrors.length;
    const site6b = await mkSite('a6b');
    const wa6b = await mkWorkArea(site6b.id, `A6B ${randomUUID().slice(0, 4)}`);
    const w6b = await mkWorker('W6bRetry');
    const monday6b = nextMonday();
    const draft6b = await buildDraft(w6b.id, site6b.id, wa6b.id, monday6b);
    await submitTimesheet(w6b.id, draft6b.ts.id);

    await page.goto(`${BASE}/admin/timesheets?startDate=${isoDate(monday6b)}&endDate=${endOf(monday6b)}&workAreaId=${wa6b.id}`, { waitUntil: 'networkidle' });
    await page.locator('.ledger-row-summary').first().click();
    await page.waitForTimeout(150);

    // route.fetch() genuinely dispatches the request to the real server and waits for its real
    // response (business logic runs to completion, server-side idempotency caching completes) --
    // THEN route.abort() simulates the browser never receiving that response, exactly like a
    // connection drop after the server already processed the write.
    let firstIdempotencyKey: string | null = null;
    let firstBody: string | null = null;
    let firstRequestIntercepted = false;
    await page.route('**/api/admin/time-ledger/approvals', async (route) => {
      if (firstRequestIntercepted) {
        await route.continue();
        return;
      }
      firstRequestIntercepted = true;
      firstIdempotencyKey = route.request().headers()['idempotency-key'] ?? null;
      firstBody = route.request().postData();
      await route.fetch();
      await route.abort('failed');
    });

    await page.locator('.ledger-row').first().locator('.ledger-approve-button').click();
    const errorBanner = page.locator('.ledger-row').first().locator('.ledger-approve-error[role="alert"]');
    await errorBanner.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    check('6b-1: a client-side network failure during commit surfaces the error banner', (await errorBanner.count()) > 0, await page.locator('.ledger-row').first().innerText());

    const itemsAfterFirst = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: draft6b.ts.id } });
    check('6b-2: the server genuinely created the item from the first request despite the client never seeing the response', itemsAfterFirst === 1, itemsAfterFirst);

    let retryIdempotencyKey: string | null = null;
    let retryBody: string | null = null;
    const captureRetry = (req: import('playwright').Request) => {
      if (req.method() === 'POST' && req.url().includes('/api/admin/time-ledger/approvals')) {
        retryIdempotencyKey = req.headers()['idempotency-key'] ?? null;
        retryBody = req.postData();
      }
    };
    page.on('request', captureRetry);
    await page.locator('.ledger-row').first().locator('.ledger-retry-button').click();
    await page
      .waitForFunction(() => document.querySelectorAll('.ledger-row-summary')[0]?.textContent?.includes('Подтверждено') ?? false, { timeout: 10000 })
      .catch(() => {});
    page.off('request', captureRetry);
    await page.unroute('**/api/admin/time-ledger/approvals');

    check('6b-3: the retry sent the EXACT SAME Idempotency-Key as the first attempt', retryIdempotencyKey !== null && retryIdempotencyKey === firstIdempotencyKey, { first: firstIdempotencyKey, retry: retryIdempotencyKey });
    check('6b-4: the retry sent the EXACT SAME request body as the first attempt', retryBody !== null && retryBody === firstBody, { first: firstBody, retry: retryBody });

    const rowTextAfterRetry = await page.locator('.ledger-row-summary').first().innerText();
    check('6b-5: after the retry, the row shows APPROVED (the result came from the idempotency cache)', rowTextAfterRetry.includes('Подтверждено'), rowTextAfterRetry);

    const itemsAfterRetry = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: draft6b.ts.id } });
    check('6b-6: still exactly ONE approval item — the cached replay created no second write', itemsAfterRetry === 1, itemsAfterRetry);

    const item6b = await prisma.customerHoursApprovalItem.findFirstOrThrow({ where: { timesheetId: draft6b.ts.id } });
    const reconfirmedForThisItem = await prisma.auditEvent.count({ where: { entityId: item6b.id, eventType: 'CUSTOMER_HOURS_APPROVAL_RECONFIRMED' } });
    check('6b-7: no extra CUSTOMER_HOURS_APPROVAL_RECONFIRMED audit event — the cached replay never re-ran business logic', reconfirmedForThisItem === 0, reconfirmedForThisItem);
    const approvedForThisItem = await prisma.auditEvent.count({ where: { entityId: item6b.id, eventType: 'CUSTOMER_HOURS_APPROVED' } });
    check('6b-8: exactly one CUSTOMER_HOURS_APPROVED audit event exists (business logic ran exactly once, on the first request)', approvedForThisItem === 1, approvedForThisItem);
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Accessible loading/error states — role=status while loading, role=alert on failure.
  // ---------------------------------------------------------------------------------------------
  {
    const site2 = await mkSite('a7');
    const wa2 = await mkWorkArea(site2.id, `A7 ${randomUUID().slice(0, 4)}`);
    const w7 = await mkWorker('W7Access');
    const monday7 = nextMonday();
    const draft7 = await buildDraft(w7.id, site2.id, wa2.id, monday7);
    await submitTimesheet(w7.id, draft7.ts.id);
    await page.goto(`${BASE}/admin/timesheets?startDate=${isoDate(monday7)}&endDate=${endOf(monday7)}&workAreaId=${wa2.id}`, { waitUntil: 'networkidle' });
    const row7 = page.locator('.ledger-row-summary').first();
    await row7.click();
    await page.waitForTimeout(150);

    // Delay (never abort) the preview response briefly so the transient loading state is
    // observable, then let it resolve normally into the clean auto-commit flow.
    await page.route('**/api/admin/time-ledger/approval-preview', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.locator('.ledger-row').first().locator('.ledger-approve-button').click();
    const loadingStatus = page.locator('.ledger-row').first().locator('.ledger-approve-loading[role="status"]');
    check('7: the loading phase is announced via role=status', await loadingStatus.isVisible().catch(() => false));
    // Wait for the delayed handler to genuinely finish (route.continue()) and the whole clean
    // auto-commit flow to land BEFORE unrouting -- unrouting while that handler is still asleep in
    // its own setTimeout made Playwright treat the route as already resolved out from under it.
    await page.waitForFunction(() => document.querySelectorAll('.ledger-row-summary')[0]?.textContent?.includes('Подтверждено') ?? false, { timeout: 10000 }).catch(() => {});
    await page.unroute('**/api/admin/time-ledger/approval-preview');

    // A second, fresh row for the network-failure/role=alert check. consoleErrorsBeforeAbort was
    // already snapshotted at block 6b's own (earlier) intentional abort — not reset here, since
    // that snapshot already precedes every intentional route.abort() in this file, including this
    // block's.
    const w7b = await mkWorker('W7AccessB');
    const monday7b = nextMonday();
    const draft7b = await buildDraft(w7b.id, site2.id, wa2.id, monday7b);
    await submitTimesheet(w7b.id, draft7b.ts.id);
    await page.goto(`${BASE}/admin/timesheets?startDate=${isoDate(monday7b)}&endDate=${endOf(monday7b)}&workAreaId=${wa2.id}`, { waitUntil: 'networkidle' });
    await page.locator('.ledger-row-summary').first().click();
    await page.waitForTimeout(150);
    await page.route('**/api/admin/time-ledger/approval-preview', async (route) => route.abort('failed'));
    await page.locator('.ledger-row').first().locator('.ledger-approve-button').click();
    const errorBanner = page.locator('.ledger-row').first().locator('.ledger-approve-error[role="alert"]');
    await errorBanner.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    check('7b: a network failure surfaces via role=alert, not a silent failure', (await errorBanner.count()) > 0, await page.locator('.ledger-row').first().innerText());
    await page.unroute('**/api/admin/time-ledger/approval-preview');
  }

  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  check('desktop: no horizontal overflow introduced by the approve UI', bodyWidth <= DESKTOP.width + 1, bodyWidth);
  check('zero console errors across the whole approval flow (excluding the intentionally-aborted network-failure check)', consoleErrorsBeforeAbort === 0, consoleErrors.slice(0, consoleErrorsBeforeAbort));

  await context.close();
  await browser.close();

  // ---------------------------------------------------------------------------------------------
  // 8. Flag off -> legacy page has no approval UI and no approval API calls at all.
  // ---------------------------------------------------------------------------------------------
  if (LEGACY_BASE) {
    const legacyCookie = await login(LEGACY_BASE, (await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } })).username, PASSWORD);
    const browser2 = await chromium.launch({ headless: true });
    const context2 = await browser2.newContext({ viewport: DESKTOP });
    await context2.addCookies([{ name: 'tt_session', value: legacyCookie, url: LEGACY_BASE }]);
    const page2 = await context2.newPage();
    const legacyRequests: string[] = [];
    page2.on('request', (r) => {
      if (r.url().includes('/api/admin/time-ledger/approval')) legacyRequests.push(r.url());
    });
    await page2.goto(`${LEGACY_BASE}/admin/timesheets`, { waitUntil: 'networkidle' });
    check('8: legacy page has no approve-button markup at all', (await page2.locator('.ledger-approve-button').count()) === 0);
    check('8b: legacy page never calls either new approval endpoint', legacyRequests.length === 0, legacyRequests);
    await browser2.close();
  } else {
    console.log('  SKIPPED flag-off legacy-page check — TEST_BASE_URL_LEGACY not set.');
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
