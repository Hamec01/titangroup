// /admin/workers search backend: case-insensitive partial name matching, multi-token full-name
// matching, employee number/login matching, empty-query reset, and archive scoping.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { listWorkers } from '../lib/workers';

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) pass++;
  else { fail++; console.log('FAIL:', name, extra ?? ''); }
};

async function worker(employeeNumber: string, firstName: string, lastName: string, username: string, active = true) {
  const employee = await prisma.employee.create({ data: { employeeNumber, firstName, lastName } });
  await prisma.employment.create({
    data: {
      employeeId: employee.id,
      active,
      startDate: new Date('2026-01-01'),
      ...(active ? {} : { endDate: new Date('2026-09-30'), deactivationReason: 'test archive' })
    }
  });
  await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', employeeId: employee.id } });
  return employee;
}

async function main() {
  const oleh = await worker('1041', 'Oleh', 'Moroz', 'morozo');
  const oleksandr = await worker('1042', 'Oleksandr', 'Bondar', 'bondaro');
  await worker('1043', 'Anna', 'Smith', 'smitha');
  const archived = await worker('1044', 'Archived', 'Worker', 'archivew', false);

  const partial = await listWorkers(1, 100, { q: 'o' });
  check('one letter searches all active workers, not one page', partial.totalItems === 2 && partial.items.some((w) => w.id === oleh.id) && partial.items.some((w) => w.id === oleksandr.id), partial.items);

  const caseInsensitive = await listWorkers(1, 100, { q: 'OLEKSANDR' });
  check('name search is case-insensitive', caseInsensitive.totalItems === 1 && caseInsensitive.items[0]?.id === oleksandr.id, caseInsensitive.items);

  const fullName = await listWorkers(1, 100, { q: 'Oleksandr Bondar' });
  check('whitespace-tokenized full name matches across fields', fullName.totalItems === 1 && fullName.items[0]?.id === oleksandr.id, fullName.items);

  const number = await listWorkers(1, 100, { q: '1042' });
  check('employee number is searchable', number.totalItems === 1 && number.items[0]?.id === oleksandr.id, number.items);

  const login = await listWorkers(1, 100, { q: 'bondaro' });
  check('login is searchable', login.totalItems === 1 && login.items[0]?.id === oleksandr.id, login.items);

  const cleared = await listWorkers(1, 100, { q: '' });
  check('clearing search restores every active worker', cleared.totalItems === 3, cleared.totalItems);

  const archivedHidden = await listWorkers(1, 100, { q: 'Archived' });
  const archivedShown = await listWorkers(1, 100, { q: 'Archived', includeArchived: true });
  check('archive scope remains respected by search', archivedHidden.totalItems === 0 && archivedShown.totalItems === 1 && archivedShown.items[0]?.id === archived.id, { archivedHidden, archivedShown });

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); }).finally(() => prisma.$disconnect());
