import { randomUUID, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { bootstrapSuperAdmin } from './bootstrap-super-admin';

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §5 — shared T9.1/T9.2 fixture builder, imported by
// _test-t9-setup-lifecycle.ts, _test-t9-role-matrix.ts, _test-t9-setup-ui.ts. Everything is created
// through real HTTP against a real standalone server, except the one bootstrap SUPER_ADMIN — the
// project's existing, already-approved convention for the very first account. Passwords are
// random, >=16 chars, never logged, never written anywhere except the returned in-memory object.

const CSRF = 'titanor-time';

export function genPassword(): string {
  return randomBytes(16).toString('base64url');
}

export interface FixtureContext {
  base: string;
  run: string;
  superAdmin: { username: string; password: string; cookie: string };
  admin: { username: string; password: string; cookie: string };
  foreman: { username: string; password: string; cookie: string; userId: string };
  workerA: { employeeId: string; username: string; password: string; cookie: string };
  workerB: { employeeId: string; username: string; password: string; cookie: string };
  dualRoleWorker: { employeeId: string; username: string; password: string; cookie: string };
  sites: { alpha: string; beta: string; gamma: string };
  templateId: string;
  periodId: string;
}

export async function login(base: string, identifier: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
    body: JSON.stringify({ identifier, password })
  });
  if (!res.ok) {
    throw new Error(`login failed for ${identifier}: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie?.match(/tt_session=([^;]+)/);
  if (!match) throw new Error(`no session cookie for ${identifier}`);
  return match[1];
}

export function authHeaders(cookie: string, extra?: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Requested-With': CSRF, Cookie: `tt_session=${cookie}`, ...extra };
}

// Worker activation — GET /api/auth/activate + POST /api/auth/set-initial-password
// (lib/activation.ts, ActivationToken table).
async function activateViaCode(base: string, activationCode: string, password: string): Promise<void> {
  const verify = await fetch(`${base}/api/auth/activate?token=${encodeURIComponent(activationCode)}`);
  if (!verify.ok) throw new Error(`activation code verify failed: ${verify.status}`);
  const setPw = await fetch(`${base}/api/auth/set-initial-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
    body: JSON.stringify({ token: activationCode, password })
  });
  if (!setPw.ok) throw new Error(`set-initial-password failed: ${setPw.status} ${await setPw.text()}`);
}

// Standalone system-user (FOREMAN) activation — a SEPARATE flow/table from worker activation
// (lib/system-activation.ts, UserActivationToken table) — confirmed by reading
// app/api/admin/users/[userId]/activation/route.ts's own comment.
async function activateSystemUserViaCode(base: string, activationCode: string, password: string): Promise<void> {
  const verify = await fetch(`${base}/api/auth/activate-account?token=${encodeURIComponent(activationCode)}`);
  if (!verify.ok) throw new Error(`system activation code verify failed: ${verify.status}`);
  const setPw = await fetch(`${base}/api/auth/set-account-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
    body: JSON.stringify({ token: activationCode, password })
  });
  if (!setPw.ok) throw new Error(`set-account-password failed: ${setPw.status} ${await setPw.text()}`);
}

export async function buildFixture(base: string): Promise<FixtureContext> {
  const run = randomUUID().slice(0, 6);

  const superAdminUsername = `t9-super-${run}`;
  const superAdminPassword = genPassword();
  await bootstrapSuperAdmin({ username: superAdminUsername, email: null, locale: 'EN', dryRun: false, password: superAdminPassword });
  const superCookie = await login(base, superAdminUsername, superAdminPassword);

  // ADMIN — same underlying primitive as bootstrapSuperAdmin (Role.name='ADMIN'); the accepted
  // "no other path exists yet" case documented in T9_INTERNAL_TEST_PLAN.md §5 (user.create.admin
  // has no implemented route).
  const adminUsername = `t9-admin-${run}`;
  const adminPassword = genPassword();
  {
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
    const user = await prisma.user.create({ data: { username: adminUsername, status: 'ACTIVE', locale: 'EN', passwordHash } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const adminCookie = await login(base, adminUsername, adminPassword);

  async function createSite(name: string): Promise<string> {
    const res = await fetch(`${base}/api/admin/sites`, {
      method: 'POST',
      headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error(`createSite ${name} failed: ${res.status} ${await res.text()}`);
    return (await res.json()).id;
  }
  const siteAlphaId = await createSite(`Alpha ${run}`);
  const siteBetaId = await createSite(`Beta ${run}`);
  const siteGammaId = await createSite(`Gamma ${run}`); // foreman deliberately NOT assigned here

  async function createWorkArea(siteId: string, name: string): Promise<void> {
    const res = await fetch(`${base}/api/admin/sites/${siteId}/work-areas`, {
      method: 'POST',
      headers: authHeaders(adminCookie),
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error(`createWorkArea failed: ${res.status} ${await res.text()}`);
  }
  await createWorkArea(siteAlphaId, 'Zone A');
  await createWorkArea(siteBetaId, 'Zone B');

  async function createGeofence(siteId: string, lat: number, lng: number): Promise<void> {
    const res = await fetch(`${base}/api/admin/sites/${siteId}/geofence-versions`, {
      method: 'POST',
      headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ latitude: lat, longitude: lng, radiusMeters: 150 })
    });
    if (!res.ok) throw new Error(`createGeofence failed: ${res.status} ${await res.text()}`);
  }
  await createGeofence(siteAlphaId, 60.17, 24.94);
  await createGeofence(siteBetaId, 60.2, 24.9);

  const templateRes = await fetch(`${base}/api/admin/templates`, {
    method: 'POST',
    headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({
      name: `Standard ${run}`,
      days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        isWorkingDay: weekday < 5,
        plannedStartTime: weekday < 5 ? '09:00' : undefined,
        plannedEndTime: weekday < 5 ? '17:00' : undefined,
        plannedBreakMinutes: weekday < 5 ? 30 : 0
      }))
    })
  });
  if (!templateRes.ok) throw new Error(`createTemplate failed: ${templateRes.status} ${await templateRes.text()}`);
  const templateId = (await templateRes.json()).id;

  async function createWorker(firstName: string, lastName: string): Promise<{ employeeId: string; username: string }> {
    const res = await fetch(`${base}/api/admin/workers`, {
      method: 'POST',
      headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ firstName, lastName })
    });
    if (!res.ok) throw new Error(`createWorker ${firstName} failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return { employeeId: body.employee.id, username: body.username };
  }
  const workerA = await createWorker('Anna', `Worka${run}`);
  const workerB = await createWorker('Bo', `Workb${run}`);
  const dualEmployee = await createWorker('Carl', `Dualc${run}`);

  async function issueActivationAndActivate(employeeId: string, password: string): Promise<void> {
    const issueRes = await fetch(`${base}/api/admin/workers/${employeeId}/activation`, {
      method: 'POST',
      headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() })
    });
    if (!issueRes.ok) throw new Error(`issue activation failed: ${issueRes.status} ${await issueRes.text()}`);
    const { activationCode } = await issueRes.json();
    await activateViaCode(base, activationCode, password);
  }

  // Open-ended validFrom fixed at a real past date so "today" filters (GET .../attendance/context,
  // activation readiness) always see a current assignment — established T7A/T8 convention.
  async function createAssignment(employeeId: string, siteId: string, isPrimary: boolean): Promise<void> {
    const res = await fetch(`${base}/api/admin/assignments`, {
      method: 'POST',
      headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({ employeeId, siteId, templateId, validFrom: '2020-01-01', isPrimary })
    });
    if (!res.ok) throw new Error(`createAssignment failed: ${res.status} ${await res.text()}`);
  }
  await createAssignment(workerA.employeeId, siteAlphaId, true);
  await createAssignment(workerB.employeeId, siteBetaId, true);
  await createAssignment(dualEmployee.employeeId, siteGammaId, true);

  // Far-future test year (established convention this session, e.g. T8.4A/T8/T8.8 fixtures) — keeps
  // this fixture's own OPEN period from colliding (PERIOD_OVERLAP) with any real-"today"-dated
  // period a caller creates separately (e.g. _test-t9-setup-lifecycle.ts's Setup-checklist group).
  // Activation readiness only requires period.status='OPEN' (lib/workers.ts's computeActivationStatus
  // has no date-range filter on the period itself), so a far-future range is safe here — unlike
  // SiteAssignment.validFrom above, which stays anchored to a real past date because
  // buildAttendanceContext DOES filter assignments by real "today".
  const periodStart = '2210-01-01';
  const periodEnd = '2210-01-14';
  const periodRes = await fetch(`${base}/api/admin/periods`, {
    method: 'POST',
    headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ startDate: periodStart, endDate: periodEnd })
  });
  if (!periodRes.ok) throw new Error(`createPeriod failed: ${periodRes.status} ${await periodRes.text()}`);
  const periodId = (await periodRes.json()).id;

  const workerAPassword = genPassword();
  const workerBPassword = genPassword();
  const dualPassword = genPassword();
  await issueActivationAndActivate(workerA.employeeId, workerAPassword);
  await issueActivationAndActivate(workerB.employeeId, workerBPassword);
  await issueActivationAndActivate(dualEmployee.employeeId, dualPassword);

  const foremanUsername = `t9-foreman-${run}`;
  const foremanPassword = genPassword();
  const foremanRes = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ mode: 'STANDALONE', username: foremanUsername, locale: 'EN' })
  });
  if (!foremanRes.ok) throw new Error(`createForeman failed: ${foremanRes.status} ${await foremanRes.text()}`);
  const foremanUserId = (await foremanRes.json()).id;
  const foremanActivationRes = await fetch(`${base}/api/admin/users/${foremanUserId}/activation`, {
    method: 'POST',
    headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() })
  });
  if (!foremanActivationRes.ok) throw new Error(`foreman activation issue failed: ${foremanActivationRes.status} ${await foremanActivationRes.text()}`);
  const { activationCode: foremanCode } = await foremanActivationRes.json();
  await activateSystemUserViaCode(base, foremanCode, foremanPassword);

  async function assignForeman(foremanUserId: string, siteId: string): Promise<void> {
    const res = await fetch(`${base}/api/admin/foreman-assignments`, {
      method: 'POST',
      headers: authHeaders(adminCookie),
      body: JSON.stringify({ foremanUserId, siteId, isSubstitute: false, validFrom: '2020-01-01' })
    });
    if (!res.ok) throw new Error(`assignForeman failed: ${res.status} ${await res.text()}`);
  }
  await assignForeman(foremanUserId, siteAlphaId);
  await assignForeman(foremanUserId, siteBetaId);

  const dualGrantRes = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: authHeaders(adminCookie, { 'Idempotency-Key': randomUUID() }),
    body: JSON.stringify({ mode: 'EXISTING_EMPLOYEE', employeeId: dualEmployee.employeeId })
  });
  if (!dualGrantRes.ok) throw new Error(`dual-role grant failed: ${dualGrantRes.status} ${await dualGrantRes.text()}`);

  const foremanCookie = await login(base, foremanUsername, foremanPassword);
  const workerACookie = await login(base, workerA.username, workerAPassword);
  const workerBCookie = await login(base, workerB.username, workerBPassword);
  const dualCookie = await login(base, dualEmployee.username, dualPassword);

  return {
    base,
    run,
    superAdmin: { username: superAdminUsername, password: superAdminPassword, cookie: superCookie },
    admin: { username: adminUsername, password: adminPassword, cookie: adminCookie },
    foreman: { username: foremanUsername, password: foremanPassword, cookie: foremanCookie, userId: foremanUserId },
    workerA: { employeeId: workerA.employeeId, username: workerA.username, password: workerAPassword, cookie: workerACookie },
    workerB: { employeeId: workerB.employeeId, username: workerB.username, password: workerBPassword, cookie: workerBCookie },
    dualRoleWorker: { employeeId: dualEmployee.employeeId, username: dualEmployee.username, password: dualPassword, cookie: dualCookie },
    sites: { alpha: siteAlphaId, beta: siteBetaId, gamma: siteGammaId },
    templateId,
    periodId
  };
}
