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

## 4. Рабочие шаблоны

`POST` создаёт `WorkScheduleTemplate`+версию 1; `PATCH` создаёт новую версию.

#### `GET /api/admin/templates`
- Permission: `template.read.all`
- Response `200`: список `{ id, name, active, currentVersionNumber, workingDaysCount }`

#### `POST /api/admin/templates`
- Permission: `template.create`
- Request: `{ "name", "description"?, "days": [7 × {weekday, isWorkingDay, plannedStartTime?, plannedEndTime?, plannedBreakMinutes}] }`
- Response `201`: `{ "id", "name", "currentVersionId", "currentVersionNumber": 1, "days": [...] }`
- Ошибки: `400 VALIDATION_ERROR`
- Idempotency: поддерживается
- Audit: `TEMPLATE_CREATED`

#### `GET /api/admin/templates/:templateId`
- Permission: `template.read.all`
- Response `200`: `{ "id", "name", "active", "currentVersionId", "currentVersionNumber", "days" }`
- Ошибки: `404 TEMPLATE_NOT_FOUND`

#### `PATCH /api/admin/templates/:templateId`
- Permission: `template.update`
- Request: `{ "expectedVersionNumber", "name"?, "days"? }`
- Ошибки: `404`, `409 VERSION_CONFLICT`, `400 VALIDATION_ERROR`
- Audit: `TEMPLATE_UPDATED`

## 5. Работники

#### `GET /api/admin/workers`
- Permission: `worker.read.all`
- Response `200`:
```json
{ "items": [{ "id": "uuid", "employeeNumber": "1042", "firstName": "Juha", "lastName": "Korhonen",
  "active": true, "currentAssignments": [{ "siteId": "uuid", "siteName": "Kamppi Renovation",
  "isPrimary": true }] }], "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
```

#### `POST /api/admin/workers`
- Permission: `worker.create`
- Request: `{ "firstName", "lastName", "phone"?, "employeeNumber"? }`
- Response `201`: `{ "employee": {...}, "userId", "userStatus": "PENDING_ACTIVATION" }` — не
  возвращает код активации
- Ошибки: `400 VALIDATION_ERROR`, `409 DUPLICATE_EMPLOYEE_NUMBER`
- Idempotency: обязателен
- Audit: `WORKER_CREATED`

#### `GET /api/admin/workers/:employeeId`
- Permission: `worker.read.all`
- Response `200`: `Employee`+`Employment`+`currentAssignments: []`+`activationStatus`
- Ошибки: `404 WORKER_NOT_FOUND`

#### `PATCH /api/admin/workers/:employeeId`
- Permission: `worker.update`
- Request: `{ "version", ...частичные поля }`
- Ошибки: `404`, `409 VERSION_CONFLICT`, `400 VALIDATION_ERROR`
- Audit: `WORKER_UPDATED`

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
- Response `200`: `{ "timesheetId", "periodId", "status", "currentVersionId" }`
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
  "plannedShifts": [...], "reviewScopes": [{ "scopeType", "siteId", "status" }] }`
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
