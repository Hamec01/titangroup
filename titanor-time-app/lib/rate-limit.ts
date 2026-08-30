import { prisma } from '@/lib/prisma';

// R07-A — shared, restart-safe fixed-window rate limiter backed by a single Postgres row per key
// (`RateLimitCounter`). Correct across multiple app instances (the whole increment is one atomic
// `INSERT … ON CONFLICT DO UPDATE`) and it survives a process restart, unlike the previous
// in-memory Map. One round-trip per limited request.
//
// Window semantics are unchanged: a fixed window of `windowMs`, `limit` requests allowed within it,
// the window resets lazily on the first request after it expires.

const CLEANUP_PROBABILITY = 0.02;

/**
 * Returns true if the call is allowed, false if `key` is at or over `limit` for the current window.
 * Fail-OPEN by design: if the database is unreachable the call is allowed. A rate limiter must
 * never be the reason the whole app stops working, and every operation these limiters protect
 * (login, activation, clock in/out, …) already needs the same database — a DB outage disables them
 * regardless. This is the standard trade-off for a limiter and is called out in the R07-A report.
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "RateLimitCounter" ("key", "count", "windowExpiresAt")
      VALUES (${key}, 1, now() + (${windowMs}::double precision * interval '1 millisecond'))
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimitCounter"."windowExpiresAt" <= now() THEN 1
                       ELSE "RateLimitCounter"."count" + 1 END,
        "windowExpiresAt" = CASE WHEN "RateLimitCounter"."windowExpiresAt" <= now()
                                 THEN now() + (${windowMs}::double precision * interval '1 millisecond')
                                 ELSE "RateLimitCounter"."windowExpiresAt" END
      RETURNING "count"`;

    if (Math.random() < CLEANUP_PROBABILITY) {
      // Opportunistic GC so the table stays tiny; expired rows are already ignored above.
      await prisma.$executeRaw`DELETE FROM "RateLimitCounter" WHERE "windowExpiresAt" < now() - interval '1 hour'`;
    }

    const count = rows[0]?.count ?? 1;
    return count <= limit;
  } catch {
    // Never let a limiter outage take the app down.
    return true;
  }
}
