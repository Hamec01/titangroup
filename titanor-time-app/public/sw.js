// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — hand-rolled service
// worker, no Workbox/next-pwa. Registered with `scope: '/worker/'` only (app/worker/layout.tsx) —
// the browser itself structurally prevents this SW from ever intercepting /admin/**, /foreman/**,
// /login, or any request outside that scope, on top of the allowlist logic below.
//
// Cache Storage is the ONLY thing this file ever touches. It never reads cookies, never inspects
// response bodies for content, never sends network requests of its own initiative beyond what the
// three allowlisted branches below issue. Any request not matched by one of those three branches
// falls through untouched — no caches.* call happens for it in either direction.

const CACHE_VERSION = 'v1';
const CACHE_NAME = `titanor-time-worker-shell-${CACHE_VERSION}`;
const OFFLINE_SHELL_PATH = '/worker-offline';

const STATIC_CACHE_PREFIXES = ['/_next/static/', '/icons/'];
const STATIC_CACHE_EXACT = ['/manifest.webmanifest'];

function isStaticCacheable(pathname) {
  return STATIC_CACHE_EXACT.includes(pathname) || STATIC_CACHE_PREFIXES.some((p) => pathname.startsWith(p));
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
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
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
    if (url.pathname === '/worker') {
      event.respondWith(networkFirstWithOfflineShellFallback(request));
      return;
    }
    if (url.pathname === OFFLINE_SHELL_PATH) {
      event.respondWith(networkFirstUpdatingCache(request, OFFLINE_SHELL_PATH));
      return;
    }
    // Every other navigation (including /worker/periods, /worker/history, /admin/**, /foreman/**,
    // /login, anything else) is never intercepted — real network request, real browser offline
    // error on failure, never silently swapped for this shell.
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
    if (response && response.ok) {
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
  if (response && response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}
