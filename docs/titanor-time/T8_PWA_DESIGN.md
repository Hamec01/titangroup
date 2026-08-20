# Titanor Time — T8.5–T8.7 PWA Reconciliation + Installation UX

```text
Status: written BEFORE code (2026-08-20)
Scope: T8.5 (manifest) reconciliation, T8.6 (icons) reconciliation, T8.7 (installation UX) — new
Authority: docs/PROJECT_ROADMAP.md T8.5-T8.8, docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md
           Addendum "T7A.10C.1" §C-D (existing PWA shell this slice builds on top of, unchanged)
```

This is a reconciliation-plus-addition slice, not a rewrite. T8.5/T8.6 already have a working
implementation from T7A.10C.1/its FOLLOW-UP — this document records what was verified, what (if
anything) changed, and why. T8.7 (installation UX) is new. **T8.8 (offline for the rest of the
app) is explicitly out of scope for this slice** — see §D.

## §A. T8.5 — Manifest reconciliation

`public/manifest.webmanifest` was audited against the roadmap's own checklist (name, short_name,
icons, start_url, display standalone, theme/background) plus the fuller contract this task adds
(description, scope, background_color, theme_color, icon entries reachable, start_url inside
scope, manifest link present only under `/worker/**`). Verified **by real HTTP requests against a
production standalone build**, not by reading the file and assuming:

- `GET /manifest.webmanifest` → `200`, `Content-Type` contains `manifest` (Next.js's own static
  file serving sets `application/manifest+json` for `.webmanifest`).
- Body parses as valid JSON.
- `name: "Titanor Time — Worker Clock"`, `short_name: "Titanor Time"`, `description` present,
  `start_url: "/worker"`, `scope: "/worker"`, `display: "standalone"`, `background_color:
  "#05070b"`, `theme_color: "#05070b"` — all present, all non-empty.
- `start_url` (`/worker`) is a literal prefix of `scope` (`/worker`) — trivially inside scope
  (equal case). Verified as a string check, not assumed.
- `icons` array has two entries, `192x192` and `512x512`, both `image/png`, both reachable
  (`GET` each `src` → `200`, `Content-Type: image/png`) — no 404s.
- `<link rel="manifest" href="/manifest.webmanifest">` present in the raw HTML of `/worker` and
  the new `/worker/install` (§C below); **absent** from `/admin`, `/foreman`, `/login` — verified
  by fetching each page's HTML directly and checking for the literal tag, not inferred from the
  layout tree. This holds structurally because `metadata.manifest` is declared only in
  `app/worker/layout.tsx`, never in the root layout (`app/layout.tsx` has no `manifest` field) —
  Next.js's metadata resolution only emits the tag for routes under that segment.

**Verdict: `public/manifest.webmanifest` is unchanged, byte-identical.** It already satisfied
every checked requirement; rewriting it would only produce diff noise with zero behavior change,
which the task explicitly says not to do. **T8.5 is closed by the evidence above plus the
permanent regression script (`scripts/_test-pwa-install.ts`, scenarios 4-9), not by a new
implementation.**

## §B. T8.6 — Icon reconciliation

`public/icons/icon-192.png` and `icon-512.png` (from T7A.10C.1, hand-generated via `node:zlib`,
no image-processing dependency) were re-verified:

- Both decode as real PNG (`file` + a manual IHDR parse — width/height/bit-depth/color-type read
  directly from the chunk, not trusted from the filename).
- Declared IHDR dimensions match the filenames exactly: `192×192` and `512×512` — both meet the
  Chrome/Android installability minimum (≥192×192, ≥512×512 present).
- 8-bit RGBA, non-interlaced. Visually inspected (rendered, not just decoded) — a filled blue ring
  and white clock face on an opaque black background, not a blank/fully-transparent canvas.
- Both `manifest.webmanifest` icon URLs resolve `200`/`image/png` — no 404 gap.
- Visual identity unchanged from the existing Titanor Time mark — **not redesigned**, per the
  task's explicit constraint. No logo change.

**Verdict: both files kept byte-identical.** No 192/512 icon problem was found to fix.

**Apple touch icon — a genuine, previously-unclosed gap, closed by addition.** Neither
`app/layout.tsx` nor `app/worker/layout.tsx` declared an `apple-touch-icon` link or
`apple-mobile-web-app-capable` meta tag anywhere in the codebase (confirmed by grep — zero
matches) before this slice. This is a real installability/fidelity gap specifically for iOS
Safari's "Add to Home Screen": without `apple-touch-icon`, iOS falls back to a screenshot of the
page instead of the app mark; without `apple-mobile-web-app-capable`, the installed shortcut opens
inside Safari's browser chrome instead of a standalone window. Both are iOS-specific — the
`manifest.webmanifest` icons/`display: standalone` fields (already correct) are what Chrome/
Android read; iOS Safari historically does not read the web manifest for either of these two
specific behaviors (partial, version-dependent manifest support exists on newer iOS releases, but
`apple-touch-icon`/`apple-mobile-web-app-capable` remain the documented, reliable mechanism and
cost nothing to add correctly).

Closed by adding **one new file**, `public/icons/apple-touch-icon.png` (180×180 — Apple's
documented recommended size for modern devices), derived by **pixel-averaging down from the
existing `icon-512.png`** (box-filter downsample, `node:zlib`-only, no new dependency — same
"hand-rolled instead of a library" principle as the original two icons) — not redrawn, not
reinterpreted. Alpha is flattened onto opaque black before encoding (iOS composites transparent
touch-icon pixels unpredictably; the source art already has an opaque black background, so this
flattening is a safety guarantee, not a visible change). The existing mark already has generous
inset margins around the circle (visible in the original 512×512 art), which doubles as a safe
zone for iOS's own rounded-corner mask — no extra padding needed.

`app/worker/layout.tsx`'s `metadata` gains `icons: { apple: { url: '/icons/apple-touch-icon.png',
sizes: '180x180', type: 'image/png' } }` and `appleWebApp: { capable: true, title: 'Titanor Time',
statusBarStyle: 'black-translucent' }` (dark status bar area, matching the manifest's own
near-black `theme_color`/`background_color` — a coherent choice, not a redesign of anything
visible in-app). Scoped to the worker layout only, same mechanism as the existing `manifest` field
— `/admin`, `/foreman`, `/login` inherit nothing from it (root layout defines no `icons`/
`appleWebApp` for the worker layout to override, so those routes simply have none, exactly as
before).

**No maskable icon variant was added.** Maskable icons address Android's *adaptive icon* shape
masking (a cosmetic concern — the OS crops a non-maskable icon into its own shape, which can clip
content without a defined safe zone) — they are not a Chrome/Android PWA **installability**
requirement; `purpose: "any"` icons at 192/512, which already exist, fully satisfy the
installability criteria the task asks this slice to prove. Since this is not a proven
installability gap (only a possible cosmetic one, and the existing art's generous margins likely
already look acceptable under a circular/squircle mask), it is left for a future slice if actually
found lacking — adding it speculatively would contradict the task's own instruction to add a
derivative "only if it truly closes a proven installability gap."

**Verdict: T8.6 is closed** — the two required icons were already correct and are unchanged; one
new derivative file (`apple-touch-icon.png`) closes a real, specific, previously-open iOS gap
without touching or reinterpreting the underlying mark.

## §C. T8.7 — Installation UX

### C.1 Route and access control

New page: `app/worker/install/page.tsx`, a Server Component under the existing `app/worker/
layout.tsx` (so it inherits the manifest link, SW registration, and the new `viewport`/`icons.
apple`/`appleWebApp` metadata for free — no duplicated wiring). Gate is the exact same pattern
`app/worker/page.tsx` already uses: `resolveServerSession()` → `redirect('/login')` if no
session; `!session.user.roles.includes('WORKER')` → render an "Access denied" fragment (not a
redirect — matches the existing `/worker` convention so ADMIN/FOREMAN sessions get a real, testable
in-page response, not a 3xx). Not linked from `/admin` or `/foreman` navigation, not publicly
reachable without a WORKER-role session — same authorization boundary as the rest of `/worker/**`.

### C.2 Server/Client boundary

The Server Component (`page.tsx`) renders:
1. The session/role gate above.
2. A stable, static SSR shell — heading, a short static paragraph on why installing helps
   (offline cold start, one-tap access, no address bar) — zero per-request personalization beyond
   the gate itself, zero reads of `window`/`navigator`/user-agent (there are none available on the
   server regardless — Next.js Server Components never see them).
3. `<InstallPrompt />` — the one Client Component, imported and rendered as a child. It receives
   **no props at all** (trivially serializable — there is nothing to serialize) and is a plain
   synchronous function component (`'use client'`, not `async`), consistent with the rule that
   Client Components cannot be `async`.

All browser-capability detection (`beforeinstallprompt`, `appinstalled`, `display-mode`,
`navigator.standalone`, user-agent string, `serviceWorker` support) lives *only* inside
`InstallPrompt`, inside `useEffect` — never read during the function body's synchronous execution,
which is what SSR and the first client render both execute. That guarantees the server-rendered
HTML and the first client render are byte-identical (both show the `CHECKING` markup), so React
hydration never has anything to reconcile — no `suppressHydrationWarning` needed, none used.

### C.3 Install state machine

```text
CHECKING
  → (mount effect runs, synchronously) →
     already standalone / navigator.standalone            → INSTALLED
     iOS UA, no `beforeinstallprompt` support at all       → IOS_SAFARI | IOS_OTHER_BROWSER
     not iOS, 'serviceWorker' NOT in navigator              → UNSUPPORTED_OR_UNKNOWN
     not iOS, serviceWorker supported, no prompt (yet)      → ANDROID_OR_DESKTOP_WITHOUT_PROMPT
                                                               (copy varies Android/desktop by UA,
                                                               same component branch)
  → (async, whenever it happens) `beforeinstallprompt` fires → INSTALLABLE (supersedes the
     ANDROID_OR_DESKTOP_WITHOUT_PROMPT guess above — the guess was only ever a fallback for "no
     event yet", not a claim that one will never come)
  → (async) `appinstalled` fires                            → INSTALLED (from any prior state)
```

- **CHECKING**: no button, no claim, identical SSR/first-render markup.
- **INSTALLABLE**: real captured `BeforeInstallPromptEvent`. `event.preventDefault()` is called the
  moment the event is captured (per spec, this is what makes calling `.prompt()` later legal at
  all) — the event is stored in a `useRef`, never in state (state would be a non-serializable,
  re-render-triggering hazard for a live browser object; a ref is the correct primitive for "hold a
  mutable external object without triggering re-renders on its own").
  - `prompt()` is called **only** from the button's `onClick` handler — never on mount, never on a
    timer, never on re-render/navigation. A **synchronous** `useRef<boolean>` guard
    (`promptInFlightRef`) is checked and set to `true` as the very first line of the handler,
    before any `await` — this blocks a second click that lands before React has even scheduled a
    re-render (a plain `useState`-driven `disabled` prop is not fast enough for this: state updates
    are asynchronous/batched, so two clicks in the same tick could both pass a state-based check).
  - After `await event.userChoice`, the captured event reference is cleared
    (`promptEventRef.current = null`) — the browser itself already refuses to prompt the same
    `BeforeInstallPromptEvent` a second time (one-shot by spec), and clearing the ref makes that
    invariant explicit in this code too, not just relied upon implicitly.
  - `outcome === 'accepted'` → move toward `INSTALLED` (the authoritative transition is still the
    real `appinstalled` event, which normally follows very shortly after; the UI shows an interim
    "Finishing installation…" rather than claiming success itself, since `'accepted'` is the user's
    choice, not proof the OS actually completed installation).
  - `outcome === 'dismissed'` → **not** treated as success. Returns to a state that offers the
    manual browser-menu instructions as a fallback, with a plain-language, `aria-live` note that
    installation did not happen and can be retried from the browser's own menu at any time.
- **INSTALLED**: derived from `window.matchMedia('(display-mode: standalone)').matches` (Chromium/
  Android/desktop) `|| navigator.standalone === true` (the historical, still-supported iOS Safari
  standalone flag) checked once on mount, and kept in sync by the `appinstalled` listener for the
  case where installation happens while the tab is already open. Install button is not rendered at
  all in this state; a plain, unambiguous "App is installed" message is shown instead.
- **IOS_SAFARI**: iOS device (see detection below) running Safari itself. No fake install button —
  Safari does not fire `beforeinstallprompt` at all, ever; showing a button that silently does
  nothing on click would be a lie. Numbered manual steps: Share icon → "Add to Home Screen" → "Add"
  — described in text (not solely relying on recognizing Apple's icon glyphs, which vary by iOS
  version and are meaningless to a screen reader).
- **IOS_OTHER_BROWSER**: an iOS device, but the browser is not Safari (Chrome/Firefox/Edge-on-iOS —
  all of these are required by Apple's platform policy to use WebKit under the hood, and **none**
  of them expose "Add to Home Screen" the way Safari does). Copy explains this plainly and tells
  the user to open the same page in Safari to install — makes no claim that any prompt was or will
  be triggered here.
- **ANDROID_OR_DESKTOP_WITHOUT_PROMPT**: not iOS, service worker is supported, but no
  `beforeinstallprompt` has fired (yet, or ever — a given browser/session may simply never fire it:
  already dismissed too many times per browser heuristics, enterprise policy, etc.). Manual
  instructions via the browser's own menu (⋮ / "Install app" / "Add to Home screen" depending on
  browser) — copy varies slightly (mentions "Chrome menu" vs "browser menu") based on a UA check
  for `Android`, purely for wording, not a separate code branch/state. The absence of the event is
  explicitly **not** presented as an application error anywhere in the copy.
- **UNSUPPORTED_OR_UNKNOWN**: `'serviceWorker' in navigator` is false, or the UA doesn't parse into
  any of the above buckets confidently. The app remains fully usable in the browser regardless (no
  feature on `/worker` itself depends on installation) — copy is neutral, makes no promises about
  install steps that may not apply, and does not use alarming language.

### C.4 iPadOS desktop-mode detection

Recent iPadOS defaults to a desktop-style user-agent string containing `Macintosh` with no `iPad`/
`iPhone` token, making naive UA sniffing misclassify a touch iPad as a desktop Mac. Apple's own
documented workaround (used here): `navigator.platform === 'MacIntel' && navigator.maxTouchPoints >
1` — a real Mac laptop/desktop reports `maxTouchPoints === 0` (no built-in touchscreen in the
overwhelming majority of shipped hardware), while an iPad in desktop-UA mode still reports its real
multi-touch digitizer point count. Combined with the classic `/iPad|iPhone|iPod/.test(userAgent)`
check (still correct for iPhone and any iPad still sending its own UA string), this correctly
routes a desktop-mode iPad into the `IOS_SAFARI`/`IOS_OTHER_BROWSER` branches instead of
`ANDROID_OR_DESKTOP_WITHOUT_PROMPT`.

### C.5 Service worker registration outcome — decoupled, one-directional

`components/worker-pwa/ServiceWorkerRegistration.tsx`'s own registration call and its `.catch(() =>
{})` (silently degrade, the online clock must never depend on this succeeding) are **unchanged**.
A new, tiny, dependency-free module, `lib/offline-outbox/sw-registration-outcome.ts`, adds a
module-level "last known outcome" value (`'pending' | 'success' | 'unsupported' | 'error'`) plus a
trivial subscribe function. `ServiceWorkerRegistration` now *also* records its own outcome into
this module (one additional line per branch — the registration logic itself does not change).
`InstallPrompt` is the only other reader — it shows one small, non-blocking `aria-live` note
("Offline mode may not be available in this browser right now") only when the outcome is
`'unsupported'` or `'error'`, and never in any state that already explains something else. This
keeps the dependency **one-directional**: `WorkerClockPanel`, the offline outbox, and
`ServiceWorkerRegistration` itself never import or read anything from `InstallPrompt` or this new
module's *subscribers* — only `InstallPrompt` depends on `ServiceWorkerRegistration`'s output, never
the reverse. Removing `InstallPrompt` entirely would not change the online clock's behavior by a
single line.

### C.6 "Install app" link from `/worker`

`WorkerClockPanel` already renders an optional nav row for `periodsHref`/`historyHref` (`string |
null`, hidden when `null`). A third prop, `installHref: string | null`, is added to the exact same
row, same `wk-back-link` styling, same placement (below the clock card, after any return-reason
notices) — deliberately reusing an existing, already-proven-non-intrusive pattern rather than
inventing new UI. `app/worker/page.tsx` passes `installHref="/worker/install"`;
`app/worker-offline/OfflineShellClient.tsx` passes `installHref={null}` — consistent with why
`periodsHref`/`historyHref` are already `null` there (a link that requires a live navigation to a
route the service worker does not specially handle would just produce a real browser network error
while genuinely offline; the offline shell deliberately avoids offering those). This is the only
change to `WorkerClockPanel.tsx` — a new optional nullable prop and one more conditional `<Link>`,
no change to any Check In/Check Out/Switch Site/offline-outbox logic.

### C.7 CSS

All new rules live under a `.pwa-install-*` class namespace in `app/globals.css` (additive
section, appended — no existing selector is edited or removed). Reuses existing CSS custom
properties (`--text-soft`, `--error`, etc.) already defined elsewhere in the file for color
consistency, but defines no new custom properties and does not touch the global reset/typography
rules.

## §D. Explicitly not in this slice

- **T8.8** (offline read-only fallback for the rest of the Worker screens) — not started when this
  section was written; implemented `[2026-08-20]` in a later addendum to this same document, see
  §F below. `/admin`/`/foreman` remain out of PWA scope entirely, in T8.8 too.
- **Physical device verification** (a real iPhone, a real Android phone) — external acceptance
  gate, per T9.7. Everything in this slice is proven via real HTTP requests and Playwright-driven
  Chromium (with emulated viewports/user-agents where a distinct device class needs to be
  exercised) against a production standalone build. **No claim is made that installation was
  verified on physical hardware.**
- No schema/migration/permission/API change — this slice touches only static assets, one new
  route, one new component, one new tiny pub-sub module, CSS, and metadata.
- No Workbox/next-pwa or other new runtime dependency — `public/sw.js` is unchanged.
- No change to service worker scope (`/worker`, unchanged), fetch strategy, or the offline outbox/
  FIFO/idempotency semantics from T7A.7B/T7A.10C.1.
- No redesign, no localization, no logout/shared-device cleanup policy change (still intentionally
  unimplemented, per T7A.10C.1 §D).

## §E. Testing methodology notes

- `beforeinstallprompt` is injected as a synthetic browser event
  (`window.dispatchEvent(new Event('beforeinstallprompt'))` with `preventDefault`/`prompt`/
  `userChoice` monkey-patched onto the event instance before dispatch) — real Chromium does not
  reliably fire this event under headless/automated conditions regardless of manifest/SW
  correctness, a known, documented Chromium automation limitation, not something a test can wait
  out. The manifest/SW/icon *prerequisites* for a real prompt (valid manifest, registered SW
  controlling the scope, installability criteria) are separately, genuinely verified via real HTTP
  requests and a real SW registration check — the mock only stands in for the specific "Chromium
  internally decided to fire this event" step, which this app's code has no control over.
- WebKit (real iPhone/iPadOS engine emulation via Playwright) was **not** attempted — this host is
  missing the same system `.so` dependencies (`libharfbuzz-icu`, `libepoxy`, `libwayland-*`, etc.)
  documented as absent during T7A.10C.1's own testing, and installing them was out of scope/
  authorization for this task too. iOS-path testing (`IOS_SAFARI`/`IOS_OTHER_BROWSER`) uses
  Chromium with a spoofed `userAgent` matching real iPhone/iPad Safari and Chrome-on-iOS strings —
  this exercises this app's own UA-parsing branches faithfully (the detection logic only reads
  `navigator.userAgent`/`navigator.platform`/`navigator.maxTouchPoints`, all of which Playwright can
  set precisely), but does **not** exercise real WebKit rendering/PWA-install behavior. Documented
  honestly, not presented as "real iOS verified."

---

## §F. T8.8 — Account-bound Offline Read-only Worker Views (2026-08-20)

Written **before** code. Base: `f84c5a4 feat(time): add PWA installation guidance`. This closes
T8.8, and with it, all of ЭТАП 8.

Goal: extend the existing real offline Check In/Out/Switch Site (T7A.7B/T7A.10C.1 — **unchanged by
this addendum**) with a safe, **read-only**, **account-bound** cached view of the rest of the
Worker screens, without ever caching authenticated HTML or API responses, and without ever letting
one browser/device show cached data belonging to a different account.

### F.1 Why two separate storage mechanisms, not one

`Cache Storage` (SW-managed) stays exactly what it already was: one generic, personalization-free
HTML document (`/worker-offline`) plus static assets. It is not, and does not become, a per-route or
per-user cache — there is still only ever one shell document in it. **Personal data belongs only in
IndexedDB**, as small allowlisted DTOs, never as HTML, and never in Cache Storage. This split is
what makes the account-binding check possible at all: Cache Storage has no concept of "whose data is
this", but an IndexedDB record can carry an explicit `ownerUserId`/`deviceInstallationId` pair that
application code checks before rendering anything from it.

### F.2 Account-binding invariants (the security boundary)

A cached read-only view is shown **only if all six of these hold simultaneously**:

1. **Last successfully authenticated browser user** (`deviceState.lastAuthenticatedUserId`) — written
   client-side by the login page immediately after a successful `POST /api/auth/login`, before
   navigating to the home route. The fastest-updating signal; reflects "who is currently logged in
   in this browser", independent of whether any offline bootstrap has run yet.
2. **`ownerUserId` confirmed by a successful attendance-context bootstrap**
   (`deviceState.ownerUserId`) — written only inside `applyContextResponse` after
   `GET /api/worker/attendance/context` returns `200`, from the response's own (new, additive)
   `userId` field. The strongest signal — server-confirmed that *this* `deviceInstallationId`
   legitimately belongs to *this* user's employee record.
3. **`snapshot.ownerUserId`** — set at capture time from the rendering page's own session (always
   accurate for that request — never from IndexedDB, never from a query/body param).
4. **Current `deviceInstallationId`** (`deviceState.deviceInstallationId`).
5. **`snapshot.deviceInstallationId`** — set at capture time from whatever `deviceState` currently
   holds.
6. **Device is not `paused`** (`DEVICE_NOT_OWNED`/`DEVICE_REVOKED`) — a paused device shows its
   existing pause banner (`WorkerClockPanel`, unchanged) instead of any cached view.

All of (1)≡(2)≡(3) and (4)≡(5) must hold, plus (6). Any single mismatch → the view is treated as
**not available for this account**, not as "no data was ever cached" — the UI copy is deliberately
the same safe message either way (§F.6), so a stale-but-foreign snapshot can never be distinguished
from "nothing cached" by an unauthorized viewer.

**Write side is deliberately looser than read side.** Capturing a snapshot only requires a current
`deviceInstallationId` to exist (created eagerly at login, see F.3) — it does **not** require
`ownerUserId` (2) to already be confirmed. `snapshot.ownerUserId` is always the *server session's*
user id at render time, which is unconditionally correct regardless of whether this device has ever
successfully bootstrapped. This means a snapshot is always tagged with the truth at write time; the
6-invariant check is what gates *display*, which is the actual point of attack (an offline viewer
reading someone else's leftover cache), not capture.

### F.3 Login-time marker and bootstrap-time owner binding

`app/login/page.tsx`'s `handleSubmit` already parses `{ user: { id, roles } }` from a successful
login response but previously only used `roles`. It now also calls a new
`recordAuthenticatedUser(userId)` (`lib/offline-outbox/device.ts`) **before** `router.push(target)`,
for **every** successful login (WORKER, ADMIN, FOREMAN alike — not conditioned on role), because the
cross-account rule needs to know when a *non-worker* account logs in too (§F.7). This call is
wrapped so any IndexedDB failure is swallowed — **login itself never fails or slows down because of
it** (per the AUTH SECURITY HOTFIX's own pre-hydration gating, this write happens fully inside the
already-hydrated `handleSubmit` handler, never before hydration, so it cannot reintroduce that
regression). If `deviceState` doesn't exist yet, `recordAuthenticatedUser` creates it (same default
shape `ensureDeviceBootstrapped` would), so a device identity exists as soon as anyone logs in —
`ownerUserId` stays `null` until a real bootstrap confirms it.

`GET /api/worker/attendance/context`'s response gains one additive field, `userId: string` — the
caller's own `authenticated.user.id`, already resolved from the session (never from a query/body
param — no new information is disclosed that the session didn't already establish; this is not a
new permission). `applyContextResponse` (`lib/offline-outbox/device.ts`) sets
`deviceState.ownerUserId = wire.userId` on every successful `200` response, alongside its existing
`bootstrapped`/`nextDeviceSequence`/`contextAssignments` updates.

**Legacy v1 `deviceState` rows** (migrated to v2 without ever having `ownerUserId`) read as
`ownerUserId: undefined` — the account-binding check treats `undefined`/`null` as an automatic
mismatch, so a legacy row is `unbound` and shows no snapshots until one successful online bootstrap
sets `ownerUserId` for the first time. No special-case code needed — this falls out of the same
equality check as every other mismatch.

### F.4 IndexedDB v1 → v2

`DB_NAME`/`STORE_CLOCK_OUTBOX`/`STORE_LOCAL_CLOCK_STATE`/`STORE_DEVICE_STATE` are **not** renamed or
recreated. `DB_VERSION` becomes `2`. The `onupgradeneeded` handler keeps its existing
`if (!db.objectStoreNames.contains(...))`-guarded creation of the three v1 stores completely
unchanged (a fresh v2 install still creates all three, byte-for-byte the same shape as before) and
adds one new object store:

```text
STORE_WORKER_READ_SNAPSHOTS = 'workerReadSnapshots', keyPath: 'key'
  index 'by-capturedAt' on 'capturedAt' (non-unique) — used only by the bounded LRU eviction
  (getAll() + JS sort would also work at this record count, but the task explicitly permits this
  index and it is the more idiomatic/efficient way to find "the oldest N" without loading
  everything into memory).
```

Two new **optional** fields are added to `DeviceStateRecord` (`ownerUserId: string | null`,
`lastAuthenticatedUserId: string | null`) — this is a TypeScript-level, not IndexedDB-level, change
(IndexedDB itself is schemaless per-record; adding an optional field to the interface does not
require an upgrade step by itself). Existing v1 rows simply read these two fields as `undefined`
until the write paths above populate them — exactly the "legacy row is unbound" behavior §F.3
describes, verified by an explicit real-v1-fixture-upgraded-to-v2 test (§F.11 #2/#18).

**What v1→v2 must preserve byte-for-byte** (upgrade only ever *adds* a store; it never touches rows
in the three existing stores): every `clockOutbox` row regardless of `state`
(`PENDING`/`SENDING`/`FAILED_TERMINAL`/`ACKED`), `deviceState.deviceInstallationId`/
`nextDeviceSequence`/`contextAssignments`/`paused`, and `localClockState`. The upgrade handler
performs **zero** reads/writes against the three existing stores — it only calls
`db.createObjectStore(STORE_WORKER_READ_SNAPSHOTS, ...)`, which cannot alter existing store contents
by construction. This is the safest possible upgrade shape and is why it's chosen over any kind of
data migration/rewrite of the existing rows.

### F.5 Snapshot record shape, allowlist, and bounds

```ts
interface WorkerReadSnapshotRecord {
  key: string;              // deterministic — see F.6
  routeKind: SnapshotRouteKind;
  payloadVersion: 1;
  ownerUserId: string;
  deviceInstallationId: string;
  capturedAt: string;       // ISO, client clock — UX-only, never authoritative (§F.9)
  payload: <allowlisted DTO, one shape per routeKind — see F.6>;
}
```

**Bounds (documented, enforced in code, not just convention):**

- `MAX_SNAPSHOT_PAYLOAD_BYTES = 16384` (16 KiB) — `JSON.stringify(payload).length` measured before
  write; over the limit → the write is skipped entirely (fail closed, no partial/truncated record),
  logged nowhere (no console output that could itself leak anything).
- `MAX_SNAPSHOT_RECORDS = 40` — a global cap across all owners/routes on this device. Before
  inserting a record that would push the total over 40, the oldest record by `capturedAt` (via the
  `by-capturedAt` index, one cursor step) is deleted first, inside the **same** read-write
  transaction as the insert — the eviction and the write are atomic together, and neither this nor
  any other snapshot operation ever runs a non-IDB `await` (a network call, a timer, a promise not
  backed by an IDBRequest) while a transaction is open, which is the classic way to have IndexedDB
  silently auto-close a transaction mid-operation.
- Eviction only ever targets `STORE_WORKER_READ_SNAPSHOTS` — the eviction routine's transaction
  scope is `[STORE_WORKER_READ_SNAPSHOTS]` only, structurally unable to touch the other three
  stores.

**Forbidden in the payload, enforced by the TypeScript allowlist types themselves (no field a
snapshot type doesn't declare can ever be spread into it) plus a runtime scan in the permanent test
suite**: session token/cookie, raw GPS, `latitude`/`longitude`/`accuracy`, `payloadHash`,
`requestId`, `deviceSequence`, password/email/phone, any server DTO passed through unfiltered, HTML,
or an unknown nested metadata blob. Every snapshot payload type below is a hand-picked, flat-ish
subset — never `...spread` of a raw server DTO.

### F.6 Route → snapshot mapping

| Route | `routeKind` | Key | Payload (allowlisted) |
|---|---|---|---|
| `/worker/periods` | `periods-list` | `${ownerUserId}:periods-list` | `{ periods: { id, startDate, endDate, timesheetId, timesheetStatus }[] }` |
| `/worker/history` | `history-list` | `${ownerUserId}:history-list` | `{ timesheets: { id, startDate, endDate, timesheetId, timesheetStatus }[] }` |
| `/worker/periods/:id` | `period-detail` | `${ownerUserId}:period-detail:${periodId}` | `{ periodId, startDate, endDate, timesheetStatus, editable, assignments: { id, siteName, workAreaName, templateName, isPrimary }[], returnReasons: SnapshotReturnReason[] }` |
| `/worker/periods/:id/hours` | `hours-list` | `${ownerUserId}:hours-list:${periodId}` | `{ periodId, startDate, endDate, timesheetStatus, editable, days: { date, dayType, confirmedZero, totalMinutes, siteNames: string[] }[], returnReasons }` |
| `/worker/periods/:id/hours/:date` | `day-detail` | `${ownerUserId}:day-detail:${periodId}:${date}` | `{ periodId, date, dayType, confirmedZero, timesheetStatus, segments: { startAt, endAt, siteName, workAreaName, breaks: { startAt, endAt, paid }[] }[], returnReasons }` |
| `/worker/periods/:id/submit` | `submit-summary` | `${ownerUserId}:submit-summary:${periodId}` | `{ periodId, startDate, endDate, timesheetStatus, workedDaysCount, totalDaysCount, totalMinutes, returnReasons }` |
| `/worker/install` | *(none)* | *(none)* | data-free static offline notice — no business snapshot needed or captured, matches this route's existing zero-personalization design (T8.7 §C.1) |
| `/worker`, `/worker-offline` | *(none — pre-existing)* | *(none)* | unchanged real offline clock (T7A.7B/T7A.10C.1), not a snapshot at all |

`SnapshotReturnReason = { scopeType, siteName, contextSiteName, reason, returnedAt }` — a deliberate,
explicit subset of `ReturnReasonView` (drops `scopePurpose`/`siteId`/`contextSiteId`, which the
existing `ReturnReasonsNotice` component doesn't even read).

The read side parses `window.location.pathname` with a small matcher (mirrors the six patterns
above, one regex each) to recover `{ routeKind, periodId?, date? }`, then builds the same key format
with the account-binding-confirmed `ownerUserId` — capture and lookup can never disagree on key
shape because both go through one shared `buildSnapshotKey()` function.

### F.7 Cross-account behavior (each bullet is its own test, §F.11 group B)

- **A → logout → B, A's outbox empty**: device may still pass the *existing* safe rotation
  (`ensureDeviceBootstrapped`'s `DEVICE_NOT_OWNED` + empty-outbox branch, unchanged). Rotation
  assigns a **new** `deviceInstallationId`, which alone already makes every one of A's snapshots
  fail invariant (4)≡(5); `ownerUserId` also becomes `B` on B's subsequent successful bootstrap.
- **A → logout → B, A has pending/failed outbox events**: nothing is deleted — outbox, device row,
  and A's snapshots all persist untouched. B's own bootstrap attempt gets `DEVICE_NOT_OWNED` and (
  since the outbox isn't empty) the device **pauses** instead of rotating — B sees the existing pause
  banner on `/worker` explaining a device conflict, and any offline view B tries to open shows the
  same safe "not saved for offline viewing yet" message (§F.9) as a device with nothing cached at
  all — `lastAuthenticatedUserId` is `B` but `ownerUserId` is still stale `A`, an automatic
  mismatch. Resolution path (unchanged from T7A.10C.1): log back in as A once, online, to flush the
  queue.
- **Worker → ADMIN/FOREMAN login on the same browser**: `recordAuthenticatedUser` still runs (it's
  role-agnostic) and sets `lastAuthenticatedUserId` to the admin/foreman's own user id — this alone
  makes every worker snapshot's `ownerUserId` mismatch invariant (1)≡(3), regardless of what
  `deviceState.ownerUserId` says. Worker snapshots are never reachable through `/admin`/`/foreman`
  UI anyway (PWA/offline code doesn't exist there at all — §F.10), so this is defense-in-depth for
  the case where the SAME physical device later has a worker session again without ever revisiting
  `/worker` to refresh the binding. The pending worker outbox is untouched by an admin/foreman login.
- **`DEVICE_NOT_OWNED`/`DEVICE_REVOKED`**: outbox preserved, snapshots not shown (invariant 6),
  never an automatic destructive cleanup of anything.
- **No network / a `401`**: never deletes outbox or snapshots, never reattributes existing local data
  to whichever account happens to be current.
- **No hidden auto-delete of pending outbox is ever introduced under the guise of "logout cleanup"**
  — there still isn't a logout-cleanup feature at all (T7A.10C.1 §D's own stance, unchanged).

### F.8 Snapshot capture — Server → Client boundary

Each of the six Server Component pages in §F.6 (unchanged in their own authoritative DB reads/output
— **zero new Prisma queries added for this feature**, every field in every payload above is a subset
of data the page already fetched for its own rendering) now additionally renders one small new
Client Component, `<SnapshotWriter kind="..." payload={...} />`
(`components/worker-pwa/SnapshotWriter.tsx`), as a sibling to the existing page content. `payload` is
the exact allowlisted object from §F.6, built inline in the Server Component right before return —
plain object literals of strings/numbers/booleans/nulls (every source field was already a string by
the time these pages read it — `formatDate()`/`SegmentView`/`ReturnReasonView` are already
string-typed, so no `Date`-to-string conversion was even needed here, unlike a hypothetical page that
still worked with raw `Date` objects). `SnapshotWriter` takes no other props, is not `async` (it's a
plain synchronous function component, same rule as `InstallPrompt`), does no HTTP fetch of any kind,
and its `useEffect` write is wrapped so a failure (IndexedDB unavailable, quota, anything) never
throws into the page — the online page's own rendering and content are completely unaffected either
way; this is a pure "while you're here, remember this for later" side effect.

### F.9 Stale-data / read-only semantics

Every offline read view (rendered by the shell's client code once it determines
`window.location.pathname` matches one of the six known routes and the account-binding check
passes) shows, verbatim: **`Offline — read-only`**, **`Last updated: <capturedAt, localized>`**, and
a **`Reload when online`**/`Try again` action plus a link back to `/worker`. It never recomputes
totals from the cached data as if fresh, never labels the cached status "current" without the
`Offline — read-only` qualifier, and renders **zero** editable inputs, **zero** Save/Submit controls,
and **zero** mutation-confirmation text — the day-detail view in particular reuses none of
`DayEditor.tsx` (that component's whole purpose is editing; the offline view is a distinct, simpler,
read-only renderer over the same segment shape). The **only** exception, as before, is the real
attendance clock (`/worker`, `/worker-offline`) — its actions are durably queued in the outbox and
this addendum does not touch that code path.

If no snapshot exists for the resolved key (never visited online yet, evicted by the bounded LRU, or
the account-binding check failed) the view shows exactly: *"This page has not been saved for offline
viewing yet. Connect and open it once."* plus the link to `/worker` — never a fabricated empty list,
never the browser's own network-error page.

### F.10 Service worker navigation algorithm

```text
navigate to "/worker" or "/worker-offline":
  unchanged from T7A.10C.1/its FOLLOW-UP — network-first, cached-shell-on-exception-only.

navigate to a KNOWN /worker/** UI route (periods, periods/:id, periods/:id/hours,
periods/:id/hours/:date, periods/:id/submit, history, install — matched structurally, not by an
exact path list, since :id/:date are arbitrary):
  network-first — the real response (including a genuine 401/403/404/409/500) is always returned
  exactly as received, NEVER replaced.
  ONLY on an actual fetch() exception (offline, DNS failure, connection reset — no HTTP response was
  received at all) → caches.match('/worker-offline') (the same single cached shell as before).

any other navigation (/admin/**, /foreman/**, /login, any /worker/* path not in the known list,
anything else): unchanged — never intercepted, real network request, real browser error on failure.

non-GET, /api/**, RSC/data requests: unchanged — never touched, structurally not reachable by any
branch above.
```

The browser preserves the **original requested URL** in `window.location`/the address bar when a
service worker serves a cached response for a navigation — only the response *body* comes from the
cache, not the URL. This (standard, spec-defined SW behavior, not a trick) is exactly what lets the
shell's client code read `window.location.pathname` and know it was asked for
`/worker/periods/abc123` even though the HTML it's hydrating is the generic cached shell document.

**Cache version bump.** `CACHE_VERSION` moves `v1` → `v2` (SW behavior changed — the navigation
allowlist grew), so `CACHE_NAME` becomes `titanor-time-worker-shell-v2`. The existing
namespace-isolation `activate` handler (T7A.10C.1 FOLLOW-UP — delete only keys starting with
`CACHE_PREFIX` that aren't the current `CACHE_NAME`) needs no code change at all to correctly evict
the old `v1` entry while leaving any foreign, non-prefixed cache untouched — the prefix-based
deletion logic was already version-agnostic. `lib/offline-outbox/pwa-warm-cache.ts`'s own duplicated
`CACHE_NAME` literal (it cannot import from `public/sw.js`, a raw unbundled script — same reason the
two files already duplicate `isSafeToCache`) is bumped to the identical `'titanor-time-worker-shell-v2'`
string in the same commit. A permanent test (§F.11 #59) extracts both literals via source-text regex
and asserts equality, specifically to catch any future edit that updates one file and not the other.

### F.11 Testing, documentation, and everything else

Full scenario list, test counts, regression results, and technical-check evidence are in this
session's own final report (not duplicated here) — this section only records the *design* decisions
a future reader needs, per this addendum's own header goal.

### F.12 Explicitly not in this sub-slice

- `/admin`/`/foreman` remain completely outside PWA/offline scope — no manifest, no SW control, no
  snapshot capture, no read-only views. Structurally impossible, not just unimplemented (SW `scope`
  is still `/worker`, unchanged).
- No change to `ClockEvent`/`ClockShift`/materializer, FIFO/`deviceSequence`/idempotency, geofence
  evaluation, or the scheduler — the real offline clock mutation path is untouched end to end.
- No Prisma schema/migration/permission change. The one API surface change
  (`GET /api/worker/attendance/context` gaining `userId`) is additive, reuses the existing
  `attendance.clock.read.own` permission, and discloses nothing the session didn't already establish.
- No logout/shared-device cleanup policy change — still intentionally unimplemented (T7A.10C.1 §D).
- No redesign — all new CSS lives in two new, additive namespaces (`.wk-snap-*` for the read-only
  views, `.wk-connectivity-*` for the shared banner), no existing rule edited.
- Physical device installation/offline testing remains the external T9.7 acceptance gate.

**With this addendum, ЭТАП 8 (T8.1–T8.8) is fully complete.** Next recommended step: ЭТАП 9
(internal functional test/audit), per `docs/PROJECT_ROADMAP.md`.
