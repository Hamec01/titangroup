// Worker Dossier feature (2026-08-26, task spec §48/§49) — direct lib-level test for the new
// EmployeeProfile fields (henkilötunnus, contact email, address): update/read round-trip,
// encryption-at-rest, audit hygiene (no plaintext HETU anywhere in the audit row), absence of
// HETU from generic reads (getEmployeeProfileView, listWorkers), and role-based access via
// hasPermission (FOREMAN denied, WORKER denied the .all scope, ADMIN/SUPER_ADMIN granted).
import { randomUUID, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getEmployeeProfileView, updateEmployeeProfileFields, validateProfileFields, getEmployeeProfilePersonalIdentityCode } from '../lib/employee-profile';
import { validatePersonalIdentityCode, normalizePersonalIdentityCode } from '../lib/personal-identity-code';
import { hasPermission } from '../lib/permissions';
import { listWorkers } from '../lib/workers';

process.env.PERSONAL_DATA_ENCRYPTION_KEY = process.env.PERSONAL_DATA_ENCRYPTION_KEY ?? randomBytes(32).toString('base64');

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
  const employee = await prisma.employee.create({ data: { employeeNumber: `WDTEST-${suffix}-${randomUUID().slice(0, 6)}`, firstName: 'Dossier', lastName: `Test${suffix}` } });
  return employee.id;
}

async function makeUser(roleName: string, suffix: string, employeeId?: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({
    data: {
      username: `wdtest_${suffix}_${randomUUID().slice(0, 6)}`,
      status: 'ACTIVE',
      locale: 'EN',
      employeeId,
      userRoles: { create: { roleId: role.id } }
    }
  });
  return user.id;
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
  const adminId = await makeUser('ADMIN', 'admin');
  const employeeId = await makeEmployee('worker');
  const hetu = buildValidHetu(12, 6, 88, '-', 321);

  // --- Admin sets full profile including HETU/contact/address ---
  const update1 = await updateEmployeeProfileFields({
    employeeId,
    version: 0,
    actorUserId: adminId,
    requestId: randomUUID(),
    fields: {
      dateOfBirth: new Date('1988-06-12T00:00:00.000Z'),
      specialty: 'Welder',
      skills: 'TIG, MAG',
      personalIdentityCode: normalizePersonalIdentityCode(hetu),
      contactEmail: 'worker@example.com',
      addressStreet: 'Testikatu 1',
      addressPostalCode: '00100',
      addressCity: 'Helsinki',
      addressCountry: 'Finland'
    }
  });
  check('admin profile create with all new fields succeeds', update1.ok, update1);

  const view = await getEmployeeProfileView(employeeId, true);
  check('view has hasPersonalIdentityCode=true', view?.hasPersonalIdentityCode === true, view);
  check('view personalIdentityCodeLast4 matches input', view?.personalIdentityCodeLast4 === hetu.slice(-4), { got: view?.personalIdentityCodeLast4, expected: hetu.slice(-4) });
  check('view contactEmail round-trips', view?.contactEmail === 'worker@example.com');
  check('view address fields round-trip', view?.addressStreet === 'Testikatu 1' && view?.addressPostalCode === '00100' && view?.addressCity === 'Helsinki' && view?.addressCountry === 'Finland');

  // --- Plaintext HETU never appears anywhere in the generic view object ---
  const viewJson = JSON.stringify(view);
  check('plaintext HETU absent from getEmployeeProfileView JSON', !viewJson.includes(hetu), viewJson);

  // --- Decrypt round-trip via the dedicated reveal function ---
  const decrypted = await getEmployeeProfilePersonalIdentityCode(employeeId);
  check('decrypted value equals original plaintext', decrypted === hetu, decrypted);

  // --- DB row: encrypted column is not the plaintext ---
  const row = await prisma.employeeProfile.findUniqueOrThrow({ where: { employeeId }, select: { personalIdentityCodeEncrypted: true, personalIdentityCodeLast4: true } });
  check('DB encrypted column differs from plaintext', row.personalIdentityCodeEncrypted !== hetu, row.personalIdentityCodeEncrypted);
  check('DB encrypted column does not contain plaintext substring', !(row.personalIdentityCodeEncrypted ?? '').includes(hetu));
  check('DB last4 column matches', row.personalIdentityCodeLast4 === hetu.slice(-4));

  // --- Audit row: no plaintext HETU anywhere, presence marker only ---
  const auditRows = await prisma.auditEvent.findMany({ where: { entityType: 'EMPLOYEE_PROFILE', entityId: (await prisma.employeeProfile.findUniqueOrThrow({ where: { employeeId }, select: { id: true } })).id }, orderBy: { createdAt: 'desc' }, take: 1 });
  check('exactly one audit row found for this create', auditRows.length === 1, auditRows.length);
  if (auditRows.length === 1) {
    const auditJson = JSON.stringify(auditRows[0]);
    check('audit row JSON does not contain plaintext HETU', !auditJson.includes(hetu), auditJson);
    const afterValue = auditRows[0].afterValue as Record<string, unknown> | null;
    check('audit afterValue has personalIdentityCodePresent=true, no raw value', afterValue?.personalIdentityCodePresent === true && !('personalIdentityCode' in (afterValue ?? {})), afterValue);
    check('audit afterValue has contactEmailPresent=true (not the raw email)', afterValue?.contactEmailPresent === true && !('contactEmail' in (afterValue ?? {})), afterValue);
    check('audit afterValue has addressUpdated=true (no raw address fields)', afterValue?.addressUpdated === true && !('addressStreet' in (afterValue ?? {})), afterValue);
  }

  // --- Clearing HETU removes both encrypted + last4 ---
  const cleared = await updateEmployeeProfileFields({ employeeId, version: view!.version, actorUserId: adminId, requestId: randomUUID(), fields: { personalIdentityCode: null } });
  check('clearing HETU succeeds', cleared.ok, cleared);
  const viewAfterClear = await getEmployeeProfileView(employeeId, true);
  check('hasPersonalIdentityCode false after clearing', viewAfterClear?.hasPersonalIdentityCode === false);
  check('personalIdentityCodeLast4 null after clearing', viewAfterClear?.personalIdentityCodeLast4 === null);
  const decryptedAfterClear = await getEmployeeProfilePersonalIdentityCode(employeeId);
  check('reveal returns null after clearing', decryptedAfterClear === null);

  // --- Validation ---
  const invalidErrors = validateProfileFields({ personalIdentityCode: '150590-000X' });
  check('invalid HETU produces a generic error (no input reflected)', Array.isArray(invalidErrors.personalIdentityCode) && !JSON.stringify(invalidErrors).includes('150590-000X'), invalidErrors);

  const invalidEmailErrors = validateProfileFields({ contactEmail: 'not-an-email' });
  check('invalid email rejected', Array.isArray(invalidEmailErrors.contactEmail), invalidEmailErrors);

  const tooLongStreet = validateProfileFields({ addressStreet: 'x'.repeat(256) });
  check('addressStreet over 255 chars rejected', Array.isArray(tooLongStreet.addressStreet));

  const validFields = validateProfileFields({ contactEmail: 'ok@example.com', addressCity: 'Helsinki', personalIdentityCode: hetu });
  check('valid fields produce no errors', Object.keys(validFields).length === 0, validFields);

  // --- Worker cannot self-verify is out of scope here (qualification concern); but HETU
  // ownership is enforced entirely by which employeeId a route passes in — verify via
  // hasPermission that WORKER never holds the .all scope, and FOREMAN holds neither. ---
  check('WORKER role lacks worker.profile.read.all (cannot read arbitrary employee HETU)', !(await hasPermission(['WORKER'], 'worker.profile.read.all')));
  check('FOREMAN role lacks worker.profile.read.all', !(await hasPermission(['FOREMAN'], 'worker.profile.read.all')));
  check('FOREMAN role lacks worker.profile.read.own', !(await hasPermission(['FOREMAN'], 'worker.profile.read.own')));
  check('FOREMAN role lacks worker.profile.update.all', !(await hasPermission(['FOREMAN'], 'worker.profile.update.all')));
  check('ADMIN role holds worker.profile.read.all', await hasPermission(['ADMIN'], 'worker.profile.read.all'));
  check('SUPER_ADMIN role holds worker.profile.read.all', await hasPermission(['SUPER_ADMIN'], 'worker.profile.read.all'));
  check('WORKER role holds worker.profile.read.own (its own scope only)', await hasPermission(['WORKER'], 'worker.profile.read.own'));

  // --- HETU absent from the generic worker list (lib/workers.ts) ---
  const workerList = await listWorkers(1, 50);
  const listJson = JSON.stringify(workerList);
  check('personalIdentityCode-shaped keys absent from listWorkers()', !/personalIdentityCode/i.test(listJson), listJson.length);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
