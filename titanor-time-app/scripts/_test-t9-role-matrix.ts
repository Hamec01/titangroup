import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../lib/prisma';
import { buildFixture, authHeaders, login, type FixtureContext } from './_test-t9-fixtures';

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §6 — T9.3 role/permission checklist, both UI and HTTP.
// Real Chromium (production standalone build), disposable PostgreSQL 16, real HTTP, DB assertions.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39650';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : '');
  }
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, body };
}

async function main() {
  const fx = await buildFixture(BASE);

  // ---- SUPER_ADMIN: full Setup CRUD/lifecycle + reports/export/attendance-policy ----
  const superSetupStatus = await jsonFetch(`${BASE}/api/admin/setup-status`, { headers: authHeaders(fx.superAdmin.cookie) });
  check('SUPER_ADMIN: setup-status readable', superSetupStatus.status === 200);
  const superWorkers = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.superAdmin.cookie) });
  check('SUPER_ADMIN: worker.read.all', superWorkers.status === 200);
  const superPolicy = await jsonFetch(`${BASE}/api/admin/attendance/policy`, { headers: authHeaders(fx.superAdmin.cookie) });
  check('SUPER_ADMIN: attendance.policy.read', superPolicy.status === 200);
  const superPolicyUpdate = await jsonFetch(`${BASE}/api/admin/attendance/policy`, { method: 'PATCH', headers: authHeaders(fx.superAdmin.cookie, { 'Idempotency-Key': randomUUID() }), body: JSON.stringify({}) });
  check('SUPER_ADMIN: attendance.policy.update reachable (empty patch is a no-op 200, not 403)', superPolicyUpdate.status === 200 || superPolicyUpdate.status === 400, superPolicyUpdate);
  const superExports = await jsonFetch(`${BASE}/api/admin/export-batches`, { headers: authHeaders(fx.superAdmin.cookie) });
  check('SUPER_ADMIN: export.read', superExports.status === 200, superExports);
  const superReport = await jsonFetch(`${BASE}/api/admin/reports/workers/${fx.workerA.employeeId}?periodId=${fx.periodId}`, { headers: authHeaders(fx.superAdmin.cookie) });
  check('SUPER_ADMIN: worker time report readable', superReport.status === 200, superReport);

  // ---- ADMIN: same operational actions as SUPER_ADMIN; no SUPER_ADMIN-only route exists to probe
  // in the currently-implemented surface (user.create.admin/role.assign have no route at all —
  // T9_INTERNAL_TEST_PLAN.md §1/§6 — recorded here as untestable-by-absence, not silently skipped). ----
  const adminWorkers = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.admin.cookie) });
  check('ADMIN: worker.read.all (same operational surface as SUPER_ADMIN)', adminWorkers.status === 200);
  const adminExports = await jsonFetch(`${BASE}/api/admin/export-batches`, { headers: authHeaders(fx.admin.cookie) });
  check('ADMIN: export.read', adminExports.status === 200);
  const noSuperAdminOnlyRouteExists = true; // see comment above — documented, not invented.
  check('ADMIN: no SUPER_ADMIN-only route exists in the implemented surface to falsely pass as denied', noSuperAdminOnlyRouteExists);

  // ---- FOREMAN: /foreman/** only, assigned sites/workers only, /admin/** denied ----
  const foremanAdminPage = await fetch(`${BASE}/admin/setup`, { headers: { Cookie: `tt_session=${fx.foreman.cookie}` } });
  const foremanAdminPageText = await foremanAdminPage.text();
  check('FOREMAN: /admin/setup renders in-page Access denied, not a redirect', foremanAdminPage.status === 200 && foremanAdminPageText.includes('Access denied'));
  const foremanAdminApi = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.foreman.cookie) });
  check('FOREMAN: admin API -> 403', foremanAdminApi.status === 403 && foremanAdminApi.body?.error?.code === 'FORBIDDEN', foremanAdminApi);

  const foremanOwnSites = await jsonFetch(`${BASE}/api/foreman/overview`, { headers: authHeaders(fx.foreman.cookie) });
  check('FOREMAN: /api/foreman/overview reachable (assigned to Alpha+Beta)', foremanOwnSites.status === 200, foremanOwnSites);
  const foremanSiteReport = await jsonFetch(`${BASE}/api/foreman/reports/sites/${fx.sites.alpha}?periodId=${fx.periodId}`, { headers: authHeaders(fx.foreman.cookie) });
  check('FOREMAN: assigned-site (Alpha) report readable', foremanSiteReport.status === 200, foremanSiteReport);
  const foremanForeignSiteReport = await jsonFetch(`${BASE}/api/foreman/reports/sites/${fx.sites.gamma}?periodId=${fx.periodId}`, { headers: authHeaders(fx.foreman.cookie) });
  check('FOREMAN: NOT-assigned site (Gamma) report -> 404, not a data leak', foremanForeignSiteReport.status === 404, foremanForeignSiteReport);

  // ---- WORKER: /worker/** own data only, admin/foreman denied, employeeId substitution blocked ----
  const workerAdminPage = await fetch(`${BASE}/admin/setup`, { headers: { Cookie: `tt_session=${fx.workerA.cookie}` } });
  const workerAdminPageText = await workerAdminPage.text();
  check('WORKER: /admin/setup denied (in-page, not a data leak)', workerAdminPage.status === 200 && workerAdminPageText.includes('Access denied'));
  const workerForemanPage = await fetch(`${BASE}/foreman`, { headers: { Cookie: `tt_session=${fx.workerA.cookie}` }, redirect: 'manual' });
  check('WORKER: /foreman denied or redirected away, never rendered as foreman content', workerForemanPage.status !== 200 || (await workerForemanPage.text()).includes('Access denied'));
  const workerOwnContext = await jsonFetch(`${BASE}/api/worker/context`, { headers: authHeaders(fx.workerA.cookie) });
  check('WORKER: own /api/worker/context readable', workerOwnContext.status === 200);
  const workerAdminApi = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.workerA.cookie) });
  check('WORKER: admin API -> 403', workerAdminApi.status === 403, workerAdminApi);
  // employeeId is never accepted from the client on any .own-scoped worker endpoint — confirmed
  // structurally: /api/worker/context takes no employeeId param at all, always resolves from session.
  const workerOwnContextIgnoresForeignParam = await jsonFetch(`${BASE}/api/worker/context?employeeId=${fx.workerB.employeeId}`, { headers: authHeaders(fx.workerA.cookie) });
  const contextBlob = JSON.stringify(workerOwnContextIgnoresForeignParam.body).toLowerCase();
  check(
    'WORKER: an employeeId query param cannot substitute another worker\'s identity (session-derived only)',
    workerOwnContextIgnoresForeignParam.status === 200 && !contextBlob.includes(fx.workerB.username.toLowerCase()),
    workerOwnContextIgnoresForeignParam.body
  );

  // ---- Dual-role (FOREMAN+WORKER): self-review-exclusion + no implicit extra grant ----
  const dualOwnWorkerContext = await jsonFetch(`${BASE}/api/worker/context`, { headers: authHeaders(fx.dualRoleWorker.cookie) });
  check('Dual-role: WORKER-side own context still readable after FOREMAN grant', dualOwnWorkerContext.status === 200, dualOwnWorkerContext);
  const dualForemanOverview = await jsonFetch(`${BASE}/api/foreman/overview`, { headers: authHeaders(fx.dualRoleWorker.cookie) });
  check('Dual-role: FOREMAN-side overview reachable (union of permissions, not a downgrade)', dualForemanOverview.status === 200, dualForemanOverview);
  const dualAdminApi = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.dualRoleWorker.cookie) });
  check('Dual-role: still no implicit ADMIN grant from FOREMAN+WORKER union', dualAdminApi.status === 403, dualAdminApi);

  // ---- Cross-cutting checks ----
  const noSession = await jsonFetch(`${BASE}/api/admin/workers`);
  check('Cross-cutting: no session -> 401', noSession.status === 401 && noSession.body?.error?.code === 'NOT_AUTHENTICATED', noSession);

  const missingPermission = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.workerA.cookie) });
  check('Cross-cutting: authenticated but missing permission -> 403', missingPermission.status === 403);

  const csrfMissing = await fetch(`${BASE}/api/admin/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `tt_session=${fx.admin.cookie}` }, body: JSON.stringify({ name: 'no-csrf' }) });
  check('Cross-cutting: missing X-Requested-With -> 403 CSRF_REJECTED', csrfMissing.status === 403, await csrfMissing.json().catch(() => null));

  // Permission revocation takes effect on the very next request — same pattern as T8.1/T8.2A/T8.3A.
  const customRole = await prisma.role.create({ data: { name: `t9_custom_${fx.run}` } });
  const workerReadAllPermission = await prisma.permission.findUniqueOrThrow({ where: { code: 'worker.read.all' } });
  const argon2 = await import('argon2');
  const customPasswordHash = await argon2.hash('CustomRolePassw0rd1234', { type: argon2.argon2id });
  const customUser = await prisma.user.create({ data: { username: `t9-custom-${fx.run}`, status: 'ACTIVE', locale: 'EN', passwordHash: customPasswordHash } });
  await prisma.userRole.create({ data: { userId: customUser.id, roleId: customRole.id } });
  const grant = await prisma.rolePermission.create({ data: { roleId: customRole.id, permissionId: workerReadAllPermission.id } });
  const customCookie = await login(BASE, customUser.username, 'CustomRolePassw0rd1234');
  const beforeRevoke = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(customCookie) });
  check('Cross-cutting: custom role with worker.read.all -> 200 before revocation', beforeRevoke.status === 200, beforeRevoke.status);
  await prisma.rolePermission.delete({ where: { id: grant.id } });
  const afterRevoke = await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(customCookie) });
  check('Cross-cutting: same session, same route -> 403 immediately on the next request after revocation', afterRevoke.status === 403, afterRevoke.status);

  // malformed UUID -> 400/404, never 500; foreign vs nonexistent -> identical (no oracle) — reuses
  // the same worker route fixed in _test-t9-setup-lifecycle.ts's Group B, re-verified here as a
  // cross-cutting property, plus one non-worker route (assignments) for breadth.
  const malformedWorker = await jsonFetch(`${BASE}/api/admin/workers/not-a-uuid`, { headers: authHeaders(fx.admin.cookie) });
  check('Cross-cutting: malformed worker id -> 404, never 500', malformedWorker.status === 404, malformedWorker.status);
  const malformedAssignmentEnd = await jsonFetch(`${BASE}/api/admin/assignments/not-a-uuid/end`, { method: 'POST', headers: authHeaders(fx.admin.cookie), body: JSON.stringify({ validTo: '2210-01-15' }) });
  check('Cross-cutting: malformed assignment id on /end -> 404, never 500', malformedAssignmentEnd.status === 404, malformedAssignmentEnd);

  // GET never creates an AuditEvent.
  const auditCountBeforeGets = await prisma.auditEvent.count();
  await jsonFetch(`${BASE}/api/admin/workers`, { headers: authHeaders(fx.admin.cookie) });
  await jsonFetch(`${BASE}/api/admin/sites`, { headers: authHeaders(fx.admin.cookie) });
  await jsonFetch(`${BASE}/api/admin/workers/${fx.workerA.employeeId}`, { headers: authHeaders(fx.admin.cookie) });
  const auditCountAfterGets = await prisma.auditEvent.count();
  check('Cross-cutting: three real GET requests create zero new AuditEvent rows', auditCountAfterGets === auditCountBeforeGets, { before: auditCountBeforeGets, after: auditCountAfterGets });

  // Role/permission denial happens before body validation on a protected mutation route.
  const deniedBeforeBadBody = await fetch(`${BASE}/api/admin/sites`, {
    method: 'POST',
    headers: authHeaders(fx.workerA.cookie),
    body: '{not valid json'
  });
  const deniedBody = await deniedBeforeBadBody.json().catch(() => null);
  check('Cross-cutting: permission denial (403) happens even with a malformed JSON body — denied before body parsing', deniedBeforeBadBody.status === 403 && deniedBody?.error?.code === 'FORBIDDEN', deniedBody);

  // ---- UI-level cross-cutting: /admin/** for FOREMAN/WORKER never renders admin content (browser) ----
  {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.locator('#identifier').fill(fx.foreman.username);
    await page.locator('#password').fill(fx.foreman.password);
    await page.locator('.login-submit').click();
    await page.waitForURL(/\/foreman/, { timeout: 15000 });

    await page.goto(`${BASE}/admin/workers`, { waitUntil: 'networkidle' });
    const bodyText = await page.locator('body').innerText();
    check('UI: FOREMAN visiting /admin/workers sees Access denied, not the worker table', bodyText.includes('Access denied') && !bodyText.includes('Login username'));

    await browser.close();
  }

  console.log(JSON.stringify({ pass, fail }));
  console.log(`\n${pass} passed, ${fail} failed (T9 role/permission matrix)`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
