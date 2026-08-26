// Fix (2026-08-26) — standalone ADMIN accounts (created via POST /api/admin/users/admins,
// lib/users.ts createStandaloneAdmin) could never be issued an activation token:
// lib/system-activation.ts's eligibility gate only ever accepted a current FOREMAN role (it
// predates admin creation). Covers: ADMIN can now be issued a token and complete activation;
// FOREMAN (the original, already-working path) is unaffected; a role with neither still
// correctly gets ACCOUNT_NOT_ELIGIBLE — the fix must not over-widen the gate.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { createStandaloneAdmin, createStandaloneForeman } from '../lib/users';
import { issueSystemActivationToken, verifySystemActivationToken, setAccountPassword } from '../lib/system-activation';

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

async function makeSuperAdmin(suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'SUPER_ADMIN' } });
  const user = await prisma.user.create({ data: { username: `saatest_super_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function main(): Promise<void> {
  const superAdminId = await makeSuperAdmin('a');
  const requestId = randomUUID();

  // --- ADMIN: was previously stuck ACCOUNT_NOT_ELIGIBLE forever, now must succeed end-to-end ---
  const adminUsername = `saatest_admin_${randomUUID().slice(0, 6)}`;
  const createdAdmin = await createStandaloneAdmin(adminUsername, null, 'EN', superAdminId, requestId);
  check('fixture: standalone ADMIN created', !('code' in createdAdmin) || createdAdmin.code === undefined, createdAdmin);
  const adminUserId = 'id' in createdAdmin ? createdAdmin.id : '';

  const issuedForAdmin = await issueSystemActivationToken(adminUserId, superAdminId, randomUUID());
  check('ADMIN: issueSystemActivationToken no longer returns ACCOUNT_NOT_ELIGIBLE', !('code' in issuedForAdmin), issuedForAdmin);

  if (!('code' in issuedForAdmin)) {
    // Recover the raw code the same way the UI would display it — formatActivationCodeForDisplay
    // output round-trips through verify/setAccountPassword just like a real pasted code.
    const verified = await verifySystemActivationToken(issuedForAdmin.activationCode);
    check('ADMIN: issued token verifies as valid', !('code' in verified), verified);

    const activated = await setAccountPassword(issuedForAdmin.activationCode, 'a-valid-password-123', randomUUID(), null, null);
    check('ADMIN: setAccountPassword succeeds (was previously ACCOUNT_NOT_ELIGIBLE)', !('code' in activated), activated);
    if (!('code' in activated)) {
      check('ADMIN: activated user carries the ADMIN role', activated.user.roles.includes('ADMIN'), activated.user.roles);
    }

    const userRow = await prisma.user.findUniqueOrThrow({ where: { id: adminUserId }, select: { status: true } });
    check('ADMIN: User.status is now ACTIVE', userRow.status === 'ACTIVE', userRow.status);
  }

  // --- FOREMAN: the original path must still work unchanged (regression) ---
  const foremanUsername = `saatest_foreman_${randomUUID().slice(0, 6)}`;
  const createdForeman = await createStandaloneForeman(foremanUsername, null, 'EN', superAdminId, requestId);
  const foremanUserId = 'id' in createdForeman ? createdForeman.id : '';
  check('fixture: standalone FOREMAN created', foremanUserId !== '', createdForeman);

  const issuedForForeman = await issueSystemActivationToken(foremanUserId, superAdminId, randomUUID());
  check('FOREMAN: issueSystemActivationToken still succeeds (regression)', !('code' in issuedForForeman), issuedForForeman);
  if (!('code' in issuedForForeman)) {
    const activatedForeman = await setAccountPassword(issuedForForeman.activationCode, 'a-valid-password-123', randomUUID(), null, null);
    check('FOREMAN: setAccountPassword still succeeds (regression)', !('code' in activatedForeman), activatedForeman);
  }

  // --- Negative control: a user with neither FOREMAN nor ADMIN must still be rejected ---
  const workerRole = await prisma.role.findFirstOrThrow({ where: { name: 'WORKER' } });
  const strayUser = await prisma.user.create({
    data: { username: `saatest_stray_${randomUUID().slice(0, 6)}`, status: 'PENDING_ACTIVATION', locale: 'EN', employeeId: null, userRoles: { create: { roleId: workerRole.id } } }
  });
  const issuedForStray = await issueSystemActivationToken(strayUser.id, superAdminId, randomUUID());
  check('negative control: a WORKER-role standalone user is still ACCOUNT_NOT_ELIGIBLE (fix did not over-widen the gate)', 'code' in issuedForStray && issuedForStray.code === 'ACCOUNT_NOT_ELIGIBLE', issuedForStray);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
