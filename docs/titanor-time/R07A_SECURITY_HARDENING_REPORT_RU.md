# R07-A — Security hardening & API robustness (Titanor Time)

- **Основание:** production release roadmap R07 (Titanor Time часть), ТЗ §16.1. Продвигает
  блокеры B08 и B11.
- **Дата:** 2026-08-30.
- **Не затронуто:** production, live public site, Caddy, Cloudflare DNS, схема ролей/permissions,
  бизнес-логика, UI. Одна аддитивная миграция (**97** — `RateLimitCounter`). Пилот **не
  переразвёртывался** этим этапом.
- **R07-B (публичный сайт)** — вынесен в отдельный заход (решение владельца): admin login
  rate-limit, timing-safe пароль, CSRF logout, contact SMTP timeout, uploads
  magic-byte/size/re-encode/nosniff/path-traversal.
- **Commits:** `899862c` (A) · `8f3795f` (B) · `c413748` (C) · `ecfb302` (guard helper + auth routes).

---

## Итог по ТЗ §16.1

| требование | статус |
|---|---|
| Централизовать auth/permission checks | 🟡 `lib/api-guard.guardApiRequest` создан + это обязательный паттерн; мигрированы `/api/auth/{session,logout,logout-all}`. Полная миграция 135 маршрутов — R07-A.1 (пошагово, с ревью каждого; слепой codemod даёт риск неверного `csrf`/permission). |
| Сохранить CSRF для всех mutations | ✅ покрытие 100% (90/90 mutating routes) — было и остаётся; централизовано в guard для мигрированных |
| Rate limit не зависит от недоверенного первого `X-Forwarded-For` | ✅ **B08** — `lib/client-ip.ts`, rightmost-minus-hops |
| Доверять proxy headers только от Caddy | ✅ `TITANOR_TRUSTED_PROXY_HOPS` (default 1); `CF-Connecting-IP`/`X-Real-IP` не читаются |
| Shared rate limiting перед масштабированием >1 инстанса | ✅ **B08** — DB-backed `RateLimitCounter`, атомарный upsert, multi-instance + restart-safe |
| Не логировать tokens/cookies/hashes/GPS/персональные коды | ✅ уже соответствует — аудит ниже (§5) |
| Безопасные диагностические error codes для scheduler | ✅ сделано в R06-A |
| валидировать UUID/input до Prisma, безопасный 4xx не P2023/500 | ✅ **B11** — `lib/api-guard.requireUuidParam`, 26 маршрутов |
| убрать `x-powered-by`, production security headers, noindex/robots | ✅ **A** |
| безопасные global error/not-found | ✅ **A** |

**PASS-критерий R07** (negative/security regression tests проходят; malformed input не даёт 500;
rate-limit нельзя обойти подменой первого forwarded IP) — **выполнен** (§4).

---

## 1. Slice A — security headers, noindex, safe error/not-found (`899862c`)

`next.config.mjs`: `poweredByHeader: false` + блок на `/:path*`:

| header | значение |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (приложение никогда не встраивается) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | `geolocation=(self)` (worker PWA), всё остальное `()` |
| `Strict-Transport-Security` | `max-age=63072000` |
| `X-Robots-Tag` | `noindex, nofollow` |

`app/robots.ts` → `Disallow: /`; root `metadata.robots` noindex.
`app/error.tsx` / `app/global-error.tsx` / `app/not-found.tsx` — двуязычные, self-contained
(AppLocaleProvider только в section-layout'ах), **никогда** не рендерят `error.message` / stack,
только безопасный `error.digest`.

Проверено на собранном приложении: все 7 заголовков на `/login`, нет `X-Powered-By`,
`/robots.txt` = `Disallow: /`, 404 отдаёт 404.

## 2. Slice B — trusted-proxy client IP + shared DB rate limiter (`8f3795f`, миграция 97) — B08

### `lib/client-ip.ts`
`X-Forwarded-For` — цепочка слева-направо `[origin client, proxy1, proxy2, …]`, каждый proxy
**добавляет справа** свой view непосредственного downstream-пира. При N доверенных proxy реальный
клиент — элемент на позиции N от конца: `xff[xff.length - N]`. Всё левее — управляемо клиентом и
никогда не доверяется.

| окружение | цепочка | `TITANOR_TRUSTED_PROXY_HOPS` |
|---|---|---|
| pilot | browser → Caddy (127.0.0.1) → app | **1** (default) |
| production (с R11) | browser → Cloudflare → Caddy → app | **2** — переключается env, без правки live-Caddy |

`CF-Connecting-IP` / `X-Real-IP` **не читаются** — на R11 Caddy настраивается с
`trusted_proxies_strict` + официальными Cloudflare CIDR, и производимый им XFF уже корректен;
этому модулю нужен только hop count. Слишком короткая цепочка (прямой запрос / мисконфиг) →
`{ ip: null, chainTooShort: true }`. Заменил 7 per-route `clientIp()` (каждый брал `.split(',')[0]`
— уязвимый leftmost).

### `lib/rate-limit.ts` + `RateLimitCounter`
`checkRateLimit` стал `async`, одна строка Postgres на ключ, весь инкремент — один атомарный
`INSERT … ON CONFLICT DO UPDATE` (корректно между инстансами, переживает рестарт — в отличие от
прежней in-memory Map). Fixed-window семантика без изменений. **Fail-OPEN** при ошибке БД
(лимитер не должен ронять приложение; защищаемые операции всё равно требуют ту же БД).
Оппортунистический GC истёкших строк (2% вероятность). 14 вызовов переведены на `await`.

## 3. Slice C — UUID/input validation до Prisma (`c413748`) — B11

`lib/api-guard.ts`: `isUuid()` + `requireUuidParam(value, notFound, requestId)` → отдаёт **тот же
`<ENTITY>_NOT_FOUND` 404**, что маршрут уже использует (malformed id неотличим от valid-but-missing),
вместо того чтобы не-UUID дошёл до Prisma и вызвал P2023 → 500. Паттерн lenient (любой hex в форме
8-4-4-4-12 — ровно то, что принимает `::uuid` cast), чтобы корректный не-v4 id не давал ложный 404.

Применено к 26 динамическим маршрутам, которые передавали непроверенный `[id]` прямо в lib/Prisma
(corrections, export-batches, review-scopes, timesheets, period/site reports —
admin/foreman/worker). 49 уже валидировавших маршрутов не тронуты.
`foreman/attendance/exceptions/[exceptionId]/edit` намеренно оставлен — он 403'ит до касания id.

## 4. Slice D — централизация auth/CSRF guard (`ecfb302`)

`lib/api-guard.ts` `guardApiRequest(request, { csrf?, permission?, anyPermission? })` →
`{ ok:true, session, requestId } | { ok:false, response }`. Одна точка для повторяющегося блока:
fresh requestId → CSRF header → сессия (401 `NOT_AUTHENTICATED`) → permission (403 `FORBIDDEN`).
Route-специфичные проверки (ownership, `NO_EMPLOYEE_PROFILE`, доменное состояние) остаются в
маршруте после `const { session, requestId } = guard`. Конверты / коды / сообщения **байт-в-байт**
как во всех inline-проверках до R07-A.

Мигрированы (вручную, с проверкой): `/api/auth/session`, `/api/auth/logout`, `/api/auth/logout-all`.

**Полная миграция 135 маршрутов — R07-A.1.** Слепой codemod был написан и отклонён: часть mutating
routes использует многострочную форму `jsonError(403, …CSRF_REJECTED…)`, которую регексп codemod'а
не распознавал → риск проставить `csrf: false` на mutating route (регрессия безопасности). Правильный
путь — пошаговая миграция с ревью каждого маршрута, естественно совмещаемая с R09 (UX-этап всё равно
трогает большинство этих маршрутов). До тех пор `guardApiRequest` — обязательный паттерн для новых
и изменяемых маршрутов; немигрированные маршруты не изменены и делают те же проверки inline.

## 5. Log sanitization audit (ТЗ §16.1) — уже соответствует, изменений нет

Всего **3** `console.*` в `app/` + `lib/` (не считая тестов):

| место | что логирует | вердикт |
|---|---|---|
| `app/api/ready/route.ts:35` | `readiness: not ready (<reason>)` — enum | ✅ (R06-A) |
| `app/api/admin/workers/[employeeId]/dossier/route.ts:59` | `{ requestId, employeeId }` (UUID) | ✅ |
| `lib/employee-profile.ts:774` | best-effort cleanup fail: `{ qualificationId, path, error }` | ✅ путь хранилища, не из списка ТЗ |

Ни одна строка не логирует **tokens / cookies / password hashes / GPS / персональные коды**
(явный список ТЗ). Scheduler `logSafe` (R06-A) эмитит только `event`/`outcome`/`errorCode`/счётчики.
`process.stderr.write` в scheduler-runtime — только фиксированный FATAL-текст про интервал.

## 6. Тесты (PASS-критерий R07)

| тест | lane | проверок | что покрывает |
|---|---|--:|---|
| `_test-client-ip.ts` | unit | 26 | rightmost-minus-hops, **отклонение поддельного leading XFF**, прямой запрос, CF+Caddy цепочка, env-парсинг hops |
| `_test-rate-limit-db.ts` | db | 13 | window limit/reset, изоляция ключей, **30 конкурентных инкрементов атомарны**, GC |
| `_test-malformed-uuid.ts` | db | 14 | garbage `[id]` (вкл. SQL-строку) → 404 не 500, на 4 маршрутах + control valid-but-missing |
| `_test-api-guard.ts` | db | 17 | guard: CSRF / auth / single+array+any permission gates; `/api/auth/{session,logout,logout-all}` |

**PASS-критерий:**
- negative/security regression tests проходят — ✅ (70 новых проверок)
- malformed input не даёт 500 — ✅ (`_test-malformed-uuid`: 404, не 500)
- rate-limit нельзя обойти подменой первого forwarded IP — ✅ (`_test-client-ip`: «forged leading
  XFF is ignored» — берётся Caddy-appended rightmost)

**Полный прогон (clean env):** typecheck 0 · lint ok · unit **13** · db **57** · scheduler **5** ·
`npm run build` ✓ · миграция 97 с нуля чисто. CI (`139221d`, run 33316873965): **6/6 job success**.

## 7. Открытые пункты / для R11 и R14

- **R07-A.1** — миграция остальных ~130 маршрутов на `guardApiRequest` (пошагово, с ревью).
- **R07-B** — публичный сайт (отдельно, решение владельца).
- **R11 (Caddy для `app.titanorgroup.fi`)**: `trusted_proxies_strict` + официальные Cloudflare CIDR
  + очистка поддельных forwarded-заголовков; затем `TITANOR_TRUSTED_PROXY_HOPS=2` в env приложения.
  Нужны тесты: прямой запрос, поддельный XFF, цепочка Cloudflare → Caddy.
- **R14**: прод-scheduler (`sh -c npx tsx`, старый образ) — та же SIGKILL/stale-lease хрупкость
  (см. R06-B.1); прод-БД 42 миграции (B07) — замена на pilot целиком.
- Преждевременный schema drift: `CompanyAttendancePolicy.cutoffTime @default(dbgenerated(…))` не
  выставлен ни одной миграцией — безвредно (`migrate deploy` не затрагивает), пометка для R14.
