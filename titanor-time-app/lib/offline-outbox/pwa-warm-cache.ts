// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — runtime cache warm,
// called from the ONLINE /worker page only, once per successful bootstrap. Browser-only. Must stay
// in sync with the cache name literal in public/sw.js (that file cannot import this module — it
// runs as a raw, unbundled service worker script, not through webpack).
//
// docs/titanor-time/T8_PWA_DESIGN.md §F.10 (T8.8) — bumped to v2 alongside public/sw.js's own
// CACHE_VERSION in the same commit. scripts/_test-pwa-offline-views.ts asserts both literals match.

const CACHE_NAME = 'titanor-time-worker-shell-v2';
const OFFLINE_SHELL_PATH = '/worker-offline';

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
 * T7A.10C.1 FOLLOW-UP — mirrors public/sw.js's isSafeToCache. Duplicated, not imported, for the
 * same reason CACHE_NAME above is a duplicated literal: this module and the raw SW script are two
 * separate execution contexts that cannot share code. `requireHtml` is only ever true for the shell
 * document itself; static assets vary in Content-Type by design.
 */
function isSafeToCache(response: Response, { requireHtml = false }: { requireHtml?: boolean } = {}): boolean {
  if (!response || !response.ok) {
    return false;
  }
  if (response.redirected) {
    return false;
  }
  if (response.type !== 'basic') {
    return false;
  }
  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  if (cacheControl.includes('private') || cacheControl.includes('no-store')) {
    return false;
  }
  if (response.headers.get('set-cookie')) {
    return false;
  }
  if (requireHtml) {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('text/html')) {
      return false;
    }
  }
  return true;
}

/**
 * T7A.10C.1 FOLLOW-UP — retry/concurrency semantics rewrite. The previous version set an in-module
 * `warmed = true` flag BEFORE the fetch even started, so a single non-ok/unsafe response (e.g. a
 * transient 500 from `/worker-offline`) permanently locked out retries for the rest of the page
 * session — worse than a hard network failure, which at least reset the flag in a `catch`. There was
 * also no de-duplication of concurrent callers: two near-simultaneous calls before either awaited
 * anything would both proceed past the old synchronous flag check and duplicate every fetch.
 *
 * Now: `inFlight` is a shared Promise, not a boolean — every caller while a warm attempt is running
 * gets the SAME promise and therefore performs exactly one set of network fetches between them, and
 * genuinely waits for that attempt's outcome rather than getting a false "already done" return.
 * `warmed` (module-level, in-memory only) becomes `true` ONLY after the shell document AND every
 * asset it references have been individually confirmed cached (`isSafeToCache` for the shell, a
 * verified `cache.match` or a freshly successful `cache.put` for each asset) — any unsafe/failed
 * response for the shell OR any one asset leaves `warmed = false`, so the next call (this session,
 * or a later one) retries the whole thing from scratch. A successful warm is remembered in-memory
 * only (`warmed`), matching the previous session-scoped behavior — nothing is persisted.
 */
let warmed = false;
let inFlight: Promise<void> | null = null;

async function warmOnce(): Promise<void> {
  if (typeof caches === 'undefined' || typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return;
  }

  const response = await fetch(OFFLINE_SHELL_PATH, { credentials: 'omit' });
  if (!isSafeToCache(response, { requireHtml: true })) {
    return; // warmed stays false — caller may retry.
  }
  const html = await response.clone().text();
  const cache = await caches.open(CACHE_NAME);
  await cache.put(OFFLINE_SHELL_PATH, response);

  const assetUrls = extractAssetUrls(html);
  const assetResults = await Promise.all(
    assetUrls.map(async (url) => {
      try {
        const alreadyCached = await cache.match(url);
        if (alreadyCached) {
          return true;
        }
        const assetResponse = await fetch(url, { credentials: 'omit' });
        if (!isSafeToCache(assetResponse)) {
          return false;
        }
        await cache.put(url, assetResponse);
        return true;
      } catch {
        return false;
      }
    })
  );

  // Every asset the shell HTML actually references is required for a fully working offline
  // render — a missing/failed one leaves the warm attempt incomplete, not "mostly done".
  if (assetResults.every(Boolean)) {
    warmed = true;
  }
}

export async function warmOfflineShellCache(): Promise<void> {
  if (warmed) {
    return;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = warmOnce()
    .catch(() => {
      // Best-effort only — a failed warm attempt never blocks or errors the online page; it just
      // means the offline shell may not be fully cached yet for a genuinely offline cold start.
      // warmed is already false in every path that reaches here (warmOnce only ever sets it true
      // on full success), so nothing to reset.
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
