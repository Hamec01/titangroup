import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders } from './_test-t9-fixtures';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.8 / §3.9 / §3.13 (L) — R15-D7 Deploy C.
// Real HTTP against the production standalone build, disposable PostgreSQL 16, DB assertions, no
// mocks. Covers: finish-site preflight + finish (live assignments operationally closed, future
// cancelled, active=false + finishedAt), the server constraint L (finished site / disabled
// customer refuse new + transferred-in assignments), "finishing" vs "finished" by open-shift
// presence, Check Out never blocked, reopen (assignments NOT revived); disable-customer preflight,
// the explicit decision (leave-on-site-no-customer / remove), decision-required 409, PATCH
// active=false guard, enable-customer.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : '');
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

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

async function main() {
  const fx = await buildFixture(BASE);
  const admin = fx.admin.cookie;
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' };
  const today = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date())}T00:00:00.000Z`);
  const todayIso = isoDate(today);
  const tomorrowIso = isoDate(new Date(today.getTime() + 86400000));
  const inAWeek = isoDate(new Date(today.getTime() + 7 * 86400000));

  const mkSite = async (label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/sites`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ name: `SL ${label} ${fx.run}` })
    });
    if (r.status !== 201) throw new Error(`mkSite ${label} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const mkWorkArea = async (siteId: string, label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/sites/${siteId}/work-areas`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ name: `WA ${label} ${fx.run}` })
    });
    if (r.status !== 201) throw new Error(`mkWorkArea ${label} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const mkWorker = async (label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/workers`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ firstName: 'SL', lastName: `${label}${fx.run}` })
    });
    return r.body.employee.id as string;
  };
  const assign = async (
    employeeId: string,
    siteId: string,
    opts: { isPrimary?: boolean; validFrom?: string; workAreaId?: string | null } = {}
  ): Promise<{ status: number; body: any }> => {
    return jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({
        employeeId,
        siteId,
        templateId: fx.templateId,
        validFrom: opts.validFrom ?? '2020-01-01',
        isPrimary: opts.isPrimary ?? false,
        workAreaId: opts.workAreaId ?? null
      })
    });
  };
  const assignOk = async (employeeId: string, siteId: string, opts: Parameters<typeof assign>[2] = {}): Promise<string> => {
    const r = await assign(employeeId, siteId, opts);
    if (r.status !== 201) throw new Error(`assign -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const workerRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' }, select: { id: true } })).id;
  const workerLogin = async (employeeId: string): Promise<string> => {
    const u = await prisma.user.findFirstOrThrow({ where: { employeeId }, select: { id: true, status: true } });
    if (u.status !== 'ACTIVE') await prisma.user.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
    const hasRole = await prisma.userRole.findFirst({ where: { userId: u.id, roleId: workerRoleId, validTo: null }, select: { id: true } });
    if (!hasRole) await prisma.userRole.create({ data: { userId: u.id, roleId: workerRoleId } });
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    await prisma.userSession.create({
      data: { userId: u.id, tokenHash: createHash('sha256').update(token).digest('hex'), authLevel: 'PASSWORD', expiresAt: new Date(Date.now() + 86400000) }
    });
    return token;
  };
  const checkIn = (cookie: string, siteId: string) =>
    jsonFetch(`${BASE}/api/worker/attendance/check-in`, {
      method: 'POST',
      headers: { ...H, Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId: randomUUID(), siteId, workAreaId: null, clientCapturedAt: new Date().toISOString(), location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });
  const checkOut = (cookie: string, assumedSiteId: string) =>
    jsonFetch(`${BASE}/api/worker/attendance/check-out`, {
      method: 'POST',
      headers: { ...H, Cookie: `tt_session=${cookie}` },
      body: JSON.stringify({ clientEventId: randomUUID(), assumedSiteId, clientCapturedAt: new Date().toISOString(), location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' })
    });
  const siteRow = (id: string) => prisma.workSite.findUniqueOrThrow({ where: { id }, select: { active: true, finishedAt: true } });
  const asgRow = (id: string) => prisma.siteAssignment.findUniqueOrThrow({ where: { id } });
  const transitionsFor = (assignmentId: string) =>
    prisma.assignmentTransition.findMany({ where: { fromAssignmentId: assignmentId }, orderBy: { createdAt: 'asc' } });

  // ── C1 — finish-site preflight + finish ─────────────────────────────────────────────────────
  {
    const site = await mkSite('C1');
    const wa = await mkWorkArea(site, 'C1');
    const w1 = await mkWorker('C1a');
    const w2 = await mkWorker('C1b');
    const w3 = await mkWorker('C1c');
    const a1 = await assignOk(w1, site, { isPrimary: true, workAreaId: wa });
    const a2 = await assignOk(w2, site, { isPrimary: true });
    const a3 = await assignOk(w3, site, { isPrimary: true, validFrom: inAWeek }); // future

    const pre = await jsonFetch(`${BASE}/api/admin/sites/${site}/finish`, { headers: authHeaders(admin) });
    check('C1a: finish preflight 200', pre.status === 200, pre.body);
    check('C1b: preflight counts 2 assigned now + 1 future + 1 customer', pre.body.assignedCount === 2 && pre.body.futureAssignmentsCount === 1 && pre.body.customerCount === 1, pre.body);
    check('C1c: preflight names the affected workers', (pre.body.workers as any[]).length === 2 && (pre.body.futureWorkers as any[]).length === 1, pre.body);

    const fin = await jsonFetch(`${BASE}/api/admin/sites/${site}/finish`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
    check('C1d: finish 200', fin.status === 200, fin.body);
    check('C1e: finish result — 2 closed + 1 future cancelled', fin.body.closedAssignmentCount === 2 && fin.body.cancelledFutureAssignmentCount === 1, fin.body);

    const s = await siteRow(site);
    check('C1f: site active=false + finishedAt set', s.active === false && s.finishedAt !== null, s);
    const r1 = await asgRow(a1);
    const r2 = await asgRow(a2);
    const r3 = await asgRow(a3);
    check('C1g: live assignments got clockInDisabledAt + validTo=today', r1.clockInDisabledAt !== null && isoDate(r1.validTo!) === todayIso && r2.clockInDisabledAt !== null, { r1: r1.validTo, r2: r2.clockInDisabledAt });
    check('C1h: future assignment cancelled (clockInDisabledAt set, never live)', r3.clockInDisabledAt !== null, r3);
    const tr = await transitionsFor(a1);
    check('C1i: SITE_FINISH transition written per worker, one groupId', tr.length === 1 && tr[0].kind === 'SITE_FINISH' && tr[0].groupId === fin.body.groupId, tr);
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: site, eventType: 'SITE_FINISHED' } });
    check('C1j: SITE_FINISHED audit event written', audit !== null);

    // §3.13 L — finished site refuses a new assignment + a transfer onto it
    const newW = await mkWorker('C1d');
    const blocked = await assign(newW, site, { isPrimary: true });
    check('C1k: POST /assignments onto a finished site → 409 SITE_FINISHED', blocked.status === 409 && blocked.body?.error?.code === 'SITE_FINISHED', blocked.body);

    const elsewhere = await mkSite('C1elsewhere');
    const mover = await mkWorker('C1mv');
    const moverA = await assignOk(mover, elsewhere, { isPrimary: true });
    const moved = await jsonFetch(`${BASE}/api/admin/assignments/${moverA}/change`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ siteId: site, workAreaId: null, templateId: fx.templateId, isPrimary: true, effectiveFrom: tomorrowIso })
    });
    check('C1l: /change onto a finished site → 409 SITE_FINISHED', moved.status === 409 && moved.body?.error?.code === 'SITE_FINISHED', moved.body);

    // reopen — assignments NOT revived
    const re = await jsonFetch(`${BASE}/api/admin/sites/${site}/reopen`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
    check('C1m: reopen 200', re.status === 200 && re.body.assignmentsRevived === false, re.body);
    const s2 = await siteRow(site);
    check('C1n: reopened site active=true + finishedAt=null', s2.active === true && s2.finishedAt === null, s2);
    check('C1o: reopen did NOT revive the closed assignments', (await asgRow(a1)).clockInDisabledAt !== null && (await asgRow(a2)).clockInDisabledAt !== null);
    // after reopen a new assignment is allowed again
    const okAgain = await assign(newW, site, { isPrimary: true });
    check('C1p: after reopen a new assignment succeeds', okAgain.status === 201, okAgain.body);
  }

  // ── C2 — finish with an open shift: "finishing" → Check Out → "finished", never blocked ─────
  {
    const site = await mkSite('C2');
    const w = await mkWorker('C2');
    await assignOk(w, site, { isPrimary: true });
    const cookie = await workerLogin(w);
    const ci = await checkIn(cookie, site);
    check('C2a: worker checks in', ci.status === 200 || ci.status === 201, ci.body);

    const fin = await jsonFetch(`${BASE}/api/admin/sites/${site}/finish`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
    check('C2b: finish 200 with an open shift', fin.status === 200 && fin.body.openShiftsRemaining === 1, fin.body);

    const detail = await jsonFetch(`${BASE}/api/admin/sites/${site}`, { headers: authHeaders(admin) });
    check('C2c: site detail reports finishingState="finishing"', detail.body.finishingState === 'finishing' && (detail.body.stuckOpenShifts as any[]).length === 1, detail.body);

    const co = await checkOut(cookie, site);
    check('C2d: Check Out is NOT blocked by the finish', co.status === 200 || co.status === 201, co.body);

    const detail2 = await jsonFetch(`${BASE}/api/admin/sites/${site}`, { headers: authHeaders(admin) });
    check('C2e: after Check Out the site is "finished"', detail2.body.finishingState === 'finished', detail2.body);
  }

  // ── C3 — disable-customer: preflight, decision-required, LEAVE_ON_SITE_NO_CUSTOMER ──────────
  {
    const site = await mkSite('C3');
    const wa = await mkWorkArea(site, 'C3');
    const w1 = await mkWorker('C3a');
    const w2 = await mkWorker('C3b');
    const a1 = await assignOk(w1, site, { isPrimary: true, workAreaId: wa });
    const a2 = await assignOk(w2, site, { isPrimary: true, workAreaId: wa });

    const pre = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}/disable`, { headers: authHeaders(admin) });
    check('C3a: disable preflight 200 names 2 workers', pre.status === 200 && pre.body.assignedCount === 2 && (pre.body.workers as any[]).length === 2, pre.body);

    const noDecision = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}/disable`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
    check('C3b: disable with workers + no decision → 409 DECISION_REQUIRED + preview', noDecision.status === 409 && noDecision.body?.error?.code === 'DECISION_REQUIRED' && noDecision.body?.error?.preview?.assignedCount === 2, noDecision.body);

    const patchGuard = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}`, {
      method: 'PATCH',
      headers: authHeaders(admin),
      body: JSON.stringify({ version: 1, active: false })
    });
    check('C3c: PATCH work-area active=false with workers → 409 CUSTOMER_HAS_WORKERS', patchGuard.status === 409 && patchGuard.body?.error?.code === 'CUSTOMER_HAS_WORKERS', patchGuard.body);

    const done = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}/disable`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ decision: 'LEAVE_ON_SITE_NO_CUSTOMER' })
    });
    check('C3d: disable LEAVE_ON_SITE_NO_CUSTOMER 200', done.status === 200 && done.body.affectedCount === 2, done.body);

    const wa2 = await prisma.workArea.findUniqueOrThrow({ where: { id: wa }, select: { active: true } });
    check('C3e: customer active=false', wa2.active === false);
    check('C3f: old assignment closed (clockInDisabledAt) + validTo today', (await asgRow(a1)).clockInDisabledAt !== null && isoDate((await asgRow(a1)).validTo!) === todayIso);
    const replacements = await prisma.siteAssignment.findMany({ where: { employeeId: w1, siteId: site, workAreaId: null, clockInDisabledAt: null } });
    check('C3g: worker got a replacement assignment on the SAME site with NO customer', replacements.length === 1 && isoDate(replacements[0].validFrom) === tomorrowIso, replacements);
    const tr = await transitionsFor(a1);
    check('C3h: CUSTOMER_DISABLE transition written', tr.length === 1 && tr[0].kind === 'CUSTOMER_DISABLE', tr);
    check('C3i: a2 also handled', (await asgRow(a2)).clockInDisabledAt !== null);

    // §3.13 L — disabled customer refuses a new assignment
    const w3 = await mkWorker('C3c');
    const blocked = await assign(w3, site, { workAreaId: wa });
    check('C3j: POST /assignments with a disabled customer → 409 CUSTOMER_DISABLED', blocked.status === 409 && blocked.body?.error?.code === 'CUSTOMER_DISABLED', blocked.body);

    const en = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}/enable`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
    check('C3k: enable customer 200, not revived', en.status === 200 && en.body.assignmentsRevived === false, en.body);
    const okAgain = await assign(w3, site, { workAreaId: wa });
    check('C3l: after enable a new assignment on that customer succeeds', okAgain.status === 201, okAgain.body);
  }

  // ── C4 — disable-customer REMOVE_WORKERS ────────────────────────────────────────────────────
  {
    const site = await mkSite('C4');
    const wa = await mkWorkArea(site, 'C4');
    const w1 = await mkWorker('C4a');
    const a1 = await assignOk(w1, site, { isPrimary: true, workAreaId: wa });
    const done = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}/disable`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ decision: 'REMOVE_WORKERS' })
    });
    check('C4a: disable REMOVE_WORKERS 200', done.status === 200 && done.body.decision === 'REMOVE_WORKERS', done.body);
    const r1 = await asgRow(a1);
    check('C4b: worker removed (clockInDisabledAt + validTo today), NO replacement', r1.clockInDisabledAt !== null && isoDate(r1.validTo!) === todayIso, r1);
    const repl = await prisma.siteAssignment.count({ where: { employeeId: w1, clockInDisabledAt: null } });
    check('C4c: worker has no live assignment left', repl === 0, { repl });
  }

  // ── C5 — disable a customer with NO workers: straight through, no decision needed ───────────
  {
    const site = await mkSite('C5');
    const wa = await mkWorkArea(site, 'C5');
    const done = await jsonFetch(`${BASE}/api/admin/sites/${site}/work-areas/${wa}/disable`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
    check('C5a: disable an empty customer with no decision → 200', done.status === 200 && done.body.decision === 'NO_WORKERS' && done.body.affectedCount === 0, done.body);
    check('C5b: customer active=false', (await prisma.workArea.findUniqueOrThrow({ where: { id: wa }, select: { active: true } })).active === false);
  }

  console.log(`\n${pass} passed · ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
