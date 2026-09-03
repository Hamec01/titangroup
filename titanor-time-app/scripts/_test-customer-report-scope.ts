// CUSTOMER_REPORT_SCOPE_PICKER_RU.md §3/§8 — the "site -> workers" scope model for
// /admin/reports/customer: parseCustomerReportScope (lenient URL parse + explicit ALL/PICK modes),
// serializeScopeToExportParams (maps ALL/PICK back onto the existing export API, absent list = all),
// resolveCustomerScopeWorkers (assigned OR canonical hours, historical hours never hidden, one row
// per worker). db lane — needs a disposable PostgreSQL 16 with all migrations.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { SubmissionSource } from '@prisma/client';
import {
  parseCustomerReportScope,
  serializeScopeToExportParams,
  resolveCustomerScopeWorkers,
  type CustomerReportScope
} from '../lib/reporting/customer-report-scope';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const uuid = () => randomUUID();
const ASG_START = new Date('2020-01-01T00:00:00.000Z');
const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);

// ------------------------------------------------------------------------------------------
// parseCustomerReportScope
// ------------------------------------------------------------------------------------------
{
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  let s = parseCustomerReportScope({});
  check('parse: empty -> site-first NONE / NONE (never "all")', s.scopeBasis === 'SITES' && s.siteMode === 'NONE' && s.workerMode === 'NONE' && s.dateFrom === null, s);

  s = parseCustomerReportScope({ scopeBy: 'workers', workerIds: A });
  check('parse: scopeBy=workers -> direct workers + all sites', s.scopeBasis === 'WORKERS' && s.siteMode === 'ALL' && s.workerMode === 'PICK', s);

  s = parseCustomerReportScope({ sites: 'all', workers: 'all', dateFrom: '2026-01-01', dateTo: '2026-01-31' });
  check('parse: sites=all workers=all -> ALL / ALL', s.siteMode === 'ALL' && s.workerMode === 'ALL' && s.siteIds.length === 0, s);

  s = parseCustomerReportScope({ siteIds: [A, B, 'garbage'], workerIds: A, sites: 'all' });
  check('parse: siteIds present beats sites=all; garbage dropped', s.siteMode === 'PICK' && s.siteIds.length === 2, s);
  check('parse: workerIds -> PICK', s.workerMode === 'PICK' && s.workerIds.length === 1, s);

  s = parseCustomerReportScope({ workers: 'all', wx: `${A},${B}` });
  check('parse: workers=all + wx -> ALL with 2 excludes', s.workerMode === 'ALL' && s.workerExcludeIds.length === 2, s);

  s = parseCustomerReportScope({ workerIds: A, wx: B });
  check('parse: wx ignored when not workers=all', s.workerMode === 'PICK' && s.workerExcludeIds.length === 0, s);

  s = parseCustomerReportScope({ dateFrom: 'not-a-date', dateTo: '2026/01/31' });
  check('parse: wrong-shape dates -> null', s.dateFrom === null && s.dateTo === null, s);

  s = parseCustomerReportScope({ customer: 'x'.repeat(500) });
  check('parse: customer capped at 200', s.customer.length === 200);
}

// ------------------------------------------------------------------------------------------
// serializeScopeToExportParams — the 5 rows of the §4 mapping table
// ------------------------------------------------------------------------------------------
{
  const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const S2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const W1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const W3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
  const base = { dateFrom: '2026-01-01', dateTo: '2026-01-31', customer: 'Meyer', projectReference: '' };
  const scopeIds = [W1, W2, W3];

  const mk = (o: Partial<CustomerReportScope>): CustomerReportScope => ({ ...base, scopeBasis: 'SITES', customer: base.customer, projectReference: '', siteMode: 'ALL', siteIds: [], workerMode: 'ALL', workerIds: [], workerExcludeIds: [], ...o });

  let p = serializeScopeToExportParams(mk({ siteMode: 'ALL', workerMode: 'ALL' }), scopeIds);
  check('serialize: ALL/ALL -> no siteIds, no employeeIds, customer kept', !!p && !p.has('siteIds') && !p.has('employeeIds') && p.get('customer') === 'Meyer', p?.toString());

  p = serializeScopeToExportParams(mk({ siteMode: 'PICK', siteIds: [S1, S2], workerMode: 'ALL' }), scopeIds);
  check('serialize: PICK sites / ALL workers -> siteIds set, employeeIds omitted', !!p && p.getAll('siteIds').length === 2 && !p.has('employeeIds'), p?.toString());

  p = serializeScopeToExportParams(mk({ siteMode: 'PICK', siteIds: [S1], workerMode: 'PICK', workerIds: [W1, W2] }), scopeIds);
  check('serialize: PICK / PICK -> both lists', !!p && p.getAll('siteIds').length === 1 && p.getAll('employeeIds').sort().join() === [W1, W2].sort().join(), p?.toString());

  p = serializeScopeToExportParams(mk({ siteMode: 'ALL', workerMode: 'ALL', workerExcludeIds: [W2] }), scopeIds);
  check('serialize: ALL minus 1 -> employeeIds = scope minus exclude', !!p && p.getAll('employeeIds').sort().join() === [W1, W3].sort().join(), p?.toString());

  p = serializeScopeToExportParams(mk({ siteMode: 'ALL', workerMode: 'NONE' }), scopeIds);
  check('serialize: workerMode NONE -> null (report blocked)', p === null);

  p = serializeScopeToExportParams(mk({ siteMode: 'PICK', siteIds: [], workerMode: 'ALL' }), scopeIds);
  check('serialize: PICK sites but empty list -> null', p === null);

  p = serializeScopeToExportParams(mk({ dateFrom: null as unknown as string, workerMode: 'ALL' }), scopeIds);
  check('serialize: missing date -> null', p === null);

  p = serializeScopeToExportParams(mk({ siteMode: 'ALL', workerMode: 'ALL', workerExcludeIds: scopeIds }), scopeIds);
  check('serialize: everyone excluded -> null', p === null);
}

// ------------------------------------------------------------------------------------------
// resolveCustomerScopeWorkers — fixture
// ------------------------------------------------------------------------------------------
async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `SC ${tag} ${uuid().slice(0, 4)}` } });
}
async function mkEmployee(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `SC-${tag}-${uuid().slice(0, 6)}`, firstName: tag, lastName: `Z${tag}` } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  return emp;
}
// Migration 100 (ex_site_assignment_one_primary_per_period) forbids two overlapping isPrimary rows
// for one worker. The scope resolver reads assignments/segments regardless of primary-ness, so a
// worker's 2nd concurrent-site assignment is created non-primary.
async function mkAssignment(employeeId: string, siteId: string, adminId: string, validFrom: Date, validTo: Date | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, isPrimary, validFrom, validTo, assignedByUserId: adminId } });
}
/** A submitted-then-final timesheet with one WORK day (07:00–15:00) -> a real WorkSegment on `site`. */
async function mkWorkedTimesheet(adminId: string, employeeId: string, siteId: string, assignmentId: string, dayBase: Date) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: dayBase, endDate: new Date(dayBase.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: dayBase, siteId, sourceAssignmentId: assignmentId, plannedStartAt: at(dayBase, 7), plannedEndAt: at(dayBase, 15), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: dayBase, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: dayBase, startAt: at(dayBase, 7), endAt: at(dayBase, 15), siteId, sourceAssignmentId: assignmentId } });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, ts.id, adminId, uuid(), SubmissionSource.MANUAL);
  });
  await prisma.timesheet.update({ where: { id: ts.id }, data: { status: 'FINAL_APPROVED' } });
  return { periodId: period.id, dayBase };
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = (await prisma.user.create({ data: { username: `scp_${uuid().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } })).id;

  const siteA = await mkSite('A');
  const siteB = await mkSite('B');
  const dayBase = new Date(Date.UTC(2098, 5, 1));
  const from = '2098-06-01';
  const to = '2098-06-07';

  // W1 — assigned to A (open) + has hours on A
  const w1 = await mkEmployee('W1');
  const a1 = await mkAssignment(w1.id, siteA.id, admin, ASG_START, null);
  await mkWorkedTimesheet(admin, w1.id, siteA.id, a1.id, dayBase);

  // W2 — assigned to B (open) only, NO hours anywhere
  const w2 = await mkEmployee('W2');
  await mkAssignment(w2.id, siteB.id, admin, ASG_START, null);

  // W3 — on BOTH: assigned to A (open, no hours there) + has hours on B
  const w3 = await mkEmployee('W3');
  await mkAssignment(w3.id, siteA.id, admin, ASG_START, null);
  const a3b = await mkAssignment(w3.id, siteB.id, admin, ASG_START, null, false); // 2nd concurrent site — non-primary
  await mkWorkedTimesheet(admin, w3.id, siteB.id, a3b.id, dayBase);

  // W4 — HISTORICAL: assignment to A ends mid-range (validTo 2098-06-04 < dateTo 2098-06-07), worked
  //      on 2098-06-01 (inside the assignment window). A naive "assignment active on dateTo" filter
  //      would drop W4; the overlap rule keeps them (ТЗ §3 — historical hours are not hidden).
  const w4 = await mkEmployee('W4');
  const a4 = await mkAssignment(w4.id, siteA.id, admin, ASG_START, new Date('2098-06-04T00:00:00.000Z'));
  await mkWorkedTimesheet(admin, w4.id, siteA.id, a4.id, dayBase);

  // W5 — employed in the range, but has no site assignment and no hours yet. It must be available
  // in the direct worker picker, while correctly staying absent from every site-first list.
  const w5 = await mkEmployee('W5');

  // ---- scenario 1: one site (A) -> W1 (asg+hrs), W3 (asg only), W4 (asg-ends-mid-range + hrs) — not W2
  {
    const r = await resolveCustomerScopeWorkers({ siteMode: 'PICK', siteIds: [siteA.id], dateFrom: from, dateTo: to });
    const ids = new Set(r.map((w) => w.employeeId));
    check('1: site A -> W1, W3, W4 (not W2 who is on B only)', ids.has(w1.id) && ids.has(w3.id) && ids.has(w4.id) && !ids.has(w2.id), [...ids]);
    check('1: rows sorted by lastName then firstName', r.map((w) => `${w.lastName} ${w.firstName}`).join('|') === [...r].map((w) => `${w.lastName} ${w.firstName}`).sort((x, y) => x.localeCompare(y)).join('|'), r.map((w) => w.lastName));
  }

  // ---- scenario 4: worker whose A-assignment ended mid-range still shows via hours in the range
  {
    const r = await resolveCustomerScopeWorkers({ siteMode: 'PICK', siteIds: [siteA.id], dateFrom: from, dateTo: to });
    const w4row = r.find((w) => w.employeeId === w4.id);
    check('4: W4 (assignment ends 2098-06-04, range ends 2098-06-07) still in scope for A, hasHours', !!w4row && w4row.hasHours === true, w4row);
  }

  // ---- scenario 2 + 3: several sites -> union, no dups, worker-on-both once with both sites
  {
    const r = await resolveCustomerScopeWorkers({ siteMode: 'PICK', siteIds: [siteA.id, siteB.id], dateFrom: from, dateTo: to });
    const ids = r.map((w) => w.employeeId);
    check('2: A+B -> W1,W2,W3,W4 union, no dups', new Set(ids).size === ids.length && [w1.id, w2.id, w3.id, w4.id].every((id) => ids.includes(id)), ids);
    const w3row = r.find((w) => w.employeeId === w3.id)!;
    check('3: W3 appears once, with BOTH sites listed', w3row && w3row.siteIds.length === 2 && w3row.siteIds.includes(siteA.id) && w3row.siteIds.includes(siteB.id), w3row);
    check('3: W3 reason = assigned (A) + hasHours (B)', w3row.assigned && w3row.hasHours, w3row);
  }

  // ---- scenario 8 (server half): changing the site set changes the worker set
  {
    const onlyB = await resolveCustomerScopeWorkers({ siteMode: 'PICK', siteIds: [siteB.id], dateFrom: from, dateTo: to });
    const bIds = new Set(onlyB.map((w) => w.employeeId));
    check('8: site B -> W2 (assigned) + W3 (hours), NOT W1/W4', bIds.has(w2.id) && bIds.has(w3.id) && !bIds.has(w1.id) && !bIds.has(w4.id), [...bIds]);
  }

  // ---- ALL sites mode: every worker with an assignment or hours anywhere in range
  {
    const r = await resolveCustomerScopeWorkers({ siteMode: 'ALL', siteIds: [], dateFrom: from, dateTo: to });
    const ids = new Set(r.map((w) => w.employeeId));
    check('ALL: W1..W4 all present, siteIds empty in ALL mode', [w1.id, w2.id, w3.id, w4.id].every((id) => ids.has(id)) && r.every((w) => w.siteIds.length === 0), r.map((w) => w.siteIds.length));
  }

  // ---- direct worker mode: independent of assignment; site history is still shown ---------
  {
    const r = await resolveCustomerScopeWorkers({ scopeBasis: 'WORKERS', siteMode: 'ALL', siteIds: [], dateFrom: from, dateTo: to });
    const ids = new Set(r.map((w) => w.employeeId));
    check('direct: employed worker without a site is present', ids.has(w5.id), [...ids]);
    const w5row = r.find((w) => w.employeeId === w5.id);
    check('direct: unassigned worker has an empty site list and no false status', !!w5row && w5row.siteIds.length === 0 && !w5row.assigned && !w5row.hasHours, w5row);
    const w3row = r.find((w) => w.employeeId === w3.id);
    check('direct: worker who changed/worked across sites shows both sites', !!w3row && w3row.siteIds.includes(siteA.id) && w3row.siteIds.includes(siteB.id), w3row);
  }

  // ---- range with no periods & after every assignment ended -> W4 gone (ended 06-04), W1/W3 stay (open asg)
  {
    const r = await resolveCustomerScopeWorkers({ siteMode: 'PICK', siteIds: [siteA.id], dateFrom: '2098-07-01', dateTo: '2098-07-07' });
    check('post-range: nobody has hours; W4 gone (assignment ended), W1 stays via open assignment', r.every((w) => !w.hasHours) && r.some((w) => w.employeeId === w1.id) && !r.some((w) => w.employeeId === w4.id), r);
  }

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
