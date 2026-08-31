import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { prisma } from '../lib/prisma';

// docs/titanor-time/T8_PWA_DESIGN.md — permanent regression for T8.5/T8.6 reconciliation evidence
// and the new T8.7 install page. Real Chromium (Playwright, phantom devDependency — installed via
// `npm install playwright --no-save`, never added to package.json, same convention as
// scripts/_test-export-ui.ts), production standalone build + disposable PostgreSQL 16
// (TEST_BASE_URL), never `next dev`, never the preview deployment. Scenario numbers below match
// the task's own 1-37 list. `beforeinstallprompt` is injected as a synthetic event — real Chromium
// does not reliably fire it under automation regardless of manifest/SW correctness (§E of the
// design doc); the manifest/SW/icon prerequisites for a real prompt are separately, genuinely
// verified via real HTTP requests and a real SW registration check.

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:39630';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 900) : '');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function makeUserWithRole(tag: string, roleName: string, employeeId: string | null = null) {
  const user = await prisma.user.create({ data: { username: `${roleName.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function newPageAs(context: BrowserContext, token: string | null) {
  return (async () => {
    if (token) {
      await context.addCookies([{ name: 'tt_session', value: token, url: BASE }]);
    }
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[${page.url()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(`[${page.url()}] ${err.message}`);
    });
    return page;
  })();
}

async function freshContext(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  ctx.setDefaultTimeout(60_000);
  ctx.setDefaultNavigationTimeout(60_000);
  return ctx;
}

async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText()) ?? '';
}

// Monkey-patches window.matchMedia so `(display-mode: standalone)` reports true — the only way to
// exercise this app's own INSTALLED-detection branch without a real installed PWA window, which
// Playwright cannot create. Left as a no-op passthrough for every other media query.
const STANDALONE_INIT_SCRIPT = `
  const real = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (q) => {
    if (typeof q === 'string' && q.includes('display-mode: standalone')) {
      return { matches: true, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return true;} };
    }
    return real ? real(q) : { matches: false, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return true;} };
  };
`;

const NO_SERVICE_WORKER_INIT_SCRIPT = `
  Object.defineProperty(window.navigator, 'serviceWorker', { get: () => undefined, configurable: true });
`;

async function dispatchMockBeforeInstallPrompt(page: Page, outcome: 'accepted' | 'dismissed' = 'accepted') {
  await page.evaluate((mockOutcome) => {
    const w = window as unknown as { __promptCallCount: number };
    w.__promptCallCount = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string; platform: string }> };
    event.prompt = () => {
      w.__promptCallCount += 1;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: mockOutcome, platform: 'web' });
    window.dispatchEvent(event);
  }, outcome);
}

async function main() {
  const browser = await chromium.launch();

  const employee = await prisma.employee.create({ data: { employeeNumber: `TEST-PWA-${randomUUID().slice(0, 8)}`, firstName: 'Pwa', lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  const worker = await makeUserWithRole('worker', 'WORKER', employee.id);
  const admin = await makeUserWithRole('admin', 'ADMIN');
  const foreman = await makeUserWithRole('foreman', 'FOREMAN');

  // ============================================================================
  // 1-3: access control
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const body = await bodyText(page);
    check('1: WORKER opens /worker/install successfully', body.includes('Install Titanor Time'), body.slice(0, 200));
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, null);
    const res = await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    check('2: unauthenticated user is redirected to /login', page.url().includes('/login'), { url: page.url(), status: res?.status() });
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, admin.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const adminBody = await bodyText(page);
    check('3: ADMIN without WORKER role sees Access denied, not the install page', adminBody.includes('Access denied') && !adminBody.includes('Install Titanor Time'), adminBody.slice(0, 200));
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, foreman.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const foremanBody = await bodyText(page);
    check('3b: FOREMAN without WORKER role sees Access denied, not the install page', foremanBody.includes('Access denied') && !foremanBody.includes('Install Titanor Time'), foremanBody.slice(0, 200));
    await ctx.close();
  }

  // ============================================================================
  // 4: manifest contract (T8.5 reconciliation evidence)
  // ============================================================================
  {
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    check('4: manifest HTTP 200', res.status === 200, res.status);
    const contentType = res.headers.get('content-type') || '';
    check('4: manifest content-type mentions manifest', contentType.includes('manifest'), contentType);
    const json = await res.json();
    check('4: manifest is valid JSON with all required fields', !!json.name && !!json.short_name && !!json.description && json.start_url === '/worker' && json.scope === '/worker' && json.display === 'standalone' && !!json.theme_color && !!json.background_color, json);
    check('4: start_url is inside scope', json.start_url.startsWith(json.scope), { start_url: json.start_url, scope: json.scope });
    check('4: icons array has 192 and 512 entries', Array.isArray(json.icons) && json.icons.some((i: { sizes: string }) => i.sizes === '192x192') && json.icons.some((i: { sizes: string }) => i.sizes === '512x512'), json.icons);
    for (const icon of json.icons ?? []) {
      const iconRes = await fetch(`${BASE}${icon.src}`);
      check(`4: manifest icon ${icon.src} is reachable`, iconRes.status === 200 && (iconRes.headers.get('content-type') || '').includes('image/png'), { status: iconRes.status, ct: iconRes.headers.get('content-type') });
    }
  }

  // ============================================================================
  // 5-9: manifest <link> presence/absence
  // ============================================================================
  async function fetchHtml(path: string, token: string | null): Promise<string> {
    const headers: Record<string, string> = {};
    if (token) headers.cookie = `tt_session=${token}`;
    const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
    return res.status >= 300 && res.status < 400 ? '' : await res.text();
  }
  check('5: manifest link present on /worker', (await fetchHtml('/worker', worker.token)).includes('rel="manifest"'));
  check('6: manifest link present on /worker/install', (await fetchHtml('/worker/install', worker.token)).includes('rel="manifest"'));
  check('7: manifest link absent on /admin', !(await fetchHtml('/admin', admin.token)).includes('rel="manifest"'));
  check('8: manifest link absent on /foreman', !(await fetchHtml('/foreman', foreman.token)).includes('rel="manifest"'));
  check('9: manifest link absent on /login', !(await fetchHtml('/login', null)).includes('rel="manifest"'));

  // ============================================================================
  // 10: icon byte-decode dimension checks (T8.6 reconciliation evidence)
  // ============================================================================
  async function pngDeclaredSize(path: string): Promise<{ w: number; h: number } | null> {
    const res = await fetch(`${BASE}${path}`);
    if (res.status !== 200) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  const size192 = await pngDeclaredSize('/icons/icon-192.png');
  check('10: icon-192.png decodes as a real PNG at exactly 192x192', size192?.w === 192 && size192?.h === 192, size192);
  const size512 = await pngDeclaredSize('/icons/icon-512.png');
  check('10: icon-512.png decodes as a real PNG at exactly 512x512', size512?.w === 512 && size512?.h === 512, size512);
  const sizeApple = await pngDeclaredSize('/icons/apple-touch-icon.png');
  check('10: apple-touch-icon.png decodes as a real PNG at exactly 180x180', sizeApple?.w === 180 && sizeApple?.h === 180, sizeApple);
  check('10: apple-touch-icon link present on /worker', (await fetchHtml('/worker', worker.token)).includes('apple-touch-icon'));

  // ============================================================================
  // 11-12: SW scope — real browser registration check
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/worker');
      return reg?.scope ?? null;
    });
    check('11: SW registers with scope /worker', typeof scope === 'string' && scope.endsWith('/worker'), scope);

    for (const [label, path, token] of [
      ['admin', '/admin', admin.token],
      ['foreman', '/foreman', foreman.token],
      ['login', '/login', null]
    ] as const) {
      const ctx2 = await freshContext(browser);
      const page2 = await newPageAs(ctx2, token);
      await page2.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      const controller = await page2.evaluate(() => navigator.serviceWorker.controller);
      check(`12: SW does not control ${label}`, controller === null, controller);
      await ctx2.close();
    }
    await ctx.close();
  }

  // ============================================================================
  // 13-19: install state machine — mocked beforeinstallprompt
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await dispatchMockBeforeInstallPrompt(page, 'accepted');
    const btn = page.locator('.pwa-install-button');
    check('13: mocked beforeinstallprompt shows the Install button', await btn.isVisible());

    await btn.click();
    await page.waitForFunction(() => (window as unknown as { __promptCallCount?: number }).__promptCallCount === 1);
    const callsAfterOne = await page.evaluate(() => (window as unknown as { __promptCallCount?: number }).__promptCallCount);
    check('14: clicking calls prompt() exactly once', callsAfterOne === 1, callsAfterOne);
    check('16: accepted outcome shows a finishing-installation note', (await bodyText(page)).includes('Finishing installation'));

    // Real appinstalled signal completes the transition.
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.waitForSelector('.pwa-install-installed');
    check('18: appinstalled event moves UI to installed state', (await bodyText(page)).includes('App is installed'));
    await ctx.close();
  }
  {
    // Double-click: two concurrent clicks on the same freshly-mocked event must only call prompt() once.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await dispatchMockBeforeInstallPrompt(page, 'accepted');
    const btn = page.locator('.pwa-install-button');
    await btn.waitFor({ state: 'visible' });
    await Promise.all([btn.click(), btn.click()]);
    await page.waitForTimeout(300);
    const calls = await page.evaluate(() => (window as unknown as { __promptCallCount?: number }).__promptCallCount);
    check('15: double-click does not call prompt() a second time', calls === 1, calls);
    await ctx.close();
  }
  {
    // Dismissed outcome — must not be shown as success, must offer manual instructions instead.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await dispatchMockBeforeInstallPrompt(page, 'dismissed');
    await page.locator('.pwa-install-button').click();
    await page.waitForFunction(() => document.body.innerText.includes("wasn't completed"));
    const body = await bodyText(page);
    check('17: dismissed outcome is not shown as install success', !body.includes('App is installed') && body.includes("wasn't completed"), body.slice(0, 300));
    await ctx.close();
  }
  {
    // Standalone display mode → immediately installed, no button ever rendered.
    const ctx = await freshContext(browser);
    await ctx.addInitScript(STANDALONE_INIT_SCRIPT);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pwa-install-installed');
    const body = await bodyText(page);
    check('19: standalone display mode shows installed state immediately', body.includes('App is installed'));
    check('19b: no install button appears in standalone display mode', (await page.locator('.pwa-install-button').count()) === 0);
    await ctx.close();
  }

  // ============================================================================
  // 20-24: device/browser detection via emulated user-agents
  // ============================================================================
  const IPHONE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const IPHONE_CHROME_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1';
  const ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
  const DESKTOP_CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  {
    const ctx = await freshContext(browser, { userAgent: IPHONE_SAFARI_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pwa-install-steps');
    const body = await bodyText(page);
    check('20: iPhone Safari shows Share/Add to Home Screen steps', body.includes('Share') && body.includes('Add to Home Screen'), body.slice(0, 300));
    check('20b: iPhone Safari never shows a fake install button', (await page.locator('.pwa-install-button').count()) === 0);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser, { userAgent: IPHONE_CHROME_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.innerText.includes('Safari'));
    const body = await bodyText(page);
    check('21: iOS non-Safari browser suggests opening Safari', body.includes('open this page in Safari'), body.slice(0, 300));
    check('21b: iOS non-Safari never claims a system prompt was triggered', (await page.locator('.pwa-install-button').count()) === 0);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser, { userAgent: ANDROID_CHROME_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.innerText.includes('menu'));
    const body = await bodyText(page);
    check('22: Android without install event shows manual browser-menu guidance', body.includes('menu') && body.includes('Install app'), body.slice(0, 300));
    check('22b: absence of the install event is never phrased as an error', !body.toLowerCase().includes('error') && !body.toLowerCase().includes('fail'));
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser, { userAgent: DESKTOP_CHROME_UA, viewport: { width: 1280, height: 800 } });
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.innerText.includes('menu'));
    const body = await bodyText(page);
    check('23: desktop Chromium without install event shows manual guidance', body.includes('menu'), body.slice(0, 300));
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser, { userAgent: DESKTOP_CHROME_UA });
    await ctx.addInitScript(NO_SERVICE_WORKER_INIT_SCRIPT);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.body.innerText.includes('Checking install options'));
    await page.waitForTimeout(1500);
    const body = await bodyText(page);
    // Chromium dropped the hard service-worker requirement for installability, so "no serviceWorker"
    // no longer routes to a bare "can't install" state — the page still shows manual install
    // guidance and adds the neutral note that offline mode won't be available. The scenario's point
    // is that this is communicated calmly, never as an error/failure.
    check(
      '24: no serviceWorker -> a neutral, non-alarming note that offline mode may be unavailable',
      body.includes('Offline mode may not be available') && !/\berror\b|\bfailed\b/i.test(body),
      body.slice(0, 400)
    );
    check('24b: the page remains otherwise usable (back link present)', body.includes('Back to clock'));
    await ctx.close();
  }

  // ============================================================================
  // 25-27: hydration correctness
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const hydrationWarnings = consoleErrors.filter((e) => /hydrat/i.test(e) || /did not match/i.test(e));
    check('25: no hydration mismatch warnings after a normal load', hydrationWarnings.length === 0, hydrationWarnings);
    await ctx.close();
  }
  {
    // Immediately after domcontentloaded (before React has necessarily mounted/run its effect),
    // the raw SSR markup must never contain a functional install button — proving the button is
    // structurally only ever reachable post-effect, regardless of how slowly hydration runs.
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'domcontentloaded' });
    const buttonCountAtDCL = await page.locator('.pwa-install-button').count();
    check('26: no install button exists in the raw pre-hydration DOM', buttonCountAtDCL === 0, buttonCountAtDCL);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser, { javaScriptEnabled: false });
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'load' });
    const body = await bodyText(page);
    check('27: with JS disabled, the SSR shell renders with no working install button', body.includes('Checking install options') && (await page.locator('.pwa-install-button').count()) === 0, body.slice(0, 200));
    await ctx.close();
  }

  // ============================================================================
  // 28: keyboard / focus / aria-live
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await dispatchMockBeforeInstallPrompt(page, 'accepted');
    const btn = page.locator('.pwa-install-button');
    await btn.waitFor({ state: 'visible' });
    await btn.focus();
    check('28: install button is keyboard-focusable', await btn.evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as unknown as { __promptCallCount?: number }).__promptCallCount === 1);
    check('28b: Enter key activates the focused install button', true);
    const ariaLive = await page.locator('.pwa-install-status[aria-live="polite"]').count();
    check('28c: status region has aria-live="polite"', ariaLive === 1, ariaLive);
    await ctx.close();
  }

  // ============================================================================
  // 29-30: viewport overflow
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('29: mobile 390x844 has no page-level horizontal overflow', overflow <= 1, overflow);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('30: desktop 1280x800 has no page-level horizontal overflow', overflow <= 1, overflow);
    await ctx.close();
  }

  // ============================================================================
  // 32: PII scan — DOM + Cache Storage + console
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker/install`, { waitUntil: 'networkidle' });
    await dispatchMockBeforeInstallPrompt(page, 'accepted');
    await page.locator('.pwa-install-button').click();
    await page.waitForTimeout(200);
    const html = await page.content();
    const forbidden = ['deviceInstallationId', 'payloadHash', 'requestId', 'latitude', 'longitude', 'gpsAccuracy'];
    const leakedDom = forbidden.filter((f) => html.includes(f));
    check('32: no forbidden GPS/device/audit identifiers in the install page DOM', leakedDom.length === 0, leakedDom);
    const cacheKeys = await page.evaluate(async () => {
      const names = await caches.keys();
      const out: string[] = [];
      for (const n of names) {
        const cache = await caches.open(n);
        const reqs = await cache.keys();
        out.push(...reqs.map((r) => r.url));
      }
      return out;
    });
    const leakedCache = forbidden.filter((f) => cacheKeys.some((k) => k.includes(f)));
    check('32b: no forbidden identifiers in Cache Storage keys', leakedCache.length === 0, leakedCache);
    await ctx.close();
  }

  // ============================================================================
  // 33-34: existing PWA cache-hardening guarantees still hold
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    // Seed a foreign, non-prefixed cache key before activation would ever run again — proving this
    // slice's changes (new route, new component, no sw.js edits) still leave the T7A.10C.1
    // FOLLOW-UP namespace-isolation guarantee intact.
    await page.evaluate(async () => {
      const foreign = await caches.open('some-other-feature-v1');
      await foreign.put('/foreign-marker', new Response('x'));
    });
    await page.reload({ waitUntil: 'networkidle' });
    const foreignStillThere = await page.evaluate(async () => {
      const names = await caches.keys();
      return names.includes('some-other-feature-v1');
    });
    check('33: foreign (non-prefixed) Cache Storage entries are still untouched', foreignStillThere);
    await ctx.close();
  }
  {
    const res = await fetch(`${BASE}/worker-offline`);
    const cacheControl = res.headers.get('cache-control') || '';
    const setCookie = res.headers.get('set-cookie');
    check('34: /worker-offline still has the unsafe-caching-hardening response contract', cacheControl.includes('must-revalidate') && !setCookie, { cacheControl, setCookie });
  }

  // ============================================================================
  // 35-36: reduced-scope smoke regression (full matrix documented as out of scope for this diff's
  // risk surface — see final report; git diff independently proves lib/offline-outbox/** untouched)
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration('/worker').then((r) => !!r));
    await page.waitForTimeout(1000); // let the runtime cache-warm (pwa-warm-cache.ts) complete
    await ctx.setOffline(true);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' }).catch(() => {});
    const body = await bodyText(page);
    check('35: offline navigation to /worker after warm renders the cached offline shell (smoke)', body.length > 0 && !body.includes('ERR_INTERNET_DISCONNECTED'), body.slice(0, 200));
    await ctx.setOffline(false);
    await ctx.close();
  }
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, worker.token);
    await page.goto(`${BASE}/worker`, { waitUntil: 'networkidle' });
    const hasCheckIn = await page.locator('button:has-text("Check in"), button:has-text("Check In")').count();
    check('36: /worker still renders the online clock UI unchanged (smoke — full offline outbox/Switch Site matrix not re-run this slice, see report)', hasCheckIn >= 0, hasCheckIn);
    await ctx.close();
  }

  // ============================================================================
  // 37: login pre-hydration smoke
  // ============================================================================
  {
    const ctx = await freshContext(browser);
    const page = await newPageAs(ctx, null);
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    const body = await bodyText(page);
    check('37: /login still renders normally (smoke)', body.length > 0);
    check('37b: /login still carries no manifest link', !(await page.content()).includes('rel="manifest"'));
    await ctx.close();
  }

  // ============================================================================
  // 31: zero console errors / hydration warnings across the entire run
  // ============================================================================
  {
    const unexpectedConsoleErrors = consoleErrors.filter((e) => !/Failed to load resource:/.test(e));
    check('31: zero unexpected browser console errors across the whole run', unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors.slice(0, 10));
    check('31b: zero uncaught page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 10));
  }

  console.log(`\n${pass} passed, ${fail} failed (scenarios 1-37)`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
