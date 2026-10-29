// Табель v2 — real-Postgres coverage of the owner rules of 2026-10-15:
//  1. schedule cap: hours counted inside the worker's template window (minus the ledger's breaks),
//     never above the recorded or planned hours; template days off keep the recorded hours;
//  2. "Редактировать табель": typed values (TimesheetV2CellOverride) replace computed cells — saved
//     and reset through POST/DELETE /api/admin/timesheets-v2/cells, audited, admin-only, CSRF-gated —
//     and flow into the month grid, the customer cards and the Excel export.
// Needs a disposable PostgreSQL 16 (DATABASE_URL) with every migration applied.

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as cellsPOST, DELETE as cellsDELETE } from '../app/api/admin/timesheets-v2/cells/route';
import { POST as cardsPOST } from '../app/api/admin/timesheets-v2/cards/route';
import { GET as exportGET } from '../app/api/admin/timesheets-v2/export/route';
import { loadCustomerCards, loadCustomerMonthMatrix } from '../lib/reporting/monthly-matrix';
import { parseCellInput, saveTimesheetV2Cells, TimesheetV2CellError } from '../lib/timesheet-v2-cells';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 800) : ''); }
}

const MONTH = '2037-01';
const TODAY = '2037-02-01';
let adminUserId = '';

async function makeSession(roleName: string): Promise<{ token: string; userId: string }> {
  const user = await prisma.user.create({ data: { username: `tv2-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { token, userId: user.id };
}

function req(url: string, token: string | null, method: 'POST' | 'DELETE' | 'GET', body?: unknown, csrf = true): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrf) headers.set('x-requested-with', 'titanor-time');
  if (token) headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
  return new NextRequest(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));
/** Helsinki is UTC+2 in January. */
const local = (date: string, h: number, m = 0) => new Date(Date.parse(`${date}T00:00:00.000Z`) + ((h - 2) * 60 + m) * 60000);

async function main() {
  const admin = await makeSession('SUPER_ADMIN');
  adminUserId = admin.userId;
  const worker = await makeSession('WORKER');

  const site = await prisma.workSite.create({ data: { name: `TV2 Site ${randomUUID().slice(0, 5)}` } });
  const area = await prisma.workArea.create({ data: { siteId: site.id, name: `TV2 Customer ${randomUUID().slice(0, 4)}` } });
  const otherArea = await prisma.workArea.create({ data: { siteId: site.id, name: `TV2 Other ${randomUUID().slice(0, 4)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `TV2-${randomUUID().slice(0, 8)}`, firstName: 'Oleksandr', lastName: 'Kosariev' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  const idle = await prisma.employee.create({ data: { employeeNumber: `TV2-${randomUUID().slice(0, 8)}`, firstName: 'Ivan', lastName: 'Isaiev' } });

  // Template like Aros Marine: Mon–Fri 07:00–18:00, Sat 07:00–13:00, 30 min unpaid lunch; Sunday off.
  const template = await prisma.workScheduleTemplate.create({ data: { name: `TV2 Tpl ${randomUUID().slice(0, 4)}` } });
  const version = await prisma.workScheduleTemplateVersion.create({ data: { templateId: template.id, versionNumber: 1, createdByUserId: adminUserId, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') } });
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const working = weekday < 6;
    await prisma.workScheduleTemplateVersionDay.create({ data: { templateVersionId: version.id, weekday, isWorkingDay: working, plannedStartTime: working ? time(7) : null, plannedEndTime: working ? (weekday === 5 ? time(13) : time(18)) : null, plannedBreakMinutes: working ? 30 : 0, plannedBreakPaid: false } });
  }
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: area.id, templateVersionId: version.id, isPrimary: true, validFrom: new Date('2036-12-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
  await prisma.siteAssignment.create({ data: { employeeId: idle.id, siteId: site.id, workAreaId: area.id, templateVersionId: version.id, isPrimary: true, validFrom: new Date('2036-12-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });

  // One weekly draft (Mon 2037-01-05 … Sun 2037-01-11) with the owner's example days.
  const monday = new Date('2037-01-05T00:00:00.000Z');
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date('2037-01-11T00:00:00.000Z'), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
  const shifts: Array<[string, [number, number], [number, number]]> = [
    ['2037-01-05', [6, 30], [18, 30]], // 06:30–18:30 → 10.5
    ['2037-01-06', [9, 0], [20, 0]],   // 09:00–20:00 → 9 h in the window − lunch
    ['2037-01-07', [12, 0], [18, 0]],  // 12:00–18:00 → recorded
    ['2037-01-10', [7, 0], [15, 0]],   // Saturday 07:00–15:00, template ends 13:00
    ['2037-01-11', [10, 0], [14, 0]]   // Sunday, template day off → recorded
  ];
  for (const [date, from, to] of shifts) {
    const day = new Date(`${date}T00:00:00.000Z`);
    const sunday = date === '2037-01-11';
    const saturday = date === '2037-01-10';
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: day, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: sunday ? null : local(date, 7), plannedEndAt: sunday ? null : local(date, saturday ? 13 : 18), plannedBreakMinutes: sunday ? 0 : 30 } });
    await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } }).then((dd) =>
      prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: day, startAt: local(date, ...from), endAt: local(date, ...to), siteId: site.id, workAreaId: area.id, sourceAssignmentId: asg.id } })
    );
  }

  const customer = { siteId: site.id, workAreaId: area.id };
  const first = await loadCustomerMonthMatrix(MONTH, customer, { userId: adminUserId, employeeId: null }, TODAY);
  check('matrix loads', first.ok, first);
  if (!first.ok) throw new Error('matrix did not load');
  const row = first.matrix.rows.find((r) => r.employeeId === emp.id)!;
  const cell = (d: number) => row.cells[d - 1];
  const lunch = (d: number) => cell(d).recordedMinutes; // recorded = gross − ledger breaks
  check('attached worker without hours has a row', first.matrix.rows.some((r) => r.employeeId === idle.id && r.totalMinutes === 0));
  check('Mon 06:30–18:30 → 10.5 h', cell(5).workedMinutes === 630 && cell(5).capped, cell(5));
  const tueBreak = 660 - lunch(6);
  check('Tue 09:00–20:00 → 9 h inside 07–18 minus the same lunch', cell(6).workedMinutes === 540 - tueBreak && cell(6).capped, { cell: cell(6), tueBreak });
  check('Wed 12:00–18:00 → recorded hours, not capped', cell(7).workedMinutes === lunch(7) && !cell(7).capped, cell(7));
  check('Sat 07:00–15:00 → capped to the 07:00–13:00 Saturday plan', cell(10).workedMinutes === Math.min(330, 360 - (480 - lunch(10))) && cell(10).capped, cell(10));
  check('Sun on a template day off → recorded hours', cell(11).workedMinutes === lunch(11) && !cell(11).capped, cell(11));
  check('Thu/Fri without hours inside the active week → OFF', cell(8).kind === 'OFF' && cell(9).kind === 'OFF');

  // ---- saving typed cells (service) ----
  const bad = await saveTimesheetV2Cells({ ...customer, month: MONTH, changes: [{ employeeId: emp.id, date: '2037-01-08', value: '9' }, { employeeId: emp.id, date: '2037-01-09', value: 'abc' }], actorUserId: adminUserId, requestId: randomUUID() }).then(() => null, (e) => e);
  check('invalid value rejects the whole save', bad instanceof TimesheetV2CellError && bad.code === 'INVALID_VALUE' && (await prisma.timesheetV2CellOverride.count({ where: { employeeId: emp.id } })) === 0, bad?.code);
  const outside = await saveTimesheetV2Cells({ ...customer, month: MONTH, changes: [{ employeeId: emp.id, date: '2037-02-01', value: '9' }], actorUserId: adminUserId, requestId: randomUUID() }).then(() => null, (e) => e);
  check('date outside the month rejected', outside?.code === 'DATE_OUTSIDE_MONTH');
  check('parse accepts 10,5 / 7:30 / off / empty', parseCellInput('10,5')?.minutes === 630 && parseCellInput('7:30')?.minutes === 450 && parseCellInput('off')?.off === true && parseCellInput('')?.minutes === 0 && parseCellInput('25') === null);

  // ---- API ----
  const url = 'http://localhost/api/admin/timesheets-v2/cells';
  const body = { siteId: site.id, workArea: area.id, month: MONTH, changes: [
    { employeeId: emp.id, date: '2037-01-05', value: '12' },  // overtime typed by the boss
    { employeeId: emp.id, date: '2037-01-08', value: '9' },   // OFF day filled
    { employeeId: emp.id, date: '2037-01-09', value: 'OFF' }, // stays OFF, now explicit
    { employeeId: emp.id, date: '2037-01-11', value: '' },    // Sunday cleared
    { employeeId: idle.id, date: '2037-01-12', value: '7,5' }
  ] };
  check('anonymous save → 401', (await cellsPOST(req(url, null, 'POST', body))).status === 401);
  check('save without CSRF header → 403', (await cellsPOST(req(url, admin.token, 'POST', body, false))).status === 403);
  check('worker cannot save → 403', (await cellsPOST(req(url, worker.token, 'POST', body))).status === 403);
  check('unknown customer → 404', (await cellsPOST(req(url, admin.token, 'POST', { ...body, workArea: randomUUID() }))).status === 404);
  const saved = await cellsPOST(req(url, admin.token, 'POST', body));
  const savedBody = await saved.json();
  check('admin save → 200, 5 cells', saved.status === 200 && savedBody.saved === 5, savedBody);
  const again = await (await cellsPOST(req(url, admin.token, 'POST', body))).json();
  check('saving the same values again writes nothing', again.saved === 0, again);
  const update = await (await cellsPOST(req(url, admin.token, 'POST', { ...body, changes: [{ employeeId: emp.id, date: '2037-01-05', value: '11' }] }))).json();
  check('changing a typed value updates the same row', update.saved === 1 && (await prisma.timesheetV2CellOverride.count({ where: { employeeId: emp.id, date: new Date('2037-01-05T00:00:00.000Z') } })) === 1);
  const audit = await prisma.auditEvent.findMany({ where: { eventType: 'TIMESHEET_V2_CELLS_EDITED', actorUserId: adminUserId }, orderBy: { createdAt: 'asc' } });
  const lastChanges = (audit[1]?.afterValue as { changes?: Array<{ date: string; before: string | null; after: string }> } | null)?.changes ?? [];
  check('each effective save audited with before/after', audit.length === 2 && lastChanges.length === 1 && lastChanges[0].date === '2037-01-05' && lastChanges[0].before === '12' && lastChanges[0].after === '11', audit.map((a) => a.afterValue));

  const edited = await loadCustomerMonthMatrix(MONTH, customer, { userId: adminUserId, employeeId: null }, TODAY);
  if (!edited.ok) throw new Error('matrix did not load');
  const er = edited.matrix.rows.find((r) => r.employeeId === emp.id)!;
  const ir = edited.matrix.rows.find((r) => r.employeeId === idle.id)!;
  check('typed overtime replaces the cap', er.cells[4].manual && er.cells[4].workedMinutes === 660);
  check('typed hours fill an OFF day', er.cells[7].kind === 'WORK' && er.cells[7].workedMinutes === 540);
  check('typed OFF', er.cells[8].kind === 'OFF' && er.cells[8].manual);
  check('cleared Sunday is an empty weekend cell', er.cells[10].kind === 'WEEKEND' && er.cells[10].workedMinutes === 0 && er.cells[10].manual);
  check('typed hours for an attached worker without records', ir.cells[11].workedMinutes === 450 && ir.totalMinutes === 450);
  check('totals include typed values', edited.matrix.totalMinutes === er.totalMinutes + ir.totalMinutes && er.totalMinutes === 660 + cell(6).workedMinutes + cell(7).workedMinutes + 540 + cell(10).workedMinutes);

  const cards = await loadCustomerCards(MONTH, { userId: adminUserId, employeeId: null }, TODAY);
  const card = cards.ok ? cards.cards.find((c) => c.workAreaId === area.id) : null;
  check('customer card hours follow the edited grid', card?.workedMinutes === edited.matrix.totalMinutes && card?.peopleCount === 2, card);
  check('other customer untouched', cards.ok && (cards.cards.find((c) => c.workAreaId === otherArea.id)?.workedMinutes ?? 0) === 0);

  const xlsx = await exportGET(req(`http://localhost/api/admin/timesheets-v2/export?siteId=${site.id}&workArea=${area.id}&month=${MONTH}`, admin.token, 'GET', undefined, false));
  check('Excel export 200 with xlsx content type', xlsx.status === 200 && (xlsx.headers.get('content-type') ?? '').includes('spreadsheetml'));

  // ---- "no customer" key: NULL work area is one key (NULLS NOT DISTINCT) ----
  const noneCustomer = { siteId: site.id, workAreaId: null };
  await saveTimesheetV2Cells({ ...noneCustomer, month: MONTH, changes: [{ employeeId: emp.id, date: '2037-01-13', value: '5' }], actorUserId: adminUserId, requestId: randomUUID() });
  await saveTimesheetV2Cells({ ...noneCustomer, month: MONTH, changes: [{ employeeId: emp.id, date: '2037-01-13', value: '6' }], actorUserId: adminUserId, requestId: randomUUID() });
  check('no-customer cell updated, not duplicated', (await prisma.timesheetV2CellOverride.count({ where: { employeeId: emp.id, workAreaId: null } })) === 1);
  const dup = await prisma.timesheetV2CellOverride.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: null, date: new Date('2037-01-13T00:00:00.000Z'), minutes: 60, updatedByUserId: adminUserId } }).then(() => 'created', (e) => e.code);
  check('database refuses a second no-customer row for the same cell', dup === 'P2002', dup);
  const badOff = await prisma.timesheetV2CellOverride.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: area.id, date: new Date('2037-01-20T00:00:00.000Z'), minutes: 60, off: true, updatedByUserId: adminUserId } }).then(() => 'created', () => 'refused');
  check('database refuses OFF with hours', badOff === 'refused');

  // ---- reset ----
  const delUrl = `${url}?siteId=${site.id}&workArea=${area.id}&month=${MONTH}`;
  check('worker cannot reset → 403', (await cellsDELETE(req(delUrl, worker.token, 'DELETE'))).status === 403);
  const reset = await (await cellsDELETE(req(delUrl, admin.token, 'DELETE'))).json();
  check('reset removes this customer\'s typed values', reset.removed === 5, reset);
  check('reset leaves other customers\' typed values', (await prisma.timesheetV2CellOverride.count({ where: { employeeId: emp.id, workAreaId: null } })) === 1);
  check('reset audited', (await prisma.auditEvent.count({ where: { eventType: 'TIMESHEET_V2_CELLS_RESET' } })) === 1);
  const back = await loadCustomerMonthMatrix(MONTH, customer, { userId: adminUserId, employeeId: null }, TODAY);
  check('after reset the grid is computed again', back.ok && back.matrix.totalMinutes === first.matrix.totalMinutes);

  // ---- monthly card names and reversible trash; source hours are never deleted ----
  const cardsUrl = 'http://localhost/api/admin/timesheets-v2/cards';
  const noCustomerBody = { siteId: site.id, workArea: 'none', month: MONTH };
  check('worker cannot manage cards → 403', (await cardsPOST(req(cardsUrl, worker.token, 'POST', { ...noCustomerBody, action: 'RENAME', displayName: 'Hidden' }))).status === 403);
  check('card management requires CSRF → 403', (await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'RENAME', displayName: 'Hidden' }, false))).status === 403);
  check('invalid customer card → 404', (await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, siteId: randomUUID(), action: 'TRASH' }))).status === 404);
  check('empty card name rejected → 400', (await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'RENAME', displayName: '  ' }))).status === 400);

  const rename = await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'RENAME', displayName: 'Transferred workers' }));
  check('card rename → 200', rename.status === 200);
  const renamedCards = await loadCustomerCards(MONTH, { userId: adminUserId, employeeId: null }, TODAY);
  const noCustomerCard = renamedCards.ok ? renamedCards.cards.find((c) => c.workAreaId === null && c.siteId === site.id) : null;
  check('monthly card name is saved without changing the source customer', noCustomerCard?.displayName === 'Transferred workers' && (await prisma.workArea.findUniqueOrThrow({ where: { id: area.id } })).name.startsWith('TV2 Customer'));
  const overridesBeforeTrash = await prisma.timesheetV2CellOverride.count({ where: { siteId: site.id } });
  const totalBeforeTrash = renamedCards.ok ? renamedCards.totalMinutes : -1;

  const movedToTrash = await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'TRASH' }));
  const inTrash = await loadCustomerCards(MONTH, { userId: adminUserId, employeeId: null }, TODAY);
  check('move card to trash hides it from active cards', movedToTrash.status === 200 && inTrash.ok && !inTrash.cards.some((c) => c.workAreaId === null && c.siteId === site.id));
  check('trash shows card and preserves month total', inTrash.ok && inTrash.trashedCards.some((c) => c.displayName === 'Transferred workers') && inTrash.totalMinutes === totalBeforeTrash);
  check('trashing preserves the source overrides', (await prisma.timesheetV2CellOverride.count({ where: { siteId: site.id } })) === overridesBeforeTrash);

  const restored = await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'RESTORE' }));
  const restoredCards = await loadCustomerCards(MONTH, { userId: adminUserId, employeeId: null }, TODAY);
  check('restore returns renamed card to the month', restored.status === 200 && restoredCards.ok && restoredCards.cards.some((c) => c.displayName === 'Transferred workers'));

  await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'TRASH' }));
  const permanentlyRemoved = await cardsPOST(req(cardsUrl, admin.token, 'POST', { ...noCustomerBody, action: 'DELETE' }));
  const afterPermanentRemoval = await loadCustomerCards(MONTH, { userId: adminUserId, employeeId: null }, TODAY);
  check('permanent removal clears the trash but keeps card hidden', permanentlyRemoved.status === 200 && afterPermanentRemoval.ok && !afterPermanentRemoval.cards.some((c) => c.workAreaId === null && c.siteId === site.id) && !afterPermanentRemoval.trashedCards.some((c) => c.siteId === site.id && c.workAreaId === null));
  check('permanent removal retains source hours and monthly total', afterPermanentRemoval.ok && afterPermanentRemoval.totalMinutes === totalBeforeTrash && (await prisma.timesheetV2CellOverride.count({ where: { siteId: site.id } })) === overridesBeforeTrash);
  const cardAuditCount = await prisma.auditEvent.count({ where: { eventType: { in: ['TIMESHEET_V2_CARD_RENAMED', 'TIMESHEET_V2_CARD_TRASHED', 'TIMESHEET_V2_CARD_RESTORED', 'TIMESHEET_V2_CARD_DELETED'] } } });
  check('card actions are audited', cardAuditCount === 5);

  console.log(`timesheet v2 db: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); }).finally(() => prisma.$disconnect());
