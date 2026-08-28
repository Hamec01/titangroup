// T13.2 (2026-08-29) — profession services: add (catalog / custom), remove, catalog listing,
// per-worker listing, name normalization, ALREADY_ADDED on a duplicate, and an audit scan that
// EMPLOYEE_PROFESSION_ADDED/REMOVED carry no henkilötunnus / address / secrets.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { addEmployeeProfession, removeEmployeeProfession, listProfessionCatalog, listEmployeeProfessions, normalizeProfessionName } from '../lib/professions';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

async function makeAdmin(): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const u = await prisma.user.create({ data: { username: `tpa_${randomUUID().slice(0, 10)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return u.id;
}
async function makeEmployee(): Promise<string> {
  const e = await prisma.employee.create({ data: { employeeNumber: `TPA-${randomUUID().slice(0, 10)}`, firstName: 'Api', lastName: 'Prof' } });
  return e.id;
}

async function main() {
  const actor = await makeAdmin();

  // 1. normalizeProfessionName
  check('normalize lowercases + trims + collapses whitespace', normalizeProfessionName('  Welder   Helper ') === 'welder helper');

  // 2. listProfessionCatalog — grouped, both categories, sorted
  {
    const groups = await listProfessionCatalog();
    check('catalog has both category groups', groups.length === 2, groups.map((g) => g.category));
    const ship = groups.find((g) => g.category === 'SHIPBUILDING');
    check('SHIPBUILDING group non-empty', !!ship && ship.professions.length > 0);
    check('every catalog entry has code + nameEn + nameRu', groups.every((g) => g.professions.every((p) => p.code && p.nameEn && p.nameRu)));
    // sorted by the seed's sortOrder — SHIP_WELDER (10) before SHIP_PIPE_FITTER (40)
    const codes = ship!.professions.map((p) => p.code);
    check('  group is sorted (SHIP_WELDER before SHIP_PIPE_FITTER)', codes.indexOf('SHIP_WELDER') < codes.indexOf('SHIP_PIPE_FITTER'), codes.slice(0, 5));
  }

  const welder = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'SHIP_WELDER' } });
  const fitter = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'SHIP_PIPE_FITTER' } });

  // 3. add catalog profession
  const emp = await makeEmployee();
  {
    const r = await addEmployeeProfession({ employeeId: emp, definitionId: welder.id, actorUserId: actor, requestId: randomUUID() });
    check('add catalog profession ok', r.ok === true && !!(r as { id: string }).id, r);
  }

  // 4. add custom profession
  {
    const r = await addEmployeeProfession({ employeeId: emp, customName: '  Rope Access  Technician ', customCategory: 'SHIPBUILDING', actorUserId: actor, requestId: randomUUID() });
    check('add custom profession ok', r.ok === true, r);
  }

  // 5. listEmployeeProfessions returns both, newest first, custom marked
  {
    const items = await listEmployeeProfessions(emp);
    check('worker has 2 professions', items.length === 2, items.length);
    const custom = items.find((i) => i.isCustom);
    check('custom entry: trimmed + whitespace-collapsed name, null nameRu, no code', !!custom && custom.nameEn === 'Rope Access Technician' && custom.nameRu === null && custom.code === null, custom);
    const cat = items.find((i) => !i.isCustom);
    check('catalog entry carries code + category + nameRu', !!cat && cat.code === 'SHIP_WELDER' && cat.category === 'SHIPBUILDING' && !!cat.nameRu, cat);
  }

  // 6. duplicate catalog -> ALREADY_ADDED
  {
    const r = await addEmployeeProfession({ employeeId: emp, definitionId: welder.id, actorUserId: actor, requestId: randomUUID() });
    check('duplicate catalog profession -> ALREADY_ADDED', r.ok === false && (r as { code: string }).code === 'ALREADY_ADDED', r);
  }

  // 7. duplicate custom differing only in case/whitespace -> ALREADY_ADDED
  {
    const r = await addEmployeeProfession({ employeeId: emp, customName: 'rope access technician', customCategory: 'SHIPBUILDING', actorUserId: actor, requestId: randomUUID() });
    check('duplicate custom (case/whitespace) -> ALREADY_ADDED', r.ok === false && (r as { code: string }).code === 'ALREADY_ADDED', r);
  }

  // 8. unknown / inactive definition
  {
    const r = await addEmployeeProfession({ employeeId: emp, definitionId: randomUUID(), actorUserId: actor, requestId: randomUUID() });
    check('unknown definitionId -> DEFINITION_NOT_FOUND', r.ok === false && (r as { code: string }).code === 'DEFINITION_NOT_FOUND', r);
    // deactivate a def then try to add it
    const tmp = await prisma.professionDefinition.create({ data: { code: `TMP_${randomUUID().slice(0, 8)}`, category: 'CONSTRUCTION', nameEn: 'tmp', nameRu: 'tmp', isActive: false } });
    const r2 = await addEmployeeProfession({ employeeId: emp, definitionId: tmp.id, actorUserId: actor, requestId: randomUUID() });
    check('inactive definition -> DEFINITION_NOT_FOUND', r2.ok === false && (r2 as { code: string }).code === 'DEFINITION_NOT_FOUND', r2);
    await prisma.professionDefinition.delete({ where: { id: tmp.id } }); // keep the disposable DB catalog clean for sibling tests
  }

  // 9. validation — empty custom name, bad category
  {
    const r = await addEmployeeProfession({ employeeId: emp, customName: '   ', customCategory: 'SHIPBUILDING', actorUserId: actor, requestId: randomUUID() });
    check('empty custom name -> VALIDATION_ERROR', r.ok === false && (r as { code: string }).code === 'VALIDATION_ERROR', r);
  }

  // 10. employee not found
  {
    const r = await addEmployeeProfession({ employeeId: randomUUID(), definitionId: fitter.id, actorUserId: actor, requestId: randomUUID() });
    check('unknown employee -> EMPLOYEE_NOT_FOUND', r.ok === false && (r as { code: string }).code === 'EMPLOYEE_NOT_FOUND', r);
  }

  // 11. remove — ownership enforced
  {
    const items = await listEmployeeProfessions(emp);
    const other = await makeEmployee();
    const wrong = await removeEmployeeProfession({ employeeProfessionId: items[0].id, employeeId: other, actorUserId: actor, requestId: randomUUID() });
    check('remove with wrong employeeId -> NOT_FOUND (ownership)', wrong.ok === false, wrong);
    const ok = await removeEmployeeProfession({ employeeProfessionId: items[0].id, employeeId: emp, actorUserId: actor, requestId: randomUUID() });
    check('remove with correct owner ok', ok.ok === true, ok);
    const left = await listEmployeeProfessions(emp);
    check('  one profession left', left.length === 1, left.length);
  }

  // 12. audit scan — no PII in EMPLOYEE_PROFESSION_* events
  {
    const events = await prisma.auditEvent.findMany({ where: { eventType: { in: ['EMPLOYEE_PROFESSION_ADDED', 'EMPLOYEE_PROFESSION_REMOVED'] } }, select: { eventType: true, entityType: true, beforeValue: true, afterValue: true } });
    check('audit events were written', events.length >= 3, events.length);
    check('  entityType is EMPLOYEE_PROFESSION', events.every((e) => e.entityType === 'EMPLOYEE_PROFESSION'));
    const blob = JSON.stringify(events);
    check('  no henkilötunnus / address / secret-shaped keys', !/personalIdentity|henkilotunnus|addressStreet|passwordHash|secret|token/i.test(blob), blob.slice(0, 200));
    // profession code / category ARE allowed
    check('  profession code recorded', /SHIP_WELDER|professionCode|customNameNormalized/.test(blob));
  }

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
