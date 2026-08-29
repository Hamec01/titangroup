// T14.5a (2026-08-29) — PATCH /api/admin/sites/:id accepts the `gpsOftenUnavailable` boolean:
// toggles it, writes it into the SITE_UPDATED audit event, rejects a non-boolean, and is gated by
// auth / the site.update permission. Direct-route-handler style. Needs DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { PATCH as sitePatch, GET as siteGet } from '../app/api/admin/sites/[siteId]/route';
import { getSiteDetail } from '../lib/sites';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

async function makeSession(username: string, roleNames: string[]) {
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  for (const roleName of roleNames) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return token;
}

function patchReq(siteId: string, token: string | null, body: unknown, csrf = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  if (csrf) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(`http://localhost/api/admin/sites/${siteId}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
}
const params = (siteId: string) => ({ params: Promise.resolve({ siteId }) });

async function main() {
  const adminToken = await makeSession('sitegps-admin', ['ADMIN']);
  const workerToken = await makeSession('sitegps-worker', ['WORKER']);
  const site = await prisma.workSite.create({ data: { name: `SiteGps ${randomUUID().slice(0, 5)}` } });

  check('default gpsOftenUnavailable is false', (await getSiteDetail(site.id))?.gpsOftenUnavailable === false);

  // 1. turn it on
  const r1 = await sitePatch(patchReq(site.id, adminToken, { version: 1, gpsOftenUnavailable: true }), params(site.id));
  const j1 = await r1.json();
  check('1: PATCH gpsOftenUnavailable:true -> 200', r1.status === 200 && j1.gpsOftenUnavailable === true, j1);
  check('1: getSiteDetail now reports it on', (await getSiteDetail(site.id))?.gpsOftenUnavailable === true);
  const audit = await prisma.auditEvent.findFirst({ where: { entityId: site.id, eventType: 'SITE_UPDATED' }, orderBy: { createdAt: 'desc' } });
  check('1: SITE_UPDATED audit records gpsOftenUnavailable', !!audit && (audit.afterValue as Record<string, unknown>).gpsOftenUnavailable === true, audit?.afterValue);

  // 2. a partial PATCH that omits the field leaves it untouched
  const r2 = await sitePatch(patchReq(site.id, adminToken, { version: 2, name: `${site.name} v3` }), params(site.id));
  check('2: unrelated PATCH -> 200', r2.status === 200);
  check('2: gpsOftenUnavailable still on (not reset by an omitted field)', (await getSiteDetail(site.id))?.gpsOftenUnavailable === true);

  // 3. non-boolean rejected
  const r3 = await sitePatch(patchReq(site.id, adminToken, { version: 3, gpsOftenUnavailable: 'yes' }), params(site.id));
  const j3 = await r3.json();
  check('3: non-boolean -> 400 VALIDATION_ERROR', r3.status === 400 && j3.error?.code === 'VALIDATION_ERROR' && !!j3.error?.fieldErrors?.gpsOftenUnavailable, j3);

  // 4. auth / role gates
  const r4a = await sitePatch(patchReq(site.id, null, { version: 3, gpsOftenUnavailable: false }), params(site.id));
  check('4a: no session -> 401', r4a.status === 401);
  const r4b = await sitePatch(patchReq(site.id, workerToken, { version: 3, gpsOftenUnavailable: false }), params(site.id));
  check('4b: WORKER role -> 403', r4b.status === 403);
  const r4c = await sitePatch(patchReq(site.id, adminToken, { version: 3, gpsOftenUnavailable: false }, false), params(site.id));
  check('4c: missing CSRF header -> 403', r4c.status === 403);

  // 5. GET exposes the field
  const r5 = await siteGet(new NextRequest(`http://localhost/api/admin/sites/${site.id}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${adminToken}` } }), params(site.id));
  const j5 = await r5.json();
  check('5: GET site detail includes gpsOftenUnavailable', r5.status === 200 && j5.gpsOftenUnavailable === true, j5);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
