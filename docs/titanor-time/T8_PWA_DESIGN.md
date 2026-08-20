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

- **T8.8** (offline read-only fallback for `/admin`/`/foreman`/other worker screens) — not started,
  next separate slice.
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
