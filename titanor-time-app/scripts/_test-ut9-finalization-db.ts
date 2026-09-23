// UT9-B (Titanor Time — единый путь принятия часов) — real-Postgres coverage for the new
// customer-hours-driven Timesheet finalization: lib/reporting/customer-hours-finalization.ts
// (attemptTimesheetFinalization / computeTimesheetCustomerHoursCoverage), the refactored
// lib/admin-timesheets.ts (finalizeLockedTimesheet, reused by both the OLD /admin/review flow and
// this new one), and the two commit routes it is wired into (single-item
// POST /api/admin/time-ledger/approvals, mass POST /api/admin/time-ledger/mass-approvals including
// the new scope='WEEK' selection shape). Route-handler-direct-call, same convention as
// _test-customer-hours-summary-db.ts / _test-time-ledger-approvals.ts.

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, reopenWorkerTimesheetForEdits } from '../lib/worker-timesheets';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as previewPOST } from '../app/api/admin/time-ledger/approval-preview/route';
import { POST as commitPOST } from '../app/api/admin/time-ledger/approvals/route';
import { POST as massPreviewPOST } from '../app/api/admin/time-ledger/mass-approval-preview/route';
import { POST as massCommitPOST } from '../app/api/admin/time-ledger/mass-approvals/route';
import { lockPeriod } from '../lib/periods';
import { attemptTimesheetFinalization } from '../lib/reporting/customer-hours-finalization';
import { createAuditEvent } from '../lib/audit';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 900) : '');
  }
}

let adminUserId = '';

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `UT9-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `UT9-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `UT9-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2039, 0, 3) + weekSlot * 14 * 86400000); // 2039-01-03 is a Monday
  weekSlot += 1;
  return d;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** One period+timesheet+draft with a single 07:00-15:00 segment on `monday` at (siteId, workAreaId)
 *  — 450 worked minutes after the company-wide auto-unpaid-lunch deduction (the same "8h gross ->
 *  450 min" fact every other test file in this suite anchors on), proving rounding/lunch are
 *  untouched by this whole feature: nothing here ever recomputes hours, only reads
 *  slice.workedMinutes already produced by buildWeeklyCustomerSlices. */
async function buildDraft(employeeId: string, siteId: string, workAreaId: string | null, monday: Date) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  const asg = await mkAssignment(employeeId, siteId, workAreaId);
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: monday, siteId, sourceAssignmentId: asg.id, plannedStartAt: at(monday, 7), plannedEndAt: at(monday, 15), plannedBreakMinutes: 0 } });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: monday, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: monday, startAt: at(monday, 7), endAt: at(monday, 15), siteId, workAreaId, sourceAssignmentId: asg.id } });
  return { period, ts, draft, asg };
}

/** UT9-B test 3 — one period+timesheet+draft with segments on TWO DIFFERENT days of the SAME
 *  Helsinki week, each at its own (siteId, workAreaId) — the same shape a real "day split between
 *  two customers" produces: one Timesheet, one weekStart, two distinct weekly-customer-slices. */
async function buildTwoCustomerDraft(employeeId: string, monday: Date, entries: { dayOffset: number; siteId: string; workAreaId: string | null }[]) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const day = new Date(monday.getTime() + e.dayOffset * 86400000);
    // Only the FIRST assignment is primary — SiteAssignment has a GiST exclusion constraint
    // ("≤1 LIVE primary per OVERLAPPING period" per employee), and every entry here shares the
    // same open-ended [2020-01-01, ∞) validity window.
    const asg = await mkAssignment(employeeId, e.siteId, e.workAreaId, i === 0);
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: day, siteId: e.siteId, sourceAssignmentId: asg.id, plannedStartAt: at(day, 7), plannedEndAt: at(day, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: day, startAt: at(day, 7), endAt: at(day, 15), siteId: e.siteId, workAreaId: e.workAreaId, sourceAssignmentId: asg.id } });
  }
  return { period, ts, draft };
}

async function submitDraft(employeeId: string, timesheetId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;
    return submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), SubmissionSource.MANUAL);
  });
}
async function mustReopen(employeeId: string, timesheetId: string): Promise<void> {
  const result = await reopenWorkerTimesheetForEdits(employeeId, timesheetId, adminUserId, randomUUID());
  if (result.code !== 'REOPENED') {
    throw new Error(`reopenWorkerTimesheetForEdits failed unexpectedly: ${JSON.stringify(result)}`);
  }
}
async function makeSession(roleName: string, employeeId: string | null = null): Promise<string> {
  const user = await prisma.user.create({ data: { username: `ut9-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
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
async function commitJson(sessionToken: string | null, itemKey: unknown, expectedFingerprint: string, confirmationToken: string): Promise<{ status: number; body: any }> {
  const res = await commitPOST(jsonReq('http://localhost/api/admin/time-ledger/approvals', sessionToken, { itemKey, expectedFingerprint, confirmationToken }, { 'idempotency-key': randomUUID() }));
  return { status: res.status, body: await res.json() };
}
async function realPreview(sessionToken: string, itemKey: unknown): Promise<{ status: number; body: any }> {
  const bootstrap = await previewJson(sessionToken, itemKey, '0'.repeat(64));
  if (bootstrap.status !== 200) return bootstrap;
  return previewJson(sessionToken, itemKey, bootstrap.body.currentFingerprint);
}
/** Single-item "Принять эту неделю" — preview then commit, returns the COMMIT response (carries
 *  finalizedTimesheetIds). */
async function approveWeek(sessionToken: string, itemKey: unknown): Promise<{ status: number; body: any }> {
  const preview = await realPreview(sessionToken, itemKey);
  if (preview.status !== 200 || !preview.body.confirmationToken) return preview;
  return commitJson(sessionToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
}
async function massPreviewJson(sessionToken: string, selection: unknown[], scope: 'CUSTOMER' | 'WEEK'): Promise<{ status: number; body: any }> {
  const res = await massPreviewPOST(jsonReq('http://localhost/api/admin/time-ledger/mass-approval-preview', sessionToken, { selection, scope }));
  return { status: res.status, body: await res.json() };
}
async function massCommitJson(sessionToken: string, selection: unknown[], confirmationToken: string, scope: 'CUSTOMER' | 'WEEK'): Promise<{ status: number; body: any }> {
  const res = await massCommitPOST(jsonReq('http://localhost/api/admin/time-ledger/mass-approvals', sessionToken, { selection, confirmationToken, scope }, { 'idempotency-key': randomUUID() }));
  return { status: res.status, body: await res.json() };
}
/** Full preview -> commit for a mass selection, returns the COMMIT response. */
async function massApprove(sessionToken: string, selection: { itemKey: unknown }[], scope: 'CUSTOMER' | 'WEEK'): Promise<{ status: number; body: any }> {
  const bootstrap = await massPreviewJson(
    sessionToken,
    selection.map((s) => ({ itemKey: s.itemKey, expectedFingerprint: '0'.repeat(64) })),
    scope
  );
  if (bootstrap.status !== 200) return bootstrap;
  // The preview response's itemKey also carries employeeId (display convenience) — strip it back
  // down to the 4 fields validateMassSelection actually allows before resubmitting.
  const realSelection = bootstrap.body.items.map((it: any) => ({
    itemKey: { timesheetId: it.itemKey.timesheetId, siteId: it.itemKey.siteId, workAreaId: it.itemKey.workAreaId, weekStart: it.itemKey.weekStart },
    expectedFingerprint: it.currentFingerprint
  }));
  const preview = await massPreviewJson(sessionToken, realSelection, scope);
  if (preview.status !== 200 || !preview.body.confirmationToken) return preview;
  return massCommitJson(sessionToken, realSelection, preview.body.confirmationToken, scope);
}

async function main() {
  const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `ut9-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: adminRole.id } } } });
  adminUserId = admin.id;
  const adminToken = await makeSession('ADMIN');

  // ===============================================================================================
  // 1. UT9-A/B decision 1/2 — confirming ONE customer out of two on the same worker/timesheet must
  //    NOT finalize the Timesheet: partial coverage never finalizes, ever.
  // ===============================================================================================
  {
    const siteA = await mkSite('T1A');
    const waA = await mkWorkArea(siteA.id, 'T1A');
    const siteB = await mkSite('T1B');
    const waB = await mkWorkArea(siteB.id, 'T1B');
    const monday = nextMonday();
    const emp = await mkWorker('T1');
    const { ts } = await buildTwoCustomerDraft(emp.id, monday, [
      { dayOffset: 0, siteId: siteA.id, workAreaId: waA.id },
      { dayOffset: 1, siteId: siteB.id, workAreaId: waB.id }
    ]);
    await submitDraft(emp.id, ts.id);

    const keyA = { timesheetId: ts.id, siteId: siteA.id, workAreaId: waA.id, weekStart: isoDate(monday) };
    const approved = await approveWeek(adminToken, keyA);
    check('1: confirming customer A succeeds', approved.status === 200 && approved.body.result === 'APPROVED', approved.body);
    check('1b: finalizedTimesheetIds is empty — customer B is still unconfirmed', Array.isArray(approved.body.finalizedTimesheetIds) && approved.body.finalizedTimesheetIds.length === 0, approved.body);

    const fresh = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('1c: Timesheet.status is NOT FINAL_APPROVED (still SUBMITTED/FOREMAN_APPROVED)', fresh.status !== 'FINAL_APPROVED', fresh.status);
  }

  // ===============================================================================================
  // 2. UT9-A/B decision 1 — confirming the LAST remaining customer completes coverage and finalizes
  //    the Timesheet automatically, atomically with the confirmation itself. Also the rounding/lunch
  //    regression: workedMinutes for a 07:00-15:00 shift stays 450 (8h gross minus the default
  //    30-min auto-unpaid-lunch) — this whole feature never recomputes hours.
  // ===============================================================================================
  {
    const site = await mkSite('T2');
    const wa = await mkWorkArea(site.id, 'T2');
    const monday = nextMonday();
    const emp = await mkWorker('T2');
    const { ts, period } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);

    const key = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const approved = await approveWeek(adminToken, key);
    check('2: single-customer confirmation succeeds', approved.status === 200 && approved.body.result === 'APPROVED', approved.body);
    check('2b: workedMinutes is 450 (8h gross minus the default auto-unpaid-lunch) — rounding/lunch unaffected', approved.body.workedMinutes === 450, approved.body);
    check('2c: finalizedTimesheetIds contains exactly this timesheet — its ONLY customer just reached full coverage', JSON.stringify(approved.body.finalizedTimesheetIds) === JSON.stringify([ts.id]), approved.body);

    const fresh = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('2d: Timesheet.status is now FINAL_APPROVED', fresh.status === 'FINAL_APPROVED', fresh.status);

    // 8. Old payroll/lock scenarios still work off the SAME status field the new path just set.
    const lockResult = await lockPeriod(period.id, adminUserId, randomUUID());
    check('2e: lockPeriod succeeds for a period whose one participant was finalized via the NEW path', 'status' in lockResult && lockResult.status === 'LOCKED', lockResult);
  }

  // ===============================================================================================
  // 3. UT9-A/B decision 3 — "Принять всю неделю": one atomic mass operation (scope='WEEK')
  //    confirming BOTH customers of one worker's one week (a day split between two customers) in a
  //    single call, which then also finalizes the Timesheet in the SAME transaction.
  // ===============================================================================================
  {
    const siteA = await mkSite('T3A');
    const waA = await mkWorkArea(siteA.id, 'T3A');
    const siteB = await mkSite('T3B');
    const waB = await mkWorkArea(siteB.id, 'T3B');
    const monday = nextMonday();
    const emp = await mkWorker('T3');
    const { ts } = await buildTwoCustomerDraft(emp.id, monday, [
      { dayOffset: 0, siteId: siteA.id, workAreaId: waA.id },
      { dayOffset: 1, siteId: siteB.id, workAreaId: waB.id }
    ]);
    await submitDraft(emp.id, ts.id);

    const keyA = { timesheetId: ts.id, siteId: siteA.id, workAreaId: waA.id, weekStart: isoDate(monday) };
    const keyB = { timesheetId: ts.id, siteId: siteB.id, workAreaId: waB.id, weekStart: isoDate(monday) };

    // A CUSTOMER-scope selection spanning two different customers must be rejected outright (the
    // mixed-customer rule is unaffected by this fixup) — confirms scope='WEEK' is genuinely doing
    // something different, not just a silent no-op.
    const wrongScope = await massPreviewJson(adminToken, [{ itemKey: keyA, expectedFingerprint: '0'.repeat(64) }, { itemKey: keyB, expectedFingerprint: '0'.repeat(64) }], 'CUSTOMER');
    check('3: a mixed-customer selection under scope=CUSTOMER is still rejected (MIXED_CUSTOMER_SELECTION)', wrongScope.status === 400 && wrongScope.body.error?.code === 'MIXED_CUSTOMER_SELECTION', wrongScope.body);

    const result = await massApprove(adminToken, [{ itemKey: keyA }, { itemKey: keyB }], 'WEEK');
    check('3b: scope=WEEK atomically confirms both customers in one call', result.status === 200 && result.body.itemCount === 2, result.body);
    check('3c: finalizedTimesheetIds contains this timesheet — both its customers are now covered', JSON.stringify(result.body.finalizedTimesheetIds) === JSON.stringify([ts.id]), result.body);

    const fresh = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('3d: Timesheet.status is FINAL_APPROVED after the single atomic whole-week operation', fresh.status === 'FINAL_APPROVED', fresh.status);
  }

  // ===============================================================================================
  // 4. UT9-A/B decision 4 — a mass CUSTOMER-scope operation spanning MULTIPLE workers/timesheets
  //    finalizes each Timesheet that reaches full coverage as a result, and leaves any Timesheet
  //    that still has an unconfirmed OTHER customer exactly as it was (never partially finalized).
  // ===============================================================================================
  {
    const site = await mkSite('T4');
    const wa = await mkWorkArea(site.id, 'T4');
    const siteOther = await mkSite('T4Other');
    const waOther = await mkWorkArea(siteOther.id, 'T4Other');
    const monday = nextMonday();

    // Worker A: ONLY this one customer -> mass-confirming it will fully cover and finalize.
    const empA = await mkWorker('T4A');
    const { ts: tsA } = await buildDraft(empA.id, site.id, wa.id, monday);
    await submitDraft(empA.id, tsA.id);

    // Worker B: this customer PLUS another, unconfirmed one -> mass-confirming only this customer
    // must leave worker B's timesheet un-finalized.
    const empB = await mkWorker('T4B');
    const { ts: tsB } = await buildTwoCustomerDraft(empB.id, monday, [
      { dayOffset: 0, siteId: site.id, workAreaId: wa.id },
      { dayOffset: 1, siteId: siteOther.id, workAreaId: waOther.id }
    ]);
    await submitDraft(empB.id, tsB.id);

    const keyA = { timesheetId: tsA.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const keyB = { timesheetId: tsB.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const result = await massApprove(adminToken, [{ itemKey: keyA }, { itemKey: keyB }], 'CUSTOMER');
    check('4: mass CUSTOMER-scope confirmation of both workers succeeds', result.status === 200 && result.body.itemCount === 2, result.body);
    check('4b: finalizedTimesheetIds contains ONLY worker A\'s timesheet (fully covered)', JSON.stringify(result.body.finalizedTimesheetIds) === JSON.stringify([tsA.id]), result.body);

    const freshA = await prisma.timesheet.findUniqueOrThrow({ where: { id: tsA.id }, select: { status: true } });
    const freshB = await prisma.timesheet.findUniqueOrThrow({ where: { id: tsB.id }, select: { status: true } });
    check('4c: worker A Timesheet.status is FINAL_APPROVED', freshA.status === 'FINAL_APPROVED', freshA.status);
    check('4d: worker B Timesheet.status is left exactly as it was (NOT finalized — the other customer is still unconfirmed)', freshB.status !== 'FINAL_APPROVED', freshB.status);
  }

  // ===============================================================================================
  // 5. UT9-A/B decision 5 — the admin can finalize WITHOUT a foreman review, even when a real,
  //    currently-active ForemanAssignment exists for the site (which the OLD /admin/review
  //    "Утвердить табель" flow would have blocked with FOREMAN_REVIEW_PENDING).
  // ===============================================================================================
  {
    const site = await mkSite('T5');
    const wa = await mkWorkArea(site.id, 'T5');
    const monday = nextMonday();
    const emp = await mkWorker('T5');
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);

    // A real, currently-active foreman for this exact site — exactly the condition that blocks the
    // OLD adminApproveTimesheet path with FOREMAN_REVIEW_PENDING.
    const foremanUser = await prisma.user.create({ data: { username: `ut9-foreman-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
    await prisma.foremanAssignment.create({ data: { siteId: site.id, foremanUserId: foremanUser.id, assignedByUserId: adminUserId, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null } });

    const key = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const approved = await approveWeek(adminToken, key);
    check('5: confirming the (only) customer succeeds despite an active foreman on this site', approved.status === 200 && approved.body.result === 'APPROVED', approved.body);
    check('5b: finalizedTimesheetIds contains this timesheet — foreman review was never required', JSON.stringify(approved.body.finalizedTimesheetIds) === JSON.stringify([ts.id]), approved.body);

    const fresh = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('5c: Timesheet.status is FINAL_APPROVED (the foreman-pending gate never applied here)', fresh.status === 'FINAL_APPROVED', fresh.status);
  }

  // ===============================================================================================
  // 6. UT9-A/B decision 6 — self-approval (the confirming admin IS the timesheet's own worker) is
  //    allowed, with no warning and no block, for the new finalization path.
  // ===============================================================================================
  {
    const site = await mkSite('T6');
    const wa = await mkWorkArea(site.id, 'T6');
    const monday = nextMonday();
    const emp = await mkWorker('T6');
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);

    // An ADMIN session whose OWN employeeId is this exact worker — genuine self-approval.
    const selfToken = await makeSession('ADMIN', emp.id);

    const key = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const approved = await approveWeek(selfToken, key);
    check('6: self-approval succeeds (no SELF_APPROVAL_FORBIDDEN)', approved.status === 200 && approved.body.result === 'APPROVED', approved.body);
    check('6b: finalizedTimesheetIds contains this timesheet', JSON.stringify(approved.body.finalizedTimesheetIds) === JSON.stringify([ts.id]), approved.body);

    const fresh = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('6c: Timesheet.status is FINAL_APPROVED after self-approval', fresh.status === 'FINAL_APPROVED', fresh.status);
  }

  // ===============================================================================================
  // 7. UT9-A/B decision 9 — the TIMESHEET_AWAITING_APPROVAL notification carries the exact
  //    employeeId + period dates the redirect uses to land on the exact worker/period (see
  //    components/admin/NotificationCenter.tsx's handleView — pure client-side routing, verified
  //    here at the data layer it actually reads).
  // ===============================================================================================
  {
    const site = await mkSite('T7');
    const wa = await mkWorkArea(site.id, 'T7');
    const monday = nextMonday();
    const emp = await mkWorker('T7');
    const { ts, period } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);

    const { ensureTimesheetApprovalNotifications } = await import('../lib/timesheet-approval-notifications');
    await ensureTimesheetApprovalNotifications();
    const notification = await prisma.adminNotification.findFirst({ where: { type: 'TIMESHEET_AWAITING_APPROVAL', timesheetId: ts.id, resolvedAt: null } });
    check('7: a TIMESHEET_AWAITING_APPROVAL notification exists for this submission', !!notification, notification);
    check('7b: it carries the exact employeeId (what the redirect uses, never a name/number substring match)', notification?.employeeId === emp.id, notification);

    const { listActiveNotificationsForAdmin } = await import('../lib/qualification-notifications');
    const adminForList = await prisma.user.create({ data: { username: `ut9-list-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
    const active = await listActiveNotificationsForAdmin(adminForList.id);
    const view = active.find((n) => n.timesheetId === ts.id);
    check('7c: the notification view exposes the exact period start/end the redirect needs', view?.periodStartDate === isoDate(period.startDate) && view?.periodEndDate === isoDate(period.endDate), view);
  }

  // ===============================================================================================
  // 8. UT9-B-fixup #2 — a genuinely TECHNICAL failure while computing coverage (canonical source
  //    becomes unreadable) throws CustomerHoursFinalizationInvariantError and rolls back the WHOLE
  //    transaction — never silently swallowed into "not fully covered". Constructed the SAME way
  //    scripts/_test-worker-timesheet-reconciliation.ts's own source-unreadable fixture is (a direct
  //    DB corruption unreachable through the app's own write surface — currentVersionId nulled,
  //    status left SUBMITTED — the owner's own "as far as possible without a production debug flag"
  //    instruction).
  //
  //    Note on WHY this tests computeTimesheetCustomerHoursCoverage directly rather than only
  //    through attemptTimesheetFinalization: Timesheet.currentVersionId carries a COMPOSITE FK to
  //    TimesheetVersion(id, timesheetId) — Postgres itself rejects pointing it at a non-existent or
  //    mismatched-timesheet version, so the only DB-constructible corruption is null. But
  //    attemptTimesheetFinalization's OWN status-eligibility check (`!ts.currentVersionId`) already
  //    catches currentVersionId===null and returns NOT_ELIGIBLE_STATUS *before* ever calling
  //    computeTimesheetCustomerHoursCoverage — a second, independent, correct line of defense, not a
  //    gap. This block therefore proves TWO things separately: (8d-8h) the exported
  //    computeTimesheetCustomerHoursCoverage function itself throws (never returns a soft false) for
  //    this technical failure, rolling back a transaction it participates in; (8i) the actual
  //    wired-in entry point, attemptTimesheetFinalization, independently refuses to even reach that
  //    far for the one DB-constructible corruption, and does so WITHOUT throwing (graceful, since a
  //    merely ineligible status is not itself a technical failure).
  // ===============================================================================================
  {
    const siteA = await mkSite('T8A');
    const waA = await mkWorkArea(siteA.id, 'T8A');
    const siteB = await mkSite('T8B');
    const waB = await mkWorkArea(siteB.id, 'T8B');
    const monday = nextMonday();
    const emp = await mkWorker('T8');
    const { ts } = await buildTwoCustomerDraft(emp.id, monday, [
      { dayOffset: 0, siteId: siteA.id, workAreaId: waA.id },
      { dayOffset: 1, siteId: siteB.id, workAreaId: waB.id }
    ]);
    await submitDraft(emp.id, ts.id);

    // Confirm ONLY customer A — genuine, expected PARTIAL_COVERAGE (customer B is untouched), never
    // an error. Proves the "normal partial coverage" path is unaffected by this fixup.
    const keyA = { timesheetId: ts.id, siteId: siteA.id, workAreaId: waA.id, weekStart: isoDate(monday) };
    const approvedA = await approveWeek(adminToken, keyA);
    check('8: confirming customer A alone succeeds (genuine partial coverage, not an error)', approvedA.status === 200 && approvedA.body.result === 'APPROVED', approvedA.body);
    check('8b: finalizedTimesheetIds is empty — customer B is still genuinely unconfirmed', Array.isArray(approvedA.body.finalizedTimesheetIds) && approvedA.body.finalizedTimesheetIds.length === 0, approvedA.body);
    const statusAfterPartial = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('8c: Timesheet.status still SUBMITTED after the genuine partial-coverage confirm', statusAfterPartial.status === 'SUBMITTED', statusAfterPartial.status);

    // Corrupt the canonical source directly — unreachable through the app's own write surface.
    await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: null } });

    // 8d-8h — computeTimesheetCustomerHoursCoverage itself, called directly, inside a transaction
    // that ALSO writes a marker audit event first — proving the throw rolls back the WHOLE
    // transaction it participates in, not just this one read. Same Employee->Timesheet lock order
    // every real caller already holds.
    const { computeTimesheetCustomerHoursCoverage } = await import('../lib/reporting/customer-hours-finalization');
    const markerEntityId = randomUUID();
    let threw = false;
    let errorMessage = '';
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
        await createAuditEvent(tx, { actorUserId: adminUserId, eventType: 'CUSTOMER_HOURS_APPROVED', entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM', entityId: markerEntityId, requestId: randomUUID(), afterValue: { marker: true } });
        await computeTimesheetCustomerHoursCoverage(tx, ts.id);
      });
    } catch (err) {
      threw = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    check('8d: computeTimesheetCustomerHoursCoverage throws (never silently returns fullyCovered:false) once the canonical source is unreadable', threw, errorMessage);
    check('8e: the thrown error is specifically CustomerHoursFinalizationInvariantError', errorMessage.includes('CUSTOMER_HOURS_FINALIZATION_INVARIANT_FAILURE'), errorMessage);
    const markerEvent = await prisma.auditEvent.findFirst({ where: { entityId: markerEntityId } });
    check('8f: the marker audit event written just before the throw was rolled back with everything else (whole transaction aborted)', markerEvent === null, markerEvent);

    const statusAfterFault = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { status: true } });
    check('8g: Timesheet.status is untouched by the failed coverage computation', statusAfterFault.status === 'SUBMITTED', statusAfterFault.status);
    const itemAStillCurrent = await prisma.customerHoursApprovalItem.findFirst({ where: { timesheetId: ts.id, siteId: siteA.id, workAreaId: waA.id, approvalState: 'CURRENT' } });
    check('8h: customer A\'s earlier, genuinely-successful confirmation is untouched', !!itemAStillCurrent, itemAStillCurrent);

    // 8i — the actual wired-in entry point independently refuses this same corrupted state, purely
    // via its own pre-existing status-eligibility check, WITHOUT reaching the throw at all — proving
    // no real caller of attemptTimesheetFinalization could ever hit an unhandled exception from this
    // particular (the only DB-constructible) corruption.
    const finalizationResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
      return attemptTimesheetFinalization(tx, ts.id, adminUserId, ['ADMIN'], randomUUID());
    });
    check(
      '8i: attemptTimesheetFinalization itself gracefully refuses (NOT_ELIGIBLE_STATUS, no throw) for the same corruption — its own earlier check is a second, independent line of defense',
      !finalizationResult.finalized && finalizationResult.reason === 'NOT_ELIGIBLE_STATUS',
      finalizationResult
    );
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
