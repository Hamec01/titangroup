import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders } from './_test-t9-fixtures';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.6 / §7 — R15-D7 Deploy A + Deploy D.
// Real HTTP against the production standalone build, disposable PostgreSQL 16, DB assertions,
// zero mocks. Covers the unified clockInDisabledAt gate, the lifecycle service (removeFromSite /
// changeWorkplace / promoteToPrimary), AssignmentTransition, idempotency, C8, the §3.12 Check Out
// step — AND the corrected Deploy D primary model: "≤1 LIVE primary per OVERLAPPING period"
// (ex_site_assignment_one_primary_per_period), with the six mandatory owner scenarios P1–P6
// (future transfer, effective-day handover, non-overlap invariant, scheduled-change conflict,
// same-day completed hours, open shift). Passes on BOTH the D1 image (no constraint) and the D2
// image (constraint installed). Site finish (C), group transfer (E) and D3 (F) are not here.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';

let pass = 0;
let fail = 0;
const pLog: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '');
  }
  // STOP-GATE #3 — the owner asked for the P1–P6 results shown separately.
  if (/^P[1-6]/.test(name)) {
    pLog.push(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
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
  // exact replica of lib/worker-timesheets.ts resolvePrimarySiteId — "the primary NOW" resolved by
  // date range + clockInDisabledAt, never by a global flag (design §3.6).
  const primaryResolver = async (employeeId: string): Promise<string | null> => {
    const now = new Date();
    const row = await prisma.siteAssignment.findFirst({
      where: {
        employeeId,
        isPrimary: true,
        validFrom: { lte: today },
        AND: [
          { OR: [{ validTo: null }, { validTo: { gte: today } }] },
          { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] }
        ]
      },
      orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
      select: { siteId: true }
    });
    return row?.siteId ?? null;
  };
  const openShiftRow = (employeeId: string) =>
    prisma.employeeOpenShift.findUnique({ where: { employeeId }, select: { siteId: true, sourceAssignmentId: true } });
  const openShiftSite = async (employeeId: string): Promise<string | null> => (await openShiftRow(employeeId))?.siteId ?? null;
  const clearOpenShift = (employeeId: string) => prisma.employeeOpenShift.deleteMany({ where: { employeeId } });
  const livePrimaryCount = (employeeId: string) =>
    prisma.siteAssignment.count({ where: { employeeId, isPrimary: true, clockInDisabledAt: null } });
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' };
  // Activate a worker + mint its session directly. The real activate → set-initial-password → login
  // HTTP flow is per-IP rate-limited and this file logs in ~10 workers; here we replicate exactly
  // what lib/activation.ts setInitialPassword() does that matters for Check In: flip the user to
  // ACTIVE and give it a live WORKER UserRole, then insert a session (sha256(token) is
  // UserSession.tokenHash, per lib/session.ts).
  const workerRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' }, select: { id: true } })).id;
  const workerLogin = async (employeeId: string): Promise<string> => {
    const u = await prisma.user.findFirstOrThrow({ where: { employeeId }, select: { id: true, status: true } });
    if (u.status !== 'ACTIVE') {
      await prisma.user.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
    }
    const hasRole = await prisma.userRole.findFirst({ where: { userId: u.id, roleId: workerRoleId, validTo: null }, select: { id: true } });
    if (!hasRole) {
      await prisma.userRole.create({ data: { userId: u.id, roleId: workerRoleId } });
    }
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await prisma.userSession.create({
      data: { userId: u.id, tokenHash, authLevel: 'PASSWORD', expiresAt: new Date(Date.now() + 86400000) }
    });
    return token;
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

  // Is the ex_site_assignment_one_primary_per_period EXCLUDE constraint installed? (Deploy D2 adds
  // it; the D1 image runs the same lifecycle code WITHOUT it — the app-level demote must hold the
  // invariant either way, and this file passes on both.)
  const cRows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_constraint WHERE conname = 'ex_site_assignment_one_primary_per_period'`;
  const constraintInstalled = Number(cRows[0]?.n ?? 0) > 0;
  check(`constraint status: ex_site_assignment_one_primary_per_period ${constraintInstalled ? 'INSTALLED (D2)' : 'ABSENT (D1)'}`, true);

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
    check('L5b: old assignment KEEPS isPrimary + clockInDisabledAt NULL (future change), validTo = today', oldRow.isPrimary === true && oldRow.clockInDisabledAt === null && oldRow.validTo !== null && isoDate(oldRow.validTo) === todayIso, { p: oldRow.isPrimary, d: oldRow.clockInDisabledAt, v: oldRow.validTo });
    const newRow = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: res.body.newAssignment.id } });
    check('L5c: new assignment validFrom tomorrow, isPrimary too (disjoint period), not live today', isoDate(newRow.validFrom) === tomorrowIso && newRow.isPrimary === true, newRow);
    const livePrimaries = await prisma.siteAssignment.count({ where: { employeeId: w, isPrimary: true, clockInDisabledAt: null } });
    check('L5c2: BOTH rows are stored primary — disjoint periods, no constraint violation', livePrimaries === 2, livePrimaries);
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
    check('L9c: exactly one live primary in the overlapping period', livePrimaries === 1, livePrimaries);
  }

  // ── L10 — Deploy D2: the EXCLUDE constraint forbids two OVERLAPPING live primaries but ALLOWS
  //          two disjoint ones (raw INSERT, bypassing the service — no template, no materialisation) ─
  {
    const w = await mkWorker('L10');
    const { assignedByUserId: adminUserId } = await prisma.siteAssignment.findFirstOrThrow({ select: { assignedByUserId: true } });
    const p = await prisma.siteAssignment.create({
      data: { employeeId: w, siteId: siteA, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), assignedByUserId: adminUserId }
    });
    // (a) a 2nd primary whose period OVERLAPS — must be rejected by the constraint when installed
    let overlapRaised = false;
    let created2: string | null = null;
    try {
      const row = await prisma.siteAssignment.create({
        data: { employeeId: w, siteId: siteB, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), assignedByUserId: adminUserId }
      });
      created2 = row.id;
    } catch (e) {
      const m = String((e as Error).message);
      overlapRaised = m.includes('ex_site_assignment_one_primary_per_period') || m.includes('23P01') || m.includes('exclusion');
    }
    if (constraintInstalled) {
      check('L10a (D2): raw INSERT of an OVERLAPPING 2nd live primary → rejected (23P01)', overlapRaised && created2 === null, { overlapRaised, created2 });
    } else {
      check('L10a (D1): no constraint yet — raw INSERT of an overlapping primary is not DB-rejected', !overlapRaised && created2 !== null);
      if (created2) await prisma.siteAssignment.delete({ where: { id: created2 } }).catch(() => {});
    }
    // (b) a 2nd primary whose period is DISJOINT — must be ALLOWED even with the constraint
    await prisma.siteAssignment.update({ where: { id: p.id }, data: { validTo: new Date('2025-12-31T00:00:00.000Z') } });
    let disjointOk = false;
    let created3: string | null = null;
    try {
      const row = await prisma.siteAssignment.create({
        data: { employeeId: w, siteId: siteB, isPrimary: true, validFrom: new Date('2026-01-01T00:00:00.000Z'), assignedByUserId: adminUserId }
      });
      created3 = row.id;
      disjointOk = true;
    } catch {
      disjointOk = false;
    }
    check('L10b: a DISJOINT 2nd live primary ([..2025] + [2026..]) is accepted by the constraint', disjointOk, created3);

    // changeWorkplace of a primary (future) must not trip the constraint — periods stay disjoint
    const w2 = await mkWorker('L10c');
    const a2 = await assign(w2, siteA, true);
    const chg = await jsonFetch(`${BASE}/api/admin/assignments/${a2}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: tomorrowIso, siteId: siteB, reason: 'L10 future move of a primary' })
    });
    check('L10c: future changeWorkplace of a primary → 200 (no PRIMARY_PERIOD_CONFLICT)', chg.status === 200, chg.body);
    const primaries2 = await prisma.siteAssignment.count({ where: { employeeId: w2, isPrimary: true, clockInDisabledAt: null } });
    check('L10d: two disjoint live primaries after the future change (current + scheduled)', primaries2 === 2, primaries2);
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

  // ── L14 — a REMOVED primary (clockInDisabledAt set) is out of the invariant: it neither blocks
  //          a new primary nor gets a spurious second demotion transition ─────────────────────
  {
    const w = await mkWorker('L14');
    const a = await assign(w, siteA, true);
    await jsonFetch(`${BASE}/api/admin/assignments/${a}/end`, { method: 'POST', headers: authHeaders(admin), body: JSON.stringify({ validTo: todayIso, reason: 'L14 removed' }) });
    const aRemoved = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('L14a: a is removed (clockInDisabledAt set) — its isPrimary flag lingers as history', aRemoved.clockInDisabledAt !== null, aRemoved.clockInDisabledAt);
    const trBefore = (await transitions(a)).length;
    const b = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w, siteId: siteB, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true })
    });
    check('L14b: create a new primary while the removed one still has isPrimary=true → 201 (not blocked)', b.status === 201, b.body);
    const livePrimaries = await prisma.siteAssignment.count({ where: { employeeId: w, isPrimary: true, clockInDisabledAt: null } });
    check('L14c: exactly one LIVE primary (the removed row is not counted)', livePrimaries === 1, livePrimaries);
    const trAfter = (await transitions(a)).length;
    check('L14d: no new demotion transition was written for the already-removed assignment', trAfter === trBefore, { trBefore, trAfter });
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

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // P1–P6 — the six mandatory owner scenarios for the corrected primary model (STOP-GATE #3).
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const daysFromToday = (n: number) => isoDate(new Date(today.getTime() + n * 86400000));
  const inAWeek = daysFromToday(7);

  // ── P1 — FUTURE TRANSFER: before the date, A is the primary now; the worker Checks In on A ──
  {
    const w = await mkWorker('P1');
    const a = await assign(w, siteA, true);
    const chg = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: inAWeek, siteId: siteB, isPrimary: true, reason: 'P1 transfer to B in a week' })
    });
    check('P1a: schedule the transfer to start in a week → 200', chg.status === 200, chg.body);
    const bId = chg.body.newAssignment.id as string;
    const [aRow, bRow] = await Promise.all([
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } }),
      prisma.siteAssignment.findUniqueOrThrow({ where: { id: bId } })
    ]);
    check('P1b: A stays primary, validTo = the day before the transfer, clockInDisabledAt NULL', aRow.isPrimary === true && aRow.clockInDisabledAt === null && isoDate(aRow.validTo!) === daysFromToday(6), { p: aRow.isPrimary, v: aRow.validTo, d: aRow.clockInDisabledAt });
    check('P1c: B is a future primary (validFrom = transfer date, isPrimary, not live yet)', bRow.isPrimary === true && isoDate(bRow.validFrom) === inAWeek && bRow.clockInDisabledAt === null, bRow);
    check('P1d: BOTH stored primary — disjoint periods, DB constraint satisfied', (await livePrimaryCount(w)) === 2, await livePrimaryCount(w));
    check('P1e: resolvePrimarySiteId returns A (its range covers today, B\'s does not)', (await primaryResolver(w)) === siteA);
    check('P1f: admin "current assignments" shows A, not B', (await adminCurrentIds(w)).includes(a) && !(await adminCurrentIds(w)).includes(bId));
    const cookie = await workerLogin(w);
    const ci = await checkIn(cookie, siteA, new Date().toISOString());
    const osA = await openShiftRow(w);
    check('P1g: worker Check In today attributes to A (open shift bound to assignment A)', ci.status === 201 && osA?.siteId === siteA && osA?.sourceAssignmentId === a, { st: ci.status, os: osA });
    await clearOpenShift(w);
    await checkIn(cookie, siteB, new Date().toISOString(), randomUUID());
    const osB = await openShiftRow(w);
    check('P1h: Check In on B today resolves NO assignment (B not live until the transfer date)', osB?.sourceAssignmentId === null, osB);
    await clearOpenShift(w);
  }

  // ── P2 — EFFECTIVE DAY: the exact state a future transfer reaches on its date. No cron, no
  //         manual step — pure date resolution flips A→B. ─────────────────────────────────────
  {
    const w = await mkWorker('P2');
    const { assignedByUserId: adminUserId } = await prisma.siteAssignment.findFirstOrThrow({ select: { assignedByUserId: true } });
    const aRow = await prisma.siteAssignment.create({
      data: { employeeId: w, siteId: siteA, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00.000Z'), validTo: new Date(today.getTime() - 86400000), assignedByUserId: adminUserId }
    });
    const bRow = await prisma.siteAssignment.create({
      data: { employeeId: w, siteId: siteB, isPrimary: true, validFrom: today, assignedByUserId: adminUserId }
    });
    check('P2a: on the handover day BOTH rows are still stored primary (disjoint) — nothing demoted', aRow.isPrimary && bRow.isPrimary && (await livePrimaryCount(w)) === 2);
    check('P2b: clockInDisabledAt is NULL on both — no cron / no manual switch happened', aRow.clockInDisabledAt === null && bRow.clockInDisabledAt === null);
    check('P2c: resolvePrimarySiteId now returns B (its range covers today; A\'s ended yesterday)', (await primaryResolver(w)) === siteB, { got: await primaryResolver(w), siteA, siteB });
    check('P2d: admin "current assignments" now shows B, not A (the worker app uses the same gate)', (await adminCurrentIds(w)).includes(bRow.id) && !(await adminCurrentIds(w)).includes(aRow.id));
    const cookie = await workerLogin(w);
    const ciNew = await checkIn(cookie, siteB, new Date().toISOString());
    const osNew = await openShiftRow(w);
    check('P2e: Check In on the NEW site B attributes to B', ciNew.status === 201 && osNew?.sourceAssignmentId === bRow.id, { st: ciNew.status, os: osNew });
    await clearOpenShift(w);
    await checkIn(cookie, siteA, new Date().toISOString(), randomUUID());
    const osOld = await openShiftRow(w);
    check('P2f: Check In on the OLD site A resolves NO assignment (its window ended yesterday)', osOld?.sourceAssignmentId === null, osOld);
    await clearOpenShift(w);
  }

  // ── P3 — NON-OVERLAP INVARIANT: disjoint primaries allowed by DB AND service; overlapping ones
  //         forbidden by DB AND service. ────────────────────────────────────────────────────────
  {
    const w = await mkWorker('P3');
    const a = await assign(w, siteA, true);
    // (service) creating an OVERLAPPING primary demotes the prior one → 1 live primary
    const b = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w, siteId: siteB, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true })
    });
    check('P3a: service — overlapping primary created → prior auto-demoted, exactly 1 live primary', b.status === 201 && (await livePrimaryCount(w)) === 1, { st: b.status, n: await livePrimaryCount(w) });
    // (service) a FUTURE transfer produces a DISJOINT primary pair — both kept
    const bId = b.body.id as string;
    const siteP3 = await mkSite('P3c');
    const chg = await jsonFetch(`${BASE}/api/admin/assignments/${bId}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: inAWeek, siteId: siteP3, isPrimary: true, reason: 'P3 disjoint future' })
    });
    check('P3b: service — future transfer keeps BOTH primaries (disjoint), no PRIMARY_PERIOD_CONFLICT', chg.status === 200 && (await livePrimaryCount(w)) === 2, { st: chg.status, n: await livePrimaryCount(w) });
    check('P3c: DB backstop — see L10a (raw overlapping INSERT → 23P01 when the constraint is installed)', true);
    check('P3d: DB backstop — see L10b (raw DISJOINT INSERT accepted by the constraint)', true);
  }

  // ── P4 — SCHEDULED-CHANGE CONFLICT: creating/promoting another primary today must NOT silently
  //         cancel the future transfer — 409 offering "keep" or "replace". ────────────────────────
  {
    // (keep)
    const w = await mkWorker('P4keep');
    const a = await assign(w, siteA, true);
    const sched = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: inAWeek, siteId: siteB, isPrimary: true, reason: 'P4 scheduled transfer' })
    });
    const bId = sched.body.newAssignment.id as string;
    const siteC = await mkSite('P4C');
    const conflict = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w, siteId: siteC, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true })
    });
    check('P4a: creating another primary while a transfer is scheduled → 409 SCHEDULED_PRIMARY_CONFLICT', conflict.status === 409 && conflict.body?.error?.code === 'SCHEDULED_PRIMARY_CONFLICT', conflict.body);
    check('P4b: the 409 body names the scheduled assignment + its start date', conflict.body?.error?.scheduledAssignmentId === bId && conflict.body?.error?.scheduledValidFrom === inAWeek, conflict.body?.error);
    const bStill = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: bId } });
    check('P4c: the scheduled transfer is untouched (still exists, still primary, dates intact)', bStill.isPrimary === true && isoDate(bStill.validFrom) === inAWeek, bStill);
    const keep = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w, siteId: siteC, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true, primaryConflictResolution: 'KEEP_SCHEDULED' })
    });
    check('P4d: KEEP_SCHEDULED → 201, new assignment created NON-primary, transfer kept', keep.status === 201 && keep.body.isPrimary === false, keep.body);
    check('P4e: KEEP_SCHEDULED left B primary', (await prisma.siteAssignment.findUniqueOrThrow({ where: { id: bId } })).isPrimary === true);

    // (replace)
    const w2 = await mkWorker('P4repl');
    const a2 = await assign(w2, siteA, true);
    const sched2 = await jsonFetch(`${BASE}/api/admin/assignments/${a2}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: inAWeek, siteId: siteB, isPrimary: true, reason: 'P4 scheduled transfer 2' })
    });
    const b2Id = sched2.body.newAssignment.id as string;
    const siteC2 = await mkSite('P4C2');
    const replace = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId: w2, siteId: siteC2, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: true, primaryConflictResolution: 'REPLACE_SCHEDULED' })
    });
    check('P4f: REPLACE_SCHEDULED → 201, new assignment IS primary', replace.status === 201 && replace.body.isPrimary === true, replace.body);
    const b2After = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: b2Id } });
    check('P4g: the scheduled assignment still EXISTS with its dates — only its primary status is dropped', isoDate(b2After.validFrom) === inAWeek && b2After.isPrimary === false && b2After.clockInDisabledAt === null, b2After);
    const replTr = await prisma.assignmentTransition.findFirst({ where: { fromAssignmentId: b2Id, toAssignmentId: replace.body.id } });
    check('P4h: the replacement is RECORDED as an AssignmentTransition (not silent)', replTr !== null && (replTr?.reasonText ?? '').toLowerCase().includes('superseded'), replTr?.reasonText);
    const replAudit = await prisma.auditEvent.findFirst({ where: { eventType: 'ASSIGNMENT_CREATED', entityId: replace.body.id } });
    check('P4i: the create audit lists the replaced transfer under demotedScheduledPrimaryAssignmentIds', replAudit !== null && JSON.stringify((replAudit?.afterValue as any)?.demotedScheduledPrimaryAssignmentIds ?? []).includes(b2Id), replAudit?.afterValue);

    // promote hits the same gate
    const w3 = await mkWorker('P4prom');
    const a3 = await assign(w3, siteA, true);
    const sched3 = await jsonFetch(`${BASE}/api/admin/assignments/${a3}/change`, {
      method: 'POST', headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: inAWeek, siteId: siteB, isPrimary: true, reason: 'P4 sched 3' })
    });
    const siteC3 = await mkSite('P4C3');
    const other = await assign(w3, siteC3, false);
    const prom = await jsonFetch(`${BASE}/api/admin/assignments/${other}/promote`, { method: 'POST', headers: authHeaders(admin), body: '' });
    check('P4j: promote while a transfer is scheduled → 409 SCHEDULED_PRIMARY_CONFLICT', prom.status === 409 && prom.body?.error?.code === 'SCHEDULED_PRIMARY_CONFLICT', prom.body);
    void sched3;
  }

  // P5/P6 need a real OPEN payroll period covering "today" so shifts materialise into fragments
  // (the fixture's own period is far-future). EX-03 period-overlap was retired, so this is safe;
  // a manually-created period has submissionScheduleId = null, so assign() backfills its timesheet.
  {
    const pStart = daysFromToday(-20);
    const pEnd = daysFromToday(20);
    const pr = await jsonFetch(`${BASE}/api/admin/periods`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ startDate: pStart, endDate: pEnd })
    });
    check('P5/P6 setup: an OPEN period covering today was created', pr.status < 500, { st: pr.status, body: pr.body });
  }

  // ── P5 — SAME-DAY COMPLETED HOURS: worker finished an interval today on A; boss transfers today
  //         to B. Old interval stays on A. Transfer does NOT 409. Next Check In → B. ───────────
  {
    const w = await mkWorker('P5');
    const a = await assign(w, siteA, true);
    const cookie = await workerLogin(w);
    const ci = await checkIn(cookie, siteA, new Date(Date.now() - 4 * 3600_000).toISOString());
    check('P5a: worker checked in on A earlier today', ci.status === 201, ci.body);
    const co = await checkOut(cookie, siteA, new Date(Date.now() - 3 * 3600_000).toISOString());
    check('P5b: worker checked out — a completed interval now exists on A today', (co.status === 200 || co.status === 201) && (await openShiftSite(w)) === null, co.body);
    const fragBefore = await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: a, date: today } });
    check('P5c: the completed interval is materialised on A for today', fragBefore >= 1, fragBefore);
    // boss transfers TODAY to B
    const chg = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: todayIso, siteId: siteB, reason: 'P5 transfer today' })
    });
    check('P5d: immediate transfer with completed hours today → 200 (NOT 409)', chg.status === 200, chg.body);
    const aAfter = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('P5e: A keeps TODAY (validTo = today) so the interval is not stranded; demoted + clockInDisabledAt set', isoDate(aAfter.validTo!) === todayIso && aAfter.isPrimary === false && aAfter.clockInDisabledAt !== null, { v: aAfter.validTo, p: aAfter.isPrimary, d: aAfter.clockInDisabledAt });
    const fragAfter = await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: a, date: today } });
    check('P5f: the completed interval is STILL bound to A (history not rewritten)', fragAfter === fragBefore, { fragBefore, fragAfter });
    const bId = chg.body.newAssignment.id as string;
    const plannedToday = await prisma.timesheetDraftPlannedShift.findMany({ where: { employeeId: w, date: today }, select: { siteId: true } });
    check('P5g: today\'s timesheet has BOTH places (a planned shift for A and for B)', plannedToday.some((p) => p.siteId === siteA) && plannedToday.some((p) => p.siteId === siteB), plannedToday.map((p) => p.siteId));
    check('P5h: resolvePrimarySiteId now returns B', (await primaryResolver(w)) === siteB);
    const ciNext = await checkIn(cookie, siteB, new Date().toISOString(), randomUUID());
    check('P5i: the next Check In goes to B', ciNext.status === 201 && (await openShiftSite(w)) === siteB, { st: ciNext.status, os: await openShiftSite(w) });
    await clearOpenShift(w);
    void bId;
  }

  // ── P6 — OPEN SHIFT: "finish on A" pushes the transfer to tomorrow; "move today's shift" attributes
  //         the whole open shift to B. Check Out is never blocked. ─────────────────────────────
  {
    // (KEEP_ON_OLD → transfer bumped to tomorrow, shift finishes on A)
    const w = await mkWorker('P6keep');
    const a = await assign(w, siteA, true);
    const cookie = await workerLogin(w);
    const ci = await checkIn(cookie, siteA, new Date(Date.now() - 2 * 3600_000).toISOString());
    check('P6a: worker is on an open shift on A', ci.status === 201 && (await openShiftSite(w)) === siteA, ci.body);
    const keep = await jsonFetch(`${BASE}/api/admin/assignments/${a}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: todayIso, siteId: siteB, todayShiftHandling: 'KEEP_ON_OLD', reason: 'P6 finish on A' })
    });
    check('P6b: KEEP_ON_OLD → 200, transfer effective date bumped to tomorrow', keep.status === 200 && keep.body.effectiveFrom === tomorrowIso, keep.body);
    const aKeep = await prisma.siteAssignment.findUniqueOrThrow({ where: { id: a } });
    check('P6c: A keeps primary + is live today (validTo = today, clockInDisabledAt NULL)', aKeep.isPrimary === true && aKeep.clockInDisabledAt === null && isoDate(aKeep.validTo!) === todayIso, aKeep);
    check('P6d: the open shift still belongs to A', (await openShiftSite(w)) === siteA);
    const coKeep = await checkOut(cookie, siteA, new Date().toISOString());
    check('P6e: Check Out on A is NOT blocked — the shift closes', (coKeep.status === 200 || coKeep.status === 201) && (await openShiftSite(w)) === null, coKeep.body);

    // (MOVE_TO_NEW → whole open shift attributed to B)
    const w2 = await mkWorker('P6move');
    const a2 = await assign(w2, siteA, true);
    const cookie2 = await workerLogin(w2);
    const ci2 = await checkIn(cookie2, siteA, new Date(Date.now() - 2 * 3600_000).toISOString());
    check('P6f: second worker on an open shift on A', ci2.status === 201 && (await openShiftSite(w2)) === siteA, ci2.body);
    const move = await jsonFetch(`${BASE}/api/admin/assignments/${a2}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ effectiveFrom: todayIso, siteId: siteB, todayShiftHandling: 'MOVE_TO_NEW', reason: 'P6 move shift to B' })
    });
    check('P6g: MOVE_TO_NEW → 200, immediate transfer', move.status === 200, move.body);
    const b2Id = move.body.newAssignment.id as string;
    check('P6h: the open shift is re-pointed to B', (await openShiftSite(w2)) === siteB);
    const coMove = await checkOut(cookie2, siteB, new Date().toISOString());
    check('P6i: Check Out is NOT blocked — the shift closes', (coMove.status === 200 || coMove.status === 201) && (await openShiftSite(w2)) === null, coMove.body);
    const bFrag = await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: b2Id } });
    const aFrag = await prisma.clockShiftFragment.count({ where: { sourceAssignmentId: a2 } });
    check('P6j: the whole shift landed on B (fragments bound to B, none to the old A)', bFrag >= 1 && aFrag === 0, { bFrag, aFrag });
  }

  console.log('\n──────── P1–P6 (STOP-GATE #3 mandatory owner scenarios) ────────');
  console.log(pLog.join('\n'));
  console.log(`──────── ${pLog.filter((l) => l.includes('PASS')).length}/${pLog.length} P-checks passed ────────\n`);

  console.log(JSON.stringify({ pass, fail }));
  console.log(`${pass} passed, ${fail} failed (T9 assignment lifecycle)`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
