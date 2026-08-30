// R09.1 — /admin/users list: parseUserListQuery (lenient) + listUsers (search on username/email,
// role + status filters, paging), SYSTEM + WORKER-only accounts excluded. db lane.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseUserListQuery, listUsers } from '../lib/users';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const TAG = randomUUID().slice(0, 8);

async function mkUser(name: string, role: string, status: string, email: string | null, createdAt: Date) {
  return prisma.user.create({
    data: {
      username: `${name}_${TAG}`,
      email,
      status: status as never,
      locale: 'EN',
      userKind: 'HUMAN',
      createdAt,
      userRoles: { create: { role: { connect: { name: role } }, validFrom: new Date('2020-01-01T00:00:00Z') } }
    }
  });
}

function main() {
  parseChecks();
  dbChecks().then(async () => {
    console.log(`\nPASS: ${pass}/${pass + fail}`);
    await prisma.$disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
}

function parseChecks() {
  const d = parseUserListQuery({});
  check('parse: defaults page 1 / size 25', d.page === 1 && d.pageSize === 25 && d.q === '' && d.role === null && d.status === null);
  check('parse: bad page -> 1', parseUserListQuery({ page: 'x' }).page === 1 && parseUserListQuery({ page: '0' }).page === 1);
  check('parse: page 3', parseUserListQuery({ page: '3' }).page === 3);
  check('parse: pageSize clamp', parseUserListQuery({ pageSize: '5000' }).pageSize === 25 && parseUserListQuery({ pageSize: '50' }).pageSize === 50);
  check('parse: q trimmed + capped', parseUserListQuery({ q: `  ${'a'.repeat(500)}  ` }).q.length === 200);
  check('parse: role case-insensitive', parseUserListQuery({ role: 'admin' }).role === 'ADMIN');
  check('parse: bad role -> null', parseUserListQuery({ role: 'WORKER' }).role === null && parseUserListQuery({ role: 'nope' }).role === null);
  check('parse: status valid + case-insensitive', parseUserListQuery({ status: 'active' }).status === 'ACTIVE');
  check('parse: bad status -> null', parseUserListQuery({ status: 'PENDING' }).status === null);
}

async function dbChecks() {
  const t0 = new Date('2026-01-01T00:00:00Z');
  await mkUser('alice.foreman', 'FOREMAN', 'ACTIVE', `alice@${TAG}.test`, new Date(t0.getTime() + 5000));
  await mkUser('bob.foreman', 'FOREMAN', 'PENDING_ACTIVATION', null, new Date(t0.getTime() + 4000));
  await mkUser('carol.admin', 'ADMIN', 'ACTIVE', `carol@${TAG}.test`, new Date(t0.getTime() + 3000));
  await mkUser('dave.super', 'SUPER_ADMIN', 'ACTIVE', `dave@${TAG}.test`, new Date(t0.getTime() + 2000));
  await mkUser('eve.gone', 'FOREMAN', 'DEACTIVATED', `eve@${TAG}.test`, new Date(t0.getTime() + 1000));
  await mkUser('wanda.worker', 'WORKER', 'ACTIVE', `wanda@${TAG}.test`, new Date(t0.getTime() + 6000));

  const mine = (r: Awaited<ReturnType<typeof listUsers>>) => r.items.filter((u) => u.username.endsWith(`_${TAG}`));

  let r = await listUsers({ page: 1, pageSize: 100 });
  check('no filter: 5 system users (WORKER-only excluded)', mine(r).length === 5, mine(r).map((u) => u.username));
  check('no filter: newest first', mine(r)[0].username === `carol.admin_${TAG}` ? false : mine(r)[0].username === `alice.foreman_${TAG}`, mine(r).map((u) => u.username));

  r = await listUsers({ page: 1, pageSize: 100, q: 'alice' });
  check('q=alice -> username match, 1', mine(r).length === 1 && mine(r)[0].username === `alice.foreman_${TAG}`);
  r = await listUsers({ page: 1, pageSize: 100, q: `${TAG.toUpperCase()}.TEST` });
  check('q email substring, case-insensitive -> 4 with email', mine(r).length === 4, mine(r).map((u) => u.email));
  r = await listUsers({ page: 1, pageSize: 100, q: 'ALICE.FOREMAN' });
  check('q username case-insensitive', mine(r).length === 1);

  r = await listUsers({ page: 1, pageSize: 100, role: 'ADMIN' });
  check('role=ADMIN -> 1 (carol)', mine(r).length === 1 && mine(r)[0].username === `carol.admin_${TAG}`);
  r = await listUsers({ page: 1, pageSize: 100, role: 'FOREMAN' });
  check('role=FOREMAN -> 3', mine(r).length === 3, mine(r).map((u) => u.username));

  r = await listUsers({ page: 1, pageSize: 100, status: 'ACTIVE' });
  check('status=ACTIVE -> 3 (alice, carol, dave)', mine(r).length === 3, mine(r).map((u) => u.username));
  r = await listUsers({ page: 1, pageSize: 100, status: 'DEACTIVATED' });
  check('status=DEACTIVATED -> 1 (eve)', mine(r).length === 1 && mine(r)[0].username === `eve.gone_${TAG}`);

  r = await listUsers({ page: 1, pageSize: 100, role: 'FOREMAN', status: 'ACTIVE' });
  check('role=FOREMAN + status=ACTIVE -> 1 (alice)', mine(r).length === 1 && mine(r)[0].username === `alice.foreman_${TAG}`);

  // pagination — restrict to a q so only our 5 are in scope
  const p1 = await listUsers({ page: 1, pageSize: 2, q: TAG });
  check('pageSize=2: totalPages 3', p1.totalPages === 3 && p1.totalItems >= 5, [p1.totalPages, p1.totalItems]);
  check('pageSize=2 page 1: 2 items', p1.items.length === 2);
  const p3 = await listUsers({ page: 3, pageSize: 2, q: TAG });
  check('pageSize=2 page 3: 1 item, no overlap with page 1', p3.items.length === 1 && !p1.items.some((u) => u.id === p3.items[0].id));

  const alice = mine(await listUsers({ page: 1, pageSize: 100, q: 'alice' }))[0];
  check('item carries full active role set', Array.isArray(alice.roles) && alice.roles.includes('FOREMAN'));
}

main();
