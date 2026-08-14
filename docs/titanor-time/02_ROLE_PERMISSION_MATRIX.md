# Titanor Time — роли и разрешения

Версия: **5.4.1** (2026-07-23). Статус: **proposed architecture**. Источник истины для имён ролей,
permission-строк, route-доступа и endpoint-доступа для `01_SCREEN_MAP.md`, `03_DATA_MODEL_ERD.md`,
`04_ADMIN_FIRST_API_CONTRACTS.md`. Документ самодостаточен — все permission перечислены полными
таблицами.

## 1. Роли

| Роль | Кто это | Область действия |
|---|---|---|
| `SUPER_ADMIN` | Технический владелец системы | Всё, что доступно `ADMIN`, плюс управление учётными записями `ADMIN`/`SUPER_ADMIN`, назначение ролей, override корректировок |
| `ADMIN` | Начальник / офис-менеджер | Вся операционная бизнес-администрация, включая fallback-проверку табелей и `NON_SITE`-scope |
| `FOREMAN` | Прораб на объекте | Только назначенные ему объекты/рабочие области и работники на них; никогда `NON_SITE` |
| `WORKER` | Работник | Только собственные данные |

Пользователь может иметь несколько одновременно активных ролей (`FOREMAN`+`WORKER` — основной
кейс). Итоговый набор permission — объединение permission всех активных ролей. Запрет
самоподтверждения (`reviewer.employeeId != Timesheet.employeeId`) действует одинаково для
`timesheet.foreman_review` и `timesheet.scope_review.all`, включая `NON_SITE`-scope обеих
разновидностей (`DATA` и `EMPTY_FALLBACK`).

### Почему не добавлены `READ_ONLY_MANAGER` и `PAYROLL_VIEWER`

Нет реального держателя роли на первый срез — permission-модель атомарна, добавление не
заблокировано технически.

## 2. Модель permission-строк

Формат: `<domain>.<action>[.<scope>]`. Суффиксы `.own`/`.assigned`/`.all` обязательны для любого
permission с более чем одним держателем разной области видимости.

### 2.1 Auth / сессии

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `session.read.own` | все аутентифицированные | собственные сессии | — | нет | нет | нет |
| `session.revoke.own` | все аутентифицированные | одна собственная сессия | — | нет | да | нет |
| `session.revoke_all.own` | все аутентифицированные | все собственные сессии, включая текущую | — | нет | да | нет |

### 2.2 Работники (Employee)

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `worker.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | создаёт `Employee`+`User(PENDING_ACTIVATION)`+`Employment`; не создаёт `ActivationToken` | нет | да | нет |
| `worker.read.all` | `ADMIN`, `SUPER_ADMIN` | все работники | — | нет | нет | — |
| `worker.read.assigned` | `FOREMAN` | работники на объектах `ForemanAssignment` | только факт отсутствия, не `Absence.type` | нет | нет | — |
| `worker.read.own` | `WORKER` | собственный профиль | — | нет | нет | — |
| `worker.update` | `ADMIN`, `SUPER_ADMIN` | вся компания | требует `version` | нет | да | нет |
| `worker.deactivate` | `ADMIN`, `SUPER_ADMIN` | вся компания | `Employment.active=false`; `User.status → OFFBOARDING` либо `DEACTIVATED` по правилу `03_...`, §4.2; не трогает `PayrollPeriodParticipant` | да | да | да, для группы |
| `worker.activation.generate` | `ADMIN`, `SUPER_ADMIN` | вся компания | требует активный `SiteAssignment` + `PayrollPeriodParticipant` в открытом периоде, иначе `403 SETUP_INCOMPLETE` | нет | да | нет |

### 2.3 Отсутствия (`Absence`)

`Absence` — реальный source of truth для персональных отсутствий, накладывается на draft-дни при
создании и при одобрении (`03_...`, §4.2). Полный permission-контракт — ниже; route/API contracts
для этого домена **не входят в первый вертикальный срез** и помечены как later phase в `01_...`/
`04_...` (см. `04_...`, §12) — модель и авторизация тем не менее полностью определены здесь, чтобы
не блокировать проектирование последующих фаз.

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `absence.create.own` | `WORKER` | собственные будущие отсутствия | `SICK_LEAVE`/`VACATION`/`UNPAID_LEAVE`/`OTHER`; создаёт `Absence(status=PENDING)`; **единственный** путь работника к персональному non-WORK дню — прямой `PATCH` табеля non-WORK `dayType` без `Absence` запрещён (см. `timesheet.draft.edit.own` ниже) | нет | да | нет |
| `absence.create.all` | `ADMIN`, `SUPER_ADMIN` | любой работник | может создавать сразу `APPROVED` (задним числом/по документу) | нет | да | нет |
| `absence.read.own` | `WORKER` | собственные `Absence`, полный `type`/`note` | — | нет | нет | — |
| `absence.read.all` | `ADMIN`, `SUPER_ADMIN` | все `Absence`, полный `type`/`note` | — | нет | нет | — |
| `absence.read.assigned.summary` | `FOREMAN` | работники на своих объектах | **только факт отсутствия** (диапазон дат) — `type`/`note` не возвращаются никогда, даже в ответе с ошибкой | нет | нет | — |
| `absence.approve` | `ADMIN`, `SUPER_ADMIN` | вся компания | State-идемпотентная транзакция (`03_...`, §4.2), ветвится по `Absence.status` под `Employee`-блокировкой, не только по `Idempotency-Key`: `PENDING` → выполняет overlay, `status → APPROVED`, `200`; `APPROVED` (уже одобрена, любой `Idempotency-Key`) → overlay не повторяется, `200` с ранее сохранёнными `overlayAppliedDates`/`overlayConflicts`; `REJECTED` → `409 ABSENCE_NOT_PENDING` (единственный случай отказа). Нет сценария «мутация зафиксирована, ответ — `409`» ни при первом, ни при повторном вызове над `APPROVED` | нет | да | нет |
| `absence.reject` | `ADMIN`, `SUPER_ADMIN` | вся компания | `PENDING → REJECTED`; не трогает draft; не блокирует новый запрос на те же даты навсегда (`03_...`, §4.2, exclusion constraint с `WHERE status IN (PENDING, APPROVED)`) | да | да | нет |

`FOREMAN` никогда не имеет `absence.read.own`/`absence.read.all`/`absence.approve`/`absence.reject`
— видит на карточке работника только факт «отсутствует такого-то числа», не причину и не тип
(`worker.read.assigned`, §2.2, уже фиксирует то же ограничение для карточки работника в целом).

**`PUBLIC_HOLIDAY` — единственное исключение из «`Absence` — единственный путь».** Не персональный
признак, не источникуется из `Absence`, устанавливается системным/admin-механизмом при генерации
дней из шаблона (`03_...`, §4.2). `ADMIN` не правит персональное отсутствие (`SICK_LEAVE`/
`VACATION`/`UNPAID_LEAVE`/`OTHER`) произвольным `PATCH dayType` в обход `absence`/`correction`-flow —
симметрично `WORKER`.

### 2.4 Города, объекты, рабочие области

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `city.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | City опциональна | нет | да | нет |
| `city.read.all` | `ADMIN`, `SUPER_ADMIN` | все города | — | нет | нет | — |
| `city.read.assigned` | `FOREMAN` | города объектов `ForemanAssignment` | — | нет | нет | — |
| `city.read.own` | `WORKER` | город(а) активных `SiteAssignment` | — | нет | нет | — |
| `city.update` | `ADMIN`, `SUPER_ADMIN` | вся компания | — | нет | да | нет |
| `site.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | — | нет | да | нет |
| `site.read.all` | `ADMIN`, `SUPER_ADMIN` | все объекты | — | нет | нет | — |
| `site.read.assigned` | `FOREMAN` | объекты `ForemanAssignment` | — | нет | нет | — |
| `site.read.own` | `WORKER` | объект(ы) активных `SiteAssignment` | может быть несколько одновременно | нет | нет | — |
| `site.update` | `ADMIN`, `SUPER_ADMIN` | вся компания | — | нет | да | нет |
| `workarea.create` | `ADMIN`, `SUPER_ADMIN` | в рамках объекта | — | нет | да | нет |
| `workarea.read.all` | `ADMIN`, `SUPER_ADMIN` | все области | — | нет | нет | — |
| `workarea.read.assigned` | `FOREMAN` | области объектов `ForemanAssignment` | — | нет | нет | — |
| `workarea.read.own` | `WORKER` | области активных `SiteAssignment` | — | нет | нет | — |
| `workarea.update` | `ADMIN`, `SUPER_ADMIN` | в рамках объекта | — | нет | да | нет |

**`[2026-08-13] реализовано (T7A.2, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §12.1/§16 "Geofence
admin").`** `attendance.geofence.read`/`.update` — засеяны миграцией
`20260813000000_seed_attendance_geofence_permissions`, только `ADMIN`/`SUPER_ADMIN` (проверено
прямым SQL-запросом на одноразовом PostgreSQL 16 — ровно 4 гранта, `FOREMAN`/`WORKER` не получают
ни то ни другое). Не путать с `gps.read.*` (§2.11) — это про сырые координаты сотрудника при
Check In/Out (нереализовано), геозона объекта — его собственная, фиксированная конфигурация
центра/радиуса.

| `attendance.geofence.read` | `ADMIN`, `SUPER_ADMIN` | геозона любого объекта | `GET /api/admin/sites/:siteId/geofence-versions` — текущая версия + история, latitude/longitude как decimal-строки | нет | нет | — |
| `attendance.geofence.update` | `ADMIN`, `SUPER_ADMIN` | геозона любого объекта | `POST /api/admin/sites/:siteId/geofence-versions` — создаёт новую immutable `WorkSiteGeofenceVersion`, никогда не переписывает старую; обязательный `Idempotency-Key` | нет | да (`SITE_GEOFENCE_VERSION_CREATED`, без координат) | нет |

### 2.4a Онлайн-клок посещаемости (Check In / Check Out / Switch Site) — **`[2026-08-14]
реализовано`** (`T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §9.1-9.3/§12.1-12.2 "Online clock core")

Засеяны миграцией `20260814000000_seed_attendance_clock_worker_permissions`, только `WORKER`
(проверено прямым SQL-запросом на одноразовом PostgreSQL 16 — ровно 4 гранта; `ADMIN`/
`SUPER_ADMIN`/`FOREMAN` не получают ни одного; `SYSTEM` структурно не может иметь ролей).
**`[2026-08-16]`** `materializeClockShiftCore` теперь вызывается инлайн и для offline-checkout
(`attendance.clock.sync.own` ниже), тем же кодом, что online check-out/switch-site — не отдельная
реализация.

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `attendance.clock.read.own` | `WORKER` | собственная открытая смена | `GET /api/worker/attendance/clock-state` — есть ли открытая смена, где; без raw GPS | нет | нет | — |
| `attendance.clock.checkin.own` | `WORKER` | собственная смена | `POST /api/worker/attendance/check-in` — `employeeId` только из сессии; GPS `VERIFIED_OUTSIDE` откатывает запрос целиком (`403 OUTSIDE_GEOFENCE`); повторная открытая смена → новый `ClockEvent(NEEDS_REVIEW)`, `DOUBLE_CHECK_IN`, старая смена не трогается | нет | да (`CLOCK_CHECK_IN`/`CLOCK_CHECK_IN_REJECTED_DOUBLE`, без координат) | нет |
| `attendance.clock.checkout.own` | `WORKER` | собственная смена | `POST /api/worker/attendance/check-out` — никогда не блокируется по GPS/сайту; авторитетные site/workArea/sourceAssignmentId только из `EmployeeOpenShift`, не из тела запроса; хронологическая аномалия — clamp `+1ms`, не откат | нет | да (`CLOCK_CHECK_OUT`/`CLOCK_CHECK_OUT_ORPHAN`, без координат) | нет |
| `attendance.clock.switch_site.own` | `WORKER` | собственная смена | `POST /api/worker/attendance/switch-site` — один HTTP-запрос/одна транзакция; `VERIFIED_OUTSIDE` нового сайта откатывает ОБЕ половины; нет открытой смены → `409 NO_OPEN_SHIFT_TO_SWITCH` | нет | да (общий с check-in/check-out — обе половины) | нет |
| `attendance.clock.sync.own` | `WORKER` | собственные offline-события | **`[2026-08-16] реализовано`** — `POST /api/worker/attendance/sync` — `GET /api/worker/attendance/context` переиспользует `attendance.clock.read.own` вместо нового granta; §9.11 FIFO/`SAVEPOINT`-модель, bounded batch (100), bounded retry на `40P01`/`40001` → `503`; засеяна миграцией `20260815000000_seed_attendance_clock_sync_permission`, только `WORKER` (проверено прямым SQL — ровно 1 грант) | нет | да (общий с check-in/check-out + новые `SWITCH_SITE_GROUP_FAILED`/`SWITCH_SITE_GROUP_INVALID`/`FIFO_LEDGER_INCONSISTENT`, `actorUserId=NULL`, без координат) | нет |

### 2.4b Attendance exception review — read foundation (T7A.8A) — **`[2026-08-14] реализовано`**
(`T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §11/§12.1/§12.3 "Exception review", read-only слайс)

Засеяны миграцией `20260816000000_seed_attendance_exception_read_permissions` (проверено прямым
SQL — ровно 3 гранта: `read.assigned`→`FOREMAN`, `read.all`→`ADMIN`+`SUPER_ADMIN`, `WORKER` не
получает ни одного). Только чтение — `attendance.exception.resolve.{assigned,all}`,
`attendance.gps.read.raw`, `attendance.conflict.read`, `timesheet.draft.edit.exception` этим
слайсом НЕ засеяны (подтверждено тем же прямым SQL-запросом — ноль лишних строк).

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `attendance.exception.read.assigned` | `FOREMAN` | исключения с доказуемой связью хотя бы с одним ТЕКУЩИМ объектом прораба (`ForemanAssignment`, тот же паттерн `validFrom<=today<=validTo\|NULL`, что `timesheet.foreman_review`) | `GET /api/foreman/attendance/exceptions[/:exceptionId]` — scope собирается из ПЯТИ связей (`siteId`, `clockEvent.siteId`, `clockShift.siteId`, `clockShiftFragment.siteId`, `relatedClockShift.siteId`), не только собственного поля исключения (`OVERLAPPING_SHIFT` держит его `NULL`); dual-role `FOREMAN`+`WORKER` не видит собственные исключения (`404`, не `403` — не отличим от «не существует»); чужой `siteId`-фильтр — пустой `200`, не `403`/`404`; чужая половина own↔foreign `OVERLAPPING_SHIFT` редактируется в `null` целиком | нет | нет (read-only) | — |
| `attendance.exception.read.all` | `ADMIN`, `SUPER_ADMIN` | вся компания | `GET /api/admin/attendance/exceptions[/:exceptionId]` — тот же DTO/redaction, без scope-ограничения; `employeeId`-фильтр доступен только здесь | нет | нет (read-only) | — |

### 2.4c Attendance exception resolution (T7A.8B.1 + T7A.8B.2 + T7A.8B.3) — **`[2026-08-15]
реализовано для DISMISS/ACKNOWLEDGE_AS_VALID/PAIR_ORPHAN_EVENTS/CONFIRM_SOURCE_ASSIGNMENT`**
(`T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §8.5/§9.7/§9.8/§11/§12.1/§12.3)

Засеяны миграцией `20260817000000_seed_attendance_exception_base_resolution_permissions`
(проверено прямым SQL — ровно 2 новых гранта: `resolve.assigned`→`FOREMAN`,
`resolve.all`→`ADMIN`+`SUPER_ADMIN`; всего 6 grants по обоим exception-миграциям вместе,
`WORKER`/`SYSTEM` — ни одного). `PAIR_ORPHAN_EVENTS` (T7A.8B.2) и `CONFIRM_SOURCE_ASSIGNMENT`
(T7A.8B.3) переиспользуют те же два granta без новой миграции — **`CONFIRM_SOURCE_ASSIGNMENT`
доступен только через `resolve.all` (только `ADMIN`/`SUPER_ADMIN`)**, `resolve.assigned`
(`FOREMAN`) на это действие не распространяется структурно: foreman-роут отклоняет его `403
FORBIDDEN` на уровне кода, до любой проверки scope, независимо от того, держит ли вызывающий
`resolve.assigned` или нет. Остальные два resolution-действия (`REASON_EDIT`,
`FORCE_CLOSE_OPEN_SHIFT`) НЕ засеяны — `action` с любым из них → `400 VALIDATION_ERROR`, не
временная заглушка.

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `attendance.exception.resolve.assigned` | `FOREMAN` | исключения, чьи ВСЕ доказуемые site-связи — текущие объекты прораба (строже read-scope, где достаточно пересечения); для `PAIR_ORPHAN_EVENTS` — объединение пяти собственных site-связей named exception ∪ `checkInEvent.siteId` ∪ `checkOutEvent.siteId` | `POST /api/foreman/attendance/exceptions/:exceptionId/resolve` — `DISMISS`/`ACKNOWLEDGE_AS_VALID`/`PAIR_ORPHAN_EVENTS` ТОЛЬКО — `CONFIRM_SOURCE_ASSIGNMENT` этой permission НЕ покрывается (структурно `ADMIN`/`SUPER_ADMIN`-only, §12.1); не подразумевает read — оба permission нужны независимо; own↔foreign `OVERLAPPING_SHIFT` видна через `GET`, резолюция → `403 FOREMAN_SCOPE_INCOMPLETE`; для PAIR тот же код, если хотя бы один выбранный event на чужом сайте; scope перепроверяется внутри транзакции по свежим `ForemanAssignment`, не по данным `GET` | нет | да (`ATTENDANCE_EXCEPTION_DISMISSED`/`ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID`/`ATTENDANCE_EXCEPTION_PAIRED`, без `detail`/GPS/device-полей) | нет |
| `attendance.exception.resolve.all` | `ADMIN`, `SUPER_ADMIN` | вся компания | `POST /api/admin/attendance/exceptions/:exceptionId/resolve` — та же матрица §11, без site-ограничения; `CONFIRM_SOURCE_ASSIGNMENT` — только здесь; не подразумевает read | нет | да (то же плюс `CLOCK_SHIFT_ASSIGNMENT_RESOLVED`, без GPS/device-полей/`chosenAssignmentId`-неймспейса за пределами target/assignment id) | нет |

### 2.5 Назначения

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `assignment.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | `ASSIGNMENT_OVERLAP` = дубликат на тот же объект+область; `409 EMPLOYEE_NOT_ACTIVE`, если `Employment.active=false`; апсертит `PayrollPeriodParticipant`+`Timesheet(DRAFT)`+`TimesheetDraft` для каждого пересекающегося `OPEN`-периода | нет | да | нет |
| `assignment.read.all` | `ADMIN`, `SUPER_ADMIN` | все назначения | — | нет | нет | — |
| `assignment.read.assigned` | `FOREMAN` | назначения на своих объектах | — | нет | нет | — |
| `assignment.read.own` | `WORKER` | собственные назначения | может быть несколько активных | нет | нет | — |
| `assignment.update` | `ADMIN`, `SUPER_ADMIN` | вся компания | для начавшегося назначения меняет только `isPrimary`/`endedReason`; `siteId`/`workAreaId`/`templateVersionId` — `400 ASSIGNMENT_ALREADY_STARTED`, используйте `assignment.split` | нет | да | нет |
| `assignment.split` | `ADMIN`, `SUPER_ADMIN` | вся компания | отдельное действие от `assignment.update` — атомарно закрывает текущее назначение и создаёт новое с указанной `effectiveFrom`, одной транзакцией (`03_...`, §4.4) | нет | да (`ASSIGNMENT_SPLIT`) | нет |
| `assignment.end` | `ADMIN`, `SUPER_ADMIN` | вся компания | не удаляет запись | да, если раньше плана | да | нет |
| `foreman_assignment.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | — | нет | да | нет |
| `foreman_assignment.read.all` | `ADMIN`, `SUPER_ADMIN` | все | — | нет | нет | — |
| `foreman_assignment.read.own` | `FOREMAN` | собственные | — | нет | нет | — |
| `foreman_assignment.end` | `ADMIN`, `SUPER_ADMIN` | вся компания | — | нет | да | нет |

### 2.6 Рабочие шаблоны

`template.read.all` и `template.update` засеяны и реализованы: `GET /api/admin/templates` (список,
текущая версия каждого шаблона) + `GET /api/admin/templates/:templateId` (карточка, только текущая
версия) + `PATCH /api/admin/templates/:templateId` (создаёт новую immutable версию — `SELECT ...
FOR UPDATE` на родительской строке `WorkScheduleTemplate` серилизует конкурентные `PATCH`, сравнение
`expectedVersionNumber` происходит уже под локом) + `/admin/templates`/`/admin/templates/[templateId]`
(список + карточка с секцией «Edit schedule»). Snapshot semantics (§4.5): новая версия применяется
только к новым `SiteAssignment`; уже существующие продолжают ссылаться на прежний
`templateVersionId`; перевод уже начавшегося назначения на новую версию — исключительно через
`assignment.split`, не массовым обновлением. Поле `active` в этом срезе read-only (deactivate/
reactivate шаблона — нет утверждённого контракта).

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `template.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | создаёт `WorkScheduleTemplate`+первую версию | нет | да | нет |
| `template.read.all` | `ADMIN`, `SUPER_ADMIN` | все шаблоны, все версии | — | нет | нет | — |
| `template.read.assigned` | `FOREMAN` | шаблоны назначений на своих объектах (текущая версия) | — | нет | нет | — |
| `template.read.own` | `WORKER` | шаблон собственного назначения (текущая версия) | — | нет | нет | — |
| `template.update` | `ADMIN`, `SUPER_ADMIN` | вся компания | создаёт новую immutable версию | нет | да | нет |

### 2.7 Расчётные периоды

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `period.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | создаёт `PayrollPeriodParticipant`+`Timesheet(DRAFT)`+`TimesheetDraft` (предзаполненный из шаблона) тройкой | нет | да | нет |
| `period.read.all` | `ADMIN`, `SUPER_ADMIN` | все периоды | — | нет | нет | — |
| `period.read.assigned` | `FOREMAN` | периоды с табелями на его объектах | — | нет | нет | — |
| `period.read.own` | `WORKER` | все actionable периоды работника (`03_...`, §8), не только календарно текущий | — | нет | нет | — |
| `period.participant.exclude` | `ADMIN`, `SUPER_ADMIN` | вся компания | `409 HAS_PAYROLL_DATA`, если у участника есть хотя бы одно из: `TimesheetDraftSegment`, explicit payroll-relevant `TimesheetDraftDay.dayType`, `TimesheetDraftDay.confirmedZero=true`, **любая существующая `TimesheetVersion` для этого табеля — безусловно, даже полностью пустая `EMPTY_FALLBACK`-версия**, `Absence(PENDING\|APPROVED)` в датах периода. `CorrectionDraft`/`CorrectionRequest` **не проверяются отдельным условием** — логически избыточно: `correction.request` возможен только для табеля, уже прошедшего `FINAL_APPROVED`, поэтому существование `CorrectionDraft.basedOnVersionId` уже доказывает наличие `TimesheetVersion` и блокирует через это условие (v5.2 содержал логически противоречивое условие `MATERIAL_CORRECTION_DATA`, снятое в v5.3). **Автоматически предзаполненная пустая строка (`dayType=WORK`, `confirmedZero=false`, без сегментов) не блокирует** — см. `03_...`, §4.5 | да | да | нет |
| `period.lock` | `ADMIN`, `SUPER_ADMIN` | вся компания | без override; требует `FINAL_APPROVED` у каждого `expected=true` участника | нет | да | нет |
| `period.export` | `ADMIN`, `SUPER_ADMIN` | вся компания | только `LOCKED`/`EXPORTED`; повторный вызов для уже `EXPORTED` периода с накопленными `CorrectionRequest(pendingExport=true)` создаёт корректирующий `ExportBatch` | нет | да | нет |

### 2.8 Табели

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `timesheet.read.own` | `WORKER` | собственные табели; в статусах `SUBMITTED`/`FOREMAN_APPROVED` — через `current-version`, не draft | read-only; не даёт права мутировать draft — см. `timesheet.draft.edit.own` | нет | нет | — |
| `timesheet.draft.edit.own` | `WORKER` | собственный `TimesheetDraft` | отдельный от `timesheet.read.own` permission — `PATCH .../days/:date` требует именно его, не read-permission (в v5.2 мутация ошибочно висела на read-permission); прямая установка персонального non-WORK `dayType` без соответствующей `APPROVED Absence` → `403 DAY_TYPE_REQUIRES_ABSENCE` (`03_...`, §4.2, «Единый контракт»); `segments`, если передано, — полный итоговый набор сегментов дня по всем объектам (не дельта одного `siteId`) — объект, отсутствующий в переданном массиве, считается удалённым; `affectedSitePairs` вычисляется diff'ом старого/нового полного состояния по каждому `siteId` — правка `siteId=A` с передачей неизменённых сегментов B не резолвит `OPEN`-предложение `siteId=B` той же даты, правка `note`/non-site состояния без поля `segments` не резолвит ни одно `SITE`-предложение (`03_...`, §4.6) | нет | да | нет |
| `timesheet.read.assigned` | `FOREMAN` | табели работников на своих объектах, только `SITE`-scope своего `siteId` | никогда `NON_SITE` | нет | нет | — |
| `timesheet.read.all` | `ADMIN`, `SUPER_ADMIN` | все табели, все scope включая `NON_SITE` (обеих разновидностей) | — | нет | нет | — |
| `timesheet.submit` | `WORKER` | собственный `TimesheetDraft` конкретного `timesheetId` | `409 UNRESOLVED_PROPOSALS`, если есть предложение всё ещё `OPEN` (ни разу не тронутое ни ручной правкой, ни `accept_proposal`); создаёт `TimesheetVersion`; `TimesheetReviewScope` — по алгоритму трёх случаев `03_...`, §4.6; финально резолвит все затронутые предложения (`status != OPEN`) в `RESOLVED` в этой же транзакции | нет | да | нет |
| `timesheet.accept_proposal` | `WORKER` | собственный `TimesheetReviewProposal` | precondition: `status IN (OPEN, ACCEPTED, REPLACED)`, `resolvedInVersionId IS NULL`, `scope.timesheetVersionId = Timesheet.currentVersionId`, `Timesheet.status = RETURNED`, `TimesheetDraft.basedOnVersionId = scope.timesheetVersionId` (`03_...`, §4.6); применяет `proposedSegments` **одной транзакцией**, повторно проверяя те же правила, что обычный `PATCH`: overlap с сегментами других `siteId` того же draft/дня, `409 DAY_TYPE_CONFLICT`, `409 DAY_STATE_CONFLICT`, `404 SITE_NOT_ASSIGNED`, `409 WORK_AREA_SITE_MISMATCH`, обязательный `endAt`, break-инварианты — при любой из этих ошибок старые сегменты остаются без изменений, `status` предложения **не меняется** (не откатывается частично); только к сегментам `siteId` scope в draft, не весь день; не сабмитит; `409 STALE_PROPOSAL`/`409 PROPOSAL_ALREADY_RESOLVED` при нарушении precondition выше. **Не единственный способ разрешить `OPEN`-предложение** — обычная ручная правка того же дня через `timesheet.draft.edit.own` выводит его из `OPEN` так же (только для затронутого `siteId`, см. `timesheet.draft.edit.own` ниже), но **только** если это реальная пользовательская мутация (не системная реинициализация draft, `03_...`, §4.6) |
| `timesheet.reject_proposal` | `WORKER` | собственный `TimesheetReviewProposal` | тот же precondition-набор, что `timesheet.accept_proposal`; явное «оставить мои данные без изменений» — **не трогает** `TimesheetDraftSegment`/`Day`, только переводит `status → REPLACED` и `lastEvaluatedAt = now()` для этого одного предложения; отдельная permission-строка от `accept_proposal`, чтобы явно разграничить «применить предложение» и «отклонить, ничего не меняя» — не полагается на произвольный no-op `PATCH` (`03_...`, §4.6) | нет | да | нет |
| `timesheet.foreman_review` | `FOREMAN` | `TimesheetReviewScope(scopeType=SITE)` своих объектов | approve: precondition `scope.status=PENDING`+`scope.timesheetVersionId=currentVersionId`+**`Timesheet.status=SUBMITTED`**+`SELF_APPROVAL_FORBIDDEN`; return: то же, но `Timesheet.status IN (SUBMITTED, RETURNED)` — допускает второй почти одновременный возврат другого scope (`03_...`, §4.7) | нет | да | — |
| `timesheet.scope_review.all` | `ADMIN`, `SUPER_ADMIN` | любой `TimesheetReviewScope`, включая `NON_SITE(DATA)` и `NON_SITE(EMPTY_FALLBACK)` | fallback для единственного прораба-работника и единственный путь проверки `NON_SITE`; те же раздельные approve/return precondition, что `timesheet.foreman_review` | нет | да | — |
| `timesheet.return` | `FOREMAN` (свой `SITE`-scope, precondition как в `timesheet.foreman_review`), `ADMIN`/`SUPER_ADMIN` (свой scope через `.all`, либо весь табель — override, требует `Timesheet.status=FOREMAN_APPROVED`) | — | scope-уровневый возврат не трогает другие scope; admin override на весь табель переводит все scope версии в `RETURNED`; `returnReason` обязателен всегда; предложения (`proposals[]`) опциональны и, если заданы, каждое имеет обязательный структурированный `proposedSegments` | да | да | нет |
| `timesheet.final_approve` | `ADMIN`, `SUPER_ADMIN` | вся компания | чистый переход `FOREMAN_APPROVED → FINAL_APPROVED`, не меняет данные | нет | да | да |
| `timesheet.bulk_approve` | `FOREMAN` | свои объекты, только `SITE`-scope | precondition — тот же approve-набор, что `timesheet.foreman_review` (включая `Timesheet.status=SUBMITTED` на каждый выбранный табель); без `hasException`; собственные scope прораба исключены | нет | да | да |

### 2.9 Корректировки

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `correction.request` | `WORKER` (свои), `FOREMAN` (свои объекты), `ADMIN`/`SUPER_ADMIN` (все) | — | создаёт `CorrectionRequest(PENDING)` | да | да | нет |
| `correction.draft.edit` | `ADMIN`, `SUPER_ADMIN` | вся компания | открывает/редактирует `CorrectionDraft`, включая перерывы; открытие фиксирует `basedOnVersionId` = текущая `FINAL_APPROVED`-версия; та же таблица допустимых состояний дня (`dayType`×`confirmedZero`×сегменты), что у обычного draft — `409 DAY_TYPE_CONFLICT`/`409 DAY_STATE_CONFLICT`; submit черновика без материальных изменений (`canonicalCorrectionProjection(draft) == canonicalCorrectionProjection(basedOnVersionId)`) → `409 NO_CORRECTION_CHANGES` (`03_...`, §4.6/§4.7) | нет | да | нет |
| `correction.approve` | `ADMIN`, `SUPER_ADMIN` | вся компания | требует `decidedByUserId != CorrectionDraft.openedByUserId`, кроме `approvalOverride=true` (только `SUPER_ADMIN`) | да (для override) | да | нет |

### 2.10 Экспорт и аудит

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `export.create` | `ADMIN`, `SUPER_ADMIN` | вся компания | только для `LOCKED`/`EXPORTED` периодов; для `EXPORTED` создаёт корректирующий `ExportBatch(correctsBatchId=...)`, покрывающий накопленные `pendingExport=true` | нет | да (`EXPORT_CREATED`) | нет |
| `export.read` | `ADMIN`, `SUPER_ADMIN` | вся компания | доступ к `ExportBatch`/`ExportItem` | нет | нет | — |
| `audit.read` | `ADMIN`, `SUPER_ADMIN` | вся компания | `AuditEvent` — append-only, недоступен для записи через API вовсе | нет | нет (само чтение аудита не аудируется) | — |

### 2.11 GPS (зарезервировано, не реализуется в первом срезе)

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `gps.read.assigned` | `FOREMAN` | работники на своих объектах | недоступно, пока не реализован GPS-модуль | нет | да | — |
| `gps.read.all` | `ADMIN`, `SUPER_ADMIN` | вся компания | то же | нет | да | — |

### 2.12 Системные пользователи и роли

`GET`/`POST /api/admin/users` и credential-flow standalone `FOREMAN` (выпуск кода, публичная проверка,
установка первого пароля) реализованы (backend, без UI) — `04_ADMIN_FIRST_API_CONTRACTS.md` содержит
точный контракт.

| Permission | Держатели | Область | Ограничения | Причина | Аудит | Массовое |
|---|---|---|---|---|---|---|
| `user.create.foreman` | `ADMIN`, `SUPER_ADMIN` | вся компания | режим `STANDALONE` — создаёт новый `User(PENDING_ACTIVATION)` с активной ролью `FOREMAN`, без `Employee`; режим `EXISTING_EMPLOYEE` — добавляет активную роль `FOREMAN` уже существующему `User` привязанного `Employee` (дуал-роль `FOREMAN`+`WORKER`), второй `User` не создаётся | нет | да — `USER_CREATED` (`STANDALONE`) / `FOREMAN_ROLE_GRANTED` (`EXISTING_EMPLOYEE`) | нет |
| `user.activation.generate` | `ADMIN`, `SUPER_ADMIN` | вся компания | выпускает/reissue одноразовый код `UserActivationToken` только для standalone `FOREMAN` (`employeeId IS NULL`, `status=PENDING_ACTIVATION`, `passwordHash IS NULL`, есть текущая активная роль `FOREMAN`); reissue отзывает предыдущий `PENDING` в той же транзакции; не выдаёт код worker-пользователю (`employeeId` не `NULL` → `USER_USES_WORKER_ACTIVATION`) | нет | да (`USER_ACTIVATION_TOKEN_ISSUED`, `afterValue` — только `expiresAt`) | нет |
| `user.create.admin` | `SUPER_ADMIN` | вся компания | создаёт `User(role=ADMIN\|SUPER_ADMIN)` — недоступно `ADMIN` | нет | да (`USER_CREATED`) | нет |
| `user.read` | `ADMIN`, `SUPER_ADMIN` | все системные пользователи | — | нет | нет | — |
| `user.deactivate` | `SUPER_ADMIN` (для `ADMIN`/`SUPER_ADMIN`), `ADMIN`+`SUPER_ADMIN` (для `FOREMAN`) | — | не удаляет историю решений | да | да (`USER_DEACTIVATED`) | нет |
| `role.assign` | `SUPER_ADMIN` | вся компания | единственный способ повысить/добавить роль; `ADMIN` не может назначить себе/другому `ADMIN`/`SUPER_ADMIN`; требует свежий MFA | да | да (`ROLE_ASSIGNED`) | нет |

## 3. Сквозные правила (обязательные инварианты)

| Правило | Как обеспечивается |
|---|---|
| Прораб видит только свои объекты/работников, никогда `NON_SITE` | Фильтр по `ForemanAssignment`; `NON_SITE` доступен только через `timesheet.scope_review.all` |
| Работник видит только свои данные | `.own`-scoped permission, фильтр по `employeeId` из сессии |
| Запрет самоподтверждения — везде, включая admin fallback и `NON_SITE` | `reviewer.employeeId != Timesheet.employeeId` |
| Табели версионируются, не редактируются на месте | `TimesheetVersion` immutable; редактирование — только в `TimesheetDraft` до отправки |
| Финальное утверждение не меняет данные | `timesheet.final_approve` — чистый переход статуса |
| Ревью-действие не может быть выполнено по устаревшей версии | `STALE_REVIEW_SCOPE`, `03_...`, §4.7 |
| Scope нельзя подтвердить после того, как draft уже переоткрыт для правки другим возвратом | `approve` требует `Timesheet.status=SUBMITTED` строго; `return` допускает `SUBMITTED\|RETURNED`, `03_...`, §4.7 |
| Отправка не проходит с необработанными предложениями | `409 UNRESOLVED_PROPOSALS` — только для предложений, ни разу не тронутых с момента возврата, `03_...`, §4.6 |
| Каждое предложение всегда структурировано | `proposedSegments` NOT NULL, пустой массив = «удалить часы»; нет minutes-only варианта |
| `OPEN`-предложение разрешается только решением работника, не системным копированием, и только для затронутого `siteId` | Пересчёт запускается только пользовательской мутацией (`PATCH` — ограничен `affectedSitePairs`, `accept_proposal`, `reject_proposal`) с `contentRevision > createdAtDraftRevision`; реинициализация draft revision не двигает, `03_...`, §4.6 |
| «Оставить без изменений» — явное действие, не произвольный no-op `PATCH` | `timesheet.reject_proposal` переводит `status → REPLACED` без мутации draft, `03_...`, §4.6 |
| Завершённое предложение (`RESOLVED`) больше никогда не применяется | CHECK-constraint + `BEFORE UPDATE` триггер `trg_proposal_resolved_immutable`, не только текстовое описание, `03_...`, §4.6 |
| Предложение и его scope/день физически не могут относиться к разным версиям табеля | Composite FK на денормализованный `timesheetVersionId`, `03_...`, §1/§4.6 |
| `resolvedInVersionId` физически не может указывать на версию чужого табеля | Composite FK `(resolvedInVersionId, timesheetId) REFERENCES TimesheetVersion(id, timesheetId)`, `03_...`, §4.6 |
| Факт сопоставляется с планом по назначению (`sourceAssignmentId`), не только по объекту | Denormalized `employeeId` на `WorkSegment`/`TimesheetPlannedShift` делает composite FK реально исполнимым (не join), `03_...`, §4.6 |
| Нельзя вставить строку версии работника A с `employeeId`/`sourceAssignmentId` работника B, даже если `siteId` совпадает | Цепочка composite FK `Timesheet.employeeId → TimesheetVersion.employeeId → WorkSegment.employeeId → SiteAssignment.employeeId`, `03_...`, §4.6 |
| Дата сегмента, родительский день и плановый снимок физически согласованы, не «проверка сервисом, если существует» | Composite FK на денормализованную `date` + `trg_planned_shift_validity_check`, `03_...`, §4.6 |
| Конкурентные `INSERT` сегмента и `UPDATE confirmedZero=true` не могут обе закоммититься | Единый порядок блокировок — обе стороны берут `FOR UPDATE`/неявную блокировку строки дня первым действием, `03_...`, §4.6 |
| `confirmedZero` и введённые часы — взаимоисключающие состояния дня, на draft **и** correction | `409 DAY_STATE_CONFLICT` на `TimesheetDraftDay`/`TimesheetDay`/`CorrectionDraftDay`, `03_...`, §4.6 |
| `Absence` реально влияет на табель, а не только объявлена; единственный путь к персональному non-WORK дню | `WORKER` не может напрямую `PATCH dayType`; overlay-транзакция всегда `200 OK`, никогда committed-then-409, `03_...`, §4.2 |
| Корректировка без материальных изменений не отправляется | `409 NO_CORRECTION_CHANGES`, `canonicalCorrectionProjection()` — отдельная от `contentHash` scope функция, `03_...`, §4.5/§4.7 |
| `CorrectionDraft` не создаёт отдельное основание для блокировки исключения из периода | Логически избыточно — `basedOnVersionId` уже доказывает существующую `TimesheetVersion` (`SUBMITTED_VERSION`), `03_...`, §4.5 |
| Мутация draft, меняющая payroll-данные, требует write-permission, не read | `PATCH .../days/:date` → `timesheet.draft.edit.own`, отдельно от `timesheet.read.own` |
| Увольнение не блокирует завершение уже начатых табелей | `worker.deactivate → OFFBOARDING` |
| Единственный прораб объекта не блокирует проверку своих часов навсегда | `timesheet.scope_review.all` |
| Массовое подтверждение — только для стандартных `SITE`-scope | `timesheet.bulk_approve` исключает `RETURNED`/`hasException`/собственные/`NON_SITE` |
| Подтверждение объекта A переживает возврат объекта B и не путается с отсутствиями или пустыми днями | `SITE`/`NON_SITE(DATA)`/`NON_SITE(EMPTY_FALLBACK)` разделение по построению хеша, `03_...`, §4.6 |
| Два объекта в один день — разрешено, пересечение времени — нет | Конфликт проверяется на `TimesheetDraftSegment`, scoped по `draftId` |
| Работа и отсутствие не смешиваются в один день | `409 DAY_TYPE_CONFLICT`, `03_...`, §4.6 |
| `period.lock` без скрытых исключений | Требует `FINAL_APPROVED` у каждого `expected=true` участника |
| Работник не теряет доступ к ещё не заблокированному прошедшему периоду | «Actionable periods», каждый со своим `timesheetId` |
| Реально введённые (не автосгенерированные пустые) часы блокируют исключение из периода | Точный критерий `HAS_PAYROLL_DATA`, `03_...`, §4.5 |
| Ни один рабочий интервал не может остаться без конца | `endAt NOT NULL` везде в v1, `03_...`, §1 |

## 4. Таблица доступа: routes

| Route | `SUPER_ADMIN` | `ADMIN` | `FOREMAN` | `WORKER` | Неаутентифицированный |
|---|---|---|---|---|---|
| `/login` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/activate/[token]`, `/set-password` | — | — | — | — | ✓ (валидный токен) |
| `/reset-password/*` | ✓/— | ✓/— | ✓/— | ✓/— | ✓ |
| `/profile`, `/sessions` | ✓ | ✓ | ✓ | ✓ | — |
| `/403`, `/404`, `/500`, `/offline` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/admin/*` | ✓ | ✓* (без создания `ADMIN`/`SUPER_ADMIN`, без `role.assign`, без `approvalOverride`) | — | — | — |
| `/admin/review-fallback*` | ✓ | ✓ | — | — | — |
| `/worker/periods/[periodId]*` | ✓* (активная `WORKER`+`employeeId`) | ✓* (то же) | ✓* (то же — дуал-роль) | ✓ | — |
| `/foreman*` | — | — | ✓ | — | — |

`/worker/*` — единое правило: активная роль `WORKER` **и** `User.employeeId`. Пользователь в
`User.status=OFFBOARDING` сохраняет доступ, но ограниченно (`03_...`, §4.2).

## 5. Таблица доступа: API endpoints первого среза

| Endpoint | Метод | Требуемый permission |
|---|---|---|
| `/api/auth/login` | POST | публичный |
| `/api/auth/logout` | POST | `session.revoke.own` |
| `/api/auth/logout-all` | POST | `session.revoke_all.own` |
| `/api/auth/session` | GET | аутентифицирован |
| `/api/auth/activate` | GET | публичный + токен |
| `/api/auth/set-initial-password` | POST | публичный + токен |
| `/api/admin/cities` | GET/POST | `city.read.all` / `city.create` |
| `/api/admin/sites` | GET/POST | `site.read.all` / `site.create` |
| `/api/admin/sites/:siteId` | GET/PATCH | `site.read.all` / `site.update` |
| `/api/admin/sites/:siteId/work-areas` | GET/POST | `workarea.read.all` / `workarea.create` |
| `/api/admin/sites/:siteId/work-areas/:workAreaId` | PATCH | `workarea.update` |
| `/api/admin/sites/:siteId/geofence-versions` | GET/POST | `attendance.geofence.read` / `attendance.geofence.update` |
| `/api/admin/templates` | GET/POST | `template.read.all` / `template.create` |
| `/api/admin/templates/:templateId` | GET/PATCH | `template.read.all` / `template.update` |
| `/api/admin/setup-status` | GET | `worker.read.all` |
| `/api/admin/workers` | GET/POST | `worker.read.all` / `worker.create` |
| `/api/admin/workers/:employeeId` | GET/PATCH | `worker.read.all` / `worker.update` |
| `/api/admin/workers/:employeeId/deactivate` | POST | `worker.deactivate` |
| `/api/admin/workers/:employeeId/activation` | POST | `worker.activation.generate` |
| `/api/admin/workers/:employeeId/setup-preview` | GET | `worker.read.all` |
| `/api/admin/assignments` | GET/POST | `assignment.read.all` / `assignment.create` |
| `/api/admin/assignments/:assignmentId` | PATCH | `assignment.update` |
| `/api/admin/assignments/:assignmentId/split` | POST | `assignment.split` |
| `/api/admin/assignments/:assignmentId/promote` | POST | `assignment.update` |
| `/api/admin/assignments/:assignmentId/end` | POST | `assignment.end` |
| `/api/admin/assignments/validate-overlap` | POST | `assignment.create` |
| `/api/admin/periods` | GET/POST | `period.read.all` / `period.create` |
| `/api/admin/periods/current` | GET | `period.read.all` |
| `/api/admin/periods/:periodId` | GET | `period.read.all` |
| `/api/admin/periods/:periodId/participants/:employeeId/exclude` | POST | `period.participant.exclude` |
| `/api/admin/review-scopes` | GET | `timesheet.scope_review.all` |
| `/api/admin/review-scopes/:reviewScopeId` | GET | `timesheet.scope_review.all` |
| `/api/admin/review-scopes/:reviewScopeId/approve` | POST | `timesheet.scope_review.all` |
| `/api/admin/review-scopes/:reviewScopeId/return` | POST | `timesheet.scope_review.all` |
| `/api/worker/context` | GET | `worker.read.own` |
| `/api/worker/periods/actionable` | GET | `period.read.own` |
| `/api/worker/periods/current` | GET | `period.read.own` |
| `/api/worker/assignments/current` | GET | `assignment.read.own` |
| `/api/worker/timesheets/:timesheetId` | GET | `timesheet.read.own` |
| `/api/worker/timesheets/:timesheetId/draft` | GET | `timesheet.read.own` |
| `/api/worker/timesheets/:timesheetId/current-version` | GET | `timesheet.read.own` |
| `/api/worker/timesheets/:timesheetId/days/:date` | PATCH | `timesheet.draft.edit.own` |
| `/api/worker/timesheets/:timesheetId/submit` | POST | `timesheet.submit` |
| `/api/worker/review-proposals/:proposalId/accept` | POST | `timesheet.accept_proposal` |
| `/api/worker/review-proposals/:proposalId/reject` | POST | `timesheet.reject_proposal` |
| `/api/worker/attendance/clock-state` | GET | `attendance.clock.read.own` — **`[2026-08-14] реализовано`** |
| `/api/worker/attendance/check-in` | POST | `attendance.clock.checkin.own` — **`[2026-08-14] реализовано`** |
| `/api/worker/attendance/check-out` | POST | `attendance.clock.checkout.own` — **`[2026-08-14] реализовано`** |
| `/api/worker/attendance/switch-site` | POST | `attendance.clock.switch_site.own` — **`[2026-08-14] реализовано`** |
| `/api/worker/attendance/context` | GET | `attendance.clock.read.own` (переиспользован) — **`[2026-08-16] реализовано`** |
| `/api/worker/attendance/sync` | POST | `attendance.clock.sync.own` — **`[2026-08-16] реализовано`** |
| `/api/admin/attendance/exceptions` | GET | `attendance.exception.read.all` — **`[2026-08-14] реализовано`** |
| `/api/admin/attendance/exceptions/:exceptionId` | GET | `attendance.exception.read.all` — **`[2026-08-14] реализовано`** |
| `/api/foreman/attendance/exceptions` | GET | `attendance.exception.read.assigned` — **`[2026-08-14] реализовано`** |
| `/api/foreman/attendance/exceptions/:exceptionId` | GET | `attendance.exception.read.assigned` — **`[2026-08-14] реализовано`** |
| `/api/admin/attendance/exceptions/:exceptionId/resolve` | POST | `attendance.exception.read.all` + `attendance.exception.resolve.all` — **`[2026-08-15] реализовано (DISMISS/ACKNOWLEDGE_AS_VALID/PAIR_ORPHAN_EVENTS/CONFIRM_SOURCE_ASSIGNMENT)`** |
| `/api/foreman/attendance/exceptions/:exceptionId/resolve` | POST | `attendance.exception.read.assigned` + `attendance.exception.resolve.assigned` — **`[2026-08-15] реализовано (DISMISS/ACKNOWLEDGE_AS_VALID/PAIR_ORPHAN_EVENTS только — CONFIRM_SOURCE_ASSIGNMENT структурно недоступен, 403 FORBIDDEN)`** |

Эндпоинты домена `absence.*` (§2.3) **не входят в первый вертикальный срез** — permission-контракт
определён полностью, но route/API contracts для создания/одобрения отсутствий спроектированы позже
(`04_...`, §12, открытый вопрос). Это не блокирует overlay-механизм (`03_...`, §4.2): для первого
среза `Absence` может создаваться напрямую через сервисный слой/будущий административный экран, а не
через публичный API.

## 6. Открытые вопросы

- Финальный список действий, требующих свежий MFA.
- Делегирование `correction.draft.edit` за пределы `ADMIN`/`SUPER_ADMIN`.
- Нужен ли отдельный `timesheet.propose` permission, если предложение когда-нибудь станет возможным
  без формального возврата.
