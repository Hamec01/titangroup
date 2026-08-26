// Worker Dossier feature (2026-08-26, task spec §20/§51) — direct lib-level test for
// qualification metadata edit + the worker-edit verification-reset rule: a worker editing their
// own already-VERIFIED credential's metadata drops it to SELF_REPORTED; an admin's edit never
// does. Also covers issuedOn>expiresOn rejection and admin-edit-stays-VERIFIED.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { createEmployeeQualification, updateEmployeeQualification, setEmployeeQualificationVerification } from '../lib/employee-profile';

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

async function makeEmployee(suffix: string): Promise<string> {
  const employee = await prisma.employee.create({ data: { employeeNumber: `QETEST-${suffix}-${randomUUID().slice(0, 6)}`, firstName: 'Edit', lastName: `Test${suffix}` } });
  return employee.id;
}

async function makeUser(roleName: string, suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({ data: { username: `qetest_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function main(): Promise<void> {
  const employeeId = await makeEmployee('a');
  const adminId = await makeUser('ADMIN', 'admin');

  // Admin creates → VERIFIED immediately (admin authorship = verification act).
  const created = await createEmployeeQualification({
    employeeId,
    definitionId: null,
    name: 'Edit Test Card',
    certificateNumber: 'AA-1',
    issuer: 'Issuer A',
    issuedOn: new Date('2020-01-01T00:00:00.000Z'),
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    photoFile: null,
    actorUserId: adminId,
    requestId: randomUUID(),
    isAdminActor: true
  });
  check('admin create succeeds', created.ok, created);
  const qualId = created.ok ? created.id : '';
  const afterCreate = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('admin-created qualification starts VERIFIED', afterCreate.verificationState === 'VERIFIED', afterCreate.verificationState);

  // Admin edits metadata (resetVerificationOnEdit: false) — stays VERIFIED.
  const adminEdit = await updateEmployeeQualification({
    qualificationId: qualId,
    employeeId,
    certificateNumber: 'AA-2',
    issuer: 'Issuer A',
    issuedOn: new Date('2020-01-01T00:00:00.000Z'),
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    actorUserId: adminId,
    requestId: randomUUID(),
    resetVerificationOnEdit: false
  });
  check('admin edit succeeds', adminEdit.ok, adminEdit);
  const afterAdminEdit = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('admin edit does NOT reset verification', afterAdminEdit.verificationState === 'VERIFIED', afterAdminEdit.verificationState);
  check('admin edit applied the new certificateNumber', afterAdminEdit.certificateNumber === 'AA-2');

  // Worker edits the same still-VERIFIED credential (resetVerificationOnEdit: true) — resets to SELF_REPORTED.
  const workerEdit = await updateEmployeeQualification({
    qualificationId: qualId,
    employeeId,
    certificateNumber: 'AA-3',
    issuer: 'Issuer A',
    issuedOn: new Date('2020-01-01T00:00:00.000Z'),
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    actorUserId: adminId, // actor id irrelevant to the reset rule itself, only resetVerificationOnEdit matters
    requestId: randomUUID(),
    resetVerificationOnEdit: true
  });
  check('worker edit succeeds', workerEdit.ok, workerEdit);
  const afterWorkerEdit = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('worker edit of a VERIFIED credential resets to SELF_REPORTED', afterWorkerEdit.verificationState === 'SELF_REPORTED', afterWorkerEdit.verificationState);
  check('verifiedAt cleared on reset', afterWorkerEdit.verifiedAt === null);
  check('verifiedByUserId cleared on reset', afterWorkerEdit.verifiedByUserId === null);
  check('worker edit applied the new certificateNumber', afterWorkerEdit.certificateNumber === 'AA-3');

  // Editing an already-SELF_REPORTED credential as worker again — stays SELF_REPORTED (no-op reset, not an error).
  const workerEdit2 = await updateEmployeeQualification({
    qualificationId: qualId,
    employeeId,
    certificateNumber: 'AA-4',
    issuer: 'Issuer A',
    issuedOn: new Date('2020-01-01T00:00:00.000Z'),
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    actorUserId: adminId,
    requestId: randomUUID(),
    resetVerificationOnEdit: true
  });
  check('second worker edit on an already-SELF_REPORTED credential succeeds', workerEdit2.ok, workerEdit2);
  const afterWorkerEdit2 = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('stays SELF_REPORTED (idempotent, not an error)', afterWorkerEdit2.verificationState === 'SELF_REPORTED');

  // Admin re-verifies.
  const reverify = await setEmployeeQualificationVerification({ qualificationId: qualId, employeeId, verify: true, actorUserId: adminId, requestId: randomUUID() });
  check('admin re-verify succeeds', reverify.ok, reverify);
  const afterReverify = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('re-verified back to VERIFIED', afterReverify.verificationState === 'VERIFIED');

  // issuedOn > expiresOn rejected on both create and update.
  const badDates = await createEmployeeQualification({
    employeeId,
    definitionId: null,
    name: 'Bad Dates Card',
    certificateNumber: null,
    issuer: null,
    issuedOn: new Date('2030-01-01T00:00:00.000Z'),
    expiresOn: new Date('2020-01-01T00:00:00.000Z'),
    photoFile: null,
    actorUserId: adminId,
    requestId: randomUUID(),
    isAdminActor: true
  });
  check('create with issuedOn > expiresOn rejected', !badDates.ok && badDates.code === 'VALIDATION_ERROR', badDates);

  const badDatesUpdate = await updateEmployeeQualification({
    qualificationId: qualId,
    employeeId,
    certificateNumber: null,
    issuer: null,
    issuedOn: new Date('2030-01-01T00:00:00.000Z'),
    expiresOn: new Date('2020-01-01T00:00:00.000Z'),
    actorUserId: adminId,
    requestId: randomUUID(),
    resetVerificationOnEdit: false
  });
  check('update with issuedOn > expiresOn rejected', !badDatesUpdate.ok && badDatesUpdate.code === 'VALIDATION_ERROR', badDatesUpdate);

  // Cross-employee edit rejected (FORBIDDEN), never an existence oracle beyond that code.
  const otherEmployeeId = await makeEmployee('b');
  const crossEdit = await updateEmployeeQualification({
    qualificationId: qualId,
    employeeId: otherEmployeeId,
    certificateNumber: 'X',
    issuer: null,
    issuedOn: null,
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    actorUserId: adminId,
    requestId: randomUUID(),
    resetVerificationOnEdit: true
  });
  check('editing another employee\'s qualification is FORBIDDEN', !crossEdit.ok && crossEdit.code === 'FORBIDDEN', crossEdit);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
