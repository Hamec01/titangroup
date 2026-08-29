// T13.5 / T13.6 (2026-08-29) — the workforce matrix: profession category / profession filters,
// active/current-site semantics, profession/number/site sorts, and the export scope
// (resolveWorkforceScope — whole filtered set, hard row cap).
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getQualificationMatrix, resolveWorkforceScope, MAX_WORKFORCE_EXPORT_ROWS } from '../lib/qualification-matrix';
import { addEmployeeProfession } from '../lib/professions';
import { buildWorkforceCsv } from '../lib/reporting/workforce-export-csv';
import { buildWorkforcePdf } from '../lib/reporting/workforce-export-pdf';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

const TAG = `WFM-${randomUUID().slice(0, 6)}`;
const D2020 = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const actor = (await prisma.user.create({ data: { username: `wfm_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } })).id;

  const welder = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'SHIP_WELDER' } });
  const carpenter = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'CON_CARPENTER' } });

  const site = await prisma.workSite.create({ data: { name: `${TAG} Yard` } });

  // A — active welder (shipbuilding), on site
  const a = await prisma.employee.create({ data: { employeeNumber: `${TAG}-A`, firstName: 'Anton', lastName: 'Aaa' } });
  await prisma.employment.create({ data: { employeeId: a.id, active: true, startDate: D2020, endDate: null } });
  await prisma.siteAssignment.create({ data: { employeeId: a.id, siteId: site.id, isPrimary: true, validFrom: D2020, validTo: null, assignedByUserId: actor } });
  await addEmployeeProfession({ employeeId: a.id, definitionId: welder.id, actorUserId: actor, requestId: randomUUID() });

  // B — active carpenter (construction), no site
  const b = await prisma.employee.create({ data: { employeeNumber: `${TAG}-B`, firstName: 'Boris', lastName: 'Bbb' } });
  await prisma.employment.create({ data: { employeeId: b.id, active: true, startDate: D2020, endDate: null } });
  await addEmployeeProfession({ employeeId: b.id, definitionId: carpenter.id, actorUserId: actor, requestId: randomUUID() });

  // C — INACTIVE welder (employment ended in the past)
  const c = await prisma.employee.create({ data: { employeeNumber: `${TAG}-C`, firstName: 'Clara', lastName: 'Ccc' } });
  await prisma.employment.create({ data: { employeeId: c.id, active: true, startDate: D2020, endDate: new Date('2021-01-01T00:00:00.000Z') } });
  await addEmployeeProfession({ employeeId: c.id, definitionId: welder.id, actorUserId: actor, requestId: randomUUID() });

  // D — active, custom profession "Rope tech" (shipbuilding), no catalog profession
  const d = await prisma.employee.create({ data: { employeeNumber: `${TAG}-D`, firstName: 'Dana', lastName: 'Ddd' } });
  await prisma.employment.create({ data: { employeeId: d.id, active: true, startDate: D2020, endDate: FUTURE } });
  await addEmployeeProfession({ employeeId: d.id, customName: 'Rope tech', customCategory: 'SHIPBUILDING', actorUserId: actor, requestId: randomUUID() });

  const base = { search: TAG, qualificationCode: null, status: 'ALL' as const, siteId: null, verification: 'ALL' as const, sort: 'NAME' as const, page: 1, pageSize: 50 };

  // 1. no filter — all 4
  {
    const r = await getQualificationMatrix({ ...base });
    check('search tag returns all 4 fixtures', r.items.length === 4, r.items.map((x) => x.employeeNumber));
    const rowA = r.items.find((x) => x.employeeNumber === `${TAG}-A`)!;
    check('  row A: active, welder profession, on site', rowA.active && rowA.professions.some((p) => p.code === 'SHIP_WELDER') && rowA.currentSites.some((s) => s.name === `${TAG} Yard`), rowA);
    const rowC = r.items.find((x) => x.employeeNumber === `${TAG}-C`)!;
    check('  row C: inactive (employment ended)', rowC.active === false, rowC.active);
    const rowD = r.items.find((x) => x.employeeNumber === `${TAG}-D`)!;
    check('  row D: custom profession, isCustom true, category SHIPBUILDING', rowD.professions[0]?.isCustom === true && rowD.professions[0]?.category === 'SHIPBUILDING', rowD.professions);
  }

  // 2. professionCode filter — welder -> A and C only
  {
    const r = await getQualificationMatrix({ ...base, professionCode: 'SHIP_WELDER' });
    const ids = r.items.map((x) => x.employeeNumber).sort();
    check('professionCode=SHIP_WELDER -> A, C', ids.join(',') === `${TAG}-A,${TAG}-C`, ids);
  }

  // 3. professionCategory filter — SHIPBUILDING -> A, C, D (D via customCategory)
  {
    const r = await getQualificationMatrix({ ...base, professionCategory: 'SHIPBUILDING' });
    const ids = r.items.map((x) => x.employeeNumber).sort();
    check('professionCategory=SHIPBUILDING -> A, C, D (D via customCategory)', ids.join(',') === `${TAG}-A,${TAG}-C,${TAG}-D`, ids);
  }

  // 4. active filter
  {
    const act = await getQualificationMatrix({ ...base, active: 'ACTIVE' });
    check('active=ACTIVE excludes C', !act.items.some((x) => x.employeeNumber === `${TAG}-C`) && act.items.length === 3, act.items.map((x) => x.employeeNumber));
    const inact = await getQualificationMatrix({ ...base, active: 'INACTIVE' });
    check('active=INACTIVE -> only C', inact.items.length === 1 && inact.items[0].employeeNumber === `${TAG}-C`, inact.items.map((x) => x.employeeNumber));
  }

  // 5. intersection: SHIPBUILDING + ACTIVE -> A, D
  {
    const r = await getQualificationMatrix({ ...base, professionCategory: 'SHIPBUILDING', active: 'ACTIVE' });
    const ids = r.items.map((x) => x.employeeNumber).sort();
    check('SHIPBUILDING + ACTIVE -> A, D', ids.join(',') === `${TAG}-A,${TAG}-D`, ids);
  }

  // 6. sort by profession / number / site
  {
    const byProf = await getQualificationMatrix({ ...base, sort: 'PROFESSION' });
    // Carpenter (B) < Rope tech (D) < Welder (A) ; C also welder. alphabetical by nameEn.
    check('sort=PROFESSION alphabetises by first profession name', byProf.items[0].employeeNumber === `${TAG}-B`, byProf.items.map((x) => x.employeeNumber));
    const byNum = await getQualificationMatrix({ ...base, sort: 'NUMBER' });
    check('sort=NUMBER -> A,B,C,D', byNum.items.map((x) => x.employeeNumber).join(',') === `${TAG}-A,${TAG}-B,${TAG}-C,${TAG}-D`, byNum.items.map((x) => x.employeeNumber));
    const bySite = await getQualificationMatrix({ ...base, sort: 'CURRENT_SITE' });
    check('sort=CURRENT_SITE puts the on-site worker first', bySite.items[0].employeeNumber === `${TAG}-A`, bySite.items.map((x) => x.employeeNumber));
  }

  // 7. resolveWorkforceScope — whole set, no pagination
  {
    const scope = await resolveWorkforceScope({ ...base });
    check('resolveWorkforceScope ok, returns all 4', scope.ok === true && (scope as { rows: unknown[] }).rows.length === 4, scope);
    // CSV + PDF smoke
    if (scope.ok) {
      const csv = buildWorkforceCsv(scope.rows, 'EN');
      check('CSV has BOM + a data row per worker, no UUID', csv.subarray(0, 3).toString('hex') === 'efbbbf' && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(csv.toString()), csv.toString().slice(0, 80));
      check('  CSV mentions the professions and NOT date of birth / address', /Welder|Carpenter|Rope tech/.test(csv.toString()) && !/dateOfBirth|addressStreet/.test(csv.toString()));
      const pdf = await buildWorkforcePdf(scope.rows, { generatedAtHelsinki: '01/01/2026, 12:00', filterSummary: 'test' }, 'EN');
      check('PDF builds (%PDF header)', pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 800);
    }
  }

  check('MAX_WORKFORCE_EXPORT_ROWS is a sane cap', MAX_WORKFORCE_EXPORT_ROWS >= 500 && MAX_WORKFORCE_EXPORT_ROWS <= 10000);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
