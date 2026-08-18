// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — runtime cache warm,
// called from the ONLINE /worker page only, once per successful bootstrap. Browser-only. Must stay
// in sync with the cache name literal in public/sw.js (that file cannot import this module — it
// runs as a raw, unbundled service worker script, not through webpack).

const CACHE_NAME = 'titanor-time-worker-shell-v1';
const OFFLINE_SHELL_PATH = '/worker-offline';

let warmed = false;

const ASSET_ATTR_PATTERN = /<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"[^>]*>/gi;

function extractAssetUrls(html: string): string[] {
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  ASSET_ATTR_PATTERN.lastIndex = 0;
  while ((match = ASSET_ATTR_PATTERN.exec(html)) !== null) {
    const url = match[1];
    if (url.startsWith('/_next/static/') || url.startsWith('/icons/') || url === '/manifest.webmanifest') {
      urls.add(url);
    }
  }
  return [...urls];
}

/**
 * Fetches the (already PII-free by construction — a static, server-data-free route) offline shell
 * document, puts it directly into the SAME Cache Storage instance the service worker reads from
 * (window and SW share one Cache Storage per origin — writing from here does not require
 * postMessage'ing the SW), then parses it for the exact hashed static asset URLs THIS build's
 * offline shell actually needs and caches each of those too. Never touches /worker itself or any
 * other authenticated route.
 */
export async function warmOfflineShellCache(): Promise<void> {
  if (warmed) {
    return;
  }
  if (typeof caches === 'undefined' || typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return;
  }
  warmed = true;

  try {
    const response = await fetch(OFFLINE_SHELL_PATH, { credentials: 'omit' });
    if (!response.ok) {
      return;
    }
    const html = await response.clone().text();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(OFFLINE_SHELL_PATH, response);

    const assetUrls = extractAssetUrls(html);
    await Promise.all(
      assetUrls.map(async (url) => {
        try {
          const alreadyCached = await cache.match(url);
          if (alreadyCached) {
            return;
          }
          const assetResponse = await fetch(url, { credentials: 'omit' });
          if (assetResponse.ok) {
            await cache.put(url, assetResponse);
          }
        } catch {
          // One missing asset never blocks warming the rest — the offline shell's own SW fetch
          // handler will attempt a normal network fetch for anything not found in cache anyway.
        }
      })
    );
  } catch {
    // Best-effort only — a failed warm attempt never blocks or errors the online page; it just
    // means the offline shell may not be fully cached yet for a genuinely offline cold start.
    warmed = false;
  }
}
