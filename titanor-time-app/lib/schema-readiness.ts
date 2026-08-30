import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { MIGRATION_INVENTORY, MIGRATION_INVENTORY_COUNT } from '@/lib/generated/migration-inventory';

// R06-A — the one place that decides whether the database this build is talking to is a schema it
// can actually run against. Used by GET /api/ready and by the scheduler's startup/tick error
// classification. Everything it returns is safe to expose: fixed reason codes, migration directory
// names (already public in the repo), table names, and counts. It NEVER surfaces the caught error,
// SQL text, connection strings, credentials, or any row data.

const INVENTORY_SET: ReadonlySet<string> = new Set(MIGRATION_INVENTORY);

// A minimal set of tables the app cannot function without. Not the full schema — just enough to
// catch "connected to an empty / wrong / half-restored database" that somehow still has a
// plausible _prisma_migrations.
export const KEY_TABLES: readonly string[] = [
  'User',
  'UserSession',
  'Employee',
  'WorkSite',
  'SiteAssignment',
  'PayrollPeriod',
  'Timesheet',
  'TimesheetVersion',
  'ClockEvent',
  'ClockShift',
  'AttendanceException',
  'AuditEvent',
  'CompanyAttendancePolicy'
];

export type SchemaReadiness =
  | {
      ok: true;
      /** `current` = applied set == inventory; `ahead` = DB has extra applied migrations (forward-
       *  compatible additive migrations, e.g. mid-rollout migrate-then-swap). */
      state: 'current' | 'ahead';
      appliedCount: number;
      expectedCount: number;
      aheadBy: number;
    }
  | {
      ok: false;
      reason: 'DB_UNAVAILABLE' | 'MIGRATIONS_TABLE_MISSING' | 'MIGRATIONS_FAILED' | 'SCHEMA_BEHIND' | 'KEY_TABLE_MISSING';
      appliedCount: number;
      expectedCount: number;
      /** Names of expected migrations not yet fully applied (SCHEMA_BEHIND). */
      missingMigrations?: string[];
      /** Names of migrations recorded as unfinished or rolled back (MIGRATIONS_FAILED). */
      failedMigrations?: string[];
      /** Key tables that are absent (KEY_TABLE_MISSING). */
      missingTables?: string[];
    };

function isConnectionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P1000 auth, P1001 unreachable, P1002 timeout, P1008 op timeout, P1017 connection closed.
    return ['P1000', 'P1001', 'P1002', 'P1008', 'P1017'].includes(error.code);
  }
  return false;
}

export async function checkSchemaReadiness(): Promise<SchemaReadiness> {
  const expectedCount = MIGRATION_INVENTORY_COUNT;

  // 1. Can we reach the database at all?
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE', appliedCount: 0, expectedCount };
  }

  // 2. Migration state.
  let rows: { migration_name: string; finished: boolean; rolled_back: boolean }[];
  try {
    rows = await prisma.$queryRaw<{ migration_name: string; finished: boolean; rolled_back: boolean }[]>`
      SELECT migration_name,
             finished_at IS NOT NULL   AS finished,
             rolled_back_at IS NOT NULL AS rolled_back
      FROM _prisma_migrations`;
  } catch (error) {
    if (isConnectionError(error)) {
      return { ok: false, reason: 'DB_UNAVAILABLE', appliedCount: 0, expectedCount };
    }
    // The table itself is absent — this is not a migrated Titanor Time database.
    return { ok: false, reason: 'MIGRATIONS_TABLE_MISSING', appliedCount: 0, expectedCount };
  }

  const failedMigrations = rows.filter((r) => r.rolled_back || !r.finished).map((r) => r.migration_name).sort();
  if (failedMigrations.length > 0) {
    const appliedCount = rows.filter((r) => r.finished && !r.rolled_back).length;
    return { ok: false, reason: 'MIGRATIONS_FAILED', appliedCount, expectedCount, failedMigrations };
  }

  const applied = new Set(rows.filter((r) => r.finished).map((r) => r.migration_name));
  const missingMigrations = MIGRATION_INVENTORY.filter((name) => !applied.has(name));
  if (missingMigrations.length > 0) {
    return { ok: false, reason: 'SCHEMA_BEHIND', appliedCount: applied.size, expectedCount, missingMigrations };
  }
  const aheadBy = [...applied].filter((name) => !INVENTORY_SET.has(name)).length;

  // 3. Key tables present.
  let tableRows: { tablename: string }[];
  try {
    tableRows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY(${KEY_TABLES})`;
  } catch {
    return { ok: false, reason: 'DB_UNAVAILABLE', appliedCount: applied.size, expectedCount };
  }
  const present = new Set(tableRows.map((r) => r.tablename));
  const missingTables = KEY_TABLES.filter((t) => !present.has(t));
  if (missingTables.length > 0) {
    return { ok: false, reason: 'KEY_TABLE_MISSING', appliedCount: applied.size, expectedCount, missingTables };
  }

  return {
    ok: true,
    state: aheadBy > 0 ? 'ahead' : 'current',
    appliedCount: applied.size,
    expectedCount,
    aheadBy
  };
}
