# Titanor Time — комплект технических документов

Статус: **проектирование, без кода**. Ничего не реализовано — ни база, ни API, ни экраны. Не начата
Prisma-схема.

## 1. Зачем этот комплект

Titanor Time — отдельное внутреннее приложение учёта рабочего времени для Titanor Group
(`app.titanorgroup.fi`), физически отдельный контейнер и база на том же VPS, где уже работает
публичный сайт `titanorgroup.fi` и посторонний проект CollabStudio (`collab-studio-app-1`/
`collab-studio-postgres-1`). Ничего из этого комплекта не меняет production, VPS, DNS, Caddy или
публичный сайт — это проектная документация.

## 2. Документы и их источник истины

| Документ | Источник истины для |
|---|---|
| [`01_SCREEN_MAP.md`](./01_SCREEN_MAP.md) | route-имён, экранных состояний, навигации |
| [`02_ROLE_PERMISSION_MATRIX.md`](./02_ROLE_PERMISSION_MATRIX.md) | имён ролей, permission-строк, доступа к route/endpoint |
| [`03_DATA_MODEL_ERD.md`](./03_DATA_MODEL_ERD.md) | имён сущностей, полей, статусов, ограничений БД |
| [`04_ADMIN_FIRST_API_CONTRACTS.md`](./04_ADMIN_FIRST_API_CONTRACTS.md) | HTTP-контрактов первого вертикального сценария + рабочего кабинета + admin fallback |
| [`TITANOR_TIME_DEVELOPMENT_ROADMAP.md`](./TITANOR_TIME_DEVELOPMENT_ROADMAP.md) | исходного ТЗ |
| [`T7A_1_ATTENDANCE_CLOCK_DESIGN.md`](./T7A_1_ATTENDANCE_CLOCK_DESIGN.md) | ЭТАП 7A Attendance Clock: геозоны, clock-события, open shift, offline outbox/sync, materialization, exception-модель — **утверждён владельцем 2026-08-12** (revision 3.2.5) |

Все пять документов выше, включая этот README — **версия 5.4.1** (2026-07-23), каждый самодостаточен:
для понимания текущего состояния не требуется открывать более ранние версии.
`T7A_1_ATTENDANCE_CLOCK_DESIGN.md` — отдельный документ вне версионирования 5.4.1, со своим
собственным revision-циклом (3 → 3.2.5) и собственным статусом утверждения; описывает будущее
расширение схемы, ещё не реализованное ни в Prisma, ни в production.

## 3. Принятые архитектурные решения

- **Стек**: Next.js App Router + TypeScript + PostgreSQL 16 + Prisma, отдельный контейнер/volume,
  `127.0.0.1:3200`. Публичный сайт (`titanorgroup-web-1`) сейчас работает без ORM/БД (JSON-файлы) —
  это решение только для Titanor Time, никак не меняет существующий сайт.
- **Роли**: `SUPER_ADMIN`, `ADMIN`, `FOREMAN`, `WORKER`; несколько ролей одновременно активны на
  одном `User` (прораб, ведущий собственные часы, — обычный случай).
- **Сессии**: server-side, opaque token + `SHA-256`-hash в БД, сам токен только в cookie.
- **Редактирование до отправки — только через `TimesheetDraft`** (единственная mutable область).
  При `submit` содержимое draft замораживается в `TimesheetVersion` и **удаляется** из
  draft-таблиц; при `SUBMITTED`/`FOREMAN_APPROVED` чтение идёт через отдельный read-only
  `GET /api/worker/timesheets/:timesheetId/current-version`, не через draft-эндпоинт. При
  `RETURNED` draft идемпотентно переинициализируется копией текущей версии — **это системное
  действие, не решение работника**.
- **Цепочка `employeeId`-владения — реальные composite FK от корня, не денормализованные копии
  «на честном слове».** `Timesheet.employeeId` (корень) → `TimesheetVersion.employeeId` (FK
  `(timesheetId, employeeId) REFERENCES Timesheet(id, employeeId)`) → `WorkSegment.employeeId`/
  `TimesheetPlannedShift.employeeId` (FK `(timesheetVersionId, employeeId) REFERENCES
  TimesheetVersion(id, employeeId)`) → `sourceAssignmentId` обязан принадлежать тому же `employeeId`
  (FK на `SiteAssignment`). Физически невозможно вставить строку версии работника A с
  `employeeId`/`sourceAssignmentId` работника B, даже если `siteId` совпадает.
- **`TimesheetDraft.contentRevision` отличает пользовательскую мутацию от системной.**
  Увеличивается только явной правкой (`PATCH .../days/:date`, `accept_proposal`); идемпотентная
  реинициализация draft при возврате его не трогает. `TimesheetReviewProposal.
  createdAtDraftRevision` — снимок на момент создания предложения, используется, чтобы отличить
  «работник что-то поменял» от «система скопировала версию обратно».
- **`OPEN`-предложение может покинуть `OPEN` только по решению работника — и только для
  затронутого `siteId`.** Три равнозначных действия: `accept_proposal`, новое явное
  `reject_proposal` (см. ниже), либо ручная правка, увеличивающая `contentRevision`. Системная
  реинициализация draft никогда не запускает пересчёт. `PATCH .../days/:date` вычисляет
  `affectedSitePairs` запроса — правка объекта A не резолвит `OPEN`-предложение объекта B той же
  даты; правка `note`/non-site состояния не резолвит ни одно `SITE`-предложение.
- **`segments` в `PATCH .../days/:date` — полная замена дня по всем объектам, не дельта одного
  `siteId`.** Если поле передано, оно обязано перечислять все сегменты дня, которые должны
  существовать после запроса; объект, отсутствующий в массиве, считается удалённым. Отсутствие поля
  `segments` в теле не трогает существующие сегменты вовсе. `affectedSitePairs` — diff полного
  старого/нового состояния по `siteId`, включая случай «объект был, теперь отсутствует» как отличие.
  Одна семантика, не смешивается с частичным per-`siteId` `PATCH`.
- **`timesheet.reject_proposal` — явное «оставить мои данные без изменений».** Отдельное действие
  от `accept_proposal`, не полагается на произвольный no-op `PATCH`: не мутирует draft вовсе, только
  переводит `status → REPLACED` для конкретного предложения.
- **Пересечение рабочего времени проверяется только на `TimesheetDraftSegment`/
  `CorrectionDraftSegment`**, `EXCLUDE`-constraint scoped по `draftId` (не только `employeeId`) —
  несколько параллельных черновиков одного работника (несколько actionable периодов,
  `CorrectionDraft`) не конфликтуют друг с другом.
- **Открытых интервалов нет.** `endAt` — обязательное поле на каждой таблице сегментов/перерывов
  (`WorkSegment`, `TimesheetDraftSegment`, `CorrectionDraftSegment`, `BreakSegment` и их
  черновые аналоги), `CHECK endAt > startAt` безусловный.
- **Один тип дня — либо работа, либо отсутствие, не оба; `confirmedZero` и сегменты —
  взаимоисключающи — на draft, immutable-табеле и корректировке одинаково, и concurrency-safe.**
  `dayType=WORK` — единственный тип, допускающий сегменты (`409 DAY_TYPE_CONFLICT`);
  `confirmedZero=true` допустим только при `dayType=WORK` и только без сегментов (`409
  DAY_STATE_CONFLICT`). Оба нарушения обеспечены триггерами, которые **всегда** сначала берут
  эксклюзивную блокировку строки дня (`SELECT ... FOR UPDATE` со стороны вставки сегмента, неявная
  блокировка `UPDATE` со стороны правки дня) — конкурентные `INSERT` сегмента и `UPDATE
  confirmedZero=true` физически не могут оба закоммититься, независимо от порядка запуска.
- **Дата сегмента, родительский день и плановый снимок связаны настоящими composite FK, не
  «сервис проверяет, если существует».** Денормализованная `date` на
  `WorkSegment`/`TimesheetDraftSegment`/`CorrectionDraftSegment` (`CHECK` против собственного
  `startAt`) плюс FK на родительский день и на соответствующий плановый снимок
  (`TimesheetPlannedShift`/`TimesheetDraftPlannedShift`) — снимок гарантированно существует, потому
  что генерируется на каждую дату пересечения периода и действующего назначения; отдельный триггер
  `trg_planned_shift_validity_check` не даёт плановому снимку выйти за `validFrom..validTo`
  назначения.
- **Плановый график — снимок-сущность на каждую дату назначения.** `SITE`-`contentHash` перечисляет
  плановые снимки **по каждой дате** назначения (`plannedShifts[]`, пересечение `PayrollPeriod` и
  `SiteAssignment.validity`), не один снимок на всё назначение. `templateVersionId` зафиксирован на
  `SiteAssignment` и не меняется задним числом уже начавшегося назначения — только
  `assignment.split` создаёт новый `sourceAssignmentId` с новым планом.
- **`IdempotencyKey` — уникальность без path-параметров**, `requestHash` их учитывает: повтор ключа
  для другой цели — явная ошибка клиента (`409 IDEMPOTENCY_KEY_REUSED`), не тихое исполнение как
  нового запроса.
- **Actionable периоды — по `timesheetId`, не по неявному «текущему»**: у работника может быть
  несколько одновременно, каждый со своим набором draft/submit/proposal-эндпоинтов.
- **Административный fallback — реальные screen+API** (`/admin/review-fallback*`,
  `/api/admin/review-scopes*`): без этого единственный `FOREMAN`+`WORKER` на объекте не имел бы
  исполнимого пути от `SUBMITTED` до `FOREMAN_APPROVED`.
- **`SITE`/`NON_SITE` — независимые scope, разделённые на три случая при генерации** (не «всё, что
  не SITE, — NON_SITE»): (A) день с рабочим сегментом на объекте → `SITE`-scope этого объекта; (B)
  явный `dayType` отсутствия/подтверждённый ноль → единственный `NON_SITE(scopePurpose=DATA)`; (C)
  автоматически предзаполненный пустой рабочий день без сегментов → **не вносит вклад никуда**.
  Только если во всей версии нет ни (A), ни (B) — создаётся ровно один
  `NON_SITE(scopePurpose=EMPTY_FALLBACK)` с константным хешем, UI подписывает его как «подтверждение
  пустого табеля», не как отсутствие. `NON_SITE` (обеих разновидностей) видит только
  `ADMIN`/`SUPER_ADMIN`.
- **`HAS_PAYROLL_DATA` — точный список условий, `CorrectionDraft` в нём не участвует отдельно.**
  Любая существующая `TimesheetVersion` блокирует безусловно, независимо от содержимого. Наличие
  `CorrectionDraft`/`CorrectionRequest` **не проверяется отдельным условием** — логически избыточно:
  `correction.request` возможен только для табеля, уже прошедшего `FINAL_APPROVED`, а значит уже
  блокируется через существующую `TimesheetVersion`.
- **`canonicalCorrectionProjection()` — отдельная функция, не переиспользование `contentHash`
  scope.** `TimesheetReviewScope.contentHash` разделён по `SITE`/`NON_SITE` и исключает часть полей
  (например, `confirmedZero`/`sourceAbsenceId` нет в `NON_SITE(DATA)`-проекции); материальное
  сравнение корректировки использует весь табель целиком через отдельную функцию. Используется
  только для UI dirty-индикации, `409 NO_CORRECTION_CHANGES` на `correction.submit`, аудита — никогда
  для `HAS_PAYROLL_DATA`.
- **`TimesheetReviewProposal.proposedSegments` — обязательное структурированное поле**, минутного
  пути без интервалов не существует; пустой массив — валидное «предлагаю обнулить часы».
  `proposedMinutes` вычисляется сервисом, не принимается от клиента.
- **`RESOLVED` — терминальное состояние, обеспеченное CHECK-constraint'ом и триггером, не только
  текстом.** CHECK физически запрещает `status=RESOLVED` без одновременных `resolutionOutcome`/
  `resolvedAt`/`resolvedInVersionId`; `BEFORE UPDATE` триггер `trg_proposal_resolved_immutable`
  запрещает любое изменение строки после `RESOLVED`. Composite FK `(resolvedInVersionId,
  timesheetId)` гарантирует, что `resolvedInVersionId` указывает на версию именно того табеля,
  которому принадлежит предложение.
- **Composite FK на `WorkArea` — единый порядок колонок** во всех потребителях:
  `UNIQUE (siteId, id)` на `WorkArea`, `FOREIGN KEY (siteId, workAreaId) REFERENCES
  WorkArea (siteId, id) MATCH SIMPLE` везде, где используется.
- **Ревью-действия разделены по типу: approve строго требует `Timesheet.status=SUBMITTED`, return
  допускает `SUBMITTED|RETURNED`.** Транзакция `scope.return` — фиксированный порядок операций
  (блокировка строк `Timesheet`/`TimesheetDraft` → precondition → реинициализация draft при
  необходимости → смена статуса scope → создание новых предложений `OPEN`) — конкурентные
  `PATCH`/`return`/`accept` сериализуются этой блокировкой, а не гонкой в прикладном коде.
- **Admin override-возврат всей версии явно ломает carry-forward** для всех scope, включая уже
  `APPROVED` — осознанное отличие от точечного возврата одним прорабом.
- **`isPrimary` — «не более одного», не «ровно один»**; не имеет исторического значения, мутируется
  свободно. Смена site/workArea/template у начавшегося назначения — атомарный `assignment.split`.
- **Break-инварианты формализованы**: `endAt>startAt` (обязателен), перерыв внутри родителя,
  перерывы одного родителя не пересекаются между собой — из последнего следует, что unpaid-минуты не
  считаются дважды.
- **`Absence` — единственный путь к персональному non-WORK дню, атомарный и **state-идемпотентный**
  overlay, применяемый и при создании draft, и при последующем одобрении.** `WORKER` не может
  напрямую `PATCH` персональный non-WORK `dayType`. При создании `TimesheetDraft` сервис сначала
  проверяет пересекающийся `APPROVED Absence` для каждой даты и накладывает overlay **до** генерации
  WORK-дефолта — не только «при одобрении после того, как draft уже существует». `absence.create.all`
  не создаёт `APPROVED Absence` в обход overlay-транзакции — вызывает ту же функцию, что
  `absence.approve`. **Единый стабильный lock — `SELECT Employee ... FOR UPDATE`**, а не блокировка
  строки дня, разделяется `absence.approve` и созданием `TimesheetDraft`/`TimesheetDraftDay`
  (`period.create`/`assignment.create`): строки дня может ещё не существовать в момент конфликта,
  блокировка на уровне дня для этой гонки недостаточна. Для уже существующих дней —
  `Employee`-блокировка не заменяет блокировку строки дня: сервис дополнительно выбирает
  пересекающиеся `TimesheetDraftDay` в стабильном порядке `(date, id)` и берёт `SELECT ... FOR
  UPDATE` на каждой строке, прежде чем читать её содержимое — оба lock'а решают разные гонки и
  используются вместе. `absence.approve` ветвится по `Absence.status`, прочитанному под
  `Employee`-блокировкой: `PENDING` → выполняет overlay, `200`; `APPROVED` (в том числе повторный
  вызов с **другим корректным** `Idempotency-Key`) → overlay не повторяется, `200` с ранее
  сохранёнными `Absence.overlayAppliedDates`/`overlayConflicts`; `REJECTED` → `409
  ABSENCE_NOT_PENDING` — единственный случай отказа. `Idempotency-Key` остаётся **обязательным**
  для этого endpoint (запрос без него отклоняется общей проверкой до бизнес-логики) — состояние-
  уровневая идемпотентность работает поверх этого требования, не вместо него: никогда `409` после
  committed `APPROVED`, при условии, что запрос вообще содержит корректный ключ.
- **Мутация draft, меняющая payroll-данные, требует отдельного write-permission.**
  `timesheet.draft.edit.own` — отдельно от `timesheet.read.own`.
- **Триггеры названы по своему реальному типу, не «constraint trigger» для `BEFORE`-логики.**
  PostgreSQL допускает `CONSTRAINT TRIGGER` только как `AFTER ROW` (опционально `DEFERRABLE`).
  `trg_segment_assignment_scope_check`/`trg_planned_shift_validity_check` — обычные `BEFORE ROW`
  триггеры (нужна немедленная, не отложенная проверка); полный `CREATE TRIGGER`-контракт — `03_...`,
  §4.6.
- **Permission-документ полностью самодостаточ**: все permission расписаны таблицами, включая
  отсутствия/экспорт/аудит/GPS/системных пользователей.
- **MFA — production gate** (`REQUIRE_MFA_FOR_ADMIN=true` в `.env.production`), не декларация.
- **Первый вертикальный срез — admin-first**: `/admin/setup` — реальный чек-лист состояния БД, не
  декоративный dashboard.

## 4. Расхождения с формулировкой исходного ТЗ

Репозиторий сейчас не использует Prisma/PostgreSQL (публичный сайт — локальные JSON-файлы через
`lib/json-file-store.ts`); Prisma/PostgreSQL — решение только для Titanor Time, отдельный контейнер и
volume. Более ранний набросок в `docs/PROJECT_ROADMAP.md`/`docs/PROJECT_VISION.md` (раздел «ЭТАП 4»)
детализирован и заменён этим комплектом для целей проектирования.

## 5. MFA production gate

`REQUIRE_MFA_FOR_ADMIN=true` обязателен в `.env.production`. Preview/dev может временно работать с
`false`, пока полный MFA-flow не реализован — реальный пилот не запускается без включённого флага.

## 6. Журнал исправлений v5.4 → v5.4.1

Девятый внешний обзор — micro-pass ровно по четырём точечным остаткам после v5.4. Все четыре
исправлены во всех затронутых файлах:

1. **`absence.approve` state-идемпотентен по `Absence.status`, поверх (не вместо) обязательного
   `Idempotency-Key`.** `Absence` получила собственные поля `overlayAppliedDates`/`overlayConflicts`,
   записываемые один раз при первом переходе в `APPROVED`. `Idempotency-Key` остаётся обязательным
   для этого endpoint — запрос без заголовка отклоняется до бизнес-логики общей проверкой. Ветвление
   по `Absence.status` (при наличии корректного ключа, тем же или другим, ранее не виденным):
   `PENDING` → overlay + `200`; `APPROVED` → без повторного overlay, `200` с ранее сохранённым
   результатом; `REJECTED` → `409 ABSENCE_NOT_PENDING` — единственный случай отказа. В v5.4 повтор с
   **другим** `Idempotency-Key` после `APPROVED` ошибочно получал `409`, потому что идемпотентность
   была завязана только на конкретное значение ключа, не на состояние ресурса. Сценарий AH переписан
   (`03_...`, §4.2; `04_...`, §13; `02_...`, §2.3; `README.md`, §9).
2. **Единый стабильный `Employee`-lock сериализует `absence.approve` с созданием draft.**
   Блокировка строки `TimesheetDraftDay` (используемая для day-state конкурентности, v5.4) не
   покрывает гонку, где сама строка дня ещё не существует на момент конфликта (период/draft ещё не
   создан). `SELECT Employee ... FOR UPDATE` — общий lock, который берут `absence.approve`,
   `absence.create.all(status=APPROVED)`, `period.create` (при генерации draft каждого сотрудника —
   в возрастающем порядке `employeeId` при пакетном создании, чтобы избежать deadlock) и
   `assignment.create`. Доказательство обоих порядков конкурентного выполнения — сценарий AJ
   расширен (`03_...`, §4.2; `README.md`, §9).
3. **Точная семантика `PATCH .../days/:date`: `segments` — полная замена дня по всем объектам, не
   дельта одного `siteId`; добавлено поле `note`.** Если поле `segments` передано, оно обязано
   перечислять весь итоговый набор сегментов дня — объект, отсутствующий в массиве, считается
   удалённым; поле, отсутствующее в теле запроса вовсе, не меняет существующие сегменты.
   `affectedSitePairs` теперь однозначно определена как diff полного старого/нового состояния по
   `siteId`. Site-scoped частичная семантика (`sitePatches`) не используется — не смешивается с
   полной заменой. Сценарий AK переписан, чтобы тело запроса соответствовало выбранной семантике
   (передаёт неизменённые сегменты B, чтобы не задеть предложение B) (`03_...`, §4.6; `04_...`, §9;
   `02_...`, §2.8; `README.md`, §9).
4. **Сценарий AG переписан как чистый unit/contract-тест `canonicalSiteProjection()`/`contentHash`,
   без апелляции к несуществующей production-операции.** `assignment.update` не принимает `validTo`
   (реальная схема запроса — `{version, isPrimary?, endedReason?}`), поэтому AG в v5.4 описывал
   недостижимое действие. AG больше не привязан ни к какому конкретному HTTP-эндпоинту — это
   тест функции на двух подготовленных fixture-наборах `plannedShifts`, различающихся ровно в одной
   дате; production-правило (`templateVersionId` immutable, `assignment.split` создаёт новый
   `sourceAssignmentId`, `plannedShifts` — пересечение периода и валидности) описано отдельно, не
   перепутано с механизмом теста (`README.md`, §9).

Сценарии AG, AH, AJ, AK переписаны; A–AF, AI сверены против новых механизмов без изменения текста
(проверка подтвердила совместимость) — по-прежнему **тридцать семь** сценариев (только содержимое
четырёх обновлено, счёт не менялся).

## 7. Механическая самопроверка (выполнена перед доставкой v5.4.1)

| # | Проверка | Результат |
|---|---|---|
| 1 | Версия документа ≠ `5.4.1` в любом из пяти файлов | 0 совпадений — все пять `5.4.1` |
| 2 | `absence.approve` возвращает `409` при вызове над уже `APPROVED` записью (с корректным, ранее не виденным `Idempotency-Key`) | 0 совпадений — ветвление по `Absence.status`, `200` для `APPROVED` |
| 3 | Единственный lock для `absence.approve`↔draft-creation — блокировка строки дня, не `Employee` | 0 совпадений — везде `SELECT Employee ... FOR UPDATE` |
| 3a | `Idempotency-Key` описан как опциональный/работающий при отсутствии для `absence.approve` | 0 совпадений — везде «обязателен», отсутствие → ошибка до бизнес-логики |
| 3b | `Employee`-lock утверждается как блокирующий конкурентный `PATCH .../days/:date` над уже существующей строкой дня | 0 совпадений — для существующих дней явно описан отдельный `SELECT ... FOR UPDATE` в порядке `(date, id)` |
| 4 | `PATCH .../days/:date` без явного определения, является ли `segments` полной заменой или дельтой | 0 совпадений — везде явно «полная замена по всем объектам» |
| 5 | Request schema `PATCH .../days/:date` без поля `note`, при том что логика ссылается на note-only правку | 0 совпадений — `note?` добавлено в схему |
| 6 | AG апеллирует к `assignment.update`/`validTo`, отсутствующему в реальном контракте | 0 совпадений — AG переписан как unit-тест без привязки к конкретному endpoint |
| 7 | AK отправляет `PATCH` только с сегментами A, утверждая, что B не резолвится, при full-day-replace семантике | 0 совпадений — AK явно передаёт неизменённые сегменты B |
| 8 | Наличие сценариев A–AK (37 меток) | все 37 присутствуют в §9 |
| 9 | `keep_original`/явный отказ от предложения описан как «используйте no-op PATCH» | 0 совпадений — `timesheet.reject_proposal` — отдельное действие |
| 10 | Наличие сценариев A–AK (37 меток) | все 37 присутствуют в §9 |

## 8. Открытые вопросы (нужно решение владельца, не техническое)

1. Правило для смены, пересекающей границу расчётного периода.
2. Финальный список действий, требующих свежий MFA.
3. Максимальная разумная длительность одного `WorkSegment`/`TimesheetDraftSegment`.
4. Нужна ли `WorkScheduleTemplateVersion` видимой пользователю как отдельная сущность в UI.
5. Кому, кроме `ADMIN`/`SUPER_ADMIN`, можно делегировать `correction.draft.edit`.
6. Partial-day отсутствия (сейчас исключение занимает целый календарный день) — нужна ли отдельная
   будущая модель.
7. Когда именно строится route/API для `absence.*` — permission-контракт и контракт
   `absence.approve` (`04_...`, §13) готовы, сам экран/эндпоинт сознательно вынесен за пределы
   первого среза.

## 9. Тридцать семь сквозных сценариев

Формат для каждого: **Entity** (какие таблицы задействованы) · **DB constraint** (что физически
не даёт БД) · **Service precondition** (что проверяет сервисный слой до записи) · **Endpoint**
(конкретный HTTP-контракт) · **State transition** (что меняется).

**A. `APPROVED` A + `RETURNED` B; изменён только B — A остаётся `APPROVED`.**
Entity: `TimesheetReviewScope` (A и B), `WorkSegment`, `TimesheetPlannedShift`. Constraint: partial
unique index `(timesheetVersionId, siteId) WHERE scopeType='SITE'`. Precondition: у прежнего scope A
`status=APPROVED` и новый `contentHash` (assignment-группы `siteId` этого scope, включая
`plannedShifts[]` по датам) не изменился; у прежнего scope B `status=RETURNED` (безусловно — новый
scope B всегда `PENDING`). Endpoint: `POST /api/worker/timesheets/:timesheetId/submit`. Transition:
новый scope A → `APPROVED`, `carriedFromScopeId`=id прежнего, без нового `ApprovalAction`; новый
scope B → `PENDING` безусловно.

**B. Работник обнулил все интервалы объекта B — scope B остаётся `PENDING`, не исчезает.**
Entity: `TimesheetReviewScope`, `WorkSegment`. Constraint: `S_new ∪ S_prev` (алгоритм `03_...`, §4.6,
шаг 2) — объект остаётся в рассмотрении, даже если в новой версии у него нет дней типа (A).
Precondition: `B ∈ S_prev`, `B ∉ S_new`. Endpoint: `POST .../submit`. Transition: scope B создаётся
снова с `contentHash` пустой проекции (`actualDays: []` для каждой assignment-группы, отличается от
прежнего непустого) → `PENDING`.

**C. `Version N+1` дословно копирует интервал `Version N` — разрешено.**
Entity: `WorkSegment` (immutable, без exclusion constraint), `TimesheetDraftSegment` (constraint
scoped по `draftId`). Constraint: `EXCLUDE` физически отсутствует на `WorkSegment`. Precondition:
интервал уже прошёл проверку, пока был draft'ом версии N. Endpoint: `POST .../submit`
(`INSERT ... SELECT` из draft в `WorkSegment`, включая `sourceAssignmentId`+`employeeId`+`date`).
Transition: `DRAFT`/`RETURNED → SUBMITTED`, новые строки `WorkSegment` без конфликта с прежними.

**D. Overlap внутри одного worker draft — отклонён.**
Entity: `TimesheetDraftSegment`. Constraint: `EXCLUDE USING gist (draftId WITH =, employeeId WITH =,
tstzrange(startAt,endAt) WITH &&)` — без фильтра `WHERE`, поскольку `endAt` теперь `NOT NULL`
безусловно. Precondition: — (constraint сам по себе рубеж). Endpoint: `PATCH
/api/worker/timesheets/:timesheetId/days/:date`. Transition: вставка второго пересекающегося
интервала отклоняется на уровне БД, draft не меняется.

**E. Второй `CorrectionDraft` повторяет интервалы первого исторического — разрешён; overlap внутри
второго — отклонён.**
Entity: `CorrectionDraftSegment` (два разных `draftId`). Constraint: тот же `EXCLUDE`, scoped по
`draftId`. Precondition: `correctionRequestId` (и, следовательно, `draftId`) различны. Endpoint:
`correction.draft.edit` (внутренний сервисный вызов). Transition: копия исторического интервала во
второй черновик — успешна (разные `draftId`); попытка пересечения **внутри** второго черновика —
отклонена тем же constraint'ом с тем же `draftId`.

**F. 630 gross − 30 unpaid = 600.**
Entity: `WorkSegment`, `BreakSegment`, `TimesheetReviewProposal.originalMinutes`. Constraint:
break-инварианты §5 (`03_...`) — перерывы одного сегмента не пересекаются, сумма корректна.
Precondition: — (чистое вычисление). Endpoint: вычисляется при создании
`TimesheetReviewProposal`/отображении. Transition: —, формула `sum(WorkSegment) − sum(unpaid
BreakSegment) = 630 − 30 = 600`.

**G. `A=240, B=240`; предложение по B не удаляет A.**
Entity: `TimesheetReviewProposal`, `TimesheetDraftSegment`. Constraint: `proposedSegments` не несёт
`siteId` — всегда наследуется из `reviewScopeId`. Precondition: `proposal.status IN
(OPEN,ACCEPTED,REPLACED)`, `resolvedInVersionId IS NULL`. Endpoint: `POST /api/worker/
review-proposals/:proposalId/accept`. Transition: заменяются только `TimesheetDraftSegment` с
`siteId=B` этого дня; `siteId=A` того же дня не затронут.

**H. Два предложения разрешаются только действиями работника, затем становятся `RESOLVED` в одной
`Version N+1`.**
Entity: `TimesheetReviewProposal` (два, разные дни), `TimesheetDraft` (`contentRevision`).
Constraint: partial unique `(reviewScopeId, timesheetDayId) WHERE status='OPEN'`. Precondition: оба
предложения покинули `OPEN` **исключительно** пользовательской мутацией — ручной правкой
соответствующего дня (увеличивает `contentRevision`) **или** `accept_proposal` — не системной
реинициализацией draft. Endpoint: любая комбинация `PATCH .../days/:date` и `POST .../
review-proposals/:id/accept`, затем один `POST .../submit`. Transition: draft накапливает обе
правки; в транзакции `submit` сервер повторно сверяет финальное состояние с `proposedSegments`
каждого, переводит оба в `status=RESOLVED` с финальным `resolutionOutcome`, `resolvedAt=now()`,
`resolvedInVersionId=N+1`; создаётся ровно одна `TimesheetVersion(versionNumber=N+1)`.

**I. Системная rehydration не выводит `OPEN` из `OPEN`; блокирует submit только по-настоящему
нетронутое предложение.**
Entity: `TimesheetReviewProposal`, `TimesheetDraft`. Constraint: precondition на `timesheet.submit`;
пересчёт `status` условен на `createdAtDraftRevision < TimesheetDraft.contentRevision` (§4.6
`03_...`). Endpoint: `POST /api/worker/timesheets/:timesheetId/submit`. Precondition: хотя бы одно
предложение всё ещё `status=OPEN` — реинициализация draft (§4.6, шаг 5) `contentRevision` не
двигает, значит не может вывести предложение из `OPEN` сама по себе. Transition: `409
UNRESOLVED_PROPOSALS` (тело — `openProposalDayIds`), `Timesheet.status` не меняется; предложение,
переведённое в `ACCEPTED`/`REPLACED` реальной пользовательской мутацией, **не** блокирует submit.

**J. Offboarding-работник завершает старый период.**
Entity: `Employment`, `User.status`, `PayrollPeriodParticipant`. Constraint: правило `03_...`, §4.2.
Precondition: есть `PayrollPeriodParticipant(expected=true, Timesheet.status != FINAL_APPROVED)` в
`OPEN`-периоде `<= endDate`. Endpoint: `POST /api/admin/workers/:employeeId/deactivate` (устанавливает
`OFFBOARDING`, не отзывает сессии), затем `POST /api/worker/timesheets/:timesheetId/submit`
(по-прежнему работает). Transition: `User.status → OFFBOARDING`; после `FINAL_APPROVED` последнего
такого табеля — автоматически `→ DEACTIVATED`.

**K. Draft с введёнными часами блокирует `participant.exclude`, пустой предзаполненный draft — не
блокирует.**
Entity: `TimesheetDraftSegment`, `TimesheetDraftDay`, `PayrollPeriodParticipant`. Constraint: точный
критерий `HAS_PAYROLL_DATA` (`03_...`, §4.5), среди которых `TimesheetDraftSegment` (реальный
интервал), но **не** голая `TimesheetDraftDay` с `dayType=WORK, confirmedZero=false`. Precondition:
существует хотя бы одна строка `TimesheetDraftSegment` для этого `employeeId`/периода. Endpoint:
`POST /api/admin/periods/:periodId/participants/:employeeId/exclude`. Transition: `409
HAS_PAYROLL_DATA` с телом `{reasons: ["DRAFT_SEGMENTS"]}`, `expected` не меняется; для работника с
только автоматически предзаполненными пустыми строками — исключение проходит успешно
(`expected=false`).

**L. Период, закончившийся вчера, но всё ещё `OPEN`, — выбирается по `timesheetId`, submit
работает.**
Entity: `PayrollPeriod(status=OPEN, endDate=вчера)`, `Timesheet`. Constraint: actionable — определение
не зависит от календарных дат (`03_...`, §8). Precondition: `PayrollPeriodParticipant.expected=true`.
Endpoint: `GET /api/worker/periods/actionable` возвращает `timesheetId` этого периода; `POST /api/
worker/timesheets/:timesheetId/submit`. Transition: submit проходит несмотря на то, что период
календарно уже не «текущий».

**M. Два actionable периода редактируются без неоднозначного draft endpoint.**
Entity: два независимых `Timesheet`+`TimesheetDraft`, каждый со своим `TimesheetDraftPlannedShift`.
Constraint: draft-эндпоинты параметризованы `:timesheetId`; exclusion constraint на
`TimesheetDraftSegment` scoped по `draftId`. Precondition: оба периода `expected=true`+`OPEN`+не
`FINAL_APPROVED`. Endpoint: `PATCH /api/worker/timesheets/:timesheetIdA/days/:date` и `.../
timesheetIdB/days/:date` — независимо. Transition: правки в одном табеле не видны и не мешают
другому; идентичный интервал в оба табеля в один день не создаёт ложного пересечения (разные
`draftId`).

**N. `ADMIN` реально подтверждает scope единственного `FOREMAN`+`WORKER` через API, self-approval
запрещён.**
Entity: `TimesheetReviewScope`, `User`/`Employee`. Constraint: `reviewer.employeeId !=
Timesheet.employeeId`. Precondition: вызывающий `ADMIN` — не тот же `Employee`, что владелец табеля;
`Timesheet.status = SUBMITTED`. Endpoint: `GET /api/admin/review-scopes?status=PENDING`, `POST
/api/admin/review-scopes/:reviewScopeId/approve`. Transition: `PENDING → APPROVED` (обычный `ADMIN`,
отличный от работника); `403 SELF_APPROVAL_FORBIDDEN`, если совпадает.

**O. `Idempotency-Key` для employee A нельзя использовать для employee B.**
Entity: `IdempotencyKey`. Constraint: unique `(actorUserId, httpMethod, routeTemplate,
idempotencyKey)` — без path-параметров; `requestHash` включает их. Precondition: тот же ключ, другой
`employeeId` в пути → та же строка найдена, `requestHash` не совпадает. Endpoint: `POST /api/admin/
workers/:employeeId/activation` дважды (A, затем B, тот же `Idempotency-Key`). Transition: второй
вызов → `409 IDEMPOTENCY_KEY_REUSED`, для B ничего не создаётся под видом повтора.

**P. `WorkArea` объекта B нельзя записать с `siteId` объекта A.**
Entity: `SiteAssignment`/`WorkSegment`/`TimesheetDraftSegment`/`CorrectionDraftSegment`. Constraint:
`WorkArea` объявляет `UNIQUE (siteId, id)`; потребители объявляют `FOREIGN KEY (siteId, workAreaId)
REFERENCES WorkArea (siteId, id) MATCH SIMPLE` — идентичный порядок колонок `(siteId, workAreaId)` во
всех местах, включая `proposedSegments` (валидируется сервисом, поскольку это jsonb, где FK
физически невозможен). Precondition: —. Endpoint: любая запись, где `siteId=A`, `workAreaId`
фактически принадлежит B. Transition: нарушение внешнего ключа, `INSERT`/`UPDATE` отклоняется на
уровне БД (для `proposedSegments` — `400 VALIDATION_ERROR` от сервиса при создании предложения).

**Q. Смешанный табель (объект A + больничный + объект B) создаёт `SITE A`, `SITE B` и
`NON_SITE(DATA)` scope с независимыми хешами.**
Entity: `TimesheetReviewScope` (три строки, `scopePurpose=DATA` у третьей). Constraint: partial
unique index `(timesheetVersionId) WHERE scopeType='NON_SITE'` + классификация дней по трём случаям
(`03_...`, §4.6). Precondition: есть `WorkSegment` на A (случай A), на B (случай A), и хотя бы один
день `dayType=SICK_LEAVE` (случай B, явный — без обобщённого `ABSENCE`). Endpoint: `POST .../submit`.
Transition: три независимых `TimesheetReviewScope`; изменение содержимого одного не пересчитывает
`contentHash` двух других (данные физически не пересекаются в проекции — каждый день принадлежит
ровно одному scope).

**R. Прораб со старой вкладкой не может решить scope предыдущей версии.**
Entity: `TimesheetReviewScope`. Constraint: `scope.timesheetVersionId = Timesheet.currentVersionId`.
Precondition: работник успел переотправить между открытием вкладки прорабом и его действием.
Endpoint: `POST /api/foreman/review-scopes/:reviewScopeId/approve` (или `/return`). Transition: `409
STALE_REVIEW_SCOPE`, состояние не меняется, UI подсказывает обновить список.

**S. Два назначения одного объекта, разные `workAreaId`/шаблоны, получают независимое сравнение с
планом.**
Entity: `WorkSegment` (`sourceAssignmentId` различается, оба с локальным `employeeId`),
`TimesheetPlannedShift` (по одной строке на `(sourceAssignmentId, date)`). Constraint:
`TimesheetPlannedShift` резолвится из `SiteAssignment`, действовавшего для этого
`employeeId`+`siteId`+`workAreaId`+даты, и замораживается при `submit`; composite FK
`(sourceAssignmentId, employeeId, siteId) REFERENCES SiteAssignment(id, employeeId, siteId)` — реален
благодаря локальному `employeeId`. Precondition: два `WorkSegment` того же дня и `siteId`, разные
`sourceAssignmentId`. Endpoint: вычисление `hasException` при ревью/отображении (агрегированное
сравнение `WorkSegment` каждого `sourceAssignmentId` с соответствующим `TimesheetPlannedShift`, не по
`siteId` в целом). Transition: —, каждая пара (назначение, план) сравнивается независимо;
`SITE`-scope помечается `hasException`, если отклонение есть хотя бы у одного назначения.

**T. Два пересекающихся unpaid-перерыва отклоняются, не уменьшают payroll дважды.**
Entity: `BreakSegment`/`TimesheetDraftBreakSegment`. Constraint: `EXCLUDE USING gist
(parentSegmentId WITH =, tstzrange(startAt,endAt) WITH &&)`. Precondition: —. Endpoint: `PATCH /api/
worker/timesheets/:timesheetId/days/:date` (попытка добавить второй пересекающийся перерыв).
Transition: вставка отклоняется на уровне БД; поскольку пересекающиеся перерывы невозможны,
`sum(BreakSegment.duration)` не может посчитать один и тот же интервал дважды.

**U. День с реальными сегментами на объекте не превращает пустые дни того же табеля в `NON_SITE` —
только явные (B)-дни туда попадают.**
Entity: `TimesheetDay` (случай A на объекте C), `TimesheetDay` (случай C — пустой рабочий день без
сегментов в другую дату того же табеля), `TimesheetReviewScope`. Constraint: алгоритм `03_...`,
§4.6 — классификация выполняется **по дням**, не по табелю целиком; случай (C) не создаёт вклад ни в
`SITE`, ни в `NON_SITE` независимо от того, что происходит в другие дни того же табеля. Precondition:
табель содержит хотя бы один день типа (A) на объекте C и хотя бы один день типа (C) в другую дату.
Endpoint: `POST /api/worker/timesheets/:timesheetId/submit`. Transition: создаётся только
`SITE(siteId=C)` scope; пустой день типа (C) не порождает `NON_SITE(EMPTY_FALLBACK)`, поскольку
`(S_new ∪ S_prev)` непусто (правило §4.6, шаг 7 — `EMPTY_FALLBACK` создаётся, только если **весь**
табель не имеет ни (A), ни (B)).

**V. Работник, у которого есть только автоматически предзаполненные пустые дни (случай C) за весь
период, — исключается из периода без блокировки.**
Entity: `TimesheetDraftDay` (все `dayType=WORK, confirmedZero=false`, без единого
`TimesheetDraftSegment`), `PayrollPeriodParticipant`. Constraint: `HAS_PAYROLL_DATA` (`03_...`, §4.5)
— явно перечисленный список условий не включает голую предзаполненную строку. Precondition: ни одно
из условий `HAS_PAYROLL_DATA` не выполнено (в т.ч. нет ни одной `TimesheetVersion`). Endpoint: `POST
/api/admin/periods/:periodId/participants/:employeeId/exclude`. Transition: `expected → false`,
`exclusionReason` сохраняется, `200 OK` (не `409`).

**W. Прораб пытается вернуть табель с предложением «замени на 6 часов» без интервалов — запрос
отклоняется на уровне API, минутного пути не существует.**
Entity: `TimesheetReviewProposal`. Constraint: `proposedSegments jsonb NOT NULL` — колонка физически
не принимает `NULL`; поле `proposedMinutes` не читается из тела запроса вовсе. Precondition: тело
запроса не содержит `proposedSegments` как массив интервалов (например, содержит только число минут).
Endpoint: `POST /api/foreman/review-scopes/:reviewScopeId/return`. Transition: `400
VALIDATION_ERROR` до создания `TimesheetReviewProposal`; для «обнулить часы» клиент обязан явно
передать `proposedSegments: []` — валидный отдельный случай, отличимый от отсутствующего поля.

**X. `ACCEPTED ↔ REPLACED` работает после пользовательских изменений, не после системных.**
Entity: `TimesheetReviewProposal`, `TimesheetDraftSegment`, `TimesheetDraft` (`contentRevision`).
Constraint: пересчёт статуса при пользовательской мутации draft, затрагивающей `(siteId, date)` пары
scope+день, условен на `createdAtDraftRevision < contentRevision` (`03_...`, §4.6, «Жизненный цикл
status»). Precondition: `proposal.status = ACCEPTED` (уже покинул `OPEN` пользовательской мутацией,
`resolvedInVersionId IS NULL`), затем `PATCH` на тот же день меняет содержимое так, что оно больше не
совпадает с `proposedSegments`, увеличивая `contentRevision`. Endpoint: `POST /api/worker/
review-proposals/:proposalId/accept` (первый шаг), затем `PATCH /api/worker/timesheets/:timesheetId/
days/:date` (второй шаг). Transition: `ACCEPTED → REPLACED`, `lastEvaluatedAt` обновляется на вторую
мутацию; `status`, `resolvedAt`, `resolvedInVersionId` остаются не-`RESOLVED`/`NULL` до фактического
`submit`.

**Y. Плановая смена `07:00–15:00` фактически отработана двумя фрагментами
(`07:00–11:00`+`12:00–15:00`) — `hasException` вычисляется по агрегату, не по каждому фрагменту
отдельно, и не показывает ложное отклонение только из-за разбиения.**
Entity: `WorkSegment` (два, один `siteId`/`sourceAssignmentId`), `TimesheetPlannedShift` (один —
на конкретную дату). Constraint: агрегированное определение `hasException` (`03_...`, §4.6,
«`hasException` для пары (назначение, день)») — сравнение суммарной длительности и границ **всех**
`WorkSegment` этой пары `(date, sourceAssignmentId)` с одной строкой `TimesheetPlannedShift`, не
поэлементное. Precondition: сумма `WorkSegment.duration` этой пары равна плановой длительности
(`plannedEndAt − plannedStartAt − plannedBreakMinutes`) с точностью до допустимого отклонения.
Endpoint: вычисление на `GET /api/foreman/timesheets/:timesheetId` / `GET /api/admin/review-scopes/
:reviewScopeId`. Transition: —, `hasException = false`, несмотря на то что ни один отдельный
`WorkSegment` не покрывает `07:00–15:00` целиком.

**Z. Ни одна сущность интервала не может быть сохранена с `endAt = NULL`.**
Entity: `WorkSegment`, `TimesheetDraftSegment`, `CorrectionDraftSegment`, `BreakSegment`,
`TimesheetDraftBreakSegment`, `CorrectionDraftBreakSegment`. Constraint: `endAt timestamptz NOT
NULL` на каждой из шести таблиц, `CHECK endAt > startAt` безусловный (без `WHERE endAt IS NOT NULL` —
проверка применяется ко всем строкам). Precondition: клиент пытается сохранить интервал/перерыв без
поля `endAt`. Endpoint: `PATCH /api/worker/timesheets/:timesheetId/days/:date` (и любой другой
эндпоинт, создающий сегмент/перерыв — `04_...`, §0, «Рабочие интервалы всегда закрыты»). Transition:
`400 VALIDATION_ERROR` на уровне API до похода в БД; при гипотетическом обходе валидации — `NOT NULL`
constraint отклоняет запись на уровне БД как последний рубеж.

**AA. Полностью пустая, но уже отправленная версия блокирует `participant.exclude`.**
Entity: `Timesheet`, `TimesheetVersion` (единственный `NON_SITE(EMPTY_FALLBACK)` scope),
`PayrollPeriodParticipant`. Constraint: безусловная проверка `Timesheet.currentVersionId IS NOT
NULL` / `EXISTS TimesheetVersion` (`03_...`, §4.5). Precondition: работник хотя бы раз отправил
табель, все дни которого — случай (C) (пустой дефолт), получив только `NON_SITE(EMPTY_FALLBACK)`
scope. Endpoint: `POST /api/admin/periods/:periodId/participants/:employeeId/exclude`. Transition:
`409 HAS_PAYROLL_DATA` с телом `{reasons: ["SUBMITTED_VERSION"]}`, `expected` не меняется —
несмотря на то что содержимое версии формально пусто.

**AB. Только что скопированный `CorrectionDraft` имеет `materialChanged=false` и не может быть
отправлен как корректировка; изменение одного `dayType` даёт `materialChanged=true` и разрешает
`correction.submit`. `participant.exclude` в обоих случаях отдельно блокируется `SUBMITTED_VERSION`,
потому что базовая версия уже существует.**
Entity: `CorrectionDraft` (`basedOnVersionId`), `CorrectionDraftDay`, `CorrectionDraftSegment`,
`TimesheetVersion` версии-источника. Constraint: `canonicalCorrectionProjection()` — отдельная от
`contentHash` scope функция (`03_...`, §4.5), сравнивающая весь табель целиком. Precondition (два
независимых вопроса): (1) `correction.submit` — `materialHash(draft) == materialHash(basedOnVersionId)`
блокирует отправку (`409 NO_CORRECTION_CHANGES`), пока `!=` — не блокирует; (2)
`participant.exclude` — сам факт `CorrectionDraft.basedOnVersionId IS NOT NULL` уже доказывает
существование `TimesheetVersion`, которая блокирует через `SUBMITTED_VERSION`, **независимо** от
результата (1). Endpoint: `correction.draft.edit`/`correction.submit` для (1); `POST /api/admin/
periods/:periodId/participants/:employeeId/exclude` для (2). Transition: (1) дословная копия →
`409 NO_CORRECTION_CHANGES`; изменённый `dayType` → `correction.submit` проходит,
`CorrectionRequest.status → SUBMITTED`; (2) в обоих случаях `exclude` → `409 HAS_PAYROLL_DATA`
`{reasons: ["SUBMITTED_VERSION"]}` — `200 OK` для табеля с открытым `CorrectionDraft` невозможен ни
при каком `materialChanged`.

**AC. Два назначения одного работника на один `siteId`, разные `workAreaId`/шаблоны, сравниваются
независимо и не смешиваются в один агрегат — на реальном composite FK, не декларативной фразе.**
Entity: `SiteAssignment` (два, тот же `siteId`, разные `workAreaId`), `WorkSegment` (разные
`sourceAssignmentId`, у каждого свой локальный `employeeId`), `TimesheetPlannedShift` (по строке на
`(sourceAssignmentId, date)`). Constraint: exclusion constraint на `SiteAssignment` разрешает обе
строки (ключ включает `COALESCE(workAreaId, ...)`, `03_...`, §4.4); `hasException`/`contentHash`
группируются по `sourceAssignmentId`, реальный composite FK `(sourceAssignmentId, employeeId, siteId)
REFERENCES SiteAssignment(id, employeeId, siteId)` физически исполним благодаря локальному
`employeeId` на `WorkSegment`. Precondition: обе `SiteAssignment` активны и пересекаются датами;
работник вводит часы на оба назначения в один день. Endpoint: два `PATCH /api/worker/timesheets/
:timesheetId/days/:date`, затем `GET /api/foreman/timesheets/:timesheetId` / `GET /api/admin/
review-scopes/:reviewScopeId`. Transition: —, отклонение по одному назначению не влияет на оценку
другого; `SITE`-scope помечается `hasException=true`, если отклонение есть хотя бы у одного из двух,
но каждое видно раздельно.

**AD. `confirmedZero=true` вместе с сегментами невозможно сохранить и невозможно заморозить ни на
draft, ни на correction draft, ни на immutable-версии.**
Entity: `TimesheetDraftDay`/`TimesheetDraftSegment` (обычный draft), `CorrectionDraftDay`/
`CorrectionDraftSegment` (корректировка), `TimesheetDay`/`WorkSegment` (immutable). Constraint:
`BEFORE ROW` триггер, реализующий таблицу допустимых состояний (`03_...`, §4.6, «Правило состояния
дня») — три экземпляра: обычный draft, `trg_correction_day_state_check` на `CorrectionDraft*`, и тот
же триггер на immutable стороне, все — с единым порядком блокировки строки дня (`03_...`, §4.6,
«Concurrency-safe реализация»). Precondition: запрос пытается установить `confirmedZero=true` при
существующих (или одновременно передаваемых) сегментах дня — в любой из трёх таблиц. Endpoint:
`PATCH /api/worker/timesheets/:timesheetId/days/:date` (обычный draft); `correction.draft.edit`/
`correction.submit` (корректировка); прямая вставка в обход draft при `submit`/`correction.approve`
(immutable). Transition: `409 DAY_STATE_CONFLICT` на уровне API до похода в БД во всех трёх случаях;
при обходе валидации — триггер отклоняет `INSERT`/`UPDATE` на уровне БД как последний рубеж;
`correction.submit` дополнительно не проходит финальную проверку правила состояния дня, а
`correction.approve` не может заморозить такую комбинацию.

**AE. `scope.return` создаёт предложение и реинициализирует draft, но предложение остаётся `OPEN` до
последующего действия работника; системное копирование исходной версии не считается `REPLACED`.**
Entity: `TimesheetReviewProposal` (новое, `status=OPEN`), `TimesheetDraft`
(`contentRevision`/`basedOnVersionId`). DB constraint/trigger: `createdAtDraftRevision` снимается в
момент создания предложения **после** реинициализации draft в той же транзакции (`03_...`, §4.7,
«Транзакция `scope.return`»); реинициализация не увеличивает `contentRevision`, поэтому предложение
и текущее состояние draft остаются на одной и той же ревизии сразу после возврата. Service
precondition: пересчёт `status` запускается только когда `contentRevision > createdAtDraftRevision`
— сразу после `scope.return` это условие ложно для только что созданного предложения, поэтому
пересчёт не выполняется вовсе. Endpoint: `POST /api/foreman/review-scopes/:reviewScopeId/return`
(или admin fallback `.../return`) с `proposals[]`. Transaction: блокировка `Timesheet`/
`TimesheetDraft` → precondition → реинициализация draft (если нужна) → `scope.status → RETURNED` →
создание предложений `status=OPEN`. State transition: сразу после коммита транзакции
`TimesheetReviewProposal.status = OPEN` — не `REPLACED`/`ACCEPTED`, даже если скопированное системой
содержимое draft дословно совпадает с `proposedSegments`; переход из `OPEN` происходит только при
следующей пользовательской мутации (`PATCH`/`accept_proposal`/`reject_proposal`).

**AF. `WorkSegment`/`TimesheetPlannedShift` нельзя сохранить со строкой версии работника A, но
`employeeId`/`sourceAssignmentId` работника B — даже если `siteId` совпадает. Ошибка возникает на
уровне БД даже при обходе API.**
Entity: `Timesheet`, `TimesheetVersion`, `WorkSegment`, `SiteAssignment`. DB constraint: цепочка
composite FK — `(timesheetId, employeeId) REFERENCES Timesheet(id, employeeId)` на `TimesheetVersion`
(гарантирует `TimesheetVersion.employeeId = Timesheet.employeeId`), `(timesheetVersionId, employeeId)
REFERENCES TimesheetVersion(id, employeeId)` на `WorkSegment`/`TimesheetPlannedShift` (гарантирует
`WorkSegment.employeeId = TimesheetVersion.employeeId`), и `(sourceAssignmentId, employeeId, siteId)
REFERENCES SiteAssignment(id, employeeId, siteId)` (гарантирует, что `sourceAssignmentId` принадлежит
тому же `employeeId`, что и сам сегмент) (`03_...`, §4.6). Service precondition: сервис резолвит
`sourceAssignmentId` сам и не принимает его от клиента (`04_...`, §0), но составная FK-цепочка —
независимый последний рубеж. Endpoint: гипотетическая прямая вставка в `WorkSegment` в обход
сервисного слоя с `timesheetVersionId` табеля A, но `employeeId=B` и `sourceAssignmentId`,
принадлежащим B (самосогласованно внутри себя, но не с версией A). Transition: `INSERT` отклоняется
на уровне БД нарушением FK `(timesheetVersionId, employeeId) REFERENCES TimesheetVersion(id,
employeeId)` — `employeeId=B` не совпадает с `TimesheetVersion.employeeId=A`; ни один прикладной код
(даже с ошибкой) не может создать такую строку, потому что нарушение обнаруживается на первом же
звене цепочки, независимо от того, что `sourceAssignmentId` сам по себе валиден для B.

**AG. Изменение планового снимка одной даты в canonical `SITE`-проекции меняет `contentHash`, даже
если снимок другой даты и все фактические часы идентичны — чистый unit/contract-тест функции, не
сценарий через production-мутацию.**
`v5.4` пытался объяснить это через `assignment.update`, «продлевающий» `SiteAssignment.validTo» —
но реальный контракт `PATCH /api/admin/assignments/:assignmentId` (`04_...`, §6) принимает только
`{version, isPrimary?, endedReason?}` и не принимает `validTo` вовсе; `assignment.split` создаёт
**новый** `sourceAssignmentId`, не продлевает существующий; регенерация из одного и того же immutable
`templateVersionId` детерминирована и не может дать другой результат для уже сгенерированной даты.
Production-путь, реально производящий два **разных** снимка одной и той же даты **для одного и того
же** `sourceAssignmentId` в рамках этой модели, не существует — и не должен придумываться ради теста.
Entity: `TimesheetPlannedShift` (две строки, один `sourceAssignmentId`, разные `date`) —
подготовленные fixture-данные, не результат конкретного вызова API. DB constraint: `unique
(timesheetVersionId, date, sourceAssignmentId)` — по строке на каждую дату, не одна на назначение
(`03_...`, §4.6) — сама эта уникальность и есть то свойство, которое тест проверяет косвенно: функция
обязана учитывать каждую дату отдельно. Service precondition/Endpoint: **не применяется — это
unit/contract-тест канонической функции `canonicalSiteProjection()`/`contentHash`, не HTTP-сценарий**.
Тестовые входные данные (два подготовленных набора для одного и того же `SITE`-scope, одного
`sourceAssignmentId`):

```text
Набор 1: plannedShifts = [ {date: D1, plannedStartAt: 07:00, plannedEndAt: 15:00, plannedBreakMinutes: 30},
                            {date: D2, plannedStartAt: 07:00, plannedEndAt: 15:00, plannedBreakMinutes: 30} ]
         actualDays     = [ {date: D1, segments: [...]} ]   // одинаковые в обоих наборах

Набор 2: plannedShifts = [ {date: D1, plannedStartAt: 07:00, plannedEndAt: 15:00, plannedBreakMinutes: 30},
                            {date: D2, plannedStartAt: 08:00, plannedEndAt: 16:00, plannedBreakMinutes: 30} ]
         actualDays     = [ {date: D1, segments: [...]} ]   // те же, что в наборе 1
```

Transition: `hash1 = SHA-256(canonicalSiteProjection(Набор 1))`, `hash2 =
SHA-256(canonicalSiteProjection(Набор 2))` → `hash1 != hash2`, несмотря на то что `actualDays` и
запись `plannedShifts[D1]` идентичны в обоих наборах — единственное отличие, запись `plannedShifts[D2]`,
достаточно, чтобы изменить итоговый хеш всего `SITE`-scope (`03_...`, §4.6, «Каноническая проекция
для `contentHash`»).

**Реальное production-правило (отдельно от теста выше, действует независимо от того, как именно два
разных набора снимков когда-либо возникают)**: `templateVersionId` зафиксирован на `SiteAssignment` и
не редактируется задним числом уже начавшегося назначения; `assignment.split` — единственный способ
сменить план назначения, и он создаёт новый `sourceAssignmentId` (см. `03_...`, §4.4); пересечение
`PayrollPeriod` × `SiteAssignment.validity` определяет, какие именно даты `plannedShifts`
генерируются вообще (`03_...`, §4.6). Смысл AG — не «как это произойдёт в проде», а «функция
корректно чувствительна к изменению одной даты внутри массива, а не только к изменению `actualDays`».

**AH. `APPROVED Absence` частично конфликтует с уже отправленным табелем: одобрение фиксируется один
раз, безопасные дни получают overlay, конфликтные возвращаются в `overlayConflicts`; повтор запроса
идемпотентен **по состоянию `Absence`, не только по `Idempotency-Key`**.**
Entity: `Absence` (получил `overlayAppliedDates`/`overlayConflicts` как собственные поля, `03_...`,
§4.2), `TimesheetDraftDay` (несколько дат, часть — «нетронутый дефолт», часть — уже с данными),
`TimesheetVersion` (для дат, уже отправленных), `Employee` (объект блокировки). DB constraint:
транзакционность — `Absence.status: PENDING → APPROVED` и применённые overlay-строки коммитятся
одной транзакцией; `SELECT Employee ... FOR UPDATE` перед чтением `Absence.status` (`03_...`, §4.2).
Service precondition: сервис читает `Absence.status` **под блокировкой** и ветвится — `PENDING`
выполняет overlay; `APPROVED` возвращает уже сохранённый результат без повторного overlay;
`REJECTED` отклоняет. Endpoint: `POST /api/admin/absences/:absenceId/approve` (`04_...`, §13, later
phase; **`Idempotency-Key` обязателен для обоих вызовов**, оба — с корректным заголовком), вызван
**дважды** с **разными** `Idempotency-Key` — второй вызов уже после того, как первый перевёл
`Absence` в `APPROVED`. Transaction: первый вызов — `SELECT Employee ... FOR UPDATE` (сериализует с
`period.create`/`assignment.create`, не с `PATCH` над уже существующими днями, см. AJ), одобрение
фиксируется, по каждой дате диапазона — уже существующие `TimesheetDraftDay` выбираются в порядке
`(date, id)` и берутся `SELECT ... FOR UPDATE` по очереди (та же дисциплина, что day-state триггеры)
**до** чтения `dayType`/`confirmedZero` — overlay применяется, если день «нетронутый дефолт», иначе
дата+причина попадает в `overlayConflicts`; `Absence.overlayAppliedDates`/`overlayConflicts`
записываются. Второй вызов (уже `Absence.status=APPROVED`, другой, ранее не виденный, корректный
`Idempotency-Key`) — overlay не выполняется повторно, транзакция коммитится как no-op. State
transition: оба вызова возвращают **`200 OK`** с идентичным телом
(`overlayAppliedDates`/`overlayConflicts` первого вызова) — **не** `409`, несмотря на разные
`Idempotency-Key`; `409 ABSENCE_NOT_PENDING` достижим только если `Absence.status = REJECTED`.

**AI. Конкурентные `INSERT` сегмента и `UPDATE confirmedZero=true` на один день не могут обе
закоммититься, независимо от порядка запуска.**
Entity: `TimesheetDraftDay`, `TimesheetDraftSegment`. DB constraint/trigger: единый порядок блокировок
— `BEFORE ROW` триггер на `TimesheetDraftSegment` берёт `SELECT ... FROM TimesheetDraftDay WHERE
id=... FOR UPDATE` первым действием; триггер на `TimesheetDraftDay` полагается на блокировку,
неявно взятую самим `UPDATE` (`03_...`, §4.6, «Concurrency-safe реализация»). Service precondition:
—, это чисто DB-уровневое доказательство. Endpoint: `PATCH /api/worker/timesheets/:timesheetId/
days/:date` (два конкурентных вызова — один добавляет сегмент, другой ставит `confirmedZero=true`).
Transaction/Transition: T1 (`INSERT`) первой берёт блокировку → T2 (`UPDATE`) ждёт, видит после
разблокировки существующий сегмент → `409 DAY_STATE_CONFLICT`, откат; **или** T2 первой берёт
блокировку (неявно) → T1 ждёт на своём `FOR UPDATE`, после разблокировки видит `confirmedZero=true`
→ `409 DAY_TYPE_CONFLICT`/`DAY_STATE_CONFLICT`, откат. В обоих порядках ровно одна транзакция
коммитится; невалидная комбинация (`confirmedZero=true` + сегмент) недостижима.

**AJ. `APPROVED Absence`, существовавшая до открытия периода, накладывается на `TimesheetDraftDay`
уже при создании draft; конкурентное `period.create` и `absence.approve` для одного работника не
могут произвести противоречивую комбинацию `Absence.status=APPROVED` + нетронутый
`dayType=WORK`-день независимо от порядка коммита.**
Entity: `Absence(status=APPROVED)`, `PayrollPeriod`, `TimesheetDraft`, `TimesheetDraftDay`,
`Employee` (объект общей блокировки). DB constraint: exclusion constraint на `Absence` (`WHERE
status IN (PENDING,APPROVED)`, `03_...`, §4.2); `SELECT Employee ... FOR UPDATE`, взятая **обеими**
сторонами до первого чтения `Absence`/`TimesheetDraftDay` (`03_...`, §4.2, «Единый стабильный
lock...») — устраняет гонку, для которой блокировки самой строки дня недостаточно, поскольку в
момент конфликта строка `TimesheetDraftDay` может ещё не существовать. Service precondition: при
генерации `TimesheetDraftDay` сервис сначала ищет пересекающийся `APPROVED Absence` этого
`employeeId` **до** применения WORK-дефолта, уже под блокировкой `Employee` (`03_...`, §4.6, шаг 1).
Endpoint: `POST /api/admin/periods` (или `POST /api/admin/assignments`, если период уже открыт) и
`POST /api/admin/absences/:absenceId/approve` — вызваны **конкурентно** для одного и того же
`employeeId` (T1 = создание периода/draft, T2 = одобрение `Absence`). Transaction: обе стороны берут
`SELECT Employee ... FOR UPDATE` первым действием — какая бы транзакция ни захватила блокировку
первой, вторая ждёт её коммита прежде, чем прочитать `Absence.status`/`TimesheetDraftDay`. Transition
(оба порядка): (а) T1 первая — коммитит WORK-дефолт **только** если на момент её собственного чтения
`Absence.status != APPROVED` **и** дожидается T2 (заблокированной на том же `Employee`); T2,
разблокировавшись, находит уже существующий «нетронутый дефолт» и накладывает overlay штатно; (б) T2
первая — коммитит `Absence.status=APPROVED`; T1, разблокировавшись, видит `APPROVED` на шаге
проверки и сразу создаёт день с overlay, минуя WORK-дефолт. В обоих порядках после коммита обеих
транзакций **не существует** дня с `Absence.status=APPROVED` и при этом нетронутым `dayType=WORK` —
недостижимая до `v5.4.1` комбинация исключена структурно, не только «в большинстве случаев».

**AK. Два `OPEN`-предложения разных `siteId` на одну и ту же дату: правка объекта A, при явной
передаче неизменённых сегментов B (обязательно при full-day-replace семантике `segments`), не
резолвит предложение объекта B.**
Entity: `TimesheetReviewProposal` (два, один день, `reviewScope.siteId` — A и B соответственно),
`TimesheetDraftSegment` (сегменты обоих объектов на этот день). DB constraint: partial unique
`(reviewScopeId, timesheetDayId) WHERE status='OPEN'` — по одному предложению на пару (scope, день),
не мешает существованию двух предложений разных `reviewScopeId` на тот же `timesheetDayId`.
Service precondition: `segments`, переданное в `PATCH .../days/:date`, — **полный итоговый набор
сегментов дня по всем объектам** (`03_...`, §4.6, «Точная семантика `PATCH .../days/:date`»); чтобы
изменить только A и не задеть B, клиент **обязан** включить в `segments` сегменты объекта A (новые)
**и** сегменты объекта B дословно неизменёнными — иначе, при full-day-replace семантике, отсутствие B
в массиве означает его удаление, и `affectedSitePairs` включила бы `B`. Endpoint: `PATCH
/api/worker/timesheets/:timesheetId/days/:date` с телом:

```json
{
  "segments": [
    { "siteId": "A", "startAt": "...", "endAt": "...", "breaks": [] },
    { "siteId": "B", "startAt": "07:00Z-исходный", "endAt": "15:00Z-исходный", "breaks": [] }
  ]
}
```

— сегмент B передан дословно тем же, что уже был в draft до запроса. Transition: сервис сравнивает
полное старое/новое состояние по каждому `siteId`: `siteId=A` отличается → `A ∈ affectedSitePairs`;
`siteId=B` идентичен → `B ∉ affectedSitePairs`. Предложение объекта A пересчитывается (`OPEN →
ACCEPTED`/`REPLACED` по совпадению с `proposedSegments`); предложение объекта B **остаётся `OPEN`** —
не затронуто этим вызовом, несмотря на то что оба относятся к одному календарному дню и оба физически
присутствовали в теле запроса. **Контрпример (проверка семантики, не отдельный сценарий)**: тот же
`PATCH`, но без сегментов B в теле — при full-day-replace семантике `B ∈ affectedSitePairs`
(сегмент B удалён), предложение B корректно пересчитывается как `REPLACED` (draft для B теперь
пуст, не совпадает с `proposedSegments`), а не остаётся `OPEN` — это не баг, а следствие того, что
B действительно изменился (удалён) этим запросом.

## 10. Порядок утверждения

1. `02_ROLE_PERMISSION_MATRIX.md` — полностью самодостаточен, включая `absence.*`,
   `timesheet.draft.edit.own`, `timesheet.reject_proposal`.
2. `03_DATA_MODEL_ERD.md` — особенно §4.2 (`Absence` overlay при создании и одобрении), §4.5
   (`HAS_PAYROLL_DATA`, `canonicalCorrectionProjection`), §4.6 (табели/предложения/scope/
   `contentRevision`/`affectedSitePairs`/цепочка `employeeId`/`sourceAssignmentId`/`date`-
   целостность/concurrency-safe day-state) и §4.7 (транзакция `scope.return`).
3. `01_SCREEN_MAP.md` — включая `/admin/review-fallback*`, `/worker/periods/*`, `reject_proposal` на
   `/worker/history/[timesheetId]`, `/worker/absences`+`/admin/absences` (later phase).
4. `04_ADMIN_FIRST_API_CONTRACTS.md` — §11 покрывает сценарий без пробелов, §13 — контракт
   `absence.approve`.
5. Тридцать семь сценариев §9 — соответствуют реальной практике владельца.
6. Открытые вопросы §8 закрываются явным решением.
7. Только после этого — T5.1/T5.2 из `docs/PROJECT_ROADMAP.md` (Prisma schema).

## 11. Критерии, после которых можно начинать production-код

- Документы прочитаны владельцем, включая все тридцать семь сценариев §9.
- Открытые вопросы §8 закрыты явным решением или явным «решим по ходу» с пометкой где.
- Первый вертикальный срез (`04_...`, §11) подтверждён как первое, что строится.
- Известен первый `SUPER_ADMIN` и способ передачи первого пароля.
- `REQUIRE_MFA_FOR_ADMIN` заложен в план деплоя.
- Ничего не противоречит `docs/AGENT_RULES.md`.

До выполнения этих критериев — **код и Prisma-схема не пишутся**.
