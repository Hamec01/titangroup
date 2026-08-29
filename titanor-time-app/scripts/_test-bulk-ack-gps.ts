// T14.5c (2026-08-29) — bulkAcknowledgeGpsNotVerified: filter-scoped bulk ACKNOWLEDGE_AS_VALID,
// GPS_NOT_VERIFIED / OPEN only, one summary audit event, refuses an unscoped call.
// Needs a disposable PostgreSQL 16 (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { bulkAcknowledgeGpsNotVerified } from '../lib/attendance-exception-resolution';
import { POST as bulkRoute } from '../app/api/admin/attendance/exceptions/bulk-acknowledge-gps/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

async function mkExc(employeeId: string, siteId: string, type: string, status: 'OPEN' | 'RESOLVED') {
  return prisma.attendanceException.create({
    data: { type: type as never, employeeId, siteId, occurredAt: new Date(), status, ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}) }
  });
}

async function main() {
  const admin = await prisma.user.create({ data: { username: `bulkack_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } })).id } } } });
  const siteX = await prisma.workSite.create({ data: { name: `BulkX ${randomUUID().slice(0, 4)}` } });
  const siteY = await prisma.workSite.create({ data: { name: `BulkY ${randomUUID().slice(0, 4)}` } });
  const emps = await Promise.all(
    [0, 1, 2].map((i) => prisma.employee.create({ data: { employeeNumber: `BK-${i}-${randomUUID().slice(0, 6)}`, firstName: 'Bulk', lastName: `E${i}` } }))
  );

  // 3 OPEN GPS_NOT_VERIFIED at site X (target), + noise that must be left alone:
  const targets = await Promise.all(emps.map((e) => mkExc(e.id, siteX.id, 'GPS_NOT_VERIFIED', 'OPEN')));
  const noiseResolvedSameSite = await mkExc(emps[0].id, siteX.id, 'GPS_NOT_VERIFIED', 'RESOLVED');
  const noiseOtherTypeSameSite = await mkExc(emps[1].id, siteX.id, 'DOUBLE_CHECK_IN', 'OPEN');
  const noiseOtherSite = await mkExc(emps[2].id, siteY.id, 'GPS_NOT_VERIFIED', 'OPEN');

  // 1. unscoped -> NO_SCOPE, nothing touched
  const r0 = await bulkAcknowledgeGpsNotVerified({}, admin.id, randomUUID());
  check('1: unscoped call -> NO_SCOPE', r0.kind === 'NO_SCOPE', r0);

  // 2. scoped to site X
  const auditBefore = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID' } });
  const r1 = await bulkAcknowledgeGpsNotVerified({ siteId: siteX.id }, admin.id, randomUUID());
  check('2: -> OK, acknowledgedCount 3', r1.kind === 'OK' && r1.acknowledgedCount === 3, r1);

  const freshTargets = await prisma.attendanceException.findMany({ where: { id: { in: targets.map((t) => t.id) } } });
  check('2: all 3 targets RESOLVED with actor + note', freshTargets.every((t) => t.status === 'RESOLVED' && t.resolvedByUserId === admin.id && !!t.resolutionNote && t.resolvedAt !== null), freshTargets.map((t) => t.status));

  check('2: RESOLVED same-site GPS exception untouched', (await prisma.attendanceException.findUniqueOrThrow({ where: { id: noiseResolvedSameSite.id } })).resolvedByUserId === null);
  check('2: other-type same-site exception still OPEN', (await prisma.attendanceException.findUniqueOrThrow({ where: { id: noiseOtherTypeSameSite.id } })).status === 'OPEN');
  check('2: other-site GPS exception still OPEN', (await prisma.attendanceException.findUniqueOrThrow({ where: { id: noiseOtherSite.id } })).status === 'OPEN');

  const auditAfter = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID' } });
  check('2: exactly ONE summary audit event written', auditAfter === auditBefore + 1, { auditBefore, auditAfter });
  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: 'ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID' }, orderBy: { createdAt: 'desc' } });
  const after = audit.afterValue as Record<string, unknown>;
  check('2: audit records bulk:true, count 3, all 3 ids', after.bulk === true && after.acknowledgedCount === 3 && Array.isArray(after.exceptionIds) && (after.exceptionIds as string[]).length === 3, after);

  // 3. re-run -> NONE_MATCHED (idempotent)
  const r2 = await bulkAcknowledgeGpsNotVerified({ siteId: siteX.id }, admin.id, randomUUID());
  check('3: re-run -> NONE_MATCHED', r2.kind === 'NONE_MATCHED', r2);

  // 4. route: auth + CSRF gates
  const workerToken = (async () => {
    const u = await prisma.user.create({ data: { username: `bulkw_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } })).id } } } });
    const tok = generateSessionToken();
    await prisma.userSession.create({ data: { userId: u.id, tokenHash: hashSessionToken(tok), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
    return tok;
  })();
  const mkReq = (token: string | null, csrf: boolean, body: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
    if (csrf) headers['x-requested-with'] = 'titanor-time';
    return new NextRequest('http://localhost/api/admin/attendance/exceptions/bulk-acknowledge-gps', { method: 'POST', headers, body: JSON.stringify(body) });
  };
  check('4a: no session -> 401', (await bulkRoute(mkReq(null, true, { siteId: siteX.id }))).status === 401);
  check('4b: no CSRF header -> 403', (await bulkRoute(mkReq(await workerToken, false, { siteId: siteX.id }))).status === 403);
  check('4c: WORKER role -> 403', (await bulkRoute(mkReq(await workerToken, true, { siteId: siteX.id }))).status === 403);

  const adminTok = generateSessionToken();
  await prisma.userSession.create({ data: { userId: admin.id, tokenHash: hashSessionToken(adminTok), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  const r4d = await bulkRoute(mkReq(adminTok, true, {}));
  check('4d: admin, unscoped body -> 400 VALIDATION_ERROR', r4d.status === 400 && (await r4d.json()).error?.code === 'VALIDATION_ERROR');

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
