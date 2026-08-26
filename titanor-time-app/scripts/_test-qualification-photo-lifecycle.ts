// Worker Dossier feature (2026-08-26, task spec §17-19/§50) — direct lib-level test for the new
// qualification-photo lifecycle (upload-later, replace-with-old-file-cleanup, remove-without-
// deleting-the-credential, repeat-DELETE-is-safe, ownership enforcement).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { createEmployeeQualification, setEmployeeQualificationPhoto, removeEmployeeQualificationPhoto, getEmployeeQualificationPhotoPath } from '../lib/employee-profile';

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
  const employee = await prisma.employee.create({ data: { employeeNumber: `QPTEST-${suffix}-${randomUUID().slice(0, 6)}`, firstName: 'Photo', lastName: `Test${suffix}` } });
  return employee.id;
}

async function makeAdmin(suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({ data: { username: `qptest_admin_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function makeImageFile(name: string, color: { r: number; g: number; b: number }): Promise<File> {
  const buffer = await sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).jpeg().toBuffer();
  return new File([new Uint8Array(buffer)], name, { type: 'image/jpeg' });
}

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'employees');

async function main(): Promise<void> {
  const employeeId = await makeEmployee('a');
  const otherEmployeeId = await makeEmployee('b');
  const adminId = await makeAdmin('a');
  const requestId = randomUUID();

  // --- Create without photo ---
  const createdNoPhoto = await createEmployeeQualification({
    employeeId,
    definitionId: null,
    name: 'Custom Card',
    certificateNumber: null,
    issuer: null,
    issuedOn: null,
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    photoFile: null,
    actorUserId: adminId,
    requestId,
    isAdminActor: true
  });
  check('create without photo succeeds', createdNoPhoto.ok, createdNoPhoto);
  const qualNoPhotoId = createdNoPhoto.ok ? createdNoPhoto.id : '';
  const pathAfterCreateNoPhoto = await getEmployeeQualificationPhotoPath(qualNoPhotoId, employeeId);
  check('no photoPath after creating without photo', pathAfterCreateNoPhoto === null);

  // --- Upload photo later ---
  const photo1 = await makeImageFile('a.jpg', { r: 200, g: 10, b: 10 });
  const uploadLater = await setEmployeeQualificationPhoto(qualNoPhotoId, employeeId, photo1);
  check('upload photo later succeeds', uploadLater.ok, uploadLater);
  const pathAfterUpload = await getEmployeeQualificationPhotoPath(qualNoPhotoId, employeeId);
  check('photoPath set after upload-later', pathAfterUpload !== null, pathAfterUpload);
  const firstStoredAbsPath = pathAfterUpload ? path.join(UPLOAD_ROOT, pathAfterUpload) : null;
  check('uploaded file actually exists on disk', firstStoredAbsPath !== null && existsSync(firstStoredAbsPath));

  // --- Replace photo — old file cleaned up ---
  const photo2 = await makeImageFile('b.jpg', { r: 10, g: 200, b: 10 });
  const replaced = await setEmployeeQualificationPhoto(qualNoPhotoId, employeeId, photo2);
  check('replace photo succeeds', replaced.ok, replaced);
  const pathAfterReplace = await getEmployeeQualificationPhotoPath(qualNoPhotoId, employeeId);
  check('photoPath changed after replace', pathAfterReplace !== null && pathAfterReplace !== pathAfterUpload, { before: pathAfterUpload, after: pathAfterReplace });
  check('old stored file removed after replace', firstStoredAbsPath !== null && !existsSync(firstStoredAbsPath));
  const secondStoredAbsPath = pathAfterReplace ? path.join(UPLOAD_ROOT, pathAfterReplace) : null;
  check('new stored file exists after replace', secondStoredAbsPath !== null && existsSync(secondStoredAbsPath));

  // --- Remove photo — qualification row survives ---
  const removed = await removeEmployeeQualificationPhoto(qualNoPhotoId, employeeId);
  check('remove photo succeeds', removed.ok, removed);
  const pathAfterRemove = await getEmployeeQualificationPhotoPath(qualNoPhotoId, employeeId);
  check('photoPath null after remove', pathAfterRemove === null);
  check('removed file no longer exists on disk', secondStoredAbsPath !== null && !existsSync(secondStoredAbsPath));
  const stillExistsRow = await prisma.employeeQualification.findUnique({ where: { id: qualNoPhotoId }, select: { id: true, name: true } });
  check('qualification row still exists after photo removal', stillExistsRow?.name === 'Custom Card', stillExistsRow);

  // --- Remove again — safe no-op ---
  const removedAgain = await removeEmployeeQualificationPhoto(qualNoPhotoId, employeeId);
  check('repeat DELETE of an already-photoless qualification is safe (ok:true)', removedAgain.ok, removedAgain);

  // --- Create with photo directly ---
  const photo3 = await makeImageFile('c.jpg', { r: 10, g: 10, b: 200 });
  const createdWithPhoto = await createEmployeeQualification({
    employeeId,
    definitionId: null,
    name: 'Custom Card With Photo',
    certificateNumber: null,
    issuer: null,
    issuedOn: null,
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    photoFile: photo3,
    actorUserId: adminId,
    requestId: randomUUID(),
    isAdminActor: true
  });
  check('create with photo succeeds', createdWithPhoto.ok, createdWithPhoto);
  if (createdWithPhoto.ok) {
    const p = await getEmployeeQualificationPhotoPath(createdWithPhoto.id, employeeId);
    check('photoPath set immediately after create-with-photo', p !== null);
  }

  // --- expiresOn now unconditionally required for new employee credentials ---
  const missingExpiry = await createEmployeeQualification({
    employeeId,
    definitionId: null,
    name: 'No Expiry Card',
    certificateNumber: null,
    issuer: null,
    issuedOn: null,
    expiresOn: null,
    photoFile: null,
    actorUserId: adminId,
    requestId: randomUUID(),
    isAdminActor: true
  });
  check('create without expiresOn is rejected (VALIDATION_ERROR)', !missingExpiry.ok && missingExpiry.code === 'VALIDATION_ERROR', missingExpiry);

  // --- Ownership: another employee's id can't touch this qualification's photo ---
  const photo4 = await makeImageFile('d.jpg', { r: 5, g: 5, b: 5 });
  const wrongOwnerUpload = await setEmployeeQualificationPhoto(qualNoPhotoId, otherEmployeeId, photo4);
  check('setEmployeeQualificationPhoto with wrong employeeId returns FORBIDDEN', !wrongOwnerUpload.ok && wrongOwnerUpload.code === 'FORBIDDEN', wrongOwnerUpload);
  const wrongOwnerRemove = await removeEmployeeQualificationPhoto(qualNoPhotoId, otherEmployeeId);
  check('removeEmployeeQualificationPhoto with wrong employeeId returns FORBIDDEN', !wrongOwnerRemove.ok && wrongOwnerRemove.code === 'FORBIDDEN', wrongOwnerRemove);
  const wrongOwnerRead = await getEmployeeQualificationPhotoPath(qualNoPhotoId, otherEmployeeId);
  check('getEmployeeQualificationPhotoPath with wrong employeeId returns null', wrongOwnerRead === null);

  // --- Non-existent qualification id ---
  const notFoundUpload = await setEmployeeQualificationPhoto(randomUUID(), employeeId, photo4);
  check('upload against non-existent qualification returns NOT_FOUND', !notFoundUpload.ok && notFoundUpload.code === 'NOT_FOUND', notFoundUpload);

  // --- Unsupported file type rejected ---
  const badFile = new File([new Uint8Array([1, 2, 3, 4])], 'x.txt', { type: 'text/plain' });
  const badUpload = await setEmployeeQualificationPhoto(qualNoPhotoId, employeeId, badFile);
  check('unsupported mime type rejected', !badUpload.ok && badUpload.code === 'UNSUPPORTED_TYPE', badUpload);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
