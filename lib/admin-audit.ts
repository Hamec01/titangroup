import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

// R07-B — append-only audit of public-site admin logins. One JSON line per attempt. It records
// only the outcome, a coarse timestamp, the trusted client IP and the user agent — NEVER the
// password, the session token, or any request body. Best-effort: a write failure is swallowed so
// it can never break a login flow.
//
// ADMIN_AUDIT_LOG — path, default `/app/data/admin-login-audit.log` (the `titanorgroup_data`
// named volume, so it survives container recreation). Rotation is external (logrotate / ops).

const DEFAULT_PATH = '/app/data/admin-login-audit.log';

export type AdminLoginOutcome = 'success' | 'failure' | 'rate_limited' | 'locked';

let ensuredDir: string | null = null;

export async function recordAdminLogin(
  outcome: AdminLoginOutcome,
  meta: { ip: string | null; userAgent: string | null }
): Promise<void> {
  const path = process.env.ADMIN_AUDIT_LOG || DEFAULT_PATH;
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'admin_login',
      outcome,
      ip: meta.ip ?? 'unknown',
      ua: (meta.userAgent ?? '').slice(0, 256)
    }) + '\n';

  try {
    const dir = dirname(path);
    if (ensuredDir !== dir) {
      await mkdir(dir, { recursive: true });
      ensuredDir = dir;
    }
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // never let an audit-write failure affect the login response
  }
}
