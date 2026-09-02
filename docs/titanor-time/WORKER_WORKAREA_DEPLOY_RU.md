# Production deploy — раб.зона в карточке работника + «Завершить» назначение

- **Дата:** 2026-09-02.
- **Вердикт:** **PASS**.
- **Product commit / deployed HEAD:** `ae92b9a` (`fix(time): end-assignment 409 instead of 500
  when shifts follow the date`), включает `944ba82` (`feat(time): show work area on the worker
  card + End assignment there`).
- **Образ:** `titanor-time-app:worker-workarea-ae92b9a`
  (`sha256:0ccba44c7f50f9d2d3dfe4285aa7ea3859094ecebcbc3ded00ca1741841ec2c4`).
- **Scope:** только production web. Scheduler (`r14-release-1416503`), DB, Caddy, DNS, публичный
  сайт — не менялись. **Без миграции.**
- **Основание:** сообщения владельца 2026-09-01/02 — «непонятки у заказчика с добавлением рабочей
  зоны и объекта»: (а) «после создать назначение не всегда подхватывает»; (б) «нет функции убрать
  объект или раб.зону»; (в) «раб.зона не пишется у человека, пишется только объект». Плюс: «в
  редакторе через админку мы должны видеть где работник работает, на каком объекте в какой раб.зоне,
  и уметь снимать его с этой раб.зоны или объекта». Ограничение владельца: «Сделай грамотно и не
  сломай привязки GPS и другой функционал».

## Что изменено

### 1. Раб.зона видна везде (было: только объект)
- `lib/workers.ts` `CurrentAssignment` — добавлены `assignmentId`, `workAreaId`, `workAreaName`,
  `validFrom`, `validTo`. `getWorkerDetail` и `listWorkers` тянут `workArea { id, name }`.
- Карточка работника и список `/admin/workers` — колонка/строка назначения теперь
  `Объект — Раб.зона (основной)`.

### 2. «После создать назначение не всегда подхватывает» — исправлено
- Причина: карточка работника ключевала список назначений по `key={assignment.siteId}`. Два
  назначения на **одном** объекте с **разными** раб.зонами (случай владельца: «на одном объекте
  2 разных заказчика») → React считал их одной строкой и рисовал только первую. Выглядело как
  «второе назначение не создалось».
- Теперь `key={assignment.assignmentId}` — оба показываются, каждое со своей раб.зоной.

### 3. «Убрать объект или раб.зону» — кнопка «Завершить» на карточке
- `EndAssignmentAction.tsx` переиспользован на карточке работника (раньше был только на
  `/admin/assignments`). У каждого текущего назначения — кнопка **«Завершить»** → форма с датой
  окончания и причиной. Вызывает существующий `POST /api/admin/assignments/:id/end`.
- **Запись назначения не удаляется** — ставится `validTo` + `endedReason` + `AuditEvent
  ASSIGNMENT_ENDED`, `version++`. Физического DELETE у `SiteAssignment` нет by design
  (`T9_INTERNAL_TEST_PLAN.md` §1 — осиротил бы историю табелей/GPS). После даты окончания
  назначение автоматически уходит из «текущих» и из вариантов отметки у рабочего (тот же фильтр
  `currentAssignmentWhere` в `lib/workers.ts` и `lib/worker-context.ts`).
- **Привязки GPS не тронуты**: geofence привязан к объекту (`WorkSite`), не к назначению; путь
  отметки рабочего читает те же «текущие назначения».

### 4. Баг `POST /api/admin/assignments/:id/end` — 500 → понятный 409
- Найден при тестах. `fn_site_assignment_dependents_guard` (TRG-11, `05_RAW_SQL_REGISTER.md`)
  кидает `ASSIGNMENT_DEPENDENTS_CONFLICT` (P0001), если `validTo` ставят раньше уже созданных
  плановых/фактических смен назначения. `assignment.create` создаёт `TimesheetDraftPlannedShift`
  на весь открытый период вперёд → **любое «завершить сегодня» роняло endpoint в сырой HTTP 500**
  (без обработки в route). Это же касалось и `/admin/assignments`.
- `end/route.ts` — транзакция в `try/catch`; `ASSIGNMENT_DEPENDENTS_CONFLICT` → **409
  `ASSIGNMENT_HAS_DEPENDENTS`** с полем `earliestValidTo` (последний день, за который есть
  плановая/фактическая смена). Поведение данных не меняется, миграции нет.
- `lib/workers.ts` — `latestBoundShiftDates` / `earliestAssignmentEndDate` /
  `assignmentEndDateDefaults`: максимальная дата плановой/фактической смены по тем же 4 таблицам,
  что проверяет триггер.
- Карточка работника: форма «Завершить» **сама подставляет** эту безопасную дату (конец текущего
  периода) — обычный клик всегда проходит.
- `EndAssignmentAction`: при `ASSIGNMENT_HAS_DEPENDENTS` переносит поле даты на `earliestValidTo` и
  просит подтвердить ещё раз.

## Проверки до deploy

- `tsc --noEmit` чисто; `npm run lint` — все проверки OK (`prisma validate` ok).
- Browser lane (одноразовый PG16 + app из кандидата):
  - `_test-t9-setup-lifecycle.ts` **85/0** — новые шаги **WA1–WA8**: два заказчика = две раб.зоны
    на одном объекте, оба назначения создаются и **оба видны** на карточке; «Завершить» подставляет
    безопасную дату; завершение по ней = 200 и строка сохранена (`validTo` + `endedReason`);
    завершение слишком ранней датой = чистый **409 `ASSIGNMENT_HAS_DEPENDENTS`** (не 500) с
    `earliestValidTo`, при этом назначение не изменено.
  - `_test-t9-setup-ui.ts` **26/0**, `_test-t9-role-matrix.ts` **33/0**, `_test-t9-full-flow.ts` **84/0**.
- Кандидат на `127.0.0.1:3198` против **production-схемы**: `/api/ready` 200 98/98; `/login` 200;
  `/admin/workers`, `/admin/assignments` без сессии 307; `POST …/assignments/<uuid|not-a-uuid>/end`
  без сессии 401 (auth раньше всего, без oracle); error-логи 0. Контейнер удалён.
- Verified pre-deploy backup: `production-20260902T082811Z-pre-deploy`
  (2108 rows, 98 migrations, on-box + off-box `SHA256SUMS` OK).

## Swap

- Web-only: stop+run `08:28:51Z` → `08:28:52Z`, ready `08:28:54Z` (~3 c), healthy ~+10 c.
- Новый `titanor-time-prod-app`: `worker-workarea-ae92b9a`, healthy, RestartCount 0.
- Rollback-контейнер: `titanor-time-prod-app-pre-ae92b9a` на `worker-archive-08acb30`.
- Scheduler не заменялся: `r14-release-1416503` (`sha256:864267bb…`), тот же StartedAt
  `2026-08-31T15:48:16Z`, RestartCount 0.

## После deploy

- `https://app.titanorgroup.fi/api/ready` 200 98/98; `/login` 200. Error-логи прод-app с момента
  swap — чисто.
- `titanorgroup.fi/en` + `/fi` 200, `collabstudio.run` 200 — Caddy/DNS не менялись.
- **Live-проверка под `pilot-owner` (SUPER_ADMIN) на реальных данных:**
  - Список `/admin/workers`: у Nazar Druz (#1002) видно `Meyer Turku Shipyard (основной),
    Meyer Turku Shipyard — Aros Marine (основной)` — ровно случай владельца (2 заказчика на одной
    верфи).
  - Карточка Nazar Druz: два текущих назначения, каждое с раб.зоной, у каждого кнопка «Завершить».
  - Форма «Завершить» подставила `validTo = 2026-09-13` (конец текущего периода) — не «сегодня»,
    не дату-которая-роняла-в-500. **Ничего не завершали** (Отмена).
  - `/admin/assignments`: 13 строк, 13 кнопок «Завершить», рендерится.
- Prod app/scheduler/db healthy, RestartCount 0.

## Rollback

До завершения R15 не удалять `titanor-time-prod-app-pre-ae92b9a` и pre-deploy backup.
`docker rm -f titanor-time-prod-app && docker rename titanor-time-prod-app-pre-ae92b9a
titanor-time-prod-app && docker start titanor-time-prod-app`. DB restore не нужен (миграции нет).

## Не сделано (осознанно)

- **Расчётный лист по раб.зоне** (сообщение владельца 25: «расчётный лист можно было делать не
  только по объекту но и по раб.зоне… раб.зона не ниже по важности чем объект»). Это следующая,
  бо́льшая задача — трогает `lib/site-time-report.ts`, `/admin/reports/sites`, «Часы заказчику»
  (`/admin/reports/customer`), возможно CSV-экспорт. Не начата.
- Досрочное завершение (раньше конца текущего периода, «убрать сегодня») по-прежнему требует
  сначала разобраться с плановыми сменами периода — endpoint теперь объясняет это (409 с датой),
  но автоматически их не удаляет. Массовая правка плановых смен = отдельная задача с отдельным
  разрешением (payroll-adjacent, идёт R15).
- `/admin/workforce` матрица и пикеры отчётов — свой фильтр, не трогал, чтобы deploy оставался узким.
