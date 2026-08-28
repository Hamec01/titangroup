# T12 · Инструменты админа + доводка GPS

Статус: **все 5 задач готовы и на пилоте `t97-pilot-75cdde5`; ветка запушена в origin.**
Дата: 2026-08-28. По списку правок владельца (утро 2026-08-28):

1. Уведомления «нужно утвердить» за каждую неделю + кнопка «Изменить часы» на карточке табеля
   (правка без причины, работник не уведомляется).
2. GPS: кнопка «Разрешить» ничего не делала и баннер возвращался; периодическая проверка
   местоположения при открытой смене (даже офлайн).
3. Объединить ветку `feature/titanor-time-foundation`, задеплоить на пилот, коммит.
4. Фильтр `/admin/attendance/exceptions` падал на пустых query-параметрах.

---

## ЖУРНАЛ ВЫПОЛНЕНИЯ (для проверки другим агентом)

| # | Что | Статус |
|---|---|---|
| 2a | GPS-баннер «Разрешите геолокацию один раз» больше не залипает | ✅ ГОТОВО. Коммит `402f66b`. Тест `_test-worker-gps` 22/22. |
| 4 | Пустые `type=`/`from=`/`to=` в URL исключений = «фильтр не задан» | ✅ ГОТОВО. Коммит `05a9a0c`. Тест `_test-exception-list-query` 12/12. |
| 1b | Кнопка «Изменить часы» — 1 клик, без причины, без плашки работнику, полный аудит | ✅ ГОТОВО. Коммит `543a339`. Миграция `20260828120000`. Тест `_test-admin-direct-edit` 22/22. |
| 1a | Уведомление «нужно утвердить» на каждый сданный табель + разбивка по неделям в календарном бейдже | ✅ ГОТОВО. Коммит `d8e404e`. Миграция `20260828130000`. Тест `_test-timesheet-approval-notifications` 12/12. |
| 2b | Авто-точка «на месте» при открытой смене (≥3ч, офлайн-safe), карта у админа | ✅ ГОТОВО. Коммит `dedf3a0`. Миграция `20260828140000`. Тесты `_test-attendance-presence` 20/20, `_test-presence-pacing` 7/7, `_test-offline-idb-invariants` 32/32. |
| 3 | Деплой на пилот (3 миграции) + `git push` ветки в origin | ✅ ГОТОВО. `git push` — 20 коммитов в `origin/feature/titanor-time-foundation` (`41d2c04..75cdde5`). Пилот на образе `t97-pilot-75cdde5`. |
| 5 | Обновить встроенную инструкцию (`/guide`) до текущего состояния | ✅ ГОТОВО. Коммит `d16e37f`. Пилот пересобран → образ `t97-pilot-d16e37f` (без миграций). |

**Пилот (`t97-pilot-75cdde5`, 2026-08-28).** Бэкап `t97-pilot-20260828T122802Z-pre-75cdde5.dump`.
3 миграции (`20260828120000`, `130000`, `140000`) применены на `titanor_time_t97` через
`prisma migrate deploy` (temp-контейнер из нового образа, host `prisma/` смонтирован ro,
`--env-file` пилота); idempotent-повтор `No pending migrations`. Схема проверена: `ADMIN_EDIT` в
enum, `CorrectionRequest.directEdit`, `AdminNotification.timesheetId`, таблица
`ShiftPresenceSample`, частичный индекс `ux_admin_notification_active_timesheet` — все на месте.
Контейнер `t97-pilot-app` пересоздан на новом образе; `/api/ready` + `/api/health` + `/login` 200,
внешний HTTPS через Caddy 200. Счётчики строк без изменений
(`AttendanceException`=10 / `ClockEvent`=23 / `Timesheet`=12), `ShiftPresenceSample`=0,
`CorrectionRequest.directEdit` дефолт false на существующей строке. Prod-образ `daa2edbb…` /
`titanor-time-app:latest` и контейнер `titanor-time-app-1` не тронуты (up 6 days healthy).
Smoke: `POST /api/worker/attendance/presence` → 401, `GET /api/admin/review-queue` → 401,
`/admin/attendance/exceptions?status=OPEN&type=&from=&to=` → 307 (login) — ни одного 500, лог чист.

**Пилот повторно (`t97-pilot-d16e37f`, 2026-08-28).** Обновление `/guide` (`lib/i18n/guide.ts`,
RU + EN) до текущего состояния — сгруппированное меню, колокольчик уведомлений + календарный
бейдж, матрица допусков + досье, экран «На утверждении», три способа правки табеля,
больничный/отпуск из редактора, порог точности GPS, mid-shift presence в приложении. Миграций
нет, только код. Контейнер пересоздан на `t97-pilot-d16e37f`; `/guide` 200 (новый текст в HTML),
`/api/ready`/`/api/health`/`/login` 200, внешний HTTPS 200. Счётчики строк без изменений
(10/23/12), pending-миграций 0, prod не тронут.

`tsc --noEmit` зелёный после каждого шага. Регрессии (corrections, qualification-notifications,
GPS steps 1/4) — зелёные.

Каждый шаг закрывается только после: код + тест на одноразовой PG16 + `tsc` + (для деплоя)
`next build` + применение миграций на пилот + проверка. Реальные commit-hash / image-tag пишутся
по факту.

---

## Шаг 2a — GPS-баннер (`402f66b`)

**Симптом.** Работник видит баннер «Разрешите геолокацию один раз», жмёт кнопку — ничего не
происходит; при следующем входе баннер снова.

**Причина.**
- iOS Safari: `navigator.permissions.query({name:'geolocation'})` возвращает `prompt` даже когда
  доступ на origin уже выдан. → баннер показывается всегда.
- Кнопка вызывает `getCurrentPosition`. Внутри помещения фикс за 15 с не приходит → `TIMEOUT` →
  прежний код оставлял состояние `prompt` → баннер не исчезал.
- Нигде не хранилось, что онбординг уже пройден.

**Решение.** `lib/worker-gps.ts`: локальный флаг `titanor.geo.onboarded` в `localStorage`
(`isGeoOnboarded` / `markGeoOnboarded` / `clearGeoOnboarded`, всё в try/catch, только булев
признак — не координата). `startGpsWatch(onPermissionDenied?)` сообщает о реальном отзыве.
`WorkerClockPanel`: состояние резолвится один раз на маунте — `denied` → баннер «включите в
настройках»; `granted` → watch; `prompt`/`unsupported` → если онбординг уже пройден на этом
устройстве, тихо запускаем watch, иначе показываем баннер онбординга. Кнопка отмечает онбординг
пройденным при успехе И при не-denial-ошибке (`TIMEOUT`/`POSITION_UNAVAILABLE`), так что баннер
перестаёт возвращаться; `PERMISSION_DENIED` от захвата на чек-ине или отзыв watch — снова баннер
«запрещено» + флаг сбрасывается.

## Шаг 4 — фильтр исключений (`05a9a0c`)

Форма фильтров (`<form method=GET>`) для нетронутых полей шлёт `?status=OPEN&type=&from=&to=`.
`parseExceptionListQuery` считала `type !== null` «явно передан» → `''` не проходит валидацию → 400
с тремя ошибками. Фикс: пустая / из пробелов строка → `null` перед валидацией (семантика URL).
`?type=GARBAGE` по-прежнему 400 — контракт «не молча заменять невалидное значение» сохранён для
реально переданных значений. Одна общая функция → чинит и admin, и foreman страницы + оба API.

## Шаг 1b — «Изменить часы» (`543a339`)

**Задача владельца.** Кнопка на карточке табеля, чтобы админ поправил часы сразу, без указания
причины; работник в этом случае ничего не пишет и уведомление не получает.

**Почему не «правка на месте той же версии».** Система построена на неизменяемых `TimesheetVersion`
(на них ссылаются выгрузки, очереди проверки, базовые точки корректировок). Правка версии «на
месте» ломает эти инварианты.

**Решение — переиспользуем механику корректировок с одним отличием.**
- Миграция `20260828120000`: `TimesheetVersionSource += ADMIN_EDIT`; `CorrectionRequest.directEdit
  BOOLEAN NOT NULL DEFAULT false`. Аддитивно.
- `requestCorrection(…, { directEdit: true })` — пустая причина, флаг на строке; запрещено против
  `FINAL_APPROVED`. `applyInReviewCorrection` читает флаг → замораживает версию
  `source=ADMIN_EDIT`, `note=null`, аудит `TIMESHEET_ADMIN_EDIT` (не `CORRECTION_APPROVED`).
- `getWorkerTimesheetSummary` показывает плашку «Часы исправил администратор» только при
  `source=CORRECTION` → для `ADMIN_EDIT` работник **ничего не видит**. Номер версии технически
  растёт (внутренняя механика), но никакой «обвиняющей» подписи / уведомления нет.
- `POST /api/admin/timesheets/[id]/direct-edit`; `DirectEditForm` на карточке табеля; общий
  редактор `/admin/corrections/[id]` + `CorrectionActions` показывают мягкие формулировки
  («Сохранить часы») при `directEdit`.
- Полный аудит `AuditEvent` (actor + before/after) сохраняется всегда.

## Шаг 1a — уведомления «нужно утвердить» (`d8e404e`)

- Миграция `20260828130000`: `AdminNotificationType += TIMESHEET_AWAITING_APPROVAL`;
  `AdminNotification.timesheetId` (nullable, FK `ON DELETE CASCADE`, индекс) + частичный уникальный
  индекс `ux_admin_notification_active_timesheet` (одна активная строка на табель).
- `lib/timesheet-approval-notifications.ts` `ensureTimesheetApprovalNotifications()` — та же схема
  «ensure перед каждым чтением», что у qualification-уведомлений. Одна активная строка на
  `SUBMITTED`/`FOREMAN_APPROVED` табель в OPEN-периоде; резолвится при утверждении / возврате /
  закрытии периода; resubmit → новая строка.
- `NotificationCenter` рендерит новый тип (метка недели из периода, «Открыть табель» →
  `/admin/timesheets/[id]`, тост при первом появлении).
- Календарный бейдж: `ReviewQueueIndicator` теперь раскрывается в drawer с разбивкой по открытым
  периодам («Неделя 18–24 авг · 3»); `GET /api/admin/review-queue` отдаёт `{ count, weeks }`.

## Шаг 2b — авто-точка при открытой смене (`dedf3a0`)

**Ограничение.** Фоновая проверка «раз в 3 часа, телефон в кармане» в PWA на iOS невозможна —
код не выполняется в фоне. Реализован реалистичный вариант: при разворачивании приложения, если
смена открыта и с последней точки прошло ≥3ч — один GPS-фикс в очередь (офлайн-safe), синхронизация
позже. Точка ничего не блокирует и не создаёт исключений — это доказательство «был на месте»
в середине смены. Против «отметился и уехал»: теперь нужна поддельная геолокация всю смену, а не
только в момент чек-ина.

- Миграция `20260828140000`: таблица `ShiftPresenceSample` (сырые координаты, 90-дневная
  ретенция — `runAttendanceLocationRetention` теперь чистит и её). Аддитивно.
- IndexedDB `DB_VERSION` 2 → 3: новый стор `presenceOutbox` (guarded `createObjectStore`, ничего
  существующее не трогается). `lib/offline-outbox/presence.ts` (enqueue + чистое правило
  `shouldCapturePresence` на 3ч + prune) и `presence-sync.ts` (best-effort POST по одной, без
  batch-машины — точки редкие).
- `POST /api/worker/attendance/presence` + `lib/attendance-presence.ts`: session-auth, проверка
  владения устройством, идемпотентность по `clientSampleId`, оценка геозоны (`VERIFIED_INSIDE`/
  `OUTSIDE` → `insideGeofence` true/false, иначе null), `NO_OPEN_SHIFT` → 200 `{recorded:false}`,
  неправдоподобный клок-скью отклоняется.
- `WorkerClockPanel`: захват при развороте пока «в смене»; presence-sync также на событии `online`.
- Админ: карта и список на `/admin/workers/[id]/locations` показывают точки середины смены
  (янтарные, «в зоне / вне зоны / офлайн»), под тем же правом `attendance.gps.read.raw`.

### Что НЕ сделано / осознанные отказы

- **Настоящая фоновая геолокация** — только нативное приложение. Записано как ограничение
  веб-версии; кандидат в роадмап.
- **Детект mock-геолокации / root / jailbreak** — веб не умеет. Тоже роадмап (натив).
- Presence-точка **не привязана к `ClockShift`** (его ещё нет — смена открыта), только к
  `EmployeeOpenShift.id` + `employeeId` + `siteId` + `capturedAt`.
