// UT7-B / UT7-B-fixup — real-Postgres coverage for reconciliation embedded in
// submitWorkerTimesheetCore (lib/reporting/customer-hours-reconciliation.ts), the read-only diff
// endpoint (GET /api/admin/time-ledger/approval-diff), and the historical-approvals endpoint
// (GET /api/admin/time-ledger/historical-approvals): fast path with no approvals, unchanged resubmit
// (zero writes/audit), a changed day/break/customer/week, a removed slice, a note-only edit (no
// fingerprint change), reverting to a superseded fingerprint (no auto-restore), all three submit
// paths (manual, auto, correction), a parallel submit+approve race, a source-read-failure deferral
// that must never be mistaken for a mass slice removal (fixup #1), an unrelated genuine DB error
// that must still not be swallowed (fixup #3), the diff endpoint's four states plus its strict
// unknown/repeated query-parameter rejection (fixup #4), and the historical-approvals endpoint
// surfacing removed/unreadable rows while never reporting an ordinary unchanged approval (fixup #2).
// Needs a disposable PostgreSQL 16 (DATABASE_URL) with every migration applied and
// CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY + IDEMPOTENCY_ENCRYPTION_KEY set.

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, reopenWorkerTimesheetForEdits } from '../lib/worker-timesheets';
import { requestCorrection, openCorrectionDraft, patchCorrectionDraftDay, submitCorrection, applyInReviewCorrection } from '../lib/corrections';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as previewPOST } from '../app/api/admin/time-ledger/approval-preview/route';
import { POST as commitPOST } from '../app/api/admin/time-ledger/approvals/route';
import { GET as diffGET } from '../app/api/admin/time-ledger/approval-diff/route';
import { GET as historicalGET } from '../app/api/admin/time-ledger/historical-approvals/route';
import { reconcileCustomerHoursApprovalsForTimesheet } from '../lib/reporting/customer-hours-reconciliation';
import { loadHistoricalApprovalIssues } from '../lib/reporting/customer-hours-history';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 800) : '');
  }
}

let adminUserId = '';

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `RCL-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `RCL-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `RCL-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2035, 0, 1) + weekSlot * 14 * 86400000); // 2035-01-01 is a Monday
  weekSlot += 1;
  return d;
}

async function buildDraft(employeeId: string, siteId: string, workAreaId: string | null, monday: Date, endDate?: Date) {
  // Deliberately kept OPEN (never LOCKED) — several scenarios in this file need
  // reopenWorkerTimesheetForEdits to actually work, which requires period.status === 'OPEN' and
  // "now" before its own edit-window cutoff (both are true here: nextMonday() picks dates far in the
  // future, and neither submit function itself requires LOCKED).
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: endDate ?? new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  const asg = await mkAssignment(employeeId, siteId, workAreaId);
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: monday, siteId, sourceAssignmentId: asg.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 15), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: monday, startAt: at(monday, 7), endAt: at(monday, 15), siteId, workAreaId, sourceAssignmentId: asg.id } });
  return { period, ts, draft, asg };
}
async function submitDraft(employeeId: string, timesheetId: string, source: SubmissionSource = SubmissionSource.MANUAL) {
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
function itemKeyOf(f: { timesheetId: string; site: { id: string }; workArea: { id: string } | null; monday: Date }) {
  return { timesheetId: f.timesheetId, siteId: f.site.id, workAreaId: f.workArea?.id ?? null, weekStart: isoDate(f.monday) };
}

/** Asserts the reopen actually happened (status -> DRAFT, draft repopulated) rather than silently
 *  no-op'ing on a precondition miss (e.g. a LOCKED period) — a real reopen failure must fail the
 *  test loudly here, not surface later as a confusing "fingerprint didn't change as expected". */
async function mustReopen(employeeId: string, timesheetId: string): Promise<void> {
  const result = await reopenWorkerTimesheetForEdits(employeeId, timesheetId, adminUserId, randomUUID());
  if (result.code !== 'REOPENED') {
    throw new Error(`reopenWorkerTimesheetForEdits failed unexpectedly: ${JSON.stringify(result)}`);
  }
}

async function makeSession(roleName: string, employeeId: string | null = null): Promise<string> {
  const user = await prisma.user.create({ data: { username: `rcl-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return token;
}

function jsonReq(url: string, sessionToken: string | null, body: unknown, extraHeaders: Record<string, string> = {}, csrf = true, method: 'GET' | 'POST' = 'POST'): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrf) headers.set('x-requested-with', 'titanor-time');
  if (sessionToken) headers.set('cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new NextRequest(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) });
}
async function previewJson(sessionToken: string | null, itemKey: unknown, expectedFingerprint: string): Promise<{ status: number; body: any }> {
  const res = await previewPOST(jsonReq('http://localhost/api/admin/time-ledger/approval-preview', sessionToken, { itemKey, expectedFingerprint }));
  return { status: res.status, body: await res.json() };
}
async function commitJson(sessionToken: string | null, itemKey: unknown, expectedFingerprint: string, confirmationToken: string, idempotencyKey = randomUUID()): Promise<{ status: number; body: any }> {
  const res = await commitPOST(jsonReq('http://localhost/api/admin/time-ledger/approvals', sessionToken, { itemKey, expectedFingerprint, confirmationToken }, { 'idempotency-key': idempotencyKey }));
  return { status: res.status, body: await res.json() };
}
async function realPreview(sessionToken: string, itemKey: unknown): Promise<{ status: number; body: any }> {
  const bootstrap = await previewJson(sessionToken, itemKey, '0'.repeat(64));
  if (bootstrap.status !== 200) return bootstrap;
  return previewJson(sessionToken, itemKey, bootstrap.body.currentFingerprint);
}
async function approveWeek(sessionToken: string, itemKey: unknown): Promise<{ status: number; body: any }> {
  const preview = await realPreview(sessionToken, itemKey);
  if (preview.status !== 200 || !preview.body.confirmationToken) return preview;
  return commitJson(sessionToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
}
async function diffJson(sessionToken: string | null, itemKey: { timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string }): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams({ timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, weekStart: itemKey.weekStart });
  if (itemKey.workAreaId) qs.set('workAreaId', itemKey.workAreaId);
  const res = await diffGET(jsonReq(`http://localhost/api/admin/time-ledger/approval-diff?${qs.toString()}`, sessionToken, null, {}, false, 'GET'));
  return { status: res.status, body: await res.json() };
}
async function historicalJson(
  sessionToken: string | null,
  filters: { siteId?: string; workAreaId?: string | 'none'; status?: string; onlyIssues?: boolean; onlyChangedAfterApproval?: boolean }
): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams({ allTime: 'true' });
  if (filters.siteId) qs.set('siteId', filters.siteId);
  if (filters.workAreaId) qs.set('workAreaId', filters.workAreaId);
  if (filters.status) qs.set('status', filters.status);
  if (filters.onlyIssues) qs.set('onlyIssues', 'true');
  if (filters.onlyChangedAfterApproval) qs.set('onlyChangedAfterApproval', 'true');
  const res = await historicalGET(jsonReq(`http://localhost/api/admin/time-ledger/historical-approvals?${qs.toString()}`, sessionToken, null, {}, false, 'GET'));
  return { status: res.status, body: await res.json() };
}

async function currentItem(timesheetId: string, siteId: string, workAreaId: string | null, weekStart: string) {
  return prisma.customerHoursApprovalItem.findFirst({ where: { timesheetId, siteId, workAreaId, weekStart: new Date(`${weekStart}T00:00:00.000Z`), approvalState: 'CURRENT' } });
}
async function allItemsFor(timesheetId: string, siteId: string, workAreaId: string | null, weekStart: string) {
  return prisma.customerHoursApprovalItem.findMany({ where: { timesheetId, siteId, workAreaId, weekStart: new Date(`${weekStart}T00:00:00.000Z`) }, orderBy: { createdAt: 'asc' } });
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `rcl-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;
  const adminToken = await makeSession('ADMIN');

  // ===============================================================================================
  // 1. Fast path — a Timesheet with NO customer-hours approval history submits normally, no
  //    reconciliation audit of any kind is written.
  // ===============================================================================================
  {
    const site = await mkSite('T1');
    const wa = await mkWorkArea(site.id, 'T1');
    const emp = await mkWorker('T1');
    const monday = nextMonday();
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    const result = await submitDraft(emp.id, ts.id);
    check('1: submit succeeds with no prior approvals', result.status === 'SUBMITTED', result);
    const reconEvents = await prisma.auditEvent.count({ where: { entityId: ts.id, eventType: { in: ['CUSTOMER_HOURS_APPROVAL_SUPERSEDED', 'CUSTOMER_HOURS_RECONCILIATION_DEFERRED'] } } });
    check('1b: zero reconciliation audit events for a never-approved timesheet', reconEvents === 0, reconEvents);
  }

  // ===============================================================================================
  // 2. Unchanged manual resubmit (reopen, no edit, resubmit) — CURRENT item untouched, no audit.
  // ===============================================================================================
  {
    const site = await mkSite('T2');
    const wa = await mkWorkArea(site.id, 'T2');
    const emp = await mkWorker('T2');
    const monday = nextMonday();
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const approve1 = await approveWeek(adminToken, itemKey);
    check('2: initial approval succeeds', approve1.status === 200 && approve1.body.result === 'APPROVED', approve1.body);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    await mustReopen(emp.id, ts.id);
    const resubmit = await submitDraft(emp.id, ts.id); // no edit in between -> byte-identical content
    check('2b: resubmit with unchanged content succeeds', resubmit.status === 'SUBMITTED', resubmit);

    const after = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('2c: the SAME CURRENT item (same id) is still CURRENT after an unchanged resubmit', !!after && after.id === before?.id, { before, after });
    const supersededCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, approvalState: 'SUPERSEDED' } });
    check('2d: no SUPERSEDED row was created', supersededCount === 0, supersededCount);
    const auditCount = await prisma.auditEvent.count({ where: { entityId: before!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    check('2e: no SUPERSEDED audit event for the unchanged resubmit', auditCount === 0, auditCount);
  }

  // ===============================================================================================
  // 3. Changed day (extend the segment) -> CURRENT -> SUPERSEDED, audit carries old/new fingerprint
  //    and minutes, newSourceId = the new version's id.
  // ===============================================================================================
  {
    const site = await mkSite('T3');
    const wa = await mkWorkArea(site.id, 'T3');
    const emp = await mkWorker('T3');
    const monday = nextMonday();
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: (await prisma.timesheetDraft.findFirstOrThrow({ where: { timesheetId: ts.id } })).id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(monday, 17) } }); // 15:00 -> 17:00
    const resubmit = await submitDraft(emp.id, ts.id);
    check('3: resubmit with a changed day succeeds', resubmit.status === 'SUBMITTED', resubmit);

    const afterItems = await allItemsFor(ts.id, site.id, wa.id, isoDate(monday));
    check('3b: original item is now SUPERSEDED', afterItems.find((i) => i.id === before!.id)?.approvalState === 'SUPERSEDED', afterItems);
    check('3c: no new CURRENT item was auto-created (no automatic re-approval)', afterItems.filter((i) => i.approvalState === 'CURRENT').length === 0, afterItems);

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: before!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    const afterValue = audit.afterValue as any;
    const beforeValue = audit.beforeValue as any;
    check('3d: audit trigger=RECONCILIATION, reason=FINGERPRINT_CHANGED', afterValue.trigger === 'RECONCILIATION' && afterValue.reason === 'FINGERPRINT_CHANGED', afterValue);
    check('3e: audit beforeValue carries the OLD fingerprint/minutes', beforeValue.fingerprint === before!.fingerprint && beforeValue.workedMinutes === before!.workedMinutes, beforeValue);
    check('3f: audit afterValue carries the NEW fingerprint (different) and minutes (larger)', afterValue.newFingerprint !== before!.fingerprint && afterValue.newWorkedMinutes > before!.workedMinutes, afterValue);
    check('3g: audit afterValue.newSourceId is the resubmit\'s new version id', afterValue.newSourceId === resubmit.versionId, { afterValue, resubmit });
  }

  // ===============================================================================================
  // 4. Changed break only (same start/end, add an explicit unpaid break) -> fingerprint changes ->
  //    SUPERSEDED.
  // ===============================================================================================
  {
    const site = await mkSite('T4');
    const wa = await mkWorkArea(site.id, 'T4');
    const emp = await mkWorker('T4');
    const monday = nextMonday();
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: (await prisma.timesheetDraft.findFirstOrThrow({ where: { timesheetId: ts.id } })).id } });
    await prisma.timesheetDraftBreakSegment.create({ data: { draftSegmentId: seg.id, startAt: at(monday, 11), endAt: at(monday, 11.5), paid: false } });
    const resubmit = await submitDraft(emp.id, ts.id);
    check('4: resubmit with an added break succeeds', resubmit.status === 'SUBMITTED', resubmit);

    const after = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('4b: original item superseded (break change alone changes the fingerprint)', after === null, after);
    const supersededRow = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: before!.id } });
    check('4c: workedMinutes dropped by the added 30-minute break', supersededRow.approvalState === 'SUPERSEDED', supersededRow);
  }

  // ===============================================================================================
  // 5. Two customers (work areas) approved on the same Timesheet/week — changing ONE leaves the
  //    OTHER's CURRENT item completely untouched.
  // ===============================================================================================
  {
    const site = await mkSite('T5');
    const waA = await mkWorkArea(site.id, 'T5A');
    const waB = await mkWorkArea(site.id, 'T5B');
    const emp = await mkWorker('T5');
    const monday = nextMonday();

    // waA on Monday, waB on Tuesday (same WEEK, different DAY) — deliberately never sharing a
    // calendar day, so the day-level auto-break allocation (computed once per day and split
    // proportionally across every customer group present THAT day) can never cross-contaminate
    // waB's fingerprint just because waA's hours on a DIFFERENT day changed.
    const tuesday = new Date(monday.getTime() + 86400000);
    const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
    const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
    const asgA = await mkAssignment(emp.id, site.id, waA.id);
    const asgB = await mkAssignment(emp.id, site.id, waB.id, false);
    await prisma.timesheetDraftPlannedShift.createMany({
      data: [
        { draftId: draft.id, employeeId: emp.id, date: monday, siteId: site.id, sourceAssignmentId: asgA.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 11), plannedBreakMinutes: 0 },
        { draftId: draft.id, employeeId: emp.id, date: tuesday, siteId: site.id, sourceAssignmentId: asgB.id, plannedStartAt: at(tuesday, 12), plannedEndAt: at(tuesday, 16), plannedBreakMinutes: 0 }
      ]
    });
    const ddA = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
    const ddB = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: tuesday, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: ddA.id, draftId: draft.id, employeeId: emp.id, date: monday, startAt: at(monday, 7), endAt: at(monday, 11), siteId: site.id, workAreaId: waA.id, sourceAssignmentId: asgA.id } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: ddB.id, draftId: draft.id, employeeId: emp.id, date: tuesday, startAt: at(tuesday, 12), endAt: at(tuesday, 16), siteId: site.id, workAreaId: waB.id, sourceAssignmentId: asgB.id } });
    await submitDraft(emp.id, ts.id);

    const itemKeyA = { timesheetId: ts.id, siteId: site.id, workAreaId: waA.id, weekStart: isoDate(monday) };
    const itemKeyB = { timesheetId: ts.id, siteId: site.id, workAreaId: waB.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKeyA);
    await approveWeek(adminToken, itemKeyB);
    const beforeA = await currentItem(ts.id, site.id, waA.id, isoDate(monday));
    const beforeB = await currentItem(ts.id, site.id, waB.id, isoDate(monday));
    check('5: both customers approved', !!beforeA && !!beforeB, { beforeA, beforeB });

    await mustReopen(emp.id, ts.id);
    const segA = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id, workAreaId: waA.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: segA.id }, data: { endAt: at(monday, 10) } }); // only waA's hours change (shrink, never overlapping waB's 12:00-16:00)
    await submitDraft(emp.id, ts.id);

    const afterA = await currentItem(ts.id, site.id, waA.id, isoDate(monday));
    const afterB = await currentItem(ts.id, site.id, waB.id, isoDate(monday));
    check('5b: waA (changed) has no CURRENT item anymore', afterA === null, afterA);
    check('5c: waB (untouched) is STILL CURRENT, same id, same fingerprint', !!afterB && afterB.id === beforeB!.id && afterB.fingerprint === beforeB!.fingerprint, { beforeB, afterB });
    const auditForB = await prisma.auditEvent.count({ where: { entityId: beforeB!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    check('5d: no audit event was written for the untouched customer', auditForB === 0, auditForB);
  }

  // ===============================================================================================
  // 6. Biweekly Timesheet — changing week 2 leaves week 1's CURRENT item untouched.
  // ===============================================================================================
  {
    const site = await mkSite('T6');
    const wa = await mkWorkArea(site.id, 'T6');
    const emp = await mkWorker('T6');
    const week1 = nextMonday();
    const week2 = new Date(week1.getTime() + 7 * 86400000);
    const periodEnd = new Date(week1.getTime() + 13 * 86400000);

    const period = await prisma.payrollPeriod.create({ data: { startDate: week1, endDate: periodEnd, status: 'OPEN', openedByUserId: adminUserId } });
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
    const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
    const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
    const asg = await mkAssignment(emp.id, site.id, wa.id);
    for (const day of [week1, week2]) {
      await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: day, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: at(day, 7), plannedEndAt: at(day, 15), plannedBreakMinutes: 0 } });
      const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
      await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: day, startAt: at(day, 7), endAt: at(day, 15), siteId: site.id, workAreaId: wa.id, sourceAssignmentId: asg.id } });
    }
    await submitDraft(emp.id, ts.id);

    const key1 = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(week1) };
    const key2 = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(week2) };
    await approveWeek(adminToken, key1);
    await approveWeek(adminToken, key2);
    const before1 = await currentItem(ts.id, site.id, wa.id, isoDate(week1));
    const before2 = await currentItem(ts.id, site.id, wa.id, isoDate(week2));
    check('6: both weeks approved', !!before1 && !!before2, { before1, before2 });

    await mustReopen(emp.id, ts.id);
    const seg2 = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id, date: week2 } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg2.id }, data: { endAt: at(week2, 17) } }); // only week 2 changes
    await submitDraft(emp.id, ts.id);

    const after1 = await currentItem(ts.id, site.id, wa.id, isoDate(week1));
    const after2 = await currentItem(ts.id, site.id, wa.id, isoDate(week2));
    check('6b: week 1 (untouched) still CURRENT, same id', !!after1 && after1.id === before1!.id, { before1, after1 });
    check('6c: week 2 (changed) no longer CURRENT', after2 === null, after2);
  }

  // ===============================================================================================
  // 7. Slice removed entirely (all segments for the customer/week deleted) -> SUPERSEDED,
  //    reason SLICE_REMOVED, audit new* fields are all null.
  // ===============================================================================================
  {
    const site = await mkSite('T7');
    const wa = await mkWorkArea(site.id, 'T7');
    const emp = await mkWorker('T7');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    await mustReopen(emp.id, ts.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draft.id } });
    // A DRAFT with a day but zero segments for this customer/week -> buildWeeklyCustomerSlices
    // simply never produces a slice for this logical key anymore.
    const resubmit = await submitDraft(emp.id, ts.id);
    check('7: resubmit after removing all segments succeeds', resubmit.status === 'SUBMITTED', resubmit);

    const supersededRow = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: before!.id } });
    check('7b: item is SUPERSEDED', supersededRow.approvalState === 'SUPERSEDED', supersededRow);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: before!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    const afterValue = audit.afterValue as any;
    check('7c: reason=SLICE_REMOVED, every new* field is null', afterValue.reason === 'SLICE_REMOVED' && afterValue.newFingerprint === null && afterValue.newWorkedMinutes === null && afterValue.newGrossMinutes === null && afterValue.newBreakMinutes === null, afterValue);
    check('7d: newSourceId is still the new version id (not null)', afterValue.newSourceId === resubmit.versionId, afterValue);
  }

  // ===============================================================================================
  // 8. Note-only change (day.note edited, hours untouched) -> fingerprint unchanged -> no write.
  // ===============================================================================================
  {
    const site = await mkSite('T8');
    const wa = await mkWorkArea(site.id, 'T8');
    const emp = await mkWorker('T8');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    await mustReopen(emp.id, ts.id);
    const day = await prisma.timesheetDraftDay.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftDay.update({ where: { id: day.id }, data: { note: 'left early, doctor appointment' } });
    const resubmit = await submitDraft(emp.id, ts.id);
    check('8: resubmit with only a note change succeeds', resubmit.status === 'SUBMITTED', resubmit);

    const after = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('8b: SAME CURRENT item, note does not affect the fingerprint', !!after && after.id === before!.id && after.fingerprint === before!.fingerprint, { before, after });
    const auditCount = await prisma.auditEvent.count({ where: { entityId: before!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    check('8c: no audit event for a note-only edit', auditCount === 0, auditCount);
  }

  // ===============================================================================================
  // 9. Revert to a previously-approved (now superseded) fingerprint -> NOT auto-restored: still no
  //    CURRENT item, the SUPERSEDED row is untouched, and the diff endpoint shows UNCHANGED (live
  //    content matches the last known snapshot) while there's still no active confirmation.
  // ===============================================================================================
  {
    const site = await mkSite('T9');
    const wa = await mkWorkArea(site.id, 'T9');
    const emp = await mkWorker('T9');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const original = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    // Change it (-> superseded by reconciliation).
    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(monday, 17) } });
    await submitDraft(emp.id, ts.id);
    check('9: after the edit, no CURRENT item', (await currentItem(ts.id, site.id, wa.id, isoDate(monday))) === null);

    // Revert back to the ORIGINAL hours.
    await mustReopen(emp.id, ts.id);
    const seg2 = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg2.id }, data: { endAt: at(monday, 15) } }); // back to the original 07:00-15:00
    await submitDraft(emp.id, ts.id);

    check('9b: still no CURRENT item after reverting (no auto-restore)', (await currentItem(ts.id, site.id, wa.id, isoDate(monday))) === null);
    const allRows = await allItemsFor(ts.id, site.id, wa.id, isoDate(monday));
    check('9c: exactly one historical row total, still SUPERSEDED, fingerprint == original', allRows.length === 1 && allRows[0].approvalState === 'SUPERSEDED' && allRows[0].fingerprint === original!.fingerprint, { original, allRows });

    const diff = await diffJson(adminToken, itemKey);
    check('9d: diff endpoint reports UNCHANGED (live content matches the last known snapshot)', diff.status === 200 && diff.body.state === 'UNCHANGED', diff.body);
  }

  // ===============================================================================================
  // 10. Auto-submit path also reconciles (SubmissionSource.AUTO through the same core function).
  // ===============================================================================================
  {
    const site = await mkSite('T10');
    const wa = await mkWorkArea(site.id, 'T10');
    const emp = await mkWorker('T10');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id, SubmissionSource.MANUAL);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(monday, 16) } });
    const resubmit = await submitDraft(emp.id, ts.id, SubmissionSource.AUTO);
    check('10: AUTO resubmit succeeds', resubmit.status === 'SUBMITTED', resubmit);

    const after = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('10b: reconciliation ran for the AUTO path too (item superseded)', after === null, after);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: before!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    check('10c: audit trigger still RECONCILIATION regardless of submissionSource', (audit.afterValue as any).trigger === 'RECONCILIATION', audit.afterValue);
  }

  // ===============================================================================================
  // 11. Correction/direct-edit approval path also reconciles.
  //
  // UT9-B — a SECOND, deliberately UNAPPROVED customer (siteOther/waOther, Tuesday) is added
  // alongside the main one this test actually exercises: confirming just the main customer now
  // atomically finalizes the Timesheet the moment its own coverage is complete
  // (lib/reporting/customer-hours-finalization.ts) — and requestCorrection's directEdit:true path is
  // deliberately refused against an already-FINAL_APPROVED timesheet (lib/corrections.ts, a
  // pre-existing, unrelated rule: a no-reason admin direct edit needs the classic four-eyes flow
  // once a timesheet is final). Keeping a second customer unconfirmed keeps THIS timesheet at
  // SUBMITTED, exactly what this test needs, without changing anything this test actually asserts
  // (every check below still scopes to site.id/wa.id only).
  // ===============================================================================================
  {
    const site = await mkSite('T11');
    const wa = await mkWorkArea(site.id, 'T11');
    const siteOther = await mkSite('T11Other');
    const waOther = await mkWorkArea(siteOther.id, 'T11Other');
    const emp = await mkWorker('T11');
    const monday = nextMonday();
    const tuesday = new Date(monday.getTime() + 86400000);
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    const asgOther = await mkAssignment(emp.id, siteOther.id, waOther.id, false);
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: tuesday, siteId: siteOther.id, sourceAssignmentId: asgOther.id, plannedStartAt: at(tuesday, 7), plannedEndAt: at(tuesday, 15), plannedBreakMinutes: 0 } });
    const ddOther = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: tuesday, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: ddOther.id, draftId: draft.id, employeeId: emp.id, date: tuesday, startAt: at(tuesday, 7), endAt: at(tuesday, 15), siteId: siteOther.id, workAreaId: waOther.id, sourceAssignmentId: asgOther.id } });
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    const req = await requestCorrection(ts.id, adminUserId, '', randomUUID(), { directEdit: true });
    check('11: requestCorrection ok', !('code' in req), req);
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, adminUserId, randomUUID());
    const patched = await patchCorrectionDraftDay(reqId, monday, {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(monday, 7), endAt: at(monday, 18), siteId: site.id, workAreaId: wa.id, breaks: [] }] // 07:00-18:00 instead of 07:00-15:00
    });
    check('11b: patchCorrectionDraftDay ok', !('code' in patched), patched);
    const submitted = await submitCorrection(reqId, randomUUID());
    check('11c: submitCorrection ok', !('code' in submitted), submitted);
    const applied = await applyInReviewCorrection(reqId, adminUserId, randomUUID());
    check('11d: applyInReviewCorrection ok', !('code' in applied), applied);

    const after = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('11e: reconciliation ran for the correction/direct-edit path too', after === null, after);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: before!.id, eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED' } });
    check('11f: audit reason FINGERPRINT_CHANGED, newSourceId = the correction\'s resulting version', (audit.afterValue as any).reason === 'FINGERPRINT_CHANGED' && (audit.afterValue as any).newSourceId === (applied as any).resultingVersionId, { audit: audit.afterValue, applied });
  }

  // ===============================================================================================
  // 12. Parallel submit (edit) and approve on the SAME logical key — no deadlock, no corrupted
  //     state: whichever transaction locks first proceeds; the loser re-reads fresh data under its
  //     own lock and never double-writes or crashes.
  // ===============================================================================================
  {
    const site = await mkSite('T12');
    const wa = await mkWorkArea(site.id, 'T12');
    const emp = await mkWorker('T12');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const preview = await realPreview(adminToken, itemKey); // preview BEFORE the race, token bound to the pre-edit fingerprint

    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(monday, 16) } });

    const [submitResult, commitResult] = await Promise.allSettled([
      submitDraft(emp.id, ts.id), // resubmits the changed content -> triggers reconciliation
      commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken) // races to approve the PRE-edit fingerprint
    ]);
    check('12: submit settled (not deadlocked/hung)', submitResult.status === 'fulfilled', submitResult);
    check('12b: commit settled (not deadlocked/hung)', commitResult.status === 'fulfilled', commitResult);
    if (commitResult.status === 'fulfilled') {
      check('12c: the commit either succeeded (won the race, before the edit landed) or failed cleanly with a real conflict code (never a 500)', commitResult.value.status === 200 || (commitResult.value.status === 409 && typeof commitResult.value.body?.error?.code === 'string'), commitResult.value);
    }
    const currentCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: new Date(`${isoDate(monday)}T00:00:00.000Z`), approvalState: 'CURRENT' } });
    check('12d: at most one CURRENT item for this logical key after the race (never two)', currentCount <= 1, currentCount);
  }

  // ===============================================================================================
  // 13. UT7-B-fixup #1/#3 — a source read failure must defer, never mass-supersede, and reconciliation
  //     never silently swallows a genuinely unknown error. Both exercised by calling
  //     reconcileCustomerHoursApprovalsForTimesheet directly against a Timesheet whose
  //     currentVersionId has been corrupted (status stays SUBMITTED, currentVersionId nulled) — the
  //     SAME technique _test-timesheets-ledger-diff-browser.ts already uses to simulate a technical
  //     read failure. This state is unreachable through the app's own submit flow (nothing here
  //     weakens a production constraint); it exists purely to drive the guard that catches it,
  //     exactly the "special DB fixture built directly for the reconciliation test" the owner
  //     explicitly permitted. The known WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE
  //     deferral remains verified only by direct code inspection plus the unit test in
  //     _test-customer-hours-reconciliation.ts (classifyReconciliationBuildFailure) — two independent
  //     attempts to construct it at the DB level were both rejected by dedicated Postgres guards
  //     (BREAK_OUTSIDE_PARENT trigger, ex_timesheet_draft_break_segment_time_overlap exclusion
  //     constraint) before ever reaching reconciliation, confirming the condition is structurally
  //     unreachable through the real data-entry surface rather than merely untested.
  // ===============================================================================================
  {
    const site = await mkSite('T13');
    const wa = await mkWorkArea(site.id, 'T13');
    const emp = await mkWorker('T13');
    const monday = nextMonday();
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    const submitted = await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('13: approved before corrupting the source', !!before, before);

    // Corrupt the canonical source directly — unreachable through the app's own write surface.
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: null } });

    // 13a — call reconciliation directly with a REAL actorUserId, the same lock chain
    // submitWorkerTimesheetCore's callers already hold before calling it.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
      await reconcileCustomerHoursApprovalsForTimesheet({ tx, employeeId: emp.id, timesheetId: ts.id, versionId: submitted.versionId as string, actorUserId: adminUserId, requestId: randomUUID() });
    });

    const afterDirect = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('13a: CURRENT item is STILL CURRENT, same id and fingerprint (a read failure never mass-supersedes)', !!afterDirect && afterDirect.id === before!.id && afterDirect.fingerprint === before!.fingerprint, { before, afterDirect });
    const supersededCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, approvalState: 'SUPERSEDED' } });
    check('13b: no SUPERSEDED row was created by the source-unreadable run', supersededCount === 0, supersededCount);
    const deferredEvents = await prisma.auditEvent.findMany({ where: { entityId: ts.id, eventType: 'CUSTOMER_HOURS_RECONCILIATION_DEFERRED' } });
    check('13c: exactly one CUSTOMER_HOURS_RECONCILIATION_DEFERRED audit event, reasonCode SOURCE_UNREADABLE', deferredEvents.length === 1 && (deferredEvents[0].afterValue as any).reasonCode === 'SOURCE_UNREADABLE', deferredEvents);

    // 13d — a genuinely unknown error (here: an AuditEvent actorUserId FK violation from a bogus
    // user id) must still NOT be swallowed — it propagates out of reconciliation and rolls back the
    // whole call, leaving no partial trace behind.
    const bogusActorUserId = randomUUID(); // well-formed UUID, no matching User row
    let threw = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
        await reconcileCustomerHoursApprovalsForTimesheet({ tx, employeeId: emp.id, timesheetId: ts.id, versionId: submitted.versionId as string, actorUserId: bogusActorUserId, requestId: randomUUID() });
      });
    } catch {
      threw = true;
    }
    check('13e: an unrelated genuine DB error (audit FK violation) propagates, is not swallowed', threw);
    const deferredEventsAfter = await prisma.auditEvent.count({ where: { entityId: ts.id, eventType: 'CUSTOMER_HOURS_RECONCILIATION_DEFERRED' } });
    check('13f: the failed attempt left no additional trace (rolled back — still exactly one prior deferred event)', deferredEventsAfter === 1, deferredEventsAfter);
    const stillCurrent = await currentItem(ts.id, site.id, wa.id, isoDate(monday));
    check('13g: CURRENT item still untouched after the rolled-back attempt', !!stillCurrent && stillCurrent.id === before!.id, stillCurrent);
  }

  // ===============================================================================================
  // 14. Diff endpoint — the four states, auth/permission, strict logical-key validation.
  // ===============================================================================================
  {
    const site = await mkSite('T14');
    const wa = await mkWorkArea(site.id, 'T14');
    const emp = await mkWorker('T14');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);

    const unchanged = await diffJson(adminToken, itemKey);
    check('14: freshly approved, untouched -> state UNCHANGED', unchanged.status === 200 && unchanged.body.state === 'UNCHANGED', unchanged.body);
    check('14b: deltaWorkedMinutes is 0 for UNCHANGED', unchanged.body.deltaWorkedMinutes === 0, unchanged.body);

    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(monday, 17) } });
    await submitDraft(emp.id, ts.id);

    const changed = await diffJson(adminToken, itemKey);
    check('15: after a real change -> state FINGERPRINT_CHANGED', changed.status === 200 && changed.body.state === 'FINGERPRINT_CHANGED', changed.body);
    check('15b: after.workedMinutes > before.workedMinutes, deltaWorkedMinutes > 0', changed.body.after.workedMinutes > changed.body.before.workedMinutes && changed.body.deltaWorkedMinutes > 0, changed.body);
    check('15c: changedDates includes the edited date', Array.isArray(changed.body.changedDates) && changed.body.changedDates.includes(isoDate(monday)), changed.body.changedDates);
    check('15d: before carries who/when approved', typeof changed.body.before.approvedByUserName === 'string' && typeof changed.body.before.approvedAt === 'string', changed.body.before);

    await mustReopen(emp.id, ts.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draft.id } });
    await submitDraft(emp.id, ts.id);
    const removed = await diffJson(adminToken, itemKey);
    check('16: after the slice disappears -> state SLICE_REMOVED, after=null', removed.status === 200 && removed.body.state === 'SLICE_REMOVED' && removed.body.after === null, removed.body);
    check('16b: deltaWorkedMinutes is null when after is null', removed.body.deltaWorkedMinutes === null, removed.body);

    // Auth/permission/validation.
    const noAuth = await diffJson(null, itemKey);
    check('17: no session -> 401', noAuth.status === 401, noAuth.body);
    const workerRole = await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } });
    const workerUser = await prisma.user.create({ data: { username: `rcl-worker-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: workerRole.id } } } });
    const workerToken = generateSessionToken();
    await prisma.userSession.create({ data: { userId: workerUser.id, tokenHash: hashSessionToken(workerToken), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
    const forbidden = await diffJson(workerToken, itemKey);
    check('17b: WORKER role lacking timesheet.read.all -> 403', forbidden.status === 403, forbidden.body);

    const badKey = await diffJson(adminToken, { ...itemKey, weekStart: '2026-09-22' }); // a Tuesday, not a Monday
    check('17c: non-Monday weekStart -> 400', badKey.status === 400, badKey.body);

    const noHistory = await diffJson(adminToken, { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(new Date(monday.getTime() + 28 * 86400000)) }); // +4 weeks, still a Monday
    check('17d: a logical key with no approval history -> 404 NO_APPROVAL_HISTORY', noHistory.status === 404 && noHistory.body.error?.code === 'NO_APPROVAL_HISTORY', noHistory.body);

    // UT7-B-fixup #4 — strict validation: an unknown query parameter, and a repeated one, are both
    // rejected outright rather than silently ignored/first-wins.
    const unknownParamRes = await diffGET(jsonReq(`http://localhost/api/admin/time-ledger/approval-diff?timesheetId=${itemKey.timesheetId}&siteId=${itemKey.siteId}&weekStart=${itemKey.weekStart}&bogus=1`, adminToken, null, {}, false, 'GET'));
    const unknownParamBody = await unknownParamRes.json();
    check('17e: unknown query parameter -> 400 VALIDATION_ERROR', unknownParamRes.status === 400 && unknownParamBody.error?.code === 'VALIDATION_ERROR' && !!unknownParamBody.error?.fieldErrors?.bogus, unknownParamBody);

    const repeatedParamRes = await diffGET(jsonReq(`http://localhost/api/admin/time-ledger/approval-diff?timesheetId=${itemKey.timesheetId}&timesheetId=${itemKey.timesheetId}&siteId=${itemKey.siteId}&weekStart=${itemKey.weekStart}`, adminToken, null, {}, false, 'GET'));
    const repeatedParamBody = await repeatedParamRes.json();
    check('17f: repeated query parameter -> 400 VALIDATION_ERROR', repeatedParamRes.status === 400 && repeatedParamBody.error?.code === 'VALIDATION_ERROR' && !!repeatedParamBody.error?.fieldErrors?.timesheetId, repeatedParamBody);
  }

  // ===============================================================================================
  // 18. UT7-B-fixup #2 — GET /api/admin/time-ledger/historical-approvals: a genuinely removed slice
  //     and a genuinely unreadable source both surface as historical rows once no CURRENT item is
  //     left for their logical key; an ordinary unchanged-and-still-approved item never does; the
  //     siteId filter is respected.
  // ===============================================================================================
  {
    const site = await mkSite('T18');
    const otherSite = await mkSite('T18-other');
    const wa = await mkWorkArea(site.id, 'T18');
    const emp = await mkWorker('T18');
    const monday = nextMonday();
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, itemKey);
    const before = await currentItem(ts.id, site.id, wa.id, isoDate(monday));

    // Remove the slice entirely (same construction as block 7) -> SUPERSEDED, reason SLICE_REMOVED,
    // no CURRENT left, source still perfectly readable (zero days for this logical key, not a
    // technical failure).
    await mustReopen(emp.id, ts.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draft.id } });
    await submitDraft(emp.id, ts.id);
    check('18: no CURRENT item after the slice was removed', (await currentItem(ts.id, site.id, wa.id, isoDate(monday))) === null);

    const removedResult = await historicalJson(adminToken, { siteId: site.id });
    check('18a: 200 OK', removedResult.status === 200, removedResult.body);
    const removedRow = removedResult.body.rows.find((r: any) => r.timesheetId === ts.id && r.weekStart === isoDate(monday));
    check('18b: the removed slice appears as a historical row, reason SLICE_REMOVED', !!removedRow && removedRow.reason === 'SLICE_REMOVED', removedResult.body.rows);
    check('18c: historical row carries the OLD approval numbers/who/when, not a fabricated value', !!removedRow && removedRow.lastApproval.fingerprint === before!.fingerprint && removedRow.lastApproval.workedMinutes === before!.workedMinutes && typeof removedRow.lastApproval.approvedByUserName === 'string', removedRow);
    check('18d: row stays inside its own customer context (siteId/workAreaId/employeeId correct)', !!removedRow && removedRow.siteId === site.id && removedRow.workAreaId === wa.id && removedRow.employeeId === emp.id, removedRow);

    // Now ALSO corrupt the (already-superseded, source-vanished) Timesheet's currentVersionId, so
    // the SAME logical key's live resolution fails technically rather than just "no data" — the
    // history module must reclassify it as SOURCE_UNREADABLE, not keep reporting SLICE_REMOVED.
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: null } });
    const unreadableResult = await historicalJson(adminToken, { siteId: site.id });
    const unreadableRow = unreadableResult.body.rows.find((r: any) => r.timesheetId === ts.id && r.weekStart === isoDate(monday));
    check('18e: once the source itself becomes unreadable, the SAME row reclassifies to SOURCE_UNREADABLE', !!unreadableRow && unreadableRow.reason === 'SOURCE_UNREADABLE', unreadableResult.body.rows);

    // An ordinary, still-CURRENT, unchanged approval never appears as historical.
    const site2 = await mkSite('T18b');
    const wa2 = await mkWorkArea(site2.id, 'T18b');
    const emp2 = await mkWorker('T18b');
    const monday2 = nextMonday();
    const { ts: ts2 } = await buildDraft(emp2.id, site2.id, wa2.id, monday2);
    await submitDraft(emp2.id, ts2.id);
    await approveWeek(adminToken, { timesheetId: ts2.id, siteId: site2.id, workAreaId: wa2.id, weekStart: isoDate(monday2) });
    const normalResult = await historicalJson(adminToken, { siteId: site2.id });
    check('18f: an ordinary unchanged CURRENT approval is never reported as historical', normalResult.body.rows.every((r: any) => r.timesheetId !== ts2.id), normalResult.body.rows);

    // siteId filter excludes rows from a different site.
    const otherSiteResult = await historicalJson(adminToken, { siteId: otherSite.id });
    check('18g: siteId filter respected — an unrelated site sees none of this site\'s historical rows', otherSiteResult.body.rows.every((r: any) => r.timesheetId !== ts.id), otherSiteResult.body.rows);

    // A CURRENT item that was NEVER superseded (no resubmit happened — reconciliation never ran)
    // but whose Timesheet's source has independently become unreadable must ALSO surface as
    // historical: this is exactly the same "corrupted currentVersionId, no resubmit" state fixup #1
    // guarantees reconciliation leaves untouched, and it deserves the same visibility fixup #2 asks
    // for — not just the already-superseded case tested above.
    const site3 = await mkSite('T18c');
    const wa3 = await mkWorkArea(site3.id, 'T18c');
    const emp3 = await mkWorker('T18c');
    const monday3 = nextMonday();
    const { ts: ts3 } = await buildDraft(emp3.id, site3.id, wa3.id, monday3);
    await submitDraft(emp3.id, ts3.id);
    const itemKey3 = { timesheetId: ts3.id, siteId: site3.id, workAreaId: wa3.id, weekStart: isoDate(monday3) };
    await approveWeek(adminToken, itemKey3);
    const before3 = await currentItem(ts3.id, site3.id, wa3.id, isoDate(monday3));
    await prisma.timesheet.update({ where: { id: ts3.id }, data: { currentVersionId: null } });
    const stillCurrent3 = await currentItem(ts3.id, site3.id, wa3.id, isoDate(monday3));
    check('18h: the CURRENT item really is untouched (still CURRENT) after the direct corruption', !!stillCurrent3 && stillCurrent3.id === before3!.id, stillCurrent3);
    const currentUnreadableResult = await historicalJson(adminToken, { siteId: site3.id });
    const currentUnreadableRow = currentUnreadableResult.body.rows.find((r: any) => r.timesheetId === ts3.id);
    check('18i: a still-CURRENT item on a source-broken Timesheet also surfaces as historical, reason SOURCE_UNREADABLE', !!currentUnreadableRow && currentUnreadableRow.reason === 'SOURCE_UNREADABLE', currentUnreadableResult.body.rows);

    // UT7-B-fixup-2 #4 — historical rows respect the status/issue filter. Reusing site/ts from 18b
    // above (a genuine SLICE_REMOVED historical row already exists for it).
    const readyResult = await historicalJson(adminToken, { siteId: site.id, status: 'ready' });
    check('18j: status=ready -> historical row hidden (incompatible filter)', readyResult.status === 200 && readyResult.body.rows.every((r: any) => r.timesheetId !== ts.id), readyResult.body.rows);
    const approvedResult = await historicalJson(adminToken, { siteId: site.id, status: 'approved' });
    check('18k: status=approved -> historical row hidden', approvedResult.status === 200 && approvedResult.body.rows.every((r: any) => r.timesheetId !== ts.id), approvedResult.body.rows);
    const notSubmittedResult = await historicalJson(adminToken, { siteId: site.id, status: 'not_submitted' });
    check('18l: status=not_submitted -> historical row hidden', notSubmittedResult.status === 200 && notSubmittedResult.body.rows.every((r: any) => r.timesheetId !== ts.id), notSubmittedResult.body.rows);
    const needsAttentionResult = await historicalJson(adminToken, { siteId: site.id, status: 'needs_attention' });
    check('18m: status=needs_attention -> historical row hidden', needsAttentionResult.status === 200 && needsAttentionResult.body.rows.every((r: any) => r.timesheetId !== ts.id), needsAttentionResult.body.rows);
    const changedResult = await historicalJson(adminToken, { siteId: site.id, status: 'changed_after_approval' });
    check('18n: status=changed_after_approval -> historical row SHOWN (compatible)', changedResult.status === 200 && changedResult.body.rows.some((r: any) => r.timesheetId === ts.id), changedResult.body.rows);
    const onlyIssuesResult = await historicalJson(adminToken, { siteId: site.id, status: 'ready', onlyIssues: true });
    check('18o: onlyIssues=true wins over an otherwise-incompatible status -> SHOWN', onlyIssuesResult.status === 200 && onlyIssuesResult.body.rows.some((r: any) => r.timesheetId === ts.id), onlyIssuesResult.body.rows);
    const onlyChangedResult = await historicalJson(adminToken, { siteId: site.id, onlyChangedAfterApproval: true });
    check('18p: onlyChangedAfterApproval=true -> SHOWN', onlyChangedResult.status === 200 && onlyChangedResult.body.rows.some((r: any) => r.timesheetId === ts.id), onlyChangedResult.body.rows);
  }

  // ===============================================================================================
  // 19. UT7-B-fixup-2 #3 — truncation is reported explicitly, and a logical key's own history can
  //     never crowd a DIFFERENT, more-recently-touched key out of a bounded result. The query groups
  //     by logical key IN THE DATABASE (groupBy + _max(createdAt), see customer-hours-history.ts)
  //     before any maxRows limit is applied — structurally, one key can only ever occupy ONE slot in
  //     that limit, however many raw SUPERSEDED rows it happens to carry. loadHistoricalApprovalIssues
  //     called directly with a small maxRows override (a server-side-only parameter — GET
  //     .../historical-approvals never exposes it, see customer-hours-history.ts).
  // ===============================================================================================
  {
    const site = await mkSite('T19');
    const waOld = await mkWorkArea(site.id, 'T19-old');
    const waRecent = await mkWorkArea(site.id, 'T19-recent');
    const empOld = await mkWorker('T19old');
    const empRecent = await mkWorker('T19recent');

    // Key A ("old"): approve, then two full change-and-reapprove cycles (each producing one real
    // SUPERSEDED row), then a final change with NO reapproval — three SUPERSEDED rows total on the
    // SAME logical key, all older in time than key B below, key A itself genuinely SLICE_REMOVED by
    // the end (segments deleted on the last cycle, not just changed).
    const mondayOld = nextMonday();
    const { ts: tsOld, draft: draftOld } = await buildDraft(empOld.id, site.id, waOld.id, mondayOld);
    await submitDraft(empOld.id, tsOld.id);
    const itemKeyOld = { timesheetId: tsOld.id, siteId: site.id, workAreaId: waOld.id, weekStart: isoDate(mondayOld) };
    await approveWeek(adminToken, itemKeyOld); // C1
    for (const endHour of [16, 17]) {
      await mustReopen(empOld.id, tsOld.id);
      const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draftOld.id } });
      await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(mondayOld, endHour) } });
      await submitDraft(empOld.id, tsOld.id); // supersedes the current CURRENT
      await approveWeek(adminToken, itemKeyOld); // re-approves the new content -> a fresh CURRENT
    }
    await mustReopen(empOld.id, tsOld.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draftOld.id } });
    await submitDraft(empOld.id, tsOld.id); // final supersede, NOT re-approved -> genuinely SLICE_REMOVED
    const oldHistoryCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: tsOld.id, siteId: site.id, workAreaId: waOld.id, approvalState: 'SUPERSEDED' } });
    check('19: key A really does carry multiple old SUPERSEDED rows on the SAME logical key', oldHistoryCount >= 3, oldHistoryCount);

    // Key B ("recent"): approve, then remove the slice ONCE — a single, more recently created
    // SUPERSEDED row than anything on key A above.
    const mondayRecent = nextMonday();
    const { ts: tsRecent, draft: draftRecent } = await buildDraft(empRecent.id, site.id, waRecent.id, mondayRecent);
    await submitDraft(empRecent.id, tsRecent.id);
    const itemKeyRecent = { timesheetId: tsRecent.id, siteId: site.id, workAreaId: waRecent.id, weekStart: isoDate(mondayRecent) };
    await approveWeek(adminToken, itemKeyRecent);
    await mustReopen(empRecent.id, tsRecent.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draftRecent.id } });
    await submitDraft(empRecent.id, tsRecent.id);

    const limited = await loadHistoricalApprovalIssues(
      { allTime: true, requestedRange: null, employeeSearch: null, siteId: site.id, workAreaId: null, status: 'all', onlyIssues: false, onlyChangedAfterApproval: false },
      { userId: adminUserId, employeeId: null },
      prisma,
      1 // maxRows=1 — only ONE logical key can be shown, out of the two that qualify (A and B)
    );
    check('19b: truncated=true when more logical keys match than maxRows', limited.truncated === true, limited);
    check('19c: exactly one row returned (maxRows respected)', limited.rows.length === 1, limited.rows);
    check(
      '19d: the ONE shown row is key B (the more recently touched key) — key A\'s pile of old SUPERSEDED rows never crowds it out',
      limited.rows[0]?.timesheetId === tsRecent.id,
      limited.rows
    );

    const unlimited = await loadHistoricalApprovalIssues(
      { allTime: true, requestedRange: null, employeeSearch: null, siteId: site.id, workAreaId: null, status: 'all', onlyIssues: false, onlyChangedAfterApproval: false },
      { userId: adminUserId, employeeId: null },
      prisma
      // default maxRows (production value) — comfortably above 2, so nothing is truncated here.
    );
    check('19e: with the production maxRows, both keys fit and truncated=false', unlimited.truncated === false && unlimited.rows.length === 2, unlimited.rows);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
