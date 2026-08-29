// T15.2 (2026-08-29) — the worker manages their OWN professions from /worker/profile:
// GET /api/worker/professions (own list + catalog), POST (catalog / custom), DELETE (own only).
// Direct-route-handler style. Needs a disposable PostgreSQL 16 (DATABASE_URL) with migrations
// through 20260829190000 applied.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { GET as listRoute, POST as addRoute } from '../app/api/worker/professions/route';
import { DELETE as removeRoute } from '../app/api/worker/professions/[employeeProfessionId]/route';
import { addEmployeeProfession } from '../lib/professions';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

async function makeWorker(username: string) {
  const employee = await prisma.employee.create({ data: { employeeNumber: `WP-${randomUUID().slice(0, 8)}`, firstName: 'Worker', lastName: 'Prof' } });
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } });
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId: employee.id, userRoles: { create: { roleId: role.id } } } });
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { user, employeeId: employee.id, token };
}

function req(method: 'GET' | 'POST' | 'DELETE', token: string | null, body?: unknown, csrf = true, path = '') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  if (csrf && method !== 'GET') headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(`http://localhost/api/worker/professions${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const delParams = (id: string) => ({ params: Promise.resolve({ employeeProfessionId: id }) });

async function main() {
  const alice = await makeWorker('wprof-alice');
  const bob = await makeWorker('wprof-bob');

  // 1. GET returns an empty own-list + a non-empty catalog
  const r1 = await listRoute(req('GET', alice.token));
  const j1 = await r1.json();
  check('1: GET -> 200 with items[] and catalog[]', r1.status === 200 && Array.isArray(j1.items) && j1.items.length === 0 && Array.isArray(j1.catalog) && j1.catalog.length > 0, j1);
  const firstDef = j1.catalog[0].professions[0];

  // 2. POST a catalog profession
  const r2 = await addRoute(req('POST', alice.token, { definitionId: firstDef.id }));
  check('2: POST catalog -> 201', r2.status === 201, await r2.clone().json());
  // 3. POST a custom profession (more than one — multiple allowed)
  const r3 = await addRoute(req('POST', alice.token, { customName: 'Rope Access Technician', customCategory: 'CONSTRUCTION' }));
  check('3: POST custom -> 201', r3.status === 201, await r3.clone().json());
  const r3b = await addRoute(req('POST', alice.token, { customName: 'Scaffolder', customCategory: 'CONSTRUCTION' }));
  check('3b: a third profession -> 201 (no limit)', r3b.status === 201);

  const r4 = await listRoute(req('GET', alice.token));
  const j4 = await r4.json();
  check('4: own list now has 3', j4.items.length === 3, j4.items);

  // 5. duplicate -> 409 PROFESSION_ALREADY_ADDED
  const r5 = await addRoute(req('POST', alice.token, { definitionId: firstDef.id }));
  const j5 = await r5.json();
  check('5: duplicate catalog -> 409 PROFESSION_ALREADY_ADDED', r5.status === 409 && j5.error?.code === 'PROFESSION_ALREADY_ADDED', j5);

  // 6. exactly-one-of validation
  check('6a: neither definitionId nor customName -> 400', (await addRoute(req('POST', alice.token, {}))).status === 400);
  check('6b: both -> 400', (await addRoute(req('POST', alice.token, { definitionId: firstDef.id, customName: 'X', customCategory: 'CONSTRUCTION' }))).status === 400);
  check('6c: custom without a valid category -> 400', (await addRoute(req('POST', alice.token, { customName: 'Y' }))).status === 400);

  // 7. DELETE own
  const own = (await (await listRoute(req('GET', alice.token))).json()).items;
  const toRemove = own.find((p: { isCustom: boolean }) => p.isCustom);
  const r7 = await removeRoute(req('DELETE', alice.token), delParams(toRemove.id));
  check('7: DELETE own -> 200', r7.status === 200);
  check('7b: own list back to 2', (await (await listRoute(req('GET', alice.token))).json()).items.length === 2);

  // 8. Bob cannot delete Alice's row (ownership enforced) -> 404
  const aliceRow = (await (await listRoute(req('GET', alice.token))).json()).items[0];
  const r8 = await removeRoute(req('DELETE', bob.token), delParams(aliceRow.id));
  check("8: Bob deleting Alice's profession -> 404", r8.status === 404);
  check("8b: Alice's row still there", (await (await listRoute(req('GET', alice.token))).json()).items.some((p: { id: string }) => p.id === aliceRow.id));

  // 9. auth / CSRF / permission gates
  check('9a: no session -> 401', (await listRoute(req('GET', null))).status === 401);
  check('9b: POST without CSRF header -> 403', (await addRoute(req('POST', alice.token, { definitionId: firstDef.id }, false))).status === 403);
  const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const adminUser = await prisma.user.create({ data: { username: `wprof-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: adminRole.id } } } });
  const adminTok = generateSessionToken();
  await prisma.userSession.create({ data: { userId: adminUser.id, tokenHash: hashSessionToken(adminTok), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  check('9c: ADMIN (no worker.profession.manage.own, no employee) -> 403', (await listRoute(req('GET', adminTok))).status === 403);

  // 10. admin-added professions still coexist (admin path untouched)
  await addEmployeeProfession({ employeeId: bob.employeeId, customName: 'Foreman-set trade', customCategory: 'SHIPBUILDING', actorUserId: adminUser.id, requestId: randomUUID() });
  check('10: an admin-added profession shows in the worker own-list', (await (await listRoute(req('GET', bob.token))).json()).items.some((p: { nameEn: string }) => p.nameEn === 'Foreman-set trade'));

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
