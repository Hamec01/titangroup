// Fix (2026-08-26) — an ADMIN/SUPER_ADMIN with no FOREMAN role who lands on any /foreman/*
// route (no ForemanAssignment, no FOREMAN UserRole) hit every child page's own "access denied"
// text, styled identically to a login failure. app/foreman/layout.tsx now redirects such a
// session straight to /admin instead. Covers: ADMIN and SUPER_ADMIN redirected from /foreman AND
// a nested route (/foreman/workers) to /admin, which itself renders 200; WORKER and the dual-role
// FOREMAN+WORKER (FOREMAN currently active) unaffected — still get the exact pre-existing
// behavior (WORKER: inline access-denied text, no redirect; dual-role/plain FOREMAN: normal
// foreman content, no redirect).
import { buildFixture } from './_test-t9-fixtures';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3933';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

async function fetchManual(path: string, cookie: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { Cookie: `tt_session=${cookie}` },
    redirect: 'manual'
  });
}

async function main(): Promise<void> {
  const fx = await buildFixture(BASE);

  // --- ADMIN: base /foreman and a nested route both redirect to /admin ---
  const adminForeman = await fetchManual('/foreman', fx.admin.cookie);
  check('ADMIN: GET /foreman redirects (30x)', adminForeman.status >= 300 && adminForeman.status < 400, adminForeman.status);
  check('ADMIN: GET /foreman redirects to /admin', adminForeman.headers.get('location')?.endsWith('/admin') ?? false, adminForeman.headers.get('location'));

  const adminForemanWorkers = await fetchManual('/foreman/workers', fx.admin.cookie);
  check('ADMIN: GET /foreman/workers also redirects to /admin (layout-level, not per-page)', adminForemanWorkers.headers.get('location')?.endsWith('/admin') ?? false, [adminForemanWorkers.status, adminForemanWorkers.headers.get('location')]);

  // The redirect target must itself actually work — "refresh and it just works", not a second dead end.
  const adminLanded = await fetch(`${BASE}/admin`, { headers: { Cookie: `tt_session=${fx.admin.cookie}` } });
  check('ADMIN: GET /admin (the redirect target) is 200', adminLanded.status === 200, adminLanded.status);
  const adminLandedBody = await adminLanded.text();
  // Not a substring-absence check on "Access denied" — the page's i18n dictionary ships that
  // phrase as serialized props for unrelated components on every /admin/* page regardless of
  // what's rendered. Assert a positive signal that the real overview actually rendered instead.
  check('ADMIN: /admin body shows the real admin identity/nav, not a denial screen', adminLandedBody.includes('admin-identity') && adminLandedBody.includes(fx.admin.username));

  // --- SUPER_ADMIN: same redirect ---
  const superForeman = await fetchManual('/foreman', fx.superAdmin.cookie);
  check('SUPER_ADMIN: GET /foreman redirects to /admin', superForeman.headers.get('location')?.endsWith('/admin') ?? false, [superForeman.status, superForeman.headers.get('location')]);

  // --- Regression: plain FOREMAN unaffected — normal 200 content, no redirect ---
  const foremanOwn = await fetchManual('/foreman', fx.foreman.cookie);
  check('FOREMAN: GET /foreman is still 200 (no redirect)', foremanOwn.status === 200, foremanOwn.status);

  // --- Regression: WORKER unaffected — still the inline access-denied text, no redirect ---
  const workerForeman = await fetchManual('/foreman', fx.workerA.cookie);
  check('WORKER: GET /foreman is still 200, not a redirect', workerForeman.status === 200, workerForeman.status);
  const workerBody = await workerForeman.text();
  check('WORKER: still sees the inline access-denied text (unchanged contract)', workerBody.includes('Access denied') || workerBody.includes('Доступ запрещён'));

  // --- Regression: dual-role FOREMAN+WORKER (FOREMAN currently active) unaffected — normal content ---
  const dualForeman = await fetchManual('/foreman', fx.dualRoleWorker.cookie);
  check('dual-role FOREMAN+WORKER: GET /foreman is still 200 (no redirect)', dualForeman.status === 200, dualForeman.status);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
