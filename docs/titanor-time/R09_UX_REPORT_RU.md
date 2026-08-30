# R09 — UX WORKER / ADMIN перед production (Titanor Time)

- **Основание:** production release roadmap R09, ТЗ §13 (worker), §15 (admin/super-admin), §19.2–19.4.
  Аудит и план — `R09_UX_AUDIT_AND_PLAN_RU.md`. Browser-чек-лист — `R09_BROWSER_ACCEPTANCE_RU.md`.
- **Дата:** 2026-08-30.
- **Объём (сужен владельцем 2026-08-30):** R09.1, R09.2, R09.5, R09.6, R09.7, R09.8, R09.10, R09.11.
  **FOREMAN UI полностью исключён** (заказчик не обговаривал) — R09.3 / R09.4 и любые правки прораба
  не входят. **R09.9** (split крупных admin-модулей) — не делаем, в backlog. Объединение карточки
  работника в один табовый экран — backlog после production.
- **Не затронуто:** production Titanor Time, публичный сайт, Caddy, DNS, Cloudflare. **Ни одной
  миграции** — R09 чисто UI/навигация/i18n + одна экстракция клиентского компонента; бизнес-логику
  клок-ина, табелей, прав не меняли.
- **Статус:** код готов, CI зелёный. **Один pilot-деплой** (image swap, БД не меняется) — по
  отдельному подтверждению владельца; агент не запускает.
- **Commits:** `d5a8d24` (R09.1) · `f0e081f` (R09.2) · `b6f052c` (R09.5) · `6099e6b` (R09.6) ·
  `7184aaa` (R09.7) · `fe33e31` (R09.8) · этот коммит (R09.11).

---

## Итог по ТЗ

| требование | было | стало (R09) |
|---|---|---|
| §15 «Список пользователей: поиск / фильтры / страницы» | `/admin/users` — только `role`, без q/email/status, без UI пагинации | R09.1 — форма фильтров (поиск по username **или** email без регистра, роль, статус), URL-persist, пагинация prev/next, ленивый парсер (мусор игнорируется) |
| §13 + §15 «Понятные причины запрета вместо permission-кодов» | 13 admin-страниц печатали `Access denied — this page requires the <x.y.z> permission` | R09.2 — `AccessDeniedNotice` / `accessDeniedText(area, locale)`: короткий человеческий RU/EN текст + один следующий шаг; **код не в тексте**, только в `title` / `data-permission` для поддержки |
| §15 «Task-center: критические категории» | «истекающие/просроченные документы» — только в notification bell | R09.5 — `getDocumentAttentionSummary`: clickable-карточка на `/admin` (нужно внимание → `/admin/workforce?sort=ATTENTION`, истекает скоро → `?status=EXPIRING_SOON`); скрыта, если 0/0; только admin-путь `OverviewView` |
| §19.3 «Без горизонтального overflow, mobile-first» | 11 admin-таблиц без scroll-обёртки; шапка `/admin` распирала страницу; нет глобального `overflow-x` guard | R09.6 — `html,body { overflow-x: hidden }`, 12 таблиц в `.worker-table-scroll`, `.admin-identity { min-width:0; overflow-wrap:anywhere }`, `.admin-header-actions { flex-wrap:wrap }` |
| §13 «Разделить крупный clock UI на части без изменения поведения» | `WorkerClockPanel.tsx` — 1160 строк в одном клиентском компоненте | R09.7 — `app/worker/clock-panel/`: `format.ts` (чистые хелперы + типы) + `GpsNotices` / `WorkerStatusCard` / `MainClockAction` / `TimeCardPreview` / `ClockOverlays` (4 шита). Панель = 951 строк, вся логика/эффекты/рефы на месте. **Ноль изменений поведения** (SSR-тест + build) |
| §15 «Единая карточка работника» (сужено до «навести порядок») | 4 отдельные страницы с 4 разными back-ссылками; профиль не показывал, чей он; дубли ссылок в «быстрых действиях» | R09.8 — общий `WorkerCardNav`: крошки `Работники › Имя` + ряд из 4 вкладок (текущая — `aria-current="page"`, не ссылка). Страницы остаются раздельными. «Быстрые действия» почищены, устаревшие i18n-строки удалены |
| §19.2 «guardApiRequest on-touch, без blind codemod» | — | R09.10 — **R09.1–R09.8 не тронули ни одного `app/**/route.ts`** (только server components, lib-хелпер, CSS, i18n, client split). Rollout не применяется. См. §3 |
| §19.4 «Тесты по изменённым сценариям + browser-чек-лист» | — | R09.11 — 4 новых test-файла (unit+db), browser-acceptance чек-лист по 4 viewport + клавиатура/a11y |

---

## 1. Что сделано по слайсам

### R09.1 — `/admin/users` поиск + фильтры + страницы (`d5a8d24`)
- `lib/users.ts`: `parseUserListQuery` (ленивый — плохой `page`/`pageSize`/`role`/`status`
  игнорируется, `q` тримится и режется до 200, `role`/`status` без учёта регистра), `listUsers`
  `where` расширен `q` (username **OR** email, `insensitive`) и `status`; `roleNamesForFilter` — любая
  из FOREMAN/ADMIN/SUPER_ADMIN.
- `app/admin/users/page.tsx` — переписан на `searchParams` + форма `GET` (`.ov-filters`), таблица в
  `.worker-table-scroll`, `.exc-pagination` prev/next с сохранением q/role/status/pageSize.
- SYSTEM и «только WORKER» аккаунты по-прежнему исключены; `item.roles` — полный активный набор.
- **Тест:** `_test-admin-users-list.ts` (db, 23) — парсер + фильтры + пагинация + исключения.

### R09.2 — человеческие причины запрета (`f0e081f`)
- `lib/i18n/access-denied.ts` — `AccessDeniedArea` (`overview` / `reports` / `exports` /
  `attendance-issues` / `attendance-policy` / `workforce` / `setup` / `admin`), `accessDeniedText`
  RU/EN, каждый — короткий текст + «обратитесь к SUPER_ADMIN».
- `components/admin/AccessDeniedNotice.tsx` — `<p role="alert" title={permission} data-permission={permission}>`
  (код доступен поддержке, не пользователю).
- 13 admin-страниц переведены; неиспользуемые импорты `localeText` убраны. **FOREMAN-страницы не
  трогали** (вне объёма R09).
- **Тест:** `_test-access-denied-notice.ts` (unit, 58) — regex `\b[a-z]+(\.[a-z]+){2,}\b` доказывает,
  что кода в тексте нет; RU≠EN; fallback.

### R09.5 — «документы, требующие внимания» в task-center (`b6f052c`)
- `lib/document-attention.ts` — `getDocumentAttentionSummary(today)`: активные работники (окно
  `[startDate,endDate]` покрывает сегодня), статус квалификации из `computeQualificationExpiryStatus`
  (те же границы, что `lib/qualification-expiry`). `EXPIRED` / `CRITICAL` / `MISSING_EXPIRY` →
  `workersNeedingAttention`; `EXPIRING_SOON` → `workersExpiringSoon`; работник считается один раз,
  «нужно внимание» перекрывает «скоро».
- `OverviewView` — `DocumentAttentionCard` (только admin-путь `AdminTodayBody`), `null` при 0/0.
- **Тест:** `_test-document-attention.ts` (db) — работники A–H, ожидание 4 / 1.

### R09.6 — overflow / mobile sweep WORKER + ADMIN (`6099e6b`)
- `app/globals.css`: `html, body { overflow-x: hidden }`; `.admin-identity` → `min-width:0;
  overflow-wrap:anywhere`; `.admin-header-actions` → `flex-wrap:wrap`.
- 12 таблиц `worker-table` в 11 файлах обёрнуты в `.worker-table-scroll` (`sites`, `periods`,
  `workers`, `assignments`, `corrections`, `corrections/[id]`, `timesheets`, `review-scopes`,
  `timesheets/[id]`, `review` ×2, `cities/CityList`). Разметка/поведение не менялись. **FOREMAN не
  трогали.**

### R09.7 — WorkerClockPanel split (`7184aaa`)
- `app/worker/clock-panel/format.ts` — `assignmentKey` / `formatDuration` / `formatHelsinkiTime` /
  `outboxGpsFields` / `resolveGpsUiState` (байт-в-байт) + типы `StatusMessage` / `GpsUiState` /
  `ZoneStatus` / `ClockPanelAssignment` / `WorkerWeekActivity` / `WorkerWeekDayActivity`.
- `GpsNotices` (3 баннера) · `WorkerStatusCard` · `MainClockAction` (+ таймер) · `TimeCardPreview`
  (+ недельная сетка) · `ClockOverlays` (`AssignmentSheet` / `SwitchSitePanel` / `WorkStatusSheet` /
  `OutsideZoneModal`).
- Панель хранит **все** `useState`/`useEffect`/`useRef`/`useCallback`/хендлеры; шиты теперь всегда
  монтируются и сами гейтятся по `open`/`prompt` (`return null`) вместо `{flag && <>…</>}` — тот же
  вывод, состояния/эффектов у них нет.
- `ClockPanelAssignment` / `WorkerWeekActivity` / `WorkerWeekDayActivity` реэкспортированы из
  `WorkerClockPanel` → `app/worker/page.tsx` и `app/worker-offline/OfflineShellClient.tsx` не тронуты.
- **Тест:** `_test-worker-clock-panel.ts` (unit, 55) — хелперы держат вывод; каждый компонент рисует
  ключевые affordance через `renderToStaticMarkup`; закрытые шиты рисуют пустоту.

### R09.8 — навигация по карточке работника (`fe33e31`)
- `components/admin/WorkerCardNav.tsx` — крошки `Работники › Имя` (ссылка на `/admin/workers`;
  имя-ссылка на «Обзор», кроме самого «Обзора») + ряд из 4 `<Link>` (текущий — `<span
  aria-current="page">`). Не JS-таб-виджет.
- Вставлен в `/admin/workers/[employeeId]` (+ `/profile` / `/timeline` / `/locations`), заменил 4
  разных back-ссылки. Profile-страница теперь тянет `firstName/lastName` → имя видно в крошках.
  `<h1>` под-страниц больше не содержит `— Имя`. «Быстрые действия» на «Обзоре» сокращены до
  реально сквозных (статус на «Сегодня», назначения, правка имени/статуса, проблемы работника,
  отчёт). Удалены неиспользуемые `admin-daily` строки `workers.backToday` / `workers.locations`.
- **Тест:** `_test-worker-card-nav.ts` (unit, 36) — крошки → `/admin/workers`; по одной ссылке на
  каждую соседнюю страницу; текущая никогда не ссылка; `null` имя убирает разделитель; RU-ярлыки.

### R09.10 — guardApiRequest on-touch
**Нет работы.** R09.1–R09.8 изменили: server components (`page.tsx`), `lib/users.ts`,
`lib/document-attention.ts`, `components/**`, `app/globals.css`, `lib/i18n/**`,
`app/worker/clock-panel/**`. **Ни одного `app/**/route.ts`.** Правило владельца — «только реально
трогаемые маршруты, blind codemod запрещён» — значит rollout не применяется. Профильная страница
получила `prisma.employee.findUnique({ where: { id: employeeId }})`, но это RSC-страница (не API), и
тот же запрос там уже был через `getEmployeeProfileView` — новой поверхности нет. Полный
guard-rollout остаётся за R07-A.1 (позже, отдельно).

### R09.11 — этот отчёт + browser-чек-лист + roadmap/status/memory.

---

## 2. Проверки

| | R09.1 | R09.2 | R09.5 | R09.6 | R09.7 | R09.8 |
|---|---|---|---|---|---|---|
| `npm run typecheck` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `npm run lint` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `npm run build` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CI (unit+db+scheduler) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Новые тесты: `_test-admin-users-list` (db 23), `_test-access-denied-notice` (unit 58),
`_test-document-attention` (db), `_test-worker-clock-panel` (unit 55), `_test-worker-card-nav`
(unit 36). Browser-lane (Chromium) — на R12 пилот-приёмке; здесь чек-лист
`R09_BROWSER_ACCEPTANCE_RU.md`.

---

## 3. Backlog (после production, не блокеры R09)

- Объединение карточки работника в один экран (табы/секции) — глубокий рефактор.
- R09.9 — split `ExceptionActionPanel` (847) / `AdminWorkerProfileForm` (504) / `PolicyForm` (450).
- Весь FOREMAN UX — adaptive nav, bulk-подтверждение, приоритезация task-list (R09.3 / R09.4).
- Полный `guardApiRequest` rollout (R07-A.1).
- Access-denied текст на worker sub-страницах карточки (`/profile` / `/timeline` / `/locations`) —
  сейчас старый `localeText('Access denied…')`; перевести на `AccessDeniedNotice` при следующем
  заходе в эти файлы.
- `/admin/workers` (список работников) — page 1 only, 20 строк, без поиска (в отличие от
  `/admin/users` после R09.1).
- `/fi` отдаёт `<html lang="en">` (i18n).

---

## 4. Deploy (готово, ожидает владельца)

R09 не меняет БД → **чистый swap образа** на пилоте (как R05), без миграции. Обычный pre-deploy
backup всё равно делается.

**Образ собран:** `titanor-time-app:t97-pilot-edd950c` (revision label `edd950c`, HEAD ветки;
изолированный тег — `titanor-time-app:latest` = `daa2edbb` production не тронут, см.
`titanor_time_docker_shared_tag_risk`).

**Скрипт:** `ops/titanor-time/deploy-pilot-edd950c.sh` (байт-копия
`/home/deploy/app-data/t97-pilot/deploy-edd950c.sh`, sha256 `6457582e…`). По образцу
`deploy-6a47ed3.sh`, но **шаг 5 — read-only `migrate status`** (проверяет «up to date»,
`migrate deploy` не запускается — миграций нет). 7 шагов: state-guard → образ+label →
preflight (DB на 98, `GPS_ARCHIVE_ENCRYPTION_KEY` есть) → prod baseline → pre-deploy backup
on+off-box → schema check → swap с авто-rollback → verify (app health, `/api/ready`
`schema:current` applied=98, R09-страницы не 5xx, R07-A headers/rate-limit/malformed-UUID
регрессия, R08 gps-archive bundle + fail-closed, scheduler lease/heartbeat/ticks, retention
`retentionOutcome:ok`) → prod baseline `unchanged`.

**Disposable-verify — PASS (2026-08-30):** свежий `pg_dump` пилота (только чтение) → disposable
PG16 (98 миграций) → образ `edd950c`: `migrate status` = «up to date»; boot → `/api/ready` 200
`schema:current` applied=98; `/login` 200; `/admin`, `/admin/users`, `/admin/workforce?sort=ATTENTION`,
`?status=EXPIRING_SOON`, `/admin/workers`, `/worker` → 307 (redirect на /login, 0×5xx); rollback-образ
`6a47ed3` тоже boot 200 против той же БД; пилот-БД и контейнеры не тронуты; полный teardown.

**Агент не запускает деплой** — владелец, после отдельного подтверждения. Rollback-контейнеры
`t97-pilot-{app,scheduler}-pre-edd950c` сохранить (как для R07-A/R08).
