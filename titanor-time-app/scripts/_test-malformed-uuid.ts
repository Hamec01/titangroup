// R07-A (B11) — a malformed [id] path parameter must produce a safe 4xx, never a Prisma P2023 /
// HTTP 500. Covers the shared guard (lib/api-guard) plus a sample of the routes it now protects,
// invoked as real handlers. Needs DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { isUuid, requireUuidParam, UUID_PATTERN } from '../lib/api-guard';
import { GET as workerTimesheet } from '../app/api/worker/timesheets/[timesheetId]/route';
import { POST as adminApprove } from '../app/api/admin/timesheets/[timesheetId]/approve/route';
import { GET as periodReport } from '../app/api/admin/reports/periods/[periodId]/route';
import { GET as exportBatch } from '../app/api/admin/export-batches/[batchId]/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 200) : ''); }
};

// ---- pure: isUuid / requireUuidParam ----
check('isUuid: real v4', isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
check('isUuid: uppercase ok', isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301'));
check('isUuid: rejects "1"', !isUuid('1'));
check('isUuid: rejects sql-ish', !isUuid("1' OR '1'='1"));
check('isUuid: rejects too short', !isUuid('3f2504e0-4f89-41d3-9a0c'));
check('isUuid: rejects non-string', !isUuid(42 as unknown));
check('UUID_PATTERN exported', UUID_PATTERN instanceof RegExp);
{
  const r = requireUuidParam('not-a-uuid', { code: 'X_NOT_FOUND', message: 'nope' }, 'req-1');
  check('requireUuidParam: bad -> 404 response', r !== null && r.status === 404);
  check('requireUuidParam: good -> null', requireUuidParam(randomUUID(), { code: 'X', message: 'y' }, 'r') === null);
}

// ---- route handlers with a valid session but a garbage id ----
async function sessionWith(roleName: string, withEmployee: boolean) {
  const emp = withEmployee
    ? await prisma.employee.create({ data: { employeeNumber: `UU-${randomUUID().slice(0, 8)}`, firstName: 'U', lastName: 'U' } })
    : null;
  const user = await prisma.user.create({
    data: { username: `uu-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId: emp?.id ?? null }
  });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = generateSessionToken();
  await prisma.userSession.create({
    data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() }
  });
  return token;
}

function req(url: string, token: string, method: 'GET' | 'POST' = 'GET'): NextRequest {
  const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
  if (method === 'POST') headers.set('x-requested-with', 'titanor-time');
  return new NextRequest(`http://localhost${url}`, { method, headers });
}

const BAD = "not-a-uuid-'; DROP TABLE";

async function main() {
  const admin = await sessionWith('SUPER_ADMIN', false);
  const worker = await sessionWith('WORKER', true);

  {
    const res = await workerTimesheet(req(`/api/worker/timesheets/${BAD}`, worker), { params: Promise.resolve({ timesheetId: BAD }) });
    const body = await res.json().catch(() => ({}));
    check('GET worker/timesheets/[bad] -> 404 TIMESHEET_NOT_FOUND', res.status === 404 && body?.error?.code === 'TIMESHEET_NOT_FOUND', { status: res.status, body });
  }
  {
    const res = await adminApprove(req(`/api/admin/timesheets/${BAD}/approve`, admin, 'POST'), { params: Promise.resolve({ timesheetId: BAD }) });
    check('POST admin/timesheets/[bad]/approve -> 404, not 500', res.status === 404, { status: res.status });
  }
  {
    const res = await periodReport(req(`/api/admin/reports/periods/${BAD}`, admin), { params: Promise.resolve({ periodId: BAD }) });
    check('GET admin/reports/periods/[bad] -> 404, not 500', res.status === 404, { status: res.status });
  }
  {
    const res = await exportBatch(req(`/api/admin/export-batches/${BAD}`, admin), { params: Promise.resolve({ batchId: BAD }) });
    check('GET admin/export-batches/[bad] -> 404, not 500', res.status === 404, { status: res.status });
  }
  {
    // control: a well-formed but non-existent id still 404s (and never 500s).
    const ghost = randomUUID();
    const res = await periodReport(req(`/api/admin/reports/periods/${ghost}`, admin), { params: Promise.resolve({ periodId: ghost }) });
    check('GET admin/reports/periods/[ghost uuid] -> 404', res.status === 404, { status: res.status });
  }

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
