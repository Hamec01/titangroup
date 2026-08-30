import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { successHeaders } from '@/lib/api-error';
import { checkSchemaReadiness } from '@/lib/schema-readiness';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R06-A — schema-aware readiness. 200 only when this build can actually run against the database
// it is connected to: reachable, no failed/unfinished migrations, every migration this build
// expects is applied, and the key tables exist. Any incompatibility is a 503 — a stale schema
// can no longer hide behind a plain `SELECT 1`.
//
// The body carries only safe values: a fixed status/reason enum, migration directory names (public
// in the repo), table names, and counts. Never the caught error, SQL, connection details, or rows.

export async function GET() {
  const requestId = randomUUID();
  const result = await checkSchemaReadiness();

  if (result.ok) {
    return NextResponse.json(
      {
        status: 'ready',
        service: 'titanor-time',
        database: 'connected',
        schema: result.state, // 'current' | 'ahead'
        migrations: { applied: result.appliedCount, expected: result.expectedCount, aheadBy: result.aheadBy }
      },
      { status: 200, headers: successHeaders(requestId) }
    );
  }

  // One fixed log line per reason — no error content, no host/port.
  console.error(`titanor-time readiness: not ready (${result.reason})`);

  return NextResponse.json(
    {
      status: 'not_ready',
      service: 'titanor-time',
      database: result.reason === 'DB_UNAVAILABLE' ? 'unavailable' : 'connected',
      reason: result.reason,
      migrations: { applied: result.appliedCount, expected: result.expectedCount },
      ...(result.missingMigrations ? { missingMigrations: result.missingMigrations } : {}),
      ...(result.failedMigrations ? { failedMigrations: result.failedMigrations } : {}),
      ...(result.missingTables ? { missingTables: result.missingTables } : {})
    },
    { status: 503, headers: successHeaders(requestId) }
  );
}
