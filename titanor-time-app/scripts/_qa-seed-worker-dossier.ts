// Seed for scripts/_test-worker-dossier-browser-qa.ts — creates the fixed dossier fixture the
// browser test expects: employee QA-0001, users qa_admin (ADMIN) / qa_worker (WORKER), password
// QaPassw0rd!23, a profile photo, HETU + contact + address, and two qualification cards (one
// admin-VERIFIED "Occupational Safety Card" with a photo, one SELF_REPORTED "Custom QA
// Certificate"). Idempotent: a second run wipes and re-creates the QA-0001 rows.
//
// Needs DATABASE_URL + the PERSONAL_DATA_ENCRYPTION_KEY / IDEMPOTENCY_ENCRYPTION_KEY / … env the
// app runs with. Drive it from ops/titanor-time/run-worker-dossier-qa.sh, never against pilot/prod.
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { normalizePersonalIdentityCode } from '../lib/personal-identity-code';
import { updateEmployeeProfileFields, setEmployeeProfilePhoto, createEmployeeQualification } from '../lib/employee-profile';

const PASSWORD = 'QaPassw0rd!23';
const HETU = '030785-2464';

async function pngFile(name: string, rgb: { r: number; g: number; b: number }): Promise<File> {
  const buf = await sharp({ create: { width: 48, height: 36, channels: 3, background: rgb } }).png().toBuffer();
  return new File([new Uint8Array(buf)], name, { type: 'image/png' });
}

async function main(): Promise<void> {
  // --- Wipe any previous QA-0001 fixture so the seed is idempotent ---
  const existing = await prisma.employee.findFirst({ where: { employeeNumber: 'QA-0001' }, select: { id: true } });
  if (existing) {
    await prisma.user.deleteMany({ where: { employeeId: existing.id } });
    await prisma.employee.delete({ where: { id: existing.id } });
  }
  await prisma.user.deleteMany({ where: { username: { in: ['qa_admin', 'qa_worker'] } } });

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  const workerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } });

  const admin = await prisma.user.create({ data: { username: 'qa_admin', status: 'ACTIVE', locale: 'EN', passwordHash } });
  await prisma.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });

  const employee = await prisma.employee.create({ data: { employeeNumber: 'QA-0001', firstName: 'Qa', lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  const worker = await prisma.user.create({ data: { username: 'qa_worker', status: 'ACTIVE', locale: 'EN', employeeId: employee.id, passwordHash } });
  await prisma.userRole.create({ data: { userId: worker.id, roleId: workerRole.id } });

  // --- Profile: HETU + contact + address ---
  const profileRes = await updateEmployeeProfileFields({
    employeeId: employee.id,
    version: 0,
    actorUserId: admin.id,
    requestId: randomUUID(),
    fields: {
      personalIdentityCode: normalizePersonalIdentityCode(HETU),
      contactEmail: 'qa-worker@example.com',
      addressStreet: 'Testikatu 1'
    }
  });
  if (!profileRes.ok) throw new Error(`profile seed failed: ${JSON.stringify(profileRes)}`);

  // --- Profile photo ---
  const photoRes = await setEmployeeProfilePhoto(employee.id, await pngFile('qa-photo.png', { r: 60, g: 110, b: 190 }));
  if (!photoRes.ok) throw new Error(`profile photo seed failed: ${JSON.stringify(photoRes)}`);

  // --- Qualification 1: admin-created "Occupational Safety Card" (-> VERIFIED) with a photo ---
  const safetyDef = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'OCCUPATIONAL_SAFETY_CARD' } });
  const q1 = await createEmployeeQualification({
    employeeId: employee.id,
    definitionId: safetyDef.id,
    name: null,
    certificateNumber: 'OSC-QA-1',
    issuer: 'QA Authority',
    issuedOn: new Date('2024-01-01T00:00:00.000Z'),
    expiresOn: new Date(Date.now() + 200 * 86400000),
    photoFile: await pngFile('safety.png', { r: 200, g: 60, b: 60 }),
    actorUserId: admin.id,
    requestId: randomUUID(),
    isAdminActor: true
  });
  if (!q1.ok) throw new Error(`safety qualification seed failed: ${JSON.stringify(q1)}`);

  // --- Qualification 2: custom "Custom QA Certificate" (SELF_REPORTED, no photo) ---
  const q2 = await createEmployeeQualification({
    employeeId: employee.id,
    definitionId: null,
    name: 'Custom QA Certificate',
    certificateNumber: null,
    issuer: null,
    issuedOn: null,
    expiresOn: new Date(Date.now() + 120 * 86400000),
    photoFile: null,
    actorUserId: admin.id,
    requestId: randomUUID(),
    isAdminActor: false
  });
  if (!q2.ok) throw new Error(`custom qualification seed failed: ${JSON.stringify(q2)}`);

  console.log(JSON.stringify({ ok: true, employeeId: employee.id, adminId: admin.id, workerId: worker.id }));
}

main()
  .catch((error) => {
    console.error('SEED ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
