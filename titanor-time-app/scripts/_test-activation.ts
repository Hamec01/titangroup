import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { POST as issueActivationRoute } from '../app/api/admin/workers/[employeeId]/activation/route';
import { GET as verifyActivationRoute } from '../app/api/auth/activate/route';
import { POST as setInitialPasswordRoute } from '../app/api/auth/set-initial-password/route';
import {
  generateActivationCode,
  hashActivationCode,
  issueActivationToken,
  setInitialPassword,
  verifyActivationToken
} from '../lib/activation';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function createReadyWorker(tag: string, actorUserId: string, siteId: string, periodId: string, withOperationalSetup = true) {
  const employee = await prisma.employee.create({
    data: { employeeNumber: `ACT-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' }
  });
  const user = await prisma.user.create({
    data: { username: employee.employeeNumber, status: 'PENDING_ACTIVATION', locale: 'FI', employeeId: employee.id }
  });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2026-01-01T00:00:00Z') } });
  if (withOperationalSetup) {
    await prisma.siteAssignment.create({
      data: {
        employeeId: employee.id,
        siteId,
        isPrimary: true,
        validFrom: new Date('2026-01-01T00:00:00Z'),
        assignedByUserId: actorUserId
      }
    });
    await prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId: employee.id, expected: true } });
  }
  return { employee, user };
}

async function main() {
  const activationPermission = await prisma.permission.findUnique({ where: { code: 'worker.activation.generate' } });
  assert(activationPermission, 'worker.activation.generate permission was not seeded');

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  const workerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } });
  const actor = await prisma.user.create({ data: { username: `activation-admin-${randomUUID()}`, status: 'ACTIVE', locale: 'EN' } });
  await prisma.userRole.create({ data: { userId: actor.id, roleId: adminRole.id } });

  const adminPermission = await prisma.rolePermission.findFirst({
    where: { roleId: adminRole.id, permissionId: activationPermission.id }
  });
  assert(adminPermission, 'ADMIN did not receive worker.activation.generate');

  const site = await prisma.workSite.create({ data: { name: `Activation Site ${randomUUID()}` } });
  const period = await prisma.payrollPeriod.create({
    data: {
      startDate: new Date('2026-08-01T00:00:00Z'),
      endDate: new Date('2026-08-15T00:00:00Z'),
      status: 'OPEN',
      openedByUserId: actor.id
    }
  });

  const unassigned = await createReadyWorker('Unassigned', actor.id, site.id, period.id, false);
  const unassignedIssue = await issueActivationToken(unassigned.employee.id, actor.id, randomUUID());
  assert(!('code' in unassignedIssue), 'active new worker must receive activation without assignment/period participation');
  assert(
    (await prisma.siteAssignment.count({ where: { employeeId: unassigned.employee.id } })) === 0 &&
      (await prisma.payrollPeriodParticipant.count({ where: { employeeId: unassigned.employee.id } })) === 0,
    'activation must not fabricate operational setup rows'
  );

  const primary = await createReadyWorker('Primary', actor.id, site.id, period.id);
  const first = await issueActivationToken(primary.employee.id, actor.id, randomUUID());
  assert(!('code' in first), `first issue failed: ${'code' in first ? first.code : ''}`);
  assert(!('code' in (await verifyActivationToken(first.activationCode))), 'fresh activation code must verify');

  const replacement = await issueActivationToken(primary.employee.id, actor.id, randomUUID());
  assert(!('code' in replacement), `replacement issue failed: ${'code' in replacement ? replacement.code : ''}`);
  const oldResult = await verifyActivationToken(first.activationCode);
  assert('code' in oldResult && oldResult.code === 'TOKEN_INVALID', 'replaced activation code must be revoked');

  const activated = await setInitialPassword(
    replacement.activationCode,
    'correct horse battery staple 2026',
    randomUUID(),
    '127.0.0.1',
    'activation-test'
  );
  assert(!('code' in activated), `activation failed: ${'code' in activated ? activated.code : ''}`);
  assert(activated.user.roles.includes('WORKER'), 'activated user must receive WORKER role');

  const usedResult = await verifyActivationToken(replacement.activationCode);
  assert('code' in usedResult && usedResult.code === 'TOKEN_USED', 'used code must not verify again');
  const replay = await setInitialPassword(replacement.activationCode, 'another sufficiently long password', randomUUID(), null, null);
  assert('code' in replay && replay.code === 'TOKEN_USED', 'used code must not activate twice');

  const storedUser = await prisma.user.findUniqueOrThrow({ where: { id: primary.user.id } });
  assert(storedUser.status === 'ACTIVE' && storedUser.passwordHash, 'activation must persist ACTIVE status and password hash');
  assert(await prisma.userSession.findFirst({ where: { userId: primary.user.id } }), 'activation must create an auto-login session');
  assert(
    await prisma.userRole.findFirst({ where: { userId: primary.user.id, roleId: workerRole.id, validTo: null } }),
    'activation must persist the active WORKER role'
  );
  assert(
    (await prisma.auditEvent.count({ where: { entityId: primary.employee.id, eventType: 'ACTIVATION_TOKEN_ISSUED' } })) === 2,
    'each issuance must be audited'
  );
  assert(
    (await prisma.auditEvent.count({ where: { actorUserId: primary.user.id, eventType: 'ACCOUNT_ACTIVATED' } })) === 1,
    'account activation must be audited once'
  );

  const concurrent = await createReadyWorker('Concurrent', actor.id, site.id, period.id);
  const concurrentResults = await Promise.all([
    issueActivationToken(concurrent.employee.id, actor.id, randomUUID()),
    issueActivationToken(concurrent.employee.id, actor.id, randomUUID())
  ]);
  assert(concurrentResults.every((result) => !('code' in result)), 'both serialized issuance requests should complete');
  assert(
    (await prisma.activationToken.count({ where: { employeeId: concurrent.employee.id, status: 'PENDING' } })) === 1,
    'concurrent issuance must leave exactly one PENDING token'
  );
  const concurrentVerification = await Promise.all(
    concurrentResults.map((result) => verifyActivationToken('activationCode' in result ? result.activationCode : ''))
  );
  assert(
    concurrentVerification.filter((result) => !('code' in result)).length === 1 &&
      concurrentVerification.filter((result) => 'code' in result && result.code === 'TOKEN_INVALID').length === 1,
    'exactly one concurrently issued code must remain valid'
  );

  const expiredCode = generateActivationCode();
  const expiredEmployee = await createReadyWorker('Expired', actor.id, site.id, period.id);
  await prisma.activationToken.create({
    data: {
      employeeId: expiredEmployee.employee.id,
      tokenHash: hashActivationCode(expiredCode),
      status: 'PENDING',
      createdByUserId: actor.id,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      expiresAt: new Date('2026-07-04T00:00:00Z')
    }
  });
  const expiredResult = await verifyActivationToken(expiredCode);
  assert('code' in expiredResult && expiredResult.code === 'TOKEN_EXPIRED', 'expired code must return TOKEN_EXPIRED');

  const ineligible = await createReadyWorker('Ineligible', actor.id, site.id, period.id);
  await prisma.user.update({ where: { id: ineligible.user.id }, data: { status: 'OFFBOARDING' } });
  const ineligibleResult = await issueActivationToken(ineligible.employee.id, actor.id, randomUUID());
  assert('code' in ineligibleResult && ineligibleResult.code === 'SETUP_INCOMPLETE', 'OFFBOARDING user must not receive a code');

  const adminSessionToken = generateSessionToken();
  await prisma.userSession.create({
    data: {
      userId: actor.id,
      tokenHash: hashSessionToken(adminSessionToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastSeenAt: new Date()
    }
  });
  const apiWorker = await createReadyWorker('Api', actor.id, site.id, period.id);
  const routeContext = { params: Promise.resolve({ employeeId: apiWorker.employee.id }) };
  const baseIssueHeaders = {
    'x-requested-with': 'titanor-time',
    'idempotency-key': randomUUID()
  };

  const unauthenticatedResponse = await issueActivationRoute(
    new NextRequest(`http://localhost/api/admin/workers/${apiWorker.employee.id}/activation`, {
      method: 'POST',
      headers: baseIssueHeaders
    }),
    routeContext
  );
  assert(unauthenticatedResponse.status === 401, 'activation issue API must reject missing session');

  const wrongRoleResponse = await issueActivationRoute(
    new NextRequest(`http://localhost/api/admin/workers/${apiWorker.employee.id}/activation`, {
      method: 'POST',
      headers: {
        ...baseIssueHeaders,
        cookie: `${SESSION_COOKIE_NAME}=${activated.sessionToken}`,
        'idempotency-key': randomUUID()
      }
    }),
    routeContext
  );
  assert(wrongRoleResponse.status === 403, 'activation issue API must reject WORKER role');

  const malformedIdResponse = await issueActivationRoute(
    new NextRequest('http://localhost/api/admin/workers/not-a-uuid/activation', {
      method: 'POST',
      headers: { ...baseIssueHeaders, cookie: `${SESSION_COOKIE_NAME}=${adminSessionToken}` }
    }),
    { params: Promise.resolve({ employeeId: 'not-a-uuid' }) }
  );
  assert(malformedIdResponse.status === 404, 'malformed employee id must map to WORKER_NOT_FOUND');

  const issuedApiResponse = await issueActivationRoute(
    new NextRequest(`http://localhost/api/admin/workers/${apiWorker.employee.id}/activation`, {
      method: 'POST',
      headers: {
        ...baseIssueHeaders,
        cookie: `${SESSION_COOKIE_NAME}=${adminSessionToken}`,
        'idempotency-key': randomUUID()
      }
    }),
    routeContext
  );
  assert(issuedApiResponse.status === 201, 'ADMIN activation issue API must return 201');
  const issuedApiBody = (await issuedApiResponse.json()) as { activationCode?: string };
  assert(issuedApiBody.activationCode, 'issue API must return activationCode once');

  const verifyApiResponse = await verifyActivationRoute(
    new NextRequest(`http://localhost/api/auth/activate?token=${encodeURIComponent(issuedApiBody.activationCode)}`, {
      headers: { 'x-forwarded-for': '127.0.0.11' }
    })
  );
  assert(verifyApiResponse.status === 200, 'public activation verify API must accept fresh code');

  const csrfResponse = await setInitialPasswordRoute(
    new NextRequest('http://localhost/api/auth/set-initial-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.12' },
      body: JSON.stringify({ token: issuedApiBody.activationCode, password: 'api password is sufficiently long' })
    })
  );
  assert(csrfResponse.status === 403, 'set-initial-password API must enforce CSRF header');

  const activateApiResponse = await setInitialPasswordRoute(
    new NextRequest('http://localhost/api/auth/set-initial-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'titanor-time',
        'x-forwarded-for': '127.0.0.13'
      },
      body: JSON.stringify({ token: issuedApiBody.activationCode, password: 'api password is sufficiently long' })
    })
  );
  assert(activateApiResponse.status === 200, 'set-initial-password API must activate a valid worker');
  assert(activateApiResponse.cookies.get(SESSION_COOKIE_NAME)?.value, 'activation API must set auto-login cookie');

  const replayApiResponse = await setInitialPasswordRoute(
    new NextRequest('http://localhost/api/auth/set-initial-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'titanor-time',
        'x-forwarded-for': '127.0.0.14'
      },
      body: JSON.stringify({ token: issuedApiBody.activationCode, password: 'another sufficiently long api password' })
    })
  );
  assert(replayApiResponse.status === 410, 'set-initial-password API must reject replay with 410');

  console.log('activation vertical slice: all checks passed');
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'activation test failed');
    process.exitCode = 1;
  });
