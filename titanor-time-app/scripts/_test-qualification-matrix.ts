// Direct lib-level test for getQualificationMatrix — task spec §37D (search/filters/sort/
// pagination) and §37C (permission combination, checked against hasPermission directly since
// enforcement lives in the route handler around this pure query function).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getQualificationMatrix } from '../lib/qualification-matrix';
import { hasPermission } from '../lib/permissions';

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

function daysFromNow(n: number): Date {
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() + n);
  return utcMidnight;
}

async function makeEmployee(lastName: string, firstName: string, numberSuffix: string): Promise<string> {
  const employee = await prisma.employee.create({
    data: { employeeNumber: `QMTEST-${numberSuffix}-${randomUUID().slice(0, 6)}`, firstName, lastName }
  });
  return employee.id;
}

async function makeSite(name: string): Promise<string> {
  const site = await prisma.workSite.create({ data: { name: `${name}-${randomUUID().slice(0, 6)}` } });
  return site.id;
}

async function main(): Promise<void> {
  const safety = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'OCCUPATIONAL_SAFETY_CARD' } });
  const hotWork = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'HOT_WORK_CARD' } });
  const welding = await prisma.qualificationDefinition.findFirstOrThrow({ where: { code: 'EN_ISO_9606_1' } });

  const employeeA = await makeEmployee('Alpha', 'Anna', 'a');
  const employeeB = await makeEmployee('Beta', 'Boris', 'b');
  const employeeC = await makeEmployee('Gamma', 'Carla', 'c');

  const siteX = await makeSite('SiteX');
  const siteY = await makeSite('SiteY');
  const today = daysFromNow(0);
  const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const assigner = await prisma.user.create({ data: { username: `qmtest_assigner_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: adminRole.id } } } });
  await prisma.siteAssignment.create({ data: { employeeId: employeeA, siteId: siteX, workAreaId: null, isPrimary: true, validFrom: today, assignedByUserId: assigner.id } });
  await prisma.siteAssignment.create({ data: { employeeId: employeeB, siteId: siteY, workAreaId: null, isPrimary: true, validFrom: today, assignedByUserId: assigner.id } });

  // A: valid safety card + valid hot-work card (fully compliant), no welding cert.
  await prisma.employeeQualification.create({
    data: { employeeId: employeeA, definitionId: safety.id, name: safety.nameEn, expiresOn: daysFromNow(200), verificationState: 'VERIFIED' }
  });
  await prisma.employeeQualification.create({
    data: { employeeId: employeeA, definitionId: hotWork.id, name: hotWork.nameEn, expiresOn: daysFromNow(200), verificationState: 'VERIFIED' }
  });
  // B: expired safety card, self-reported welding cert expiring soon.
  await prisma.employeeQualification.create({
    data: { employeeId: employeeB, definitionId: safety.id, name: safety.nameEn, expiresOn: daysFromNow(-5), verificationState: 'SELF_REPORTED' }
  });
  await prisma.employeeQualification.create({
    data: { employeeId: employeeB, definitionId: welding.id, name: welding.nameEn, expiresOn: daysFromNow(45), verificationState: 'SELF_REPORTED' }
  });
  // C: no qualifications at all (missing safety + hot work by default).

  // --- search ---
  const searchResult = await getQualificationMatrix({ search: 'Beta', qualificationCode: null, status: 'ALL', siteId: null, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 20 });
  check('search matches by last name', searchResult.items.length === 1 && searchResult.items[0].employeeId === employeeB, searchResult.items);

  const searchNumberResult = await getQualificationMatrix({ search: employeeA.slice(0, 4), qualificationCode: null, status: 'ALL', siteId: null, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 20 });
  check('search does not error on partial uuid-looking text (no employeeNumber match expected)', Array.isArray(searchNumberResult.items));

  // --- qualification filter ---
  const qualFilterResult = await getQualificationMatrix({ search: '', qualificationCode: 'EN_ISO_9606_1', status: 'ALL', siteId: null, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 20 });
  check('qualification filter narrows to only holders', qualFilterResult.items.length === 1 && qualFilterResult.items[0].employeeId === employeeB, qualFilterResult.items);

  // --- status filter ---
  const statusExpiredResult = await getQualificationMatrix({ search: '', qualificationCode: 'OCCUPATIONAL_SAFETY_CARD', status: 'EXPIRED', siteId: null, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 20 });
  check('status=EXPIRED + qualification filter finds B only', statusExpiredResult.items.length === 1 && statusExpiredResult.items[0].employeeId === employeeB, statusExpiredResult.items);

  const statusMissingResult = await getQualificationMatrix({ search: '', qualificationCode: null, status: 'MISSING', siteId: null, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 20 });
  const missingIds = statusMissingResult.items.map((r) => r.employeeId);
  check('status=MISSING (no qualification filter) finds worker missing a safety indicator', missingIds.includes(employeeB) && missingIds.includes(employeeC) && !missingIds.includes(employeeA), missingIds);

  // --- site filter ---
  const siteFilterResult = await getQualificationMatrix({ search: '', qualificationCode: null, status: 'ALL', siteId: siteX, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 20 });
  check('site filter narrows to assigned employees only', siteFilterResult.items.length === 1 && siteFilterResult.items[0].employeeId === employeeA, siteFilterResult.items);

  // --- verification filter ---
  const verifiedResult = await getQualificationMatrix({ search: '', qualificationCode: null, status: 'ALL', siteId: null, verification: 'VERIFIED', sort: 'NAME', page: 1, pageSize: 20 });
  const verifiedIds = verifiedResult.items.map((r) => r.employeeId);
  check('verification=VERIFIED finds only A (has a VERIFIED chip)', verifiedIds.includes(employeeA) && !verifiedIds.includes(employeeB), verifiedIds);

  // --- attention sort: worst-status-first ---
  const attentionResult = await getQualificationMatrix({ search: '', qualificationCode: null, status: 'ALL', siteId: null, verification: 'ALL', sort: 'ATTENTION', page: 1, pageSize: 20 });
  const attentionIds = attentionResult.items.map((r) => r.employeeId);
  const posB = attentionIds.indexOf(employeeB); // expired safety card -> worst
  const posA = attentionIds.indexOf(employeeA); // valid everything it has, but missing hot-work -> still attention-worthy
  const posC = attentionIds.indexOf(employeeC); // missing both -> worst tier too
  check('attention sort puts EXPIRED/MISSING worker(s) before a worker with only valid credentials', posB < posA && posC < posA, { attentionIds });

  // --- pagination ---
  const pageSize1 = await getQualificationMatrix({ search: '', qualificationCode: null, status: 'ALL', siteId: null, verification: 'ALL', sort: 'NAME', page: 1, pageSize: 1 });
  check('pageSize=1 returns exactly one item and correct totalPages', pageSize1.items.length === 1 && pageSize1.totalItems >= 3 && pageSize1.totalPages >= 3, pageSize1);

  // --- permission combination (§37C) ---
  const workerCanReadOwn = await hasPermission(['WORKER'], 'worker.profile.read.own');
  const workerCanReadAll = await hasPermission(['WORKER'], 'worker.profile.read.all');
  check('WORKER has profile.read.own but not .read.all (own-scope only)', workerCanReadOwn && !workerCanReadAll);

  const adminCanReadAllProfile = await hasPermission(['ADMIN'], 'worker.profile.read.all');
  const adminCanReadAllWorker = await hasPermission(['ADMIN'], 'worker.read.all');
  check('ADMIN has both permissions required by the matrix route', adminCanReadAllProfile && adminCanReadAllWorker);

  const foremanProfileAll = await hasPermission(['FOREMAN'], 'worker.profile.read.all');
  const foremanWorkerAll = await hasPermission(['FOREMAN'], 'worker.read.all');
  check('FOREMAN lacks at least one permission the matrix route requires (no matrix access)', !foremanProfileAll || !foremanWorkerAll, { foremanProfileAll, foremanWorkerAll });

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
