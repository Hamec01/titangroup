// T13.1 (2026-08-29) — Profession schema: catalog seed, the catalog-XOR-custom CHECK, and the two
// partial unique indexes that stop a worker getting the same profession twice (catalog id, or a
// custom name differing only in case / whitespace). Also the FK delete rules.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

function isCheckViolation(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('23514') || m.includes('ck_employee_profession_catalog_xor_custom');
}
function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return true;
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('23505') || m.includes('ux_employee_profession_');
}
function isFkRestrict(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2003' || e.code === 'P2014')) return true;
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('23503') || m.includes('P2003') || m.includes('foreign key');
}

async function makeUser(): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const u = await prisma.user.create({ data: { username: `tp_${randomUUID().slice(0, 10)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return u.id;
}
async function makeEmployee(): Promise<string> {
  const e = await prisma.employee.create({ data: { employeeNumber: `TP-${randomUUID().slice(0, 10)}`, firstName: 'Test', lastName: 'Prof' } });
  return e.id;
}

async function main() {
  const actor = await makeUser();

  // 1. Catalog seed
  {
    const total = await prisma.professionDefinition.count();
    check('catalog seeded (>= 40 entries)', total >= 40, total);
    const ship = await prisma.professionDefinition.count({ where: { category: 'SHIPBUILDING' } });
    const con = await prisma.professionDefinition.count({ where: { category: 'CONSTRUCTION' } });
    check('both categories populated', ship > 0 && con > 0, { ship, con });
    const shipWelder = await prisma.professionDefinition.findUnique({ where: { code: 'SHIP_WELDER' } });
    const conWelder = await prisma.professionDefinition.findUnique({ where: { code: 'CON_WELDER' } });
    check('SHIP_WELDER and CON_WELDER are distinct catalog entries', !!shipWelder && !!conWelder && shipWelder!.id !== conWelder!.id, { shipWelder: shipWelder?.id, conWelder: conWelder?.id });
    check('  same display name, different category', shipWelder?.nameEn === conWelder?.nameEn && shipWelder?.category !== conWelder?.category);
    check('  RU name present', !!shipWelder?.nameRu && shipWelder!.nameRu.length > 0);
    const seedCount = await prisma.professionDefinition.count({ where: { OR: [{ code: { startsWith: 'SHIP_' } }, { code: { startsWith: 'CON_' } }] } });
    check('>= 40 seed codes carry a SHIP_/CON_ prefix', seedCount >= 40, seedCount);
    const codes = (await prisma.professionDefinition.findMany({ select: { code: true } })).map((c) => c.code);
    check('all codes unique', new Set(codes).size === codes.length);
  }

  const welderDef = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'SHIP_WELDER' } });
  const fitterDef = await prisma.professionDefinition.findUniqueOrThrow({ where: { code: 'SHIP_PIPE_FITTER' } });

  // 2. CHECK — valid catalog row
  {
    const emp = await makeEmployee();
    const row = await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: welderDef.id, createdByUserId: actor } });
    check('valid catalog EmployeeProfession inserts', !!row.id);
  }

  // 3. CHECK — valid custom row
  {
    const emp = await makeEmployee();
    const row = await prisma.employeeProfession.create({
      data: { employeeId: emp, customName: 'Rope access technician', customNameNormalized: 'rope access technician', customCategory: 'SHIPBUILDING', createdByUserId: actor }
    });
    check('valid custom EmployeeProfession inserts', !!row.id);
  }

  // 4-7. CHECK — invalid combinations rejected
  {
    const emp = await makeEmployee();
    const cases: { name: string; data: Prisma.EmployeeProfessionUncheckedCreateInput }[] = [
      { name: 'definitionId + customName both set -> rejected', data: { employeeId: emp, definitionId: welderDef.id, customName: 'x', customNameNormalized: 'x', customCategory: 'SHIPBUILDING', createdByUserId: actor } },
      { name: 'neither definitionId nor custom set -> rejected', data: { employeeId: emp, createdByUserId: actor } },
      { name: 'definitionId + customCategory set -> rejected', data: { employeeId: emp, definitionId: welderDef.id, customCategory: 'SHIPBUILDING', createdByUserId: actor } },
      { name: 'customName set but customNameNormalized null -> rejected', data: { employeeId: emp, customName: 'Foo', customCategory: 'SHIPBUILDING', createdByUserId: actor } }
    ];
    for (const c of cases) {
      let threw = false;
      try {
        await prisma.employeeProfession.create({ data: c.data });
      } catch (e) {
        threw = isCheckViolation(e);
      }
      check(c.name, threw);
    }
  }

  // 8. ux_catalog — same (employeeId, definitionId) twice
  {
    const emp = await makeEmployee();
    await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: welderDef.id, createdByUserId: actor } });
    let threw = false;
    try {
      await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: welderDef.id, createdByUserId: actor } });
    } catch (e) {
      threw = isUniqueViolation(e);
    }
    check('same catalog profession cannot be added to one worker twice', threw);
  }

  // 9. ux_custom — same normalized custom name twice (simulating case/whitespace differences)
  {
    const emp = await makeEmployee();
    await prisma.employeeProfession.create({ data: { employeeId: emp, customName: 'Welder helper', customNameNormalized: 'welder helper', customCategory: 'CONSTRUCTION', createdByUserId: actor } });
    let threw = false;
    try {
      await prisma.employeeProfession.create({ data: { employeeId: emp, customName: '  WELDER   HELPER ', customNameNormalized: 'welder helper', customCategory: 'CONSTRUCTION', createdByUserId: actor } });
    } catch (e) {
      threw = isUniqueViolation(e);
    }
    check('custom profession differing only in case/whitespace rejected', threw);
  }

  // 10. Several different professions on one worker — allowed
  {
    const emp = await makeEmployee();
    await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: welderDef.id, createdByUserId: actor } });
    await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: fitterDef.id, createdByUserId: actor } });
    await prisma.employeeProfession.create({ data: { employeeId: emp, customName: 'Confined space attendant', customNameNormalized: 'confined space attendant', customCategory: 'SHIPBUILDING', createdByUserId: actor } });
    const n = await prisma.employeeProfession.count({ where: { employeeId: emp } });
    check('one worker can hold several distinct professions', n === 3, n);
  }

  // 11. Same catalog profession on TWO different workers — allowed
  {
    const a = await makeEmployee();
    const b = await makeEmployee();
    await prisma.employeeProfession.create({ data: { employeeId: a, definitionId: fitterDef.id, createdByUserId: actor } });
    const row = await prisma.employeeProfession.create({ data: { employeeId: b, definitionId: fitterDef.id, createdByUserId: actor } });
    check('same catalog profession on two workers is fine', !!row.id);
  }

  // 12. onDelete Restrict — a catalog entry in use cannot be deleted
  {
    let threw = false;
    try {
      await prisma.professionDefinition.delete({ where: { id: welderDef.id } });
    } catch (e) {
      threw = isFkRestrict(e);
    }
    check('ProfessionDefinition in use cannot be deleted (Restrict)', threw);
  }

  // 13. onDelete Cascade — deleting a bare Employee removes its professions
  {
    const emp = await makeEmployee();
    await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: welderDef.id, createdByUserId: actor } });
    await prisma.employee.delete({ where: { id: emp } });
    const left = await prisma.employeeProfession.count({ where: { employeeId: emp } });
    check('deleting an Employee cascade-deletes EmployeeProfession', left === 0, left);
  }

  // 14. createdBy Restrict — the acting user cannot be deleted while they own a profession row
  {
    const u = await makeUser();
    const emp = await makeEmployee();
    await prisma.employeeProfession.create({ data: { employeeId: emp, definitionId: fitterDef.id, createdByUserId: u } });
    let threw = false;
    try {
      await prisma.user.delete({ where: { id: u } });
    } catch (e) {
      threw = isFkRestrict(e);
    }
    check('createdByUser cannot be deleted while owning a profession row (Restrict)', threw);
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
