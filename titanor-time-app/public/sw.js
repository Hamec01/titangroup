// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — hand-rolled service
// worker, no Workbox/next-pwa. Registered with `scope: '/worker'` (no trailing slash — a leading
// trailing-slash typo was found and fixed during T7A.10C.1 testing, see the addendum; a scope of
// '/worker/' would NOT cover the bare '/worker' page itself, since SW scope matching is a literal
// string-prefix test) by client code in components/worker-pwa/ServiceWorkerRegistration.tsx — not
// app/worker/layout.tsx, which only renders that component. The browser itself structurally
// prevents this SW from ever intercepting /admin/**, /foreman/**, /login, or any request outside
// that scope, on top of the allowlist logic below.
//
// Cache Storage is the ONLY thing this file ever touches. It never reads cookies, never inspects
// response bodies for content, never sends network requests of its own initiative beyond what the
// three allowlisted branches below issue. Any request not matched by one of those three branches
// falls through untouched — this file makes no `event.respondWith(...)` call for it at all, so the
// browser performs its own normal network handling; this script itself never calls `fetch()` for
// those requests.
//
// docs/titanor-time/T8_PWA_DESIGN.md §F.10 (T8.8) — the first branch (network-first, cached-shell-
// on-exception-only) now also covers a fixed set of known /worker/** UI routes (isKnownWorkerUiRoute
// below), not just /worker itself, so the same single cached /worker-offline document can serve as
// the offline fallback for periods/history/period-detail/hours/day-detail/submit/install too. Real
// HTTP responses (including 401/403/404/409/500) are still always returned exactly as received —
// only a genuine fetch() exception falls back to the cache. No new Cache Storage entry is added by
// this — still one document, still PII-free, still never authenticated HTML or an API response.

// v2 (T8.8, docs/titanor-time/T8_PWA_DESIGN.md §F.10) — the navigation allowlist grew to cover
// more known /worker/** UI routes, not just /worker itself, so the SW's own behavior changed.
// lib/offline-outbox/pwa-warm-cache.ts duplicates this exact literal (it cannot import from this
// raw, unbundled script) — keep both in sync; scripts/_test-pwa-offline-views.ts asserts they match.
const CACHE_VERSION = 'v2';
const CACHE_PREFIX = 'titanor-time-worker-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const OFFLINE_SHELL_PATH = '/worker-offline';

const STATIC_CACHE_PREFIXES = ['/_next/static/', '/icons/'];
const STATIC_CACHE_EXACT = ['/manifest.webmanifest'];

function isStaticCacheable(pathname) {
  return STATIC_CACHE_EXACT.includes(pathname) || STATIC_CACHE_PREFIXES.some((p) => pathname.startsWith(p));
}

// docs/titanor-time/T8_PWA_DESIGN.md §F.6/§F.10 — known /worker/** UI routes that get the SAME
// network-first-with-offline-shell-fallback treatment as /worker itself (T8.8). Structural match
// (periodId/date are arbitrary), not an exact path list. Deliberately mirrors
// lib/offline-outbox/read-snapshots.ts's ROUTE_PATTERNS one-for-one, but duplicated here for the
// same reason CACHE_NAME/isSafeToCache already are — this file cannot import that module.
const WORKER_UI_ROUTE_PATTERNS = [
  /^\/worker\/periods\/[^/]+\/hours\/[^/]+\/?$/,
  /^\/worker\/periods\/[^/]+\/hours\/?$/,
  /^\/worker\/periods\/[^/]+\/submit\/?$/,
  /^\/worker\/periods\/[^/]+\/?$/,
  /^\/worker\/periods\/?$/,
  /^\/worker\/history\/?$/,
  /^\/worker\/install\/?$/
];

function isKnownWorkerUiRoute(pathname) {
  return WORKER_UI_ROUTE_PATTERNS.some((re) => re.test(pathname));
}

/**
 * T7A.10C.1 FOLLOW-UP — fail-closed cacheability predicate. `response.ok` alone (the previous
 * check) says nothing about redirects, `Cache-Control: private`/`no-store`, a `Set-Cookie` header,
 * or an opaque/cross-origin response — any of those would make it unsafe to persist this response
 * under a shared, shell-wide cache key. Same-origin filtering already happens in the `fetch`
 * listener below (line ~68), so `response.type` here is defense-in-depth, not the only guard.
 * `Set-Cookie` is a forbidden response-header name per the Fetch spec — browsers strip it from
 * `Headers` entirely, so `.get('set-cookie')` is normally always null here regardless of what the
 * server sent. This check is kept anyway (in case that ever changes, and to keep this predicate a
 * complete, self-documenting statement of intent) — the actual enforcement that `/worker-offline`
 * never sets one is the route's own response contract (next.config.mjs `headers()`), verified by a
 * real, non-browser HTTP request in tests, not by this in-SW check.
 */
function isSafeToCache(response, { requireHtml = false } = {}) {
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

self.addEventListener('install', (event) => {
  // No install-time precache of hashed chunk names here — this file cannot know the current
  // build's content hashes (see the design addendum's own reasoning). Cache warming happens from
  // page-side code (lib/offline-outbox/pwa-warm-cache.ts) after a real successful online bootstrap.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // T7A.10C.1 FOLLOW-UP — namespace isolation. The previous version deleted every cache key on
      // the origin except the current CACHE_NAME, which would destroy any unrelated same-origin
      // cache (a future feature's own cache, or one created by different tooling entirely). Now
      // only THIS shell's own stale versions (same CACHE_PREFIX, different from the current
      // CACHE_NAME) are ever deleted — a foreign key never starting with CACHE_PREFIX is untouched.
      const keys = await caches.keys();
      const staleOwnKeys = keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME);
      await Promise.all(staleOwnKeys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return; // never touch caches.* for any non-GET request — falls through to plain network.
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return; // never intercept cross-origin requests.
  }

  if (request.mode === 'navigate') {
    if (url.pathname === '/worker' || isKnownWorkerUiRoute(url.pathname)) {
      event.respondWith(networkFirstWithOfflineShellFallback(request));
      return;
    }
    if (url.pathname === OFFLINE_SHELL_PATH) {
      event.respondWith(networkFirstUpdatingCache(request, OFFLINE_SHELL_PATH));
      return;
    }
    // Every other navigation (any /worker/* path not in the known list above, /admin/**,
    // /foreman/**, /login, anything else) is never intercepted — real network request, real
    // browser offline error on failure, never silently swapped for this shell.
    return;
  }

  if (isStaticCacheable(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else — /api/**, RSC data requests, any other asset — network-only, untouched.
});

async function networkFirstWithOfflineShellFallback(request) {
  try {
    // The real /worker response (including a genuine 401/403) is returned exactly as received —
    // never cached, never inspected for content, just passed through.
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(OFFLINE_SHELL_PATH);
    if (cached) {
      return cached;
    }
    return new Response('Offline and no cached shell is available yet. Connect once to finish setup.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function networkFirstUpdatingCache(request, cacheKey) {
  try {
    const response = await fetch(request);
    if (isSafeToCache(response, { requireHtml: true })) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
    return new Response('Offline and no cached shell is available yet. Connect once to finish setup.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (isSafeToCache(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}
