# R15 — наблюдение и закрытие релиза

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R15.
- **Cutover:** 2026-08-31 ~15:48 UTC (18:48 EEST) — `R14_CUTOVER_REPORT_RU.md`.
- **72 ч истекли:** 2026-09-03 ~15:48 UTC. Идёт согласованный с владельцем период стабильности.
- **Статус (2026-09-04):** прод здоров (`titanor-time-app:d7f-d216482`, healthy, restart 0, schema
  100/100). **R15-D7 A→F полностью на production** — владелец дал **технический sign-off по D7 A→F**
  2026-09-03. **Полный R15 owner sign-off ещё НЕ получен** — открыто 5 P1-пунктов из финального
  аудита `fixroad.md` (см. §«Финальный аудит»).

---

## Фаза 1 — первые 2 часа ✅

| пункт | статус |
|---|---|
| app errors / readiness / scheduler heartbeat / login / disk | ✅ чисто; restarts 0; scheduler `lastOutcome:ok`, overlap null |
| первые реальные role flows | ✅ owner smoke на cutover |
| не смешивать release incidents с feature requests | — (после R14 были отдельные UI-деплои: `customer-scope-c6f9cb4`, `customer-worker-scope-e9e7c62` — не инциденты) |

## Фаза 2 — первые 24 часа (почти закрыта, 2 пункта открыты)

| пункт | статус |
|---|---|
| clock / GPS / offline sync / обработка табеля на проде | ⏳ **F02** — нужна ручная приёмка на реальных iPhone/Safari и Android/Chrome (разрешения ОС, cold start, восстановление сети). Автотесты покрывают контур, реальный контур используется (за 7 дней 19 Check In / 18 Check Out / 13 версий табелей), но поведение на телефонах не подтверждено. Владелец выполняет сам. |
| uploads / отчёты (экран + PDF + CSV) / audit events | ⏳ **F02** — проверить вместе с device acceptance (ADMIN сверяет результат в timeline / табеле / отчёте заказчика). |
| автоматический backup Titanor Time | ✅ `titanor-time-backup@production.timer` enabled+active. Автопрогоны идут ежедневно; последний подтверждённый на срез аудита — 2026-09-03 (on-box + off-box `SHA256SUMS` OK, 100 миграций). |
| restore-проверка из production backup | ✅ `restore-test` **13/13** на `production-20260903T175352Z-pre-deploy` (Deploy F). |
| GPS archive / retention на проде | ✅ `titanor-time-gps-archive@production.timer` enabled+active (05:10 UTC); прогон 2026-09-03 PASS, день записан + off-box + promoted VERIFIED. |
| место на storage | ✅ диск / 77%, свободно ~35 GiB; build cache ~71 GB (prune заморожен до sign-off). |
| **backup публичного сайта `titanorgroup.fi`** | ❌ **F04** — `titanorgroup-backup.service` в состоянии failed (ExecStart `/usr/local/sbin/backup-titanorgroup.sh` exit 1) с ~2026-09-01; каталоги `auto-*` за 1–4 сентября создаются, но пустые/неполные; последний известный полный — 2026-08-31. **Сам публичный сайт работает** (`titanorgroup-web-1` healthy 3 дня, `https://titanorgroup.fi/en` → 200). Journal/скрипт/артефакты — только root, диагностика недоступна текущему пользователю. Требуется root-оператор. Titanor Time backup и GPS archive это НЕ затрагивает — это соседний unit. |

## Дефекты, найденные за наблюдение

| # | что | severity | статус |
|---|---|---|---|
| D1a | **Нет UI «восстановить работника».** Деактивация — в одну сторону; приложение писало «сначала восстановите работника», указывая на несуществующую кнопку. | P2 | ✅ **ИСПРАВЛЕНО и задеплоено 2026-09-02** — `c229a44` / `worker-reactivate-c229a44`, отчёт `WORKER_REACTIVATE_DEPLOY_RU.md`. `POST …/reactivate` + кнопка «Восстановить работника». `druzr` (Ruslan Druz #1003, тестовая деактивация `oleksandr` «plohoi») был восстановлен ещё до фикса напрямую в БД. |
| D1b | **Нет «удалить работника в архив».** | P2 | ✅ **ИСПРАВЛЕНО и задеплоено 2026-09-02** (Вариант B, владелец) — `08acb30` / `worker-archive-08acb30`, отчёт `WORKER_ARCHIVE_DEPLOY_RU.md`. «Деактивировать» = «в архив» (данные целы); `/admin/workers` по умолчанию скрывает архивных, переключатель «Показать архив (N)». Без миграции. Физического DELETE по-прежнему нет by design. |
| D2 | **Раб.зона не видна в админке; кажется, что 2-е назначение на одном объекте «не создаётся»; нет кнопки «убрать объект/раб.зону» на карточке работника.** Плюс: `POST /api/admin/assignments/:id/end` отдавал сырой **HTTP 500** при дате окончания раньше уже созданных плановых смен (а это почти любое «завершить сегодня»). | P2 | ✅ **ИСПРАВЛЕНО и задеплоено 2026-09-02** — `ae92b9a` (вкл. `944ba82`) / `worker-workarea-ae92b9a`, отчёт `WORKER_WORKAREA_DEPLOY_RU.md`. Раб.зона в карточке и списке (`Объект — Раб.зона`); список назначений ключуется по `assignmentId` (React больше не схлопывает 2 назначения на одном объекте); кнопка «Завершить» у каждого назначения (запись сохраняется, `validTo`+`endedReason`+audit); `/end` → понятный **409 `ASSIGNMENT_HAS_DEPENDENTS`** с `earliestValidTo` вместо 500, форма подставляет безопасную дату (конец периода). Без миграции. Привязки GPS не тронуты (geofence на объекте, не на назначении). Browser lane 85/26/33/84. Live-проверка под `pilot-owner` на реальных данных (Meyer Turku Shipyard + раб.зона Aros Marine). |
| D3 | **Расчётный лист только по объекту, не по раб.зоне** (сообщение владельца 25: «раб.зона не ниже по важности чем объект»). | P2 | ⏳ **BACKLOG** — не начата. Трогает `lib/site-time-report.ts`, `/admin/reports/sites`, `/admin/reports/customer`, возможно CSV. |
| D5 | **«Завершить» назначение упирается в авто-плановые смены и двигает дату на конец периода** — начальнику нужно снять работника с объекта «сегодня». Плюс: нет заметного «объект завершён»/скрытия закрытых объектов. | P1 (мешает ежедневной работе) | ✅ **Задеплоено 2026-09-02** — `7b3cb94` / `end-today-7b3cb94`, отчёт `END_TODAY_AND_SITE_ARCHIVE_DEPLOY_RU.md`. `/end` удаляет собственные будущие черновые плановые смены → «Завершить сегодня» = 200; реально отмеченные/сданные часы после даты → 409 `ASSIGNMENT_HAS_RECORDED_TIME`; форма по умолчанию ставит сегодня. Кнопка «Объект завершён»/«Восстановить объект» на странице объекта; `/admin/sites` скрывает завершённые (переключатель «Показать завершённые (N)»), пикеры объектов фильтруют `?active=true`. Browser lane 103/26/33/84. Live-проверка (read-only) под `pilot-owner`. Без миграции. |
| D6 | **«Рабочая зона» вводит начальника в ступор** — на практике это заказчик (несколько заказчиков на одном объекте). Плюс: хочется нажать на заказчика и увидеть его работников. | P3 (терминология + UX) | ✅ **Задеплоено 2026-09-02** — `496aa3c` (переименование) + `5381b9f` (страница заказчика), отчёт `CUSTOMER_RENAME_DEPLOY_RU.md`. (1) «Рабочая зона» → «Заказчик» / «Work area» → «Customer» во всей админке, инструкции, CSV/PDF; GPS-тексты у рабочего переформулированы («территория объекта» / «На объекте»/«Вне объекта»), т.к. геозона на весь объект. (2) Страница `/admin/work-areas/:id`: текущие работники заказчика (ссылки на карточки), свёрнутый блок «Работали раньше», ссылка на объект, вкл./откл.; имя заказчика — ссылка из списка, из секции объекта и с карточки работника. Модель БД `WorkArea` и роуты не тронуты. Без миграции. Browser lane 108/84/26/33 + clock-panel 55/55. |
| D4 | **Нет «изменить работнику объект/зону» одним действием** (только «Завершить» + отдельно «Добавить»); при открытой смене смена объекта не должна рвать часы. | P2 | ✅ **Деплой 1/2 задеплоен 2026-09-02** — `bee072d` / `worker-change-bee072d`, отчёт `WORKER_CHANGE_ASSIGNMENT_DEPLOY_RU.md`. Кнопка «Изменить объект / зону» (2 режима: только зона с сегодня / полный с датой); `POST …/change` закрывает старое назначение днём раньше и открывает материализованную замену; заднее число запрещено; сданный/отмеченный табель на дату → чистый 409; открытая смена → 409-выбор (доработать на старом / перенести смену на новый). Browser lane 98/26/33/84. **Оговорка:** при первичной live-проверке моя проба `/change` без `templateId` по ошибке изменила данные Nazar Druz (фантом на 2099, влияния на работника нет) — устранено одной транзакцией с разрешения владельца, `ASSIGNMENT_CHANGE_REVERTED` в аудите. **✅ Деплой 2/2 ТОЖЕ СДЕЛАН:** групповой перевод = Deploy E; «объект завершён» / восстановление + скрытие закрытых объектов = Deploy C + D5; пометка в табеле «место работы изменено · A→B · by …» = Deploy B (маркер перехода в карточке табеля). D4 закрыт полностью, повторно делать не нужно. |
| **D7** | **Фундамент управления назначениями фрагментирован** — одна дата `validTo` тянет 3 несовместимые роли, гейт «текущего» разный в 8 местах, 3 механизма «работник уходит с объекта», нет инварианта «одно основное», история переходов только в JSON. | P1 (архитектурный) | ✅ **Deploy A (фундамент) задеплоен 2026-09-02 ~17:29 UTC** — `d7a-37dddb1` (код = коммит `37dddb1`), отчёт `R15_D7_DEPLOY_A_REPORT_RU.md`. **ПЕРВАЯ prod-миграция после R14: 98 → 99** (`add_assignment_lifecycle` — additive: `SiteAssignment.clockInDisabledAt`, `WorkSite.finishedAt`, таблица `AssignmentTransition` + immutability-триггер + 3 enum; backfill тронул **0 реальных строк**). Единое определение «действующего назначения» (`clockInDisabledAt`-aware) во всех 8 потребителях; сервис `lib/assignment-lifecycle-service.ts` (`removeFromSite`/`changeWorkplace`/`promoteToPrimary`, общий advisory-lock, пишет `AssignmentTransition`) — `/end`, `/remove`(новый), `/change`, `/promote` через него; C8 (деактивированный/OFFBOARDING работник не начинает новую смену); шаг Check Out §3.12. **UI не менялся.** Простой ≈ 8.8 с (миграция шла при работающем старом образе `schema:ahead`). scheduler/Caddy/DNS не тронуты. disposable-тесты: `_test-t9-assignment-lifecycle` 37/37 + setup-lifecycle 108/108 + full-flow 84/84 + setup-ui 26/26 + role-matrix 33/33 + unit 17/17 + restart-persistence 5/5+18/18. Verification на восстановленном prod-backup: паритет 13/13, `migrate deploy` ×2 чисто, приложение отдаёт реальные данные 200. Backup `production-20260902T172647Z-pre-deploy` (+`…162950Z-pre-migration`), rollback-контейнер `titanor-time-prod-app-pre-37dddb1` (образ `customer-page-5381b9f`). **Расхождение на реальных данных:** двойных основных назначений было ДВА (Nazar Druz #1002, Mykhailo Sadovnikov #1004) → исправлены в Deploy D2. **✅ ВЕСЬ D7 A→F LIVE НА PRODUCTION 2026-09-03; технический sign-off по A→F получен.** Хронология и rollback — ниже в логе R15 и в отчётах `R15_D7_DEPLOY_{A..F}_REPORT_RU.md`:<br>• **B + восстановление пароля** (карточка работника + пресеты причин + пометка перехода в табеле + ссылка/QR сброса пароля) — `d7b-recovery-80d5c9c`, ~06:40 UTC;<br>• **C** (завершение объекта / отключение заказчика) — `d7c-ad780f8`, ~09:34 UTC;<br>• **D2** (GiST EXCLUDE `ex_site_assignment_one_primary_per_period`, схема 99→100, `fix-double-primary.sql`) — ~03:44–03:52 UTC;<br>• **E** (групповой перевод) — `d7e-5cce319`, ~12:16 UTC;<br>• **F** (отчёт «Часы заказчику», привязан к `workAreaId`) — `d7f-d216482`, ~19:34 UTC (со 2-й попытки — 1-я оборвалась на баге deploy-скрипта, авто-откат, ~11.5 c, потерь нет).<br>Перед E — очистка тестовых данных SMOKE-C (`R15_D7_SMOKE_C_CLEANUP_RU.md`). **Текущий prod-образ `d7f-d216482`, схема 100.** |

## Фаза 3 — 72 ч + период стабильности (идёт)

- [x] дефекты наблюдения D1a/D1b/D2/D4/D5/D6/D7(A→F) — **все задеплоены**; D3 закрыт Deploy F (см. §«Терминология»)
- [~] финализировать `R14_CUTOVER_REPORT_RU.md` — ссылка на R15 добавлена; фактические 72h-результаты — здесь и в `fixroad.md`
- [x] обновить `IMPLEMENTATION_STATUS.md` — компактная финальная запись 2026-09-04 добавлена
- [x] обновить `R15_OBSERVATION_RU.md` — этот файл приведён к состоянию на 2026-09-04
- [ ] обновить backup/restore и production runbooks (образ `d7f-d216482`, rollback-скрипты Deploy F)
- [ ] **owner sign-off всего R15** — НЕ технический D7, а весь релиз. Блокируется 5 P1 из `fixroad.md`:
      - [ ] **F01** — 3 browser-фикстуры Migration 100 + единый зелёный release-run *(в работе 2026-09-04)*
      - [ ] **F02** — WORKER-приёмка на реальных iPhone/Android *(владелец)*
      - [ ] **F03** — разбор очереди attendance exceptions + SLA *(разбор готов: `R15_ATTENDANCE_EXCEPTIONS_REVIEW_RU.md`; действия — за администратором)*
      - [ ] **F04** — failed backup публичного сайта *(root-оператор)* либо явно вывести публичный сайт из объёма передачи
      - [ ] **F05** — финальные документы (этот пункт)
- [ ] решить срок хранения старого production backup
- [ ] удаление старых данных — **отдельная задача, отдельное разрешение**

### Терминология (зафиксировано `fixroad.md`, подтверждено владельцем)

- **D3** («расчётный лист по заказчику, а не только по объекту») — **закрыт Deploy F** как
  `/admin/reports/customer` («Часы заказчику», привязан к `workAreaId`, секции по заказчику, PDF/CSV).
- Разреза «заказчик» **внутри** `/admin/reports/sites` (site-first документ с разбивкой часов
  объекта по заказчикам) сейчас нет. Дублировать отчёт без подтверждения заказчика не рекомендуется.
  Если заказчику нужен именно site-first документ — оформить **отдельной задачей `R15-F1`**, не
  переоткрывать D3.
- **D4** (изменить место работы + групповой перевод + маркер в табеле) — **закрыт полностью**
  (деплой 1/2 = `worker-change-bee072d`; деплой 2/2 = Deploy B/C/E + D5). Повторно не делать.

## Финальный аудит (2026-09-03 21:54 UTC) — `fixroad.md`

Полный аудит после Deploy F. **P0 нет** — приложение отвечает, данные пишутся, scheduler работает,
schema/backup/GPS archive в норме. Вердикт: **«production технически здоров, handoff условный»**.
До полного R15 owner sign-off и передачи заказчику — 5 P1-gate:

| # | что | кто закрывает | статус на 2026-09-04 |
|---|---|---|---|
| **F01** | 3 browser-фикстуры несовместимы с Migration 100 → нет одного зелёного release-run | агент, без production | ✅ фикстуры исправлены; полный disposable-прогон — §ниже |
| **F02** | не закрыта реальная device acceptance (iPhone/Safari, Android/Chrome): разрешения ОС, cold start, восстановление сети | **владелец** | ⏳ владелец выполняет сам |
| **F03** | 20 (→23) открытых attendance exceptions, 16 старше 72 ч; нет ежедневного ответственного/SLA | администратор | ✅ разбор готов (`R15_ATTENDANCE_EXCEPTIONS_REVIEW_RU.md`); закрытие записей + SLA — за администратором |
| **F04** | `titanorgroup-backup.service` (публичный сайт) в failed с ~2026-09-01; сам сайт работает | **root-оператор** | ⏳ нужен root; сайт healthy, риск — только защита данных публичного сайта |
| **F05** | финальные документы противоречат production | агент | ✅ этот файл + `IMPLEMENTATION_STATUS.md`; остаётся backup/restore + prod runbooks |

**P2 — принять как residual risk или закрыть до финала** (детали в `fixroad.md` §3):

- **F06** — разрез «заказчик» внутри `/admin/reports/sites` отсутствует. Не дублировать без запроса
  заказчика; при необходимости — `R15-F1`.
- **F07** — `capturedOffline` вводит администратора в заблуждение: worker UI теперь ВСЕГДА пишет
  Check In/Out сначала в IndexedDB-очередь и шлёт через `/attendance/sync`, поэтому **все** prod
  ClockEvent (37 за 7 дней) имеют `channel=OFFLINE_SYNC` / `capturedOffline=true` и UI показывает
  «зафиксировано оффлайн». Расчёт часов / replay / GPS это НЕ ломает, но флаг больше не доказывает
  отсутствие сети. Решение: либо переименовать надпись в «отправлено через очередь устройства»,
  либо хранить отдельный `wasOfflineAtCapture` (additive migration). Не переиспользовать текущий
  boolean с новым смыслом.
- **F08** — deploy-скрипты проверяются только `bash -n`. Первая попытка Deploy F (11.5 c 503) это
  показала. Нужен shell-test с подменёнными `docker`/`curl`: ready сразу / несколько неуспешных
  poll затем ready / timeout / failed run + trap rollback / занятое rollback-name / неверный
  исходный образ. Плюс ShellCheck в CI.
- **F09** — нет централизованного алертинга (failed unit нашли ручным аудитом). Минимум:
  `/api/ready != 200`, unhealthy/restart>0, scheduler `!= ok`, любой failed `titanor-time-*` /
  `titanorgroup-backup` unit, отсутствие свежего backup, disk >80/90%, exception старше SLA.
- **F10** — из 153 API route-файлов только 3 через общий `guardApiRequest`; открытого mutating
  endpoint аудит не нашёл — это maintainability, не доказанная уязвимость. Продолжать R07-A.1
  on-touch. CSP осознанно не заявлен.
- **F11** — зафиксировать список осознанно исключённых функций для заказчика (foreman
  propose-correction, отдельная foreman history, R08.1 читаемый GPS-экспорт, полный CSP,
  физическое удаление работников).

Полный чек-лист «можно отдавать заказчику» — `fixroad.md` §5.

## Уборка

- **2026-09-01 — сделано (владелец разрешил):** удалены 22 контейнера `t97-pilot-{app,scheduler}-pre-*`
  + 11 старых образов `t97-pilot-*` (кроме `edd950c`). Освобождено ~9 GB, диск / 86%→79%.
  Оставлены: образ `t97-pilot-edd950c` (rollback-ref), `t97-pilot-db` (справка «что перенесли», ещё
  пару дней), `t97-pilot-{app,scheduler}` (остановлены). `@pilot` таймеры отключены.
- **Заморожено до sign-off (владелец: «Очистку Docker пока не выполнять»):** ~15 контейнеров
  `titanor-time-prod-app-pre-*` (по одному на каждый deploy R15 + R15-D7), старые образы
  `titanor-time-app:*`, build cache ~71 GB.
- **Держать до конца периода наблюдения (по слову владельца):** rollback-контейнер
  `titanor-time-prod-app-pre-d216482` (образ `d7e-5cce319`) + backup `production-20260903T175352Z-pre-deploy`
  (on+off-box). Это активный rollback для текущего prod-образа `d7f-d216482`.
- **После sign-off:** остановить/удалить `t97-pilot-db` + том `t97-pilot-db-data`; `docker builder
  prune` (~50–71 GB build cache); `docker volume prune`; свернуть цепочку `*-pre-*` контейнеров по
  явному allowlist + dry-run. Старый prod (`titanor-time-*-1`) — зона ответственности начальника,
  не трогаем.

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
| 2026-09-03 ~00:14 UTC | deploy `d7d1-b9cb5e7` (**R15-D7 Deploy D1** — код «≤1 живой primary на пересекающийся период», `overlappingPrimaryWhere`); web-swap ~3.9 c, схема осталась 99. |
| 2026-09-03 ~03:44–03:52 UTC | **R15-D7 Deploy D2** — `fix-double-primary.sql` (актёр `pilot-owner`; Nazar #1002 → `c6825d98`, Mykhailo #1004 → `bc174aef`; часы/история/`validTo`/`endedReason` не тронуты; +2 `AssignmentTransition` +2 audit) → миграция 99→**100** (`add_primary_period_exclusion`, GiST EXCLUDE `ex_site_assignment_one_primary_per_period`, `convalidated=true`) через throwaway-контейнер при работающем D1 → web-swap на `d7d3-5690632`, ~3.6 c. Backup `production-20260903T034904Z-pre-migration` + `…035327Z-manual`. Rollback после D2 = контейнер `titanor-time-prod-app-pre-5690632` (`d7d1-b9cb5e7`) ONLY, схему не откатывать. Отчёт `R15_D7_DEPLOY_D_REPORT_RU.md`. |
| 2026-09-03 ~06:40 UTC | deploy `d7b-recovery-80d5c9c` (**R15-D7 Deploy B + hotfix восстановления пароля**, одним web-swap). Карточка работника переделана (текущее/запланированное/прошлое место, «Изменить место работы», «Снять с объекта», пресеты причин), маркер перехода в карточке табеля, ссылка + client-side QR для сброса пароля. Без миграции, простой ~2.6 c. Rollback контейнер `titanor-time-prod-app-pre-80d5c9c` (образ `recovery-cdc04b6`). Отчёт `R15_D7_DEPLOY_B_RECOVERY_RELEASE_RU.md`. |
| 2026-09-03 ~09:34 UTC | deploy `d7c-ad780f8` (**R15-D7 Deploy C** — «Объект завершён» / «Восстановить объект», отключение заказчика с выбором «оставить без заказчика» / «снять работников», серверные запреты на назначение на завершённый объект/отключённого заказчика). Без миграции (`WorkSite.finishedAt` из Migration 1), простой ~2.5 c. Rollback контейнер `titanor-time-prod-app-pre-ad780f8` (`d7b-recovery-80d5c9c`). Отчёт `R15_D7_DEPLOY_C_REPORT_RU.md` §6. |
| 2026-09-03 (перед Deploy E) | **очистка тестовых данных SMOKE-C** (write-smoke Deploy C) — одна транзакция, 4 immutable-триггера off→delete→on внутри tx (audit-триггер не трогали), ~527 строк + 3 smoke-периода; работник #1017 оставлен архивной оболочкой (Employee+User+неактивный Employment + 2 immutable CLOCK-события). Отчёт `R15_D7_SMOKE_C_CLEANUP_RU.md`, SQL `ops/titanor-time/r15-d7/cleanup-smoke-c.sql`. |
| 2026-09-03 ~12:16 UTC | deploy `d7e-5cce319` (**R15-D7 Deploy E** — групповой перевод: секция «Групповой перевод» на странице объекта, будущей датой, одна транзакция / один `groupId` / откат всей партии при конфликте одного). Без миграции, простой ~4 c. Post-swap — только read-only smoke (групповой перевод доказан на disposable, `_test-t9-group-transfer` 16/16). Rollback контейнер `titanor-time-prod-app-pre-5cce319` (`d7c-ad780f8`). Отчёт `R15_D7_DEPLOY_E_REPORT_RU.md` §6. |
| 2026-09-03 ~19:08 UTC | **R15-D7 Deploy F — попытка 1 НЕ удалась.** Образ `d7f-18c2091`. После review deploy-скрипт получил `set -euo pipefail`; из-за этого `code=$(curl … /api/ready)` в цикле ожидания стал фатальным на 1-й итерации → EXIT-trap авто-восстановил `d7e-5cce319`. Простой ≈ **11.5 c** (Caddy отдавал 503), потерь данных нет (миграции нет, БД не трогали), scheduler не заметил. Причина исправлена (`curl … \|\| true`). |
| 2026-09-03 ~19:34 UTC | deploy `d7f-d216482` (**R15-D7 Deploy F — попытка 2, УСПЕХ**). Отчёт «Часы заказчику» полностью переписан: выбор настоящего заказчика (`WorkArea`) вместо свободного текста, фильтр всех сегментов по `workAreaId` (часы одного заказчика не смешиваются с другим на том же объекте), секции по заказчику, PDF/CSV, имя по id из БД, ворота финального экспорта. Ветка перед пересборкой сдвинулась (снят лимит `take:200` в `resolveCustomerReadiness` + регрессионный тест). Без миграции (схема 100), простой ≈ **2.6 c** (T0 `docker stop` 19:34:00.9Z → `/api/ready` 200 19:34:04.1Z). Post-swap — только read-only через Caddy, всё зелёное; scheduler/Caddy/DNS/БД не тронуты. **Rollback: `bash ops/titanor-time/r15-d7/deploy-f-rollback.sh` → контейнер `titanor-time-prod-app-pre-d216482` (образ `d7e-5cce319`).** Отчёт `R15_D7_DEPLOY_F_REPORT_RU.md` §6. |
| 2026-09-03 ~20:00 UTC | **технический owner sign-off по R15-D7 A→F.** Держать rollback-контейнер `titanor-time-prod-app-pre-d216482` + backup `production-20260903T175352Z-pre-deploy` до конца периода наблюдения. Полный R15 sign-off — не давать (см. `fixroad.md`). |
| 2026-09-03 21:54 UTC | финальный аудит специалиста — `fixroad.md`. Вердикт: «production технически здоров, handoff условный». P0 нет. 5 P1-gate до передачи заказчику. |
| 2026-09-04 ~04:00 UTC | **F01** — исправлены 3 browser-фикстуры под Migration 100 (`_test-csv-export` / `_test-period-time-report` / `_test-report-rounding-consistency`: 2-е одновременное назначение → `isPrimary=false`, constraint не отключён, `23P01` не маскируется); `run-worker-dossier-qa.sh` → mode `100755`. Полный disposable-прогон (см. этот файл, §F01-результат). Changelog `/guide` дополнен записью «2–3 сентября 2026» простым языком. **F03** — разбор attendance exceptions: `R15_ATTENDANCE_EXCEPTIONS_REVIEW_RU.md`. **F04** — публичный сайт работает, backup-unit failed (root). Только read-only + disposable, production не менялся. |
