// T7A.10C.1 FOLLOW-UP §3 — proves warmOfflineShellCache's retry/concurrency semantics without a
// real browser: mocked `fetch`/`caches`/`navigator` globals, tsx-run, plain assertions. Each
// scenario dynamic-imports the module under a distinct query-string specifier so it gets fresh
// module-level state (`warmed`/`inFlight` are module-scoped, not resettable from outside).

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
}

class FakeHeaders {
  private map: Map<string, string>;
  constructor(init: Record<string, string> = {}) {
    this.map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), v]));
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
}

class FakeResponse {
  ok: boolean;
  redirected: boolean;
  type: string;
  headers: FakeHeaders;
  status: number;
  private body: string;
  constructor(body: string, opts: { ok?: boolean; redirected?: boolean; type?: string; headers?: Record<string, string>; status?: number } = {}) {
    this.body = body;
    this.ok = opts.ok ?? true;
    this.redirected = opts.redirected ?? false;
    this.type = opts.type ?? 'basic';
    this.status = opts.status ?? (this.ok ? 200 : 500);
    this.headers = new FakeHeaders(opts.headers ?? { 'content-type': 'text/html' });
  }
  clone(): FakeResponse {
    return this;
  }
  async text(): Promise<string> {
    return this.body;
  }
}

class FakeCache {
  store = new Map<string, FakeResponse>();
  async match(key: string) {
    return this.store.get(key);
  }
  async put(key: string, response: FakeResponse) {
    this.store.set(key, response);
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name)!;
  }
}

const SHELL_HTML = '<html><head><script src="/_next/static/chunk-abc.js"></script><link rel="stylesheet" href="/_next/static/style-def.css"></head><body></body></html>';

function installGlobals(fetchImpl: (url: string) => Promise<FakeResponse>) {
  const fakeCacheStorage = new FakeCacheStorage();
  const calls: string[] = [];
  (globalThis as any).caches = fakeCacheStorage;
  // Node's built-in `navigator` global is a getter-only accessor property — plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: {} }, configurable: true, writable: true });
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    return fetchImpl(url);
  };
  return { fakeCacheStorage, calls };
}

async function scenarioFailThenSucceed() {
  let shellCallCount = 0;
  const { fakeCacheStorage, calls } = installGlobals(async (url: string) => {
    if (url === '/worker-offline') {
      shellCallCount++;
      if (shellCallCount === 1) {
        return new FakeResponse('service unavailable', { ok: false, status: 503, headers: {} });
      }
      return new FakeResponse(SHELL_HTML);
    }
    return new FakeResponse('/* asset */', { headers: { 'content-type': 'application/javascript' } });
  });

  // A computed (non-literal) specifier — cache-busting query string forces a fresh module instance
  // (module-level `warmed`/`inFlight` state) per scenario. tsc cannot statically resolve a computed
  // specifier and treats the result as `any`, which is correct here — this is deliberately dynamic.
  const modulePath = '../lib/offline-outbox/pwa-warm-cache.ts' + '?scenario=fail-then-succeed';
  const mod = await import(modulePath);

  await mod.warmOfflineShellCache();
  const cache1 = await fakeCacheStorage.open('titanor-time-worker-shell-v1');
  assert(!(await cache1.match('/worker-offline')), 'first warm (503) must NOT cache the shell');
  assert(calls.length === 1, `first warm should make exactly 1 fetch call (the failed shell fetch), got ${calls.length}`);

  await mod.warmOfflineShellCache();
  const shellCached = await cache1.match('/worker-offline');
  assert(!!shellCached, 'second warm (200) must cache the shell');
  const assetJs = await cache1.match('/_next/static/chunk-abc.js');
  const assetCss = await cache1.match('/_next/static/style-def.css');
  assert(!!assetJs && !!assetCss, 'second warm must cache both discovered assets');
  assert(shellCallCount === 2, 'shell must have been fetched exactly twice total (retry allowed after 503)');

  console.log('PASS: scenario A — 503 then retry succeeds, shell+assets cached, warmed unlocked after failure.');
}

async function scenarioConcurrentDedup() {
  let shellFetchCount = 0;
  const { fakeCacheStorage, calls } = installGlobals(async (url: string) => {
    if (url === '/worker-offline') {
      shellFetchCount++;
      await new Promise((r) => setTimeout(r, 10)); // simulate network latency so both calls overlap
      return new FakeResponse(SHELL_HTML);
    }
    return new FakeResponse('/* asset */', { headers: { 'content-type': 'application/javascript' } });
  });

  const modulePath = '../lib/offline-outbox/pwa-warm-cache.ts' + '?scenario=concurrent-dedup';
  const mod = await import(modulePath);

  const [a, b] = await Promise.all([mod.warmOfflineShellCache(), mod.warmOfflineShellCache()]);
  void a;
  void b;

  assert(shellFetchCount === 1, `two concurrent warm() calls must issue exactly one shell fetch, got ${shellFetchCount}`);
  // shell fetch (1) + 2 assets (2) = 3 total network calls, not 6.
  assert(calls.length === 3, `two concurrent warm() calls must perform exactly one full fetch set (3 calls), got ${calls.length}`);

  const cache = await fakeCacheStorage.open('titanor-time-worker-shell-v1');
  assert(!!(await cache.match('/worker-offline')), 'concurrent warm must still cache the shell');

  console.log('PASS: scenario B — two concurrent warm() calls perform exactly one network fetch set.');
}

async function main() {
  await scenarioFailThenSucceed();
  await scenarioConcurrentDedup();
  console.log('PASS: warm retry/concurrency semantics (2/2 scenarios).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
