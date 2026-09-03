import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders } from './_test-t9-fixtures';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §M / §8-E — R15-D7 Deploy E "Групповой
// перевод". Real HTTP against the production standalone build, disposable PostgreSQL 16, DB
// assertions, no mocks. Covers: preflight breakdown (READY / already-scheduled), the batch
// transfer (one groupId, one transaction, one audit event, GROUP_CHANGE transitions), future-only
// guard, source scoping, the target-site L guard, whole-batch rollback on a single conflict
// (design test 27), and the calendar handover (before effectiveFrom the OLD site is still primary).

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : '');
  }
}
async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

async function main() {
  const fx = await buildFixture(BASE);
  const admin = fx.admin.cookie;
  const today = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date())}T00:00:00.000Z`);
  const todayIso = isoDate(today);
  const inTwoDays = isoDate(new Date(today.getTime() + 2 * 86400000));
  const inThreeDays = isoDate(new Date(today.getTime() + 3 * 86400000));

  const mkSite = async (label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/sites`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ name: `GT ${label} ${fx.run}` })
    });
    if (r.status !== 201) throw new Error(`mkSite ${label}: ${r.status}`);
    return r.body.id as string;
  };
  const mkWA = async (siteId: string, label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/sites/${siteId}/work-areas`, {
      method: 'POST',
      headers: authHeaders(admin),
      body: JSON.stringify({ name: `GT WA ${label} ${fx.run}` })
    });
    if (r.status !== 201) throw new Error(`mkWA ${label}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const mkWorker = async (label: string): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/workers`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ firstName: 'GT', lastName: `${label}${fx.run}` })
    });
    return r.body.employee.id as string;
  };
  const assign = async (employeeId: string, siteId: string, opts: { isPrimary?: boolean; workAreaId?: string | null } = {}): Promise<string> => {
    const r = await jsonFetch(`${BASE}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(admin, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId, siteId, templateId: fx.templateId, validFrom: '2020-01-01', isPrimary: opts.isPrimary ?? true, workAreaId: opts.workAreaId ?? null })
    });
    if (r.status !== 201) throw new Error(`assign: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const asg = (id: string) => prisma.siteAssignment.findUniqueOrThrow({ where: { id } });
  const liveOn = (employeeId: string, siteId: string) =>
    prisma.siteAssignment.count({ where: { employeeId, siteId, clockInDisabledAt: null } });
  const primaryNow = async (employeeId: string): Promise<string | null> => {
    const now = new Date();
    const row = await prisma.siteAssignment.findFirst({
      where: {
        employeeId,
        isPrimary: true,
        validFrom: { lte: today },
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: today } }] }, { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] }]
      },
      orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
      select: { siteId: true }
    });
    return row?.siteId ?? null;
  };

  const src = await mkSite('src');
  const srcWaX = await mkWA(src, 'X');
  const dst = await mkSite('dst');
  const dstWa = await mkWA(dst, 'D');
  const elsewhere = await mkSite('elsewhere');

  // ── E1 — preflight breakdown ───────────────────────────────────────────────────────────────
  const w1 = await mkWorker('e1a');
  const w2 = await mkWorker('e1b');
  const w3 = await mkWorker('e1c');
  const a1 = await assign(w1, src, { workAreaId: srcWaX });
  const a2 = await assign(w2, src, { workAreaId: srcWaX });
  const a3 = await assign(w3, src);
  // w3 already has a scheduled transfer to `elsewhere` from inTwoDays -> a3.validTo = inTwoDays-1
  const sched = await jsonFetch(`${BASE}/api/admin/assignments/${a3}/change`, {
    method: 'POST',
    headers: authHeaders(admin),
    body: JSON.stringify({ siteId: elsewhere, workAreaId: null, templateId: fx.templateId, isPrimary: true, effectiveFrom: inTwoDays })
  });
  check('E1-setup: w3 scheduled transfer created', sched.status === 200, sched.body);

  const pre = await jsonFetch(`${BASE}/api/admin/assignments/group-change?sourceSiteId=${src}&effectiveFrom=${inThreeDays}&isPrimary=true`, { headers: authHeaders(admin) });
  check('E1a: preflight 200', pre.status === 200, pre.body);
  check(
    'E1b: 3 workers listed, w1/w2 READY, w3 ALREADY_SCHEDULED, readyCount=2',
    pre.body.workers.length === 3 &&
      pre.body.readyCount === 2 &&
      pre.body.workers.find((w: any) => w.assignmentId === a3)?.status === 'ALREADY_SCHEDULED' &&
      pre.body.workers.find((w: any) => w.assignmentId === a1)?.status === 'READY',
    pre.body.workers
  );
  check('E1c: today as effectiveFrom → 400', (await jsonFetch(`${BASE}/api/admin/assignments/group-change?sourceSiteId=${src}&effectiveFrom=${todayIso}`, { headers: authHeaders(admin) })).status === 400);
  const scoped = await jsonFetch(`${BASE}/api/admin/assignments/group-change?sourceSiteId=${src}&sourceWorkAreaId=${srcWaX}&effectiveFrom=${inThreeDays}&isPrimary=true`, { headers: authHeaders(admin) });
  check('E1d: source scoped to one customer → only its 2 workers', scoped.body.workers.length === 2, scoped.body.workers);

  // ── E2 — the batch transfer ───────────────────────────────────────────────────────────────
  const res = await jsonFetch(`${BASE}/api/admin/assignments/group-change`, {
    method: 'POST',
    headers: authHeaders(admin),
    body: JSON.stringify({ assignmentIds: [a1, a2], siteId: dst, workAreaId: dstWa, templateId: fx.templateId, isPrimary: true, effectiveFrom: inThreeDays })
  });
  check('E2a: transfer 200, 2 transferred', res.status === 200 && res.body.transferredCount === 2, res.body);
  const groupId = res.body.groupId as string;
  const r1 = await asg(a1);
  const r2 = await asg(a2);
  check('E2b: old rows closed before effectiveFrom, KEEP isPrimary, NOT clockInDisabled (future)', isoDate(r1.validTo!) < inThreeDays && r1.isPrimary && r2.isPrimary && r1.clockInDisabledAt === null, { v1: r1.validTo, p1: r1.isPrimary, c1: r1.clockInDisabledAt });
  check('E2c: each worker has a new live primary on the target site+customer from effectiveFrom', (await prisma.siteAssignment.count({ where: { employeeId: w1, siteId: dst, workAreaId: dstWa, isPrimary: true, validFrom: new Date(`${inThreeDays}T00:00:00.000Z`) } })) === 1 && (await prisma.siteAssignment.count({ where: { employeeId: w2, siteId: dst, workAreaId: dstWa } })) === 1);
  const trs = await prisma.assignmentTransition.findMany({ where: { groupId } });
  check('E2d: 2 GROUP_CHANGE transitions with the shared groupId', trs.length === 2 && trs.every((t) => t.kind === 'GROUP_CHANGE' && t.groupId === groupId), trs.map((t) => t.kind));
  const audits = await prisma.auditEvent.findMany({ where: { eventType: 'ASSIGNMENT_GROUP_CHANGED' } });
  check('E2e: exactly ONE ASSIGNMENT_GROUP_CHANGED audit for the batch', audits.length === 1 && (audits[0].afterValue as any).transferredCount === 2, audits[0]?.afterValue);
  check('E2f: before effectiveFrom the OLD site is still "the primary now" (calendar handover)', (await primaryNow(w1)) === src);

  // ── E3 — whole-batch rollback on a single conflict (design test 27) ────────────────────────
  const w4 = await mkWorker('e3a');
  const w5 = await mkWorker('e3b');
  const a4 = await assign(w4, src);
  const a5 = await assign(w5, src);
  await assign(w5, dst, { workAreaId: dstWa }); // w5 already has an open-ended assignment on the target → EX-02 overlap on execute
  const before4 = await liveOn(w4, dst);
  const bad = await jsonFetch(`${BASE}/api/admin/assignments/group-change`, {
    method: 'POST',
    headers: authHeaders(admin),
    body: JSON.stringify({ assignmentIds: [a4, a5], siteId: dst, workAreaId: dstWa, templateId: fx.templateId, isPrimary: true, effectiveFrom: inThreeDays })
  });
  check('E3a: batch with one conflicting worker → 409 BATCH_CONFLICT (ASSIGNMENT_OVERLAP)', bad.status === 409 && bad.body?.error?.code === 'BATCH_CONFLICT' && bad.body?.error?.conflict === 'ASSIGNMENT_OVERLAP', bad.body);
  check('E3b: whole batch rolled back — the OTHER worker was NOT transferred', (await liveOn(w4, dst)) === before4 && (await asg(a4)).validTo === null);
  check('E3c: no GROUP_CHANGE transitions written for the failed batch', (await prisma.assignmentTransition.count({ where: { fromAssignmentId: { in: [a4, a5] }, kind: 'GROUP_CHANGE' } })) === 0);

  // ── E4 — target-site L guard ──────────────────────────────────────────────────────────────
  const finished = await mkSite('finished');
  await jsonFetch(`${BASE}/api/admin/sites/${finished}/finish`, { method: 'POST', headers: authHeaders(admin), body: '{}' });
  const w6 = await mkWorker('e4');
  const a6 = await assign(w6, src);
  const toFinished = await jsonFetch(`${BASE}/api/admin/assignments/group-change`, {
    method: 'POST',
    headers: authHeaders(admin),
    body: JSON.stringify({ assignmentIds: [a6], siteId: finished, templateId: fx.templateId, isPrimary: true, effectiveFrom: inThreeDays })
  });
  check('E4a: group transfer onto a finished site → 409 SITE_FINISHED', toFinished.status === 409 && toFinished.body?.error?.code === 'SITE_FINISHED', toFinished.body);
  check('E4b: nothing changed for that worker', (await asg(a6)).validTo === null);

  console.log(`\n${pass} passed · ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
