// UT4-B — GET /api/admin/time-ledger/filter-options. Needs a disposable PostgreSQL 16
// (DATABASE_URL). Proves: 401/403, ADMIN/SUPER_ADMIN success, search, same customer NAME on two
// different sites stays two distinct options, a bounded/well-shaped result, and strict rejection
// of malformed/repeated query parameters — mirroring scripts/_test-api-guard.ts's own
// route-handler-direct-call convention (no HTTP server needed).

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { GET } from '../app/api/admin/time-ledger/filter-options/route';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : '');
  }
}

async function makeSession(roleName: string | null): Promise<string> {
  const user = await prisma.user.create({ data: { username: `flo-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  if (roleName) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return token;
}

function req(token: string | null, qs: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
  return new NextRequest(`http://localhost/api/admin/time-ledger/filter-options${qs}`, { method: 'GET', headers });
}

async function main() {
  // 401 — no session at all.
  {
    const res = await GET(req(null, '?type=customer'));
    check('401: no session', res.status === 401);
  }

  // 403 — a real session but a role with no timesheet.read.all (WORKER never holds it).
  {
    const token = await makeSession('WORKER');
    const res = await GET(req(token, '?type=customer'));
    check('403: WORKER role lacks timesheet.read.all', res.status === 403);
  }

  // ADMIN success + shape.
  const adminToken = await makeSession('ADMIN');
  {
    const res = await GET(req(adminToken, '?type=customer'));
    check('200: ADMIN with timesheet.read.all succeeds', res.status === 200);
    const body = await res.json();
    check('200: response has a workAreas array', Array.isArray(body.workAreas), body);
  }

  // SUPER_ADMIN success.
  {
    const superToken = await makeSession('SUPER_ADMIN');
    const res = await GET(req(superToken, '?type=customer'));
    check('200: SUPER_ADMIN succeeds', res.status === 200);
  }

  // Fixture: two work areas with the IDENTICAL customer name on two DIFFERENT sites — must remain
  // two distinct options (never merged), and a substring search must find both.
  const tag = randomUUID().slice(0, 6);
  const siteA = await prisma.workSite.create({ data: { name: `FLO-SiteA-${tag}` } });
  const siteB = await prisma.workSite.create({ data: { name: `FLO-SiteB-${tag}` } });
  const sharedName = `FLO-SharedCustomer-${tag}`;
  const waA = await prisma.workArea.create({ data: { siteId: siteA.id, name: sharedName } });
  const waB = await prisma.workArea.create({ data: { siteId: siteB.id, name: sharedName } });

  {
    const res = await GET(req(adminToken, `?type=customer&q=${encodeURIComponent(sharedName)}`));
    check('search: 200', res.status === 200);
    const body = await res.json();
    const matches = (body.workAreas as { workAreaId: string; siteId: string; workAreaName: string }[]).filter((w) => w.workAreaName === sharedName);
    check('search: same customer name on 2 different sites -> 2 distinct options', matches.length === 2, matches);
    const siteIds = new Set(matches.map((m) => m.siteId));
    check('search: the two options carry their OWN distinct siteId', siteIds.size === 2 && siteIds.has(siteA.id) && siteIds.has(siteB.id), [...siteIds]);
    const workAreaIds = new Set(matches.map((m) => m.workAreaId));
    check('search: the two options carry distinct workAreaId', workAreaIds.size === 2 && workAreaIds.has(waA.id) && workAreaIds.has(waB.id), [...workAreaIds]);
  }

  // Search by site name also matches (searchCustomerWorkAreas searches name OR site.name).
  {
    const res = await GET(req(adminToken, `?type=customer&q=${encodeURIComponent(siteA.name)}`));
    const body = await res.json();
    const found = (body.workAreas as { workAreaId: string }[]).some((w) => w.workAreaId === waA.id);
    check('search: matching by SITE name also finds the work area', found, body.workAreas);
  }

  // Bounded shape: every returned option has exactly the documented fields.
  {
    const res = await GET(req(adminToken, `?type=customer&q=${encodeURIComponent(tag)}`));
    const body = await res.json();
    const ok = (body.workAreas as unknown[]).every((o) => {
      const w = o as Record<string, unknown>;
      return typeof w.workAreaId === 'string' && typeof w.workAreaName === 'string' && typeof w.siteId === 'string' && typeof w.siteName === 'string' && typeof w.active === 'boolean' && typeof w.label === 'string';
    });
    check('shape: every option has {workAreaId, workAreaName, siteId, siteName, active, label}', ok, body.workAreas);
  }

  // Malformed / repeated query -> 400, never a 500 and never a silent default.
  {
    const res = await GET(req(adminToken, '?type=bogus'));
    check('400: type=bogus rejected', res.status === 400);
  }
  {
    const res = await GET(req(adminToken, ''));
    check('400: missing type rejected (never silently defaults to customer)', res.status === 400);
  }
  {
    const res = await GET(req(adminToken, `?type=customer&q=${'x'.repeat(200)}`));
    check('400: q over 120 chars rejected', res.status === 400);
  }
  {
    const url = new URL('http://localhost/api/admin/time-ledger/filter-options');
    url.searchParams.append('type', 'customer');
    url.searchParams.append('type', 'customer');
    const headers = new Headers();
    headers.set('cookie', `${SESSION_COOKIE_NAME}=${adminToken}`);
    const res = await GET(new NextRequest(url, { method: 'GET', headers }));
    check('400: repeated type= parameter rejected', res.status === 400);
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
