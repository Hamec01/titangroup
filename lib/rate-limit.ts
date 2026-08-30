// R07-B — in-memory fixed-window rate limiter for the public site.
//
// The public site (`compose.yaml` service `web`) runs exactly one instance and takes very little
// traffic, so a per-process Map is sufficient: a restart clears the counters (acceptable — it only
// means a brief window where a previously-limited client is allowed again), and there is no
// second instance to share state with. If the site is ever scaled out this needs a shared store.

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

function sweepExpired(now: number): void {
  if (Math.random() >= 0.02) return;
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests already counted in the current window (including this one). */
  count: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/** Fixed window of `windowMs`; up to `limit` calls allowed within it. */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweepExpired(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    const w = { count: 1, resetAt: now + windowMs };
    windows.set(key, w);
    return { allowed: true, count: 1, resetAt: w.resetAt };
  }

  existing.count += 1;
  return { allowed: existing.count <= limit, count: existing.count, resetAt: existing.resetAt };
}

/** Test-only: wipe all counters. */
export function __resetRateLimitStore(): void {
  windows.clear();
}
