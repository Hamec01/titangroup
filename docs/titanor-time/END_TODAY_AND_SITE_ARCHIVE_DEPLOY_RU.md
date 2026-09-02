# Production deploy — «Завершить сегодня» + «Объект завершён / восстановить»

- **Дата:** 2026-09-02.
- **Вердикт:** **PASS**.
- **Product commit / deployed HEAD:** `7b3cb94` (`feat(time): end-assignment "today" works + finish/reopen a site`).
- **Образ:** `titanor-time-app:end-today-7b3cb94`.
- **Scope:** только production web. Scheduler (`r14-release-1416503`), DB, Caddy, DNS, публичный
  сайт — не менялись. **Без миграции.**
- **Основание:** срочное сообщение владельца 2026-09-02 — «старый объект прямо щас нужно у работника
  убрать и мне не даёт… мне нужно сделать это сегодня, а не 13.09!!». Плюс Деплой 2a из плана D5
  (архив объектов).

## 1. «Завершить» назначение теперь работает «сегодня»

**Было:** «Завершить» упиралось в авто-созданные плановые смены на весь открытый период и двигало
дату окончания на конец периода (13.09).

**Стало:** `POST /api/admin/assignments/:id/end` удаляет **собственные будущие черновые плановые
смены** назначения (`TimesheetDraftPlannedShift`, даты после даты окончания) — это просто
«график ожидает работу», не отмеченные часы — и завершает назначение сегодня.
- **Реально отмеченные / сданные часы** после даты (`WorkSegment` / `TimesheetPlannedShift` /
  `TimesheetDraftSegment` / `ClockShiftFragment`) по-прежнему блокируют завершение чистым **409
  `ASSIGNMENT_HAS_RECORDED_TIME`** с `earliestValidTo` — их правят в табеле.
- `latestBoundShiftDates` больше не учитывает `TimesheetDraftPlannedShift`, поэтому форма
  «Завершить» на карточке по умолчанию ставит **сегодня** для назначения без отмеченных часов.
- То же самое уже делает `/change` для старого назначения при переводе — теперь `/end` и `/change`
  согласованы.

## 2. «Объект завершён» / «Восстановить объект»

- На странице объекта — заметная секция **«Статус объекта»** с кнопкой **«Объект завершён»**
  (с подтверждением) / **«Восстановить объект»**. Под капотом — существующий
  `PATCH /api/admin/sites/:id { version, active }`, нового endpoint нет. Физически объект не
  удаляется (на него ссылаются геозоны, назначения, отработанные часы — by design).
- `/admin/sites` по умолчанию **скрывает завершённые объекты**; в подзаголовке переключатель
  **«Показать завершённые (N)» / «Скрыть завершённые»** (`?closed=1`). `listSites` возвращает
  `closedCount`.
- Пикеры объектов в «Добавить объект» и «Изменить объект / зону» теперь запрашивают
  `?active=true` — завершённые объекты не предлагаются при назначении.

## Проверки до deploy

- `tsc --noEmit` чисто; `npm run lint` OK.
- Browser lane (одноразовый PG16): `_test-t9-setup-lifecycle.ts` **103/0** (WA4–WA8 переписаны:
  форма ставит сегодня, «Завершить сегодня» = 200, будущие плановые смены удалены, назначение-строка
  сохранена; реально отмеченное время → 409 `ASSIGNMENT_HAS_RECORDED_TIME`; секция Sites: скрытие по
  умолчанию, `?closed=1`, кнопка «Восстановить объект»), `_test-t9-setup-ui.ts` **26/0**,
  `_test-t9-role-matrix.ts` **33/0**, `_test-t9-full-flow.ts` **84/0**.
- Кандидат на `127.0.0.1:3198` против production-схемы: `/api/ready` 200 98/98; `/login` 200;
  `/admin/sites`, `?closed=1` без сессии 307; `/api/admin/sites?active=true` без сессии 401;
  `POST …/end` без сессии 401; error-логи 0. Контейнер удалён.
- Verified pre-deploy backup: `production-20260902T114839Z-pre-deploy` (2121 rows, 98 migrations,
  on-box + off-box `SHA256SUMS` OK).

## Swap

- Web-only: stop+run `11:49:17Z` → `11:49:18Z`, ready `11:49:22Z` (~4 c), healthy ~+10 c.
- Новый `titanor-time-prod-app`: `end-today-7b3cb94`, healthy, RestartCount 0.
- Rollback-контейнер: `titanor-time-prod-app-pre-7b3cb94` на `worker-change-bee072d`.
- Scheduler не заменялся: `r14-release-1416503` (`sha256:864267bb…`), тот же StartedAt, RestartCount 0.

## После deploy

- `https://app.titanorgroup.fi/api/ready` 200 98/98; `/login` 200. Error-логи прод-app чисто.
- `titanorgroup.fi/en` + `/fi` 200, `collabstudio.run` 200 — Caddy/DNS не менялись.
- **Live-проверка под `pilot-owner` (read-only):** карточка Nazar Druz — форма «Завершить» у обоих
  назначений (Meyer Turku Shipyard и Meyer Turku Shipyard — Aros Marine) по умолчанию ставит
  **2026-09-02 (сегодня)**, а не конец периода. Ничего не завершали.
- Prod app/scheduler/db healthy, RestartCount 0.

## Rollback

До завершения R15 не удалять `titanor-time-prod-app-pre-7b3cb94` и pre-deploy backup.
`docker rm -f titanor-time-prod-app && docker rename titanor-time-prod-app-pre-7b3cb94
titanor-time-prod-app && docker start titanor-time-prod-app`. DB restore не нужен (миграции нет).

## Follow-up: `end-gt-today-f2c5e57` (2026-09-02 12:27 UTC)

Владелец завершил назначение Nazar Druz **3 раза** датой «сегодня» — оно завершалось, но карточка
считала «заканчивается сегодня» = «ещё действует» (`validTo >= today`) и продолжала показывать
(ушло бы только завтра).

**Фикс:** `lib/workers.ts` `currentAssignmentWhere` теперь сравнивает `validTo` с `> today`
(не `>=`). Назначение, завершённое сегодняшним числом, **сразу** уходит из «Текущих назначений»
в блок «Прошлые назначения». Путь отметок работника (`lib/worker-context.ts`,
`lib/attendance-clock.ts`) сохраняет свой инклюзивный (`>=`) фильтр — работник дорабатывает
сегодняшнюю смену.

- Browser lane 105/26/33/84. Backup `production-20260902T122629Z-pre-deploy`. Swap ~4 c.
  Rollback: `titanor-time-prod-app-pre-f2c5e57`. Scheduler не тронут.
- Live (read-only): Nazar Druz — «Meyer Turku Shipyard» ушёл в «Прошлые назначения (1)», в текущих
  осталась только зона Aros Marine.
- Ruslan Druz — его «Meyer Turku Shipyard» был завершён датой **13.09** (до утреннего фикса), висит
  до 13-го. Владельцу: нажать «Завершить» ещё раз (дата подставится сегодня) → уйдёт сразу.

## Осталось (Деплой 2b + D3)

- **Деплой 2b:** групповой перевод работников; пометка в табеле «Объект изменён DD.MM в HH:MM: A → B».
- **D3:** расчётный лист по рабочей зоне.
