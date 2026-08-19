# Titanor Time — T8 Reports Design

Написано **до** реализации T8.1 (Admin Worker Time Report), фиксирует ядро расчёта времени и
контракты, которые T8.2 (отчёт по объекту), T8.3 (отчёт по периоду) и T8.4 (CSV/PDF export)
обязаны переиспользовать без копирования формулы.

## 0. Явно НЕ входит ни в один слайс T8

Зарплата, ставки, деньги, payroll calculation — этот документ и весь T8 намеренно ограничены
рабочим временем (минутами), никогда не переводят его в деньги.

## 1. Canonical data source

Источник данных для отчёта по `Timesheet` определяется ИСКЛЮЧИТЕЛЬНО его `status` — никогда не
смешивается, никогда не имеет fallback в обе стороны:

| `Timesheet.status`                          | Источник сегментов                                     |
|----------------------------------------------|---------------------------------------------------------|
| `DRAFT`, `RETURNED`                           | текущее содержимое `TimesheetDraft` → `TimesheetDraftDay` → `TimesheetDraftSegment` → `TimesheetDraftBreakSegment` |
| `SUBMITTED`, `FOREMAN_APPROVED`, `FINAL_APPROVED` | `TimesheetVersion` с `id = Timesheet.currentVersionId` (immutable) → `TimesheetDay` → `WorkSegment` → `BreakSegment` |

Правила:
- **Никакого fallback** — если статус требует version, но `currentVersionId` почему-то `null` (не
  должно происходить по существующим инвариантам T7/корректировок — `SUBMITTED`/`FOREMAN_APPROVED`/
  `FINAL_APPROVED` всегда получают `currentVersionId` в той же транзакции, что и переход статуса,
  см. `lib/worker-timesheets.ts:1148`), это **invariant failure**, не нулевой отчёт — выбрасывается
  ошибка (500 с safe-логом), а не молча подставляется пустой список сегментов.
- **`CorrectionRequest` со статусом `PENDING`/`DRAFT_OPEN`/`SUBMITTED`** никак не меняет
  `Timesheet.currentVersionId` (проверено — `lib/corrections.ts` не вызывает
  `tx.timesheet.update({ data: { currentVersionId } })` нигде, кроме approval-ветки ниже) —
  следовательно отчёт для `FINAL_APPROVED` с открытой pending-корректировкой продолжает читать
  СТАРУЮ current version, не видит черновик корректировки вообще. Это не специальный случай в коде
  отчёта — это прямое следствие "читаем `Timesheet.status`+`currentVersionId`, больше ничего".
- **Approved correction** (`CorrectionRequest.status = APPROVED`) переключает `resultingVersionId`
  на новую `TimesheetVersion` И атомарно обновляет `Timesheet.currentVersionId = version.id`
  (`lib/corrections.ts:904`, та же транзакция) — отчёт, вызванный ПОСЛЕ этого коммита, естественно
  видит новую version, без какого-либо специального кода для "an approved correction happened".

## 2. Формула рабочих минут — reusable core

Новый чистый модуль `lib/reporting/worked-time.ts`, ноль зависимостей от Prisma/HTTP/UI:

```ts
export interface WorkedTimeBreakInput { startAt: Date; endAt: Date; paid: boolean }
export interface WorkedTimeSegmentInput { startAt: Date; endAt: Date; breaks: WorkedTimeBreakInput[] }
export interface WorkedTimeMs { grossMs: number; paidBreakMs: number; unpaidBreakMs: number; workedMs: number }

export function computeSegmentMs(segment: WorkedTimeSegmentInput): WorkedTimeMs
export function sumWorkedTimeMs(items: WorkedTimeMs[]): WorkedTimeMs
export function msToMinutes(ms: number): number   // Math.round(ms / 60000)
```

`computeSegmentMs`: `grossMs = endAt - startAt`; для каждого break — `paid ? paidBreakMs += breakMs
: unpaidBreakMs += breakMs`; `workedMs = grossMs - unpaidBreakMs`. Paid break **входит** в
`workedMs` (не вычитается — только собирается отдельно для отображения). Unpaid break вычитается
**ровно один раз на break**, не на сегмент (несколько unpaid breaks одного сегмента — каждый вычитается
independently, суммарно). Никакого специального кода для cross-midnight — `startAt`/`endAt` уже
абсолютные `timestamptz`, `endAt - startAt` в мс корректен независимо от того, пересекает ли интервал
полночь; `WorkSegment.crossesMidnight`/аналог в draft — это только метаданные для UI/группировки по
дате, не участвуют в самой арифметике длительности.

**Округление — зафиксировано раз навсегда для T8.1–T8.4:**
1. Всё складывается в миллисекундах, пока не будет причины остановиться (`sumWorkedTimeMs`).
2. Округление в минуты (`msToMinutes`, `Math.round`) происходит **ровно один раз, на уровне
   минимального canonical bucket `(employeeId, siteId, date)`** — не на уровне всего site за период
   (это была ошибка T8.1's первой реализации, исправленная в T8 ROUNDING FOLLOW-UP, `[2026-08-19]`,
   см. врезку после §3) и не один раз на весь отчёт.
3. Любой более высокий уровень группировки — T8.1's `site` bucket и `total`, T8.2's `worker.total` и
   `summary`, будущие T8.3 site/company totals и T8.4 CSV — это **только сумма уже округлённых
   daily-bucket чисел**, никогда повторное округление суммы миллисекунд. Так `total.workedMinutes`
   всегда буквально равен `Σ (daily bucket).workedMinutes` (через любое число промежуточных уровней
   группировки), без визуального расхождения на ±1 минуту, которое давало бы отдельное округление
   более высокого уровня из мс.
4. Единственное исключение — `workedDayCount` (см. §3): это **count distinct calendar dates** в
   соответствующем scope, не сумма и не миллисекунды, у него нет ms-уровня вообще.

**Canonical reporting bucket — `(employeeId, siteId, date)`.** Это минимальная единица округления
для ЛЮБОГО T8-отчёта (T8.1–T8.4). Округление на любом более крупном уровне (например, «весь site за
период», без разбивки по датам) даёт **другое** число при sub-minute сегментах: два дня по 31
секунде — `round(31s) + round(31s) = 1 + 1 = 2 min` на уровне daily bucket, но `round(62s) = 1 min`,
если просуммировать миллисекунды всего site заранее и округлить один раз. T8.1 и T8.2 обязаны
сходиться на одном и том же числе для одного и того же (employee, site, period) — это была причина
инцидента, см. врезку ниже.

`lib/attendance-overview.ts`'s `segmentReportedMs` (текущий source of truth формулы, до этого
слайса) переписывается на `computeSegmentMs`+`sumWorkedTimeMs`+`msToMinutes` без изменения
поведения (regression-тест п.32 подтверждает identical `recordedMinutes`/`reportedMinutes`/
`deltaMinutes` до и после рефакторинга) — единственная общая формула, ни одной копии.

## 3. Правила группировки (T8.1)

- **Шаг 1 — canonical daily bucket**: сегменты сначала группируются по `(siteId, date)` — один bucket
  на пару объект+дата, где у работника есть хотя бы один сегмент. Внутри bucket — `sumWorkedTimeMs`
  по всем сегментам этого bucket, один `msToMinutes` на bucket (§2 п.2). Это тот же bucket, что T8.2's
  `lib/site-time-report.ts::buildDays` уже использует для своих `days[]` — общий уровень округления
  между T8.1 и T8.2, не два независимых.
- **Шаг 2 — site bucket**: один bucket на объект — сумма уже округлённых daily-bucket
  `grossMinutes`/`paidBreakMinutes`/`unpaidBreakMinutes`/`workedMinutes` внутри этого site (§2 п.3),
  никогда повторное округление ms.
- `segmentCount` (per site) — количество сегментов (WorkSegment/TimesheetDraftSegment) с этим
  `siteId`, суммируется по daily buckets этого site (целое число, не подвержено rounding).
- `workedDayCount` (per site) — `COUNT(DISTINCT date)` среди daily buckets этого site (= число daily
  buckets, раз bucket уникален по date внутри site).
- `total.*Minutes` — сумма соответствующих **уже округлённых** site-полей (§2 п.3; транзитивно — сумма
  всех daily-bucket чисел работника, независимо от порядка группировки).
- `total.workedDayCount` — `COUNT(DISTINCT date)` **по всем** сегментам timesheet'а разом (не сумма
  per-site `workedDayCount` — один календарный день с сегментами на двух объектах не должен считаться
  дважды в total).
- `total.segmentCount` — сумма per-site `segmentCount` (сегмент принадлежит ровно одному site, суммa
  корректна и без distinct).
- `total.siteCount` — `sites.length`.
- Site sorting: `siteName ASC, siteId ASC` (детерминированная сортировка даже при совпадающих именах
  объектов — тест п.25).

> **Исправлено `[2026-08-19]` (T8 ROUNDING FOLLOW-UP)**: до этого исправления шаг 1 отсутствовал —
> `lib/worker-time-report.ts::groupSegments` группировал сразу по `siteId` (весь период целиком, без
> промежуточной группировки по дате) и округлял один раз на весь site. При sub-minute сегментах это
> расходилось с T8.2, которое уже округляло per-day: два дня по 31 секунде давали T8.1 `1 min`
> (`round(62s)`), но T8.2 `2 min` (`round(31s) + round(31s)`). Исправление — только внутренняя
> перестройка `groupSegments` (bucket по `(siteId, date)`, затем sum-of-rounded в site bucket); DTO,
> API-контракт и UI T8.1 не менялись. Постоянный регрессионный тест —
> `titanor-time-app/scripts/_test-report-rounding-consistency.ts` (реальные HTTP-запросы к обоим
> endpoint, `/api/admin/reports/workers/:employeeId` и `/api/admin/reports/sites/:siteId`, сверяет
> T8.1 и T8.2 построчно на 15 обязательных сценариях).

## 4. Response contract

```
GET /api/admin/reports/workers/:employeeId?periodId=<uuid>
```

Успех — `200`, тело буквально как в задаче T8.1 (см. исходное сообщение задачи — не дублируется
здесь дословно, чтобы не разойтись с ним; ключевые инварианты ниже).

- `timesheet: null, sites: [], total: <нулевой total (все *Minutes/segmentCount/workedDayCount/
  siteCount = 0)>` — если для `(employeeId, periodId)` вообще нет строки `Timesheet` (работник не
  подавал/не был включён в этот период). Это НЕ ошибка — 200, честное "нет данных".
- `participant: { expected: false }` — если `PayrollPeriodParticipant.expected = false` для этой
  пары (явно исключённый участник); `participant: null` — если для этой пары вообще нет
  `PayrollPeriodParticipant` (сотрудник никогда не был частью периода).
- `timesheet.dataSource`: `'DRAFT'` для `DRAFT`/`RETURNED`, `'CURRENT_VERSION'` для
  `SUBMITTED`/`FOREMAN_APPROVED`/`FINAL_APPROVED` — прямое отражение §1, не отдельно вычисляемое
  поле.
- `timesheet.versionNumber`/`submissionSource` — `null`, когда `dataSource = 'DRAFT'` (у draft нет
  version); заполнены из `TimesheetVersion`, когда `dataSource = 'CURRENT_VERSION'`.
- Ошибки: malformed `employeeId` (path) или `periodId` (query) → `400 VALIDATION_ERROR` с
  `fieldErrors`; `periodId` отсутствует вовсе (query param не передан) → тоже `400
  VALIDATION_ERROR` (`fieldErrors: { periodId: ['required'] }` — этому отчёту, в отличие от
  `/api/admin/overview`, period обязателен, нет fallback на "текущий открытый период"); валидный
  формат, но employee/period не существует → `404 WORKER_NOT_FOUND`/`404 PERIOD_NOT_FOUND`
  соответственно (employeeId проверяется первым — если оба некорректны, ответ про worker).

## 5. Permission / redaction

Три permission одновременно, тот же паттерн что `GET /api/admin/overview`
(`app/api/admin/overview/route.ts:18,28-32`) — `REQUIRED_PERMISSIONS = ['worker.read.all',
'period.read.all', 'timesheet.read.all']`, цикл `hasPermission`, любой отсутствующий → `403
FORBIDDEN` до какого-либо чтения БД. Отзыв любого из трёх между запросами → `403` на следующий
запрос (permission проверяется заново на каждый HTTP-запрос, никакого кэша между вызовами — то же
поведение, что уже доказано для overview). Ни новых permission, ни изменений
`RolePermission`/schema/migrations.

Redaction — из DTO структурно отсутствуют: phone/email/GPS/device identifiers/payload/hash/
requestId (в теле успешного ответа; `requestId` живёт только в error-envelope и `X-Request-Id`
заголовке, не в JSON-теле 200-ответа). DTO строится через явный `select`/маппинг, не
`JSON.stringify` целой Prisma-модели — отсутствие поля проверяется тестом (п.28: blanket scan тела
ответа и отрендеренного HTML).

## 6. Consistency / query-count contract

Один `prisma.$transaction(async (tx) => {...}, { isolationLevel:
Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 20_000 })` — тот же
`OVERVIEW_TX_OPTIONS`-паттерн (`lib/attendance-overview.ts:753`), новая одноимённая константа в
report-модуле. Один `asOf = new Date()` фиксируется один раз внутри транзакции, до первого запроса,
и используется во всех местах, где нужен "текущий момент" (сейчас — нигде, кроме поля `asOf` самого
ответа; T8.1 не имеет relative-to-now логики вроде overview's "текущий открытый период").

Bounded query count — не зависит от числа сегментов/объектов работника за период:
1. `employee` (`findUnique`, by id).
2. `period` (`findUnique`, by id).
3. `participant` (`findUnique`, by `[periodId, employeeId]`).
4. `timesheet` (`findUnique`, by `[employeeId, periodId]`, включая `draft`-связь через `include`
   ИЛИ отдельный `findUnique` на `TimesheetDraft` by `timesheetId` — один дополнительный запрос,
   не N).
5. Сегменты — ОДИН `findMany` (`workSegment.findMany({ where: { timesheetVersionId } , include:
   { breaks: true, site: { select: { name: true } } } })` либо аналог для `timesheetDraftSegment`)
   — включает breaks и site name через `include`/`select`, не отдельный запрос на каждый
   segment/site.

Итого — фиксированное малое число query-событий (измерено: 12, включая Prisma's собственные
`BEGIN`/`COMMIT`/уровень-изоляции служебные запросы внутри interactive transaction — не только 5
логических `find*`-вызовов из списка выше), независимо от того, 1 сегмент у работника или 20
сегментов на 2 объектах — подтверждено тестом п.31: оба фикстуры дают одинаковые 12 query-событий.

GET не создаёт `AuditEvent`, не мутирует `updatedAt`/`contentRevision` ни одной строки — читает
исключительно через `tx.*.findUnique`/`findMany`, ни одного `update`/`create`/`upsert` в
транзакции.

## 7. Границы T8.1 → T8.4

- **T8.1 (этот слайс)** — один работник × один период, ADMIN/SUPER_ADMIN only, минуты (не деньги).
- **T8.2** — отчёт по объекту (много работников на одном site) — обязан переиспользовать
  `lib/reporting/worked-time.ts` без копирования формулы; НЕ начат этим слайсом.
- **T8.3** — отчёт по периоду (компания целиком) — тот же переиспользуемый core; НЕ начат.
- **T8.4** — CSV/PDF export batch — потребитель тех же DTO-форм, что и T8.1-T8.3; НЕ начат.
- FOREMAN reports, WORKER self-report — вне scope всех T8.1-T8.4 в текущей роадмап-разбивке, не
  проектируются здесь.

## Addendum — T8.2A Site Time Report APIs (2026-08-19)

Написано **до** реализации. Backend только — `lib/site-time-report.ts` (shared service) + два route
(`GET /api/admin/reports/sites/:siteId`, `GET /api/foreman/reports/sites/:siteId`). UI — отдельный
T8.2B, не начат этим слайсом.

### A. Population — кто входит в отчёт

Работник входит в site report для `(siteId, periodId)`, если выполнено **хотя бы одно**:

1. У него есть `SiteAssignment` с этим `siteId`, чей `[validFrom, validTo]` **пересекается** с
   `[period.startDate, period.endDate]` — тот же inclusive-both-ends overlap-паттерн, что уже
   `lib/periods.ts`'s `createPeriod` использует при материализации участников нового периода:
   `validFrom <= period.endDate AND (validTo IS NULL OR validTo >= period.startDate)`. Оба поля —
   `@db.Date` с обеих сторон, прямое сравнение без cast.
2. Canonical report source (§C ниже) для этого работника в этом периоде содержит **хотя бы один**
   segment с этим `siteId` — независимо от того, есть ли у него СЕЙЧАС активное assignment на этот
   site (могло закончиться, но исторический segment остаётся в отчёте).

Ни один из двух путей не первичен — это union, не приоритет. Из этого следует:
- Назначенный, но ещё не отработавший ни часа работник виден с нулём часов (`assignmentInPeriod:
  true`, `days: []`, `total` — весь ноль).
- Работник, чьё assignment закончилось ДО начала периода, но у которого есть corrected/historical
  segment с этим site в каноническом источнике (например, поздняя корректировка), не теряется
  (`assignmentInPeriod: false`, но `days`/`total` заполнены).
- Segment без текущего assignment (сотрудник переведён на другой site уже после того, как
  отработал этот period) не теряется — путь 2 не зависит от пути 1.

`participantExpected` — из `PayrollPeriodParticipant.expected` для этой пары `(periodId,
employeeId)`, если строка существует; `null`, если участника вообще нет (человек никогда не был
частью этого периода — такое возможно для пути 2: historical segment есть, а
`PayrollPeriodParticipant` мог быть создан позже или не для этого периода вовсе — честно
показываем `null`, не `false`).

### B. FOREMAN scope

- Пересчитывается **внутри той же snapshot-транзакции**, что и сам отчёт — не отдельным
  pre-check запросом до `$transaction`, чтобы scope и данные согласованно относились к одному
  `asOf` (revocation мог случиться ровно в этот момент — используется `tx`, не `prisma`).
  Переиспользует `getForemanSiteIds(foremanUserId, today, tx)` (уже существует,
  `lib/foreman-review.ts:22`) — тот же "только текущие" (`validFrom <= today AND (validTo IS NULL
  OR validTo >= today)`) паттерн, что уже используют overview/review-scopes.
- Выбранный `siteId` **обязан** входить в этот scope — иначе `404 SITE_REPORT_NOT_FOUND`,
  **тот же код**, что и для реально несуществующего site (задача §"FOREMAN scope" — foreign site не
  должен быть oracle, различимый ответ дал бы прорабу способ enumerate чужие site id).
- Report — read-only. В отличие от `buildOperationalOverview`'s `excludeEmployeeId` (foreman не
  видит/не review'ит собственный approve-queue item, чтобы не самоодобрять себя), **T8.2 никогда
  не исключает собственную строку прораба**, даже если у него dual-role FOREMAN+WORKER и он сам
  входит в population этого site — это не approve/return action, это read-only company data о
  реально отработанном времени; исключение имело бы смысл только для action-эндпоинтов.
- FOREMAN никогда не получает данные ДРУГИХ site через worker/day aggregation — population (§A) и
  все агрегаты фильтруются по ОДНОМУ `siteId` из URL на каждом уровне (SQL `WHERE siteId = $1`, не
  постфильтрация в JS), не "все site работника, потом показать только этот" — секция сегментов
  ДРУГИХ site того же (мульти-объектного) работника структурно не попадает ни в один запрос этого
  отчёта.

### C. Canonical source — дословно T8.1 (`docs/titanor-time/T8_REPORTS_DESIGN.md` §1 выше)

Тот же `Timesheet.status` → `TimesheetDraft` (DRAFT/RETURNED) или `TimesheetVersion` по
`currentVersionId` (SUBMITTED/FOREMAN_APPROVED/FINAL_APPROVED) переключатель, применяется **на
уровне каждого работника независимо** (у разных работников одного site в один момент могут быть
Timesheet в разных статусах — это нормально, не смешивается). Invariant failure (status требует
version/draft, а его нет) — throw для ВСЕГО запроса, не пропуск одной строки: частичный отчёт с
молча пропущенным работником хуже честной ошибки. Pending correction не меняет `currentVersionId` —
то же рассуждение, что T8.1 §1, применённое per-employee.

### D. Формула — дословно `lib/reporting/worked-time.ts`, ноль новых копий

`computeSegmentMs`/`sumWorkedTimeMs`/`msToMinutes` — импортируются как есть. Округление — тот же
двухуровневый rule, что T8.1, но с ОДНИМ дополнительным уровнем группировки:

1. **Day bucket** (per employee, per calendar date, per site — но site уже зафиксирован URL'ом, так
   что фактически per employee+date): сумма ms всех segments этой даты, один `msToMinutes` здесь.
2. **Worker total**: сумма уже округлённых `day.*Minutes` (не повторное округление суммы мс) —
   `worker.total.workedMinutes = Σ day.workedMinutes` буквально в JSON.
3. **Summary** (по всему result set, не текущей странице — §E): сумма уже округлённых
   `worker.total.*Minutes` по ВСЕМ работникам population, не пересчёт из сырых ms заново —
   `summary.workedMinutes = Σ items[].total.workedMinutes` для полного (непагинированного) набора.

`worker.total.workedDayCount` — количество `days[]`-записей (каждая date уже уникальна внутри
одного работника по построению группировки, distinct не нужен отдельно). `summary.workedDayCount`
— `COUNT(DISTINCT date)` по ВСЕМ segments всех работников этого site разом (день, когда на объекте
работали трое, считается одним днём объекта — та же logика, что T8.1's `total.workedDayCount`,
на уровень выше).

### E. Pagination и summary

- `summary` считается по **полной** (непагинированной) population — вычисляется ДО среза
  `page`/`pageSize`, не из текущей страницы. Это значит: агрегаты для summary и для per-worker
  `items[].total` считаются из ОДНОГО и того же набора сырых segment-строк за один проход (в
  памяти после одного bulk `findMany`, не два раздельных запроса с риском рассинхронизации между
  ними при конкурентной правке — тот же REPEATABLE READ snapshot покрывает оба).
- `items` — постранично; `page`/`pageSize`/`totalItems`/`totalPages` — тот же контракт, что уже
  `attendance-overview.ts`'s `OverviewResult` (`lib/attendance-overview.ts:240-251`), только здесь
  единица пагинации — работники population, а не строки лога.
- `summary.timesheetStatusCounts` — по всем пяти `TimesheetStatus`, посчитано из population (работник
  без Timesheet не попадает ни в одну из пяти корзин, но учитывается в отдельном
  `summary.withoutTimesheetCount`).

### F. Redaction — то же самое, расширено списком задачи

Структурно отсутствуют: phone/email, raw GPS, `deviceInstallationId`/`deviceSequence`,
`clientEventId`/`payloadHash`/`requestId`, exception detail, audit payload, correction reason,
**точные timestamps отдельных segments** (T8.2 показывает только даты и агрегированные суммы по
дню — ни `startAt`/`endAt` ни одного segment никогда не попадают в DTO, даже без разбивки на
часы/минуты отдельного интервала). DTO строится явным `select` на каждом уровне запроса — не
маппингом целой Prisma-модели с последующим удалением полей.

### G. Consistency / query-count

Один `prisma.$transaction(..., { isolationLevel: RepeatableRead })`, один `asOf` внутри. Bounded,
set-based запросы (тот же принцип, что уже `buildOperationalOverview`: IN-clause по уже
резолвленному списку employeeId/assignmentId, не per-worker/per-day loop):

1. `site` (`findUnique` by id) — заодно проверка существования → `404 SITE_NOT_FOUND`/
   `SITE_REPORT_NOT_FOUND`.
2. `period` (`findUnique` by id) → `404 PERIOD_NOT_FOUND`.
3. (только FOREMAN) `foremanAssignment.findMany` для scope — `getForemanSiteIds`.
4. `siteAssignment.findMany` (path 1 популяции) — один запрос, `WHERE siteId = $1 AND
   <overlap-condition>`.
5. Population-объединение требует знать, у КАКИХ employee вообще есть Timesheet с сегментом этого
   site в этом периоде (path 2) — один `findMany` по `Timesheet` этого `periodId`, JOIN на
   draft/version сегменты фильтрованные по `siteId` (два варианта — draft-side и version-side,
   каждый один `findMany` с `siteId`-фильтром, аналогично T8.1's сегмент-запросу, но не per-employee).
6. Итоговый employee-list — union множеств шагов 4 и 5 → один `employee.findMany({ where: { id: {
   in: [...] } } })` для DTO-полей.
7. `payrollPeriodParticipant.findMany` для всего union-списка (`participantExpected`) — один запрос.

Итого — фиксированное малое число query-событий (измерено: 13 — тот же порядок, что и T8.1's 12,
плюс один дополнительный запрос за счёт FOREMAN-scope-ветки/участников), не растущее с числом
работников (подтверждено: 1, 50 и 200 работников дают одинаковые 13 query-событий) и не растущее с
числом segments.

GET не создаёт `AuditEvent`, не мутирует `updatedAt`/`contentRevision` ни одной строки — читает
исключительно через `tx.*.findMany`/`findUnique`.

### H. Permissions — миграция

`site.read.assigned`/`period.read.assigned` **отсутствовали** до этого слайса — подтверждено прямым
SQL (`SELECT` по `Permission`/`RolePermission` на чистой disposable БД: ноль строк для обоих кодов).
Новая additive DML migration `20260819000000_seed_site_period_read_assigned_permissions` — тот же
паттерн, что уже `20260805140000_seed_foreman_review_permissions` (INSERT в `Permission`, затем
INSERT в `RolePermission` только для роли `FOREMAN`). `ADMIN`/`SUPER_ADMIN`/`WORKER` — ноль новых
grants. `schema.prisma` не меняется — `Permission`/`RolePermission` таблицы уже существуют, это
чистые данные.

### I. Endpoints

```
GET /api/admin/reports/sites/:siteId?periodId=&page=&pageSize=
  permission: site.read.all + period.read.all + timesheet.read.all (все три)
GET /api/foreman/reports/sites/:siteId?periodId=&page=&pageSize=
  permission: site.read.assigned + period.read.assigned + timesheet.read.assigned (все три)
```

Оба вызывают один `getSiteTimeReport(siteId, periodId, { page, pageSize }, scope)` из
`lib/site-time-report.ts`, где `scope` — `{ kind: 'unrestricted' } | { kind: 'foreman'; foremanUserId:
string; today: Date }`. Ни одна бизнес-логика не дублируется между route-файлами — они делают
только auth/permission/query-validation/HTTP-mapping (тот же split, что `lib/attendance-exceptions.ts`
и T8.1's `worker-time-report.ts` уже устанавливают).

## Addendum — T8.2B Site Time Report UI (2026-08-19)

Написано **до** реализации. UI поверх уже реализованного и не меняемого T8.2A backend
(`lib/site-time-report.ts`, оба route). Ни contract, ни formula/population/scope backend этим
addendum'ом не меняются.

### J. Общий presentation-компонент

`components/reports/SiteTimeReportView.tsx` — единственное место, где рендерится сам отчёт. Обе
страницы (`/admin/reports/sites`, `/foreman/reports/sites`) — тонкие Server Component обёртки,
которые: резолвят сессию, проверяют permission-тройку через `hasPermission` (не `roles.includes`),
парсят `searchParams`, вызывают `getSiteTimeReport()` **напрямую** (без HTTP self-fetch — тот же
принцип, что уже `/admin/reports` (T8.1) и `app/admin/page.tsx` (overview) устанавливают), получают
lookup-списки (§L), и передают всё как props в `SiteTimeReportView`:

```ts
interface SiteTimeReportViewProps {
  role: 'admin' | 'foreman';
  basePath: string; // '/admin/reports/sites' | '/foreman/reports/sites'
  rawFilters: { siteId: string | null; periodId: string | null; page: string | null; pageSize: string | null };
  siteOptions: { id: string; name: string }[];
  periodOptions: { id: string; label: string; status: string }[];
  outcome: SiteReportOutcome; // 'prompt' | 'invalid' | 'site-not-found' | 'period-not-found' | 'ok'
}
```

Компонент не делает ни одного собственного запроса к БД/API — чистая презентация уже готового
`SiteTimeReport`-объекта (или его отсутствия). Разница admin/foreman — это ТОЛЬКО: (1) `role` меняет
заголовок/навигационные ссылки (admin видит переключатель "By worker"/"By site", foreman — только
"By site", без единой admin-ссылки); (2) `siteOptions` заранее отфильтрован каждой страницей под
свой scope (§L) — сам компонент не знает и не проверяет scope повторно, он доверяет уже
отфильтрованному списку.

### K. Filters/URL

`<form method="GET">`, query — `siteId`/`periodId`/`page`/`pageSize`, та же схема, что T8.1 и
overview уже используют. Правила:
- Смена `site`/`period`/`pageSize` через сам `<select>` **не может** технически "сбросить page в 1"
  на чистом HTML `<form>` уровне (все поля одной формы отправляются вместе) — вместо этого форма
  **не содержит** `page` как видимое поле вообще: `page` передаётся только через отдельные
  pagination-ссылки (`<a href="...&page=N">`), которые всегда несут ТЕКУЩИЕ `siteId`/`periodId`/
  `pageSize` рядом. Сабмит фильтр-формы (смена site/period/pageSize) естественно уходит на URL без
  `page` → страница читает его как `page=1` по умолчанию. Так "смена фильтра сбрасывает page"
  достигается структурно, без JS.
- `page` вне `[1, totalPages]` (при `totalItems > 0`) — не 404 и не ошибка: честный empty-page
  state с текстом и ссылкой "Back to page 1" (та же query, `page=1`).
- Malformed `siteId`/`periodId`/`page`/`pageSize` — `outcome: 'invalid'`, inline validation banner
  (`role="alert"`), не 500 и не throw — тот же `parseSiteReportQuery()` (`lib/site-time-report.ts`,
  уже существует, экспортирован), что и API route, переиспользуется без копии.
- Reload/back/forward воспроизводят тот же отчёт "бесплатно" — URL это единственный источник
  правды, страница не хранит никакого client state (Server Component, без `'use client'`).

### L. Lookups — без нового N+1, без client fetch

- ADMIN: `listSiteOptionsForAdmin()` + `listPeriodOptions()` (оба уже существуют,
  `lib/attendance-overview-lookups.ts`, переиспользуются как есть — не копируются).
- FOREMAN: `listSiteOptionsForForeman(foremanUserId, today)` (уже существует, тот же файл) — сам
  список сайтов уже фильтрован по текущим `ForemanAssignment`, тот же scope, что
  `getSiteTimeReport()`'s собственная `getForemanSiteIds()`-проверка внутри транзакции ниже.
  `listPeriodOptions()` — тот же company-wide список периодов, что и у ADMIN (периоды сами по себе
  не site-scoped; "period.read.assigned" ограничивает не САМ список периодов, а его использование в
  контексте foreman's site, что и проверяет backend).
- Оба lookup-вызова — `Promise.all` рядом с основным вызовом `getSiteTimeReport()`, не внутри цикла,
  не пересчитываются на каждый item.
- Если FOREMAN вручную подставит в URL `siteId` объекта не из своего scope — этот id не появится ни
  в одном `<option>` (список построен только из его собственных assignments), а сам
  `getSiteTimeReport()` всё равно вернёт `SITE_REPORT_NOT_FOUND` независимо от содержимого select'а
  (defense in depth — UI-уровень fильтрации lookup'а не единственная защита).

### M. Состояния (`SiteReportOutcome`)

`'prompt'` (нет `siteId`/`periodId`) → `'invalid'` (malformed query) → `outcome` от
`getSiteTimeReport()` (`SITE_NOT_FOUND`/`SITE_REPORT_NOT_FOUND`/`PERIOD_NOT_FOUND`/`OK`). Foreign и
несуществующий site для FOREMAN — **один и тот же** текст на экране (не просто одинаковый HTTP-код
в API — сам UI-текст тоже не должен намекать на разницу), напрямую отражая `SITE_REPORT_NOT_FOUND`'s
собственную "no oracle" семантику. Дальше внутри `'ok'`: `items.length === 0` (empty site report —
либо нет ни assignment, ни segment вообще, либо `page` вне диапазона) — различаются по `totalItems`
(0 → "no workers", `page` вне диапазона при `totalItems > 0` → "empty page" с ссылкой на page 1).

### N. Формат времени — переиспользование, не копия

`formatWorkedDuration`/`timesheetStatusLabel`/`dataSourceLabel` перенесены из T8.1-специфичного
`lib/worker-time-report-ui.ts` в общий `lib/reporting/report-format.ts` (тот же core/UI split, что
`lib/reporting/worked-time.ts` уже устанавливает для формулы) — T8.1's `/admin/reports` переключён
на новый путь импорта БЕЗ изменения своего результата (тот же regression-принцип, что T8.1 само
применило к `lib/attendance-overview.ts`). Новый `submissionSourceLabel` (MANUAL/AUTO) добавлен
туда же — T8.2B первый показывает это поле в UI (T8.1's worker report никогда не рендерил
`submissionSource`, только хранил его в DTO — этот addendum не трогает T8.1's собственный вывод).

UI никогда не пересчитывает и не суммирует минуты заново — только форматирует уже готовые
`grossMinutes`/`workedMinutes`/etc. из `SiteTimeReport`, буквально как backend их вернул.

### O. Security — DTO уже redaction-safe, UI ничего не добавляет

`lib/site-time-report.ts`'s DTO (T8.2A) уже структурно не содержит phone/email/GPS/device
identifiers/payload/hash/requestId/exception detail/audit payload/correction reason/точные
timestamps segments (§F design doc выше) — UI-слой ничего нового не может утечь, потому что нечему
утекать: рендерятся только поля, уже присутствующие в типизированном `SiteTimeReport`. Blanket
scan (тест п.31 списка задачи) — просто дополнительное доказательство, не единственная защита.

## Addendum — T8.3A Company Payroll Period Report API (2026-08-19)

Написано **до** реализации. Company/site-агрегированный отчёт по расчётному периоду —
ADMIN/SUPER_ADMIN only, без разбивки по работникам (detail уже есть в T8.1/T8.2). UI (T8.3B) этим
addendum'ом не начат.

### P. Shared canonical-source helper

`lib/reporting/canonical-source.ts` (новый, чистый — ноль Prisma/I/O) выносит правило §1 в одно
место: `resolveCanonicalSource({id, status, currentVersionId, draft, currentVersion})` →
`{dataSource, versionNumber, submissionSource, draftId, versionId}`, throw при нарушении инварианта
(DRAFT/RETURNED без `TimesheetDraft`, либо не-draft статус без `currentVersionId`/`currentVersion`).
T8.1 (`lib/worker-time-report.ts`) и T8.2 (`lib/site-time-report.ts`) переключены на этот helper
**без изменения своего DTO/результата** — подтверждено полным прогоном их собственных regression
(57/57, 80/80) и 105/105 rounding-consistency после переключения. T8.3 использует тот же helper —
теперь единая точка правды для всех трёх отчётов, не три независимые копии status/source branching.
Pending correction никогда не трогает `currentVersionId` (только approved меняет его атомарно вместе
с созданием новой `TimesheetVersion`) — поэтому helper, читающий `currentVersionId` напрямую, уже
корректно обрабатывает оба случая без отдельной correction-специфичной ветки.

### Q. Company population

Работник входит в отчёт периода, если выполнено хотя бы одно (union, не приоритет):
1. существует `PayrollPeriodParticipant` этого `periodId`;
2. существует `Timesheet` этого `periodId`;
3. существует `SiteAssignment` (на любом объекте), пересекающий даты периода (тот же
   inclusive-both-ends overlap, что T8.2A использует per-site: `validFrom <= period.endDate AND
   (validTo IS NULL OR validTo >= period.startDate)`, здесь — без фильтра по `siteId`, company-wide);
4. canonical source содержит хотя бы один segment, принадлежащий `Timesheet` этого `periodId`.

**Важное наблюдение**: условие 4 всегда является подмножеством условия 2 — любой segment (draft или
version) принадлежит конкретному `TimesheetDraft`/`TimesheetVersion`, который принадлежит конкретному
`Timesheet` с конкретным `employeeId`+`periodId`; запрос сегментов в этом модуле стартует от уже
отобранных по `periodId` timesheets (§S), поэтому 4 не добавляет новых employeeId сверх 2. Условие
сохранено в реализации и в этом документе для симметрии с формулировкой задачи и на случай будущих
изменений схемы, но фактическое company population вычисляется как `participantIds ∪ timesheetIds ∪
assignmentIds` — три множества, не четыре, с доказанной эквивалентностью.

Следствия (все проверены тестами §54 списка задачи, п.9–14, 18):
- участник (`PayrollPeriodParticipant`) без `SiteAssignment` остаётся видимым (условие 1);
- работник, назначенный на объект уже после создания периода, но ещё без `Timesheet`, виден
  (условие 3);
- excluded participant (`expected: false`) виден наравне с expected — population не фильтрует по
  `expected`, это отдельное поле сводки (§T);
- historical/corrected segment не теряется — если `Timesheet` существует в периоде и его canonical
  source содержит segment, работник в population независимо от того, пересекает ли его текущий
  `SiteAssignment` период (тот же принцип, что T8.2A's population path 2, только не привязан к
  одному конкретному site);
- один worker на нескольких sites — ровно один раз в company `workerCount` (Set по `employeeId`, не
  сумма per-site).

### R. Site population

Объект входит в отчёт (появляется в `sites[]`), если хотя бы одно:
1. есть `SiteAssignment` **из company population** (§Q), пересекающий период, с этим `siteId`;
2. canonical source содержит segment этого `siteId`, принадлежащий `Timesheet` этого `periodId`.

Та же union-логика, что T8.2A's собственная per-site population (§A design doc выше), применённая
сразу ко всем объектам компании одним проходом — не N вызовов `getSiteTimeReport`. Inactive
(`active: false`) или объект, чей единственный `SiteAssignment` уже закончился до периода, но с
historical segment внутри периода — не скрывается (условие 2 срабатывает независимо от условия 1).

### S. Canonical source — использование P

Один bulk-запрос `Timesheet.findMany({where: {periodId}})` (с `draft`/`currentVersion` select, как
T8.2A), затем `resolveCanonicalSource()` (§P) на каждую строку → построение `draftId → employeeId` и
`versionId → employeeId` карт → **один** `timesheetDraftSegment.findMany({where: {draftId: {in:
[...]}}})` и **один** `workSegment.findMany({where: {timesheetVersionId: {in: [...]}}})`, оба **без**
фильтра по `siteId` (в отличие от T8.2A, которому нужен только один объект) — T8.3 читает сегменты
сразу всех объектов компании за период одним проходом каждого типа.

### T. Canonical rounding bucket — `(employeeId, siteId, date)`

Тот же bucket, что T8_REPORTS_DESIGN.md §2 п.2/§3 addendum "T8 ROUNDING FOLLOW-UP" уже зафиксировали
для T8.1/T8.2:
1. Внутри bucket — сумма ms всех сегментов этого работника на этом объекте в этот день.
2. Округление `gross`/`paid break`/`unpaid break`/`worked` через `msToMinutes` — **один раз на
   bucket**.
3. **Site totals** — сумма daily-bucket чисел всех работников этого объекта (`Σ` по employeeId и
   date внутри siteId) — уже округлённых, без повторного ms-уровня.
4. **Company summary** — сумма site totals (эквивалентно прямой сумме всех company buckets — оба
   способа дают одно число, т.к. каждый bucket принадлежит ровно одному site).
5. Ни на одном уровне выше daily bucket повторное округление ms не происходит.

### U. Aggregation hierarchy и agregated DTO

`daily bucket (employeeId, siteId, date)` → `site row` (сумма daily buckets этого siteId, плюс
distinct-count'ы по этому siteId) → `company summary` (сумма site rows, плюс distinct-count'ы
company-wide). Никакого промежуточного per-worker DTO — T8.3A не возвращает employee rows вообще
(§X) — worker-level detail уже есть в T8.1 (per worker) и T8.2 (per site, с работниками).

Все count'ы (§W) вычисляются как размеры `Set<employeeId>`/`Set<date>`, собираемых при проходе по
buckets/assignments/timesheets — ни одного отдельного `COUNT(DISTINCT ...)` SQL, ни одного
per-worker/per-site JS-цикла с собственным Prisma-запросом внутри.

### V. Reconciliation с T8.1/T8.2 — обязательная сверяемость

- `periodReport.sites[i].{grossMinutes,paidBreakMinutes,unpaidBreakMinutes,workedMinutes,
  segmentCount,workedDayCount,timesheetStatusCounts}` **буквально равны** соответствующим полям
  `GET /api/admin/reports/sites/:siteId?periodId=`'s `summary` для того же `siteId`+`periodId` —
  оба читают один и тот же `(employeeId, siteId, date)` bucket, просто T8.2 фильтрует его по одному
  siteId, T8.3 группирует сразу по всем.
- `periodReport.summary.{grossMinutes,...}` **равны** `Σ periodReport.sites[i].{...}` по ПОЛНОМУ
  (непагинированному) набору sites — считается один раз, до среза страницы (§W).
- `periodReport.summary.{grossMinutes,...}` **равны** `Σ` соответствующих `total.*Minutes` из
  `GET /api/admin/reports/workers/:employeeId?periodId=` по каждому работнику company population —
  тот же bucket, просуммированный по всем employeeId вместо всех siteId.

Эти три равенства — не совпадение, а прямое следствие того, что все три отчёта (T8.1, T8.2, T8.3)
читают один и тот же canonical source (§P) и один и тот же rounding bucket (§T addendum выше,
изначально §2-3 плюс "T8 ROUNDING FOLLOW-UP"). Постоянный тест
`titanor-time-app/scripts/_test-period-time-report.ts` проверяет все три равенства через настоящие
HTTP-запросы ко всем трём endpoint (не pure-helper вызовы).

### W. Response contract, pagination, definitions

`GET /api/admin/reports/periods/:periodId?page=&pageSize=` — `page` по умолчанию 1, `pageSize` по
умолчанию 20 (max 100), та же схема валидации, что `parseSiteReportQuery` (переиспользуется паттерн,
не код — periodId здесь путь, не query param). `no-store`.

Полный response — см. текст задачи (JSON-контракт зафиксирован дословно, не повторяется здесь).
Определения:
- `summary` — по ПОЛНОМУ result set (все sites company population), не по текущей странице;
  `sites[]` — paginated;
- `participantCount`/`expectedParticipantCount`/`excludedParticipantCount` — все
  `PayrollPeriodParticipant` этого периода / с `expected=true` / `expected=false`;
- `assignedWorkerCount` (company) — distinct `employeeId` с ≥1 overlap `SiteAssignment` (любой
  объект); `workedWorkerCount` (company) — distinct `employeeId` с ≥1 canonical segment (любой
  объект); ни один multi-site работник не дублируется — `Set`, не сумма per-site;
- `withoutTimesheetCount` (company) — company population employeeId без `Timesheet` в этом периоде;
- `withoutSiteCount` (company) — company population employeeId **без** overlap `SiteAssignment`
  **и без** canonical segment (виден только через participant или через Timesheet без сегментов и
  без назначения) — диагностика "числится в периоде, но неизвестно, на каком объекте";
- `sites[i].assignedWorkerCount`/`workedWorkerCount`/`withoutTimesheetCount` — та же семантика, но
  scoped на один `siteId` (site population = assigned ∪ worked для этого site, §R);
- `workedDayCount` (company) — distinct `date` по ВСЕМ buckets company-wide; `sites[i].
  workedDayCount` — distinct `date` только этого site;
- `timesheetStatusCounts` (company) — один `Timesheet` считается ровно один раз, даже если работник
  на нескольких sites; `sites[i].timesheetStatusCounts` — по работникам site population этого
  конкретного site — **multi-site работник намеренно считается в КАЖДОМ своём site row** (документируемое
  поведение, не баг: агрегат "сколько submitted-статусов относится к этому объекту" по смыслу должен
  включать каждого причастного к объекту работника, даже если его Timesheet общий на несколько
  объектов);
- `sites` sorting: `site.name ASC, site.id ASC` (детерминированно даже при совпадающих именах).

### X. Не возвращать employee rows

T8.3A — company/site aggregates только. Ни одного employee-специфичного поля (name, employeeNumber,
id) в DTO целиком — worker-level detail уже доступен через T8.1 (`GET /api/admin/reports/workers/
:employeeId`) и T8.2 (`GET /api/admin/reports/sites/:siteId`, с per-worker items). Это одновременно
architectural-decision (не дублировать T8.2) и redaction-decision (§Y) — employeeId используется
только как ВНУТРЕННИЙ ключ группировки в памяти, никогда не сериализуется в JSON.

### Y. Permissions/redaction

Endpoint требует одновременно (проверка через `hasPermission`, не `roles.includes`, как T8.1/T8.2):
`period.read.all` + `site.read.all` + `worker.read.all` + `timesheet.read.all` — все четыре уже
существуют (T8.1/T8.2A их создали), ноль новых permissions/migrations/schema changes. Никакого
FOREMAN-варианта — T8.3A ADMIN/SUPER_ADMIN only (company-wide агрегат по определению не line up с
per-site FOREMAN scope; FOREMAN period report explicitly не в этом слайсе).

DTO структурно не содержит: employee name/number (§X), phone/email, raw GPS, точные segment
timestamps, `deviceInstallationId`/`deviceSequence`, `clientEventId`/`payloadHash`/`requestId`,
exception detail, correction reason, audit payload — тот же redaction-принцип, что T8.1/T8.2A/T8.2B
уже устанавливают (структурная невозможность утечки: поля просто не селектятся/не сериализуются).

### Z. Consistency/query-count

Одна `REPEATABLE READ` read-only транзакция, один `asOf`, зафиксированный один раз в начале. Запросы
внутри транзакции — фиксированное множество, НЕ растущее с числом workers/sites/segments:
1. `payrollPeriod.findUnique` (существование + даты + статус);
2. `siteAssignment.findMany` (company-wide overlap, без фильтра по siteId);
3. `payrollPeriodParticipant.findMany` (весь периода);
4. `timesheet.findMany` (весь период, с draft/currentVersion select);
5. `timesheetDraftSegment.findMany` (`WHERE draftId IN [...]`, только если draftIds непусто);
6. `workSegment.findMany` (`WHERE timesheetVersionId IN [...]`, только если versionIds непусто);
7. `workSite.findMany` (`WHERE id IN [...]` — только объекты, попавшие в site population).

Итого до 7 запросов + `BEGIN`/`SET TRANSACTION`/`COMMIT` — независимо от 1, 50 или 200 работников и
1, 5 или 20 объектов (доказывается фикстурами того же размера, что T8.2A уже использовал). Ноль
Prisma-запросов внутри worker/site/day циклов — вся агрегация (§U) происходит в памяти после того,
как все нужные строки уже получены bulk-запросами выше. GET создаёт ноль `AuditEvent`, не меняет
`updatedAt`/`contentRevision` ни одной строки.

## Addendum — T8.3B Payroll Period Report UI (2026-08-19)

Написано **до** реализации. UI поверх уже реализованного и не меняемого T8.3A backend
(`lib/period-time-report.ts`, `GET /api/admin/reports/periods/:periodId`). Ни contract, ни
population/bucket/aggregation backend этим addendum'ом не меняются.

### AA. Общий tab-компонент — `components/reports/AdminReportTabs.tsx`

Единственное место, где рендерится переключатель типа отчёта для ADMIN — три вкладки "By
worker"/"By site"/"By period" (`/admin/reports`, `/admin/reports/sites`, `/admin/reports/periods`),
активная помечена `aria-current="page"`, остальные — ссылки. T8.1's страница и T8.2's
`SiteTimeReportView` (только для `role="admin"`) переключены на этот компонент вместо двух
независимых inline `<nav>` — поведение (текст, href, `aria-current`) не изменилось, только источник
кода общий. FOREMAN (`SiteTimeReportView` c `role="foreman"`) по-прежнему рендерит `null` вместо
этого компонента — ни одной admin-ссылки, ни одного лишнего URL.

### AB. Route/filters — `/admin/reports/periods`

`periodId`/`page`/`pageSize` — все три в URL query (не path param, в отличие от API route, который
берёт `periodId` из пути; страница берёт его из query — тот же паттерн, что T8.1's `/admin/reports`
уже использует для `employeeId`). `page` не является полем формы — только в pagination-ссылках,
несущих текущие `periodId`+`pageSize` — смена period/pageSize через саму форму естественно уходит
на URL без `page`, структурно сбрасывая на 1 (тот же приём, что T8.2B's §K уже устанавливает).
`outcome`: `'prompt'` (ни periodId, ни page/pageSize не заданы вообще) → `'invalid'` (malformed
periodId ЛИБО malformed page/pageSize — оба источника ошибок объединяются в один `fieldErrors`,
тот же паттерн, что API route использует) → `getPeriodTimeReport()`'s собственный outcome
(`PERIOD_NOT_FOUND`/`OK`). Reload/back/forward воспроизводят отчёт — URL единственный источник
правды, Server Component без client state.

### AC. Lookup

`listPeriodOptions()` (`lib/attendance-overview-lookups.ts`, уже существует, переиспользован как
есть — тот же bounded `take: 50` список, что T8.1/T8.2B уже используют). Никаких
worker/site-специфичных lookup'ов на этой странице вообще — до выбора period ничего, кроме списка
периодов, не загружается.

### AD. `components/reports/PeriodTimeReportView.tsx`

Презентационный компонент, получает `basePath`/`rawFilters`/`periodOptions`/`outcome` как props,
ноль собственных DB/API вызовов. Рендерит: заголовок, `AdminReportTabs active="period"`, подсказку
"Hours only — no salary or payroll calculation.", период (даты + `OPEN`/`LOCKED`/`EXPORTED` +
`asOf`), company summary (все 15 полей `PeriodTimeReportSummary` дословно из задачи), timesheet
status counts (5 меток), paginated `sites[]` (per-site все 11 полей `PeriodTimeReportSite`,
`active`/`inactive` — текстовая метка, не только цвет), drill-down ссылка на `/admin/reports/sites?
siteId=<id>&periodId=<periodId>` на каждой site-строке, пагинация (переиспользует `.exc-pagination`
CSS и `buildOverviewQueryString`, тот же паттерн, что T8.2B уже устанавливает). Никакого
пересчёта/суммирования чисел — только `formatWorkedDuration`/`timesheetStatusLabel` из уже
существующего `lib/reporting/report-format.ts`.

### AE. Cross-links

`/admin/periods/[periodId]` получает третью ссылку "View full period report" →
`/admin/reports/periods?periodId=<id>` (рядом с уже существующими "View a worker's..."/"View a
site's..." из T8.1/T8.2B — обе не убираются, не меняются). Никакого CSV/PDF/export action на этой
странице — то T8.4, вне scope.

### AF. Security — DTO уже redaction-safe (T8.3A), UI ничего не добавляет

`lib/period-time-report.ts`'s DTO (T8.3A) уже структурно не содержит employee name/number/id,
phone/email/GPS/device identifiers/payload/hash/requestId/exception detail/correction reason/audit
payload (T8_REPORTS_DESIGN.md Addendum "T8.3A" §Y) — UI-слой ничего нового не может утечь: рендерятся
только поля, уже присутствующие в типизированном `PeriodTimeReport`. Blanket HTML/network scan —
дополнительное доказательство, не единственная защита.
