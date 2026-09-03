# R15-D7 — Deploy C («Завершение объекта / отключение заказчика»): отчёт

**Статус:** ✅ **РАЗВЁРНУТО НА PRODUCTION 2026-09-03 ~09:34 UTC** (`titanor-time-app:d7c-ad780f8`,
**без миграции**, схема 100, простой **≈ 2.5 c**). Разрешение владельца — 2026-09-03. Итог — §6.
Deploy E / F не начаты.

Ветка `feature/titanor-time-foundation`, коммит **`1317d1a`**. Образ `titanor-time-app:d7c-1317d1a`
(в образе кода теста/отчёта нет). **Миграции нет** — колонка `WorkSite.finishedAt` уже в Миграции 1
(Deploy A). Схема остаётся **100**.

---

## 1. Что вошло (по design §3.8 / §3.9 / §3.13 L)

| Требование | Как сделано |
|---|---|
| Понятный предпросмотр перед завершением объекта | `GET /api/admin/sites/:id/finish` — read-only: сколько назначено / сколько работают сейчас / сколько будущих / сколько заказчиков + **поимённый список** затронутых работников + список «застрявших» открытых смен. |
| Единственный вариант «Завершить после текущих смен» | `POST /api/admin/sites/:id/finish` — новые Check In и назначения на объект **сразу** запрещены (сервер, L); всем живым назначениям — `clockInDisabledAt = now()`, `validTo = today`; будущие назначения — отменяются; открытые смены **не трогаются** (дорабатываются); будущие пустые плановые смены удаляются; committed-часы сохраняются. |
| «Завершается» vs «Завершён» | вычисляется по наличию открытых смен на объекте. `getSiteDetail` → `finishingState: 'active' \| 'finishing' \| 'finished'`. |
| «Завершается» не висит бесконечно | на странице объекта — блок «Завершается — N работников ещё на смене» + имя, время открытия смены и ссылка на карточку работника (исправить / принудительно закрыть). |
| «Восстановить объект» | `POST /api/admin/sites/:id/reopen` — `active=true`, `finishedAt=NULL`; **назначения не воскресают**; ответ `assignmentsRevived: false`. |
| Отключение заказчика с показом всех затронутых работников | `GET /api/admin/sites/:id/work-areas/:id/disable` — предпросмотр (назначено / на смене / будущих) + поимённый список + другие активные заказчики объекта. |
| Явный выбор, что делать с работниками | `POST .../disable` с `decision`: **`LEAVE_ON_SITE_NO_CUSTOMER`** (каждый остаётся на объекте без заказчика — старое назначение закрывается сегодня, открывается материализованная замена с `workAreaId=null` с завтра) или **`REMOVE_WORKERS`** (каждого снимают с объекта). Перевод на **другого** заказчика этого объекта — это групповой перевод (Deploy E); предпросмотр отдаёт `otherActiveCustomers` для него. |
| Нельзя молча `active=false` при живых назначениях | `POST .../disable` без `decision` при наличии работников → **409 `DECISION_REQUIRED`** (с предпросмотром в теле). Прямой `PATCH .../work-areas/:id { active:false }` при живых/будущих назначениях → **409 `CUSTOMER_HAS_WORKERS`**. |
| Восстановление заказчика | `POST .../work-areas/:id/enable` — `active=true`; назначения не воскресают; завершённый объект-родитель → 409 `SITE_FINISHED`. |
| Серверные запреты L | `createAssignment`, `createAssignmentInTx`, `POST /api/admin/assignments`, `POST /api/admin/assignments/:id/change` → **409 `SITE_FINISHED`** (объект `finishedAt` set / `active=false`) и **409 `CUSTOMER_DISABLED`** (заказчик `active=false`). Проверяется на сервере, в т.ч. внутри транзакции перевода (`SiteOrCustomerUnavailableError`). |
| Check Out — всегда | открытые смены при завершении объекта не трогаются, шаг §3.12 (Deploy A) продлевает `validTo` при выходе на следующий день. Проверено тестом C2. |
| Права | `site.update` для finish/reopen, `workarea.update` для disable/enable. `FOREMAN` новых прав не получает. |
| Аудит | одна транзакция: действие + `AssignmentTransition` (kind `SITE_FINISH` / `CUSTOMER_DISABLE`, один `groupId` на пакет) на каждого работника + один `AuditEvent` (`SITE_FINISHED` / `SITE_REOPENED` / `CUSTOMER_DISABLED` / `CUSTOMER_ENABLED`). Под пер-объектным advisory-lock'ом. |

---

## 2. Изменённые / новые файлы

**Новое:**
- `lib/site-lifecycle.ts` — `finishSitePreview` / `finishSite` / `reopenSite` / `disableCustomerPreview` / `disableCustomer` / `enableCustomer` + внутренний `operationallyCloseAssignmentInTx`.
- `app/api/admin/sites/[siteId]/finish/route.ts` (GET preflight + POST).
- `app/api/admin/sites/[siteId]/reopen/route.ts`.
- `app/api/admin/sites/[siteId]/work-areas/[workAreaId]/disable/route.ts` (GET preflight + POST `{decision}`).
- `app/api/admin/sites/[siteId]/work-areas/[workAreaId]/enable/route.ts`.
- `app/admin/sites/[siteId]/SiteFinishFlow.tsx` — заменяет `SiteLifecycleAction`.
- `app/admin/work-areas/[workAreaId]/DisableCustomerFlow.tsx` — заменяет `WorkAreaToggle`.
- `scripts/_test-t9-site-lifecycle.ts` — disposable-тест C1..C5.

**Правки:**
- `lib/assignment-lock.ts` — `SiteOrCustomerUnavailableError`.
- `lib/assignments.ts` — `createAssignment` + `createAssignmentInTx` проверяют `finishedAt` / `active` объекта и `active` заказчика (`SITE_FINISHED` / `CUSTOMER_DISABLED`).
- `lib/assignment-lifecycle-service.ts` — `changeWorkplace` ловит `SiteOrCustomerUnavailableError`.
- `app/api/admin/assignments/route.ts`, `.../[assignmentId]/change/route.ts` — маппинг новых 409.
- `app/api/admin/sites/[siteId]/work-areas/[workAreaId]/route.ts` — `PATCH { active:false }` guard (409 `CUSTOMER_HAS_WORKERS`).
- `lib/sites.ts` — `getSiteDetail` → `finishedAt` + `finishingState` + `stuckOpenShifts`.
- `app/admin/sites/[siteId]/page.tsx`, `WorkAreaSection.tsx`, `app/admin/work-areas/WorkAreaList.tsx`, `app/admin/work-areas/[workAreaId]/page.tsx` — новые компоненты + сообщение о `CUSTOMER_HAS_WORKERS`.

**Удалено:** `SiteLifecycleAction.tsx`, `WorkAreaToggle.tsx` (заменены).

---

## 3. Disposable-проверка (образ `d7c-1317d1a`, чистый PG16)

| Тест | Combined (`d7c-1317d1a`) | Baseline (Deploy B) |
|---|---|---|
| `_test-t9-site-lifecycle` (**новый**, C1–C5) | **38 / 38** | — |
| `_test-t9-assignment-lifecycle` | **118 / 118** | 118 / 118 |
| `_test-t9-setup-lifecycle` | **113 / 113** | 113 / 113 |
| `_test-t9-worker-card-b` | **34 / 34** | 34 / 34 |
| `_test-t9-full-flow` | **84 / 84** | 84 / 84 |
| `_test-t9-setup-ui` | **26 / 26** | 26 / 26 |
| `_test-t9-role-matrix` | **33 / 33** | 33 / 33 |
| unit lane | **18 / 18** | 18 / 18 |

**Все существующие цифры совпадают с baseline + 38 новых.** tsc + lint + `next build` — чисто.
Шаблонная БД в browser-acceptance: миграция 100 применяется из образа чисто.

### C1–C5 — что проверено
- **C1** (16 проверок): finish-preflight считает 2 назначенных + 1 будущий + 1 заказчик и называет
  их поимённо; finish закрывает 2 живых (`clockInDisabledAt` + `validTo=today`) + отменяет
  будущий; `active=false` + `finishedAt`; `SITE_FINISH` transition + `SITE_FINISHED` audit;
  **POST /assignments и /change на завершённый объект → 409 `SITE_FINISHED`**; reopen →
  `active=true`, `finishedAt=null`, назначения НЕ воскресли, после reopen назначение снова можно.
- **C2**: открытая смена → finish 200, `finishingState='finishing'` + `stuckOpenShifts`;
  **Check Out НЕ заблокирован**; после Check Out → `finishingState='finished'`.
- **C3**: disable-preflight называет 2 работников; **без `decision` → 409 `DECISION_REQUIRED`** с
  предпросмотром; **`PATCH {active:false}` с работниками → 409 `CUSTOMER_HAS_WORKERS`**;
  `LEAVE_ON_SITE_NO_CUSTOMER` → старое закрыто, замена на том же объекте без заказчика с завтра;
  `CUSTOMER_DISABLE` transition; **POST /assignments с отключённым заказчиком → 409
  `CUSTOMER_DISABLED`**; enable → снова можно.
- **C4**: `REMOVE_WORKERS` → работник снят, замены нет.
- **C5**: заказчик без работников → disable без `decision` проходит сразу (200).

---

## 4. План production (после отдельного разрешения)

Web-only swap `d7b-recovery-80d5c9c` → `d7c-<финальный SHA>`, **без миграции** (схема 100).
Standard verified backup перед swap; rollback-контейнер `titanor-time-prod-app-pre-<sha>` (образ
`d7b-recovery-80d5c9c`), откат = revert образа, без отката схемы. scheduler / Caddy / DNS / пароли
/ публичный сайт — не трогать. Ожидаемый простой ~3 c.

---

## 5. Что НЕ входит

- **Групповой перевод** (Deploy E) — «перевести всех работников заказчика на другого заказчика
  этого объекта» одной атомарной операцией. Сейчас: карточка каждого работника (Deploy B) или
  `LEAVE_ON_SITE_NO_CUSTOMER` + назначить заново.
- Отчёт «Часы заказчику» (Deploy F).

---

## 6. Production deploy — выполнено 2026-09-03 (строго по плану)

### Хронология
| шаг | детали |
|---|---|
| Финальная сборка | `titanor-time-app:d7c-ad780f8` из HEAD `ad780f8` (`GIT_SHA=ad780f8` в образе). `git diff 1317d1a ad780f8` = **только 1 docs-файл** → полная регрессия на `d7c-1317d1a` покрывает. Boot-smoke: `migrate deploy` → схема 100/100, `/api/ready` 200, `/login` 200, `/reset-password` 200, `/worker` 307, 0 ошибок. |
| Backup | `production-20260903T093118Z-pre-deploy` — 2273 строки, 100 миграций, on+off-box. `restore-test`: **13/13 PASS**. |
| Кандидат `:3198` | `d7c-ad780f8` на `127.0.0.1:3198` (prod-сеть, prod env-file, uploads `:ro`). `/api/ready` 200 `current 100/100`. **Read-only smoke на реальных prod-данных:** `/admin`, `/admin/sites`, реальный объект (31 KB), `/admin/work-areas`, реальный заказчик, реальная карточка работника, `/admin/timesheets` — **все 200**. **Новые GET-preflight'ы** (`…/finish`, `…/work-areas/:id/disable`) на реальных объектах → 200, отдают корректные данные (объект `Pipe and Co`: 1 назначен; заказчик на объекте `UKI`). Страница объекта рендерит новый flow («Завершить объект», «Статус объекта»). Сессия — 1 INSERT/DELETE. 0 ошибок в логе. |
| **Web-only swap** | T0 `docker stop -t 30` **09:34:13.734Z** → `docker rename → titanor-time-prod-app-pre-ad780f8` → `docker run` новый (идентичная конфигурация: net `titanor-time-prod-net`, `-p 127.0.0.1:3199:3000`, uploads-bind, тот же `--env-file`, тот же healthcheck, `--restart unless-stopped`) → **`/api/ready` 200 в 09:34:16.273Z**. **Простой ≈ 2.5 c.** |
| Health | `healthy` через ~40 c. |

### Пост-swap проверки (live prod, через Caddy)
- `/api/ready` → **200 `current 100/100`**; `/login` 200; неверные креды → **401**; `/worker` 307; `/reset-password` 200;
- аутентифицированно (сессия INSERT+DELETE): `/admin`, `/admin/sites`, `/admin/work-areas`, реальная карточка работника, `/admin/timesheets` — **200**; карточка Deploy B + кнопка recovery на месте; **Mykhailo #1004 `currentAssignments` = 1** (фикс D2 держится);
- **Контейнерный write-smoke на одноразовом наборе `SMOKE-C …` (создан и убран за собой):**
  - **завершение объекта:** preflight считает 2 назначенных + 1 будущий + 1 заказчик и называет их поимённо; finish → 2 закрыто + 1 будущий отменён; `finishingState='finished'`;
  - **запрет на завершённом объекте:** `POST /assignments` → **409 `SITE_FINISHED`** (и через контейнерный тест, и повторно с открытой сменой);
  - **повторное открытие:** reopen → `active`, `assignmentsRevived:false`, `finishingState='active'`, после reopen назначение снова проходит;
  - **открытая смена:** работник сделал Check In → finish → `finishingState='finishing'`, `stuckOpenShifts=1` → **Check Out НЕ заблокирован (201)** → после Check Out `finishingState='finished'`;
  - **отключение заказчика — оба варианта:** preflight называет работников + отдаёт `otherActiveCustomers`; без `decision` → **409 `DECISION_REQUIRED`** (+ preview); `PATCH {active:false}` с работниками → **409 `CUSTOMER_HAS_WORKERS`**; `LEAVE_ON_SITE_NO_CUSTOMER` → старое закрыто/демоутнуто, создана материализованная замена на том же объекте без заказчика с `validFrom=завтра` (проверено прямым запросом к prod-БД: 2 строки, новая `workAreaId=null`, `isPrimary=true`); `REMOVE_WORKERS` → работник снят; enable → `assignmentsRevived:false`;
  - `AssignmentTransition` `SITE_FINISH` / `CUSTOMER_DISABLE` (с `groupId`) + `AuditEvent` `SITE_FINISHED`×4 / `SITE_REOPENED`×1 / `CUSTOMER_DISABLED`×2 / `CUSTOMER_ENABLED`×1 — записаны;
- **восстановление пароля + QR** (реальный браузер, Ruslan Druz #1003): код `XXXX-XXXX-XXXX`, **QR — настоящий `data:image/png` (6.3 KB)**, ссылка `…/reset-password#login=…&code=…` (**query пустой**), `/reset-password` предзаполняет логин+код и чистит фрагмент; тестовые `PasswordResetToken` для Ruslan → `revokedAt`;
- лог приложения и scheduler после swap: **0 ошибок**.

### Что НЕ менялось
Схема (100), scheduler (`r14-release-1416503`), Caddy, DNS, пароли, публичный сайт.

### Rollback
Контейнер **`titanor-time-prod-app-pre-ad780f8` (образ `d7b-recovery-80d5c9c`, ID `a3fc6c1ce43e`)** сохранён — откат образа (~4 c), **без отката схемы** (миграций не было). Backup `production-20260903T093118Z-pre-deploy` (on+off-box).

### Тестовые артефакты (одноразовые, `SMOKE-C … <ts>`)
Не удаляемы физически (нет hard-delete у `WorkSite`/`Employee`), но **все переведены в неактивное
состояние** и не видны в обычных списках: 4 объекта → завершены, 3 заказчика → отключены,
8 работников → 7 `DEACTIVATED` + 1 `OFFBOARDING` (делал реальный Check In/Out). Часов у них нет.
