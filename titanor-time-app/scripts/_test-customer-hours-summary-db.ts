// UT8-B — real-Postgres coverage for the new "Сводка" summary/export surface:
// lib/reporting/customer-hours-summary.ts (loadCustomerHoursSummary), GET
// /api/admin/time-ledger/summary, and GET /api/admin/time-ledger/summary/export. Needs a disposable
// PostgreSQL 16 (DATABASE_URL) with every migration applied and
// CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY + IDEMPOTENCY_ENCRYPTION_KEY set.

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, reopenWorkerTimesheetForEdits } from '../lib/worker-timesheets';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as previewPOST } from '../app/api/admin/time-ledger/approval-preview/route';
import { POST as commitPOST } from '../app/api/admin/time-ledger/approvals/route';
import { GET as summaryGET } from '../app/api/admin/time-ledger/summary/route';
import { GET as summaryExportGET } from '../app/api/admin/time-ledger/summary/export/route';
import { getTimeLedger } from '../lib/reporting/time-ledger';
import { loadCustomerHoursSummary } from '../lib/reporting/customer-hours-summary';

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
  return prisma.workSite.create({ data: { name: `SUM-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `SUM-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `SUM-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2037, 0, 5) + weekSlot * 14 * 86400000); // 2037-01-05 is a Monday
  weekSlot += 1;
  return d;
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
  return { period, ts, draft, asg };
}
async function submitDraft(employeeId: string, timesheetId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${timesheetId}::uuid FOR UPDATE`;
    return submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), SubmissionSource.MANUAL);
  });
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
async function mustReopen(employeeId: string, timesheetId: string): Promise<void> {
  const result = await reopenWorkerTimesheetForEdits(employeeId, timesheetId, adminUserId, randomUUID());
  if (result.code !== 'REOPENED') {
    throw new Error(`reopenWorkerTimesheetForEdits failed unexpectedly: ${JSON.stringify(result)}`);
  }
}
async function makeSession(roleName: string, employeeId: string | null = null): Promise<string> {
  const user = await prisma.user.create({ data: { username: `sum-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
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
async function approveWeek(sessionToken: string, itemKey: unknown): Promise<{ status: number; body: any }> {
  const preview = await realPreview(sessionToken, itemKey);
  if (preview.status !== 200 || !preview.body.confirmationToken) return preview;
  return commitJson(sessionToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
}
async function summaryJson(sessionToken: string | null, filters: { siteId?: string; workAreaId?: string; startDate: string; endDate: string; allTime?: boolean }): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams();
  if (filters.allTime) qs.set('allTime', 'true');
  else {
    qs.set('startDate', filters.startDate);
    qs.set('endDate', filters.endDate);
  }
  if (filters.siteId) qs.set('siteId', filters.siteId);
  if (filters.workAreaId) qs.set('workAreaId', filters.workAreaId);
  const res = await summaryGET(jsonReq(`http://localhost/api/admin/time-ledger/summary?${qs.toString()}`, sessionToken, null, {}, false, 'GET'));
  return { status: res.status, body: await res.json() };
}
async function exportReq(sessionToken: string | null, filters: { siteId?: string; workAreaId?: string; startDate: string; endDate: string }, format: 'csv' | 'pdf', mode: 'preview' | 'final') {
  const qs = new URLSearchParams({ startDate: filters.startDate, endDate: filters.endDate, format, mode });
  if (filters.siteId) qs.set('siteId', filters.siteId);
  if (filters.workAreaId) qs.set('workAreaId', filters.workAreaId);
  return summaryExportGET(jsonReq(`http://localhost/api/admin/time-ledger/summary/export?${qs.toString()}`, sessionToken, null, {}, false, 'GET'));
}

async function main() {
  const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `sum-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: adminRole.id } } } });
  adminUserId = admin.id;
  const adminToken = await makeSession('ADMIN');

  // ===============================================================================================
  // 1. Confirmed / pending / changed are counted correctly, with the right minutes and worker
  //    counts, and match getTimeLedger's own numbers for the same filter exactly.
  // ===============================================================================================
  {
    const site = await mkSite('T1');
    const wa = await mkWorkArea(site.id, 'T1');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empConfirmed = await mkWorker('Confirmed');
    const { ts: tsConfirmed } = await buildDraft(empConfirmed.id, site.id, wa.id, monday);
    await submitDraft(empConfirmed.id, tsConfirmed.id);
    const keyConfirmed = { timesheetId: tsConfirmed.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const approved = await approveWeek(adminToken, keyConfirmed);
    check('1: confirmed worker approved', approved.status === 200 && approved.body.result === 'APPROVED', approved.body);

    const empPending = await mkWorker('Pending');
    const { ts: tsPending } = await buildDraft(empPending.id, site.id, wa.id, monday);
    await submitDraft(empPending.id, tsPending.id);

    const empChanged = await mkWorker('Changed');
    const { ts: tsChanged, draft: draftChanged } = await buildDraft(empChanged.id, site.id, wa.id, monday);
    await submitDraft(empChanged.id, tsChanged.id);
    const keyChanged = { timesheetId: tsChanged.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, keyChanged);
    await mustReopen(empChanged.id, tsChanged.id);
    const segChanged = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draftChanged.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: segChanged.id }, data: { endAt: at(monday, 17) } });
    await submitDraft(empChanged.id, tsChanged.id);

    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const summary = await summaryJson(adminToken, filters);
    check('1b: 200 OK', summary.status === 200, summary.body);
    // 07:00-15:00 (8h gross) resolves to 450 min worked — this codebase's company-wide auto-unpaid-
    // break policy deducts a default 30 min whenever no break was logged and gross is long enough,
    // independently of TimesheetDraftPlannedShift.plannedBreakMinutes (set to 0 in buildDraft above).
    check('1c: confirmedMinutes = 450 (8h gross minus the default auto-unpaid-break, Confirmed worker unchanged)', summary.body.totals.confirmedMinutes === 450, summary.body.totals);
    check('1d: confirmedWorkerCount = 1', summary.body.totals.confirmedWorkerCount === 1, summary.body.totals);
    check('1e: pendingWorkerCount = 1 (Pending, never approved)', summary.body.totals.pendingWorkerCount === 1, summary.body.totals);
    check('1f: changedWorkerCount = 1 (Changed, edited after approval)', summary.body.totals.changedWorkerCount === 1, summary.body.totals);
    check('1g: changedMinutes = 570 (10h gross minus the default auto-unpaid-break, the NEW live minutes for the changed worker)', summary.body.totals.changedMinutes === 570, summary.body.totals);
    check('1h: readyForCustomerExport is false (pending + changed both block it)', summary.body.readyForCustomerExport === false, summary.body);
    check('1i: blockers list has exactly 2 entries (Pending + Changed)', summary.body.blockers.length === 2, summary.body.blockers);

    // Cross-check: the SAME confirmedMinutes must equal the sum of APPROVED rows' workedMinutes in
    // getTimeLedger's own output for this exact filter — never a second, independent computation.
    const ledger = await getTimeLedger(
      { allTime: false, requestedRange: { startDate: filters.startDate, endDate: filters.endDate }, employeeSearch: null, employeeId: null, siteId: site.id, workAreaId: wa.id, status: 'all', onlyIssues: false, onlyChangedAfterApproval: false, submissionState: 'all', submissionSource: 'all', page: 1, pageSize: 50 },
      { userId: adminUserId, employeeId: null }
    );
    const ledgerApprovedMinutes = ledger.customerGroups.flatMap((g) => g.rows).filter((r) => r.approvalState === 'APPROVED').reduce((s, r) => s + r.workedMinutes, 0);
    check('1j: summary.confirmedMinutes matches getTimeLedger APPROVED rows exactly (same source, no recompute)', summary.body.totals.confirmedMinutes === ledgerApprovedMinutes, { summary: summary.body.totals.confirmedMinutes, ledger: ledgerApprovedMinutes });

    // UT8-B-fixup #5 — byCustomer carries HOURS (pendingMinutes/changedMinutes), not just a row
    // count, and they match the top-level totals exactly (only one customer is in scope here).
    check('1k: byCustomer has exactly one customer (site+wa)', summary.body.byCustomer.length === 1, summary.body.byCustomer);
    const custRow = summary.body.byCustomer[0];
    check('1l: byCustomer.pendingMinutes matches totals.pendingMinutes (450)', custRow?.pendingMinutes === summary.body.totals.pendingMinutes && custRow?.pendingMinutes === 450, custRow);
    check('1m: byCustomer.changedMinutes matches totals.changedMinutes (570)', custRow?.changedMinutes === summary.body.totals.changedMinutes && custRow?.changedMinutes === 570, custRow);
    check('1n: byCustomer.confirmedMinutes matches totals.confirmedMinutes (450)', custRow?.confirmedMinutes === summary.body.totals.confirmedMinutes, custRow);
  }

  // ===============================================================================================
  // 2. Historical (removed slice) and source-unreadable rows are excluded from every total, and
  //    only the source-unreadable one produces a blocker.
  // ===============================================================================================
  {
    const site = await mkSite('T2');
    const waRemoved = await mkWorkArea(site.id, 'T2-removed');
    const waUnreadable = await mkWorkArea(site.id, 'T2-unreadable');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empRemoved = await mkWorker('Removed');
    const { ts: tsRemoved, draft: draftRemoved } = await buildDraft(empRemoved.id, site.id, waRemoved.id, monday);
    await submitDraft(empRemoved.id, tsRemoved.id);
    const keyRemoved = { timesheetId: tsRemoved.id, siteId: site.id, workAreaId: waRemoved.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, keyRemoved);
    await mustReopen(empRemoved.id, tsRemoved.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draftRemoved.id } });
    await submitDraft(empRemoved.id, tsRemoved.id);

    const empUnreadable = await mkWorker('Unread');
    const { ts: tsUnreadable } = await buildDraft(empUnreadable.id, site.id, waUnreadable.id, monday);
    await submitDraft(empUnreadable.id, tsUnreadable.id);
    const keyUnreadable = { timesheetId: tsUnreadable.id, siteId: site.id, workAreaId: waUnreadable.id, weekStart: isoDate(monday) };
    await approveWeek(adminToken, keyUnreadable);
    await prisma.timesheet.update({ where: { id: tsUnreadable.id }, data: { currentVersionId: null } });

    const filters = { siteId: site.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const summary = await summaryJson(adminToken, filters);
    check('2: 200 OK', summary.status === 200, summary.body);
    check('2b: confirmedMinutes is 0 — neither historical row counts as confirmed', summary.body.totals.confirmedMinutes === 0, summary.body.totals);
    check('2c: historicalCount is 2 (removed + unreadable)', summary.body.totals.historicalCount === 2, summary.body.totals);
    check('2d: exactly ONE blocker (the source-unreadable one — a genuinely removed slice never blocks)', summary.body.blockers.length === 1, summary.body.blockers);
    check('2e: the one blocker has reason SOURCE_UNREADABLE', summary.body.blockers[0]?.reason === 'SOURCE_UNREADABLE', summary.body.blockers);
  }

  // ===============================================================================================
  // 3. Filters (siteId/workAreaId/employeeSearch) scope the summary correctly — no cross-customer
  //    leakage.
  // ===============================================================================================
  {
    const siteA = await mkSite('T3A');
    const waA = await mkWorkArea(siteA.id, 'T3A');
    const siteB = await mkSite('T3B');
    const waB = await mkWorkArea(siteB.id, 'T3B');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empA = await mkWorker('SiteA');
    const { ts: tsA } = await buildDraft(empA.id, siteA.id, waA.id, monday);
    await submitDraft(empA.id, tsA.id);
    await approveWeek(adminToken, { timesheetId: tsA.id, siteId: siteA.id, workAreaId: waA.id, weekStart: isoDate(monday) });

    const empB = await mkWorker('SiteB');
    const { ts: tsB } = await buildDraft(empB.id, siteB.id, waB.id, monday);
    await submitDraft(empB.id, tsB.id);
    await approveWeek(adminToken, { timesheetId: tsB.id, siteId: siteB.id, workAreaId: waB.id, weekStart: isoDate(monday) });

    const summaryA = await summaryJson(adminToken, { siteId: siteA.id, workAreaId: waA.id, startDate: isoDate(monday), endDate: isoDate(sunday) });
    check('3: siteA/workAreaA scope sees only its own customer', summaryA.body.byCustomer.length === 1 && summaryA.body.byCustomer[0].siteId === siteA.id, summaryA.body.byCustomer);
    check('3b: siteA scope confirmedWorkerCount is 1 (not 2)', summaryA.body.totals.confirmedWorkerCount === 1, summaryA.body.totals);
  }

  // ===============================================================================================
  // 4. Final export: blocked while any part of the scope is unconfirmed, listing specific
  //    workers/weeks; preview is always allowed; audit is written only on a successful final export.
  // ===============================================================================================
  {
    const site = await mkSite('T4');
    const wa = await mkWorkArea(site.id, 'T4');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    const emp = await mkWorker('T4');
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    // Deliberately NOT approved yet.

    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(sunday) };

    const auditBefore = await prisma.auditEvent.count({ where: { eventType: 'REPORT_EXPORTED', entityType: 'CUSTOMER_HOURS_SUMMARY' } });

    const previewCsv = await exportReq(adminToken, filters, 'csv', 'preview');
    check('4: preview CSV succeeds even though nothing is confirmed', previewCsv.status === 200, previewCsv.status);
    const previewPdf = await exportReq(adminToken, filters, 'pdf', 'preview');
    check('4b: preview PDF also succeeds', previewPdf.status === 200, previewPdf.status);

    const finalCsvBlocked = await exportReq(adminToken, filters, 'csv', 'final');
    check('4c: final CSV is blocked (409) while unconfirmed', finalCsvBlocked.status === 409, finalCsvBlocked.status);
    const finalBlockedBody = await finalCsvBlocked.json();
    check('4d: 409 body names the specific worker', finalBlockedBody.error?.code === 'NOT_READY_FOR_EXPORT' && finalBlockedBody.error?.blockers?.some((b: any) => b.employeeId === emp.id), finalBlockedBody);

    const auditAfterBlocked = await prisma.auditEvent.count({ where: { eventType: 'REPORT_EXPORTED', entityType: 'CUSTOMER_HOURS_SUMMARY' } });
    check('4e: no audit event was written for preview or a blocked final attempt', auditAfterBlocked === auditBefore, { auditBefore, auditAfterBlocked });

    await approveWeek(adminToken, { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) });
    const finalCsvOk = await exportReq(adminToken, filters, 'csv', 'final');
    check('4f: final CSV succeeds once the whole scope is confirmed', finalCsvOk.status === 200, finalCsvOk.status);
    check('4g: final CSV Content-Disposition is attachment', (finalCsvOk.headers.get('content-disposition') ?? '').includes('attachment'), finalCsvOk.headers.get('content-disposition'));

    const auditAfterFinal = await prisma.auditEvent.count({ where: { eventType: 'REPORT_EXPORTED', entityType: 'CUSTOMER_HOURS_SUMMARY' } });
    check('4h: exactly one audit event was written for the successful final export', auditAfterFinal === auditBefore + 1, { auditBefore, auditAfterFinal });
  }

  // ===============================================================================================
  // 5. Range/selection limits — allTime rejected, >6 weeks rejected, >maxSlices rejected — never a
  //    silent truncation.
  // ===============================================================================================
  {
    const site = await mkSite('T5');
    const wa = await mkWorkArea(site.id, 'T5');
    const monday = nextMonday();

    const allTimeRes = await summaryJson(adminToken, { siteId: site.id, workAreaId: wa.id, startDate: '', endDate: '', allTime: true });
    check('5: allTime=true -> 400 ALL_TIME_NOT_ALLOWED', allTimeRes.status === 400 && allTimeRes.body.error?.code === 'ALL_TIME_NOT_ALLOWED', allTimeRes.body);

    const tooLongEnd = new Date(monday.getTime() + 60 * 86400000); // ~8.5 weeks, comfortably over 6
    const tooLongRes = await summaryJson(adminToken, { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(tooLongEnd) });
    check('5b: >6-week range -> 400 RANGE_TOO_LARGE', tooLongRes.status === 400 && tooLongRes.body.error?.code === 'RANGE_TOO_LARGE', tooLongRes.body);

    // SELECTION_TOO_LARGE via the direct, server-side-only maxSlices override (never reachable via
    // the HTTP route) — build 3 real approved slices, then call the library function with maxSlices=2.
    const emps = await Promise.all([mkWorker('Sel1'), mkWorker('Sel2'), mkWorker('Sel3')]);
    for (const e of emps) {
      const { ts: t } = await buildDraft(e.id, site.id, wa.id, monday);
      await submitDraft(e.id, t.id);
    }
    const outcome = await loadCustomerHoursSummary(
      { allTime: false, requestedRange: { startDate: isoDate(monday), endDate: isoDate(new Date(monday.getTime() + 6 * 86400000)) }, employeeSearch: null, siteId: site.id, workAreaId: wa.id },
      { userId: adminUserId, employeeId: null },
      prisma,
      2
    );
    check('5c: maxSlices=2 with 3 real slices -> SELECTION_TOO_LARGE, not a truncated result', !outcome.ok && outcome.reason === 'SELECTION_TOO_LARGE', outcome);
  }

  // ===============================================================================================
  // 6. Permissions — 403 without timesheet.read.all (summary), 403 without export.read (export).
  // ===============================================================================================
  {
    const site = await mkSite('T6');
    const wa = await mkWorkArea(site.id, 'T6');
    const monday = nextMonday();
    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(new Date(monday.getTime() + 6 * 86400000)) };

    const workerRole = await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } });
    const workerUser = await prisma.user.create({ data: { username: `sum-worker-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: workerRole.id } } } });
    const workerToken = generateSessionToken();
    await prisma.userSession.create({ data: { userId: workerUser.id, tokenHash: hashSessionToken(workerToken), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });

    const summaryForbidden = await summaryJson(workerToken, filters);
    check('6: WORKER role lacking timesheet.read.all -> summary 403', summaryForbidden.status === 403, summaryForbidden.body);

    const exportForbidden = await exportReq(workerToken, filters, 'csv', 'preview');
    check('6b: WORKER role lacking export.read -> export 403', exportForbidden.status === 403, exportForbidden.status);

    const noAuth = await summaryJson(null, filters);
    check('6c: no session -> summary 401', noAuth.status === 401, noAuth.body);
  }

  // ===============================================================================================
  // 7. UT8-B-fixup #1 — a truncated historical list blocks the final export with its own explicit
  //    HISTORICAL_INCOMPLETE reason, even when every real confirmed/pending row in scope is fine.
  // ===============================================================================================
  {
    const site = await mkSite('T7');
    const waA = await mkWorkArea(site.id, 'T7A');
    const waB = await mkWorkArea(site.id, 'T7B');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    // Two genuinely removed (SLICE_REMOVED) historical rows on different customers under the SAME
    // site, so historicalOutcome would normally return both — deliberately capped to 1 below.
    const empA = await mkWorker('T7A');
    const { ts: tsA, draft: draftA } = await buildDraft(empA.id, site.id, waA.id, monday);
    await submitDraft(empA.id, tsA.id);
    await approveWeek(adminToken, { timesheetId: tsA.id, siteId: site.id, workAreaId: waA.id, weekStart: isoDate(monday) });
    await mustReopen(empA.id, tsA.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draftA.id } });
    await submitDraft(empA.id, tsA.id);

    const empB = await mkWorker('T7B');
    const { ts: tsB, draft: draftB } = await buildDraft(empB.id, site.id, waB.id, monday);
    await submitDraft(empB.id, tsB.id);
    await approveWeek(adminToken, { timesheetId: tsB.id, siteId: site.id, workAreaId: waB.id, weekStart: isoDate(monday) });
    await mustReopen(empB.id, tsB.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draftB.id } });
    await submitDraft(empB.id, tsB.id);

    const notTruncated = await loadCustomerHoursSummary(
      { allTime: false, requestedRange: { startDate: isoDate(monday), endDate: isoDate(sunday) }, employeeSearch: null, siteId: site.id, workAreaId: null },
      { userId: adminUserId, employeeId: null },
      prisma,
      undefined,
      10 // generous historical cap -> both rows fit, nothing truncated
    );
    check('7: not truncated -> historicalTruncated=false, readyForCustomerExport true (nothing else in scope)', notTruncated.ok && notTruncated.totals.historicalTruncated === false && notTruncated.readyForCustomerExport === true, notTruncated);

    const truncated = await loadCustomerHoursSummary(
      { allTime: false, requestedRange: { startDate: isoDate(monday), endDate: isoDate(sunday) }, employeeSearch: null, siteId: site.id, workAreaId: null },
      { userId: adminUserId, employeeId: null },
      prisma,
      undefined,
      1 // only 1 of the 2 real historical rows fits -> truncated
    );
    check('7b: truncated -> historicalTruncated=true', truncated.ok && truncated.totals.historicalTruncated === true, truncated);
    check('7c: truncated -> readyForCustomerExport is FALSE even though every real row is otherwise fine', truncated.ok && truncated.readyForCustomerExport === false, truncated);
    check(
      '7d: exactly one HISTORICAL_INCOMPLETE blocker is present',
      truncated.ok && truncated.blockers.filter((b: any) => b.reason === 'HISTORICAL_INCOMPLETE').length === 1,
      truncated.ok ? truncated.blockers : truncated
    );
  }

  // ===============================================================================================
  // 8. UT8-B-fixup #2 — preview CSV explicitly lists historical + source-error rows (via the REAL
  //    export route), never folds their minutes into any total; final CSV never lists them.
  // ===============================================================================================
  {
    const site = await mkSite('T8');
    const wa = await mkWorkArea(site.id, 'T8');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empRemoved = await mkWorker('T8Removed');
    const { ts: tsRemoved, draft: draftRemoved } = await buildDraft(empRemoved.id, site.id, wa.id, monday);
    await submitDraft(empRemoved.id, tsRemoved.id);
    await approveWeek(adminToken, { timesheetId: tsRemoved.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) });
    await mustReopen(empRemoved.id, tsRemoved.id);
    await prisma.timesheetDraftSegment.deleteMany({ where: { draftId: draftRemoved.id } });
    await submitDraft(empRemoved.id, tsRemoved.id);

    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const previewCsvRes = await exportReq(adminToken, filters, 'csv', 'preview');
    check('8: preview CSV succeeds', previewCsvRes.status === 200, previewCsvRes.status);
    const previewCsvText = await previewCsvRes.text();
    check('8b: preview CSV lists the removed row under row_type HISTORICAL', previewCsvText.includes('HISTORICAL') && previewCsvText.includes('T8Removed'), previewCsvText.slice(0, 600));
    check('8c: preview CSV does not fold the historical row into a CUSTOMER_TOTAL (no DETAIL row exists for it)', !previewCsvText.split('\r\n').some((l) => l.startsWith('"DETAIL"') && l.includes('T8Removed')), previewCsvText.slice(0, 600));

    // A SEPARATE, fully-clean scope (a confirmed worker only) — final export must succeed and must
    // never mention HISTORICAL rows at all (none exist in THIS scope).
    const site2 = await mkSite('T8b');
    const wa2 = await mkWorkArea(site2.id, 'T8b');
    const empClean = await mkWorker('T8Clean');
    const { ts: tsClean } = await buildDraft(empClean.id, site2.id, wa2.id, monday);
    await submitDraft(empClean.id, tsClean.id);
    await approveWeek(adminToken, { timesheetId: tsClean.id, siteId: site2.id, workAreaId: wa2.id, weekStart: isoDate(monday) });
    const finalCsvRes = await exportReq(adminToken, { siteId: site2.id, workAreaId: wa2.id, startDate: isoDate(monday), endDate: isoDate(sunday) }, 'csv', 'final');
    check('8d: final export succeeds for the clean scope', finalCsvRes.status === 200, finalCsvRes.status);
    const finalCsvText = await finalCsvRes.text();
    check('8e: final CSV never contains a HISTORICAL row_type', !finalCsvText.includes('HISTORICAL'), finalCsvText.slice(0, 600));
  }

  // ===============================================================================================
  // 9. UT8-B-fixup #3 — audit is written only AFTER the file is fully built, and only a genuinely
  //    successful export (file + audit both present) is ever returned. True fault-injection into the
  //    content-generation step of the real route was not attempted here: both renderers are pure,
  //    synchronous-ish functions over already-validated data, and no construction was found that
  //    makes them fail for data the route itself would ever hand them (the unit test file instead
  //    proves they DO throw for genuinely malformed input, which is the failure mode this ordering
  //    protects against). This block re-verifies the POSITIVE property with the exact before/after
  //    bracketing the fixup asks for.
  // ===============================================================================================
  {
    const site = await mkSite('T9');
    const wa = await mkWorkArea(site.id, 'T9');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    const emp = await mkWorker('T9');
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    await approveWeek(adminToken, { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) });

    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const auditBefore = await prisma.auditEvent.count({ where: { eventType: 'REPORT_EXPORTED', entityType: 'CUSTOMER_HOURS_SUMMARY' } });
    const res = await exportReq(adminToken, filters, 'pdf', 'final');
    check('9: final PDF export succeeds', res.status === 200, res.status);
    const pdfBytes = new Uint8Array(await res.arrayBuffer());
    check('9b: the response body is a real, non-empty PDF', pdfBytes.length > 4 && String.fromCharCode(...pdfBytes.slice(0, 4)) === '%PDF', pdfBytes.length);
    const auditAfter = await prisma.auditEvent.count({ where: { eventType: 'REPORT_EXPORTED', entityType: 'CUSTOMER_HOURS_SUMMARY' } });
    check('9c: exactly one new audit event exists once the (real, non-empty) file was returned', auditAfter === auditBefore + 1, { auditBefore, auditAfter });
  }

  // ===============================================================================================
  // 10. UT8-B-fixup #4 — a repeated format or mode query parameter is rejected outright (400), never
  //     silently resolved to its first value.
  // ===============================================================================================
  {
    const site = await mkSite('T10');
    const wa = await mkWorkArea(site.id, 'T10');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const dupFormatRes = await summaryExportGET(
      jsonReq(`http://localhost/api/admin/time-ledger/summary/export?startDate=${isoDate(monday)}&endDate=${isoDate(sunday)}&siteId=${site.id}&workAreaId=${wa.id}&format=csv&format=pdf&mode=preview`, adminToken, null, {}, false, 'GET')
    );
    check('10: repeated format -> 400 VALIDATION_ERROR', dupFormatRes.status === 400, dupFormatRes.status);
    const dupFormatBody = await dupFormatRes.json();
    check('10b: fieldErrors names format', !!dupFormatBody.error?.fieldErrors?.format, dupFormatBody);

    const dupModeRes = await summaryExportGET(
      jsonReq(`http://localhost/api/admin/time-ledger/summary/export?startDate=${isoDate(monday)}&endDate=${isoDate(sunday)}&siteId=${site.id}&workAreaId=${wa.id}&format=csv&mode=preview&mode=final`, adminToken, null, {}, false, 'GET')
    );
    check('10c: repeated mode -> 400 VALIDATION_ERROR', dupModeRes.status === 400, dupModeRes.status);
    const dupModeBody = await dupModeRes.json();
    check('10d: fieldErrors names mode', !!dupModeBody.error?.fieldErrors?.mode, dupModeBody);
  }

  // ===============================================================================================
  // 11. UT8-B-fixup-2 — ledgerResult.notSubmitted must not be silently ignored: a confirmed worker
  //     plus an EXPECTED worker with no submitted timesheet at all in the same scope must still block
  //     final export and name the missing worker; preview stays available regardless.
  // ===============================================================================================
  {
    const site = await mkSite('T11');
    const wa = await mkWorkArea(site.id, 'T11');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empConfirmed = await mkWorker('T11Confirmed');
    const { ts, period } = await buildDraft(empConfirmed.id, site.id, wa.id, monday);
    await submitDraft(empConfirmed.id, ts.id);
    await approveWeek(adminToken, { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) });

    // Expected worker: has a live SiteAssignment at this site (so the siteId filter includes them)
    // and an expected=true PayrollPeriodParticipant for the SAME period, but deliberately NO
    // Timesheet/draft at all — exactly loadMissingTimesheetParticipants' own "missing" case.
    const empMissing = await mkWorker('T11Missing');
    await mkAssignment(empMissing.id, site.id, wa.id);
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: empMissing.id, expected: true } });

    // Deliberately NO workAreaId here — getTimeLedger's own Tier-2 filter drops every non-slice
    // entry (including NOT_SUBMITTED) once a workAreaId is set, so this scope is scoped by siteId
    // only, the one filter combination this bug can actually surface under.
    const filters = { siteId: site.id, startDate: isoDate(monday), endDate: isoDate(sunday) };

    const summary = await summaryJson(adminToken, filters);
    check('11: 200 OK', summary.status === 200, summary.body);
    check('11b: notSubmittedCount is 1', summary.body.totals.notSubmittedCount === 1, summary.body.totals);
    check('11c: notSubmittedWorkerCount is 1', summary.body.totals.notSubmittedWorkerCount === 1, summary.body.totals);
    check('11d: readyForCustomerExport is FALSE even though the other worker is fully confirmed', summary.body.readyForCustomerExport === false, summary.body);
    const notSubmittedBlocker = summary.body.blockers.find((b: any) => b.reason === 'NOT_SUBMITTED');
    check('11e: a NOT_SUBMITTED blocker exists and names the missing worker specifically', !!notSubmittedBlocker && notSubmittedBlocker.employeeId === empMissing.id, summary.body.blockers);

    const previewRes = await exportReq(adminToken, filters, 'csv', 'preview');
    check('11f: preview export still succeeds (200) despite the missing worker', previewRes.status === 200, previewRes.status);
    const previewText = await previewRes.text();
    check('11g: preview CSV explicitly names the missing worker under row_type NOT_SUBMITTED', previewText.includes('NOT_SUBMITTED') && previewText.includes('T11Missing'), previewText.slice(0, 600));

    const finalRes = await exportReq(adminToken, filters, 'csv', 'final');
    check('11h: final export is blocked (409 NOT_READY_FOR_EXPORT)', finalRes.status === 409, finalRes.status);
    const finalBody = await finalRes.json();
    check('11i: the 409 body names the missing worker specifically', finalBody.error?.code === 'NOT_READY_FOR_EXPORT' && finalBody.error?.blockers?.some((b: any) => b.reason === 'NOT_SUBMITTED' && b.employeeId === empMissing.id), finalBody);
  }

  // ===============================================================================================
  // 12. UT8-B-fixup-3 #1 — with an explicit workAreaId selected (the primary customer-export
  //     scenario), getTimeLedger's own Tier-2 filter would drop EVERY NotSubmittedRow. A worker
  //     with a historical SiteAssignment at exactly the selected (siteId, workAreaId) but no
  //     submitted timesheet at all must still block final and appear in preview; a worker assigned
  //     to a DIFFERENT work area at the same site must NOT block the selected scope.
  // ===============================================================================================
  {
    const site = await mkSite('T12');
    const waTarget = await mkWorkArea(site.id, 'T12-target');
    const waOther = await mkWorkArea(site.id, 'T12-other');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empConfirmed = await mkWorker('T12Confirmed');
    const { ts, period } = await buildDraft(empConfirmed.id, site.id, waTarget.id, monday);
    await submitDraft(empConfirmed.id, ts.id);
    await approveWeek(adminToken, { timesheetId: ts.id, siteId: site.id, workAreaId: waTarget.id, weekStart: isoDate(monday) });

    // Assigned to the TARGET work area, no Timesheet at all -> must block the waTarget-scoped export.
    const empMissingTarget = await mkWorker('T12MissingTarget');
    await mkAssignment(empMissingTarget.id, site.id, waTarget.id);
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: empMissingTarget.id, expected: true } });

    // Assigned to a DIFFERENT work area at the same site, no Timesheet at all -> must NOT block the
    // waTarget-scoped export (not a provable assignment to the selected customer).
    const empMissingOther = await mkWorker('T12MissingOther');
    await mkAssignment(empMissingOther.id, site.id, waOther.id);
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: empMissingOther.id, expected: true } });

    const filters = { siteId: site.id, workAreaId: waTarget.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const summary = await summaryJson(adminToken, filters);
    check('12: 200 OK', summary.status === 200, summary.body);
    check('12b: notSubmittedCount is 1 (only the target-work-area worker)', summary.body.totals.notSubmittedCount === 1, summary.body.totals);
    const notSubmittedBlocker = summary.body.blockers.find((b: any) => b.reason === 'NOT_SUBMITTED');
    check('12c: the NOT_SUBMITTED blocker names the target-work-area worker specifically', !!notSubmittedBlocker && notSubmittedBlocker.employeeId === empMissingTarget.id, summary.body.blockers);
    check('12d: the other-work-area worker is NOT among the blockers', !summary.body.blockers.some((b: any) => b.employeeId === empMissingOther.id), summary.body.blockers);
    check('12e: readyForCustomerExport is FALSE', summary.body.readyForCustomerExport === false, summary.body);

    const previewRes = await exportReq(adminToken, filters, 'csv', 'preview');
    check('12f: preview export succeeds (200)', previewRes.status === 200, previewRes.status);
    const previewText = await previewRes.text();
    check('12g: preview CSV names the target-work-area missing worker under NOT_SUBMITTED', previewText.includes('NOT_SUBMITTED') && previewText.includes('T12MissingTarget'), previewText.slice(0, 600));
    check('12h: preview CSV does NOT mention the other-work-area missing worker', !previewText.includes('T12MissingOther'), previewText.slice(0, 600));

    const finalRes = await exportReq(adminToken, filters, 'csv', 'final');
    check('12i: final export is blocked (409)', finalRes.status === 409, finalRes.status);
  }

  // ===============================================================================================
  // 13. UT8-B-fixup-3 #2 — a slice can be admin-approved while the worker never actually submitted
  //     the timesheet (submissionState stays NOT_SUBMITTED on a still-DRAFT Timesheet — a deliberate,
  //     separate feature of the approval workflow). Such a row must never count as confirmedMinutes
  //     and must still block final as its own NOT_SUBMITTED blocker, WITH its real hours and
  //     site/week attribution (unlike the entirely-missing case in block 12).
  // ===============================================================================================
  {
    const site = await mkSite('T13');
    const wa = await mkWorkArea(site.id, 'T13');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const emp = await mkWorker('T13');
    const { ts } = await buildDraft(emp.id, site.id, wa.id, monday);
    // Deliberately NOT submitted — Timesheet.status stays DRAFT, submissionState stays NOT_SUBMITTED.
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };
    const approved = await approveWeek(adminToken, itemKey);
    check('13: admin can approve a still-unsubmitted draft slice (existing, separate approval-workflow feature)', approved.status === 200 && approved.body.result === 'APPROVED', approved.body);

    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const summary = await summaryJson(adminToken, filters);
    check('13b: 200 OK', summary.status === 200, summary.body);
    check('13c: confirmedMinutes is 0 — an admin-approved-but-unsubmitted draft never counts as confirmed', summary.body.totals.confirmedMinutes === 0, summary.body.totals);
    check('13d: confirmedWorkerCount is 0', summary.body.totals.confirmedWorkerCount === 0, summary.body.totals);
    const notSubmittedBlocker = summary.body.blockers.find((b: any) => b.reason === 'NOT_SUBMITTED');
    check(
      '13e: a NOT_SUBMITTED blocker exists for this worker, with real hours-bearing attribution (siteId/weekStart present, unlike the entirely-missing case)',
      !!notSubmittedBlocker && notSubmittedBlocker.employeeId === emp.id && notSubmittedBlocker.siteId === site.id && notSubmittedBlocker.weekStart === isoDate(monday),
      summary.body.blockers
    );
    check('13f: readyForCustomerExport is FALSE', summary.body.readyForCustomerExport === false, summary.body);

    const finalRes = await exportReq(adminToken, filters, 'csv', 'final');
    check('13g: final export is blocked (409)', finalRes.status === 409, finalRes.status);

    const previewRes = await exportReq(adminToken, filters, 'csv', 'preview');
    check('13h: preview export succeeds (200)', previewRes.status === 200, previewRes.status);
    const previewText = await previewRes.text();
    check('13i: preview CSV has a DETAIL row for this worker labeled not_submitted (real hours, not confirmed)', previewText.split('\r\n').some((l) => l.startsWith('"DETAIL"') && l.includes('T13') && l.includes('not_submitted')), previewText.slice(0, 800));
  }

  // ===============================================================================================
  // 14. UT8-B-fixup-3 #2 regression — a genuinely SUBMITTED slice must NEVER be caught by the new
  //     submissionState guard: after submit/resubmit without a fresh matching confirmation it stays
  //     PENDING/CHANGED_AFTER_APPROVAL (not NOT_SUBMITTED) and blocks final; once a fresh
  //     confirmation matches the current content, final is allowed.
  // ===============================================================================================
  {
    const site = await mkSite('T14');
    const wa = await mkWorkArea(site.id, 'T14');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const emp = await mkWorker('T14');
    const { ts, draft } = await buildDraft(emp.id, site.id, wa.id, monday);
    await submitDraft(emp.id, ts.id);
    const itemKey = { timesheetId: ts.id, siteId: site.id, workAreaId: wa.id, weekStart: isoDate(monday) };

    const filters = { siteId: site.id, workAreaId: wa.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const afterSubmit = await summaryJson(adminToken, filters);
    // Reason may be PENDING or NEEDS_ATTENTION here (a fresh never-approved slice can carry its own
    // pre-existing warning, unrelated to this fixup) — the actual regression is that it is one of
    // the NORMAL, already-existing reasons and specifically NOT the new NOT_SUBMITTED reclassification.
    check(
      '14: after submit, no approval yet -> a normal PENDING/NEEDS_ATTENTION blocker (never NOT_SUBMITTED)',
      afterSubmit.status === 200 &&
        afterSubmit.body.blockers.length === 1 &&
        (afterSubmit.body.blockers[0].reason === 'PENDING' || afterSubmit.body.blockers[0].reason === 'NEEDS_ATTENTION') &&
        afterSubmit.body.blockers[0].employeeId === emp.id,
      afterSubmit.body
    );

    await approveWeek(adminToken, itemKey);
    await mustReopen(emp.id, ts.id);
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: draft.id } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(monday, 17) } });
    await submitDraft(emp.id, ts.id); // resubmit — no fresh confirmation yet

    const afterResubmit = await summaryJson(adminToken, filters);
    check(
      '14b: after resubmit without a fresh confirmation -> CHANGED_AFTER_APPROVAL blocks (not NOT_SUBMITTED)',
      afterResubmit.status === 200 && afterResubmit.body.blockers.length === 1 && afterResubmit.body.blockers[0].reason === 'CHANGED_AFTER_APPROVAL' && afterResubmit.body.blockers[0].employeeId === emp.id,
      afterResubmit.body
    );

    const finalBlocked = await exportReq(adminToken, filters, 'csv', 'final');
    check('14c: final still blocked (409) before the fresh confirmation', finalBlocked.status === 409, finalBlocked.status);

    await approveWeek(adminToken, itemKey); // fresh confirmation matching the current content
    const afterFreshApproval = await summaryJson(adminToken, filters);
    check('14d: after a fresh matching confirmation, readyForCustomerExport is TRUE', afterFreshApproval.body.readyForCustomerExport === true, afterFreshApproval.body);

    const finalOk = await exportReq(adminToken, filters, 'csv', 'final');
    check('14e: final export now succeeds (200)', finalOk.status === 200, finalOk.status);
  }

  // ===============================================================================================
  // 15. UT8-B-fixup-4 — a REAL HTTP request with workAreaId set but NO siteId at all (exactly what
  //     LedgerFilterBar.pickCustomer sends — it never includes siteId). A worker assigned to the
  //     selected customer via SiteAssignment.workAreaId with no submitted timesheet must still block
  //     final and show up in preview; a worker assigned to a DIFFERENT customer must not block.
  // ===============================================================================================
  {
    const site = await mkSite('T15');
    const waTarget = await mkWorkArea(site.id, 'T15-target');
    const waOther = await mkWorkArea(site.id, 'T15-other');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const empConfirmed = await mkWorker('T15Confirmed');
    const { ts, period } = await buildDraft(empConfirmed.id, site.id, waTarget.id, monday);
    await submitDraft(empConfirmed.id, ts.id);
    await approveWeek(adminToken, { timesheetId: ts.id, siteId: site.id, workAreaId: waTarget.id, weekStart: isoDate(monday) });

    // Assigned to the TARGET customer, no Timesheet at all -> must block.
    const empMissingTarget = await mkWorker('T15MissingTarget');
    await mkAssignment(empMissingTarget.id, site.id, waTarget.id);
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: empMissingTarget.id, expected: true } });

    // Assigned to a DIFFERENT customer (different workAreaId, same site), no Timesheet at all ->
    // must NOT block the waTarget-scoped export.
    const empMissingOther = await mkWorker('T15MissingOther');
    await mkAssignment(empMissingOther.id, site.id, waOther.id);
    await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: empMissingOther.id, expected: true } });

    // Deliberately NO siteId here — this is the exact shape LedgerFilterBar.pickCustomer sends.
    const filters = { workAreaId: waTarget.id, startDate: isoDate(monday), endDate: isoDate(sunday) };
    const summary = await summaryJson(adminToken, filters);
    check('15: 200 OK with workAreaId only (no siteId), the real UI request shape', summary.status === 200, summary.body);
    check('15b: notSubmittedCount is 1 (only the target-customer worker)', summary.body.totals.notSubmittedCount === 1, summary.body.totals);
    const notSubmittedBlocker = summary.body.blockers.find((b: any) => b.reason === 'NOT_SUBMITTED');
    check('15c: the NOT_SUBMITTED blocker names the target-customer worker specifically', !!notSubmittedBlocker && notSubmittedBlocker.employeeId === empMissingTarget.id, summary.body.blockers);
    check('15d: the other-customer worker is NOT among the blockers', !summary.body.blockers.some((b: any) => b.employeeId === empMissingOther.id), summary.body.blockers);
    check('15e: readyForCustomerExport is FALSE', summary.body.readyForCustomerExport === false, summary.body);

    const previewRes = await exportReq(adminToken, filters, 'csv', 'preview');
    check('15f: preview export succeeds (200) with workAreaId only', previewRes.status === 200, previewRes.status);
    const previewText = await previewRes.text();
    check('15g: preview CSV names the target-customer missing worker under NOT_SUBMITTED', previewText.includes('NOT_SUBMITTED') && previewText.includes('T15MissingTarget'), previewText.slice(0, 600));
    check('15h: preview CSV does NOT mention the other-customer missing worker', !previewText.includes('T15MissingOther'), previewText.slice(0, 600));

    const finalRes = await exportReq(adminToken, filters, 'csv', 'final');
    check('15i: final export is blocked (409) with workAreaId only, no siteId', finalRes.status === 409, finalRes.status);
    const finalBody = await finalRes.json();
    check('15j: the 409 body names the target-customer worker specifically', finalBody.error?.blockers?.some((b: any) => b.reason === 'NOT_SUBMITTED' && b.employeeId === empMissingTarget.id), finalBody);
  }

  // ===============================================================================================
  // 16. UT8-B-fixup-4 #3 — workAreaId='none' (the explicit "no customer" bucket) with NO siteId is a
  //     genuinely ambiguous scope for NOT_SUBMITTED attribution (it would mean "every site's
  //     no-work-area assignments, company-wide") and is refused outright rather than silently
  //     widened; the same combination WITH a siteId is unaffected and works normally.
  // ===============================================================================================
  {
    const site = await mkSite('T16');
    const monday = nextMonday();
    const sunday = new Date(monday.getTime() + 6 * 86400000);

    const noSiteRes = await summaryJson(adminToken, { workAreaId: 'none', startDate: isoDate(monday), endDate: isoDate(sunday) });
    check('16: workAreaId=none without siteId -> 400 WORK_AREA_NONE_REQUIRES_SITE', noSiteRes.status === 400 && noSiteRes.body.error?.code === 'WORK_AREA_NONE_REQUIRES_SITE', noSiteRes.body);

    const withSiteRes = await summaryJson(adminToken, { siteId: site.id, workAreaId: 'none', startDate: isoDate(monday), endDate: isoDate(sunday) });
    check('16b: the SAME workAreaId=none, but WITH siteId -> 200 OK (unaffected)', withSiteRes.status === 200, withSiteRes.body);

    const exportNoSiteRes = await exportReq(adminToken, { workAreaId: 'none', startDate: isoDate(monday), endDate: isoDate(sunday) }, 'csv', 'preview');
    check('16c: the export route rejects the same combination too (400 WORK_AREA_NONE_REQUIRES_SITE)', exportNoSiteRes.status === 400, exportNoSiteRes.status);
    const exportNoSiteBody = await exportNoSiteRes.json();
    check('16d: export 400 body carries the same error code', exportNoSiteBody.error?.code === 'WORK_AREA_NONE_REQUIRES_SITE', exportNoSiteBody);
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
