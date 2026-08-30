# R09 — UX WORKER / FOREMAN / ADMIN: аудит + план

- **Основание:** production release roadmap R09, ТЗ §13–15 + §19.2–19.4. Свёртка R07-A.1
  (`guardApiRequest` rollout — пошагово, только по трогаемым маршрутам).
- **Дата:** 2026-08-30.
- **Правила:** mobile-first, RU/EN, без horizontal overflow, состояния loading/empty/error/success,
  защита от повторного действия. **Бизнес-логику не менять.** Production/DNS/Caddy/Cloudflare не
  трогать. Pilot deploy — только после зелёных проверок и отдельного подтверждения.

---

## 1. Что уже сделано (не переделывать)

- **`/admin` и `/foreman`** уже показывают `OverviewView` — оперативный task-center с summary-
  карточками (нет ухода, GPS-проблемы, sync-проблемы, draft/submitted/returned/ready-for-approval,
  открытые корректировки, открытые attendance-исключения) + секцией «Конфликты и аномалии», URL-
  фильтрами (период/объект/состояние/страница), пагинацией. Login → `/admin` (не `/admin/setup`) —
  **сделано** (T7A.9B).
- **WORKER:** hamburger-меню (`WorkerAppNavigation`), notification bell (`WorkerNotificationBell`,
  T15), pull-to-refresh, PWA (manifest/SW/apple icons), человеческие GPS-сообщения + approximate
  fix (T14), «Check In никогда не блокируется geofence» (T17).
- **ADMIN nav** — сгруппированное dropdown-меню (`AdminNav`), click-to-toggle, закрывается по
  outside-click / Escape / смене маршрута.
- **ExceptionActionPanel** — `ConfirmGate` + `pendingRef` (синхронный double-click guard) уже есть.
- **CSRF на всех mutating-маршрутах** (100%, R07-A) — `guardApiRequest` пока только на
  `/api/auth/{session,logout,logout-all}`.

## 2. Найденные пробелы (аудит экранов)

### WORKER (ТЗ §13)
| # | пробел | где |
|---|---|---|
| W-a | `WorkerClockPanel.tsx` — **1160 строк** в одном клиентском компоненте; ТЗ прямо просит «разделить крупный clock UI на поддерживаемые части без изменения поведения» | `app/worker/WorkerClockPanel.tsx` |
| W-b | Возможный horizontal overflow на `profile` / `history` / `install` / `periods` — нужен прогон по узкому viewport (таблицы/длинные строки/flex без `min-width:0`) | `app/worker/*` |
| W-c | Проверить полноту по ТЗ §13: одно главное действие, активный объект + время старта заметно, online/offline/sync + счётчик pending, безопасный retry, незаполненные дни + неподанные периоды, выделенный returned-табель — что-то может быть неполным/спрятанным в 1160-строчном компоненте | clock screen |

### FOREMAN (ТЗ §14)
| # | пробел | где |
|---|---|---|
| F-a | **Навигация не адаптивна** — плоский ряд из 5 `<Link>` в `<header>`, без hamburger; на телефоне переполняется | `app/foreman/layout.tsx` |
| F-b | `BulkApproveList` — **нет шага подтверждения** перед bulk-approve табелей (ТЗ: «Подтверждение bulk-действий»); double-submit только через `disabled={loading}` (нет синхронного ref-guard) | `app/foreman/review/standard/BulkApproveList.tsx` |
| F-c | Приоритезация критических случаев в task-list (незакрытая смена → GPS → неподанный табель → исключения) — проверить, что foreman-ветка `OverviewView` их выделяет и сортирует; быстрые переходы к работнику/табелю/исключению | `OverviewView` foreman-path |
| F-d | Причины запрета показываются как permission-код | все `/foreman/*` страницы |

### ADMIN / SUPER_ADMIN (ТЗ §15)
| # | пробел | где |
|---|---|---|
| A-a | `/admin/users` — **нет search / pagination UI / фильтров** (username/email/роль/статус). `listUsers` уже пагинирует и умеет `role`; нет free-text `q`, email, status | `app/admin/users/page.tsx`, `lib/users.ts` |
| A-b | **22 файла** показывают сырой permission-код (`Access denied — this page requires the <code> permission`). ТЗ (ADMIN + FOREMAN): «Понятные причины запрета вместо permission-кодов» | `app/admin/**`, `app/foreman/**` |
| A-c | Единая карточка работника: основной `/admin/workers/[employeeId]` уже тянет профиль+квалификации+расписание+действия+recovery, но рядом отдельные `[employeeId]/profile`, `[employeeId]/timeline`, `[employeeId]/locations`. ТЗ хочет один экран: профиль/профессии/квалификации/документы/назначения/часы/история/recovery | `app/admin/workers/[employeeId]/**` |
| A-d | Task-center: нет явной категории «просроченные / истекающие документы» в summary (есть в notification bell, нет как clickable-карточки) | `lib/attendance-overview.ts`, `OverviewView` |
| A-e | Крупные модули без разбиения: `ExceptionActionPanel` 847, `AdminWorkerProfileForm` 504, `PolicyForm` 450 — ТЗ: «Разделить чрезмерно крупные модули без изменения бизнес-логики» | components |
| A-f | Mobile nav / overflow на `/admin` — прогнать по узкому viewport (`.admin-nav-inner` — flex-ряд dropdown-триггеров; таблицы `worker-table` / `setup-list`) | `app/admin/*`, css |
| A-g | Устаревшие UI-тексты/ссылки — точечный аудит («Specialty (free text, legacy)» и т.п.; большинство «legacy period» — легитимный домен) | components/pages |

### Cross-cutting
| # | пробел |
|---|---|
| G-a | `guardApiRequest` — по маршрутам, которые R09 трогает (перевод on-touch), с ревью каждого. Blind codemod запрещён. |
| G-b | Тесты по изменённым сценариям + browser-acceptance чек-лист (desktop / tablet / iPhone-like / Android-like, keyboard nav, базовый a11y). Browser-lane гоняется на R12; здесь — чек-лист + не-browser регрессия. |

---

## 3. Предлагаемые slices (каждый = один коммит, свои проверки)

**Порядок — от «низкий риск, высокая ценность» к рефакторингу.**

| slice | что | риск | проверка |
|---|---|---|---|
| **R09.1** | `/admin/users` search + pagination + фильтры (q / email / role / status), URL-persisted. `lib/users.listUsers` расширить `q`+`status`; парсер запроса. | низкий | db-тест парсера + `listUsers` фильтров; typecheck/build |
| **R09.2** | Человеческие причины запрета: общий `<AccessDenied area=…>` (или helper) — заменить 22 сырых permission-message на осмысленный текст RU/EN, привязанный к разделу, **без изменения permission-логики** | низкий | unit-тест хелпера (area→текст, нет кода в выводе); прогон затронутых страниц в build |
| **R09.3** | FOREMAN адаптивная навигация: `ForemanNav` client-компонент (hamburger на узком, ряд на широком), паттерн как `AdminNav`/`WorkerAppNavigation`. Только презентация. | низкий | typecheck/build; browser-чек-лист (нет overflow на 360px) |
| **R09.4** | FOREMAN bulk-подтверждение: `ConfirmGate` перед `handleBulkApprove` + синхронный `pendingRef`; ясный итог. То же для др. bulk-действий foreman, если есть. | низкий | unit/DOM-тест: без подтверждения запрос не уходит; двойной клик = один запрос |
| **R09.5** | Task-center: категория «истекающие/просроченные документы» — счётчик в `attendance-overview` + clickable-карточка в `OverviewView` → фильтр по quals. Reuse существующего расчёта expiry. | средний | db-тест счётчика (истёкшие/скоро/ок); snapshot карточки |
| **R09.6** | Overflow-sweep WORKER + ADMIN + FOREMAN: CSS-правки (`min-width:0`, `overflow-x:auto` на таблицах/код-блоках, `overflow-wrap`), без изменения разметки поведения. | низкий | CSS-lint; browser-чек-лист по 4 viewport |
| **R09.7** | `WorkerClockPanel` split: извлечь `ActiveShiftHeader`, `ClockActionButton`, `SyncStatusBar`, `PendingOpsList`, `GpsMessage`, `ManualRetry` — **чистая экстракция, ноль изменений поведения**. Заодно закрыть пробелы W-c, если найдутся. | средний | регрессия: рендер-тест ключевых affordance; существующие worker-тесты зелёные; browser-чек-лист clock |
| **R09.8** | Единая карточка работника `/admin/workers/[employeeId]`: секции/табы (профиль · профессии · квалификации · документы · назначения · часы · история · recovery) в одном экране; глубокие правки — по ссылке, но представление единое. Устаревшие ссылки убрать. | средний | typecheck/build; проверить, что все под-данные показываются; browser-чек-лист |
| **R09.9** | Split крупных admin-модулей: `ExceptionActionPanel` / `AdminWorkerProfileForm` / `PolicyForm` — экстракция под-компонентов, **ноль изменений бизнес-логики**. | средний | существующие тесты (`_test-*` для exceptions/policy) зелёные; typecheck |
| **R09.10** | `guardApiRequest` rollout по маршрутам, изменённым в R09.1–R09.9 (users, foreman bulk-approve, overview, worker-card sub-routes) — по одному, с ревью; envelope байт-идентичен. | средний | `_test-api-guard` расширить; per-route negative-тесты |
| **R09.11** | R09 browser-acceptance чек-лист (`R09_BROWSER_ACCEPTANCE_RU.md`): desktop / tablet / iPhone-like / Android-like, keyboard nav, a11y; финальный отчёт `R09_UX_REPORT_RU.md`; roadmap/status. | низкий | — |

**Deploy:** всё копится на ветке; **один pilot-деплой в конце R09** (после R09.11 и зелёного
CI), по отдельному подтверждению владельца. Промежуточных деплоев нет.

---

## 4. Вопросы к владельцу перед стартом кода

1. **Объём:** ок делать все 11 slices, или сузить (например: отложить R09.8 единую карточку и/или
   R09.9 split крупных модулей — они самые «рефакторные»)?
2. **Deploy:** один деплой в конце R09 (как предложено), или чек-пойнт-деплой после «низкориск»
   блока R09.1–R09.6?
3. **Единая карточка (R09.8):** свести `/profile` `/timeline` `/locations` в табы одного экрана,
   или оставить их отдельными «глубокими» страницами, а на основной карточке просто навести порядок
   в секциях/ссылках?
4. **Текст причин запрета (R09.2):** нейтральный универсальный («Раздел доступен администраторам;
   если нужен доступ — обратитесь к SUPER_ADMIN») или более конкретный по разделу?
