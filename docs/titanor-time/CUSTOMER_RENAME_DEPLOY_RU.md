# Production deploy — «Рабочая зона» → «Заказчик»

- **Дата:** 2026-09-02.
- **Вердикт:** **PASS**.
- **Product commit / deployed HEAD:** `496aa3c` (`i18n(time): rename "Work area" -> "Customer" across the admin UI`).
- **Образ:** `titanor-time-app:customer-rename-496aa3c`.
- **Scope:** только production web. Scheduler, DB, Caddy, DNS, публичный сайт — не менялись.
  **Только подписи в интерфейсе. Без миграции, без изменения данных или логики.**
- **Основание:** сообщение владельца — `WorkArea` (подразделение объекта) на практике = «заказчик»
  (на одном объекте, напр. Meyer Turku, работают на нескольких заказчиков). «Рабочая зона» вводила
  начальников в ступор.

## Что переименовано (везде в админке): «Рабочая зона» → «Заказчик» / «Work area» → «Customer»

- Страница объекта: секция «Заказчики», «Добавить заказчика», «Отключить заказчика», подсказка
  «Разные заказчики на одном объекте…».
- Назначение работника + «Изменить объект / заказчика»: поле «Заказчик» (остаётся
  **необязательным**), «— без заказчика —», «Сменить только заказчика», «Перевести на другой
  объект / заказчика», сообщения об ошибках.
- Меню и страница `/admin/work-areas` → «Заказчики».
- Чек-лист настройки: пункт «Заказчик».
- Поиск на «Сегодня» / overview: «…объект или заказчик».
- Экраны attendance-исключений: «Объект / заказчик», «Заказчик».
- CSV- и PDF-экспорт: колонка «Заказчик» / «Customer».
- Инструкция (`/guide`): раздел «3. Заказчик», список «Заказчики», описание назначений.
- Приложение работника: подпись текущего назначения — «Заказчик».

**НЕ тронуто (по сути):** модель БД `WorkArea`, `workAreaId`, роуты `/api/admin/sites/:id/work-areas`,
URL `/admin/work-areas`, идентификаторы в коде.

## GPS / геозона — переформулирована, чтобы «зона» не путалась с заказчиком

Геозона привязана к **целому объекту** (как и было). В приложении работника:
- «вы за пределами рабочей зоны» → «вы за пределами территории объекта»;
- «В рабочей зоне» / «Вне рабочей зоны» → «На объекте» / «Вне объекта» (EN «On site» / «Off site»);
- «радиус рабочей зоны» → «радиус геозоны объекта».

## Проверки до deploy

- `tsc --noEmit` чисто; `npm run lint` OK.
- Browser lane: `_test-t9-setup-lifecycle.ts` **105/0** (CH10/CH10b обновлены под новые подписи),
  `_test-t9-full-flow.ts` **84/0** («Add customer»), `_test-t9-setup-ui.ts` **26/0**,
  `_test-t9-role-matrix.ts` **33/0**, `_test-worker-clock-panel.ts` **55/55**.
- Кандидат на `127.0.0.1:3198` против production-схемы: `/api/ready` 200 98/98; `/login` 200;
  `/admin/work-areas` без сессии 307; error-логи 0.
- Verified pre-deploy backup: `production-20260902T134805Z-pre-deploy` (2119 rows, 98 migrations,
  on-box + off-box `SHA256SUMS` OK).

## Swap

- Web-only: `13:48:43Z` → `13:48:44Z`, ready `13:48:47Z` (~4 c), healthy ~+10 c.
- Новый `titanor-time-prod-app`: `customer-rename-496aa3c`, healthy, RestartCount 0.
- Rollback-контейнер: `titanor-time-prod-app-pre-496aa3c` на `end-gt-today-f2c5e57`.
- Scheduler не заменялся: `r14-release-1416503`, тот же StartedAt, RestartCount 0.

## После deploy

- `app.titanorgroup.fi/api/ready` 200 98/98; `/login`, `/guide` 200. Error-логи чисто.
- `titanorgroup.fi/en` + `/fi` 200, `collabstudio.run` 200 — Caddy/DNS не менялись.
- **Live (read-only) под `pilot-owner`:** `/admin/work-areas` → «Заказчики» (старого термина нет);
  карточка работника, «Изменить объект / заказчика» → «Сменить только заказчика» /
  «Перевести на другой объект / заказчика»; страница объекта → секция «Заказчики» + «Добавить заказчика».

## Rollback

До завершения R15 не удалять `titanor-time-prod-app-pre-496aa3c` и pre-deploy backup.
`docker rm -f titanor-time-prod-app && docker rename titanor-time-prod-app-pre-496aa3c
titanor-time-prod-app && docker start titanor-time-prod-app`. DB restore не нужен.

## Не сделано

- Опубликованный HTML-артефакт руководства (`claude.ai/code/artifact/019e3f38-…`) — статичный,
  содержит «Рабочая зона». В приложении `/guide` уже обновлён. Артефакт при желании обновить отдельно.
