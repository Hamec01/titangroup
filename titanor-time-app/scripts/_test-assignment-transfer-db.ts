// Owner 2026-10-15 — quick transfers and re-attributing recorded hours, on real Postgres.
//  A. §3.4 in-place correction: an assignment that starts today and has not been used can be
//     changed "from today" (same row, new site / customer, planned shifts rebuilt, audited); once
//     used it answers 409 ASSIGNMENT_STARTED_IN_USE; "from tomorrow" still uses the normal transfer.
//  B. "Перенести часы другому заказчику": clock-origin and manual draft hours move to another
//     customer of the same site (times unchanged, ClockShiftAdjustment provenance, a historical
//     non-primary Check-In-disabled assignment created only for uncovered days, audit), the month
//     grid follows, submitted weeks are refused, admin + CSRF only.
// Needs a disposable PostgreSQL 16 (DATABASE_URL) with every migration applied.

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { ensureEmployeePeriodCore } from '../lib/periods';
import { materializeClockShift } from '../lib/attendance-materializer';
import { createAssignment } from '../lib/assignments';
import { helsinkiToday } from '../lib/workers';
import { loadCustomerMonthMatrix } from '../lib/reporting/monthly-matrix';
import { dateRuns } from '../lib/move-hours-to-customer';
import { POST as changePOST } from '../app/api/admin/assignments/[assignmentId]/change/route';
import { POST as previewPOST } from '../app/api/admin/assignments/change-preview/route';
import { POST as movePOST } from '../app/api/admin/timesheets-v2/move-hours/route';
import { POST as overlapPOST } from '../app/api/admin/assignments/validate-overlap/route';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 900) : ''); }
}

async function makeSession(roleName: string): Promise<{ token: string; userId: string }> {
  const user = await prisma.user.create({ data: { username: `tr-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { token, userId: user.id };
}
function req(url: string, token: string | null, body: unknown, csrf = true): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrf) headers.set('x-requested-with', 'titanor-time');
  if (token) headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function call(handler: (r: NextRequest, ctx: never) => Promise<Response>, url: string, token: string | null, body: unknown, ctx?: unknown, csrf = true) {
  const res = await handler(req(url, token, body, csrf), ctx as never);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `TR-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function clockShift(employeeId: string, siteId: string, assignmentId: string, start: Date, end: Date) {
  const event = (operationType: 'CHECK_IN' | 'CHECK_OUT', at: Date) => prisma.clockEvent.create({ data: {
    id: randomUUID(), employeeId, operationType, siteId, sourceAssignmentId: assignmentId,
    clientCapturedAt: at, capturedOffline: false, effectiveAt: at, gpsVerification: 'NOT_VERIFIED',
    gpsUnavailableReason: 'POSITION_UNAVAILABLE', processingState: 'NEEDS_REVIEW', channel: 'ONLINE',
    payloadHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), requestId: randomUUID()
  } });
  const checkIn = await event('CHECK_IN', start);
  const checkOut = await event('CHECK_OUT', end);
  const shift = await prisma.clockShift.create({ data: { employeeId, checkInEventId: checkIn.id, checkOutEventId: checkOut.id, siteId, sourceAssignmentId: assignmentId, recordedStartAt: start, recordedEndAt: end } });
  const result = await materializeClockShift(shift.id, randomUUID());
  if (result.kind !== 'MATERIALIZED') throw new Error(`shift did not materialize: ${JSON.stringify(result)}`);
  return shift;
}

async function main() {
  const admin = await makeSession('SUPER_ADMIN');
  const worker = await makeSession('WORKER');
  const site = await prisma.workSite.create({ data: { name: `TR Site ${randomUUID().slice(0, 5)}` } });
  const siteB = await prisma.workSite.create({ data: { name: `TR Site B ${randomUUID().slice(0, 5)}` } });
  const aros = await prisma.workArea.create({ data: { siteId: site.id, name: `Aros ${randomUUID().slice(0, 4)}` } });
  const siris = await prisma.workArea.create({ data: { siteId: site.id, name: `Siris ${randomUUID().slice(0, 4)}` } });
  const offArea = await prisma.workArea.create({ data: { siteId: site.id, name: `Off ${randomUUID().slice(0, 4)}`, active: false } });

  // =============================== A. in-place correction ===============================
  const today = helsinkiToday();
  const todayIso = iso(today);
  const tomorrowIso = iso(new Date(today.getTime() + 86400000));
  const empA = await mkWorker('A');
  await prisma.payrollPeriod.create({ data: { startDate: new Date(today.getTime() - 2 * 86400000), endDate: new Date(today.getTime() + 4 * 86400000), status: 'OPEN', openedByUserId: admin.userId } });
  const created = await createAssignment({ employeeId: empA.id, siteId: site.id, workAreaId: null, templateId: null, validFrom: today, validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  check('A: assignment created today', 'id' in created, created);
  const aId = (created as { id: string }).id;
  const plannedBefore = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: aId } });
  check('A: planned shifts materialised', plannedBefore > 0, plannedBefore);
  const changeUrl = `http://localhost/api/admin/assignments/${aId}/change`;
  const ctx = { params: Promise.resolve({ assignmentId: aId }) };

  const pv = await call(previewPOST as never, 'http://localhost/api/admin/assignments/change-preview', admin.token, { assignmentId: aId, effectiveFrom: todayIso, siteId: site.id, workAreaId: aros.id, isPrimary: true });
  check('A: preview says it is corrected in place, unused', pv.status === 200 && pv.body.correctsInPlace === true && pv.body.usedAlready === false, pv);
  const r1 = await call(changePOST as never, changeUrl, admin.token, { effectiveFrom: todayIso, siteId: site.id, workAreaId: aros.id, isPrimary: true }, ctx);
  check('A: change from today → 200 corrected in place', r1.status === 200 && r1.body.correctedInPlace === true && r1.body.newAssignment.id === aId, r1);
  const rowA = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: aId } });
  check('A: same row now has the new customer, still primary, still from today', rowA.workAreaId === aros.id && rowA.isPrimary && iso(rowA.validFrom) === todayIso && rowA.clockInDisabledAt === null);
  check('A: only one assignment for the worker', (await prisma.siteAssignment.count({ where: { employeeId: empA.id } })) === 1);
  check('A: correction audited + transition', (await prisma.auditEvent.count({ where: { eventType: 'ASSIGNMENT_CORRECTED', entityId: aId } })) === 1 && (await prisma.assignmentTransition.count({ where: { fromAssignmentId: aId, toAssignmentId: aId } })) === 1);

  const r2 = await call(changePOST as never, changeUrl, admin.token, { effectiveFrom: todayIso, siteId: siteB.id, workAreaId: null, isPrimary: true }, ctx);
  const plannedB = await prisma.timesheetDraftPlannedShift.findMany({ where: { sourceAssignmentId: aId }, select: { siteId: true } });
  check('A: site change in place rebuilds planned shifts on the new site', r2.status === 200 && plannedB.length === plannedBefore && plannedB.every((p) => p.siteId === siteB.id), { r2, plannedB });

  check('A: disabled customer refused', (await call(changePOST as never, changeUrl, admin.token, { effectiveFrom: todayIso, siteId: site.id, workAreaId: offArea.id }, ctx)).status === 409);
  check('A: nothing to change → 400', (await call(changePOST as never, changeUrl, admin.token, { effectiveFrom: todayIso, siteId: siteB.id, workAreaId: null }, ctx)).status === 400);

  // Once the worker used it (a Check-In event on it), "from today" is refused with a clear code.
  await prisma.clockEvent.create({ data: { id: randomUUID(), employeeId: empA.id, operationType: 'CHECK_IN', siteId: siteB.id, sourceAssignmentId: aId, clientCapturedAt: new Date(), capturedOffline: false, effectiveAt: new Date(), gpsVerification: 'NOT_VERIFIED', gpsUnavailableReason: 'POSITION_UNAVAILABLE', processingState: 'NEEDS_REVIEW', channel: 'ONLINE', payloadHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), requestId: randomUUID() } });
  const used = await call(changePOST as never, changeUrl, admin.token, { effectiveFrom: todayIso, siteId: site.id, workAreaId: aros.id }, ctx);
  check('A: used assignment → 409 ASSIGNMENT_STARTED_IN_USE', used.status === 409 && used.body?.error?.code === 'ASSIGNMENT_STARTED_IN_USE', used);
  const pv2 = await call(previewPOST as never, 'http://localhost/api/admin/assignments/change-preview', admin.token, { assignmentId: aId, effectiveFrom: todayIso, siteId: site.id, workAreaId: aros.id });
  check('A: preview flags it as used', pv2.body?.usedAlready === true, pv2);
  const tomorrow = await call(changePOST as never, changeUrl, admin.token, { effectiveFrom: tomorrowIso, siteId: site.id, workAreaId: aros.id, isPrimary: true }, ctx);
  check('A: from tomorrow → normal transfer to a new assignment', tomorrow.status === 200 && !tomorrow.body.correctedInPlace && tomorrow.body.newAssignment.id !== aId && tomorrow.body.newAssignment.workAreaId === aros.id, tomorrow);

  // A2. A scheduled, unused transfer is corrected in place and can be brought forward to today —
  // the Kosariev case: Aros removed but dated up to today, no current workplace, a transfer "без заказчика" planned from tomorrow.
  const empS = await mkWorker('S');
  const removed = await prisma.siteAssignment.create({ data: { employeeId: empS.id, siteId: site.id, workAreaId: aros.id, isPrimary: true, validFrom: new Date(today.getTime() - 5 * 86400000), validTo: today, clockInDisabledAt: new Date(), assignedByUserId: admin.userId } });
  const sched = await createAssignment({ employeeId: empS.id, siteId: site.id, workAreaId: null, templateId: null, validFrom: new Date(today.getTime() + 86400000), validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  const schedId = (sched as { id: string }).id;
  const sctx = { params: Promise.resolve({ assignmentId: schedId }) };
  const sUrl = `http://localhost/api/admin/assignments/${schedId}/change`;
  const asPlanned = await call(changePOST as never, sUrl, admin.token, { effectiveFrom: tomorrowIso, siteId: site.id, workAreaId: siris.id, isPrimary: true }, sctx);
  const schedRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: schedId } });
  check('A2: scheduled transfer corrected "as planned" (same row, new customer, same date)', asPlanned.status === 200 && asPlanned.body.correctedInPlace === true && schedRow.workAreaId === siris.id && iso(schedRow.validFrom) === tomorrowIso, asPlanned);
  const forward = await call(changePOST as never, sUrl, admin.token, { effectiveFrom: todayIso, siteId: site.id, workAreaId: siris.id, isPrimary: true }, sctx);
  const fwdRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: schedId } });
  const fwdPlanned = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: schedId, date: today } });
  check('A2: brought forward to today — the worker has a workplace today (planned shift for today too)', forward.status === 200 && iso(fwdRow.validFrom) === todayIso && fwdPlanned === 1, { forward, fwdPlanned });
  const clash = await call(changePOST as never, sUrl, admin.token, { effectiveFrom: todayIso, siteId: site.id, workAreaId: aros.id, isPrimary: true }, sctx);
  check('A2: a start that would overlap another (even removed) assignment of the same customer → 409 ASSIGNMENT_OVERLAP', clash.status === 409 && clash.body?.error?.code === 'ASSIGNMENT_OVERLAP' && (await prisma.siteAssignment.findUniqueOrThrow({ where: { id: schedId } })).workAreaId === siris.id, { clash, removed: removed.id });
  check('A2: past start refused', (await call(changePOST as never, sUrl, admin.token, { effectiveFrom: iso(new Date(today.getTime() - 86400000)), siteId: site.id, workAreaId: null }, sctx)).status === 400);

  // A3. Kosariev on prod (2026-10-15): every assignment removed, Aros Marine removed "for today".
  // "Add workplace: Aros from today" must bring that Aros assignment back, not fail on EX-02.
  const day0 = (n: number) => new Date(today.getTime() + n * 86400000);
  const empK = await mkWorker('K');
  await prisma.siteAssignment.create({ data: { employeeId: empK.id, siteId: site.id, workAreaId: null, isPrimary: true, validFrom: day0(-2), validTo: day0(-1), clockInDisabledAt: new Date(), endedReason: 'PROJECT_DONE', assignedByUserId: admin.userId } });
  const arosRemoved = await prisma.siteAssignment.create({ data: { employeeId: empK.id, siteId: site.id, workAreaId: aros.id, isPrimary: true, validFrom: today, validTo: today, clockInDisabledAt: new Date(), endedReason: 'TRANSFER', assignedByUserId: admin.userId } });
  await prisma.siteAssignment.create({ data: { employeeId: empK.id, siteId: site.id, workAreaId: null, isPrimary: false, validFrom: day0(1), validTo: day0(1), clockInDisabledAt: new Date(), endedReason: 'нету', assignedByUserId: admin.userId } });
  const pre = await call(overlapPOST as never, 'http://localhost/api/admin/assignments/validate-overlap', admin.token, { employeeId: empK.id, siteId: site.id, workAreaId: aros.id, validFrom: todayIso });
  check('A3: pre-check does not block — it will bring the removed Aros assignment back', pre.status === 200 && pre.body.hasOverlap === false && pre.body.reactivatesAssignmentId === arosRemoved.id, pre);
  const tpl = await prisma.workScheduleTemplate.create({ data: { name: `A3 tpl ${randomUUID().slice(0, 4)}`, versions: { create: { versionNumber: 1, createdByUserId: admin.userId, effectiveFrom: new Date('2020-01-01T00:00:00.000Z'), days: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isWorkingDay: weekday < 6, plannedStartTime: weekday < 6 ? new Date(Date.UTC(1970, 0, 1, 7)) : null, plannedEndTime: weekday < 6 ? new Date(Date.UTC(1970, 0, 1, 18)) : null, plannedBreakMinutes: weekday < 6 ? 30 : 0 })) } } } }, include: { versions: true } });
  const restored = await createAssignment({ employeeId: empK.id, siteId: site.id, workAreaId: aros.id, templateId: tpl.id, validFrom: today, validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  const backRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: arosRemoved.id } });
  check('A3: the removed Aros assignment is back — same row, from today, open-ended, Check-In enabled, primary, new schedule', 'id' in restored && restored.id === arosRemoved.id && iso(backRow.validFrom) === todayIso && backRow.validTo === null && backRow.clockInDisabledAt === null && backRow.isPrimary && backRow.endedReason === null && backRow.templateVersionId === tpl.versions[0].id, { restored, backRow });
  check('A3: no extra assignment row, planned shift for today exists', (await prisma.siteAssignment.count({ where: { employeeId: empK.id } })) === 3 && (await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: arosRemoved.id, date: today } })) === 1);
  check('A3: audited ASSIGNMENT_REACTIVATED + transition', (await prisma.auditEvent.count({ where: { eventType: 'ASSIGNMENT_REACTIVATED', entityId: arosRemoved.id } })) === 1 && (await prisma.assignmentTransition.count({ where: { fromAssignmentId: arosRemoved.id, toAssignmentId: arosRemoved.id } })) === 1);
  const again2 = await createAssignment({ employeeId: empK.id, siteId: site.id, workAreaId: aros.id, templateId: null, validFrom: today, validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  // Bringing back without choosing a schedule keeps the schedule the assignment had.
  const empT = await mkWorker('T');
  const arosT = await prisma.siteAssignment.create({ data: { employeeId: empT.id, siteId: site.id, workAreaId: aros.id, templateVersionId: tpl.versions[0].id, isPrimary: true, validFrom: today, validTo: today, clockInDisabledAt: new Date(), assignedByUserId: admin.userId } });
  await createAssignment({ employeeId: empT.id, siteId: site.id, workAreaId: aros.id, templateId: null, validFrom: today, validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  check('A3: no schedule chosen → the brought-back assignment keeps its schedule', (await prisma.siteAssignment.findUniqueOrThrow({ where: { id: arosT.id } })).templateVersionId === tpl.versions[0].id);
  check('A3: a second Aros workplace on the same dates is still refused (now it is live)', 'code' in again2 && again2.code === 'ASSIGNMENT_OVERLAP', again2);

  // Transfer of a worker WITH a current place to a customer that only has a removed assignment then.
  const empL = await mkWorker('L');
  const curL = await createAssignment({ employeeId: empL.id, siteId: site.id, workAreaId: null, templateId: null, validFrom: day0(-30), validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  const arosL = await prisma.siteAssignment.create({ data: { employeeId: empL.id, siteId: site.id, workAreaId: aros.id, isPrimary: false, validFrom: today, validTo: today, clockInDisabledAt: new Date(), assignedByUserId: admin.userId } });
  const curLId = (curL as { id: string }).id;
  const tr = await call(changePOST as never, `http://localhost/api/admin/assignments/${curLId}/change`, admin.token, { effectiveFrom: todayIso, siteId: site.id, workAreaId: aros.id, isPrimary: true }, { params: Promise.resolve({ assignmentId: curLId }) });
  const arosLRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: arosL.id } });
  check('A3: transfer today to Aros reuses the removed Aros row (no EX-02 409)', tr.status === 200 && tr.body.newAssignment.id === arosL.id && arosLRow.clockInDisabledAt === null && arosLRow.validTo === null && arosLRow.isPrimary, { tr, arosLRow });
  check('A3: the old place is closed by the transfer', (await prisma.siteAssignment.findUniqueOrThrow({ where: { id: curLId } })).clockInDisabledAt !== null);

  // Two removed rows of the same customer overlapping → still a clear refusal.
  const empM = await mkWorker('M');
  await prisma.siteAssignment.create({ data: { employeeId: empM.id, siteId: site.id, workAreaId: aros.id, isPrimary: false, validFrom: today, validTo: today, clockInDisabledAt: new Date(), assignedByUserId: admin.userId } });
  await prisma.siteAssignment.create({ data: { employeeId: empM.id, siteId: site.id, workAreaId: aros.id, isPrimary: false, validFrom: day0(2), validTo: day0(2), clockInDisabledAt: new Date(), assignedByUserId: admin.userId } });
  const two = await createAssignment({ employeeId: empM.id, siteId: site.id, workAreaId: aros.id, templateId: null, validFrom: today, validTo: null, isPrimary: true, assignedByUserId: admin.userId, requestId: randomUUID() });
  check('A3: two removed rows in the way → ASSIGNMENT_OVERLAP, nothing changed', 'code' in two && two.code === 'ASSIGNMENT_OVERLAP' && (await prisma.siteAssignment.count({ where: { employeeId: empM.id, clockInDisabledAt: null } })) === 0, two);

  // =============================== B. move recorded hours ===============================
  check('dateRuns groups consecutive days', JSON.stringify(dateRuns(['2037-01-14', '2037-01-13', '2037-01-16'])) === JSON.stringify([['2037-01-13', '2037-01-14'], ['2037-01-16', '2037-01-16']]));
  const emp = await mkWorker('Kosariev');
  const noneAsg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: null, isPrimary: true, validFrom: day('2037-01-01'), validTo: day('2037-01-14'), assignedByUserId: admin.userId } });
  await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, workAreaId: aros.id, isPrimary: true, validFrom: day('2037-01-15'), validTo: null, assignedByUserId: admin.userId } });
  const period = await prisma.payrollPeriod.create({ data: { startDate: day('2037-01-12'), endDate: day('2037-01-18'), status: 'OPEN', openedByUserId: admin.userId } });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId: emp.id, startDate: period.startDate, endDate: period.endDate });
  });
  // 13.01 and 14.01 clocked "без заказчика" at odd minutes (07:04–12:21 / 06:53–17:38 local, UTC+2): the
  // reported (draft) times are rounded, the raw fragment times are not — a move must keep the ROUNDED ones.
  // Plus a manual segment on 14.01.
  await clockShift(emp.id, site.id, noneAsg.id, new Date('2037-01-13T05:04:00Z'), new Date('2037-01-13T10:21:00Z'));
  await clockShift(emp.id, site.id, noneAsg.id, new Date('2037-01-14T04:53:00Z'), new Date('2037-01-14T15:38:00Z'));
  const draft = await prisma.timesheetDraft.findFirstOrThrow({ where: { employeeId: emp.id } });
  const day14 = await prisma.timesheetDraftDay.findFirstOrThrow({ where: { draftId: draft.id, date: day('2037-01-14') } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: day14.id, draftId: draft.id, employeeId: emp.id, date: day('2037-01-14'), startAt: new Date('2037-01-14T16:00:00Z'), endAt: new Date('2037-01-14T17:00:00Z'), siteId: site.id, workAreaId: null, sourceAssignmentId: noneAsg.id } });
  const before = await prisma.timesheetDraftSegment.findMany({ where: { employeeId: emp.id }, orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true } });
  check('B: fixture has 3 segments without customer', before.length === 3 && (await prisma.timesheetDraftSegment.count({ where: { employeeId: emp.id, workAreaId: null } })) === 3);

  const moveUrl = 'http://localhost/api/admin/timesheets-v2/move-hours';
  const moveBody = { employeeId: emp.id, siteId: site.id, fromWorkArea: 'none', toWorkArea: aros.id, dates: ['2037-01-13', '2037-01-14'] };
  check('B: anonymous → 401', (await call(movePOST as never, moveUrl, null, moveBody)).status === 401);
  check('B: no CSRF → 403', (await call(movePOST as never, moveUrl, admin.token, moveBody, undefined, false)).status === 403);
  check('B: worker → 403', (await call(movePOST as never, moveUrl, worker.token, moveBody)).status === 403);
  check('B: same customer → 400', (await call(movePOST as never, moveUrl, admin.token, { ...moveBody, toWorkArea: 'none' })).status === 400);
  check('B: customer of another site → 404', (await call(movePOST as never, moveUrl, admin.token, { ...moveBody, toWorkArea: (await prisma.workArea.create({ data: { siteId: siteB.id, name: 'B-area' } })).id })).status === 404);
  check('B: disabled customer → 409', (await call(movePOST as never, moveUrl, admin.token, { ...moveBody, toWorkArea: offArea.id })).status === 409);

  const preview = await call(movePOST as never, moveUrl, admin.token, { ...moveBody, preview: true });
  const beforeGross = before.reduce((t, b) => t + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000), 0);
  const rawFragments = await prisma.clockShiftFragment.findMany({ where: { employeeId: emp.id }, select: { recordedStartAt: true } });
  check('B: fixture — reported times are rounded, unlike the raw clock times', before.some((b) => !rawFragments.some((f) => f.recordedStartAt.getTime() === b.startAt.getTime())), { before, rawFragments });
  check('B: preview counts 3 segments with their gross minutes, nothing submitted', preview.status === 200 && preview.body.segmentCount === 3 && preview.body.grossMinutes === beforeGross && preview.body.submittedDates.length === 0, preview);
  check('B: preview wrote nothing', (await prisma.timesheetDraftSegment.count({ where: { employeeId: emp.id, workAreaId: aros.id } })) === 0);

  const moved = await call(movePOST as never, moveUrl, admin.token, moveBody);
  check('B: move → 200, 3 segments, one historical assignment', moved.status === 200 && moved.body.movedSegments === 3 && moved.body.createdAssignmentIds.length === 1, moved);
  const hist = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: moved.body.createdAssignmentIds[0] } });
  check('B: historical assignment = Aros, exactly 13–14.01, not primary, no Check-In', hist.workAreaId === aros.id && iso(hist.validFrom) === '2037-01-13' && iso(hist.validTo!) === '2037-01-14' && !hist.isPrimary && hist.clockInDisabledAt !== null, hist);
  const after = await prisma.timesheetDraftSegment.findMany({ where: { employeeId: emp.id }, orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, workAreaId: true, sourceAssignmentId: true } });
  check('B: every segment now Aros on the historical assignment', after.every((s) => s.workAreaId === aros.id && s.sourceAssignmentId === hist.id), after);
  check('B: reported (rounded) times unchanged', after.every((s, i) => s.id === before[i].id && s.startAt.getTime() === before[i].startAt.getTime() && s.endAt.getTime() === before[i].endAt.getTime()));
  const adjustments = await prisma.clockShiftAdjustment.findMany({ where: { employeeId: emp.id } });
  check('B: clock-origin moves recorded as ClockShiftAdjustment', adjustments.length === 2 && adjustments.every((a) => a.afterWorkAreaId === aros.id && a.afterSourceAssignmentId === hist.id), adjustments);
  const audit = await prisma.auditEvent.findFirst({ where: { eventType: 'HOURS_MOVED_TO_CUSTOMER', entityId: emp.id } });
  check('B: audited with dates and segments', !!audit && JSON.stringify(audit.afterValue).includes('2037-01-13') && (audit.afterValue as { segments: unknown[] }).segments.length === 3);
  check('B: original assignments untouched', (await prisma.siteAssignment.findUniqueOrThrow({ where: { id: noneAsg.id } })).validTo?.toISOString().slice(0, 10) === '2037-01-14');

  const actor = { userId: admin.userId, employeeId: null };
  const arosGrid = await loadCustomerMonthMatrix('2037-01', { siteId: site.id, workAreaId: aros.id }, actor, '2037-02-01');
  const noneGrid = await loadCustomerMonthMatrix('2037-01', { siteId: site.id, workAreaId: null }, actor, '2037-02-01');
  const arosRow = arosGrid.ok ? arosGrid.matrix.rows.find((r) => r.employeeId === emp.id) : null;
  const noneRow = noneGrid.ok ? noneGrid.matrix.rows.find((r) => r.employeeId === emp.id) : null;
  check('B: Табель v2 — hours now under Aros on 13 and 14', !!arosRow && arosRow.cells[12].recordedMinutes > 0 && arosRow.cells[13].recordedMinutes > 0, arosRow?.cells.slice(12, 14));
  check('B: Табель v2 — nothing left without customer on 13 and 14', !noneRow || (noneRow.cells[12].recordedMinutes === 0 && noneRow.cells[13].recordedMinutes === 0), noneRow?.cells.slice(12, 14));

  const again = await call(movePOST as never, moveUrl, admin.token, moveBody);
  check('B: moving again → 409 NOTHING_TO_MOVE', again.status === 409 && again.body?.error?.code === 'NOTHING_TO_MOVE', again);
  const back = await call(movePOST as never, moveUrl, admin.token, { ...moveBody, fromWorkArea: aros.id, toWorkArea: 'none', dates: ['2037-01-13'] });
  check('B: move back reuses the existing coverage (no new assignment)', back.status === 200 && back.body.movedSegments === 1 && back.body.createdAssignmentIds.length === 0, back);
  check('B: move to a third customer works too', (await call(movePOST as never, moveUrl, admin.token, { ...moveBody, fromWorkArea: aros.id, toWorkArea: siris.id, dates: ['2037-01-14'] })).body?.movedSegments === 2);

  // Submitted weeks are never rewritten silently.
  await prisma.timesheet.updateMany({ where: { employeeId: emp.id, periodId: period.id }, data: { status: 'SUBMITTED' } });
  const refused = await call(movePOST as never, moveUrl, admin.token, { ...moveBody, fromWorkArea: siris.id, toWorkArea: aros.id, dates: ['2037-01-14'] });
  check('B: submitted week → 409 TIMESHEET_SUBMITTED with the dates', refused.status === 409 && refused.body?.error?.code === 'TIMESHEET_SUBMITTED' && refused.body?.error?.dates?.[0] === '2037-01-14', refused);
  check('B: refused move changed nothing', (await prisma.timesheetDraftSegment.count({ where: { employeeId: emp.id, workAreaId: siris.id } })) === 2);

  console.log(`assignment transfer db: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); }).finally(() => prisma.$disconnect());
