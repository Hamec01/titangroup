// Follow-up (2026-08-26): qualification photo upload hardening — direct lib-level test.
// Covers exactly the 4 scenarios from the task spec:
//   A. DB update fails after a successful file save -> new file removed, old DB photoPath
//      unchanged, old file remains.
//   B. Successful replacement -> new path saved, old physical file deleted.
//   C. Repeated request with the SAME Idempotency-Key -> no duplicate upload side effect.
//   D. A DIFFERENT Idempotency-Key -> a legitimate new replacement is allowed.
//
// C/D exercise the exact same lib/idempotency.ts primitives (beginIdempotentRequest /
// completeIdempotentRequest) and identity/hash shape the two photo routes now construct
// (routeTemplate + pathParams-only hash, no file bytes hashed) — this project's established
// convention is lib-level tests only (no committed HTTP-server test spins one up), so this
// simulates the route's control flow directly rather than making a real HTTP request.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { createEmployeeQualification, setEmployeeQualificationPhoto } from '../lib/employee-profile';
import { computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '../lib/idempotency';

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
  const employee = await prisma.employee.create({ data: { employeeNumber: `QPH-${suffix}-${randomUUID().slice(0, 6)}`, firstName: 'Hardening', lastName: `Test${suffix}` } });
  return employee.id;
}

async function makeAdmin(suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({ data: { username: `qphtest_admin_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function makeImageFile(name: string, color: { r: number; g: number; b: number }): Promise<File> {
  const buffer = await sharp({ create: { width: 30, height: 30, channels: 3, background: color } }).jpeg().toBuffer();
  return new File([new Uint8Array(buffer)], name, { type: 'image/jpeg' });
}

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'employees');
function qualPhotoDir(employeeId: string): string {
  return path.join(UPLOAD_ROOT, employeeId, 'qualification-photo');
}
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

async function main(): Promise<void> {
  const employeeId = await makeEmployee('a');
  const adminId = await makeAdmin('a');

  const initialPhoto = await makeImageFile('initial.jpg', { r: 1, g: 2, b: 3 });
  const created = await createEmployeeQualification({
    employeeId,
    definitionId: null,
    name: 'Hardening Test Card',
    certificateNumber: null,
    issuer: null,
    issuedOn: null,
    expiresOn: new Date('2099-01-01T00:00:00.000Z'),
    photoFile: initialPhoto,
    actorUserId: adminId,
    requestId: randomUUID(),
    isAdminActor: true
  });
  check('fixture: qualification created with an initial photo', created.ok, created);
  const qualId = created.ok ? created.id : '';
  const rowInitial = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  const initialPhotoPath = rowInitial.photoPath;
  check('fixture: initial photoPath set', initialPhotoPath !== null, initialPhotoPath);
  const initialAbsPath = initialPhotoPath ? path.join(UPLOAD_ROOT, initialPhotoPath) : null;
  check('fixture: initial file exists on disk', initialAbsPath !== null && existsSync(initialAbsPath));

  // ===================== A. DB update fails after a successful save =====================
  const dirBeforeA = listFiles(qualPhotoDir(employeeId));
  const originalUpdate = prisma.employeeQualification.update.bind(prisma.employeeQualification);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.employeeQualification as any).update = async () => {
    throw new Error('SIMULATED_DB_FAILURE');
  };
  let threwA = false;
  let thrownMessageA = '';
  try {
    await setEmployeeQualificationPhoto(qualId, employeeId, await makeImageFile('willfail.jpg', { r: 9, g: 9, b: 9 }));
  } catch (error) {
    threwA = true;
    thrownMessageA = error instanceof Error ? error.message : String(error);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma.employeeQualification as any).update = originalUpdate;
  }
  check('A: setEmployeeQualificationPhoto propagates the original DB error', threwA && thrownMessageA === 'SIMULATED_DB_FAILURE', thrownMessageA);

  const dirAfterA = listFiles(qualPhotoDir(employeeId));
  check('A: no orphan file left behind — directory listing unchanged', JSON.stringify(dirBeforeA) === JSON.stringify(dirAfterA), { before: dirBeforeA, after: dirAfterA });

  const rowAfterA = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('A: DB photoPath unchanged after the failed update', rowAfterA.photoPath === initialPhotoPath, { expected: initialPhotoPath, actual: rowAfterA.photoPath });
  check('A: old file still present on disk', initialAbsPath !== null && existsSync(initialAbsPath));

  // ===================== B. Successful replacement =====================
  const replacePhoto = await makeImageFile('replace-b.jpg', { r: 40, g: 50, b: 60 });
  const resultB = await setEmployeeQualificationPhoto(qualId, employeeId, replacePhoto);
  check('B: replacement succeeds', resultB.ok, resultB);
  const rowAfterB = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('B: new photoPath differs from the initial one', rowAfterB.photoPath !== null && rowAfterB.photoPath !== initialPhotoPath, rowAfterB.photoPath);
  check('B: old (initial) physical file deleted after successful replacement', initialAbsPath !== null && !existsSync(initialAbsPath));
  const pathAfterB = rowAfterB.photoPath;
  const absAfterB = pathAfterB ? path.join(UPLOAD_ROOT, pathAfterB) : null;
  check('B: new physical file exists', absAfterB !== null && existsSync(absAfterB));

  // ===================== C. Repeated same Idempotency-Key — no duplicate side effect =====================
  const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/profile/qualifications/:qualificationId/photo';
  const sharedKey = randomUUID();
  const identity: IdempotencyIdentity = { actorUserId: adminId, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: sharedKey };
  const requestHash = computeRequestHash({ pathParams: { employeeId, qualificationId: qualId } });

  const dirBeforeC = listFiles(qualPhotoDir(employeeId));
  const begin1 = await beginIdempotentRequest(identity, requestHash);
  check('C: first request with a fresh key returns PROCEED', begin1.kind === 'PROCEED', begin1);
  if (begin1.kind === 'PROCEED') {
    const photoC1 = await makeImageFile('idem-c1.jpg', { r: 70, g: 80, b: 90 });
    const uploadResult = await setEmployeeQualificationPhoto(qualId, employeeId, photoC1);
    await completeIdempotentRequest(identity, { statusCode: 200, body: { ok: uploadResult.ok } });
  }
  const rowAfterFirstC = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  const pathAfterFirstC = rowAfterFirstC.photoPath;
  const dirAfterFirstC = listFiles(qualPhotoDir(employeeId));
  check('C: first request actually replaced the photo', pathAfterFirstC !== pathAfterB, pathAfterFirstC);

  // Second "request" — identical actor/route/key AND identical hash (same path params) -> CACHED.
  const begin2 = await beginIdempotentRequest(identity, requestHash);
  check('C: repeated request with the same key + same hash returns CACHED (not PROCEED)', begin2.kind === 'CACHED', begin2);
  // Business logic deliberately NOT invoked here — mirrors exactly what the route does on CACHED.
  const rowAfterRepeatC = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('C: photoPath unchanged after the repeated (cached) request', rowAfterRepeatC.photoPath === pathAfterFirstC, { before: pathAfterFirstC, after: rowAfterRepeatC.photoPath });
  const dirAfterRepeatC = listFiles(qualPhotoDir(employeeId));
  check('C: no new file created by the repeated (cached) request', JSON.stringify(dirAfterFirstC) === JSON.stringify(dirAfterRepeatC), { dirBeforeC, dirAfterFirstC, dirAfterRepeatC });

  // ===================== D. A different Idempotency-Key allows a legitimate new replacement =====================
  const differentKey = randomUUID();
  const identityD: IdempotencyIdentity = { actorUserId: adminId, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: differentKey };
  const beginD = await beginIdempotentRequest(identityD, requestHash);
  check('D: a different Idempotency-Key returns PROCEED even with the same request hash', beginD.kind === 'PROCEED', beginD);
  if (beginD.kind === 'PROCEED') {
    const photoD = await makeImageFile('idem-d.jpg', { r: 120, g: 130, b: 140 });
    const uploadResultD = await setEmployeeQualificationPhoto(qualId, employeeId, photoD);
    check('D: legitimate new replacement succeeds', uploadResultD.ok, uploadResultD);
    await completeIdempotentRequest(identityD, { statusCode: 200, body: { ok: uploadResultD.ok } });
  }
  const rowAfterD = await prisma.employeeQualification.findUniqueOrThrow({ where: { id: qualId } });
  check('D: photoPath changed again under the different key', rowAfterD.photoPath !== pathAfterFirstC, { before: pathAfterFirstC, after: rowAfterD.photoPath });
  const oldAbsBeforeD = pathAfterFirstC ? path.join(UPLOAD_ROOT, pathAfterFirstC) : null;
  check('D: the previous (pre-D) file was cleaned up', oldAbsBeforeD !== null && !existsSync(oldAbsBeforeD));

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
