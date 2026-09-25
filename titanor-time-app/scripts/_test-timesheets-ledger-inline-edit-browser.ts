// Inline week editor (2026-09-25) — real Chromium browser QA for «Внести изменения» inside an
// expanded /admin/timesheets row: the week is edited in place (no navigation to the timesheet card
// or the corrections editor), one «Сохранить» click runs direct-edit -> day PATCH -> apply-in-review,
// «Отмена» writes nothing, a day split between two customers keeps the OTHER customer's interval
// untouched, a server-rejected save (overlapping intervals) shows an error and leaves NO open
// correction behind, and the editor fits a 390px viewport. Needs a standalone server
// (TEST_BASE_URL) started with TIMESHEETS_LEDGER_UI_ENABLED=1 against a disposable PostgreSQL 16.

import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { login } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3941';
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const PASSWORD = 'InlineEditQaPassw0rd!23';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log('ok  ', name);
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

// January 2034: Europe/Helsinki is UTC+2, so at(monday, 7) is 09:00 on the admin's screen.
const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let adminUserId = '';
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2034, 0, 2) + weekSlot * 14 * 86400000); // 2034-01-02 is a Monday
  weekSlot += 1;
  return d;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function endOf(d: Date): string {
  return isoDate(new Date(d.getTime() + 6 * 86400000));
}

async function mkCustomer(tag: string) {
  const site = await prisma.workSite.create({ data: { name: `IEB-${tag}-${randomUUID().slice(0, 5)}` } });
  const wa = await prisma.workArea.create({ data: { siteId: site.id, name: `${tag} Co ${randomUUID().slice(0, 4)}` } });
  return { site, wa };
}

// One worker, one submitted weekly timesheet; `segments` are [customer, startHourUtc, endHourUtc]
// on the Monday. Several customers on the same day make a split day.
async function mkSubmittedWorker(tag: string, monday: Date, segments: [{ site: { id: string }; wa: { id: string } }, number, number][]) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `IEB-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  const assignmentBySite = new Map<string, string>();
  for (const [c, startH, endH] of segments) {
    let asgId = assignmentBySite.get(c.wa.id);
    if (!asgId) {
      const asg = await prisma.siteAssignment.create({
        data: { employeeId: emp.id, siteId: c.site.id, workAreaId: c.wa.id, isPrimary: assignmentBySite.size === 0, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId }
      });
      asgId = asg.id;
      assignmentBySite.set(c.wa.id, asgId);
      await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: monday, siteId: c.site.id, sourceAssignmentId: asgId, plannedStartAt: at(monday, startH), plannedEndAt: at(monday, endH), plannedBreakMinutes: 0 } });
    }
    await prisma.timesheetDraftSegment.create({
      data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: monday, startAt: at(monday, startH), endAt: at(monday, endH), siteId: c.site.id, workAreaId: c.wa.id, sourceAssignmentId: asgId }
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminUserId, randomUUID(), 'MANUAL' as any);
  });
  return { employee: emp, timesheetId: ts.id };
}

async function openCorrections(timesheetId: string): Promise<number> {
  return prisma.correctionRequest.count({ where: { timesheetId, status: { notIn: ['APPROVED', 'REJECTED'] } } });
}

async function expandRow(page: Page, qs: string, name: string) {
  await page.goto(`${BASE}/admin/timesheets?${qs}`, { waitUntil: 'networkidle' });
  const row = page.locator('.ledger-row', { has: page.locator('.ledger-row-summary', { hasText: name }) });
  await row.locator('.ledger-row-summary').click();
  await row.locator('.ledger-expanded').waitFor({ state: 'visible', timeout: 5000 });
  return row;
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const admin = await prisma.user.create({ data: { username: `ieb-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'RU', passwordHash, userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;

  const custA = await mkCustomer('Aros');
  const custB = await mkCustomer('Other');
  const monday = nextMonday();
  const w1 = await mkSubmittedWorker('IE1', monday, [[custA, 7, 15]]); // 09:00–17:00
  const w2 = await mkSubmittedWorker('IE2', monday, [[custA, 7, 11], [custB, 12, 16]]); // 09:00–13:00 A, 14:00–18:00 B
  const w3 = await mkSubmittedWorker('IE3', monday, [[custA, 7, 15]]);

  const cookie = await login(BASE, admin.username, PASSWORD);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: DESKTOP });
  await context.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const qsA = `startDate=${isoDate(monday)}&endDate=${endOf(monday)}&workAreaId=${custA.wa.id}`;
  const qsB = `startDate=${isoDate(monday)}&endDate=${endOf(monday)}&workAreaId=${custB.wa.id}`;

  // 1. «Внести изменения» opens the editor in place — no navigation — and Save stays disabled until
  //    something actually changes.
  {
    const row = await expandRow(page, qsA, 'IE1');
    const urlBefore = page.url();
    await row.getByRole('button', { name: 'Внести изменения' }).click();
    await row.locator('.ledger-edit').waitFor({ state: 'visible', timeout: 5000 });
    check('1: the editor opens inside the row, the URL does not change', page.url() === urlBefore, { before: urlBefore, after: page.url() });
    const firstDay = row.locator('.ledger-edit-table tbody tr').first();
    check('1a: Monday is prefilled with 09:00–17:00', (await firstDay.getByLabel('Начало', { exact: true }).inputValue()) === '09:00' && (await firstDay.getByLabel('Конец', { exact: true }).inputValue()) === '17:00');
    check('1b: Save is disabled before any change', await row.locator('.ledger-edit .ledger-approve-button').isDisabled());

    // 2. «Отмена» closes the editor and writes nothing.
    await firstDay.getByLabel('Конец', { exact: true }).fill('18:00');
    await row.getByRole('button', { name: 'Отмена' }).click();
    check('2: Cancel closes the editor', (await row.locator('.ledger-edit').count()) === 0);
    check('2a: Cancel created no correction at all', (await prisma.correctionRequest.count({ where: { timesheetId: w1.timesheetId } })) === 0);

    // 3. A real edit saved with one click, still on the same page.
    await row.getByRole('button', { name: 'Внести изменения' }).click();
    const monday1 = row.locator('.ledger-edit-table tbody tr').first();
    await monday1.getByLabel('Конец', { exact: true }).fill('18:30');
    const saveButton = row.locator('.ledger-edit .ledger-approve-button');
    check('3: Save counts one changed day', /дней:\s*1/.test(await saveButton.innerText()), await saveButton.innerText());
    await saveButton.click();
    await row.locator('.ledger-approve-success').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    check('3a: editor closed and a success note is shown', (await row.locator('.ledger-edit').count()) === 0 && (await row.locator('.ledger-approve-success').count()) === 1);
    check('3b: still on /admin/timesheets (no redirect)', page.url() === urlBefore, page.url());
    await page.waitForFunction(() => [...document.querySelectorAll('.ledger-days-table td')].some((td) => td.textContent === '18:30'), { timeout: 15000 }).catch(() => {});
    check('3c: the refetched week shows the new end time 18:30', (await row.locator('.ledger-days-table td', { hasText: /^18:30$/ }).count()) === 1);
    const cr = await prisma.correctionRequest.findMany({ where: { timesheetId: w1.timesheetId } });
    check('3d: exactly one direct-edit correction, applied', cr.length === 1 && cr[0].status === 'APPROVED' && cr[0].directEdit === true, cr.map((c) => [c.status, c.directEdit]));
    const ts = await prisma.timesheet.findUniqueOrThrow({ where: { id: w1.timesheetId } });
    check('3e: the timesheet is back in review (SUBMITTED)', ts.status === 'SUBMITTED', ts.status);
  }

  // 4. Split day: editing customer A's interval keeps customer B's interval exactly as it was.
  {
    const row = await expandRow(page, qsA, 'IE2');
    await row.getByRole('button', { name: 'Внести изменения' }).click();
    const monday2 = row.locator('.ledger-edit-table tbody tr').first();
    check('4: only this customer\'s interval is in the editor', (await monday2.getByLabel('Начало', { exact: true }).count()) === 1);
    await monday2.getByLabel('Конец', { exact: true }).fill('13:30');
    await row.locator('.ledger-edit .ledger-approve-button').click();
    await row.locator('.ledger-approve-success').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    check('4a: split-day save succeeded', (await row.locator('.ledger-approve-success').count()) === 1, await row.innerText());

    const rowB = await expandRow(page, qsB, 'IE2');
    const cells = await rowB.locator('.ledger-days-table tbody tr').first().locator('td').allInnerTexts();
    check('4b: customer B still shows 14:00–18:00', cells[1] === '14:00' && cells[2] === '18:00', cells);
  }

  // 5. A save the server rejects (overlapping intervals) shows an error, keeps the editor open with
  //    the admin's input, and leaves no open correction behind to block approval.
  {
    const row = await expandRow(page, qsA, 'IE3');
    await row.getByRole('button', { name: 'Внести изменения' }).click();
    const monday3 = row.locator('.ledger-edit-table tbody tr').first();
    await monday3.getByRole('button', { name: '+ интервал' }).click(); // defaults to 07:00–15:30, overlaps 09:00–17:00
    await row.locator('.ledger-edit .ledger-approve-button').click();
    await row.locator('.ledger-edit [role="alert"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const alertText = (await row.locator('.ledger-edit [role="alert"]').innerText().catch(() => '')) || '';
    check('5: overlap error is shown in plain language', /пересекаются/.test(alertText), alertText);
    check('5a: the editor stays open', (await row.locator('.ledger-edit').count()) === 1);
    check('5b: no open correction is left on the timesheet', (await openCorrections(w3.timesheetId)) === 0);
    const tsStatus = (await prisma.timesheet.findUniqueOrThrow({ where: { id: w3.timesheetId } })).status;
    check('5c: the timesheet is untouched (still SUBMITTED)', tsStatus === 'SUBMITTED', tsStatus);
  }

  // 6. Mobile: the editor never makes the page scroll sideways.
  {
    const mobileContext = await browser.newContext({ viewport: MOBILE });
    await mobileContext.addCookies([{ name: 'tt_session', value: cookie, url: BASE }]);
    const mobilePage = await mobileContext.newPage();
    const row = await expandRow(mobilePage, qsA, 'IE3');
    await row.getByRole('button', { name: 'Внести изменения' }).click();
    await row.locator('.ledger-edit').waitFor({ state: 'visible', timeout: 5000 });
    const scrollWidth = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await mobilePage.evaluate(() => document.documentElement.clientWidth);
    check('6: no horizontal page overflow on mobile with the editor open', scrollWidth <= clientWidth + 2, { scrollWidth, clientWidth });
    await mobileContext.close();
  }

  // The deliberate overlap in step 5 makes the browser log the 409 response itself.
  const unexpected = consoleErrors.filter((e) => !/status of 409/.test(e));
  check('7: zero unexpected console errors', unexpected.length === 0, unexpected);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
