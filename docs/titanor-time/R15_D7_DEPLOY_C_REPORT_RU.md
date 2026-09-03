# R15-D7 — Deploy C («Завершение объекта / отключение заказчика»): отчёт

**Статус:** разработка + disposable-тесты завершены. **Production не изменялся.** Ждёт отдельного
разрешения владельца. Deploy E / F не начаты.

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
