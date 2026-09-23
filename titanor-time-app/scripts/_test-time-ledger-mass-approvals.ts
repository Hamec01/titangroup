// UT6-B — real-Postgres coverage for POST /api/admin/time-ledger/mass-approval-preview and
// POST /api/admin/time-ledger/mass-approvals: multi-item selection, mixed new/superseded/
// already-approved/warning outcomes, whole-batch atomicity on a technical blocker or a stale item,
// self-approval/open-shift as warnings (never blockers) inside a mass selection, lock ordering under
// concurrency, idempotency, snapshots, and audit. Needs a disposable PostgreSQL 16 (DATABASE_URL)
// with every migration applied and CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY set (scripts/
// run-tests.mjs's db lane provisions it). Route-handler-direct-call convention, same as
// scripts/_test-time-ledger-approvals.ts — no HTTP server needed.

import { randomUUID, createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as massPreviewPOST } from '../app/api/admin/time-ledger/mass-approval-preview/route';
import { POST as massCommitPOST } from '../app/api/admin/time-ledger/mass-approvals/route';

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

// -------------------------------------------------------------------------------------------------
// Fixtures — same conventions as scripts/_test-time-ledger-approvals.ts.
// -------------------------------------------------------------------------------------------------

let adminUserId = '';

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `MAPV-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `MAPV-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `MAPV-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
}
async function mkOpenShift(employeeId: string, siteId: string, workAreaId: string | null, openedAt: Date) {
  const evtId = randomUUID();
  await prisma.clockEvent.create({
    data: {
      id: evtId,
      employeeId,
      operationType: 'CHECK_IN',
      siteId,
      clientCapturedAt: openedAt,
      capturedOffline: false,
      serverReceivedAt: openedAt,
      effectiveAt: openedAt,
      gpsVerification: 'NOT_VERIFIED',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: createHash('sha256').update(evtId).digest('hex'),
      requestId: randomUUID()
    }
  });
  return prisma.employeeOpenShift.create({ data: { employeeId, openedByClockEventId: evtId, siteId, workAreaId, openedAt } });
}

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let weekSlot = 0;
function nextMonday(): Date {
  const d = new Date(Date.UTC(2033, 0, 3) + weekSlot * 14 * 86400000); // 2033-01-03 is a Monday
  weekSlot += 1;
  return d;
}

async function buildDraft(employeeId: string, siteId: string, workAreaId: string | null, monday: Date) {
  const period = await prisma.payrollPeriod.create({ data: { startDate: monday, endDate: new Date(monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
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
async function submitDraft(employeeId: string, timesheetId: string, source: SubmissionSource = SubmissionSource.MANUAL) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), source);
  });
}

async function mkCustomerWorker(site: { id: string }, workArea: { id: string } | null, tag: string, source: SubmissionSource = SubmissionSource.MANUAL) {
  const emp = await mkWorker(tag);
  const monday = nextMonday();
  const { ts } = await buildDraft(emp.id, site.id, workArea?.id ?? null, monday);
  await submitDraft(emp.id, ts.id, source);
  return { employee: emp, timesheetId: ts.id, monday, site, workArea };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function itemKeyOf(f: { timesheetId: string; site: { id: string }; workArea: { id: string } | null; monday: Date }) {
  return { timesheetId: f.timesheetId, siteId: f.site.id, workAreaId: f.workArea?.id ?? null, weekStart: isoDate(f.monday) };
}

// -------------------------------------------------------------------------------------------------
// Session / request helpers.
// -------------------------------------------------------------------------------------------------

async function makeSession(roleName: string, employeeId: string | null = null): Promise<string> {
  const user = await prisma.user.create({ data: { username: `mapv-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return token;
}

function jsonReq(url: string, sessionToken: string | null, body: unknown, extraHeaders: Record<string, string> = {}, csrf = true): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrf) headers.set('x-requested-with', 'titanor-time');
  if (sessionToken) headers.set('cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function massPreviewJson(sessionToken: string | null, selection: unknown, csrf = true): Promise<{ status: number; body: any }> {
  const res = await massPreviewPOST(jsonReq('http://localhost/api/admin/time-ledger/mass-approval-preview', sessionToken, { selection }, {}, csrf));
  return { status: res.status, body: await res.json() };
}
async function massCommitJson(sessionToken: string | null, selection: unknown, confirmationToken: string, idempotencyKey = randomUUID(), csrf = true): Promise<{ status: number; body: any }> {
  const res = await massCommitPOST(jsonReq('http://localhost/api/admin/time-ledger/mass-approvals', sessionToken, { selection, confirmationToken }, { 'idempotency-key': idempotencyKey }, csrf));
  return { status: res.status, body: await res.json() };
}

/** The realistic client flow: a throwaway preview with a dummy fingerprint per item to learn the
 *  real ones (mirrors _test-time-ledger-approvals.ts's realPreview, generalized to N items — the
 *  real UI reads currentFingerprint off already-fetched ledger rows instead, this is just how a test
 *  learns it without duplicating buildWeeklyCustomerSlices). */
async function realMassSelection(sessionToken: string, itemKeys: { timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string }[]): Promise<{ itemKey: any; expectedFingerprint: string }[]> {
  const bootstrap = await massPreviewJson(sessionToken, itemKeys.map((k) => ({ itemKey: k, expectedFingerprint: '0'.repeat(64) })));
  return bootstrap.body.items.map((it: any) => ({ itemKey: { timesheetId: it.itemKey.timesheetId, siteId: it.itemKey.siteId, workAreaId: it.itemKey.workAreaId, weekStart: it.itemKey.weekStart }, expectedFingerprint: it.currentFingerprint }));
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `mapv-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;
  const adminToken = await makeSession('ADMIN');

  // ===============================================================================================
  // 1. Clean multi-item mass approval — several new items, one batch, correct itemCount/workedMinutes.
  // ===============================================================================================
  {
    const site = await mkSite('T1');
    const wa = await mkWorkArea(site.id, 'T1');
    const w1 = await mkCustomerWorker(site, wa, 'T1a');
    const w2 = await mkCustomerWorker(site, wa, 'T1b');
    const w3 = await mkCustomerWorker(site, wa, 'T1c');
    const keys = [itemKeyOf(w1), itemKeyOf(w2), itemKeyOf(w3)];
    const selection = await realMassSelection(adminToken, keys);

    const preview = await massPreviewJson(adminToken, selection);
    check('1: preview 200', preview.status === 200, preview.body);
    check('1b: summary.weekPartCount = 3', preview.body.summary.weekPartCount === 3, preview.body.summary);
    check('1c: summary.employeeCount = 3', preview.body.summary.employeeCount === 3, preview.body.summary);
    check('1d: every item WILL_APPROVE', preview.body.items.every((it: any) => it.outcome === 'WILL_APPROVE'), preview.body.items);
    check('1e: confirmationToken issued', typeof preview.body.confirmationToken === 'string', preview.body);

    const commit = await massCommitJson(adminToken, selection, preview.body.confirmationToken);
    check('1f: commit 200', commit.status === 200, commit.body);
    check('1g: itemCount = 3, alreadyApprovedCount = 0', commit.body.itemCount === 3 && commit.body.alreadyApprovedCount === 0, commit.body);
    check('1h: every result APPROVED with a real itemId', commit.body.results.every((r: any) => r.result === 'APPROVED' && typeof r.itemId === 'string'), commit.body.results);

    const batch = await prisma.customerHoursApprovalBatch.findUniqueOrThrow({ where: { id: commit.body.batchId } });
    check('1i: batch itemCount=3, workedMinutes=3*450', batch.itemCount === 3 && batch.workedMinutes === 3 * 450, batch);
    const snapshot = batch.selectionSnapshot as any;
    check('1j: selectionSnapshot mode=MASS with all 3 itemKeys', snapshot.mode === 'MASS' && Array.isArray(snapshot.itemKeys) && snapshot.itemKeys.length === 3, snapshot);

    const events = await prisma.auditEvent.findMany({ where: { requestId: commit.body.requestId }, orderBy: { createdAt: 'asc' } });
    // UT9-B — each of the 3 workers' timesheets has this as its ONLY customer, so this mass
    // approval also atomically finalizes all 3 (lib/reporting/customer-hours-finalization.ts): the
    // original 4 (1 batch-created + 3 approved) plus 3 finalization chains of 3 events each
    // (scope-approved, timesheet-foreman-approved, timesheet-final-approved) = 13.
    check('1k: 4 customer-hours events + 3x3 finalization events = 13 audit events', events.length === 13, events.map((e) => e.eventType));
    check('1l: first event is BATCH_CREATED', events[0]?.eventType === 'CUSTOMER_HOURS_APPROVAL_BATCH_CREATED', events[0]);
    check(
      '1m: finalizedTimesheetIds contains all 3 workers\' timesheets',
      Array.isArray(commit.body.finalizedTimesheetIds) && commit.body.finalizedTimesheetIds.length === 3 && keys.every((k) => commit.body.finalizedTimesheetIds.includes(k.timesheetId)),
      commit.body.finalizedTimesheetIds
    );
  }

  // ===============================================================================================
  // 2. Mixed outcomes in one selection: new + already-approved + warning, all in one commit.
  // ===============================================================================================
  {
    const site = await mkSite('T2');
    const wa = await mkWorkArea(site.id, 'T2');
    const wNew = await mkCustomerWorker(site, wa, 'T2New');
    const wAuto = await mkCustomerWorker(site, wa, 'T2Auto', SubmissionSource.AUTO); // AUTO submission -> warning, not a blocker
    const wAlready = await mkCustomerWorker(site, wa, 'T2Already');

    // Pre-approve wAlready with its real (unchanged) fingerprint via a first mass commit of just that one.
    const preApproveSelection = await realMassSelection(adminToken, [itemKeyOf(wAlready)]);
    const preApprovePreview = await massPreviewJson(adminToken, preApproveSelection);
    await massCommitJson(adminToken, preApproveSelection, preApprovePreview.body.confirmationToken);

    const keys = [itemKeyOf(wNew), itemKeyOf(wAuto), itemKeyOf(wAlready)];
    const selection = await realMassSelection(adminToken, keys);
    const preview = await massPreviewJson(adminToken, selection);
    check('2: outcomes are WILL_APPROVE / WILL_APPROVE(warning) / ALREADY_APPROVED_NOOP', true, preview.body.items.map((it: any) => it.outcome));
    const byOutcome = (o: string) => preview.body.items.filter((it: any) => it.outcome === o).length;
    check('2b: 2 WILL_APPROVE, 1 ALREADY_APPROVED_NOOP', byOutcome('WILL_APPROVE') === 2 && byOutcome('ALREADY_APPROVED_NOOP') === 1, preview.body.items);
    check('2c: the AUTO item carries an AUTOMATIC_SUBMISSION warning', preview.body.items.some((it: any) => it.warnings.some((w: any) => w.code === 'AUTOMATIC_SUBMISSION')), preview.body.items);
    check('2d: token still issued despite the warning (warnings never withhold it)', typeof preview.body.confirmationToken === 'string', preview.body);
    check('2e: alreadyApprovedCount = 1 in the summary', preview.body.summary.alreadyApprovedCount === 1, preview.body.summary);

    const commit = await massCommitJson(adminToken, selection, preview.body.confirmationToken);
    check('2f: commit 200', commit.status === 200, commit.body);
    check('2g: itemCount = 2 (only the actually-written items), alreadyApprovedCount = 1', commit.body.itemCount === 2 && commit.body.alreadyApprovedCount === 1, commit.body);
    const batch = await prisma.customerHoursApprovalBatch.findUniqueOrThrow({ where: { id: commit.body.batchId } });
    check('2h: batch.itemCount = 2 (excludes the already-approved no-op)', batch.itemCount === 2, batch);

    // UT6-A-R1 §3 (final decision) — the already-approved item creates NO audit event of its own.
    const alreadyItem = await prisma.customerHoursApprovalItem.findFirstOrThrow({ where: { timesheetId: wAlready.timesheetId } });
    const reconfirmedEvents = await prisma.auditEvent.findMany({ where: { entityId: alreadyItem.id, eventType: 'CUSTOMER_HOURS_APPROVAL_RECONFIRMED' } });
    check('2i: no RECONFIRMED audit event for the already-approved item in a mixed mass commit', reconfirmedEvents.length === 0, reconfirmedEvents);
  }

  // ===============================================================================================
  // 3. Whole selection already-approved -> zero writes, batchId null, no new audit events.
  // ===============================================================================================
  {
    const site = await mkSite('T3');
    const wa = await mkWorkArea(site.id, 'T3');
    const w1 = await mkCustomerWorker(site, wa, 'T3a');
    const w2 = await mkCustomerWorker(site, wa, 'T3b');
    const keys = [itemKeyOf(w1), itemKeyOf(w2)];
    const firstSelection = await realMassSelection(adminToken, keys);
    const firstPreview = await massPreviewJson(adminToken, firstSelection);
    await massCommitJson(adminToken, firstSelection, firstPreview.body.confirmationToken);

    const countBefore = await prisma.customerHoursApprovalItem.count();
    const auditCountBefore = await prisma.auditEvent.count();

    const secondSelection = await realMassSelection(adminToken, keys);
    const secondPreview = await massPreviewJson(adminToken, secondSelection);
    check('3: everything ALREADY_APPROVED_NOOP on the second pass', secondPreview.body.items.every((it: any) => it.outcome === 'ALREADY_APPROVED_NOOP'), secondPreview.body.items);
    const secondCommit = await massCommitJson(adminToken, secondSelection, secondPreview.body.confirmationToken);
    check('3b: commit 200, batchId null', secondCommit.status === 200 && secondCommit.body.batchId === null, secondCommit.body);
    check('3c: itemCount = 0, alreadyApprovedCount = 2', secondCommit.body.itemCount === 0 && secondCommit.body.alreadyApprovedCount === 2, secondCommit.body);

    const countAfter = await prisma.customerHoursApprovalItem.count();
    const auditCountAfter = await prisma.auditEvent.count();
    check('3d: no new CustomerHoursApprovalItem rows were created', countAfter === countBefore, { countBefore, countAfter });
    check('3e: no new AuditEvent rows were created', auditCountAfter === auditCountBefore, { auditCountBefore, auditCountAfter });
  }

  // ===============================================================================================
  // 4. Self-approval and open-shift inside a mass selection are warnings, never abort the batch.
  // ===============================================================================================
  {
    const site = await mkSite('T4');
    const wa = await mkWorkArea(site.id, 'T4');
    const wSelf = await mkCustomerWorker(site, wa, 'T4Self');
    const wOpenShift = await mkCustomerWorker(site, wa, 'T4Shift');
    await mkOpenShift(wOpenShift.employee.id, site.id, wa.id, at(wOpenShift.monday, 9));
    const selfToken = await makeSession('ADMIN', wSelf.employee.id);

    const keys = [itemKeyOf(wSelf), itemKeyOf(wOpenShift)];
    const selection = await realMassSelection(selfToken, keys);
    const preview = await massPreviewJson(selfToken, selection);
    check('4: SELF_APPROVAL_FORBIDDEN and OPEN_SHIFT both surface as warnings, never technicalBlocker', preview.body.items.every((it: any) => it.technicalBlocker === null), preview.body.items);
    check('4b: token issued despite both warnings', typeof preview.body.confirmationToken === 'string', preview.body);

    const commit = await massCommitJson(selfToken, selection, preview.body.confirmationToken);
    check('4c: commit succeeds for both, despite self-approval and an open shift', commit.status === 200 && commit.body.itemCount === 2, commit.body);
  }

  // ===============================================================================================
  // 5. A technical blocker on ONE item aborts the WHOLE transaction — nothing is written for ANY item.
  // ===============================================================================================
  {
    const site = await mkSite('T5');
    const wa = await mkWorkArea(site.id, 'T5');
    const wGood1 = await mkCustomerWorker(site, wa, 'T5Good1');
    const wGood2 = await mkCustomerWorker(site, wa, 'T5Good2');
    const wBad = await mkCustomerWorker(site, wa, 'T5Bad');

    const keys = [itemKeyOf(wGood1), itemKeyOf(wGood2), itemKeyOf(wBad)];
    const selection = await realMassSelection(adminToken, keys);
    const preview = await massPreviewJson(adminToken, selection);
    check('5: clean preview issues a token', typeof preview.body.confirmationToken === 'string', preview.body);

    // Corrupt wBad's canonical source AFTER the token was issued: status is SUBMITTED (VERSION-
    // sourced) but currentVersionId is nulled out, the exact invariant resolveCanonicalSource checks
    // -> SOURCE_ERROR, surfaced identically to a single-item commit's own SOURCE_ERROR path.
    await prisma.timesheet.update({ where: { id: wBad.timesheetId }, data: { currentVersionId: null } });

    const commit = await massCommitJson(adminToken, selection, preview.body.confirmationToken);
    check('5b: commit rejects the whole batch (SOURCE_ERROR on one item)', commit.status === 409 && commit.body.error?.code === 'SOURCE_ERROR', commit.body);
    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: { in: [wGood1.timesheetId, wGood2.timesheetId, wBad.timesheetId] } } });
    check('5c: NOTHING was written for ANY item, including the two clean ones', items === 0, items);
  }

  // ===============================================================================================
  // 6. A stale item anywhere in the selection aborts the whole batch.
  // ===============================================================================================
  {
    const site = await mkSite('T6');
    const wa = await mkWorkArea(site.id, 'T6');
    const wGood = await mkCustomerWorker(site, wa, 'T6Good');
    const wStale = await mkCustomerWorker(site, wa, 'T6Stale');

    const keys = [itemKeyOf(wGood), itemKeyOf(wStale)];
    const selection = await realMassSelection(adminToken, keys);
    const preview = await massPreviewJson(adminToken, selection);

    // Simulate a hours change on wStale after the preview — wStale is SUBMITTED (VERSION-sourced,
    // mkCustomerWorker always submits), so the canonical hours live in WorkSegment, not a draft.
    const staleVersionId = (await prisma.timesheet.findUniqueOrThrow({ where: { id: wStale.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    const seg = await prisma.workSegment.findFirstOrThrow({ where: { timesheetVersionId: staleVersionId } });
    await prisma.workSegment.update({ where: { id: seg.id }, data: { endAt: at(wStale.monday, 16) } });

    const commit = await massCommitJson(adminToken, selection, preview.body.confirmationToken);
    check('6: commit rejects the whole batch (APPROVAL_SELECTION_STALE)', commit.status === 409 && commit.body.error?.code === 'APPROVAL_SELECTION_STALE', commit.body);
    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: { in: [wGood.timesheetId, wStale.timesheetId] } } });
    check('6b: nothing was written for the clean item either (whole-batch rollback)', items === 0, items);
  }

  // ===============================================================================================
  // 7. Mixed-customer selection is rejected by the route itself (400 MIXED_CUSTOMER_SELECTION).
  // ===============================================================================================
  {
    const siteA = await mkSite('T7A');
    const siteB = await mkSite('T7B');
    const waA = await mkWorkArea(siteA.id, 'T7A');
    const waB = await mkWorkArea(siteB.id, 'T7B');
    const w1 = await mkCustomerWorker(siteA, waA, 'T7a');
    const w2 = await mkCustomerWorker(siteB, waB, 'T7b');
    const selection = [
      { itemKey: itemKeyOf(w1), expectedFingerprint: '0'.repeat(64) },
      { itemKey: itemKeyOf(w2), expectedFingerprint: '0'.repeat(64) }
    ];
    const preview = await massPreviewJson(adminToken, selection);
    check('7: mixed-customer selection -> 400 MIXED_CUSTOMER_SELECTION', preview.status === 400 && preview.body.error?.code === 'MIXED_CUSTOMER_SELECTION', preview.body);
  }

  // ===============================================================================================
  // 8. Idempotency — cached replay and same-key-different-body rejection.
  // ===============================================================================================
  {
    const site = await mkSite('T8');
    const wa = await mkWorkArea(site.id, 'T8');
    const w1 = await mkCustomerWorker(site, wa, 'T8a');
    const selection = await realMassSelection(adminToken, [itemKeyOf(w1)]);
    const preview = await massPreviewJson(adminToken, selection);
    const key = randomUUID();

    const first = await massCommitJson(adminToken, selection, preview.body.confirmationToken, key);
    check('8: first commit 200', first.status === 200, first.body);
    const replay = await massCommitJson(adminToken, selection, preview.body.confirmationToken, key);
    check('8b: cached replay returns the identical body, no new write', replay.status === 200 && replay.body.batchId === first.body.batchId, { first: first.body, replay: replay.body });
    const itemCount = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: w1.timesheetId } });
    check('8c: exactly one item exists after the replay', itemCount === 1, itemCount);

    const w2 = await mkCustomerWorker(site, wa, 'T8b');
    const otherSelection = await realMassSelection(adminToken, [itemKeyOf(w2)]);
    const otherPreview = await massPreviewJson(adminToken, otherSelection);
    const reused = await massCommitJson(adminToken, otherSelection, otherPreview.body.confirmationToken, key);
    check('8d: reusing the SAME key with a DIFFERENT selection -> 409 IDEMPOTENCY_KEY_REUSED', reused.status === 409 && reused.body.error?.code === 'IDEMPOTENCY_KEY_REUSED', reused.body);
  }

  // ===============================================================================================
  // 9. Idempotency request hash is invariant to the selection array's submitted order (UT6-A-R1 §18).
  // ===============================================================================================
  {
    const site = await mkSite('T9');
    const wa = await mkWorkArea(site.id, 'T9');
    const w1 = await mkCustomerWorker(site, wa, 'T9a');
    const w2 = await mkCustomerWorker(site, wa, 'T9b');
    const selection = await realMassSelection(adminToken, [itemKeyOf(w1), itemKeyOf(w2)]);
    const preview = await massPreviewJson(adminToken, selection);
    const key = randomUUID();

    const forward = await massCommitJson(adminToken, selection, preview.body.confirmationToken, key);
    check('9: first commit (forward order) 200', forward.status === 200, forward.body);
    const reversed = [...selection].reverse();
    const replayReversed = await massCommitJson(adminToken, reversed, preview.body.confirmationToken, key);
    check('9b: the SAME key with the SAME selection in REVERSED array order still hits the cache (no IDEMPOTENCY_KEY_REUSED)', replayReversed.status === 200 && replayReversed.body.batchId === forward.body.batchId, { forward: forward.body, replayReversed: replayReversed.body });
  }

  // ===============================================================================================
  // 10. Concurrent mass commits sharing an employee, in crossed selection order, never deadlock and
  //     serialize correctly (deterministic Employee -> Timesheet -> ... lock order, UT6-A-R1 §15).
  // ===============================================================================================
  {
    const site = await mkSite('T10');
    const wa = await mkWorkArea(site.id, 'T10');
    const wShared = await mkCustomerWorker(site, wa, 'T10Shared');
    const wOnlyA = await mkCustomerWorker(site, wa, 'T10OnlyA');
    const wOnlyB = await mkCustomerWorker(site, wa, 'T10OnlyB');

    const selA = await realMassSelection(adminToken, [itemKeyOf(wShared), itemKeyOf(wOnlyA)]);
    const selB = await realMassSelection(adminToken, [itemKeyOf(wOnlyB), itemKeyOf(wShared)]); // crossed order
    const previewA = await massPreviewJson(adminToken, selA);
    const previewB = await massPreviewJson(adminToken, selB);

    const [resA, resB] = await Promise.all([massCommitJson(adminToken, selA, previewA.body.confirmationToken), massCommitJson(adminToken, selB, previewB.body.confirmationToken)]);
    const statuses = [resA.status, resB.status].sort();
    // Exactly one succeeds cleanly; the other either succeeds too (if it happened to run first and
    // the shared item simply changed hands cleanly between two DIFFERENT selections — both are valid
    // approvals of the same slice, just at different times) or gets a 409 on the now-stale shared
    // item — never a deadlock/timeout (never a 500) and never a corrupted partial write.
    check('10: both concurrent mass commits complete without a deadlock/timeout (never a 500)', resA.status !== 500 && resB.status !== 500, { resA: resA.body, resB: resB.body });
    check('10b: at least one of the two crossed-order concurrent commits succeeds', statuses.includes(200), { resA: resA.status, resB: resB.status });
    const sharedItems = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: wShared.timesheetId, approvalState: 'CURRENT' } });
    check('10c: exactly one CURRENT approval item for the shared slice afterward', sharedItems === 1, sharedItems);
  }

  // ===============================================================================================
  // 11. Superseded item — changed-after-approval inside a mass selection creates SUPERSEDED + a new
  //     CURRENT, with history intact.
  // ===============================================================================================
  {
    const site = await mkSite('T11');
    const wa = await mkWorkArea(site.id, 'T11');
    const w1 = await mkCustomerWorker(site, wa, 'T11a');
    const firstSelection = await realMassSelection(adminToken, [itemKeyOf(w1)]);
    const firstPreview = await massPreviewJson(adminToken, firstSelection);
    const firstCommit = await massCommitJson(adminToken, firstSelection, firstPreview.body.confirmationToken);
    const originalItemId = firstCommit.body.results[0].itemId;

    const versionId11 = (await prisma.timesheet.findUniqueOrThrow({ where: { id: w1.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    const seg = await prisma.workSegment.findFirstOrThrow({ where: { timesheetVersionId: versionId11 } });
    await prisma.workSegment.update({ where: { id: seg.id }, data: { endAt: at(w1.monday, 17) } });

    const secondSelection = await realMassSelection(adminToken, [itemKeyOf(w1)]);
    const secondPreview = await massPreviewJson(adminToken, secondSelection);
    check('11: outcome WILL_SUPERSEDE_AND_APPROVE after the edit', secondPreview.body.items[0].outcome === 'WILL_SUPERSEDE_AND_APPROVE', secondPreview.body.items);
    const secondCommit = await massCommitJson(adminToken, secondSelection, secondPreview.body.confirmationToken);
    check('11b: commit 200, supersededItemId points at the original item', secondCommit.status === 200 && secondCommit.body.results[0].supersededItemId === originalItemId, secondCommit.body);

    const original = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: originalItemId } });
    check('11c: original item is now SUPERSEDED', original.approvalState === 'SUPERSEDED', original);
    const current = await prisma.customerHoursApprovalItem.findFirstOrThrow({ where: { timesheetId: w1.timesheetId, approvalState: 'CURRENT' } });
    check('11d: a new CURRENT item exists with the new (larger) workedMinutes', current.id !== originalItemId && current.workedMinutes > original.workedMinutes, { original, current });
  }

  // ===============================================================================================
  // 12. CSRF / auth / permission / selection-size-limit on the mass routes.
  // ===============================================================================================
  {
    const site = await mkSite('T12');
    const wa = await mkWorkArea(site.id, 'T12');
    const w1 = await mkCustomerWorker(site, wa, 'T12a');
    const rawSelection = [{ itemKey: itemKeyOf(w1), expectedFingerprint: '0'.repeat(64) }];

    const noCsrf = await massPreviewJson(adminToken, rawSelection, false);
    check('12: missing CSRF header -> 403 CSRF_REJECTED', noCsrf.status === 403 && noCsrf.body.error?.code === 'CSRF_REJECTED', noCsrf.body);

    const noAuth = await massPreviewJson(null, rawSelection);
    check('12b: no session -> 401 NOT_AUTHENTICATED', noAuth.status === 401 && noAuth.body.error?.code === 'NOT_AUTHENTICATED', noAuth.body);

    const workerRole = await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } });
    const workerUser = await prisma.user.create({ data: { username: `mapv-worker-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: workerRole.id } } } });
    const workerToken = generateSessionToken();
    await prisma.userSession.create({ data: { userId: workerUser.id, tokenHash: hashSessionToken(workerToken), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
    const forbidden = await massPreviewJson(workerToken, rawSelection);
    check('12c: WORKER role -> 403 FORBIDDEN', forbidden.status === 403 && forbidden.body.error?.code === 'FORBIDDEN', forbidden.body);

    const emptySelection = await massPreviewJson(adminToken, []);
    check('12d: empty selection -> 400 EMPTY_SELECTION', emptySelection.status === 400 && emptySelection.body.error?.code === 'EMPTY_SELECTION', emptySelection.body);

    const noIdempotency = await massCommitPOST(new NextRequest('http://localhost/api/admin/time-ledger/mass-approvals', { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json', 'x-requested-with': 'titanor-time', cookie: `${SESSION_COOKIE_NAME}=${adminToken}` }), body: JSON.stringify({ selection: rawSelection, confirmationToken: 'x' }) }));
    const noIdempotencyBody = await noIdempotency.json();
    check('12e: missing Idempotency-Key on commit -> 400', noIdempotency.status === 400, noIdempotencyBody);
  }

  // ===============================================================================================
  // 13. UT6-B-fixup #1 — a token issued for one selection is REJECTED against a different selection,
  //     even though every item in the new selection is individually clean. Proves the server-side
  //     defense the UI's selection-lock is backed by: a stale token can never be laundered onto a
  //     changed selection by resubmitting a different body with the old token.
  // ===============================================================================================
  {
    const site = await mkSite('T13');
    const wa = await mkWorkArea(site.id, 'T13');
    const w1 = await mkCustomerWorker(site, wa, 'T13a');
    const w2 = await mkCustomerWorker(site, wa, 'T13b');

    const selectionA = await realMassSelection(adminToken, [itemKeyOf(w1)]);
    const previewA = await massPreviewJson(adminToken, selectionA);
    check('13: preview A issues a token', typeof previewA.body.confirmationToken === 'string', previewA.body);

    // A DIFFERENT selection (adds w2) — every item in it independently valid, but the token was
    // never issued for this selectionHash.
    const selectionB = await realMassSelection(adminToken, [itemKeyOf(w1), itemKeyOf(w2)]);
    const commitWithOldToken = await massCommitJson(adminToken, selectionB, previewA.body.confirmationToken);
    check('13b: committing a DIFFERENT selection with selection A\'s token -> 403 CONFIRMATION_TOKEN_INVALID', commitWithOldToken.status === 403 && commitWithOldToken.body.error?.code === 'CONFIRMATION_TOKEN_INVALID', commitWithOldToken.body);

    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: { in: [w1.timesheetId, w2.timesheetId] } } });
    check('13c: nothing was written', items === 0, items);

    // The token still works for the EXACT selection it was issued for.
    const commitWithMatchingSelection = await massCommitJson(adminToken, selectionA, previewA.body.confirmationToken);
    check('13d: the same token still works for the selection it was actually issued for', commitWithMatchingSelection.status === 200, commitWithMatchingSelection.body);
  }

  // ===============================================================================================
  // 14. UT6-B-fixup #2 — preview's context carries a server-computed period (periodStart/periodEnd),
  //     never client-supplied, spanning the earliest weekStart to the latest week's Sunday across
  //     the selection. summary.weekPartCount replaces the ambiguous itemCount name.
  // ===============================================================================================
  {
    const site = await mkSite('T14');
    const wa = await mkWorkArea(site.id, 'T14');
    const w1 = await mkCustomerWorker(site, wa, 'T14a');
    // A second item two weeks later than w1, same customer, to prove the period spans BOTH weeks.
    weekSlot += 1; // skip one slot so w2's Monday is strictly after w1's
    const w2 = await mkCustomerWorker(site, wa, 'T14b');

    const selection = await realMassSelection(adminToken, [itemKeyOf(w1), itemKeyOf(w2)]);
    const preview = await massPreviewJson(adminToken, selection);
    check('14: context.periodStart is the EARLIEST selected weekStart', preview.body.context.periodStart === isoDate(w1.monday < w2.monday ? w1.monday : w2.monday), preview.body.context);
    const expectedLatestWeekStart = w1.monday > w2.monday ? w1.monday : w2.monday;
    const expectedPeriodEnd = isoDate(new Date(expectedLatestWeekStart.getTime() + 6 * 86400000));
    check('14b: context.periodEnd is the SUNDAY of the LATEST selected week', preview.body.context.periodEnd === expectedPeriodEnd, preview.body.context);
    check('14c: summary.weekPartCount replaces itemCount (itemCount is gone)', preview.body.summary.weekPartCount === 2 && preview.body.summary.itemCount === undefined, preview.body.summary);
    check('14d: context still carries siteName and workAreaName (заказчик/объект) alongside the period', typeof preview.body.context.siteName === 'string' && preview.body.context.siteName.length > 0 && typeof preview.body.context.workAreaName === 'string', preview.body.context);
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
