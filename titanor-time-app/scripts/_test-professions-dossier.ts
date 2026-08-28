// T13.3 (2026-08-29) — the worker dossier data now carries professions, and the dossier PDF
// renders them (a real PDF buffer with the profession names inside). Legacy specialty still
// surfaces, labelled as legacy.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getWorkerDossierData } from '../lib/worker-dossier';
import { buildWorkerDossierPdf } from '../lib/reporting/worker-dossier-pdf';
import { addEmployeeProfession } from '../lib/professions';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const actor = (await prisma.user.create({ data: { username: `tpd_${randomUUID().slice(0, 10)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } })).id;
  const emp = await prisma.employee.create({ data: { employeeNumber: `TPD-${randomUUID().slice(0, 10)}`, firstName: 'Dossier', lastName: 'Prof' } });
  await prisma.employeeProfile.create({ data: { employeeId: emp.id, specialty: 'старая специальность (текст)' } });

  const welder = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'SHIP_WELDER' } });
  await addEmployeeProfession({ employeeId: emp.id, definitionId: welder.id, actorUserId: actor, requestId: randomUUID() });
  await addEmployeeProfession({ employeeId: emp.id, customName: 'Rope access technician', customCategory: 'SHIPBUILDING', actorUserId: actor, requestId: randomUUID() });

  const data = await getWorkerDossierData(emp.id);
  check('dossier data returned', !!data);
  check('dossier carries 2 professions', data!.professions.length === 2, data!.professions.map((p) => p.nameEn));
  check('  catalog profession has nameRu', data!.professions.some((p) => !p.isCustom && !!p.nameRu));
  check('  custom profession present', data!.professions.some((p) => p.isCustom && p.nameEn === 'Rope access technician'));
  check('  legacy specialty still surfaced', data!.specialty === 'старая специальность (текст)');

  const pdfEn = await buildWorkerDossierPdf(data!, 'EN', '01/01/2026, 12:00');
  check('EN dossier PDF builds (%PDF header)', pdfEn.length > 800 && pdfEn.subarray(0, 4).toString() === '%PDF');
  const pdfRu = await buildWorkerDossierPdf(data!, 'RU', '01.01.2026, 12:00');
  check('RU dossier PDF builds', pdfRu.length > 800 && pdfRu.subarray(0, 4).toString() === '%PDF');

  // no-professions worker still builds fine
  const emp2 = await prisma.employee.create({ data: { employeeNumber: `TPD-${randomUUID().slice(0, 10)}`, firstName: 'Empty', lastName: 'Prof' } });
  const data2 = await getWorkerDossierData(emp2.id);
  check('worker with no professions: empty array', data2!.professions.length === 0);
  const pdf2 = await buildWorkerDossierPdf(data2!, 'RU', '01.01.2026, 12:00');
  check('  dossier PDF still builds with no professions', pdf2.subarray(0, 4).toString() === '%PDF');

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
