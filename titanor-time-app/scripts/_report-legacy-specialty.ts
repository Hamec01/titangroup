// T13.3 — read-only helper for the manual, admin-assisted profession backfill.
//
// Lists every worker whose EmployeeProfile.specialty (the free-text legacy field) is non-empty,
// with their employee number, current site(s), and any professions already recorded. The admin
// then maps each specialty to a catalog or custom profession through the /admin/workers/:id/
// profile UI. This script NEVER writes anything.
//
// Run: DATABASE_URL=... npx tsx scripts/_report-legacy-specialty.ts
import { prisma } from '../lib/prisma';
import { helsinkiToday } from '../lib/workers';

async function main() {
  const today = helsinkiToday();
  const rows = await prisma.employee.findMany({
    where: { profile: { specialty: { not: null } } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      employeeNumber: true,
      firstName: true,
      lastName: true,
      profile: { select: { specialty: true } },
      professions: { select: { definition: { select: { nameEn: true } }, customName: true } },
      siteAssignments: {
        where: { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
        select: { site: { select: { name: true } } }
      }
    }
  });

  const withValue = rows.filter((r) => (r.profile?.specialty ?? '').trim().length > 0);
  console.log(`\nWorkers with a legacy free-text specialty: ${withValue.length}\n`);
  for (const r of withValue) {
    const sites = r.siteAssignments.map((a) => a.site.name).join(', ') || '(no current site)';
    const profs = r.professions.map((p) => p.definition?.nameEn ?? p.customName).filter(Boolean).join(', ') || '(none)';
    console.log(`  ${r.employeeNumber.padEnd(14)} ${(r.lastName + ' ' + r.firstName).padEnd(28)} specialty="${r.profile!.specialty}"`);
    console.log(`  ${''.padEnd(14)} ${''.padEnd(28)} site: ${sites}  |  professions: ${profs}`);
  }
  console.log('');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
