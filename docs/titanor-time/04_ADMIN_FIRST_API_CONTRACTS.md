# Titanor Time — API-контракты первого Admin-first вертикального сценария

Версия: **5.4.1** (2026-07-23). Статус: **proposed architecture**. Покрывает эндпоинты, нужные для
сценария:

```text
admin создаёт объект → рабочую область → шаблон → регистрирует работника
→ назначает на объект+шаблон → открывает период → выдаёт код активации
→ работник активируется → входит → видит своё назначение
```

плюс минимальный набор для рабочего кабинета (проверка шага 13) и административный fallback для
проверки табелей (нужен, если единственный прораб объекта сам держит роль `WORKER`, см.
`02_ROLE_PERMISSION_MATRIX.md`, `timesheet.scope_review.all`).

Не покрыты здесь (спроектированы в `01_...`/`02_...`/`03_...`, вне первого среза): проверка
прорабом (`/api/foreman/*`), финальное утверждение, экспорт, корректировки, аудит-UI, восстановление
пароля, управление системными пользователями, MFA-flow.

## 0. Общие соглашения

**Base URL**: `https://app.titanorgroup.fi/api` (preview: `https://app-preview.titanorgroup.fi/api`).

**Аутентификация**: `httpOnly`, `Secure`, `SameSite=Lax` cookie `tt_session` с непрозрачным
случайным токеном ≥32 байт. `SHA-256(token)` ищется в `UserSession.tokenHash`.

**CSRF**: `SameSite=Lax` + обязательный заголовок `X-Requested-With: titanor-time` на мутирующих
запросах — отсутствие → `403 CSRF_REJECTED`.

**Request ID**: каждый ответ содержит `X-Request-Id` = `error.requestId`.

**Idempotency**: `Idempotency-Key` (UUID) обязателен/опционален per endpoint. Сервер ищет
существующую запись по `(actorUserId, httpMethod, routeTemplate, idempotencyKey)` — без
path-параметров в ключе поиска. Отдельно вычисляет `requestHash = SHA-256(canonical path params +
relevant query + canonical body)`.

- Записи нет → создать `PROCESSING`, обработать запрос, сохранить `encryptedResponseBody`
  (AES-256-GCM) + `requestHash`, перевести в `COMPLETED`.
- Запись есть, `status=COMPLETED`, `requestHash` совпадает → расшифровать и вернуть закешированный
  ответ целиком.
- Запись есть, `status=COMPLETED`, `requestHash` не совпадает (тот же ключ, другая цель/тело) →
  `409 IDEMPOTENCY_KEY_REUSED`.
- Запись есть, `status=PROCESSING` → `409 IDEMPOTENCY_KEY_IN_PROGRESS`.

**Границы дат**: `validFrom`/`validTo`/`startDate`/`endDate` — включительно с обеих сторон.

**Рабочие интервалы всегда закрыты.** Ни один запрос, создающий или изменяющий
`WorkSegment`/`TimesheetDraftSegment`/`CorrectionDraftSegment`/`proposedSegments[]`, не принимает
отсутствующий `endAt` — отсутствие поля или `null` → `400 VALIDATION_ERROR`.

**`sourceAssignmentId` резолвится сервером, не клиентом.** Ни один запрос, создающий сегмент
(`WorkSegment`/`TimesheetDraftSegment`/`CorrectionDraftSegment`), не принимает `sourceAssignmentId` в
теле — сервер резолвит его сам: уникальный активный `SiteAssignment` этого `employeeId`+`siteId`+
`workAreaId`, действующий на календарную дату дня (`03_...`, §4.6). Если такого назначения нет —
`404 SITE_NOT_ASSIGNED`. Нужен, чтобы сравнение факта с планом (`hasException`) не путало два
одновременных назначения одного работника на один объект с разными `workAreaId`/шаблонами.

**Формат ошибки** (единый):

```json
{
  "error": {
    "code": "ASSIGNMENT_OVERLAP",
    "message": "Employee already has an active assignment for this site and work area",
    "fieldErrors": { "validFrom": ["Assignment overlaps an existing assignment on the same site"] },
    "requestId": "b3f1c2a4-..."
  }
}
```

**Пагинация/поиск/фильтр/сортировка**: `?page=1&pageSize=20&search=...&sort=lastName:asc&<filters>`
→ `{ "items": [...], "page", "pageSize", "totalItems", "totalPages" }`.

**Персональные данные**: ответы никогда не содержат `passwordHash`, `tokenHash`, `twoFactorSecret`,
сырой код активации после первого показа, IP/UA других пользователей, диагноз/детали `Absence`.

## 1. Авторизация

#### `POST /api/auth/login`
- Permission: публичный
- Request: `{ "identifier": "1042", "password": "..." }`
- Response `200`: `{ "user": { "id", "username", "roles": ["WORKER"], "locale" } }`
- Ошибки: `401 INVALID_CREDENTIALS`, `403 ACCOUNT_DEACTIVATED`, `403 ACCOUNT_PENDING_ACTIVATION`,
  `429 RATE_LIMITED`
- `T7A §13`: reserved SYSTEM actor (`userKind=SYSTEM`) всегда отклоняется — тем же `401
  INVALID_CREDENTIALS`, не отдельным кодом (не должен подтверждать существование
  `system.scheduler`), с той же dummy-verify задержкой, что и неизвестный identifier. Проверка не
  зависит от `status` — уже сегодня `DEACTIVATED` отклонил бы вход, но это не структурная
  гарантия, отдельная от неё.
- Rate limit: 5/15мин на `identifier` + 50/15мин на IP
- Audit: `LOGIN_SUCCEEDED` / `LOGIN_FAILED`

#### `POST /api/auth/logout`
- Permission: аутентифицирован
- Response `204`
- Audit: `SESSION_REVOKED`

#### `POST /api/auth/logout-all`
- Permission: `session.revoke_all.own`
- Response `204` (отзывает все сессии, включая текущую)
- Audit: `SESSION_REVOKED_ALL`

#### `GET /api/auth/session`
- Permission: аутентифицирован
- Response `200`: `{ "user": { "id", "username", "roles": [...], "locale" } }`
- Ошибки: `401 NOT_AUTHENTICATED`

#### `GET /api/auth/activate?token=...`
- Permission: публичный, валидный `ActivationToken`
- Response `200`: `{ "employeeFirstName": "Juha", "employeeLastNameInitial": "K." }`
- Ошибки: `410 TOKEN_EXPIRED`, `410 TOKEN_USED`, `404 TOKEN_INVALID`

#### `POST /api/auth/set-initial-password`
- Permission: публичный, валидный `ActivationToken`
- Request: `{ "token", "password" }`
- Response `200`: тело как `POST /api/auth/login` (авто-логин)
- Ошибки: `400 VALIDATION_ERROR`, `404 TOKEN_INVALID`, `409 ACCOUNT_NOT_ELIGIBLE`,
  `410 TOKEN_EXPIRED`, `410 TOKEN_USED`, `429 RATE_LIMITED`
- Audit: `ACCOUNT_ACTIVATED`

## 2. Города

#### `GET /api/admin/cities`
- Permission: `city.read.all`
- Response `200`: `{ "items": [{ "id", "name" }] }`

#### `POST /api/admin/cities`
- Permission: `city.create`
- Request: `{ "name": "Helsinki" }`
- Response `201`: `{ "id", "name" }`
- Ошибки: `400 VALIDATION_ERROR`, `409 DUPLICATE_CITY_NAME`
- Idempotency: поддерживается
- Audit: `CITY_CREATED`

## 3. Объекты

#### `GET /api/admin/sites`
- Permission: `site.read.all`
- Query: `page`, `pageSize`, `search`, `cityId`, `active`, `sort`
- Response `200`: список `{ id, name, cityId, active, activeAssignmentsCount, version }`

#### `POST /api/admin/sites`
- Permission: `site.create`
- Request: `{ "name", "cityId"?, "address"?, "description"? }`
- Response `201`: `WorkSite`, `version: 1`
- Ошибки: `400 VALIDATION_ERROR`, `404 CITY_NOT_FOUND`
- Idempotency: поддерживается
- Audit: `SITE_CREATED`

#### `GET /api/admin/sites/:siteId`
- Permission: `site.read.all`
- Response `200`: `WorkSite` + `workAreas: []`, `activeAssignments: []`, `foremanAssignments: []`
- Ошибки: `404 SITE_NOT_FOUND`

#### `PATCH /api/admin/sites/:siteId`
- Permission: `site.update`
- Request: `{ "version", ...частичные поля }`
- Ошибки: `404`, `409 VERSION_CONFLICT`, `400 VALIDATION_ERROR`
- Audit: `SITE_UPDATED`

#### `GET /api/admin/sites/:siteId/work-areas`
- Permission: `workarea.read.all`
- Query: `page`, `pageSize`, `active`
- Response `200`: список `{ id, name, active, version }`
- Ошибки: `404 SITE_NOT_FOUND`

#### `POST /api/admin/sites/:siteId/work-areas`
- Permission: `workarea.create`
- Request: `{ "name" }`
- Response `201`: `WorkArea`, `version: 1`
- Ошибки: `404 SITE_NOT_FOUND`, `409 DUPLICATE_WORK_AREA_NAME`, `400 VALIDATION_ERROR`
- Idempotency: поддерживается
- Audit: `WORK_AREA_CREATED`

#### `PATCH /api/admin/sites/:siteId/work-areas/:workAreaId`
- Permission: `workarea.update`
- Request: `{ "version", "name"?, "active"? }`
- Ошибки: `404`, `409 VERSION_CONFLICT`, `409 DUPLICATE_WORK_AREA_NAME`, `400 VALIDATION_ERROR`
- Audit: `WORK_AREA_UPDATED`

### 3.1 Геозона объекта (T7A.2, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §12.1/§16 "Geofence admin" —
реализовано) — `lib/geofences.ts`

`WorkSiteGeofenceVersion` — immutable, append-only (`trg_geofence_version_immutable`, DB-уровень,
не только соглашение API): `PATCH`/`DELETE` напрямую SQL отклонены триггером; редактирование
геозоны всегда создаёт новую версию, `WorkSite.currentGeofenceVersionId` атомарно переключается на
неё. `latitude`/`longitude` сериализуются как **decimal-строки** с ровно 6 знаками после точки
(`numeric(8,6)`/`numeric(9,6)`, `"60.169900"`), никогда как bare JS number — не теряет точность,
стабильно между запросами.

#### `GET /api/admin/sites/:siteId/geofence-versions`
- Permission: `attendance.geofence.read`
- Query: `page` (default `1`), `pageSize` (default `20`, максимум `100`)
- Response `200`:
  ```jsonc
  {
    "siteId": "uuid",
    "currentGeofenceVersionId": "uuid | null",
    "current": { "id", "versionNumber", "latitude", "longitude", "radiusMeters", "createdByUserId", "createdByUsername", "createdAt" } | null,
    "items": [ /* та же форма, versionNumber DESC (newest-first) */ ],
    "page", "pageSize", "totalItems", "totalPages"
  }
  ```
- `current=null`/`items=[]`, если геозона объекта ещё не настроена — не ошибка
- Никогда не возвращает `ClockEventLocation`/сырые GPS-координаты сотрудников — только
  собственную, фиксированную конфигурацию объекта
- Ошибки: `401 NOT_AUTHENTICATED`, `403 FORBIDDEN`, `404 SITE_NOT_FOUND` (malformed и
  несуществующий `siteId` дают идентичный ответ — без UUID-oracle)

#### `POST /api/admin/sites/:siteId/geofence-versions`
- Permission: `attendance.geofence.update`
- CSRF: `X-Requested-With: titanor-time`
- Idempotency: **обязателен** — `Idempotency-Key: <uuid>`, тот же шифрованный механизм, что
  `POST /api/admin/workers` (`lib/idempotency.ts`); `requestHash` включает `siteId` (path param) +
  canonical body — точный повтор того же `key`+`body` возвращает тот же `201`-ответ без новой
  версии; тот же `key` с другим `siteId`/телом → `409 IDEMPOTENCY_KEY_REUSED`; конкурентный запрос
  с тем же `key`, ещё не завершённый → `409 IDEMPOTENCY_KEY_IN_PROGRESS`
- Request: `{ "latitude": number, "longitude": number, "radiusMeters": number }` — все поля
  обязательны; неизвестные поля в теле не влияют на запись (включая попытку подсунуть
  `currentGeofenceVersionId`)
- Validation (`400 VALIDATION_ERROR`, `fieldErrors` по каждому полю независимо):
  - `latitude`: конечное число, `-90..90`, **максимум 6 знаков после точки** — избыточная
    точность отклоняется целиком (`round-trip` через `Math.round(v·1e6)/1e6`), никогда не
    округляется молча;
  - `longitude`: то же, `-180..180`;
  - `radiusMeters`: целое число, `1..2000`
- Транзакция (одна): `WorkSite SELECT ... FOR UPDATE` → под локом переподтвердить существование
  (`404 SITE_NOT_FOUND` иначе) → вычислить следующий `versionNumber` из свежего состояния под
  локом → `INSERT WorkSiteGeofenceVersion` → `UPDATE WorkSite.currentGeofenceVersionId` → `INSERT
  AuditEvent` → `COMMIT`. Два конкурентных `POST` одного объекта сериализуются на локе объекта и
  получают последовательные уникальные `versionNumber`; разные объекты не блокируют друг друга.
  Существующие версии никогда не переписываются.
- Response `201`: та же форма записи, что `current`/`items[]` выше, плюс
  `"currentGeofenceVersionId"` (всегда равен `id` только что созданной версии)
- Ошибки: `401 NOT_AUTHENTICATED`, `403 FORBIDDEN`, `403 CSRF_REJECTED`, `404 SITE_NOT_FOUND`,
  `400 VALIDATION_ERROR`, `400` (`Idempotency-Key` отсутствует/не UUID), `409
  IDEMPOTENCY_KEY_REUSED`, `409 IDEMPOTENCY_KEY_IN_PROGRESS`
- Audit: `SITE_GEOFENCE_VERSION_CREATED`, `entityType WORK_SITE_GEOFENCE_VERSION`, `entityId` =
  id новой версии; `beforeValue`/`afterValue` содержат только `siteId`/version id/versionNumber/
  `radiusMeters` — **`latitude`/`longitude` никогда не попадают в `AuditEvent`**, координаты не
  логируются через `console`/`error`/`debug` нигде в этом пути

## 4. Рабочие шаблоны

`POST` создаёт `WorkScheduleTemplate`+версию 1; `PATCH` создаёт новую версию.

#### `GET /api/admin/templates`
- Permission: `template.read.all`
- Query: `page`, `pageSize` (default 20, max 100) — общий пагинационный конвеншен §0
- Response `200`:
```json
{ "items": [{ "id": "uuid", "name": "Standard Week", "description": null, "active": true,
  "currentVersionId": "uuid", "currentVersionNumber": 1, "workingDaysCount": 5 }],
  "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
```
- `currentVersion*` — версия с максимальным `versionNumber` для шаблона (одна дополнительная
  batched-запрос на relation, не N+1 в коде); `workingDaysCount` — количество дней текущей версии с
  `isWorkingDay=true`. `createdByUserId` не возвращается — внутренняя техническая деталь.
- Реализовано: 🟢 (read-only срез; `PATCH` — §ниже, отдельная будущая задача)

#### `POST /api/admin/templates`
- Permission: `template.create`
- Request: `{ "name", "description"?, "days": [7 × {weekday, isWorkingDay, plannedStartTime?, plannedEndTime?, plannedBreakMinutes}] }`
- Response `201`: `{ "id", "name", "currentVersionId", "currentVersionNumber": 1, "days": [...] }`
- Ошибки: `400 VALIDATION_ERROR`
- Idempotency: поддерживается
- Audit: `TEMPLATE_CREATED`

#### `GET /api/admin/templates/:templateId`
- Permission: `template.read.all`
- Response `200`: `{ "id", "name", "description", "active", "currentVersionId",
  "currentVersionNumber", "days": [{weekday, isWorkingDay, plannedStartTime, plannedEndTime,
  plannedBreakMinutes}] }` — только текущая версия; время в формате `"HH:MM"` (тот же формат, что
  принимает `POST`)
- Ошибки: `404 TEMPLATE_NOT_FOUND` (в т.ч. для синтаксически некорректного UUID — path-параметр
  проверяется regex-ом до похода в БД, чтобы не дать Postgres бросить `22P02` на `uuid`-каст, что
  иначе всплыло бы как `500`)
- Реализовано: 🟢

#### `PATCH /api/admin/templates/:templateId`
- Permission: `template.update`
- CSRF обязателен (как везде в §0)
- Request: `{ "expectedVersionNumber": 1, "name"?: "Standard schedule", "description"?: "text"|null,
  "days"?: [7 × {weekday, isWorkingDay, plannedStartTime?, plannedEndTime?, plannedBreakMinutes}] }`
  — `expectedVersionNumber` обязателен; хотя бы одно из `name`/`description`/`days` обязательно
  присутствовать в теле; `days`, если передан, — те же 7-day инварианты, что `POST` (общая
  валидация/formatting — `validateTemplateDays`/`parseTemplateTimeToDate` в `lib/templates.ts`,
  не дублируется между `POST` и `PATCH`)
- Response `200`: `{ "id", "name", "description", "active", "currentVersionId",
  "currentVersionNumber", "days" }`
- Ошибки: `404 TEMPLATE_NOT_FOUND` (неизвестный или malformed `templateId` — без `500`),
  `409 VERSION_CONFLICT` (`expectedVersionNumber` не совпадает с текущим максимальным
  `versionNumber` — проверяется под `SELECT ... FOR UPDATE` на строке `WorkScheduleTemplate`, что
  делает конкурентные `PATCH` безопасными: ровно один создаёт новую версию, остальные получают
  `409`, версия «через одну» не появляется), `403 FORBIDDEN`, `403 CSRF_REJECTED`,
  `400 VALIDATION_ERROR`
- **Транзакция**: лочит `WorkScheduleTemplate` (`FOR UPDATE`) → перечитывает максимальный
  `versionNumber` → сверяет `expectedVersionNumber` → при совпадении: (если переданы) обновляет
  `name`/`description` шаблона, создаёт новую `WorkScheduleTemplateVersion` (`versionNumber+1`),
  создаёт её 7 `WorkScheduleTemplateVersionDay` (из `days`, если переданы, иначе — точная копия
  дней предыдущей версии), пишет `TEMPLATE_UPDATED` — одной атомарной транзакцией, всё откатывается
  при любой ошибке
- **No-op**: если после разрешения (`name`/`description`/`days`, не переданные в запросе, берутся
  из текущего состояния) итоговые metadata и все 7 дней совпадают с текущей версией байт-в-байт —
  новая версия и `AuditEvent` **не создаются**, ответ `200` с текущими (неизменными) данными
- **Snapshot semantics** (§4.5): существующие `SiteAssignment.templateVersionId` не меняются этим
  эндпоинтом никогда; новая версия становится «текущей» только для *новых* назначений/периодов;
  перевод уже начавшегося назначения на новую версию — `POST
  /api/admin/assignments/:assignmentId/split`, не эта операция
- `active` — read-only в этом срезе, `PATCH` его не принимает
- Audit: `TEMPLATE_UPDATED` (`beforeValue`/`afterValue` содержат `versionNumber`/`name`/
  `description`; никогда cookies/passwords/session/token) — только для реально изменившего запроса;
  отклонённый (`400`/`403`/`404`/`409`) и проигравший конкурентный запрос не создают audit
- Реализовано: 🟢

## 5. Работники

**`username` — логин, независим от `employeeNumber`** (см. `03_DATA_MODEL_ERD.md` §4.1/§4.2,
`lib/worker-usernames.ts`). Генерируется при создании (`lastName`+первая буква `firstName`,
транслитерация+коллизионный суффикс), возвращается аддитивно во всех эндпоинтах ниже. Смена
логина у уже существующего Worker'а — только через отдельный явный
`POST .../regenerate-username`.

#### `GET /api/admin/workers`
- Permission: `worker.read.all`
- Response `200`:
```json
{ "items": [{ "id": "uuid", "employeeNumber": "1042", "firstName": "Juha", "lastName": "Korhonen",
  "username": "korhonenj", "active": true, "currentAssignments": [{ "siteId": "uuid",
  "siteName": "Kamppi Renovation", "isPrimary": true }] }], "page": 1, "pageSize": 20,
  "totalItems": 1, "totalPages": 1 }
```

#### `POST /api/admin/workers`
- Permission: `worker.create`
- Request: `{ "firstName", "lastName", "phone"?, "employeeNumber"? }`
- Response `201`: `{ "employee": {...}, "userId", "username", "userStatus": "PENDING_ACTIVATION" }`
  — не возвращает код активации; `username` сгенерирован из `firstName`/`lastName`, **не** равен
  `employeeNumber`
- Ошибки: `400 VALIDATION_ERROR`, `409 DUPLICATE_EMPLOYEE_NUMBER`, `409 USERNAME_CONFLICT`
  (крайне редкий — реальная гонка на уровне DB UNIQUE после advisory-lock; безопасно повторить
  запрос)
- Idempotency: обязателен
- Audit: `WORKER_CREATED` (аддитивно содержит `username`)

#### `GET /api/admin/workers/:employeeId`
- Permission: `worker.read.all`
- Response `200`: `Employee`+`Employment`+`currentAssignments: []`+`activationStatus`+`username`+
  `recommendedUsernameBase` (чистая функция от текущих `firstName`/`lastName` — подсказка для UI,
  не гарантированно свободна в БД)
- Ошибки: `404 WORKER_NOT_FOUND`

#### `PATCH /api/admin/workers/:employeeId`
- Permission: `worker.update`
- Request: `{ "version", ...частичные поля }`
- Ошибки: `404`, `409 VERSION_CONFLICT`, `400 VALIDATION_ERROR`
- Audit: `WORKER_UPDATED`
- **Не меняет `username`**, даже если `firstName`/`lastName` меняются — смена логина только через
  `POST .../regenerate-username` ниже

#### `POST /api/admin/workers/:employeeId/regenerate-username`
- Permission: `worker.update`
- CSRF: обязателен (`X-Requested-With`, см. §0)
- Явная замена текущего `username` на дружелюбный, вычисленный из **текущих**
  `firstName`/`lastName` (та же коллизионная политика, что при создании). Никогда не вызывается
  автоматически (ни `PATCH`, ни миграцией). Не трогает `passwordHash`, токены активации, роли,
  сессии, `employeeId`/`employeeNumber` — существующая сессия и текущий пароль продолжают
  работать под новым логином; старый логин перестаёт работать сразу после смены.
- Request: без тела
- Response `200`: `{ "employeeId", "previousUsername", "username", "changed" }` — если текущий
  `username` уже равен вычисленному, `changed: false` и `previousUsername === username`, без
  записи `AuditEvent`
- Ошибки: `401 NOT_AUTHENTICATED`, `403 CSRF_REJECTED`/`FORBIDDEN`, `404 WORKER_NOT_FOUND`, `409`
  на неразрешимый конфликт логина (без частичного обновления)
- Audit: `WORKER_USERNAME_CHANGED` (только при реальном изменении) — `before`/`after` содержат
  `employeeId`/`previousUsername`/`username`, без секретов

#### `POST /api/admin/workers/:employeeId/deactivate`
- Permission: `worker.deactivate`
- Request: `{ "reason", "endDate"? }`
- Response `200`: `{ "employeeId", "employmentActive": false, "userStatus": "OFFBOARDING"|"DEACTIVATED" }`
- Ошибки: `404`, `400 VALIDATION_ERROR`, `409 ALREADY_DEACTIVATED`
- Audit: `WORKER_DEACTIVATED`
- Не трогает `PayrollPeriodParticipant.expected` — см. §6, `.../exclude`

#### `POST /api/admin/periods/:periodId/participants/:employeeId/exclude`
- Permission: `period.participant.exclude`
- Request: `{ "reason" }`
- Response `200`: `{ "periodId", "employeeId", "expected": false }`
- Ошибки: `404`, `400 VALIDATION_ERROR`, `409 HAS_PAYROLL_DATA` — возвращается, если у работника в
  этом периоде есть хотя бы одно из: `TimesheetDraftSegment` (реальный введённый интервал —
  автоматически предзаполненная пустая строка `TimesheetDraftDay` без сегментов **не считается**),
  explicit payroll-relevant `TimesheetDraftDay.dayType`, `TimesheetDraftDay.confirmedZero=true`,
  **любая существующая `TimesheetVersion` для этого табеля — безусловно, независимо от содержимого**
  (полностью пустая `EMPTY_FALLBACK`-версия блокирует так же, как содержательная), либо
  `Absence(status IN (PENDING, APPROVED))` в датах периода. `CorrectionDraft` **не проверяется
  отдельным условием** — логически избыточно: он всегда относится к табелю, уже имеющему
  `TimesheetVersion` (`basedOnVersionId`), которая уже блокирует через `SUBMITTED_VERSION` (в v5.2
  здесь было логически противоречивое условие `MATERIAL_CORRECTION_DATA` — снято, см. `03_...`,
  §4.5). Тело ответа при `409` включает `{ "reasons": ["DRAFT_SEGMENTS" | "EXPLICIT_DAY_TYPE" |
  "CONFIRMED_ZERO" | "SUBMITTED_VERSION" | "ABSENCE"] }`, указывая, что именно найдено
- Audit: `PARTICIPANT_EXCLUDED`

#### `POST /api/admin/workers/:employeeId/activation`
- Permission: `worker.activation.generate`
- Ограничение: активный `SiteAssignment` + `PayrollPeriodParticipant` в `OPEN`-периоде, иначе `403
  SETUP_INCOMPLETE`
- Response `201`: `{ "activationCode", "activationExpiresAt" }` (72ч, только здесь)
- Ошибки: `404`, `409 WORKER_ALREADY_ACTIVE`, `403 SETUP_INCOMPLETE`
- Idempotency: обязателен
- Audit: `ACTIVATION_TOKEN_ISSUED`

#### `GET /api/admin/workers/:employeeId/setup-preview`
- Permission: `worker.read.all`
- Response `200`: `{ "assignments": [...], "period": {...}|null, "readyForActivation": boolean }`
- Ошибки: `404 WORKER_NOT_FOUND`

## 6. Назначения

`SiteAssignment` — разрешение работать на объекте, не эксклюзивный слот. Несколько одновременно
активных назначений на разные объекты — легитимны. `ASSIGNMENT_OVERLAP` означает дубликат на тот же
объект+область.

#### `GET /api/admin/assignments`
- Permission: `assignment.read.all`
- Response `200`: список с `employeeName`, `siteName`, `templateName`, `isPrimary`

#### `POST /api/admin/assignments/validate-overlap`
- Permission: `assignment.create`
- Request: `{ "employeeId", "siteId", "workAreaId"?, "validFrom", "validTo"? }`
- Response `200`: `{ "hasOverlap": false }` или `{ "hasOverlap": true, "conflictingAssignmentId" }`

#### `POST /api/admin/assignments`
- Permission: `assignment.create`
- Request: `{ "employeeId", "siteId", "workAreaId"?, "templateId"?, "validFrom", "validTo"?, "isPrimary"? }`
- Response `201`: полный `SiteAssignment`
- Ошибки: `400 VALIDATION_ERROR`, `404 .../SITE_NOT_FOUND/.../TEMPLATE_NOT_FOUND`, `409
  EMPLOYEE_NOT_ACTIVE`, `409 ASSIGNMENT_OVERLAP`
- Idempotency: обязателен
- Audit: `ASSIGNMENT_CREATED`
- Transaction: апсертит `PayrollPeriodParticipant`+`Timesheet(DRAFT)`+`TimesheetDraft` для каждого
  пересекающегося `OPEN`-периода

#### `PATCH /api/admin/assignments/:assignmentId`
- Permission: `assignment.update`
- Request: `{ "version", "isPrimary"?, "endedReason"? }` — не принимает `siteId`/`workAreaId`/
  `templateId` на начавшемся назначении
- Ошибки: `404`, `409 VERSION_CONFLICT`, `400 ASSIGNMENT_ALREADY_STARTED` (используйте
  `assignment.split`)
- Audit: `ASSIGNMENT_UPDATED`

#### `POST /api/admin/assignments/:assignmentId/split`
- Permission: `assignment.split`
- Атомарная замена site/workArea/template у уже начавшегося назначения
- Request: `{ "effectiveFrom": "2026-08-01", "siteId", "workAreaId"?, "templateId"?, "isPrimary"? }`
- Response `200`: `{ "closedAssignmentId", "closedValidTo": "2026-07-31", "newAssignment": {...} }`
- Ошибки: `404`, `400 VALIDATION_ERROR` (`effectiveFrom <= assignment.validFrom`), `409
  ASSIGNMENT_OVERLAP`
- Audit: `ASSIGNMENT_SPLIT`
- Transaction: `UPDATE` старой строки `validTo = effectiveFrom - 1 day` + `INSERT` новой строки —
  одна транзакция

#### `POST /api/admin/assignments/:assignmentId/promote`
- Permission: `assignment.update`
- Response `200`: `{ "assignmentId", "isPrimary": true }`
- Ошибки: `404`, `409 ASSIGNMENT_NOT_ACTIVE`
- Transaction: advisory lock на `employeeId`, демоушен прежнего primary, audit `ASSIGNMENT_PROMOTED`

#### `POST /api/admin/assignments/:assignmentId/end`
- Permission: `assignment.end`
- Request: `{ "validTo", "reason"? }`
- Ошибки: `404`, `400 VALIDATION_ERROR`
- Audit: `ASSIGNMENT_ENDED`

## 7. Расчётные периоды

#### `GET /api/admin/periods`
- Permission: `period.read.all`
- Response `200`: список `{ id, startDate, endDate, status }`

#### `POST /api/admin/periods`
- Permission: `period.create`
- Request: `{ "startDate", "endDate" }`
- Response `201`: `PayrollPeriod(status=OPEN)`, `participantsCount`
- Ошибки: `400 VALIDATION_ERROR`, `409 PERIOD_OVERLAP`
- Idempotency: поддерживается
- Audit: `PERIOD_OPENED`

#### `GET /api/admin/periods/:periodId`
- Permission: `period.read.all`
- Response `200`: `PayrollPeriod`+`{ participantsTotal, timesheetsFinalApproved, timesheetsPending }`
- Ошибки: `404 PERIOD_NOT_FOUND`

#### `GET /api/admin/periods/current`
- Permission: `period.read.all`
- Назначение: календарный дефолт для UI. Несколько периодов могут быть `OPEN` одновременно —
  выбирается тот, чьи даты в `Europe/Helsinki` включают сегодня
- Response `200`: `PayrollPeriod` либо `404 NO_OPEN_PERIOD`

## 8. Административный fallback проверки табелей

Решает случай, когда единственный прораб объекта сам держит роль `WORKER` и не может проверить
собственные часы, и обслуживает `NON_SITE`-scope, недоступный `FOREMAN`.

#### `GET /api/admin/review-scopes`
- Permission: `timesheet.scope_review.all`
- Query: `page`, `pageSize`, `status` (default `PENDING`), `scopeType` (`SITE`|`NON_SITE`),
  `scopePurpose` (`DATA`|`EMPTY_FALLBACK`, применимо только при `scopeType=NON_SITE`), `siteId`,
  `employeeId`, `sort`
- Response `200`:
```json
{ "items": [{ "id": "uuid", "scopeType": "SITE", "scopePurpose": null, "siteId": "uuid",
  "siteName": "Kamppi Renovation", "timesheetId": "uuid", "employeeId": "uuid",
  "employeeName": "Juha Korhonen", "timesheetVersionId": "uuid", "status": "PENDING",
  "hasException": true }], "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
```
Для `scopeType=NON_SITE, scopePurpose=EMPTY_FALLBACK` — UI-подпись «подтверждение пустого табеля»,
не «отсутствие» (это не `Absence`-данные, а признак того, что весь табель не содержит вообще никаких
записей). Для `scopeType=NON_SITE, scopePurpose=DATA` — `siteId`/`siteName` — `null`,
`contextSiteId`/`contextSiteName` из снимка (только для отображения группировки).
- DoD: работник, являющийся тем же `Employee`, что и `actorUserId` вызывающего `ADMIN`, никогда не
  появляется в этом списке для этого `ADMIN`

#### `GET /api/admin/review-scopes/:reviewScopeId`
- Permission: `timesheet.scope_review.all`
- Response `200`: `TimesheetReviewScope` + текущая `TimesheetVersion` (только относящиеся к этому
  scope дни: тот же `siteId` для `SITE`, explicit non-site дни для `NON_SITE(DATA)`, пустое тело для
  `NON_SITE(EMPTY_FALLBACK)`) + `TimesheetReviewProposal[]` этого scope
- Ошибки: `404 REVIEW_SCOPE_NOT_FOUND`

#### `POST /api/admin/review-scopes/:reviewScopeId/approve`
- Permission: `timesheet.scope_review.all`
- Precondition: `scope.status=PENDING`, `scope.timesheetVersionId = Timesheet.currentVersionId`,
  **`Timesheet.status = SUBMITTED`** (строго — не `RETURNED`; если родительский табель уже переведён
  в `RETURNED` возвратом другого scope той же версии, подтверждать этот scope нельзя, даже если он
  формально ещё `PENDING`, см. `03_...`, §4.7), `reviewer.employeeId != Timesheet.employeeId`
- Response `200`: `{ "reviewScopeId", "status": "APPROVED" }`
- Ошибки: `409 STALE_REVIEW_SCOPE` (устаревшая версия **либо** `Timesheet.status != SUBMITTED`),
  `403 SELF_APPROVAL_FORBIDDEN`
- Audit: `FOREMAN_APPROVED` (реально выполнено `ADMIN`, `reviewerUserId` фиксирует это)
- DoD: подтверждение последнего `PENDING`-scope версии переводит `Timesheet.status` в
  `FOREMAN_APPROVED` — единственный путь для табеля единственного `FOREMAN`+`WORKER`

#### `POST /api/admin/review-scopes/:reviewScopeId/return`
- Permission: `timesheet.scope_review.all`
- Request: `{ "returnReason", "proposals"?: [{ "timesheetDayId", "proposedSegments": [...], "reason" }] }`
  — если `proposals` заданы, каждый элемент **обязан** содержать `proposedSegments` (массив, может
  быть пустым `[]`, но не `null` и не отсутствовать); `proposedMinutes` не принимается от клиента —
  вычисляется сервером
- Precondition: `scope.status=PENDING`, `scope.timesheetVersionId = Timesheet.currentVersionId`,
  **`Timesheet.status IN (SUBMITTED, RETURNED)`** (в отличие от `approve` — допускает случай, когда
  другой scope той же версии уже вернули на долю секунды раньше, см. «Гонка одновременных возвратов»,
  `03_...`, §4.7), `reviewer.employeeId != Timesheet.employeeId`
- Response `200`: `{ "reviewScopeId", "status": "RETURNED" }`
- Ошибки: `409 STALE_REVIEW_SCOPE`, `403 SELF_APPROVAL_FORBIDDEN`, `400 VALIDATION_ERROR`
  (`returnReason` пуст, либо `proposedSegments` отсутствует/невалиден в каком-то элементе
  `proposals`)
- Audit: `TIMESHEET_RETURNED`

## 9. Рабочий кабинет

Все эндпоинты используют `req.session.userId → User.employeeId`; `employeeId` никогда не
принимается из запроса. Доступ требует активную роль `WORKER` у пользователя И заполненный
`User.employeeId`. `OFFBOARDING` — ограниченный доступ (см. §5, `.../deactivate`).

Draft/submit/proposal-эндпоинты параметризованы `:timesheetId` — сервер проверяет, что этот
`Timesheet.employeeId` принадлежит вызывающему (`403 FORBIDDEN` иначе, не `404`, чтобы не спутать
«чужой» с «не существует»).

#### `GET /api/worker/context`
- Permission: `worker.read.own`
- Response `200`: `{ "employee": {...}, "locale" }`
- Ошибки: `401 NOT_AUTHENTICATED`, `403 NO_EMPLOYEE_PROFILE`

#### `GET /api/worker/assignments/current`
- Permission: `assignment.read.own`
- Response `200`: `{ "assignments": [...] }` (массив, может быть пустым)

#### `GET /api/worker/periods/current`
- Permission: `period.read.own`
- Назначение: календарный дефолт (сегодня внутри дат периода)
- Response `200`: `{ "period": {...} }` либо `{ "period": null }`

#### `GET /api/worker/periods/actionable`
- Permission: `period.read.own`
- Response `200`:
```json
{ "periods": [{ "id": "uuid", "startDate": "2026-07-01", "endDate": "2026-07-14", "status": "OPEN",
  "timesheetId": "uuid", "timesheetStatus": "RETURNED" }] }
```
Actionable = `PayrollPeriodParticipant.expected=true` + `PayrollPeriod.status=OPEN` +
`Timesheet.status != FINAL_APPROVED`. Каждый элемент несёт собственный `timesheetId`.
`SUBMITTED`/`FOREMAN_APPROVED` включены в список, но read-only (см. ниже).

#### `GET /api/worker/timesheets/:timesheetId`
- Permission: `timesheet.read.own`
- Response `200`: `{ "timesheetId", "periodId", "status", "currentVersionId", "returnReasons": [...] }`
  — `returnReasons` (реализовано после E2E-дефекта, зафиксированного `IMPLEMENTATION_STATUS.md`):
  массив, **не** одна причина — версия может иметь больше одного `RETURNED` scope одновременно
  (`03_...`, §4.7, «Гонка одновременных возвратов»). Только scope `currentVersionId`; после
  resubmit (новая версия, свежие в основном `PENDING` scope) массив естественно становится пустым
  — старые причины никогда не показываются как актуальные, но исходные строки
  `TimesheetReviewScope` не удаляются. Каждый элемент:
```json
{
  "scopeType": "SITE",
  "scopePurpose": null,
  "siteId": "uuid",
  "siteName": "Kamppi Renovation",
  "contextSiteId": null,
  "contextSiteName": null,
  "reason": "Please fix Tuesday's break time.",
  "returnedAt": "2026-08-06T13:10:00.000Z"
}
```
  Для `scopeType=NON_SITE`: `siteId`/`siteName` — `null`; `contextSiteId`/`contextSiteName` — снимок
  основного объекта работника (только для группировки, `03_...` §4.7) либо оба `null`, если снимка
  нет. Никогда не включает `reviewedByUserId` или другие внутренние поля.
- Ошибки: `403 FORBIDDEN`, `404 TIMESHEET_NOT_FOUND`

#### `GET /api/worker/timesheets/:timesheetId/draft`
- Permission: `timesheet.read.own`
- Доступен **только** при `Timesheet.status IN (DRAFT, RETURNED)` — при `SUBMITTED`/
  `FOREMAN_APPROVED` draft физически пуст (очищен на `submit`), запрос возвращает `409
  DRAFT_NOT_EDITABLE` с подсказкой использовать `.../current-version`
- Response `200`: `{ "days": [{ "date", "dayType", "confirmedZero", "segments": [...] }],
  "plannedShifts": [...] }`
- Ошибки: `403 FORBIDDEN`, `404 TIMESHEET_NOT_FOUND`, `409 DRAFT_NOT_EDITABLE`

#### `GET /api/worker/timesheets/:timesheetId/current-version`
- Permission: `timesheet.read.own`
- Назначение: read-only просмотр последней immutable `TimesheetVersion` — доступен в **любом**
  статусе табеля (в отличие от `.../draft`), это то, что видит работник, пока табель на проверке
  (`SUBMITTED`/`FOREMAN_APPROVED`) или уже закрыт (`FINAL_APPROVED`)
- Response `200`: `{ "versionId", "versionNumber", "days": [{ "date", "dayType", "segments": [...] }],
  "plannedShifts": [...], "reviewScopes": [{ "id", "scopeType", "scopePurpose", "siteId",
  "siteName", "contextSiteId", "contextSiteName", "status", "returnReason", "reviewedAt" }] }`
  — `reviewScopes` реально заполнен настоящими строками `TimesheetReviewScope` **этой** версии
  (раньше — фиктивный `[]`, вместе с устаревшим комментарием, что модель ещё не существует; оба
  исправлены при устранении E2E-дефекта «работник не видит причину возврата»,
  `IMPLEMENTATION_STATUS.md`). Аддитивно относительно прежней формы (`scopeType`/`siteId`/`status`
  сохранены как есть) — добавлены `id`/`scopePurpose`/`siteName`/`contextSiteId`/`contextSiteName`/
  `returnReason`/`reviewedAt`, чтобы worker-consumer никогда не показывал raw UUID вместо названия
  объекта. Не отфильтровано по статусу — содержит все scope версии, включая `PENDING`/`APPROVED`;
  фильтрацию на «только `RETURNED` с причиной» делает `returnReasons` выше на
  `GET .../timesheets/:timesheetId`, не этот эндпоинт. Никогда не включает `reviewedByUserId`.
- Ошибки: `403 FORBIDDEN`, `404 TIMESHEET_NOT_FOUND` (в т.ч. если версии ещё не существует — табель
  ни разу не отправлялся)

#### `PATCH /api/worker/timesheets/:timesheetId/days/:date`
- Permission: `timesheet.draft.edit.own` (**не** `timesheet.read.own` — отдельный write-permission, в
  v5.2 мутация ошибочно требовала read-permission; каждый вызов этого эндпоинта — пользовательская
  мутация, увеличивающая `TimesheetDraft.contentRevision` на `1`, `03_...` §4.6)
- Request: `{ "dayType"?, "confirmedZero"?, "note"?, "segments"?: [{ "startAt", "endAt", "siteId",
  "workAreaId"?, "breaks"?: [{ "startAt", "endAt", "paid" }] }] }`. **Каждое поле верхнего уровня
  независимо и опционально** — отсутствующее поле не меняется этим запросом. **`segments`, если
  передано, — полный итоговый список сегментов дня по всем объектам, не только по одному `siteId`**
  (`03_...`, §4.6, «Точная семантика `PATCH .../days/:date`»): сегмент существующего объекта,
  отсутствующий в переданном массиве, будет удалён этим запросом. Чтобы изменить сегменты только
  объекта A, не тронув объект B, клиент обязан включить в `segments` неизменённые сегменты B
  дословно. `segments`, отсутствующее в теле вовсе, оставляет все существующие сегменты дня как есть;
  `segments: []` явно удаляет их все. Частичный per-`siteId` `PATCH` этот эндпоинт не поддерживает —
  семантика не смешивается. **`endAt` обязателен в каждом сегменте и в каждом перерыве**, отсутствие
  → `400 VALIDATION_ERROR`. `sourceAssignmentId` **не принимается от клиента** — сервер резолвит его
  сам из `employeeId`+`siteId`+`workAreaId`+датой дня против активного `SiteAssignment` (см.
  «`sourceAssignmentId` резолвится сервером» в §0), `404 SITE_NOT_ASSIGNED`, если такого назначения
  нет. **`dayType` персонального отсутствия (`SICK_LEAVE`/`VACATION`/`UNPAID_LEAVE`/`OTHER`) не
  принимается напрямую от `WORKER`** без соответствующей `APPROVED Absence` с `sourceAbsenceId`,
  покрывающей эту дату, — единственный путь к такому `dayType` — overlay из одобрённого `Absence`
  (`03_...`, §4.2, «Единый контракт»); попытка → `403 DAY_TYPE_REQUIRES_ABSENCE`. `PUBLIC_HOLIDAY` —
  исключение, устанавливается системно, не через этот эндпоинт от `WORKER`.
- Ошибки: `403 FORBIDDEN`, `403 DAY_TYPE_REQUIRES_ABSENCE`, `409 DRAFT_NOT_EDITABLE` (табель не в
  `DRAFT`/`RETURNED`), `409 WORK_SEGMENT_OVERLAP` (пересечение внутри этого draft), `404
  SITE_NOT_ASSIGNED`, `409 DAY_TYPE_CONFLICT` (попытка сохранить сегмент на дне с `dayType != WORK`,
  либо сменить `dayType` на не-`WORK` при существующих сегментах), `409 DAY_STATE_CONFLICT` (итоговое
  состояние строки после применения PATCH нарушает таблицу допустимых состояний
  `dayType`×`confirmedZero`×сегменты, `03_...` §4.6 «Правило состояния дня» — например
  `confirmedZero=true` при непустых `segments` в этом же запросе, либо `confirmedZero=true` при
  существующих сегментах, которые запрос не тронул)
- **`T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §10.1–10.3 (locking slice B) — clock provenance, обратно
  совместимо**: каждый объект в `segments[]` дополнительно принимает опциональный
  `"originClockShiftFragmentId"?` (UUID `ClockShiftFragment`); верхнеуровневое тело — опциональную
  карту `"clockAdjustmentReasons"?: { "<clockShiftFragmentId>": "причина" }`. `originClockShiftFragmentId`
  принимается **только** эхом уже живого на этом дне фрагмента (`previousLive`, читается до любой
  мутации) — origin, никогда не бывший живым на этом draft/дне, либо принадлежащий чужому
  employee/timesheet/дню → `403 FORBIDDEN` (тот же код и тело для «существует у другого» и «никогда
  не существовал» — без UUID-oracle). Повтор одного `originClockShiftFragmentId` дважды в одном
  `segments[]` → `400 VALIDATION_ERROR`. Реальное изменение start/end/site/workArea clock-origin
  сегмента (сравнение с последним известным значением) либо его удаление (origin, бывший в
  `previousLive`, отсутствует среди входящих `segments[]`) требует непустой
  `clockAdjustmentReasons[fragmentId]`, иначе `400 VALIDATION_ERROR` и полный откат — ни один
  частичный `ClockShiftAdjustment` не пишется. При успехе — `ClockShiftAdjustment(EDITED|
  RESTORED_TO_RECORDED|REMOVED)` в той же транзакции, `changedByUserId` = вызывающий `WORKER`,
  никогда `SYSTEM`. Manual-сегменты без `originClockShiftFragmentId` не затронуты этим расширением.
- **Побочный эффект**: сервер вычисляет `affectedSitePairs` — множество `siteId`, чей набор
  сегментов реально отличается между состоянием дня до запроса и полным итоговым состоянием после
  запроса (`siteId ∈ (старые ∪ новые)`, где значение по этому `siteId` изменилось — включая «объект
  был, в переданном `segments` отсутствует», что при полной замене равносильно удалению; `PATCH` без
  поля `segments` вовсе, меняющий только `note`/`dayType`/`confirmedZero`, даёт `affectedSitePairs =
  ∅`, поскольку набор сегментов в этом случае не менялся). Пересчитывает `status` только предложений,
  чей `reviewScope.siteId ∈ affectedSitePairs` **и** `status != RESOLVED` **и** чей
  `createdAtDraftRevision < TimesheetDraft.contentRevision` после этого запроса — **включая ещё ни
  разу не тронутые `OPEN`** (в v5.2 пересчитывались только уже покинувшие `OPEN`; в v5.3 добавлен
  `createdAtDraftRevision`; в v5.4 добавлено ограничение по `affectedSitePairs`; в v5.4.1 уточнена
  точная семантика `segments` как полной замены — иначе `affectedSitePairs` было недоопределено для
  случая «объект пропущен в теле запроса», см. `03_...` §4.6). Сравнивает новое содержимое дня для
  `siteId` scope с
  `proposedSegments` каждого такого предложения: совпадает → `ACCEPTED` (первый переход из `OPEN`,
  либо возврат из `REPLACED`), не совпадает → `REPLACED` (первый переход из `OPEN`, либо смена из
  `ACCEPTED`); `lastEvaluatedAt = now()`. Отклик включает `{ "resolvedProposals": [{ "proposalId",
  "status" }] }` со **всеми** предложениями, чей `status` изменился в результате этого запроса.
  **Системная реинициализация draft (при `RETURNED`) не вызывает этот эндпоинт и не запускает этот
  побочный эффект** — см. `03_...`, §4.6, шаг 5.

#### `POST /api/worker/timesheets/:timesheetId/submit`
- Permission: `timesheet.submit`
- Response `200`: `{ "timesheetId", "status": "SUBMITTED", "versionId", "versionNumber" }`
- Ошибки: `403 FORBIDDEN`, `409 INVALID_STATE_TRANSITION` (не в `DRAFT`/`RETURNED`), `409
  UNRESOLVED_PROPOSALS` (тело: `{ "openProposalDayIds": [...] }` — только предложения, всё ещё
  `OPEN`, то есть ни разу не тронутые ни ручной правкой соответствующего дня, ни `accept`, с момента
  возврата)
- Transaction: финальная сверка всех предложений текущей версии со `status != OPEN` против итогового
  draft, перевод каждого в терминальное `status = RESOLVED` (`resolutionOutcome` = последнее
  вычисленное `ACCEPTED`/`REPLACED`, `resolvedAt = now()`, `resolvedInVersionId = newVersionId`),
  заморозка draft в `TimesheetVersion`+`TimesheetPlannedShift` (включая `sourceAssignmentId` каждого
  сегмента), вычисление `TimesheetReviewScope` (`SITE`/`NON_SITE` по трём случаям, группировка
  `contentHash` по assignment-группам, см. `03_...`, §4.6), очистка draft-таблиц — одна транзакция
- Audit: `TIMESHEET_SUBMITTED`

#### `POST /api/worker/review-proposals/:proposalId/accept`
- Permission: `timesheet.accept_proposal`
- Precondition (все обязательны, `03_...` §4.6 шаг 6):
  - `proposal.status IN (OPEN, ACCEPTED, REPLACED)`;
  - `proposal.resolvedInVersionId IS NULL`;
  - `proposal.reviewScope.timesheetVersionId = Timesheet.currentVersionId`;
  - `Timesheet.status = RETURNED`;
  - `TimesheetDraft.basedOnVersionId = proposal.reviewScope.timesheetVersionId`;
  - `proposal` принадлежит `Timesheet` вызывающего работника.
- Response `200`: `{ "proposalId", "status": "ACCEPTED" }` — применяет `proposedSegments`
  (структурированы всегда) **одной транзакцией** только к сегментам `siteId` родительского scope в
  `TimesheetDraft`, не ко всему дню; повторно проверяет те же правила, что обычный `PATCH .../
  days/:date`, прежде чем зафиксировать замену: overlap с сегментами других `siteId` того же
  draft/дня (`409 WORK_SEGMENT_OVERLAP`), `409 DAY_TYPE_CONFLICT`, `409 DAY_STATE_CONFLICT`, `404
  SITE_NOT_ASSIGNED`, `409 WORK_AREA_SITE_MISMATCH` (`workAreaId` из `proposedSegments` не совпадает
  с активным `SiteAssignment.workAreaId` на эту дату), обязательный `endAt` в каждом
  сегменте/перерыве, break-инварианты (§5 `03_...`); запускает тот же пересчёт `resolvedProposals`,
  что `PATCH .../days/:date` (§9 выше); увеличивает `TimesheetDraft.contentRevision`, как и обычная
  правка; не вызывает `timesheet.submit`
- **При любой ошибке повторной валидации — старые сегменты дня остаются без изменений, `status`
  предложения не меняется** (транзакция откатывается целиком, не частичное применение)
- Ошибки: `403 FORBIDDEN`, `409 STALE_PROPOSAL` (устаревшая версия, не тот `basedOnVersionId`, либо
  `Timesheet.status != RETURNED`), `409 PROPOSAL_ALREADY_RESOLVED` (`status = RESOLVED`, либо
  `resolvedInVersionId IS NOT NULL`), `409 WORK_SEGMENT_OVERLAP`, `409 DAY_TYPE_CONFLICT`, `409
  DAY_STATE_CONFLICT`, `404 SITE_NOT_ASSIGNED`, `409 WORK_AREA_SITE_MISMATCH`, `400
  VALIDATION_ERROR` (отсутствующий `endAt`/нарушенный break-инвариант)
- Audit: `PROPOSAL_ACCEPTED`

#### `POST /api/worker/review-proposals/:proposalId/reject`
- Permission: `timesheet.reject_proposal`
- Precondition: тот же набор, что `.../accept` выше (`03_...` §4.6 шаг 6)
- Response `200`: `{ "proposalId", "status": "REPLACED" }` — **не** мутирует `TimesheetDraftSegment`/
  `TimesheetDraftDay` вовсе (`TimesheetDraft.contentRevision` не увеличивается — это не изменение
  содержимого draft), только переводит `status → REPLACED` и `lastEvaluatedAt = now()` для этого
  одного `proposalId`. Явный путь «оставить мои данные без изменений» — отдельный от того, чтобы
  полагаться на произвольный no-op `PATCH .../days/:date` для той же цели
- Ошибки: `403 FORBIDDEN`, `409 STALE_PROPOSAL`, `409 PROPOSAL_ALREADY_RESOLVED`
- Audit: `PROPOSAL_REJECTED`

### 9.1 Онлайн-клок посещаемости (T7A online clock core, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md`
§9.1-9.3/§12.1-12.2 — **реализовано**) — `lib/attendance-clock.ts`

Все четыре эндпоинта — только `channel=ONLINE`: `deviceInstallationId`/`deviceSequence=NULL`,
`capturedOffline=false`. `employeeId` всегда из сессии, никогда из тела запроса. **Materialization
реализована следующим backend-слайсом:** успешный `check-out`/`switch-site` при resolved assignment
и без OPEN overlap вызывает `materializeClockShiftCore` инлайн в той же транзакции; иначе shift
остаётся `PENDING` для внутреннего catch-up. **`[2026-08-15]`** Worker mobile UI (`/worker`,
`app/worker/page.tsx` + `WorkerClockPanel.tsx`) реализован поверх этих же четырёх эндпоинтов без их
изменения. **`[2026-08-16]`** `GET /attendance/context` и `POST /attendance/sync` теперь тоже
реализованы (§9.1a ниже). **`[2026-08-14]` T7A.7B:** IndexedDB/outbox клиент и
`WorkerClockPanel`-интеграция с offline-путём тоже реализованы — `lib/offline-outbox/`,
Check In/Out/Switch Site пишут в outbox и синкаются через `POST /attendance/sync` выше, прямых
вызовов online-эндпоинтов из UI больше нет (сами online-роуты не изменены). По-прежнему отложены:
`GET /attendance/today|week`, scheduler, exception-review-эндпоинты, admin attendance overview.

**GPS shape** (переиспользуется всеми телами ниже):
```json
"location": { "latitude": number, "longitude": number, "accuracyMeters": number } | null,
"gpsUnavailableReason": "PERMISSION_DENIED" | "TIMEOUT" | "POSITION_UNAVAILABLE" | null
```
`location` есть ⟺ `gpsUnavailableReason` пуст; `location` пуст ⟺ `gpsUnavailableReason` — одна из
трёх причин (`LOW_ACCURACY` клиент никогда не присылает — сервер выставляет её сам при
`accuracyMeters > 75`). `latitude ∈ [-90,90]`, `longitude ∈ [-180,180]`, максимум 6 знаков после
точки; `accuracyMeters` конечен, `>= 0`, максимум 1 знак после точки (`numeric(6,1)`) — округление
никогда не происходит молча, избыточная точность отклоняется `400 VALIDATION_ERROR`.

#### `GET /api/worker/attendance/clock-state`
- Permission: `attendance.clock.read.own`
- Response `200`:
```json
{
  "serverNow": "ISO", "state": "CLOCKED_OUT" | "CLOCKED_IN",
  "openShift": { "openedAt": "ISO", "siteId": "uuid", "siteName": "...", "workAreaId": "uuid|null",
    "workAreaName": "string|null", "sourceAssignmentId": "uuid|null", "openedByClockEventId": "uuid" } | null
}
```
- Никогда не содержит raw GPS. Ошибки: `401 NOT_AUTHENTICATED`, `403 FORBIDDEN` (нет permission),
  `403 NO_EMPLOYEE_PROFILE`.

#### `POST /api/worker/attendance/check-in`
- Permission: `attendance.clock.checkin.own`; CSRF `X-Requested-With: titanor-time` обязателен;
  `Idempotency-Key` **опциональный** (существующий HTTP-слой, `lib/idempotency.ts`) — обязательная
  натуральная идемпотентность обеспечена самим `clientEventId` (`ClockEvent.id`) независимо от
  заголовка; rate limit `20/60s` per `actorUserId`+route (`lib/rate-limit.ts`)
- Request:
```json
{ "clientEventId": "uuid", "siteId": "uuid", "workAreaId": "uuid|null",
  "clientCapturedAt": "ISO", "location": {...}|null, "gpsUnavailableReason": "..."|null }
```
- Алгоритм — §9.1 design-документа: `VERIFIED_OUTSIDE` → **вся** транзакция откатывается, `403
  OUTSIDE_GEOFENCE`, ни один ряд не создаётся. Уже есть открытая смена → новый
  `ClockEvent(NEEDS_REVIEW)`, `AttendanceException(DOUBLE_CHECK_IN)` (+ применимые GPS/skew
  exceptions), старая `EmployeeOpenShift` не трогается, `201`. Нет открытой смены → `ClockEvent
  (ACCEPTED)`, новая `EmployeeOpenShift`, `sourceAssignmentId` резолвится по Helsinki-дате
  `effectiveAt` (`NULL` → `AttendanceException(STALE_ASSIGNMENT)`), `GPS_NOT_VERIFIED`/
  `EXCESSIVE_CLOCK_SKEW` — если применимо, `201`.
- Response `201`/`200` (exact replay):
```json
{ "clockEventId": "uuid", "operationType": "CHECK_IN", "processingState": "ACCEPTED"|"NEEDS_REVIEW",
  "gpsVerification": "VERIFIED_INSIDE"|"VERIFIED_OUTSIDE"|"NOT_VERIFIED", "effectiveAt": "ISO",
  "siteId": "uuid", "assumedSiteId": null, "workAreaId": "uuid|null", "sourceAssignmentId": "uuid|null",
  "groupId": "uuid|null", "clockShiftId": null, "materializationState": null,
  "exceptions": ["TYPE", ...] }
```
`exceptions` — типы `AttendanceException`, созданные для ЭТОГО события (стабильный список,
переживает изменение `status` позже). `materializationState` читается live из закрытой смены, если
она есть: natural `clientEventId` replay после успешного catch-up честно показывает актуальный
`MATERIALIZED`, не старый response snapshot. Повтор с тем же опциональным HTTP
`Idempotency-Key` по общему контракту этого слоя возвращает исходный cached HTTP response.
- Ошибки: `400 VALIDATION_ERROR` (включая невалидный `workAreaId` для этого `siteId`), `401
  NOT_AUTHENTICATED`, `403 FORBIDDEN`/`CSRF_REJECTED`/`NO_EMPLOYEE_PROFILE`, `403
  OUTSIDE_GEOFENCE`, `404 SITE_NOT_FOUND` (malformed и несуществующий `siteId` — идентично, no
  oracle), `409 CLIENT_EVENT_ID_REUSED` (тот же `clientEventId`, другой canonical payload —
  `ClockEventIdConflict` без координат/accuracy/raw payload), `429 RATE_LIMITED`
- Audit: `CLOCK_CHECK_IN` / `CLOCK_CHECK_IN_REJECTED_DOUBLE` — без координат

#### `POST /api/worker/attendance/check-out`
- Permission: `attendance.clock.checkout.own`; те же CSRF/Idempotency-Key/rate-limit правила
- Request:
```json
{ "clientEventId": "uuid", "assumedSiteId": "uuid", "clientCapturedAt": "ISO",
  "location": {...}|null, "gpsUnavailableReason": "..."|null }
```
- Алгоритм — §9.2: **никогда** не блокируется GPS/сайтом. Нет открытой смены → orphan
  `ClockEvent(NEEDS_REVIEW)` на `assumedSiteId`, `AttendanceException(CHECKOUT_WITHOUT_OPEN_SHIFT)`
  (+ применимые GPS/skew), `ClockShift` не создаётся. Есть открытая смена → авторитетные
  site/workArea/sourceAssignmentId только из `EmployeeOpenShift` (тело запроса — только
  `assumedSiteId` для detection); `effectiveAt <= openedAt` → `ClockShift.recordedEndAt = openedAt +
  1ms` (design specifies `+1 microsecond`; здесь `+1ms` — минимальная точность JS `Date`/Prisma
  `DateTime`, свойство «не пересекает границу периода» сохраняется), `endAtProvisional=true`,
  `CHECKOUT_CHRONOLOGY_ANOMALY` сначала создаётся с `clockShiftFragmentId=NULL`, затем materializer
  связывает его с последним созданным fragment; `ClockShift(materializationState=PENDING)`
  создаётся, `EmployeeOpenShift` удаляется и, при resolved assignment/отсутствии OPEN overlap,
  полная fragment/draft projection выполняется инлайн той же транзакцией;
  применимые `SITE_MISMATCH_CHECKOUT`/`OUTSIDE_GEOFENCE_CHECKOUT`/`GPS_NOT_VERIFIED`/
  `EXCESSIVE_CLOCK_SKEW`/`EXCESSIVE_SHIFT_DURATION` (порог из `CompanyAttendancePolicy.
  maxShiftDurationHours`); overlap-детекция — общие `overlapCandidates`/`overlapExists`/
  `resolveOverlapTransition` (`lib/attendance-reported-projection.ts`, тот же код, что worker
  `PATCH`/`correction.approve`), без temporal pre-filter.
- Response `201`/`200` (exact replay): та же форма, что check-in, плюс `clockShiftId` (заполнен для
  обычного закрытия, `null` для orphan) и `materializationState: "PENDING"|"MATERIALIZED"|null`.
  Поле отражает актуальное durable-состояние на момент ответа/natural `clientEventId` replay;
  `Idempotency-Key` replay остаётся cached-response семантикой общего HTTP-слоя.
- Ошибки: `400 VALIDATION_ERROR`, `401 NOT_AUTHENTICATED`, `403 FORBIDDEN`/`CSRF_REJECTED`/
  `NO_EMPLOYEE_PROFILE`, `404 SITE_NOT_FOUND` (malformed/несуществующий `assumedSiteId`, no oracle),
  `409 CLIENT_EVENT_ID_REUSED`, `429 RATE_LIMITED`
- Audit: `CLOCK_CHECK_OUT` / `CLOCK_CHECK_OUT_ORPHAN` — без координат

#### `POST /api/worker/attendance/switch-site`
- Permission: `attendance.clock.switch_site.own`; те же CSRF/Idempotency-Key/rate-limit правила
- Request:
```json
{ "groupId": "uuid", "checkOutClientEventId": "uuid", "checkInClientEventId": "uuid",
  "oldAssumedSiteId": "uuid", "newSiteId": "uuid", "newWorkAreaId": "uuid|null",
  "checkOutClientCapturedAt": "ISO", "checkInClientCapturedAt": "ISO",
  "checkOutLocation": {...}|null, "checkOutGpsUnavailableReason": "..."|null,
  "checkInLocation": {...}|null, "checkInGpsUnavailableReason": "..."|null }
```
- Алгоритм — §9.3: один HTTP-запрос, одна DB-транзакция. Нет открытой смены → `409
  NO_OPEN_SHIFT_TO_SWITCH`, ни один `ClockEvent` не создаётся. Иначе — Check Out старого сайта
  (§9.2), затем Check In нового (§9.1), общий `groupId` на обоих `ClockEvent`. `VERIFIED_OUTSIDE`
  нового сайта, либо ЛЮБОЙ сбой check-in половины (`SITE_NOT_FOUND`/`WORK_AREA_INVALID`/
  `CLIENT_EVENT_ID_REUSED`) — откатывает **ВСЮ** транзакцию целиком, включая уже применённый
  check-out: старая `EmployeeOpenShift` остаётся как была, ни одного нового `ClockEvent`/
  `ClockShift` не остаётся (для `CLIENT_EVENT_ID_REUSED` конфликт всё равно фиксируется отдельной,
  изолированной транзакцией **после** отката — судебное доказательство сохраняется, даже когда
  сама попытка switch отклонена). Успех — ровно одна закрытая `ClockShift` старого сайта, ровно
  одна новая `EmployeeOpenShift` нового сайта, два `ClockEvent` с одинаковым `groupId`, никогда
  промежуточного «нигде не отмечен» состояния.
- Response `201`/`200` (exact replay — **вся пара** сверяется как одна группа, частично
  совпавшая/изменённая пара не применяется):
```json
{ "groupId": "uuid", "checkOut": { ...та же форма, что check-out response... },
  "checkIn": { ...та же форма, что check-in response... } }
```
- Ошибки: `400 VALIDATION_ERROR`, `401 NOT_AUTHENTICATED`, `403 FORBIDDEN`/`CSRF_REJECTED`/
  `NO_EMPLOYEE_PROFILE`, `403 OUTSIDE_GEOFENCE`, `404 SITE_NOT_FOUND`, `409
  NO_OPEN_SHIFT_TO_SWITCH`, `409 CLIENT_EVENT_ID_REUSED`, `429 RATE_LIMITED`
- Audit: общий с check-in/check-out, для обеих половин

### 9.1a Offline attendance sync (T7A.7A, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §7/§9.11 —
**реализовано**) — `lib/attendance-sync.ts`

#### `GET /api/worker/attendance/context`
- Permission: `attendance.clock.read.own` (переиспользован, новый grant не потребовался)
- Query: `deviceInstallationId` (обязательный UUID, client-generated), `platform` (опционально,
  максимум 32 символа). `userAgent` берётся ТОЛЬКО из HTTP-заголовка `User-Agent`, никогда из
  query/body.
- Bootstrap-семантика: новый `deviceInstallationId` → создаётся `WorkerDeviceInstallation` этого
  employee; тот же id, тот же employee → обновляются только `lastSeenAt`/`platform`/`userAgent`
  (никогда `lastProcessedSequence`); тот же id, **другой** employee → `403 DEVICE_NOT_OWNED` (тот
  же код, что и "не существует" — без oracle владельца); `revokedAt IS NOT NULL` → `403
  DEVICE_REVOKED`. Конкурентный первый bootstrap одного id создаёт ровно одну строку
  (`createMany`+`skipDuplicates`, тот же примитив, что использует `POST /sync` для `ClockEvent`).
- Response `200`:
```json
{
  "serverNow": "ISO", "deviceInstallationId": "uuid",
  "lastProcessedSequence": "0",
  "assignments": [
    { "id": "uuid", "siteId": "uuid", "siteName": "...", "workAreaId": "uuid|null",
      "workAreaName": "string|null", "isPrimary": boolean,
      "geofence": { "geofenceVersionId": "uuid", "latitude": "60.170000", "longitude": "24.940000",
        "radiusMeters": 100 } | null }
  ]
}
```
`lastProcessedSequence` — decimal-строка (`BigInt`), никогда голое JS-число. `geofence` — ТОЛЬКО
текущая версия сайта (`WorkSite.currentGeofenceVersionId`), исторические версии никогда не
отдаются. Ответ никогда не содержит raw GPS сотрудника (этот endpoint вообще не читает
`ClockEventLocation`).
- Ошибки: `401 NOT_AUTHENTICATED`, `403 FORBIDDEN`/`NO_EMPLOYEE_PROFILE`/`DEVICE_NOT_OWNED`/
  `DEVICE_REVOKED`, `400 VALIDATION_ERROR` (malformed `deviceInstallationId`/`platform`)

#### `POST /api/worker/attendance/sync`
- Permission: `attendance.clock.sync.own` (новая, только `WORKER`); CSRF `X-Requested-With:
  titanor-time` обязателен; `Idempotency-Key` опционален (кеширует весь HTTP-ответ на точный
  повтор, существующий механизм `lib/idempotency.ts`); rate limit `20/60s` per `actorUserId`+route
- Bounded batch size: **100 событий** — явное, задокументированное ограничение (task §C); пустой
  `events[]` отклоняется.
- `deviceSequence` wire-контракт: обычное JSON-число, обязано быть положительным safe integer
  (`1..Number.MAX_SAFE_INTEGER`) — design-документ сам приводит пример `"deviceSequence": 42` как
  голое число; `BigInt` используется внутри с момента валидации, арифметика никогда не через
  `Number`.
- Request:
```json
{
  "deviceInstallationId": "uuid",
  "events": [
    { "clientEventId": "uuid", "deviceSequence": 42, "groupId": "uuid|null",
      "operationType": "CHECK_IN|CHECK_OUT", "siteId": "uuid", "assumedSiteId": "uuid|null",
      "workAreaId": "uuid|null", "clientCapturedAt": "ISO", "capturedOffline": true,
      "cachedGeofenceVersionId": "uuid|null", "gps": {...}|null, "gpsUnavailableReason": "..."|null }
  ]
}
```
`assumedSiteId`: `CHECK_IN` → обязан быть `null`; `CHECK_OUT` → обязательный UUID (используется
только для detection, авторитетный сайт всегда из `EmployeeOpenShift`, §14). `siteId` присутствует
и валидируется как UUID для обоих типов (симметрия wire-формата с `CHECK_IN`), но для `CHECK_OUT`
функционально не используется — тот же принцип, что online `CheckOutInput` вообще не имеет этого
поля.
- Обработка — **буквально** §9.11 (не «одна транзакция на событие», не последовательный вызов
  online-эндпоинтов): одна outer-транзакция на весь батч; `clientEventId`/`deviceSequence`/
  `groupId`/`operationType` — структурные поля (невалидность любого из них отклоняет ВЕСЬ батч,
  `400`); остальные поля — «business»-уровень (невалидность даёт `REJECTED`/`VALIDATION_ERROR` для
  ОДНОГО события, батч остаётся `200`). Structurally valid batch → **всегда `200`**, исход каждого
  события в `results[]`.
- Response `200`:
```json
{
  "results": [
    { "clientEventId": "uuid", "outcome": "ACCEPTED", "processingState": "ACCEPTED"|"NEEDS_REVIEW", "exceptionType": "string"|undefined },
    { "clientEventId": "uuid", "outcome": "DUPLICATE_ACK", "processingState": "..." },
    { "clientEventId": "uuid", "outcome": "REJECTED", "code": "VALIDATION_ERROR"|"OUTSIDE_GEOFENCE"|"CLIENT_EVENT_ID_REUSED"|"DEVICE_SEQUENCE_REUSED"|"SWITCH_SITE_GROUP_FAILED"|"SWITCH_SITE_GROUP_INVALID", "groupId": "uuid"|undefined },
    { "clientEventId": "uuid", "outcome": "RETRYABLE", "code": "SEQUENCE_GAP"|"SWITCH_SITE_GROUP_INCOMPLETE"|"FIFO_LEDGER_INCONSISTENT", "groupId": "uuid"|undefined }
  ]
}
```
- Ошибки: `400 VALIDATION_ERROR` (malformed JSON, malformed batch shape, пустой/oversized `events`,
  невалидные структурные поля события), `401 NOT_AUTHENTICATED`, `403 FORBIDDEN`/`CSRF_REJECTED`/
  `NO_EMPLOYEE_PROFILE`/`DEVICE_NOT_OWNED`/`DEVICE_REVOKED`, `409 IDEMPOTENCY_KEY_REUSED`/
  `IDEMPOTENCY_KEY_IN_PROGRESS` (только если `Idempotency-Key` использован), `429 RATE_LIMITED`,
  `503 INGESTION_RETRY_EXHAUSTED` (bounded retry на `40P01`/`40001` исчерпан, **не** для
  произвольной внутренней ошибки — неожиданная ошибка остаётся необработанным `500`, весь batch
  attempt откатывается целиком)
- Audit: `CLOCK_CHECK_IN`/`CLOCK_CHECK_IN_REJECTED_DOUBLE`/`CLOCK_CHECK_OUT`/
  `CLOCK_CHECK_OUT_ORPHAN` (общие с online, `channel=OFFLINE_SYNC` в `ClockEvent`), плюс новые
  `SWITCH_SITE_GROUP_FAILED`/`SWITCH_SITE_GROUP_INVALID`/`FIFO_LEDGER_INCONSISTENT`
  (`actorUserId=NULL`, санитизировано, без координат/raw payload) — все точно по §9.11.
- **Безопасность**: `employeeId` только из сессии; `deviceInstallationId` — один на весь запрос
  (не per-event), владение/revocation проверяются один раз под `WorkerDeviceInstallation FOR
  UPDATE`, до Прохода A; `cachedGeofenceVersionId` никогда не становится authoritative (только
  сравнение для `GEOFENCE_VERSION_MISMATCH`, живая GPS-оценка — всегда против текущей
  `WorkSite.currentGeofenceVersionId`); координаты — только в `ClockEventLocation`, никогда в
  `AuditEvent`/`ClockEventIdConflict.sanitizedConflictingPayload`/HTTP-ошибках/логах.

### 9.1b Attendance exception review — read foundation (T7A.8A, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md`
§11/§12.1/§12.3 — **реализовано, только чтение**) — `lib/attendance-exceptions.ts`

Только чтение — мутация вынесена в отдельный §9.1c ниже (T7A.8B.1).

#### `GET /api/admin/attendance/exceptions`
- Permission: `attendance.exception.read.all`
- Query: `status`(`OPEN`\|`RESOLVED`\|`DISMISSED`, default `OPEN`), `type`(один из 14
  `AttendanceExceptionType`), `siteId`, `employeeId`, `payrollPeriodId`, `from`/`to`
  (ISO-8601 дата/timestamp, `occurredAt`-диапазон), `page`(default 1), `pageSize`(default 20,
  максимум 100) — **явно переданное невалидное значение любого поля → `400 VALIDATION_ERROR` с
  `fieldErrors`, никогда не заменяется дефолтом молча**
- Response `200`:
```json
{ "items": [{ "id": "uuid", "type": "GPS_NOT_VERIFIED", "status": "OPEN",
  "occurredAt": "iso", "createdAt": "iso",
  "employee": { "id": "uuid", "name": "Juha Korhonen" },
  "site": { "id": "uuid", "name": "Kamppi Renovation" } | null,
  "payrollPeriod": { "id": "uuid", "startDate": "2026-08-01", "endDate": "2026-08-15" } | null,
  "clockEventSummary": { "channel": "ONLINE", "capturedOffline": false, "gpsVerification": "NOT_VERIFIED", "gpsAccuracyMeters": null } | null,
  "summary": "GPS location could not be verified",
  "resolvedAt": null, "resolutionNote": null }],
  "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
```
- `siteId`-фильтр матчит через любую из пяти site-связей исключения (`siteId`,
  `clockEvent.siteId`, `clockShift.siteId`, `clockShiftFragment.siteId`,
  `relatedClockShift.siteId`) — не только собственное поле, которое `OVERLAPPING_SHIFT` оставляет
  `NULL`. `employeeId` — только здесь, недоступен foreman-эндпоинту ниже.
- Сортировка: `occurredAt DESC, id DESC` (стабильная). `count()`/`findMany()` — один и тот же
  `where`.
- DoD: страница/count/пустой результат согласованы одним и тем же предикатом; повторный
  идентичный запрос даёт идентичный порядок

#### `GET /api/admin/attendance/exceptions/:exceptionId`
- Permission: `attendance.exception.read.all`
- Response `200`: всё из списка + `timesheet: {id,status}|null`, `clockEvent` (полные метаданные:
  `operationType`/`effectiveAt`/`serverReceivedAt`/`capturedOffline`/`channel`/
  `gpsVerification`/`gpsAccuracyMeters`/`gpsUnavailableReason`) `|null`, `clockShift`/
  `relatedClockShift` (`site`/`workArea`/`recordedStartAt`/`recordedEndAt`/`endAtProvisional`/
  `materializationState`/`fragments[]`) `|null`, `detail` (см. sanitizer ниже) `|null`,
  `resolvedBy: {id,name}|null`
- Ошибки: `404 EXCEPTION_NOT_FOUND` — единый код для malformed UUID, несуществующего id, и (на
  foreman-эндпоинте ниже) существующего, но вне scope исключения — ни одна из трёх причин не
  отличима снаружи

#### `GET /api/foreman/attendance/exceptions` / `GET /api/foreman/attendance/exceptions/:exceptionId`
- Permission: `attendance.exception.read.assigned`
- Тот же query/response contract, кроме: `employeeId`-фильтр недоступен (тихо игнорируется, если
  передан); `siteId`-фильтр сужается до пересечения с собственным текущим scope — чужой `siteId`
  даёт пустой `200`, никогда `403`/`404`
- Scope: `scopeSiteIds` исключения (собранные из тех же пяти связей выше) должны пересекаться с
  текущими (`validFrom<=today<=validTo|NULL`) `ForemanAssignment.siteId` вызывающего
  (`lib/foreman-review.ts`'s `getForemanSiteIds`, переиспользован). Dual-role `FOREMAN`+`WORKER`
  не видит собственные исключения (`exception.employeeId === caller.employeeId`) — тот же `404`,
  что «не существует», не отдельный код. Own↔foreign `OVERLAPPING_SHIFT`: своя половина
  (`clockShift`, чей `siteId` — свой текущий объект) полностью видна; чужая половина
  (`relatedClockShift`) редактируется в `null` целиком — ни id, ни `siteId`/name, ни время
  чужого объекта не просачиваются
- DoD: scope перепроверяется на каждый запрос заново (истёкший/добавленный `ForemanAssignment`
  между list и detail немедленно меняет видимость, ничего не кэшируется)

**`detail`-sanitizer** — `AttendanceException.detail` (произвольный `Json?`) никогда не отдаётся
напрямую: явный allowlist из 16 ключей (`distanceMeters`, `accuracyMeters`, `thresholdMeters`,
`reason`, `clockSkewMs`, `assumedSiteId`, `authoritativeSiteId`, `claimedEffectiveAt`, `openedAt`,
`clampedTo`, `durationHours`, `thresholdHours`, `timesheetStatus`, `triggeringClockShiftId`,
`cachedGeofenceVersionId`, `currentGeofenceVersionId`), реверс-инженерных из реальных
`detail:`-литералов всех модулей, что создают исключения. Неизвестные ключи и любые вложенные
object/array-значения даже под разрешённым ключом отбрасываются рекурсивно.

**Никогда не отдаются** (ни `ADMIN`, ни `FOREMAN`): `latitude`/`longitude`/`ClockEventLocation`,
`payloadHash`, `requestId`, `deviceInstallationId`, `deviceSequence`,
`sanitizedConflictingPayload`, произвольный несанитизированный `detail`. Raw GPS не реализован ни
для кого этим слайсом — `attendance.gps.read.raw` не засеян.

### 9.1c Attendance exception resolution (T7A.8B.1 + T7A.8B.2, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md`
§8.5/§9.8/§11/§12.1/§12.3 — **реализовано: `DISMISS`/`ACKNOWLEDGE_AS_VALID`/
`PAIR_ORPHAN_EVENTS`**) — `lib/attendance-exception-resolution.ts`

Остальные три resolution-действия (`CONFIRM_SOURCE_ASSIGNMENT`, `REASON_EDIT`,
`FORCE_CLOSE_OPEN_SHIFT`) не реализованы — `action` с любым из этих значений (включая любую
другую строку) → `400 VALIDATION_ERROR`, `fieldErrors.action` перечисляет ровно три реализованных
значения. Нет временной заглушки, мутирующей данные для этих трёх.

#### `POST /api/admin/attendance/exceptions/:exceptionId/resolve`
#### `POST /api/foreman/attendance/exceptions/:exceptionId/resolve`
- Permission: **оба** — `attendance.exception.read.{all,assigned}` **и**
  `attendance.exception.resolve.{all,assigned}` (resolve не подразумевает read и наоборот —
  временный отзыв одного не даёт доступа через другой)
- CSRF: `X-Requested-With: titanor-time` обязателен
- Request (DISMISS/ACKNOWLEDGE_AS_VALID, неизменно с T7A.8B.1):
```json
{ "action": "DISMISS" | "ACKNOWLEDGE_AS_VALID", "resolutionNote": "optional string, max 2000" }
```
  `checkInEventId`/`checkOutEventId` для этих двух действий теперь явно **запрещены** —
  `400 VALIDATION_ERROR` с `fieldErrors`, не тихо игнорируются (защита от stale-UI, отправившего
  двусмысленное тело).
- Request (PAIR_ORPHAN_EVENTS, T7A.8B.2):
```json
{ "action": "PAIR_ORPHAN_EVENTS", "checkInEventId": "uuid", "checkOutEventId": "uuid",
  "resolutionNote": "optional string, max 2000" }
```
  Оба event id обязательны, должны быть валидными UUID и отличаться друг от друга.
  `resolutionNote` — `trim()`; пустая строка после trim считается отсутствующей (`null`);
  неизвестные поля тела игнорируются, не влияют на действие.
- Response `200` (DISMISS/ACKNOWLEDGE_AS_VALID):
```json
{ "id": "uuid", "type": "GPS_NOT_VERIFIED", "status": "DISMISSED" | "RESOLVED",
  "resolutionAction": "DISMISS" | "ACKNOWLEDGE_AS_VALID", "resolvedAt": "iso",
  "resolvedBy": { "id": "uuid", "name": "Admin Name" }, "resolutionNote": "string" | null }
```
- Response `201` (PAIR_ORPHAN_EVENTS):
```json
{ "resolutionAction": "PAIR_ORPHAN_EVENTS",
  "clockShift": { "id": "uuid", "employeeId": "uuid", "checkInEventId": "uuid",
    "checkOutEventId": "uuid", "siteId": "uuid", "workAreaId": "uuid" | null,
    "sourceAssignmentId": "uuid" | null, "recordedStartAt": "iso", "recordedEndAt": "iso",
    "materializationState": "PENDING" },
  "resolvedExceptions": [{ "id": "uuid", "type": "DOUBLE_CHECK_IN", "status": "RESOLVED" }],
  "resolvedAt": "iso", "resolvedBy": { "id": "uuid", "name": "Admin Name" },
  "resolutionNote": "string" | null }
```
  `resolvedExceptions` содержит именованное исключение плюс второе OPEN orphan-исключение
  комплементарного типа/события, если оно существует, стабильно отсортировано по `id`.
  Никогда `AttendanceException.detail` напрямую, raw GPS, `payloadHash`/device-поля, внутренности
  `AuditEvent`.
- Ошибки, общие для всех трёх действий: `400 VALIDATION_ERROR` (malformed JSON/body, `action`
  отсутствует/не из трёх реализованных значений, `resolutionNote` не строка/>2000 символов,
  `CHECKOUT_CHRONOLOGY_ANOMALY`+`DISMISS` без непустого `resolutionNote`), `401
  NOT_AUTHENTICATED`, `403 CSRF_REJECTED`, `403 FORBIDDEN` (нет одного из двух требуемых
  permission), `403 FOREMAN_SCOPE_INCOMPLETE` (видно через `GET`, но часть доказуемых site-связей
  — не текущий объект прораба), `404 EXCEPTION_NOT_FOUND` (malformed UUID, несуществующий id,
  foreman out-of-scope/self-exception — один и тот же код для всех трёх), `409
  EXCEPTION_ALREADY_RESOLVED` (терминальный статус, ничего не переписывается, второй `AuditEvent`
  не создаётся), `409 ACTION_NOT_APPLICABLE` (`allowedActions` — полная domain-матрица §11 для
  этого типа, включает нереализованные действия информационно, не обещание доступности), `409
  OPEN_SHIFT_STILL_PENDING` (`MISSING_CHECKOUT_AT_CUTOFF`+`DISMISS`, originating
  `EmployeeOpenShift` всё ещё открыта).
- Ошибки, специфичные для `PAIR_ORPHAN_EVENTS`: `400 VALIDATION_ERROR` с `fieldErrors` на
  конкретном event id — form/type mismatch (`operationType`), employee mismatch между событиями
  или с named exception (защита от использования видимого чужого orphan-exception как
  authorization anchor для произвольной пары другого работника), нарушенная строгая хронология
  (`checkOutEvent.effectiveAt <= checkInEvent.effectiveAt`, без clamp), named exception не связан
  с выбранной парой (`clockEventId` не совпадает с ожидаемым событием по типу); `404
  CLOCK_EVENT_NOT_FOUND` (один или оба event id не существуют); `409 EVENT_ALREADY_PAIRED` (одно
  или оба события уже участвуют в любой существующей `ClockShift`, явный precheck, не только
  `UNIQUE`-constraint); `409 PAIRED_SHIFT_OVERLAP` (новая пара пересекается по времени с уже
  существующей `ClockShift` этого работника — точное касание границ разрешено).
- Матрица (§11): `DISMISS` — `GPS_NOT_VERIFIED`/`OUTSIDE_GEOFENCE_CHECKOUT`/
  `SITE_MISMATCH_CHECKOUT`/`DOUBLE_CHECK_IN`/`CHECKOUT_WITHOUT_OPEN_SHIFT`/
  `GEOFENCE_VERSION_MISMATCH`/`MISSING_CHECKOUT_AT_CUTOFF`(динамически)/`EXCESSIVE_CLOCK_SKEW`/
  `CHECKOUT_CHRONOLOGY_ANOMALY`(с обязательной note)/`EXCESSIVE_SHIFT_DURATION`/
  `PERIOD_BOUNDARY_SPAN`/`OVERLAPPING_SHIFT`; НЕ `STALE_ASSIGNMENT`/`LATE_SYNC_AFTER_SUBMIT`.
  `ACKNOWLEDGE_AS_VALID` — только `GPS_NOT_VERIFIED`/`OUTSIDE_GEOFENCE_CHECKOUT`/
  `SITE_MISMATCH_CHECKOUT`/`GEOFENCE_VERSION_MISMATCH`/`EXCESSIVE_CLOCK_SKEW`/
  `EXCESSIVE_SHIFT_DURATION`/`PERIOD_BOUNDARY_SPAN`. `PAIR_ORPHAN_EVENTS` — только `DOUBLE_CHECK_IN`/
  `CHECKOUT_WITHOUT_OPEN_SHIFT`, и только пока `status=OPEN`.
- `OVERLAPPING_SHIFT` `DISMISS` меняет только `status`/`resolvedBy*`/`resolutionNote` конкретной
  canonical-пары — `overlapEndedAt` не трогается (оставлен существующему
  `resolveOverlapTransition`, который при последующем физическом исчезновении overlap заполняет
  только его, не переписывая human resolution metadata). `PAIR_ORPHAN_EVENTS` никогда не создаёт
  `OVERLAPPING_SHIFT` — пара при обнаруженном overlap отклоняется целиком, до `INSERT`.
- FOREMAN scope для мутации строже `GET`: требует, чтобы **все** доказуемые site-связи исключения
  были текущими объектами прораба, не только пересечение — own↔foreign `OVERLAPPING_SHIFT` видна
  через `GET`, но резолюция → `403 FOREMAN_SCOPE_INCOMPLETE`. Для `PAIR_ORPHAN_EVENTS` scope —
  объединение пяти собственных site-связей named exception **∪** `checkInEvent.siteId` **∪**
  `checkOutEvent.siteId`; базовая видимость исключения проверяется до чтения событий, чтобы
  невидимое исключение не дифференцировало ответ по присланным event id.
- Транзакция (§8.5, DISMISS/ACKNOWLEDGE_AS_VALID): read-only pre-read (без лока) → `Employee FOR
  UPDATE` → `AttendanceException FOR UPDATE` (canonical order §8.1) → повторная проверка
  status/type/scope из транзакции (scope — свежий запрос `ForemanAssignment`, не pre-read кэш) →
  один `UPDATE` → один `AuditEvent` → COMMIT. Любой исход, обнаруженный до мутации, коммитит без
  единой записи.
- Транзакция (§9.8, PAIR_ORPHAN_EVENTS): read-only pre-read (named exception + оба события, без
  лока) → `Employee FOR UPDATE` → named `AttendanceException FOR UPDATE` → повторная проверка
  status/type/link/employee/хронологии + свежий, race-free поиск комплементарного OPEN-исключения
  тем же tx-клиентом (Employee-лок уже держится) → `AttendanceException FOR UPDATE` комплементарной,
  если найдена → повторная проверка FOREMAN scope из транзакции → event-reuse precheck → overlap
  precheck (`tstzrange`, дефолтные `[)`-границы) → `INSERT ClockShift(PENDING)` → `UPDATE` каждой
  резолвящейся exception (named + комплементарная, если ещё OPEN — терминальная не переписывается)
  → один `AuditEvent` → COMMIT. Два `AttendanceException`-лока (named + комплементарная) не
  требуют canonical сортировки между собой: строки single-employee-owned, а держание `Employee`-
  лока первым уже полностью сериализует все resolver-транзакции этого работника.
  `materializeClockShiftCore` внутри этой транзакции НЕ вызывается — созданная `ClockShift` остаётся
  `PENDING`, подхватывается отдельным catch-up проходом материализатора с его собственным
  canonical lock contract (§9.4/§9.5), без дублирования логики.
- Audit: `ATTENDANCE_EXCEPTION_DISMISSED` / `ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID` /
  `ATTENDANCE_EXCEPTION_PAIRED`, `entityType=ATTENDANCE_EXCEPTION`, `entityId=named exceptionId`,
  `beforeValue={status,type}`, `afterValue={status,resolutionAction}` (PAIR: плюс `clockShiftId`,
  `resolvedExceptionIds` — стабильно отсортированные), `reason=resolutionNote` — никогда
  `detail`/GPS/raw event payload/`payloadHash`/device-поля/request-тела/персональные данные
  работника. Ровно один `AuditEvent` на PAIR-вызов, в той же транзакции, что и мутация.
- DoD: реальная многосессионная конкуренция (не `Promise.all`-таймингом) подтверждена
  `pg_stat_activity` — два `DISMISS` одного исключения дают ровно один `200`/один `409`/один
  `AuditEvent`; scope, истекающий между pre-read и транзакцией, гарантированно блокирует мутацию.
  Для PAIR — те же гарантии плюс: два одновременных PAIR одной пары через разные orphan-исключения
  → ровно одна `ClockShift`; две разные пары, переиспользующие один event → одна побеждает, вторая
  `409 EVENT_ALREADY_PAIRED`; принудительный сбой между `INSERT` и `UPDATE`/`AuditEvent` (реальный
  Postgres FK-violation, не тестовый backdoor) → полный откат, без orphan `ClockShift`.

## 10. Служебный агрегатор

#### `GET /api/admin/setup-status`
- Permission: `worker.read.all`
- Response `200`: `{ "hasCity", "hasSite", "hasWorkArea", "hasTemplate", "hasWorker",
  "hasAssignment", "hasOpenPeriod" }` — `hasCity` не блокирует готовность чек-листа
- Ошибки: нет

## 11. Проверка первого сценария по контрактам

| Шаг сценария | Endpoint(ы) |
|---|---|
| 1. Admin входит | `POST /api/auth/login` |
| 2. Создаёт город (опц.) | `POST /api/admin/cities` |
| 3. Создаёт объект | `POST /api/admin/sites` |
| 4. Создаёт рабочую область | `POST /api/admin/sites/:siteId/work-areas` |
| 5. Создаёт шаблон | `POST /api/admin/templates` |
| 6. Регистрирует работника | `POST /api/admin/workers` (без кода активации) |
| 7–8. Назначает на объект+шаблон | `POST /api/admin/assignments/validate-overlap`, `POST /api/admin/assignments` |
| 9. Открывает период | `POST /api/admin/periods` |
| 10. Выдаёт код активации | `POST /api/admin/workers/:employeeId/activation` |
| 11. Работник активирует | `GET /api/auth/activate`, `POST /api/auth/set-initial-password` |
| 12. Работник входит | автологин из шага 11 |
| 13. Видит назначение | `GET /api/worker/context`, `GET /api/worker/assignments/current`, `GET /api/worker/periods/current` |

## 12. Открытые вопросы

- Порог rate limit — 5/15мин на аккаунт + 50/15мин на IP, подтверждён владельцем.
- Формат `activationCode`, TTL 72 часа, бумага с QR — подтверждено владельцем.
- Правило для смены, пересекающей границу расчётного периода — не решено.
- Route/API contracts для `absence.*` (`02_...`, §2.3) — permission-контракт полный, сами endpoint'ы
  спроектированы в следующей фазе; для первого среза `Absence` создаётся вне публичного API.

## 13. `absence.approve` — контракт (later phase, зафиксирован для консистентности)

Не входит в первый вертикальный срез (см. §12), но контракт зафиксирован точно, чтобы overlay-
транзакция (`03_...`, §4.2) имела однозначную HTTP-семантику, когда этот эндпоинт будет реализован.

#### `POST /api/admin/absences/:absenceId/approve` (later phase)
- Permission: `absence.approve`
- **State-branching precondition (дополнительный уровень поверх обязательного
  `Idempotency-Key`, не замена ему)** — сервис берёт `SELECT Employee ... FOR UPDATE` этого
  `Absence.employeeId` (`03_...`, §4.2, «Единый стабильный lock...» — сериализует с
  `period.create`/`assignment.create`, не с `PATCH .../days/:date` над уже существующими днями),
  затем читает `Absence.status` под блокировкой:
  - **`PENDING`** → для каждого пересекающегося `TimesheetDraftDay` (уже существующего) — выбор в
    стабильном порядке `(date, id)`, `SELECT ... FOR UPDATE` на каждой строке, и только после этого
    чтение `dayType`/`confirmedZero`/сегментов для классификации overlay/conflict (`03_...`, §4.2) —
    выполняет overlay-транзакцию, `status → APPROVED`, записывает
    `overlayAppliedDates`/`overlayConflicts` на `Absence`, отвечает `200` (тело ниже);
  - **`APPROVED`** (уже одобрена — этим же вызовом раньше под **другим корректным**
    `Idempotency-Key`, либо гонка, разрешившаяся в пользу другого запроса) → overlay **не**
    выполняется повторно; отвечает `200` с **ранее сохранёнными** `Absence.overlayAppliedDates`/
    `overlayConflicts` — тот же результат, что при первом успешном вызове;
  - **`REJECTED`** → `409 ABSENCE_NOT_PENDING`, `Absence` не трогается — единственное состояние,
    в котором операция действительно невыполнима.
- Response `200` (для обеих веток `PENDING`/`APPROVED` выше):
```json
{
  "absenceId": "uuid",
  "status": "APPROVED",
  "overlayAppliedDates": ["2026-08-03", "2026-08-04"],
  "overlayConflicts": [
    { "timesheetId": "uuid", "date": "2026-08-05", "reason": "DRAFT_HAS_SEGMENTS" }
  ]
}
```
  `reason` в `overlayConflicts[]` — один из `DRAFT_HAS_SEGMENTS` | `CONFIRMED_ZERO` |
  `EXPLICIT_DAY_TYPE` | `SUBMITTED_VERSION`.
- Ошибки: **только** `409 ABSENCE_NOT_PENDING`, если `Absence.status = REJECTED` на момент вызова
  (вся операция отклоняется, `Absence` не трогается). **Нет сценария, где мутация зафиксирована, а
  ответ — `409`** — ни для первого успешного вызова (`PENDING → APPROVED`), ни для любого
  последующего вызова над уже `APPROVED` записью (в v5.4 это правило выполнялось только для повтора
  **того же** `Idempotency-Key» — вызов с другим ключом после `APPROVED` ошибочно получал `409`;
  исправлено: ветвление теперь по `Absence.status`, не по `Idempotency-Key`).
- Idempotency: **`Idempotency-Key` обязателен** — запрос без заголовка отклоняется общей проверкой
  обязательных заголовков **до** обращения к бизнес-логике (`400`/`422`, тот же механизм, что для
  любого другого endpoint с обязательным ключом, §1 выше; не специфично для `absence.approve`). При
  наличии корректного ключа — два уровня: (а) точно тот же ключ → закешированный HTTP-ответ без
  похода в бизнес-логику; (б) **другой**, ранее не виденный, корректный ключ, но `Absence` уже
  `APPROVED` → бизнес-логика выполняется, ветвление по `Absence.status` (см. precondition выше)
  возвращает сохранённый результат без повторного overlay — `200`, не `409`.
- Audit: `ABSENCE_APPROVED` (только при переходе `PENDING → APPROVED`, не при повторном вызове над
  `APPROVED`), отдельно `ABSENCE_OVERLAY_APPLIED` на каждую дату из `overlayAppliedDates`

## 14. Системные пользователи (`FOREMAN`) — реализовано

Backend-срез (`02_...`, §2.12): создание/пополнение только роли `FOREMAN`. Без UI, без выдачи
учётных данных — `IMPLEMENTATION_STATUS.md`. `ADMIN`/`SUPER_ADMIN`-создание, `role.assign`,
деактивация — не входят, зарезервированы `01_SCREEN_MAP.md` (`/admin/users`).

#### `GET /api/admin/users`
- Permission: `user.read`
- Query: `page`, `pageSize`, `role` (только значение `FOREMAN` учитывается как фильтр)
- Без `role` — только системные пользователи с текущей активной ролью `FOREMAN`, `ADMIN` или
  `SUPER_ADMIN` (`UserRole.validFrom <= now AND (validTo IS NULL OR validTo > now)`); `WORKER`-only
  аккаунты не включаются; дуал-роль `FOREMAN`+`WORKER` включается. `roles` в каждом элементе — полный
  набор текущих активных ролей пользователя, не только совпавшая с фильтром.
- `T7A §13/§15 п.4`: `WHERE userKind='HUMAN'` — reserved SYSTEM actor (`username=system.scheduler`)
  никогда не появляется в этом списке, явным фильтром, а не только за счёт отсутствия ролей.
- Response `200`:
```json
{
  "items": [{
    "id": "uuid", "username": "j.foreman", "email": "j.foreman@example.com",
    "status": "PENDING_ACTIVATION", "locale": "FI", "roles": ["FOREMAN"],
    "employee": null, "createdAt": "2026-08-06T12:00:00.000Z"
  }],
  "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1
}
```
- Никогда не возвращает `passwordHash`, `twoFactorSecret`, данные сессий/токенов

#### `POST /api/admin/users`
- Permission: `user.create.foreman`
- Роль никогда не принимается из тела запроса — эндпоинт физически может только создать/выдать
  `FOREMAN`; наличие поля `role`/`roles` → `400 VALIDATION_ERROR`
- Request, режим `STANDALONE` — новый `User` без `Employee`:
```json
{ "mode": "STANDALONE", "username": "j.foreman", "email": "j.foreman@example.com"?, "locale": "FI"|"EN"|"RU"? }
```
  `username`/`email` нормализуются как в `POST /auth/login` (`trim`+`lowercase`); `username` —
  `^[a-z0-9._-]{3,64}$` после нормализации; `email` — валидный формат, максимум 255 символов;
  `employeeId` в этом режиме → `400 VALIDATION_ERROR`. Атомарно: `User(status=PENDING_ACTIVATION,
  passwordHash=null, employeeId=null)` + активная `UserRole(FOREMAN)` + `AuditEvent(USER_CREATED)`.
  `UserActivationToken` **не выдаётся** этим вызовом (отдельный, ещё не реализованный шаг).
- Request, режим `EXISTING_EMPLOYEE` — дуал-роль на уже существующем `User` работника:
```json
{ "mode": "EXISTING_EMPLOYEE", "employeeId": "uuid" }
```
  `employeeId` — строгий UUID-формат (тот же `UUID_PATTERN`, что во всех остальных admin routes);
  malformed значение (не UUID) → `400 VALIDATION_ERROR`, `fieldErrors.employeeId=["invalid"]`, не
  доходит до БД (без этого — cast error `22P02`/`500`). `username`/`email`/`locale` в этом режиме →
  `400 VALIDATION_ERROR`. `Employee` уже имеет `User` (создан через `POST /api/admin/workers`) —
  второй `User` не создаётся никогда. Duplicate/reservation guard: если у `User` уже есть
  **не завершённая** `UserRole(FOREMAN)` — `validTo IS NULL OR validTo > now` — новый grant
  запрещён (`409 USER_ALREADY_FOREMAN`); это относится и к текущей (`validFrom <= now`), и к
  запланированной будущей (`validFrom > now`) роли — обе считаются «active or scheduled». Только
  уже завершённая роль (`validTo <= now`) не блокирует и не переиспользуется — создаётся новая
  активная `UserRole(FOREMAN)` + `AuditEvent(FOREMAN_ROLE_GRANTED)`. `User.status` не меняется:
  `PENDING_ACTIVATION` продолжает обычный worker-activation flow, `ACTIVE` не требует токена.
- Response `201` — тот же элемент, что в `GET` (`employee` заполнено только в `EXISTING_EMPLOYEE`);
  `roles` — только текущие роли (`validFrom <= now AND (validTo IS NULL OR validTo > now)`);
  запланированная будущая роль не попадает в `roles`, пока не наступит её `validFrom`
- Ошибки: `400 VALIDATION_ERROR`, `404 EMPLOYEE_NOT_FOUND`, `409 EMPLOYEE_USER_MISSING` (у
  `Employee` нет `User`), `409 USER_NOT_ELIGIBLE` (`status` не `PENDING_ACTIVATION`/`ACTIVE`),
  `409 USER_ALREADY_FOREMAN` (active or scheduled `FOREMAN` role уже существует),
  `409 DUPLICATE_USERNAME`, `409 DUPLICATE_EMAIL`
- Idempotency: обязателен (`X-Requested-With: titanor-time` + `Idempotency-Key`)
- Audit: `USER_CREATED` (`STANDALONE`, `entityType USER`) / `FOREMAN_ROLE_GRANTED`
  (`EXISTING_EMPLOYEE`, `entityType USER_ROLE`, `entityId` — id новой `UserRole`)

## 15. Credential flow standalone `FOREMAN` — реализовано

Отдельная от worker activation (§1/§5) пара таблица+секрет: `UserActivationToken` (не
`ActivationToken`), тот же секрет `ACTIVATION_TOKEN_HMAC_KEY` и те же crypto-примитивы
(`generateActivationCode`/`normalizeActivationCode`/`hashActivationCode`/
`formatActivationCodeForDisplay`, `lib/activation.ts`), но отдельная таблица, отдельный модуль
(`lib/system-activation.ts`) и отдельные HTTP-роуты — worker activation (`ActivationToken`,
`/api/auth/activate`, `/api/auth/set-initial-password`) не меняется. Применимо только к standalone
`FOREMAN` (`User.employeeId IS NULL`) — созданному через `POST /api/admin/users`, `mode=STANDALONE`
(§14). Без UI.

#### `POST /api/admin/users/:userId/activation`
- Permission: `user.activation.generate`
- `userId` — строгий UUID-формат; malformed → `404 USER_NOT_FOUND` (тот же паттерн, что
  `POST /api/admin/workers/:employeeId/activation`)
- Eligibility (проверяется под `SELECT ... FOR UPDATE` на `User`, порядок проверок фиксирован —
  `userKind` раньше `employeeId` раньше `status`, T7A §13/§15: reserved SYSTEM actor
  (`userKind=SYSTEM`) всегда получает `SYSTEM_USER_NOT_ELIGIBLE`, раньше любой другой проверки,
  затем worker-пользователь всегда получает `USER_USES_WORKER_ACTIVATION`, а не
  `USER_ALREADY_ACTIVE`): `User` существует; `userKind=HUMAN`; `employeeId IS NULL`;
  `status=PENDING_ACTIVATION`; `passwordHash IS NULL`; текущая активная роль `FOREMAN`
  (`validFrom <= now AND (validTo IS NULL OR validTo > now)`)
- Reissue: любой оставшийся `PENDING` код того же `userId` — просроченный (`expiresAt <= now`)
  помечается `EXPIRED`, остальные — `REVOKED`, в той же транзакции, что создание нового кода
- Response `201`:
```json
{ "activationCode": "XXXX-XXXX-XX", "activationExpiresAt": "2026-08-09T12:00:00.000Z" }
```
  Raw-код показывается только в этом успешном response — не хранится (только HMAC в
  `UserActivationToken.tokenHash`), не логируется, не попадает в аудит
- Ошибки: `404 USER_NOT_FOUND`, `409 USER_ALREADY_ACTIVE`, `409 USER_USES_WORKER_ACTIVATION`
  (`employeeId` не `NULL`), `409 SYSTEM_USER_NOT_ELIGIBLE` (T7A §13 — `userId` резолвит
  reserved SYSTEM actor, `userKind=SYSTEM`), `409 ACCOUNT_NOT_ELIGIBLE` (нет текущей роли
  `FOREMAN`, `status`≠`PENDING_ACTIVATION` или `passwordHash` уже установлен)
- Idempotency: обязателен (`X-Requested-With: titanor-time` + `Idempotency-Key`)
- Audit: `USER_ACTIVATION_TOKEN_ISSUED`, `entityType USER`, `entityId = userId`, `afterValue` —
  только `{ expiresAt }`, без кода/`tokenHash`

#### `GET /api/auth/activate-account?token=...`
- Публичный, без CSRF (`GET`); rate-limit по IP — отдельный namespace от
  `GET /api/auth/activate` (worker), не делит лимит с ним
- Ищет только `UserActivationToken` (не `ActivationToken`)
- `PENDING` и не истёк → `200`:
```json
{ "username": "j.foreman", "locale": "FI" }
```
- Просроченный `PENDING` атомарно помечается `EXPIRED` тем же вызовом
- Ошибки: `410 TOKEN_EXPIRED`, `410 TOKEN_USED`, `404 TOKEN_INVALID` (`REVOKED`/неизвестный/
  malformed — не различаются)
- Никогда не возвращает `email`, роли, `passwordHash` или `tokenHash`

#### `POST /api/auth/set-account-password`
- Публичный, mutating — CSRF (`X-Requested-With: titanor-time`) обязателен; rate-limit по IP —
  отдельный namespace от `POST /api/auth/set-initial-password` (worker)
- Request: `{ "token": "...", "password": "..." }` — `password` 8–256 символов, иначе
  `400 VALIDATION_ERROR`
- Lock order (совпадает с issuance/reissue, чтобы не было deadlock): сначала `User FOR UPDATE`
  (через дешёвый unlocked preflight lookup `UserActivationToken.userId` по `tokenHash`, ничего из
  preflight не используется для решения), затем `UserActivationToken FOR UPDATE`; token
  status/expiry и eligibility User перепроверяются под обоими локами
- Redeem eligibility: `userKind=HUMAN` (T7A §13 — checked before every other field, defense-in-
  depth even though a token pointing at a SYSTEM actor should never exist per the issuance-time
  guard above), `employeeId IS NULL`, `status=PENDING_ACTIVATION`, `passwordHash IS NULL`,
  текущая активная роль `FOREMAN` — иначе `409 SYSTEM_USER_NOT_ELIGIBLE` or `409
  ACCOUNT_NOT_ELIGIBLE` (включая `OFFBOARDING`/`DEACTIVATED` или отсутствие роли)
- Атомарно: Argon2id `passwordHash`, `User.status → ACTIVE`, существующая активная `UserRole`
  `FOREMAN` не создаётся повторно, `UserActivationToken.status → USED` + `usedAt`, новая
  `UserSession`, `AuditEvent(ACCOUNT_ACTIVATED)` с `entityType USER`
- Response `200`:
```json
{ "user": { "id": "uuid", "username": "j.foreman", "roles": ["FOREMAN"], "locale": "FI" } }
```
  cookie `tt_session` выставляется route handler'ом только после успешного commit транзакции —
  те же флаги/TTL, что `POST /api/auth/set-initial-password` (`httpOnly`, `secure`,
  `sameSite=lax`, `path=/`, `maxAge` = `SESSION_DURATION_MS`)
- Ошибки: `400 VALIDATION_ERROR`, `403 CSRF_REJECTED`, `404 TOKEN_INVALID`,
  `409 SYSTEM_USER_NOT_ELIGIBLE`, `409 ACCOUNT_NOT_ELIGIBLE`, `410 TOKEN_EXPIRED`,
  `410 TOKEN_USED`, `429 RATE_LIMITED`

## 16. Назначение прораба (`ForemanAssignment`) — selector без UUID, реализовано

`/admin/sites/:siteId` выбирает прораба через `<select>` (`lib/foreman-assignments.ts`'s
`listAssignableForemen()`), а не текстовым UUID-полем. Selector — только UX-фильтр; сервер
(`createForemanAssignment()`, вызывается из `POST /api/admin/foreman-assignments` ниже) повторяет
ровно те же две проверки независимо от selector'а — прямой запрос с произвольным `foremanUserId`
не может их обойти.

**Eligibility (обе проверки обязательны, порядок фиксирован — статус раньше роли, чтобы
`OFFBOARDING`/`DEACTIVATED` с не отозванной `FOREMAN`-ролью получал `FOREMAN_NOT_ELIGIBLE`, а не
`USER_NOT_FOREMAN`)**:
1. `User.status IN (PENDING_ACTIVATION, ACTIVE)` — `OFFBOARDING`/`DEACTIVATED` отклоняются даже
   при наличии роли (ничего сегодня не отзывает `FOREMAN`-роль при смене статуса).
   `PENDING_ACTIVATION` разрешён осознанно — прораба можно назначить на объект до того, как он
   завершит собственную активацию.
2. Текущая (не future, не ended) роль `FOREMAN`: `validFrom <= now AND (validTo IS NULL OR
   validTo > now)`.

#### (data) `listAssignableForemen()`
- Не HTTP-эндпоинт — Server Component (`/admin/sites/:siteId`) читает эту функцию напрямую, как
  `listEmployeesForForemanSelect()` в `lib/users.ts`
- Форма элемента: `{ id, username, status, employee: null | { id, employeeNumber, firstName,
  lastName } }`
- Тот же набор `User`, что eligibility выше отбирает для `createForemanAssignment` — включает
  `PENDING_ACTIVATION`, исключает `OFFBOARDING`/`DEACTIVATED`/future-role/ended-role/no-role;
  standalone `FOREMAN` присутствует в том же списке, что дуал-роль
- Сортировка: `(employee.lastName, employee.firstName)`, если `Employee` привязан, иначе
  `username`; `username` — вторичный ключ сортировки при совпадении

#### `POST /api/admin/foreman-assignments`
- Permission: `foreman_assignment.create` (без изменений)
- Request/response shape не менялись: `{ "foremanUserId", "siteId", "isSubstitute"?, "validFrom",
  "validTo"? }` → `201` с полным `ForemanAssignment`
- Ошибки: `400 VALIDATION_ERROR`, `404 FOREMAN_NOT_FOUND`/`SITE_NOT_FOUND`,
  `409 FOREMAN_NOT_ELIGIBLE` (status `OFFBOARDING`/`DEACTIVATED`),
  `409 USER_NOT_FOREMAN` (нет текущей роли `FOREMAN` — включает отсутствие роли вовсе, ещё не
  начавшуюся (`validFrom > now`) и уже завершённую (`validTo <= now`) роль)
- Malformed/неизвестный UUID — прежнее поведение не менялось: malformed → `400
  VALIDATION_ERROR` до похода в БД, валидный но неизвестный → `404 FOREMAN_NOT_FOUND`
- Audit: `FOREMAN_ASSIGNMENT_CREATED` — создаётся только при успехе, в той же транзакции, что
  `INSERT` строки `ForemanAssignment`
- Не менялись: выбор дат, `isSubstitute`, отсутствие overlap-проверки (несколько
  прорабов/заместителей на объект — легитимно, `03_...`, §4.4)
