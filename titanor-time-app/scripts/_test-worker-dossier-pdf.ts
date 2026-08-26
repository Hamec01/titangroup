// Worker Dossier PDF (task spec §53-56) — direct lib-level test, same convention as
// _test-custom-report-pdf-csv.ts (no pdf-parsing library in this project, so content checks are
// %PDF- header / size / doesn't-throw, not text extraction — brittle full-byte equality is
// exactly what the task spec says to avoid). Covers: full fixture (photo, HETU, address, safety
// card + image, hot-work card without image, catalog cert + image, custom cert), Cyrillic +
// Finnish Unicode names, portrait/landscape-shaped images, dossier-with-no-qualifications.
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { prisma } from '../lib/prisma';
import { updateEmployeeProfileFields, createEmployeeQualification, setEmployeeProfilePhoto } from '../lib/employee-profile';
import { getWorkerDossierData } from '../lib/worker-dossier';
import { buildWorkerDossierPdf, workerDossierPdfFileName } from '../lib/reporting/worker-dossier-pdf';

process.env.PERSONAL_DATA_ENCRYPTION_KEY = process.env.PERSONAL_DATA_ENCRYPTION_KEY ?? randomBytes(32).toString('base64');

async function getDefinitionByCode(code: string) {
  return prisma.qualificationDefinition.findUnique({ where: { code } });
}

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

async function makeAdmin(suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({ data: { username: `dossierpdf_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function makeImageFile(width: number, height: number, color: { r: number; g: number; b: number }): Promise<File> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
  return new File([new Uint8Array(buffer)], 'x.jpg', { type: 'image/jpeg' });
}

const CHECKSUM_ALPHABET = '0123456789ABCDEFHJKLMNPRSTUVWXY';
function buildValidHetu(day: number, month: number, twoDigitYear: number, sign: string, individual: number): string {
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  const yy = String(twoDigitYear).padStart(2, '0');
  const zzz = String(individual).padStart(3, '0');
  const checksum = CHECKSUM_ALPHABET[Number(`${dd}${mm}${yy}${zzz}`) % 31];
  return `${dd}${mm}${yy}${sign}${zzz}${checksum}`;
}

async function main(): Promise<void> {
  const admin = await makeAdmin('a');

  // --- Fixture worker: Cyrillic + Finnish diacritics name, full profile, mixed qualifications ---
  const employee = await prisma.employee.create({ data: { employeeNumber: `DOSTEST-${randomUUID().slice(0, 6)}`, firstName: 'Ääkkönen Иван', lastName: 'Örn Чурыгин', phone: '+358401234567' } });
  const hetu = buildValidHetu(3, 7, 85, '-', 246);

  const profileUpdate = await updateEmployeeProfileFields({
    employeeId: employee.id,
    version: 0,
    actorUserId: admin,
    requestId: randomUUID(),
    fields: {
      dateOfBirth: new Date('1985-07-03T00:00:00.000Z'),
      specialty: 'Welder / Сварщик',
      skills: 'TIG, MAG, 6G positional welding, plate and pipe — a fairly long skills paragraph to exercise multi-line wrapping and make sure it does not overlap the next section header.',
      personalIdentityCode: hetu,
      contactEmail: 'dossier-fixture@example.com',
      addressStreet: 'Testikatu 1 A 2',
      addressPostalCode: '00100',
      addressCity: 'Helsinki',
      addressCountry: 'Finland'
    }
  });
  check('fixture: profile update succeeds', profileUpdate.ok, profileUpdate);

  const profilePhoto = await makeImageFile(60, 60, { r: 120, g: 80, b: 200 });
  const photoResult = await setEmployeeProfilePhoto(employee.id, profilePhoto);
  check('fixture: profile photo set', photoResult.ok, photoResult);

  // Safety card with a portrait image.
  const safetyDef = await getDefinitionByCode('OCCUPATIONAL_SAFETY_CARD');
  check('fixture: OCCUPATIONAL_SAFETY_CARD catalog entry exists', safetyDef !== null);
  if (safetyDef) {
    const portraitPhoto = await makeImageFile(60, 100, { r: 200, g: 0, b: 0 });
    const c1 = await createEmployeeQualification({
      employeeId: employee.id,
      definitionId: safetyDef.id,
      name: null,
      certificateNumber: 'SAFETY-001',
      issuer: 'Titanor Group',
      issuedOn: new Date('2022-01-01T00:00:00.000Z'),
      expiresOn: new Date('2099-01-01T00:00:00.000Z'),
      photoFile: portraitPhoto,
      actorUserId: admin,
      requestId: randomUUID(),
      isAdminActor: true
    });
    check('fixture: safety card with portrait image created', c1.ok, c1);
  }

  // Hot work card without an image.
  const hotWorkDef = await getDefinitionByCode('HOT_WORK_CARD');
  if (hotWorkDef) {
    const c2 = await createEmployeeQualification({
      employeeId: employee.id,
      definitionId: hotWorkDef.id,
      name: null,
      certificateNumber: 'HOTWORK-002',
      issuer: 'Titanor Group',
      issuedOn: new Date('2023-01-01T00:00:00.000Z'),
      expiresOn: new Date('2099-06-01T00:00:00.000Z'),
      photoFile: null,
      actorUserId: admin,
      requestId: randomUUID(),
      isAdminActor: true
    });
    check('fixture: hot work card without image created', c2.ok, c2);
  }

  // EN ISO 9606-1 catalog certificate with a landscape image.
  const weldDef = await getDefinitionByCode('EN_ISO_9606_1');
  if (weldDef) {
    const landscapePhoto = await makeImageFile(120, 40, { r: 0, g: 100, b: 0 });
    const c3 = await createEmployeeQualification({
      employeeId: employee.id,
      definitionId: weldDef.id,
      name: null,
      certificateNumber: 'WPS-9606-1',
      issuer: 'Inspecta',
      issuedOn: new Date('2021-05-01T00:00:00.000Z'),
      expiresOn: new Date('2026-12-31T00:00:00.000Z'),
      photoFile: landscapePhoto,
      actorUserId: admin,
      requestId: randomUUID(),
      isAdminActor: true
    });
    check('fixture: EN ISO 9606-1 with landscape image created', c3.ok, c3);
  }

  // Custom (legacy-shaped) qualification, definitionId null.
  const c4 = await createEmployeeQualification({
    employeeId: employee.id,
    definitionId: null,
    name: 'Custom In-House Rigging Certificate',
    certificateNumber: 'RIG-004',
    issuer: 'Titanor Group',
    issuedOn: new Date('2024-01-01T00:00:00.000Z'),
    expiresOn: new Date('2027-01-01T00:00:00.000Z'),
    photoFile: null,
    actorUserId: admin,
    requestId: randomUUID(),
    isAdminActor: false
  });
  check('fixture: custom qualification created', c4.ok, c4);

  // --- Data assembly ---
  const data = await getWorkerDossierData(employee.id);
  check('getWorkerDossierData returns non-null for existing employee', data !== null);
  check('getWorkerDossierData returns null for a non-existent employee', (await getWorkerDossierData(randomUUID())) === null);
  if (!data) {
    console.log(JSON.stringify({ pass, fail: fail + 1 }));
    process.exit(1);
  }
  check('dossier data: employeeNumber matches', data.employeeNumber === employee.employeeNumber);
  check('dossier data: decrypted personalIdentityCode matches fixture HETU', data.personalIdentityCode === hetu);
  check('dossier data: 4 qualifications assembled', data.qualifications.length === 4, data.qualifications.length);
  check('dossier data: profile photo buffer present', data.photo !== null && data.photo.byteLength > 0);
  const withPhoto = data.qualifications.filter((q) => q.photo !== null);
  check('dossier data: exactly 2 qualifications have a photo buffer (safety card + weld cert)', withPhoto.length === 2, withPhoto.length);

  // --- PDF generation: full fixture ---
  const pdf = await buildWorkerDossierPdf(data, 'EN', '26.08.2026 12:00');
  check('dossier PDF starts with %PDF-', pdf.subarray(0, 5).toString('ascii') === '%PDF-');
  check('dossier PDF is non-trivially sized (>2KB, has real content + 2 embedded images)', pdf.byteLength > 2048, pdf.byteLength);

  const pdfRu = await buildWorkerDossierPdf(data, 'RU', '26.08.2026 12:00');
  check('dossier PDF (RU locale) starts with %PDF-', pdfRu.subarray(0, 5).toString('ascii') === '%PDF-');
  check('dossier PDF generation with Cyrillic + Finnish diacritics name did not throw', true);

  // --- Filename convention ---
  const filename = workerDossierPdfFileName(data.employeeNumber, '2026-08-26');
  check('dossier filename matches pattern', /^titanor-worker-dossier_.+_2026-08-26\.pdf$/.test(filename), filename);
  check('dossier filename never contains the HETU', !filename.includes(hetu));

  // --- Minimal fixture: no photo, no qualifications, all optional fields empty ---
  const bareEmployee = await prisma.employee.create({ data: { employeeNumber: `DOSTEST-BARE-${randomUUID().slice(0, 6)}`, firstName: 'Bare', lastName: 'Worker' } });
  const bareData = await getWorkerDossierData(bareEmployee.id);
  check('bare fixture: dossier data assembled with no profile row', bareData !== null);
  if (bareData) {
    check('bare fixture: no qualifications', bareData.qualifications.length === 0);
    check('bare fixture: no photo', bareData.photo === null);
    check('bare fixture: no personalIdentityCode', bareData.personalIdentityCode === null);
    const barePdf = await buildWorkerDossierPdf(bareData, 'EN', '26.08.2026 12:00');
    check('bare fixture: PDF still generates successfully (%PDF- header)', barePdf.subarray(0, 5).toString('ascii') === '%PDF-');
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
