// R06-A — schema-aware GET /api/ready + lib/schema-readiness. Direct-route-handler style, needs a
// disposable PostgreSQL 16 (the runner gives each test its own migrated clone). Mutates
// _prisma_migrations / renames tables to simulate incompatible schemas — safe only on a throwaway DB.
import { prisma } from '../lib/prisma';
import { checkSchemaReadiness, KEY_TABLES } from '../lib/schema-readiness';
import { MIGRATION_INVENTORY, MIGRATION_INVENTORY_COUNT } from '../lib/generated/migration-inventory';
import { GET as readyRoute } from '../app/api/ready/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); }
};

async function ready(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await readyRoute();
  return { status: res.status, body: await res.json() };
}

// The full set of keys /api/ready may ever return — nothing else (no stack, no url, no sql).
const ALLOWED_KEYS = new Set([
  'status', 'service', 'database', 'schema', 'reason', 'migrations',
  'missingMigrations', 'failedMigrations', 'missingTables'
]);

function assertSanitized(name: string, body: Record<string, unknown>) {
  const blob = JSON.stringify(body);
  check(`${name}: only allowed top-level keys`, Object.keys(body).every((k) => ALLOWED_KEYS.has(k)), Object.keys(body));
  check(`${name}: no error/stack/sql/connection string in body`,
    !/stack|postgres(ql)?:\/\/|SELECT |password|127\.0\.0\.1:\d|PrismaClient/i.test(blob), blob.slice(0, 200));
}

async function main() {
  // 1. current schema (fresh migrated clone)
  const r1 = await checkSchemaReadiness();
  check('1: fresh clone -> ok, state current', r1.ok && r1.state === 'current' && r1.appliedCount === MIGRATION_INVENTORY_COUNT, r1);
  const h1 = await ready();
  check('1: GET /api/ready -> 200 ready', h1.status === 200 && h1.body.status === 'ready' && h1.body.schema === 'current', h1.body);
  assertSanitized('1', h1.body);

  // 2. DB ahead — an extra applied migration the build does not know about
  await prisma.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
     VALUES (gen_random_uuid()::text, 'x', '29990101000000_future_migration', now(), now(), 1)`
  );
  const r2 = await checkSchemaReadiness();
  check('2: DB ahead -> ok, state ahead, aheadBy 1', r2.ok && r2.state === 'ahead' && r2.aheadBy === 1, r2);
  const h2 = await ready();
  check('2: GET /api/ready -> still 200 (additive-forward-compatible)', h2.status === 200 && h2.body.schema === 'ahead', h2.body);
  await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '29990101000000_future_migration'`);

  // 3. schema behind — one expected migration missing from the DB
  const dropName = MIGRATION_INVENTORY[MIGRATION_INVENTORY.length - 1];
  await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${dropName}'`);
  const r3 = await checkSchemaReadiness();
  check('3: schema behind -> not ok, reason SCHEMA_BEHIND', !r3.ok && r3.reason === 'SCHEMA_BEHIND' && (r3.missingMigrations?.includes(dropName) ?? false), r3);
  const h3 = await ready();
  check('3: GET /api/ready -> 503, missingMigrations listed', h3.status === 503 && h3.body.status === 'not_ready' && h3.body.reason === 'SCHEMA_BEHIND', h3.body);
  check('3: 503 body names the missing migration', Array.isArray(h3.body.missingMigrations) && (h3.body.missingMigrations as string[]).includes(dropName));
  assertSanitized('3', h3.body);
  // restore
  await prisma.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
     VALUES (gen_random_uuid()::text, 'x', '${dropName}', now(), now(), 1)`
  );

  // 4. migration failed — an unfinished / rolled-back row
  await prisma.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = '${dropName}'`);
  const r4 = await checkSchemaReadiness();
  check('4: unfinished migration -> not ok, reason MIGRATIONS_FAILED', !r4.ok && r4.reason === 'MIGRATIONS_FAILED' && (r4.failedMigrations?.includes(dropName) ?? false), r4);
  const h4 = await ready();
  check('4: GET /api/ready -> 503 MIGRATIONS_FAILED', h4.status === 503 && h4.body.reason === 'MIGRATIONS_FAILED', h4.body);
  assertSanitized('4', h4.body);
  await prisma.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET finished_at = now() WHERE migration_name = '${dropName}'`);

  // 5. key table missing — rename one out of the way (AuditEvent: nothing FK-references it)
  const table = KEY_TABLES.includes('AuditEvent') ? 'AuditEvent' : KEY_TABLES[KEY_TABLES.length - 1];
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME TO "${table}__r06a_test"`);
  const r5 = await checkSchemaReadiness();
  check('5: key table missing -> not ok, reason KEY_TABLE_MISSING', !r5.ok && r5.reason === 'KEY_TABLE_MISSING' && (r5.missingTables?.includes(table) ?? false), r5);
  const h5 = await ready();
  check('5: GET /api/ready -> 503 KEY_TABLE_MISSING, names the table', h5.status === 503 && h5.body.reason === 'KEY_TABLE_MISSING' && (h5.body.missingTables as string[]).includes(table), h5.body);
  assertSanitized('5', h5.body);
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}__r06a_test" RENAME TO "${table}"`);

  // 6. _prisma_migrations table itself missing -> MIGRATIONS_TABLE_MISSING (not a Titanor Time DB)
  await prisma.$executeRawUnsafe(`ALTER TABLE "_prisma_migrations" RENAME TO "_prisma_migrations__r06a_test"`);
  const r6 = await checkSchemaReadiness();
  check('6: _prisma_migrations gone -> not ok, reason MIGRATIONS_TABLE_MISSING', !r6.ok && r6.reason === 'MIGRATIONS_TABLE_MISSING', r6);
  const h6 = await ready();
  check('6: GET /api/ready -> 503 MIGRATIONS_TABLE_MISSING', h6.status === 503 && h6.body.reason === 'MIGRATIONS_TABLE_MISSING', h6.body);
  assertSanitized('6', h6.body);
  await prisma.$executeRawUnsafe(`ALTER TABLE "_prisma_migrations__r06a_test" RENAME TO "_prisma_migrations"`);

  // 7. back to healthy after every restore
  const r7 = await checkSchemaReadiness();
  check('7: fully restored -> ok again', r7.ok && r7.state === 'current', r7);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
