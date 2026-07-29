// Minimal in-memory fixed-window rate limiter for a single Node.js process.
// Correct for the current single-instance deployment (compose.titanor-time.yaml
// runs exactly one `app` replica) — would need a shared store (e.g. Redis)
// instead if the app is ever scaled to more than one instance, since these
// counters are not shared across processes and reset on restart.

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

// Opportunistic, probabilistic sweep of expired windows so long-lived
// processes with many distinct keys (identifiers/IPs) don't grow the map
// unboundedly. Not a correctness requirement — just bounds memory.
function sweepExpired(now: number): void {
  if (Math.random() >= 0.01) {
    return;
  }
  for (const [key, window] of windows) {
    if (window.resetAt <= now) {
      windows.delete(key);
    }
  }
}

/** Returns true if the call is allowed, false if the key is over its limit. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweepExpired(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  existing.count += 1;
  return true;
}
