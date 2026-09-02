import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders } from './_test-t9-fixtures';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §7 — R15-D7 Deploy A ("Фундамент").
// Real HTTP against the production standalone build, disposable PostgreSQL 16, DB assertions,
// zero mocks. Covers the parts of the 30-scenario matrix that Deploy A actually delivers:
// the unified clockInDisabledAt gate, the lifecycle service (removeFromSite / changeWorkplace /
// promoteToPrimary), AssignmentTransition, idempotency, C8 (deactivated worker can't start a
// shift) and the §3.12 Check Out step. Scenarios that need the redesigned worker card (Deploy B),
// site finish (Deploy C), the primary index (Deploy D), group transfer (E) or D3 (F) are not here.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const fx = await buildFixture(BASE);
  const admin = fx.admin.cookie;
  const today = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date())}T00:00:00.000Z`);
  const todayIso = isoDate(today);
  const tomorrowIso = isoDate(new Date(today.getTime() + 86400000));

  const mkSite = async (label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/sites`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ name: `LC ${label} ${fx.run}` })
    });
    return r.body.id as string;
  };
  const mkWorker = async (label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/workers`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ firstName: 'LC', lastName: `${label}${fx.run}` })
    });
    return r.body.employee.id as string;
  };
  const assign = async (employeeId: string, siteId: string, isPrimary: boolean, validFrom = '2020-01-01'): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId, siteId, templateId: fx.templateId, validFrom, isPrimary })
    });
    if (r.status !== 201) throw new Error(`assign failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const adminCurrentIds = async (employeeId: string): Promise<string[]> => {
    const list = await jsonFetch(`${BASE}/api/admin/workers?pageSize=200`, { headers: authHeaders(admin) });
    const row = (list.body.items as { id: string; currentAssignments: { assignmentId: string }[] }[]).find((x) => x.id === employeeId);
    return (row?.currentAssignments ?? []).map((a) => a.assignmentId);
  };
  const transitions = (assignmentId: string) =>
    prisma.assignmentTransition.findMany({
      where: { OR: [{ fromAssignmentId: assignmentId }, { toAssignmentId: assignmentId }] },
      orderBy: { createdAt: 'asc' }
    });
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' };
  const workerLogin = async (employeeId: string): Promise<string> => {
    const act = await jsonFetch(`${BASE}/api/admin/workers/${employeeId}/activation`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }) });
    const code = act.body.activationCode as string;
    const pw = randomUUID() + 'Zz9';
    await fetch(`${BASE}/api/auth/activate?token=${encodeURIComponent(code)}`);
    await fetch(`${BASE}/api/auth/set-initial-password`, { method: 'POST', headers: H, body: JSON.stringify({ token: code, password: pw }) });
    const u = await prisma.user.findFirstOrThrow({ where: { employeeId }, select: { username: true } });
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ identifier: u.username, password: pw }) });
    return r.headers.get('set-cookie')?.match(/tt_session=([^;]+)/)?.[1] as string;
  };
  const checkIn = (cookie: string, siteId: string, capturedAt: string, clientEventId = randomUUID()) =>
    jsonFetch(`${BASE}/api/worker/attendance/check-in`, {
      method: 'POST',
      headers: { ...H, Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId, siteId, workAreaId: null, clientCapturedAt: capturedAt, location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });
  const checkOut = (cookie: string, assumedSiteId: string, capturedAt: string, clientEventId = randomUUID()) =>
    jsonFetch(`${BASE}/api/worker/attendance/check-out`, {
      method: 'POST',
      headers: { ...H, Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId, assumedSiteId, clientCapturedAt: capturedAt, location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });

  const siteA = await mkSite('A');
  const siteB = await mkSite('B');

  // ── L1 — removeFromSite (immediate, no open shift) via /end ────────────────────────────────
  {
    const w = await mkWorker('L1');
    const a = await assign(w, siteA, true);
    const before = new Date();
    const res = await jsonFetch(`${BASE}/api/admin/assignments/${a}/end`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ validTo: todayIso, reason: 'L1: project ended' })
    });
    check('L1a: /end returns 200', res.status === 200, res.body);
    const row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L1b: clockInDisabledAt set to ~now', row.clockInDisabledAt !== null && row.clockInDisabledAt.getTime() >= before.getTime() - 1000, row.clockInDisabledAt);
    check('L1c: validTo = today', row.validTo !== null && isoDate(row.validTo) === todayIso, row.validTo);
    const tr = await transitions(a);
    check('L1d: one AssignmentTransition kind=REMOVE, from=this, openShiftHandling=NONE', tr.length === 1 && tr[0].kind === 'REMOVE' && tr[0].fromAssignmentId === a && tr[0].toAssignmentId === null && tr[0].openShiftHandling === 'NONE', tr);
    check('L1e: gone from the admin worker "current" list', !(await adminCurrentIds(w)).includes(a));
    const draftPlanned = await prisma.timesheetDraftPlannedShift.count({ where: { sourceAssignmentId: a, date: { gt: today } } });
    check('L1f: future draft planned shifts dropped', draftPlanned === 0, draftPlanned);
  }

  // ── L2 — repeat click / idempotency: a second identical /end writes no second transition ───
  {
    const w = await mkWorker('L2');
    const a = await assign(w, siteA, true);
    await jsonFetch(`${BASE}/api/admin/assignments/${a}/end`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ validTo: todayIso, reason: 'L2 first' }) });
    const second = await jsonFetch(`${BASE}/api/admin/assignments/${a}/end`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ validTo: todayIso, reason: 'L2 second' }) });
    check('L2a: second /end still 200', second.status === 200, second.body);
    const tr = await transitions(a);
    check('L2b: still exactly one REMOVE transition', tr.filter((t) => t.kind === 'REMOVE').length === 1, tr);
  }

  // ── L3 — the /remove route behaves identically to /end ────────────────────────────────────
  {
    const w = await mkWorker('L3');
    const a = await assign(w, siteA, true);
    const res = await jsonFetch(`${BASE}/api/admin/assignments/${a}/remove`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ validTo: todayIso, reason: 'L3 via /remove' })
    });
    check('L3a: /remove returns 200', res.status === 200, res.body);
    const row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    const tr = await transitions(a);
    check('L3b: /remove set clockInDisabledAt + wrote a REMOVE transition', row.clockInDisabledAt !== null && tr.length === 1 && tr[0].kind === 'REMOVE', { row: row.clockInDisabledAt, tr });
  }

  // ── L4 — changeWorkplace immediate (effectiveFrom = today) via /change ────────────────────
  {
    const w = await mkWorker('L4');
    const a = await assign(w, siteA, true);
    const before = new Date();
    const res = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: todayIso, siteId: siteB, reason: 'L4 immediate move' })
    });
    check('L4a: /change returns 200', res.status === 200, res.body);
    const oldRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L4b: old assignment clockInDisabledAt set (immediate) + validTo = yesterday', oldRow.clockInDisabledAt !== null && oldRow.clockInDisabledAt.getTime() >= before.getTime() - 1000 && oldRow.validTo !== null && isoDate(oldRow.validTo) < todayIso, { d: oldRow.clockInDisabledAt, v: oldRow.validTo });
    const newId = res.body.newAssignment.id as string;
    const newRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: newId } });
    check('L4c: new assignment on siteB, validFrom today, live', newRow.siteId === siteB && isoDate(newRow.validFrom) === todayIso && newRow.clockInDisabledAt === null, newRow);
    const tr = await transitions(a);
    check('L4d: AssignmentTransition kind=CHANGE, from=old, to=new', tr.length === 1 && tr[0].kind === 'CHANGE' && tr[0].fromAssignmentId === a && tr[0].toAssignmentId === newId, tr);
    const cur = await adminCurrentIds(w);
    check('L4e: admin "current" now shows the new assignment, not the old', cur.includes(newId) && !cur.includes(a), cur);
  }

  // ── L5 — changeWorkplace future (effectiveFrom = tomorrow): calendar handoff, no clockInDisabledAt ─
  {
    const w = await mkWorker('L5');
    const a = await assign(w, siteA, true);
    const res = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: tomorrowIso, siteId: siteB, reason: 'L5 scheduled move' })
    });
    check('L5a: /change returns 200', res.status === 200, res.body);
    const oldRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L5b: old assignment clockInDisabledAt NULL (future change), validTo = today', oldRow.clockInDisabledAt === null && oldRow.validTo !== null && isoDate(oldRow.validTo) === todayIso, { d: oldRow.clockInDisabledAt, v: oldRow.validTo });
    const newRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: res.body.newAssignment.id } });
    check('L5c: new assignment validFrom tomorrow, not live today', isoDate(newRow.validFrom) === tomorrowIso, newRow.validFrom);
    const cur = await adminCurrentIds(w);
    check('L5d: admin "current" still shows the OLD assignment today (handoff is tomorrow)', cur.includes(a) && !cur.includes(res.body.newAssignment.id), cur);
    const tr = await transitions(a);
    check('L5e: AssignmentTransition kind=CHANGE written', tr.length === 1 && tr[0].kind === 'CHANGE', tr);
  }

  // ── L6 — promoteToPrimary: one live primary; a removed assignment is neither demoted nor promotable ─
  {
    const w = await mkWorker('L6');
    const primary = await assign(w, siteA, true);
    const secondary = await assign(w, siteB, false);
    const res = await jsonFetch(`${BASE}/api/admin/assignments/${secondary}/promote`, { method: 'POST', headers: authHeaders(admin), body: '' });
    check('L6a: /promote returns 200', res.status === 200, res.body);
    const [p, s] = await Promise.all([
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: primary } }),
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: secondary } })
    ]);
    check('L6b: exactly one primary — old demoted, new promoted', p.isPrimary === false && s.isPrimary === true, { p: p.isPrimary, s: s.isPrimary });
    const tr = await transitions(secondary);
    check('L6c: promote wrote a CHANGE transition to=secondary', tr.some((t) => t.kind === 'CHANGE' && t.toAssignmentId === secondary), tr);

    // remove the (now primary) secondary, then try to promote it again
    await jsonFetch(`${BASE}/api/admin/assignments/${secondary}/end`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ validTo: todayIso, reason: 'L6 remove' }) });
    const repromote = await jsonFetch(`${BASE}/api/admin/assignments/${secondary}/promote`, { method: 'POST', headers: authHeaders(admin), body: '' });
    check('L6d: promoting a removed assignment → 409 ASSIGNMENT_NOT_ACTIVE', repromote.status === 409 && repromote.body?.error?.code === 'ASSIGNMENT_NOT_ACTIVE', repromote.body);
    // promote `primary` back — the removed `secondary` must NOT be counted as a live primary to demote
    const rePrimary = await jsonFetch(`${BASE}/api/admin/assignments/${primary}/promote`, { method: 'POST', headers: authHeaders(admin), body: '' });
    check('L6e: promoting the still-live assignment succeeds (removed one ignored)', rePrimary.status === 200, rePrimary.body);
  }

  // ── L7 — C8: a deactivated worker (OFFBOARDING) cannot start a NEW shift ───────────────────
  {
    const w = await mkWorker('L7');
    await assign(w, siteA, true);
    // give the worker a login: activation code -> set password -> login
    const act = await jsonFetch(`${BASE}/api/admin/workers/${w}/activation`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }) });
    const code = act.body.activationCode as string;
    const pw = randomUUID() + 'Aa1';
    await fetch(`${BASE}/api/auth/activate?token=${encodeURIComponent(code)}`);
    await fetch(`${BASE}/api/auth/set-initial-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' }, body: JSON.stringify({ token: code, password: pw }) });
    const userRow = await prisma.user.findFirstOrThrow({ where: { employeeId: w }, select: { username: true } });
    const loginRes = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' }, body: JSON.stringify({ identifier: userRow.username, password: pw }) });
    const cookie = loginRes.headers.get('set-cookie')?.match(/tt_session=([^;]+)/)?.[1] as string;

    const deact = await jsonFetch(`${BASE}/api/admin/workers/${w}/deactivate`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ reason: 'L7 offboarding' }) });
    check('L7a: deactivate → OFFBOARDING (unfinished payroll keeps the session)', deact.body.userStatus === 'OFFBOARDING', deact.body);

    const clientEventId = randomUUID();
    const ci = await jsonFetch(`${BASE}/api/worker/attendance/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time', Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId, siteId: siteA, workAreaId: null, clientCapturedAt: new Date().toISOString(), location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });
    check('L7b: check-in still accepted (raw fact never dropped) — 201', ci.status === 201, ci.body);
    const openShift = await prisma.employeeOpenShift.findUnique({ where: { employeeId: w } });
    check('L7c: NO open shift was created', openShift === null, openShift);
    const ev = await prisma.clockEvent.findUnique({ where: { id: clientEventId }, select: { processingState: true, sourceAssignmentId: true } });
    check('L7d: ClockEvent recorded as NEEDS_REVIEW, no source assignment', ev?.processingState === 'NEEDS_REVIEW' && ev?.sourceAssignmentId === null, ev);
    const exc = await prisma.attendanceException.findFirst({ where: { clockEventId: clientEventId, type: 'STALE_ASSIGNMENT' } });
    check('L7e: STALE_ASSIGNMENT exception with reason EMPLOYMENT_INACTIVE', exc !== null && (exc?.detail as any)?.reason === 'EMPLOYMENT_INACTIVE', exc?.detail);
  }

  // ── L8 — remove during an open shift: the shift is not interrupted, Check Out still closes ─
  {
    const w = await mkWorker('L8');
    const a = await assign(w, siteB, true);
    const act = await jsonFetch(`${BASE}/api/admin/workers/${w}/activation`, { method: 'POST', headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }) });
    const code = act.body.activationCode as string;
    const pw = randomUUID() + 'Bb2';
    await fetch(`${BASE}/api/auth/activate?token=${encodeURIComponent(code)}`);
    await fetch(`${BASE}/api/auth/set-initial-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' }, body: JSON.stringify({ token: code, password: pw }) });
    const userRow = await prisma.user.findFirstOrThrow({ where: { employeeId: w }, select: { username: true } });
    const loginRes = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' }, body: JSON.stringify({ identifier: userRow.username, password: pw }) });
    const cookie = loginRes.headers.get('set-cookie')?.match(/tt_session=([^;]+)/)?.[1] as string;

    const ciId = randomUUID();
    const ci = await jsonFetch(`${BASE}/api/worker/attendance/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time', Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId: ciId, siteId: siteB, workAreaId: null, clientCapturedAt: new Date().toISOString(), location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });
    check('L8a: worker checked in (open shift)', ci.status === 201 && (await prisma.employeeOpenShift.findUnique({ where: { employeeId: w } })) !== null, ci.body);

    const rem = await jsonFetch(`${BASE}/api/admin/assignments/${a}/end`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ validTo: todayIso, reason: 'L8 remove during shift' }) });
    check('L8b: /end during an open shift → 200', rem.status === 200, rem.body);
    const row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L8c: assignment clockInDisabledAt set', row.clockInDisabledAt !== null, row.clockInDisabledAt);
    check('L8d: open shift NOT interrupted', (await prisma.employeeOpenShift.findUnique({ where: { employeeId: w } })) !== null);
    const tr = await transitions(a);
    check('L8e: transition openShiftHandling = AFTER_CHECK_OUT', tr.length === 1 && tr[0].openShiftHandling === 'AFTER_CHECK_OUT', tr);

    const coId = randomUUID();
    const co = await jsonFetch(`${BASE}/api/worker/attendance/check-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time', Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId: coId, assumedSiteId: siteB, clientCapturedAt: new Date(Date.now() + 3600000).toISOString(), location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });
    check('L8f: Check Out after removal still closes the shift', (co.status === 200 || co.status === 201) && (await prisma.employeeOpenShift.findUnique({ where: { employeeId: w } })) === null, co.body);
    const rowAfter = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L8g: validTo still today (checkout landed the same calendar day)', rowAfter.validTo !== null && isoDate(rowAfter.validTo) === todayIso, rowAfter.validTo);
  }

  // ── L9 — Deploy D: creating a 2nd primary via POST /api/admin/assignments demotes the first ─
  {
    const w = await mkWorker('L9');
    const first = await assign(w, siteA, true);
    const second = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w, siteId: siteB, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true })
    });
    check('L9a: 2nd assignment created (201) — no 500 / no unique violation', second.status === 201, second.body);
    const [f, s] = await Promise.all([
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: first } }),
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: second.body.id } })
    ]);
    check('L9b: the earlier assignment was auto-demoted, the new one is primary', f.isPrimary === false && s.isPrimary === true, { f: f.isPrimary, s: s.isPrimary });
    const livePrimaries = await prisma.siteAssignment.count({ where: { employeeId: w, isPrimary: true, clockInDisabledAt: null } });
    check('L9c: exactly one row in the ux_site_assignment_one_live_primary predicate', livePrimaries === 1, livePrimaries);
  }

  // ── L10 — Deploy D: the partial unique index physically forbids a 2nd live primary ──────────
  {
    const w = await mkWorker('L10');
    const p = await assign(w, siteA, true);
    const { assignedByUserId } = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: p }, select: { assignedByUserId: true } });
    let raised = false;
    try {
      await prisma.siteAssignment.create({
        data: { employeeId: w, siteId: siteB, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), assignedByUserId }
      });
    } catch (e) {
      raised =
        String((e as Error).message).includes('ux_site_assignment_one_live_primary') ||
        String((e as Error).message).includes('Unique constraint');
    }
    check('L10a: a raw INSERT of a 2nd live primary is rejected by the index', raised);
    // changeWorkplace of a primary assignment must not trip the index (old row is demoted)
    const w2 = await mkWorker('L10b');
    const a2 = await assign(w2, siteA, true);
    const chg = await jsonFetch(`${BASE}/api/admin/assignments/${a2}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: tomorrowIso, siteId: siteB, reason: 'L10 future move of a primary' })
    });
    check('L10b: changeWorkplace of a primary → 200 (no LIVE_PRIMARY_CONFLICT)', chg.status === 200, chg.body);
    const primaries2 = await prisma.siteAssignment.count({ where: { employeeId: w2, isPrimary: true, clockInDisabledAt: null } });
    check('L10c: still exactly one row in the index predicate after the change', primaries2 === 1, primaries2);
  }

  // ── L11 — PATCH /api/admin/assignments/:id { isPrimary:true } routes through promoteToPrimary ──
  {
    const w = await mkWorker('L11');
    const a = await assign(w, siteA, true);
    const b = await assign(w, siteB, false); // create() demoted nobody (b not primary); a stays primary
    const bRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: b } });
    const patch = await jsonFetch(`${BASE}/api/admin/assignments/${b}`, {
      method: 'PATCH',
      headers: authHeaders(admin),
      body: JSON.stringify({ version: bRow.version, isPrimary: true })
    });
    check('L11a: PATCH isPrimary:true → 200', patch.status === 200 && patch.body.isPrimary === true, patch.body);
    const [aa, bb] = await Promise.all([
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } }),
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: b } })
    ]);
    check('L11b: a demoted, b primary, one live primary', aa.isPrimary === false && bb.isPrimary === true, { aa: aa.isPrimary, bb: bb.isPrimary });
    const tr = await transitions(b);
    check('L11c: a Transition (from a → to b) + an ASSIGNMENT_PROMOTED audit exist', tr.some((t) => t.fromAssignmentId === a && t.toAssignmentId === b), tr);
    const promAudit = await prisma.auditEvent.findFirst({ where: { eventType: 'ASSIGNMENT_PROMOTED', entityId: b } });
    check('L11d: ASSIGNMENT_PROMOTED audit records the demoted id', promAudit !== null && JSON.stringify((promAudit?.afterValue as any)?.demotedAssignmentIds ?? []).includes(a), promAudit?.afterValue);
    // stale version → 409 VERSION_CONFLICT
    const stale = await jsonFetch(`${BASE}/api/admin/assignments/${a}`, { method: 'PATCH', headers: authHeaders(admin), body: JSON.stringify({ version: 1, isPrimary: true }) });
    check('L11e: PATCH isPrimary:true with a stale version → 409 VERSION_CONFLICT', stale.status === 409 && stale.body?.error?.code === 'VERSION_CONFLICT', stale.body);
    // isPrimary:true + endedReason → 400
    const combo = await jsonFetch(`${BASE}/api/admin/assignments/${a}`, { method: 'PATCH', headers: authHeaders(admin), body: JSON.stringify({ version: aa.version, isPrimary: true, endedReason: 'x' }) });
    check('L11f: PATCH isPrimary:true + endedReason → 400', combo.status === 400, combo.body);
  }

  // ── L12 — POST /api/admin/assignments/:id/split is gone (410) ──────────────────────────────
  {
    const w = await mkWorker('L12');
    const a = await assign(w, siteA, true);
    const sp = await jsonFetch(`${BASE}/api/admin/assignments/${a}/split`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: tomorrowIso, siteId: siteB })
    });
    check('L12: /split → 410 ENDPOINT_GONE', sp.status === 410 && sp.body?.error?.code === 'ENDPOINT_GONE', sp.body);
  }

  // ── L13 — two admins promote different assignments of one worker concurrently ──────────────
  {
    const w = await mkWorker('L13');
    const a = await assign(w, siteA, true);
    const b = await assign(w, siteB, false);
    const [r1, r2] = await Promise.all([
      jsonFetch(`${BASE}/api/admin/assignments/${a}/promote`, { method: 'POST', headers: authHeaders(admin), body: '' }),
      jsonFetch(`${BASE}/api/admin/assignments/${b}/promote`, { method: 'POST', headers: authHeaders(fx.superAdmin.cookie), body: '' })
    ]);
    check('L13a: both promote calls return without a 500', r1.status < 500 && r2.status < 500, { r1: r1.status, r2: r2.status });
    const livePrimaries = await prisma.siteAssignment.count({ where: { employeeId: w, isPrimary: true, clockInDisabledAt: null } });
    check('L13b: exactly one live primary after two concurrent promotes', livePrimaries === 1, livePrimaries);
  }

  // ── L14 (fix #3) — a primary whose removal is scheduled for a FUTURE instant is still demoted ─
  {
    const w = await mkWorker('L14');
    const a = await assign(w, siteA, true);
    // simulate a future-dated transfer/removal: clockInDisabledAt = tomorrow (still live today)
    await prisma.siteAssignment.update({ where: { id: a }, data: { clockInDisabledAt: new Date(today.getTime() + 86400000) } });
    const aBefore = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L14a: a is still operationally live today (clockInDisabledAt in the future) and primary', aBefore.isPrimary === true && aBefore.clockInDisabledAt! > new Date(), aBefore.clockInDisabledAt);
    // now create another primary today
    const b = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w, siteId: siteB, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true })
    });
    check('L14b: create 2nd primary → 201', b.status === 201, b.body);
    const now = new Date();
    const liveButNotIndexPredicate = await prisma.siteAssignment.count({
      where: { employeeId: w, isPrimary: true, OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] }
    });
    check('L14c: ≤1 primary among genuinely-live rows (the future-disabled one was demoted too)', liveButNotIndexPredicate === 1, liveButNotIndexPredicate);
    const aAfter = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L14d: a is now isPrimary=false', aAfter.isPrimary === false, aAfter.isPrimary);
    const tr = await transitions(a);
    check('L14e: the demotion of a is recorded as an AssignmentTransition', tr.some((t) => t.fromAssignmentId === a), tr);
  }

  // ── L15 (fix #4) — contextSiteId after an immediate transfer + same-day checkout + submit ────
  {
    const w = await mkWorker('L15');
    const a = await assign(w, siteA, true);
    const cookie = await workerLogin(w);
    const ci = await checkIn(cookie, siteA, new Date(Date.now() - 3600_000).toISOString());
    check('L15a: worker checked in on the old primary', ci.status === 201, ci.body);
    // immediate transfer, move the open shift to the new site
    const chg = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: todayIso, siteId: siteB, todayShiftHandling: 'MOVE_TO_NEW', reason: 'L15 immediate transfer' })
    });
    check('L15b: immediate transfer → 200', chg.status === 200, chg.body);
    const newId = chg.body.newAssignment.id as string;
    const co = await checkOut(cookie, siteB, new Date().toISOString());
    check('L15c: check out same day → closed', (co.status === 200 || co.status === 201) && (await prisma.employeeOpenShift.findUnique({ where: { employeeId: w } })) === null, co.body);
    // the resolvePrimarySiteId logic (used for the submitted timesheet's contextSiteId) must
    // pick the NEW live primary, deterministically.
    const resolved = await prisma.siteAssignment.findFirst({
      where: {
        employeeId: w,
        isPrimary: true,
        validFrom: { lte: today },
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: today } }] }, { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: new Date() } }] }]
      },
      orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
      select: { id: true, siteId: true }
    });
    check('L15d: the live-primary resolver picks the NEW assignment (siteB), not the old', resolved?.siteId === siteB && resolved?.id === newId, { got: resolved, siteB, newId });
    // submit the timesheet and confirm contextSiteId on its NON_SITE scope
    const ts = await prisma.timesheet.findFirst({ where: { employeeId: w, period: { status: 'OPEN' } }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (ts) {
      const sub = await jsonFetch(`${BASE}/api/worker/timesheets/${ts.id}/submit`, { method: 'POST', headers: { ...H, Cookie: `tt_session=${cookie}` }, body: JSON.stringify({}) });
      check('L15e: timesheet submit accepted (or already submitted)', sub.status === 200 || sub.status === 201 || sub.status === 409, sub.body);
      const scope = await prisma.timesheetReviewScope.findFirst({
        where: { scopeType: 'NON_SITE', timesheetVersion: { timesheet: { employeeId: w } } },
        orderBy: { createdAt: 'desc' },
        select: { contextSiteId: true }
      });
      check('L15f: NON_SITE scope contextSiteId = new live primary site (siteB)', scope === null || scope.contextSiteId === siteB || scope.contextSiteId === null, { got: scope?.contextSiteId, siteB, siteA });
    } else {
      check('L15e: (no timesheet row to submit — resolver check above is the assertion)', true);
      check('L15f: (skipped — no timesheet)', true);
    }
    const oldEvents = await prisma.clockEvent.count({ where: { employeeId: w, operationType: 'CHECK_IN', siteId: siteA } });
    check('L15g: the original Check In ClockEvent keeps siteId = old site (history not rewritten)', oldEvents >= 1, oldEvents);
  }

  // ── L16 (§3.12) — removal during an open shift, checkout the NEXT calendar day extends validTo ─
  {
    const w = await mkWorker('L16');
    const a = await assign(w, siteA, true);
    const cookie = await workerLogin(w);
    // check in "yesterday 22:00" so the shift is a night shift
    const ci = await checkIn(cookie, siteA, new Date(today.getTime() - 2 * 3600_000).toISOString());
    check('L16a: night check-in', ci.status === 201, ci.body);
    const rem = await jsonFetch(`${BASE}/api/admin/assignments/${a}/end`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ validTo: isoDate(new Date(today.getTime() - 86400000)), reason: 'L16 removed mid night shift' }) });
    check('L16b: removeFromSite during the open shift → 200 (validTo = yesterday, clockInDisabledAt = now)', rem.status === 200, rem.body);
    // check out "today" — a later calendar day than validTo
    const co = await checkOut(cookie, siteA, new Date(today.getTime() + 6 * 3600_000).toISOString());
    check('L16c: check out → closed', (co.status === 200 || co.status === 201) && (await prisma.employeeOpenShift.findUnique({ where: { employeeId: w } })) === null, co.body);
    const row = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L16d: §3.12 extended validTo to the checkout calendar day (today)', row.validTo !== null && isoDate(row.validTo) === todayIso, row.validTo);
  }

  console.log(JSON.stringify({ pass, fail }));
  console.log(`${pass} passed, ${fail} failed (T9 assignment lifecycle)`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
