# R15 — наблюдение и закрытие релиза

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R15.
- **Cutover:** 2026-08-31 ~15:48 UTC (18:48 EEST) — `R14_CUTOVER_REPORT_RU.md`.
- **72 ч истекают:** 2026-09-03 ~15:48 UTC. Плюс согласованный с владельцем период стабильности.
- **Статус:** идёт. Прод здоров, инцидентов нет. Sign-off НЕ получен.

---

## Фаза 1 — первые 2 часа ✅

| пункт | статус |
|---|---|
| app errors / readiness / scheduler heartbeat / login / disk | ✅ чисто; restarts 0; scheduler `lastOutcome:ok`, overlap null |
| первые реальные role flows | ✅ owner smoke на cutover |
| не смешивать release incidents с feature requests | — (после R14 были отдельные UI-деплои: `customer-scope-c6f9cb4`, `customer-worker-scope-e9e7c62` — не инциденты) |

## Фаза 2 — первые 24 часа (идёт)

| пункт | статус |
|---|---|
| clock / GPS / offline sync / обработка табеля на проде | ⏳ нужна проверка реальным worker |
| uploads / отчёты (экран + PDF + CSV) / audit events | ⏳ |
| **дождаться и проверить автоматический backup** | ✅ Env-файлы в `/etc/titanor-time/` (root:root 0600), таймер **`titanor-time-backup@production.timer` enabled+active**; `@pilot` таймеры disabled. **Первый автоматический прогон состоялся:** `production-20260902T042421Z-scheduled` (reason=scheduled, 505 385 б, 724 TOC, 98 миграций, on-box + off-box `SHA256SUMS` OK). `titanor-time-gps-archive@production.timer` тоже отработал (`LAST 2026-09-02 07:11`). |
| restore-проверка из production backup | ✅ `restore-test` этого бэкапа: **14/14** (74 таблицы, fingerprint, uploads 3, `/api/ready` 200) |
| GPS archive / retention на проде | ✅ `titanor-time-gps-archive@production.timer` enabled+active (05:10 UTC); ручной прогон `gps-archive` exit 0 (`sealableDays:0` — раньше 90 дней нечего запечатывать) |
| место на storage | ✅ диск / 85%; build cache 71 GB (prune отложен до sign-off) |

## Дефекты, найденные за наблюдение

| # | что | severity | статус |
|---|---|---|---|
| D1a | **Нет UI «восстановить работника».** Деактивация — в одну сторону; приложение писало «сначала восстановите работника», указывая на несуществующую кнопку. | P2 | ✅ **ИСПРАВЛЕНО и задеплоено 2026-09-02** — `c229a44` / `worker-reactivate-c229a44`, отчёт `WORKER_REACTIVATE_DEPLOY_RU.md`. `POST …/reactivate` + кнопка «Восстановить работника». `druzr` (Ruslan Druz #1003, тестовая деактивация `oleksandr` «plohoi») был восстановлен ещё до фикса напрямую в БД. |
| D1b | **Нет «удалить работника в архив».** | P2 | ✅ **ИСПРАВЛЕНО и задеплоено 2026-09-02** (Вариант B, владелец) — `08acb30` / `worker-archive-08acb30`, отчёт `WORKER_ARCHIVE_DEPLOY_RU.md`. «Деактивировать» = «в архив» (данные целы); `/admin/workers` по умолчанию скрывает архивных, переключатель «Показать архив (N)». Без миграции. Физического DELETE по-прежнему нет by design. |
| D2 | **Раб.зона не видна в админке; кажется, что 2-е назначение на одном объекте «не создаётся»; нет кнопки «убрать объект/раб.зону» на карточке работника.** Плюс: `POST /api/admin/assignments/:id/end` отдавал сырой **HTTP 500** при дате окончания раньше уже созданных плановых смен (а это почти любое «завершить сегодня»). | P2 | ✅ **ИСПРАВЛЕНО и задеплоено 2026-09-02** — `ae92b9a` (вкл. `944ba82`) / `worker-workarea-ae92b9a`, отчёт `WORKER_WORKAREA_DEPLOY_RU.md`. Раб.зона в карточке и списке (`Объект — Раб.зона`); список назначений ключуется по `assignmentId` (React больше не схлопывает 2 назначения на одном объекте); кнопка «Завершить» у каждого назначения (запись сохраняется, `validTo`+`endedReason`+audit); `/end` → понятный **409 `ASSIGNMENT_HAS_DEPENDENTS`** с `earliestValidTo` вместо 500, форма подставляет безопасную дату (конец периода). Без миграции. Привязки GPS не тронуты (geofence на объекте, не на назначении). Browser lane 85/26/33/84. Live-проверка под `pilot-owner` на реальных данных (Meyer Turku Shipyard + раб.зона Aros Marine). |
| D3 | **Расчётный лист только по объекту, не по раб.зоне** (сообщение владельца 25: «раб.зона не ниже по важности чем объект»). | P2 | ⏳ **BACKLOG** — не начата. Трогает `lib/site-time-report.ts`, `/admin/reports/sites`, `/admin/reports/customer`, возможно CSV. |
| D5 | **«Завершить» назначение упирается в авто-плановые смены и двигает дату на конец периода** — начальнику нужно снять работника с объекта «сегодня». Плюс: нет заметного «объект завершён»/скрытия закрытых объектов. | P1 (мешает ежедневной работе) | ✅ **Задеплоено 2026-09-02** — `7b3cb94` / `end-today-7b3cb94`, отчёт `END_TODAY_AND_SITE_ARCHIVE_DEPLOY_RU.md`. `/end` удаляет собственные будущие черновые плановые смены → «Завершить сегодня» = 200; реально отмеченные/сданные часы после даты → 409 `ASSIGNMENT_HAS_RECORDED_TIME`; форма по умолчанию ставит сегодня. Кнопка «Объект завершён»/«Восстановить объект» на странице объекта; `/admin/sites` скрывает завершённые (переключатель «Показать завершённые (N)»), пикеры объектов фильтруют `?active=true`. Browser lane 103/26/33/84. Live-проверка (read-only) под `pilot-owner`. Без миграции. |
| D6 | **«Рабочая зона» вводит начальника в ступор** — на практике это заказчик (несколько заказчиков на одном объекте). Плюс: хочется нажать на заказчика и увидеть его работников. | P3 (терминология + UX) | ✅ **Задеплоено 2026-09-02** — `496aa3c` (переименование) + `5381b9f` (страница заказчика), отчёт `CUSTOMER_RENAME_DEPLOY_RU.md`. (1) «Рабочая зона» → «Заказчик» / «Work area» → «Customer» во всей админке, инструкции, CSV/PDF; GPS-тексты у рабочего переформулированы («территория объекта» / «На объекте»/«Вне объекта»), т.к. геозона на весь объект. (2) Страница `/admin/work-areas/:id`: текущие работники заказчика (ссылки на карточки), свёрнутый блок «Работали раньше», ссылка на объект, вкл./откл.; имя заказчика — ссылка из списка, из секции объекта и с карточки работника. Модель БД `WorkArea` и роуты не тронуты. Без миграции. Browser lane 108/84/26/33 + clock-panel 55/55. |
| D4 | **Нет «изменить работнику объект/зону» одним действием** (только «Завершить» + отдельно «Добавить»); при открытой смене смена объекта не должна рвать часы. | P2 | ✅ **Деплой 1/2 задеплоен 2026-09-02** — `bee072d` / `worker-change-bee072d`, отчёт `WORKER_CHANGE_ASSIGNMENT_DEPLOY_RU.md`. Кнопка «Изменить объект / зону» (2 режима: только зона с сегодня / полный с датой); `POST …/change` закрывает старое назначение днём раньше и открывает материализованную замену; заднее число запрещено; сданный/отмеченный табель на дату → чистый 409; открытая смена → 409-выбор (доработать на старом / перенести смену на новый). Browser lane 98/26/33/84. **Оговорка:** при первичной live-проверке моя проба `/change` без `templateId` по ошибке изменила данные Nazar Druz (фантом на 2099, влияния на работника нет) — устранено одной транзакцией с разрешения владельца, `ASSIGNMENT_CHANGE_REVERTED` в аудите. **Деплой 2/2 (backlog):** групповой перевод, «объект завершён»/восстановление + скрытие закрытых объектов, пометка в табеле «объект изменён в HH:MM». |
| **D7** | **Фундамент управления назначениями фрагментирован** — одна дата `validTo` тянет 3 несовместимые роли, гейт «текущего» разный в 8 местах, 3 механизма «работник уходит с объекта», нет инварианта «одно основное», история переходов только в JSON. | P1 (архитектурный) | ✅ **Deploy A (фундамент) задеплоен 2026-09-02 ~17:29 UTC** — `d7a-37dddb1` (код = коммит `37dddb1`), отчёт `R15_D7_DEPLOY_A_REPORT_RU.md`. **ПЕРВАЯ prod-миграция после R14: 98 → 99** (`add_assignment_lifecycle` — additive: `SiteAssignment.clockInDisabledAt`, `WorkSite.finishedAt`, таблица `AssignmentTransition` + immutability-триггер + 3 enum; backfill тронул **0 реальных строк**). Единое определение «действующего назначения» (`clockInDisabledAt`-aware) во всех 8 потребителях; сервис `lib/assignment-lifecycle-service.ts` (`removeFromSite`/`changeWorkplace`/`promoteToPrimary`, общий advisory-lock, пишет `AssignmentTransition`) — `/end`, `/remove`(новый), `/change`, `/promote` через него; C8 (деактивированный/OFFBOARDING работник не начинает новую смену); шаг Check Out §3.12. **UI не менялся.** Простой ≈ 8.8 с (миграция шла при работающем старом образе `schema:ahead`). scheduler/Caddy/DNS не тронуты. disposable-тесты: `_test-t9-assignment-lifecycle` 37/37 + setup-lifecycle 108/108 + full-flow 84/84 + setup-ui 26/26 + role-matrix 33/33 + unit 17/17 + restart-persistence 5/5+18/18. Verification на восстановленном prod-backup: паритет 13/13, `migrate deploy` ×2 чисто, приложение отдаёт реальные данные 200. Backup `production-20260902T172647Z-pre-deploy` (+`…162950Z-pre-migration`), rollback-контейнер `titanor-time-prod-app-pre-37dddb1` (образ `customer-page-5381b9f`). **Расхождение на реальных данных:** двойных основных назначений ДВА (Nazar Druz #1002 — решено Q1; Mykhailo Sadovnikov #1004 — нужен выбор владельца) → Deploy D = 2 ручных исправления. **Осталось: Deploy B** (карточка работника + пресеты причин + пометка перехода в табеле), **C** (завершение объекта/заказчика), **D** (fix двойных primary + partial unique index), **E** (групповой перевод), **F** (отчёт «Часы заказчику»). Косметика: сегодня Nazar покажет 2 текущих назначения (новый гейт `validTo >= today`), само исчезнет завтра. |

## Фаза 3 — 72 ч + период стабильности (не начата)

- [ ] финализировать `R14_CUTOVER_REPORT_RU.md`
- [ ] закрыть / вынести дефекты, найденные за наблюдение (см. выше: D1 → backlog)
- [ ] обновить runbooks / `IMPLEMENTATION_STATUS` / `NEXT_AGENT_HANDOFF_RU`
- [ ] **owner sign-off** — закрытие релиза
- [ ] решить срок хранения старого production backup
- [ ] удаление старых данных — **отдельная задача, отдельное разрешение**

## Уборка

- **2026-09-01 — сделано (владелец разрешил):** удалены 22 контейнера `t97-pilot-{app,scheduler}-pre-*`
  + 11 старых образов `t97-pilot-*` (кроме `edd950c`). Освобождено ~9 GB, диск / 86%→79%.
  Оставлены: образ `t97-pilot-edd950c` (rollback-ref), `t97-pilot-db` (справка «что перенесли», ещё
  пару дней), `t97-pilot-{app,scheduler}` (остановлены). `@pilot` таймеры отключены.
- **После sign-off:** остановить/удалить `t97-pilot-db` + том `t97-pilot-db-data`; `docker builder
  prune` (~50 GB build cache); `docker volume prune`. Старый prod (`titanor-time-*-1`) — зона
  ответственности начальника, не трогаем.

---

## Артефакты для владельца

- **Скриншоты всех экранов** (57 PNG, `pilot-owner` SUPER_ADMIN): `/home/deploy/screenshots/titanor-time-prod-2026-09-01/` + `_index.md`.
  WORKER-экраны не сняты (нужен вход рабочего аккаунта).
- **Иллюстрированное руководство** (10 разделов, 32 экрана): артефакт
  `https://claude.ai/code/artifact/019e3f38-fd3b-421a-b0f8-01496758b8c1` ·
  автономная копия `/home/deploy/screenshots/titanor-time-guide.html` ·
  исходник + build-скрипт рядом. Дополняет встроенную `/guide`.

## Лог R15

| дата (UTC) | событие |
|---|---|
| 2026-08-31 15:48 | cutover, prod live |
| 2026-08-31 20:49 / 21:52 | post-R14 UI-деплои (`customer-scope-c6f9cb4`, `customer-worker-scope-e9e7c62`) — `*-pre-deploy` backup каждый |
| 2026-09-01 06:57 | первый ручной `production-...-scheduled` backup + off-box + restore-test 14/14 + gps-archive exit 0 |
| 2026-09-01 09:02 | `@production` backup+gps таймеры enabled (04:10 / 05:10 UTC daily); `@pilot` disabled; env в `/etc/titanor-time/` |
| 2026-09-01 09:15 | пилотная deploy-history подчищена (~9 GB, диск 86→79%) |
| 2026-09-01 ~09:14 (EEST) | скриншоты всех экранов сняты |
| 2026-09-02 ~09:40 (EEST) | иллюстрированное руководство собрано |
| 2026-09-02 07:06 | deploy `worker-reactivate-c229a44` (кнопка «Восстановить работника»); web-swap ~4 c, PASS |
| 2026-09-02 07:23 | deploy `worker-archive-08acb30` (архив: список скрывает деактивированных + «Показать архив»); web-swap ~4 c, PASS. Browser lane 77/33/26/84. |
| 2026-09-02 04:24 UTC | ✅ первый автоматический production backup `production-20260902T042421Z-scheduled` — on+off-box `SHA256SUMS` OK, 98 миграций |
| 2026-09-02 08:29 UTC | deploy `worker-workarea-ae92b9a` (раб.зона в карточке/списке; «Завершить» назначение на карточке; `/end` 500→409); web-swap ~3 c, PASS. Browser lane 85/26/33/84. Live-проверка под `pilot-owner`. Rollback: `titanor-time-prod-app-pre-ae92b9a`. |
| 2026-09-02 10:19 UTC | deploy `worker-change-bee072d` (D4 деплой 1/2 — «Изменить объект / зону» на карточке, `POST …/change`, выбор при открытой смене); web-swap ~3 c, PASS. Browser lane 98/26/33/84. Backup `production-20260902T101832Z-pre-deploy`. Rollback: `titanor-time-prod-app-pre-bee072d`. **Инцидент:** проба `/change` при live-check изменила данные Nazar Druz (фантом на 2099, без влияния) → устранено 10:27 одной транзакцией с разрешения владельца (`ASSIGNMENT_CHANGE_REVERTED` в аудите). |
| 2026-09-02 11:49 UTC | deploy `end-today-7b3cb94` (D5 — «Завершить сегодня» работает: `/end` чистит собственные будущие черновые плановые смены; кнопка «Объект завершён»/«Восстановить объект» + скрытие закрытых объектов из списков/пикеров); web-swap ~4 c, PASS. Browser lane 103/26/33/84. Backup `production-20260902T114839Z-pre-deploy`. Rollback: `titanor-time-prod-app-pre-7b3cb94`. Live-проверка read-only. |
| 2026-09-02 12:27 UTC | deploy `end-gt-today-f2c5e57` (follow-up D5 — назначение, завершённое сегодня, сразу уходит из «Текущих» в «Прошлые»; `currentAssignmentWhere` `validTo > today` вместо `>=`, только админ-вид, путь отметок не тронут); web-swap ~4 c, PASS. Browser lane 105/26/33/84. Backup `production-20260902T122629Z-pre-deploy`. Rollback: `titanor-time-prod-app-pre-f2c5e57`. Live (read-only): Nazar Druz — старое назначение ушло в «Прошлые». |
| 2026-09-02 13:48 UTC | deploy `customer-rename-496aa3c` (D6 — «Рабочая зона» → «Заказчик» во всей админке; GPS-тексты у рабочего «рабочая зона» → «территория объекта»; только подписи, без миграции/данных/логики); web-swap ~4 c, PASS. Browser lane 105/84/26/33 + clock-panel 55/55. Backup `production-20260902T134805Z-pre-deploy`. Rollback: `titanor-time-prod-app-pre-496aa3c`. Live (read-only) под `pilot-owner`. Отчёт `CUSTOMER_RENAME_DEPLOY_RU.md`. |
| 2026-09-02 14:41 UTC | deploy `customer-page-5381b9f` (D6b — страница заказчика `/admin/work-areas/:id`: текущие работники + свёрнутый блок «Работали раньше», ссылка на объект, вкл./откл.; имя заказчика — ссылка из списка заказчиков, из секции объекта и с карточки работника); web-swap ~4 c, PASS. Browser lane 108/84/26/33. Backup `production-20260902T144015Z-pre-deploy`. Rollback: `titanor-time-prod-app-pre-5381b9f`. Live (read-only): «Aros Marine» → 4 работника, ссылки на карточки. |
| 2026-09-02 ~17:29 UTC | deploy `d7a-37dddb1` (**R15-D7 Deploy A — фундамент**, код = `37dddb1`). **ПЕРВАЯ prod-миграция после R14: 98 → 99** (`add_assignment_lifecycle`, additive; backfill 0 строк). Единый `clockInDisabledAt`-гейт + сервис жизненного цикла (`removeFromSite`/`changeWorkplace`/`promoteToPrimary`) + C8 + шаг Check Out §3.12. UI не менялся. Порядок: backup `production-20260902T172647Z-pre-deploy` (on+off-box OK) → `migrate deploy` при работающем старом образе (`schema:ahead` 200) → verify 99/0-bad/75 таблиц/41 триггер/182 FK → web-swap (T0 17:29:05.6 → ready 17:29:14.4, **простой ≈ 8.8 c**) → `/api/ready` 200 `schema:current` локально и через Caddy `https://app.titanorgroup.fi`. scheduler/Caddy/DNS не тронуты. disposable: assignment-lifecycle 37/37 + setup-lifecycle 108/108 + full-flow 84/84 + setup-ui 26/26 + role-matrix 33/33 + unit 17/17 + restart-persistence 5+18. Rollback: контейнер `titanor-time-prod-app-pre-37dddb1` (образ `customer-page-5381b9f`), только откат образа (схему не откатывать). Отчёт `R15_D7_DEPLOY_A_REPORT_RU.md` §11–§12. |
| 2026-09-03 15:48 | ⏳ 72 ч; собрать report → owner sign-off |
