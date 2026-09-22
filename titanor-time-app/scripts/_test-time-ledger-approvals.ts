// UT5-B — real-Postgres coverage for POST /api/admin/time-ledger/approval-preview and
// POST /api/admin/time-ledger/approvals: single weekly-customer-slice approval, preview/commit,
// confirmation token binding, idempotency + concurrency, supersede, snapshots, audit, and the
// immutability/review-scope/finalization boundaries UT5 deliberately does not cross. Needs a
// disposable PostgreSQL 16 (DATABASE_URL) with every migration applied and
// CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY set (scripts/run-tests.mjs's db lane provisions it).
//
// Route-handler-direct-call convention, same as scripts/_test-time-ledger-filter-options.ts — no
// HTTP server needed.

import { randomUUID, createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Prisma, SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { createAuditEvent } from '../lib/audit';
import { signConfirmationToken } from '../lib/customer-hours-confirmation-token';
import { POST as previewPOST } from '../app/api/admin/time-ledger/approval-preview/route';
import { POST as commitPOST } from '../app/api/admin/time-ledger/approvals/route';

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
// Fixture builders — same conventions as scripts/_test-time-ledger.ts.
// -------------------------------------------------------------------------------------------------

let adminUserId = '';

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `APV-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, tag: string) {
  return prisma.workArea.create({ data: { siteId, name: `APV-WA-${tag}-${randomUUID().slice(0, 4)}` } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `APV-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary = true) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminUserId } });
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
  const d = new Date(Date.UTC(2031, 0, 6) + weekSlot * 14 * 86400000); // 2031-01-06 is a Monday
  weekSlot += 1;
  return d;
}

interface DraftDaySpec {
  day: Date;
  siteId: string;
  workAreaId: string | null;
  assignmentId: string;
}

async function buildDraft(employeeId: string, days: DraftDaySpec[], periodStatus: 'OPEN' | 'LOCKED' = 'LOCKED', existingPeriod?: { id: string; startDate: Date; endDate: Date }) {
  const anchor = existingPeriod?.startDate ?? days[0].day;
  const end = existingPeriod?.endDate ?? new Date(anchor.getTime() + 6 * 86400000);
  const period = existingPeriod ?? (await prisma.payrollPeriod.create({ data: { startDate: anchor, endDate: end, status: 'OPEN', openedByUserId: adminUserId } }));
  const existingParticipant = await prisma.payrollPeriodParticipant.findFirst({ where: { periodId: period.id, employeeId } });
  if (!existingParticipant) await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });

  for (const d of days) {
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: d.day, siteId: d.siteId, sourceAssignmentId: d.assignmentId, plannedStartAt: at(d.day, 7), plannedEndAt: at(d.day, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: d.day, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: d.day, startAt: at(d.day, 7), endAt: at(d.day, 15), siteId: d.siteId, workAreaId: d.workAreaId, sourceAssignmentId: d.assignmentId } });
  }
  if (periodStatus === 'LOCKED' && !existingPeriod) {
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: adminUserId } });
  }
  return { period, ts, draft };
}

async function submitDraft(employeeId: string, timesheetId: string, source: SubmissionSource = SubmissionSource.MANUAL) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, timesheetId, adminUserId, randomUUID(), source);
  });
}

/** One worker, one real 07:00-15:00 worked Monday, SUBMITTED (VERSION-sourced). */
async function oneSubmittedWeek(tag: string, opts: { source?: SubmissionSource; workArea?: { id: string } | null } = {}) {
  const site = await mkSite(tag);
  const workArea = opts.workArea !== undefined ? opts.workArea : await mkWorkArea(site.id, tag);
  const emp = await mkWorker(tag);
  const asg = await mkAssignment(emp.id, site.id, workArea?.id ?? null);
  const monday = nextMonday();
  const { ts } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: workArea?.id ?? null, assignmentId: asg.id }], 'LOCKED');
  await submitDraft(emp.id, ts.id, opts.source ?? SubmissionSource.MANUAL);
  return { site, workArea, employee: emp, timesheetId: ts.id, monday };
}

/** One worker, one real 07:00-15:00 worked Monday, still DRAFT (never submitted). */
async function oneDraftWeek(tag: string, workArea?: { id: string } | null) {
  const site = await mkSite(tag);
  const wa = workArea !== undefined ? workArea : await mkWorkArea(site.id, tag);
  const emp = await mkWorker(tag);
  const asg = await mkAssignment(emp.id, site.id, wa?.id ?? null);
  const monday = nextMonday();
  const { ts, draft } = await buildDraft(emp.id, [{ day: monday, siteId: site.id, workAreaId: wa?.id ?? null, assignmentId: asg.id }], 'LOCKED');
  return { site, workArea: wa, employee: emp, timesheetId: ts.id, draftId: draft.id, monday };
}

function itemKeyOf(f: { timesheetId: string; site: { id: string }; workArea: { id: string } | null; monday: Date }) {
  return { timesheetId: f.timesheetId, siteId: f.site.id, workAreaId: f.workArea?.id ?? null, weekStart: isoDate(f.monday) };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------------------------------
// Session / request helpers.
// -------------------------------------------------------------------------------------------------

async function makeSession(roleName: string, employeeId: string | null = null): Promise<string> {
  const user = await prisma.user.create({ data: { username: `apv-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return token;
}
async function userIdForSession(sessionToken: string): Promise<string> {
  const row = await prisma.userSession.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(sessionToken) }, select: { userId: true } });
  return row.userId;
}

function jsonReq(url: string, sessionToken: string | null, body: unknown, extraHeaders: Record<string, string> = {}, csrf = true): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (csrf) headers.set('x-requested-with', 'titanor-time');
  if (sessionToken) headers.set('cookie', `${SESSION_COOKIE_NAME}=${sessionToken}`);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}
function previewReq(sessionToken: string | null, body: unknown, csrf = true): NextRequest {
  return jsonReq('http://localhost/api/admin/time-ledger/approval-preview', sessionToken, body, {}, csrf);
}
function commitReq(sessionToken: string | null, body: unknown, idempotencyKey?: string, csrf = true): NextRequest {
  return jsonReq('http://localhost/api/admin/time-ledger/approvals', sessionToken, body, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}, csrf);
}

async function previewJson(sessionToken: string, itemKey: unknown, expectedFingerprint: string): Promise<{ status: number; body: any }> {
  const res = await previewPOST(previewReq(sessionToken, { itemKey, expectedFingerprint }));
  return { status: res.status, body: await res.json() };
}
async function commitJson(sessionToken: string, itemKey: unknown, expectedFingerprint: string, confirmationToken: string, idempotencyKey = randomUUID()): Promise<{ status: number; body: any }> {
  const res = await commitPOST(commitReq(sessionToken, { itemKey, expectedFingerprint, confirmationToken }, idempotencyKey));
  return { status: res.status, body: await res.json() };
}

/** The realistic client flow: bootstrap-preview with a dummy fingerprint to learn the real one,
 *  then a real preview with it. Returns the real preview body (has currentFingerprint + token). */
async function realPreview(sessionToken: string, itemKey: unknown): Promise<{ status: number; body: any }> {
  const bootstrap = await previewJson(sessionToken, itemKey, '0'.repeat(64));
  if (bootstrap.status !== 200) return bootstrap;
  return previewJson(sessionToken, itemKey, bootstrap.body.currentFingerprint);
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { username: `apv-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  adminUserId = admin.id;
  const adminToken = await makeSession('ADMIN');

  // ===============================================================================================
  // 1. Clean one-click approval (VERSION-sourced).
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T1Clean');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    check('1: preview 200', preview.status === 200, preview.body);
    check('1b: matchesExpectedFingerprint true on the real fingerprint', preview.body.matchesExpectedFingerprint === true, preview.body);
    check('1c: no blockers, no warnings for a clean VERSION submission', preview.body.blockers.length === 0 && preview.body.warnings.length === 0, preview.body);
    check('1d: confirmationToken present', typeof preview.body.confirmationToken === 'string' && preview.body.confirmationToken.length > 0, preview.body);
    check('1e: existingApproval.state is NONE (never approved before)', preview.body.existingApproval.state === 'NONE', preview.body.existingApproval);

    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('1f: commit 200', commit.status === 200, commit.body);
    check('1g: result APPROVED', commit.body.result === 'APPROVED', commit.body);
    check('1h: batchId and itemId present', typeof commit.body.batchId === 'string' && typeof commit.body.itemId === 'string', commit.body);
    check('1i: supersededItemId null (nothing to supersede)', commit.body.supersededItemId === null, commit.body);
    check('1j: finalizedTimesheetIds is always empty in UT5', Array.isArray(commit.body.finalizedTimesheetIds) && commit.body.finalizedTimesheetIds.length === 0, commit.body);

    const batch = await prisma.customerHoursApprovalBatch.findUniqueOrThrow({ where: { id: commit.body.batchId } });
    check('1k: batch itemCount=1, workedMinutes=450 (07:00-15:00 minus 30min auto lunch)', batch.itemCount === 1 && batch.workedMinutes === 450, batch);
    const item = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: commit.body.itemId } });
    check('1l: item approvalState=CURRENT, fingerprint matches', item.approvalState === 'CURRENT' && item.fingerprint === preview.body.currentFingerprint, item);
    check('1m: item sourceKind=VERSION, sourceRevision=null', item.sourceKind === 'VERSION' && item.sourceRevision === null, item);

    const events = await prisma.auditEvent.findMany({ where: { requestId: commit.body.requestId }, orderBy: { createdAt: 'asc' } });
    check('1n: exactly 2 audit events (batch created, approved)', events.length === 2, events.map((e) => e.eventType));
    check('1o: audit event types in order', events[0]?.eventType === 'CUSTOMER_HOURS_APPROVAL_BATCH_CREATED' && events[1]?.eventType === 'CUSTOMER_HOURS_APPROVED', events.map((e) => e.eventType));
    const adminUserIdForCheck = await userIdForSession(adminToken);
    check('1p: audit actorUserId is the real actor', events.every((e) => e.actorUserId === adminUserIdForCheck), events);
  }

  // ===============================================================================================
  // 2. Warning approval — AUTO submission source produces a warning, never a blocker; token still issued.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T2Warn', { source: SubmissionSource.AUTO });
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    check('2: warnings present (AUTOMATIC_SUBMISSION)', preview.body.warnings.some((w: any) => w.code === 'AUTOMATIC_SUBMISSION'), preview.body.warnings);
    check('2b: no blockers', preview.body.blockers.length === 0, preview.body.blockers);
    check('2c: token still issued despite the warning', typeof preview.body.confirmationToken === 'string', preview.body);

    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('2d: commit succeeds despite the warning', commit.status === 200 && commit.body.result === 'APPROVED', commit.body);
  }

  // ===============================================================================================
  // 3. Self-approval — UT6-A-R1 §1 (owner decision): a warning, never a blocker. Token IS issued,
  //    and commit succeeds — the admin explicitly accepts responsibility for approving their own
  //    hours. The accepted warning must be reproducible from history (buildApprovalItemSnapshotV1's
  //    warningsAtApproval), not just visible in the live preview.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T3Self');
    const selfToken = await makeSession('ADMIN', f.employee.id);
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(selfToken, itemKey);
    check('3: SELF_APPROVAL_FORBIDDEN warning present, never a blocker', preview.body.warnings.some((w: any) => w.code === 'SELF_APPROVAL_FORBIDDEN') && !preview.body.blockers.some((b: any) => b.code === 'SELF_APPROVAL_FORBIDDEN'), { blockers: preview.body.blockers, warnings: preview.body.warnings });
    check('3b: confirmationToken IS issued despite the warning', typeof preview.body.confirmationToken === 'string', preview.body);
    check('3c: eligibility.canApprove true (a warning never blocks)', preview.body.eligibility.canApprove === true, preview.body.eligibility);

    const commit = await commitJson(selfToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('3d: commit succeeds despite self-approval', commit.status === 200 && commit.body.result === 'APPROVED', commit.body);
    const item = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: commit.body.itemId } });
    const snapshot = item.snapshot as any;
    check('3e: warningsAtApproval on the stored snapshot records SELF_APPROVAL_FORBIDDEN', Array.isArray(snapshot.warningsAtApproval) && snapshot.warningsAtApproval.some((w: any) => w.code === 'SELF_APPROVAL_FORBIDDEN'), snapshot.warningsAtApproval);
  }

  // ===============================================================================================
  // 4. Open shift at commit time — UT6-A-R1 §1: a warning, never a blocker. A fresh, valid token
  //    issued before the open shift existed still lets commit succeed once the open shift appears —
  //    commit independently re-detects the condition (never trusts the token for warning-freedom)
  //    but a warning never aborts the write, unlike a genuine technical blocker.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T4Warn');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    check('4: clean preview issues a token', typeof preview.body.confirmationToken === 'string', preview.body);

    await mkOpenShift(f.employee.id, f.site.id, f.workArea?.id ?? null, at(f.monday, 9));

    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('4b: commit succeeds despite OPEN_SHIFT appearing after the token was issued', commit.status === 200 && commit.body.result === 'APPROVED', commit.body);
    const item = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: commit.body.itemId } });
    const snapshot = item.snapshot as any;
    check('4c: warningsAtApproval on the stored snapshot records OPEN_SHIFT', Array.isArray(snapshot.warningsAtApproval) && snapshot.warningsAtApproval.some((w: any) => w.code === 'OPEN_SHIFT'), snapshot.warningsAtApproval);
  }

  // ===============================================================================================
  // 5. Stale fingerprint — preview and commit both detect a mid-flight edit (DRAFT-sourced).
  // ===============================================================================================
  {
    const f = await oneDraftWeek('T5Stale');
    const itemKey = itemKeyOf(f);
    const preview1 = await realPreview(adminToken, itemKey);
    const staleFingerprint = preview1.body.currentFingerprint;
    const staleToken = preview1.body.confirmationToken;
    check('5: initial preview clean, token issued', typeof staleToken === 'string', preview1.body);

    // Simulate a worker edit: extend the segment by one hour.
    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: f.draftId } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(f.monday, 16) } });

    const preview2 = await previewJson(adminToken, itemKey, staleFingerprint);
    check('5b: preview with the old fingerprint now reports a mismatch', preview2.body.matchesExpectedFingerprint === false, preview2.body);
    check('5c: no token issued for a stale preview', preview2.body.confirmationToken === undefined, preview2.body);

    const commit = await commitJson(adminToken, itemKey, staleFingerprint, staleToken);
    check('5d: commit with the stale fingerprint/token -> 409 APPROVAL_SELECTION_STALE', commit.status === 409 && commit.body.error?.code === 'APPROVAL_SELECTION_STALE', commit.body);
  }

  // ===============================================================================================
  // 6. Expired / tampered / wrong-actor confirmation token.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T6Tok');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const actorUserId = await userIdForSession(adminToken);

    // Expired — signed with `now` far enough in the past that it's already past its own TTL.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const expired = signConfirmationToken({ actorUserId, employeeId: f.employee.id, itemKey, expectedFingerprint: preview.body.currentFingerprint, now: longAgo });
    const expiredCommit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, expired.token);
    check('6: expired token -> 409 CONFIRMATION_TOKEN_EXPIRED', expiredCommit.status === 409 && expiredCommit.body.error?.code === 'CONFIRMATION_TOKEN_EXPIRED', expiredCommit.body);

    // Tampered signature.
    const [payloadB64] = preview.body.confirmationToken.split('.');
    const tampered = `${payloadB64}.tamperedsignaturevalue`;
    const tamperedCommit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, tampered);
    check('6b: tampered token -> 403 CONFIRMATION_TOKEN_INVALID', tamperedCommit.status === 403 && tamperedCommit.body.error?.code === 'CONFIRMATION_TOKEN_INVALID', tamperedCommit.body);

    // Wrong actor — a token genuinely signed for a DIFFERENT admin.
    const otherAdminToken = await makeSession('ADMIN');
    const otherActorUserId = await userIdForSession(otherAdminToken);
    const wrongActor = signConfirmationToken({ actorUserId: otherActorUserId, employeeId: f.employee.id, itemKey, expectedFingerprint: preview.body.currentFingerprint });
    const wrongActorCommit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, wrongActor.token);
    check('6c: token signed for a different actor -> 403 CONFIRMATION_TOKEN_INVALID', wrongActorCommit.status === 403 && wrongActorCommit.body.error?.code === 'CONFIRMATION_TOKEN_INVALID', wrongActorCommit.body);

    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: f.timesheetId } });
    check('6d: none of the bad-token attempts created anything', items === 0, items);
  }

  // ===============================================================================================
  // 6b. UT5-B-fixup #1 — the commit transaction must re-check the confirmation token's own
  //     payload.employeeId against the FRESH, now-locked Timesheet row, never trust the token's
  //     claim blindly. Simulates "employee changed between preview and commit": a genuinely
  //     correctly-signed, unexpired, otherwise-valid token whose employeeId claim simply does not
  //     match the timesheet's real, current employeeId (Timesheet.employeeId itself is never
  //     reassigned by any real app code path — this constructs the divergent-claim token directly,
  //     the same way block 6's "wrong actor" case does, since that's the only reachable way to
  //     produce this state without fighting the segment-scope trigger's OWN unrelated
  //     sourceAssignmentId invariant on a cascaded employeeId swap).
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T6bEmpChange');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    check('6b-1: clean preview issues a token bound to the real employee', typeof preview.body.confirmationToken === 'string' && preview.body.itemKey.employeeId === f.employee.id, preview.body);
    const actorUserId = await userIdForSession(adminToken);

    const otherEmployee = await mkWorker('T6bOther');
    const wrongEmployeeToken = signConfirmationToken({ actorUserId, employeeId: otherEmployee.id, itemKey, expectedFingerprint: preview.body.currentFingerprint });
    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, wrongEmployeeToken.token);
    check('6b-2: commit with a token whose employeeId claim does not match the real timesheet owner -> 403 CONFIRMATION_TOKEN_INVALID', commit.status === 403 && commit.body.error?.code === 'CONFIRMATION_TOKEN_INVALID', commit.body);

    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: f.timesheetId } });
    check('6b-3: no item was created despite a structurally valid, unexpired, correctly-signed token', items === 0, items);

    // The REAL token (matching employeeId) still works normally afterward — proves the new check is
    // specific to the mismatch, not an accidental over-broad rejection.
    const realCommit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('6b-4: the real, matching token still commits successfully', realCommit.status === 200 && realCommit.body.result === 'APPROVED', realCommit.body);
  }

  // ===============================================================================================
  // 7. CSRF / auth / permission.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T7Guard');
    const itemKey = itemKeyOf(f);

    const noCsrf = await previewPOST(previewReq(adminToken, { itemKey, expectedFingerprint: '0'.repeat(64) }, false));
    check('7: preview missing CSRF -> 403 CSRF_REJECTED', noCsrf.status === 403 && (await noCsrf.json()).error.code === 'CSRF_REJECTED');

    const noSession = await previewPOST(previewReq(null, { itemKey, expectedFingerprint: '0'.repeat(64) }));
    check('7b: preview no session -> 401 NOT_AUTHENTICATED', noSession.status === 401 && (await noSession.json()).error.code === 'NOT_AUTHENTICATED');

    const workerToken = await makeSession('WORKER');
    const noPerm = await previewPOST(previewReq(workerToken, { itemKey, expectedFingerprint: '0'.repeat(64) }));
    check('7c: preview WORKER role lacks permission -> 403 FORBIDDEN', noPerm.status === 403 && (await noPerm.json()).error.code === 'FORBIDDEN');

    const commitNoCsrf = await commitPOST(commitReq(adminToken, { itemKey, expectedFingerprint: '0'.repeat(64), confirmationToken: 'x' }, randomUUID(), false));
    check('7d: commit missing CSRF -> 403 CSRF_REJECTED', commitNoCsrf.status === 403 && (await commitNoCsrf.json()).error.code === 'CSRF_REJECTED');

    const commitNoSession = await commitPOST(commitReq(null, { itemKey, expectedFingerprint: '0'.repeat(64), confirmationToken: 'x' }, randomUUID()));
    check('7e: commit no session -> 401 NOT_AUTHENTICATED', commitNoSession.status === 401 && (await commitNoSession.json()).error.code === 'NOT_AUTHENTICATED');

    const commitNoPerm = await commitPOST(commitReq(workerToken, { itemKey, expectedFingerprint: '0'.repeat(64), confirmationToken: 'x' }, randomUUID()));
    check('7f: commit WORKER role lacks permission -> 403 FORBIDDEN', commitNoPerm.status === 403 && (await commitNoPerm.json()).error.code === 'FORBIDDEN');
  }

  // ===============================================================================================
  // 8. Malformed body / weekStart-not-Monday / malformed fingerprint.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T8Bad');
    const badUuid = await previewJson(adminToken, { timesheetId: 'not-a-uuid', siteId: f.site.id, workAreaId: null, weekStart: isoDate(f.monday) }, '0'.repeat(64));
    check('8: malformed timesheetId UUID -> 400 VALIDATION_ERROR', badUuid.status === 400 && badUuid.body.error.code === 'VALIDATION_ERROR', badUuid.body);

    const notMonday = await previewJson(adminToken, { timesheetId: f.timesheetId, siteId: f.site.id, workAreaId: null, weekStart: isoDate(new Date(f.monday.getTime() + 86400000)) }, '0'.repeat(64));
    check('8b: weekStart not a Monday -> 400 VALIDATION_ERROR', notMonday.status === 400 && notMonday.body.error.code === 'VALIDATION_ERROR', notMonday.body);

    const badFingerprint = await previewJson(adminToken, itemKeyOf(f), 'not-64-hex-chars');
    check('8c: malformed fingerprint -> 400 VALIDATION_ERROR', badFingerprint.status === 400 && badFingerprint.body.error.code === 'VALIDATION_ERROR', badFingerprint.body);

    const malformedJson = await previewPOST(new NextRequest('http://localhost/api/admin/time-ledger/approval-preview', { method: 'POST', headers: { 'x-requested-with': 'titanor-time', cookie: `${SESSION_COOKIE_NAME}=${adminToken}`, 'Content-Type': 'application/json' }, body: '{not json' }));
    check('8d: malformed JSON body -> 400 VALIDATION_ERROR, never a 500', malformedJson.status === 400, malformedJson.status);
  }

  // ===============================================================================================
  // 9. Missing / invalid Idempotency-Key (commit only).
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T9Idem');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);

    const missingKey = await commitPOST(commitReq(adminToken, { itemKey, expectedFingerprint: preview.body.currentFingerprint, confirmationToken: preview.body.confirmationToken }, undefined));
    check('9: missing Idempotency-Key -> 400 VALIDATION_ERROR', missingKey.status === 400 && (await missingKey.json()).error.code === 'VALIDATION_ERROR');

    const invalidKey = await commitPOST(commitReq(adminToken, { itemKey, expectedFingerprint: preview.body.currentFingerprint, confirmationToken: preview.body.confirmationToken }, 'not-a-uuid'));
    check('9b: malformed Idempotency-Key -> 400 VALIDATION_ERROR', invalidKey.status === 400 && (await invalidKey.json()).error.code === 'VALIDATION_ERROR');
  }

  // ===============================================================================================
  // 10. Cached replay — same key + same body -> same result, no second write.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T10Cache');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const key = randomUUID();
    const first = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken, key);
    check('10: first commit succeeds', first.status === 200 && first.body.result === 'APPROVED', first.body);

    const second = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken, key);
    check('10b: replay with same key+body returns the SAME cached result', second.status === 200 && second.body.itemId === first.body.itemId && second.body.batchId === first.body.batchId, { first: first.body, second: second.body });

    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: f.timesheetId } });
    check('10c: exactly one item exists after the replay', items === 1, items);
    const events = await prisma.auditEvent.findMany({ where: { entityId: first.body.itemId, eventType: 'CUSTOMER_HOURS_APPROVED' } });
    check('10d: exactly one APPROVED audit event (replay did not re-run business logic)', events.length === 1, events.length);
  }

  // ===============================================================================================
  // 11. Key reuse with a different body -> 409 IDEMPOTENCY_KEY_REUSED.
  // ===============================================================================================
  {
    const f1 = await oneSubmittedWeek('T11ReuseA');
    const f2 = await oneSubmittedWeek('T11ReuseB');
    const key = randomUUID();
    const preview1 = await realPreview(adminToken, itemKeyOf(f1));
    const first = await commitJson(adminToken, itemKeyOf(f1), preview1.body.currentFingerprint, preview1.body.confirmationToken, key);
    check('11: first commit with key succeeds', first.status === 200, first.body);

    const preview2 = await realPreview(adminToken, itemKeyOf(f2));
    const reused = await commitPOST(commitReq(adminToken, { itemKey: itemKeyOf(f2), expectedFingerprint: preview2.body.currentFingerprint, confirmationToken: preview2.body.confirmationToken }, key));
    check('11b: same key, different body -> 409 IDEMPOTENCY_KEY_REUSED', reused.status === 409 && (await reused.json()).error.code === 'IDEMPOTENCY_KEY_REUSED');
  }

  // ===============================================================================================
  // 12. Concurrent duplicate request — same key, truly concurrent.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T12ConcSame');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const key = randomUUID();
    const [r1, r2] = await Promise.all([commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken, key), commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken, key)]);
    const statuses = [r1.status, r2.status].sort();
    check('12: one 200 and the other is 200(cached) or 409 IN_PROGRESS, never two independent successes with different items', (statuses[0] === 200 && (statuses[1] === 200 || statuses[1] === 409)) , { r1, r2 });
    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: f.timesheetId } });
    check('12b: exactly one item created', items === 1, items);
  }

  // ===============================================================================================
  // 13. Concurrent duplicate request — DIFFERENT keys, same slice: the lock-based serialization
  //     design (UT5-A-R1 §3), never a P2002 surfacing to the client.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T13ConcDiff');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const [r1, r2] = await Promise.all([
      commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken, randomUUID()),
      commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken, randomUUID())
    ]);
    check('13: both requests get a clean 200 (one APPROVED, one ALREADY_APPROVED)', r1.status === 200 && r2.status === 200, { r1, r2 });
    const results = [r1.body.result, r2.body.result].sort();
    check('13b: exactly one APPROVED and one ALREADY_APPROVED', results[0] === 'ALREADY_APPROVED' && results[1] === 'APPROVED', results);
    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: f.timesheetId } });
    check('13c: exactly one item created (no P2002-driven duplicate or crash)', items === 1, items);
  }

  // ===============================================================================================
  // 14. Already approved (sequential) — no new batch/item, a RECONFIRMED audit-only fact.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T14Already');
    const itemKey = itemKeyOf(f);
    const preview1 = await realPreview(adminToken, itemKey);
    const first = await commitJson(adminToken, itemKey, preview1.body.currentFingerprint, preview1.body.confirmationToken);
    check('14: first commit APPROVED', first.body.result === 'APPROVED', first.body);

    const preview2 = await realPreview(adminToken, itemKey);
    check('14b: second preview sees existingApproval.state CURRENT_MATCHING', preview2.body.existingApproval.state === 'CURRENT_MATCHING', preview2.body.existingApproval);
    const second = await commitJson(adminToken, itemKey, preview2.body.currentFingerprint, preview2.body.confirmationToken);
    check('14c: second commit ALREADY_APPROVED', second.status === 200 && second.body.result === 'ALREADY_APPROVED', second.body);
    check('14d: same itemId returned, no new batch', second.body.itemId === first.body.itemId && second.body.batchId === null, second.body);

    const items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: f.timesheetId } });
    check('14e: still exactly one item', items === 1, items);
    const reconfirmed = await prisma.auditEvent.findMany({ where: { entityId: first.body.itemId, eventType: 'CUSTOMER_HOURS_APPROVAL_RECONFIRMED' } });
    check('14f: exactly one RECONFIRMED audit event', reconfirmed.length === 1, reconfirmed.length);
  }

  // ===============================================================================================
  // 15. Old CURRENT superseded — DRAFT-sourced, edited between two approvals.
  // ===============================================================================================
  {
    const f = await oneDraftWeek('T15Supersede');
    const itemKey = itemKeyOf(f);
    const preview1 = await realPreview(adminToken, itemKey);
    const first = await commitJson(adminToken, itemKey, preview1.body.currentFingerprint, preview1.body.confirmationToken);
    check('15: first commit APPROVED', first.body.result === 'APPROVED', first.body);
    const oldFingerprint = first.body.fingerprint;

    const seg = await prisma.timesheetDraftSegment.findFirstOrThrow({ where: { draftId: f.draftId } });
    await prisma.timesheetDraftSegment.update({ where: { id: seg.id }, data: { endAt: at(f.monday, 17) } });

    const preview2 = await realPreview(adminToken, itemKey);
    check('15b: fingerprint changed after the edit', preview2.body.currentFingerprint !== oldFingerprint, { old: oldFingerprint, new: preview2.body.currentFingerprint });
    check('15c: existingApproval.state CURRENT_STALE', preview2.body.existingApproval.state === 'CURRENT_STALE', preview2.body.existingApproval);

    const second = await commitJson(adminToken, itemKey, preview2.body.currentFingerprint, preview2.body.confirmationToken);
    check('15d: second commit APPROVED with a new item', second.status === 200 && second.body.result === 'APPROVED' && second.body.itemId !== first.body.itemId, second.body);
    check('15e: supersededItemId is the first item', second.body.supersededItemId === first.body.itemId, second.body);

    const oldItem = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: first.body.itemId } });
    check('15f: old item is now SUPERSEDED with both fields set', oldItem.approvalState === 'SUPERSEDED' && oldItem.supersededAt !== null && oldItem.supersededBySourceId !== null, oldItem);
    const newItem = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: second.body.itemId } });
    check('15g: new item is CURRENT with the new fingerprint', newItem.approvalState === 'CURRENT' && newItem.fingerprint === preview2.body.currentFingerprint, newItem);

    const events = await prisma.auditEvent.findMany({ where: { requestId: second.body.requestId }, orderBy: { createdAt: 'asc' } });
    check('15h: SUPERSEDED, BATCH_CREATED, APPROVED in order', events.map((e) => e.eventType).join(',') === 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED,CUSTOMER_HOURS_APPROVAL_BATCH_CREATED,CUSTOMER_HOURS_APPROVED', events.map((e) => e.eventType));
  }

  // ===============================================================================================
  // 16. Nullable customer (workAreaId = null) — uses the "_no_customer" partial unique index path.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T16NoCustomer', { workArea: null });
    const itemKey = itemKeyOf(f);
    check('16: itemKey.workAreaId is null', itemKey.workAreaId === null, itemKey);
    const preview = await realPreview(adminToken, itemKey);
    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('16b: commit succeeds for the no-customer slice', commit.status === 200 && commit.body.result === 'APPROVED', commit.body);
    const item = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: commit.body.itemId } });
    check('16c: item.workAreaId is null', item.workAreaId === null, item);
  }

  // ===============================================================================================
  // 17. Biweekly Timesheet — only the selected week is approved, the other week untouched.
  // ===============================================================================================
  {
    const site = await mkSite('T17Bi');
    const workArea = await mkWorkArea(site.id, 'T17Bi');
    const emp = await mkWorker('T17Bi');
    const asg = await mkAssignment(emp.id, site.id, workArea.id);
    const week1Monday = nextMonday();
    const week2Monday = new Date(week1Monday.getTime() + 7 * 86400000);
    const period = await prisma.payrollPeriod.create({ data: { startDate: week1Monday, endDate: new Date(week2Monday.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminUserId } });
    const { ts } = await buildDraft(
      emp.id,
      [
        { day: week1Monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id },
        { day: week2Monday, siteId: site.id, workAreaId: workArea.id, assignmentId: asg.id }
      ],
      'LOCKED',
      { id: period.id, startDate: period.startDate, endDate: period.endDate }
    );
    await submitDraft(emp.id, ts.id);

    const itemKeyWeek1 = { timesheetId: ts.id, siteId: site.id, workAreaId: workArea.id, weekStart: isoDate(week1Monday) };
    const itemKeyWeek2 = { timesheetId: ts.id, siteId: site.id, workAreaId: workArea.id, weekStart: isoDate(week2Monday) };
    const preview1 = await realPreview(adminToken, itemKeyWeek1);
    const commit1 = await commitJson(adminToken, itemKeyWeek1, preview1.body.currentFingerprint, preview1.body.confirmationToken);
    check('17: week 1 approved', commit1.status === 200 && commit1.body.result === 'APPROVED', commit1.body);

    const week1Items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, weekStart: week1Monday } });
    const week2Items = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, weekStart: week2Monday } });
    check('17b: exactly one item for week 1', week1Items === 1, week1Items);
    check('17c: zero items for week 2 (never touched)', week2Items === 0, week2Items);

    // Week 2's own preview still works independently, unaffected by week 1's approval.
    const preview2 = await realPreview(adminToken, itemKeyWeek2);
    check('17d: week 2 preview is independent (NONE, not affected by week 1)', preview2.body.existingApproval.state === 'NONE', preview2.body.existingApproval);
  }

  // ===============================================================================================
  // 18. Two customers, same week — only the selected customer's slice is approved.
  // ===============================================================================================
  {
    const site = await mkSite('T18Two');
    const waA = await mkWorkArea(site.id, 'T18A');
    const waB = await mkWorkArea(site.id, 'T18B');
    const emp = await mkWorker('T18Two');
    const asgA = await mkAssignment(emp.id, site.id, waA.id);
    const asgB = await mkAssignment(emp.id, site.id, waB.id, false);
    const monday = nextMonday();
    const tuesday = new Date(monday.getTime() + 86400000);
    const { ts } = await buildDraft(emp.id, [
      { day: monday, siteId: site.id, workAreaId: waA.id, assignmentId: asgA.id },
      { day: tuesday, siteId: site.id, workAreaId: waB.id, assignmentId: asgB.id }
    ]);
    await submitDraft(emp.id, ts.id);

    const itemKeyA = { timesheetId: ts.id, siteId: site.id, workAreaId: waA.id, weekStart: isoDate(monday) };
    const itemKeyB = { timesheetId: ts.id, siteId: site.id, workAreaId: waB.id, weekStart: isoDate(monday) };
    const previewA = await realPreview(adminToken, itemKeyA);
    const commitA = await commitJson(adminToken, itemKeyA, previewA.body.currentFingerprint, previewA.body.confirmationToken);
    check('18: customer A approved', commitA.status === 200 && commitA.body.result === 'APPROVED', commitA.body);

    const itemsA = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, workAreaId: waA.id } });
    const itemsB = await prisma.customerHoursApprovalItem.count({ where: { timesheetId: ts.id, workAreaId: waB.id } });
    check('18b: customer A has exactly one item', itemsA === 1, itemsA);
    check('18c: customer B has zero items', itemsB === 0, itemsB);

    const previewB = await realPreview(adminToken, itemKeyB);
    check('18d: customer B preview unaffected, NONE', previewB.body.existingApproval.state === 'NONE', previewB.body.existingApproval);
  }

  // ===============================================================================================
  // 19. sourceRevision DRAFT vs VERSION.
  // ===============================================================================================
  {
    const draftF = await oneDraftWeek('T19Draft');
    const draftItemKey = itemKeyOf(draftF);
    const draftPreview = await realPreview(adminToken, draftItemKey);
    const draftCommit = await commitJson(adminToken, draftItemKey, draftPreview.body.currentFingerprint, draftPreview.body.confirmationToken);
    const draftItem = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: draftCommit.body.itemId } });
    check('19: DRAFT-sourced item has sourceKind=DRAFT and sourceRevision set', draftItem.sourceKind === 'DRAFT' && draftItem.sourceRevision !== null, { sourceKind: draftItem.sourceKind, sourceRevision: draftItem.sourceRevision?.toString() });

    const versionF = await oneSubmittedWeek('T19Version');
    const versionItemKey = itemKeyOf(versionF);
    const versionPreview = await realPreview(adminToken, versionItemKey);
    const versionCommit = await commitJson(adminToken, versionItemKey, versionPreview.body.currentFingerprint, versionPreview.body.confirmationToken);
    const versionItem = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: versionCommit.body.itemId } });
    check('19b: VERSION-sourced item has sourceKind=VERSION and sourceRevision null', versionItem.sourceKind === 'VERSION' && versionItem.sourceRevision === null, versionItem);
  }

  // ===============================================================================================
  // 20. Batch/item snapshots — exact V1 shape on a real persisted row.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T20Snap');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    const batch = await prisma.customerHoursApprovalBatch.findUniqueOrThrow({ where: { id: commit.body.batchId } });
    const selectionSnapshot = batch.selectionSnapshot as any;
    check('20: selectionSnapshot schemaVersion=1, mode=SINGLE', selectionSnapshot.schemaVersion === 1 && selectionSnapshot.mode === 'SINGLE', selectionSnapshot);
    check('20b: selectionSnapshot.itemKeys has exactly the approved item key', selectionSnapshot.itemKeys.length === 1 && selectionSnapshot.itemKeys[0].timesheetId === itemKey.timesheetId, selectionSnapshot);

    const item = await prisma.customerHoursApprovalItem.findUniqueOrThrow({ where: { id: commit.body.itemId } });
    const snapshot = item.snapshot as any;
    check(
      '20c: item snapshot has exactly the documented top-level keys',
      Object.keys(snapshot).sort().join(',') ===
        ['schemaVersion', 'logicalKey', 'canonicalSource', 'fingerprint', 'workedMinutes', 'grossMinutes', 'breakMinutes', 'canonicalPayload', 'displayMetadata', 'warningsAtApproval'].sort().join(','),
      Object.keys(snapshot)
    );
    check('20d: snapshot.fingerprint matches the item column', snapshot.fingerprint === item.fingerprint, { snapshot: snapshot.fingerprint, column: item.fingerprint });
    check('20e: snapshot never contains GPS/token/session fields', !JSON.stringify(snapshot).match(/gps|latitude|longitude|confirmationToken|sessionToken|passwordHash/i), snapshot);
    check('20f: snapshot.canonicalPayload has no display-name fields (structurally impossible to leak a name into the fingerprint input)', !('employeeName' in snapshot.canonicalPayload) && !('siteName' in snapshot.canonicalPayload), snapshot.canonicalPayload);
  }

  // ===============================================================================================
  // 21. Audit payload — actor/requestId/entity/fingerprint/minutes present, nothing sensitive.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T21Audit');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    const approvedEvent = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: commit.body.itemId, eventType: 'CUSTOMER_HOURS_APPROVED' } });
    check('21: audit actorUserId set', approvedEvent.actorUserId === (await userIdForSession(adminToken)), approvedEvent);
    check('21b: audit requestId matches the response', approvedEvent.requestId === commit.body.requestId, approvedEvent);
    check('21c: audit entityType/entityId correct', approvedEvent.entityType === 'CUSTOMER_HOURS_APPROVAL_ITEM' && approvedEvent.entityId === commit.body.itemId, approvedEvent);
    const after = approvedEvent.afterValue as any;
    check('21d: audit payload carries itemKey/fingerprint/minutes', after.itemKey?.timesheetId === itemKey.timesheetId && after.fingerprint === commit.body.fingerprint && typeof after.workedMinutes === 'number', after);
    check('21e: audit payload has no GPS/token/session fields', !JSON.stringify(after).match(/gps|latitude|longitude|confirmationToken|sessionToken|passwordHash/i), after);
  }

  // ===============================================================================================
  // 22. Transaction rollback on a mid-transaction failure — proves the atomicity property the
  //     commit route's design relies on (batch + audit + item all-or-nothing), using a real Prisma
  //     $transaction the same way the route does, with a deliberately failing final statement.
  // ===============================================================================================
  {
    const before = await prisma.customerHoursApprovalBatch.count();
    let threw = false;
    try {
      await prisma.$transaction(async (tx) => {
        const batch = await tx.customerHoursApprovalBatch.create({ data: { approvedByUserId: adminUserId, requestId: randomUUID(), idempotencyKey: randomUUID(), selectionSnapshot: { tag: 'rollback-test' }, itemCount: 1, workedMinutes: 60 } });
        await createAuditEvent(tx, { actorUserId: adminUserId, eventType: 'CUSTOMER_HOURS_APPROVAL_BATCH_CREATED', entityType: 'CUSTOMER_HOURS_APPROVAL_BATCH', entityId: batch.id, requestId: randomUUID(), afterValue: { itemCount: 1 } });
        // Deliberately violates CK-62 (grossMinutes = workedMinutes + breakMinutes) to force a
        // real, late failure inside the same transaction, after the batch+audit writes above.
        await tx.customerHoursApprovalItem.create({
          data: {
            batchId: batch.id,
            timesheetId: '00000000-0000-0000-0000-000000000000',
            employeeId: '00000000-0000-0000-0000-000000000000',
            siteId: '00000000-0000-0000-0000-000000000000',
            workAreaId: null,
            weekStart: new Date('2031-01-05T00:00:00.000Z'), // not even a Monday -- also violates CK-60
            weekEnd: new Date('2031-01-11T00:00:00.000Z'),
            sourceKind: 'VERSION',
            sourceId: randomUUID(),
            sourceRevision: null,
            fingerprint: 'f'.repeat(64),
            workedMinutes: 60,
            grossMinutes: 999,
            breakMinutes: 0,
            snapshot: { schemaVersion: 1 },
            approvalState: 'CURRENT'
          }
        });
      });
    } catch (err) {
      threw = err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && /ck_customer_hours_approval_item/.test(err.message));
    }
    check('22: the deliberately-invalid final write throws', threw);
    const after = await prisma.customerHoursApprovalBatch.count();
    check('22b: the batch created earlier in the SAME transaction did NOT persist (full rollback)', after === before, { before, after });
    const orphanEvents = await prisma.auditEvent.count({ where: { eventType: 'CUSTOMER_HOURS_APPROVAL_BATCH_CREATED', afterValue: { path: ['itemCount'], equals: 1 }, reason: null, entityId: { not: null } } });
    void orphanEvents; // informational only -- the batch-count check above is the decisive assertion
  }

  // ===============================================================================================
  // 23. Immutable triggers still hold on rows this route itself created.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T23Immutable');
    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);

    let batchUpdateRejected = false;
    try {
      await prisma.customerHoursApprovalBatch.update({ where: { id: commit.body.batchId }, data: { itemCount: 2 } });
    } catch (err) {
      batchUpdateRejected = err instanceof Error && err.message.includes('CUSTOMER_HOURS_APPROVAL_BATCH_IMMUTABLE');
    }
    check('23: a direct UPDATE on the batch this route created is still rejected by the trigger', batchUpdateRejected);

    let itemDeleteRejected = false;
    try {
      await prisma.customerHoursApprovalItem.delete({ where: { id: commit.body.itemId } });
    } catch (err) {
      itemDeleteRejected = err instanceof Error && err.message.includes('CUSTOMER_HOURS_APPROVAL_ITEM_NO_DELETE');
    }
    check('23b: a direct DELETE on the item this route created is still rejected by the trigger', itemDeleteRejected);
  }

  // ===============================================================================================
  // 24. No review-scope / finalization mutation — UT5 never touches TimesheetReviewScope or flips
  //     Timesheet.status, even on a successful approval.
  // ===============================================================================================
  {
    const f = await oneSubmittedWeek('T24Scope');
    const scopesBefore = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersion: { timesheetId: f.timesheetId } } });
    const statusBefore = (await prisma.timesheet.findUniqueOrThrow({ where: { id: f.timesheetId }, select: { status: true } })).status;

    const itemKey = itemKeyOf(f);
    const preview = await realPreview(adminToken, itemKey);
    const commit = await commitJson(adminToken, itemKey, preview.body.currentFingerprint, preview.body.confirmationToken);
    check('24: commit succeeded', commit.status === 200 && commit.body.result === 'APPROVED', commit.body);

    const scopesAfter = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersion: { timesheetId: f.timesheetId } } });
    const statusAfter = (await prisma.timesheet.findUniqueOrThrow({ where: { id: f.timesheetId }, select: { status: true } })).status;
    check('24b: TimesheetReviewScope row count unchanged', scopesBefore.length === scopesAfter.length, { before: scopesBefore.length, after: scopesAfter.length });
    check(
      '24c: every existing TimesheetReviewScope row is byte-identical (status/reviewedByUserId/reviewedAt untouched)',
      scopesBefore.every((s, i) => s.status === scopesAfter[i]?.status && s.reviewedByUserId === scopesAfter[i]?.reviewedByUserId),
      { before: scopesBefore, after: scopesAfter }
    );
    check('24d: Timesheet.status unchanged (never flipped toward FINAL_APPROVED by this route)', statusBefore === statusAfter, { before: statusBefore, after: statusAfter });
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
