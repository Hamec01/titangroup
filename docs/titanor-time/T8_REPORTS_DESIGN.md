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

## Addendum — T8.4A CSV Export Schema Foundation (2026-08-19)

Написано **до** изменения schema. Только неизменяемая DB-модель для будущих CSV-экспортов и
permissions — ноль генерации CSV, ноль export API, ноль download endpoint, ноль `/admin/export`
UI, ноль PDF, ноль зарплаты/ставок/TES-категорий. Это фундамент, на который T8.4B (генерация +
API + download) и T8.4C (admin UI) будут опираться.

### AG. CSV_V1 — отчёт рабочего времени, не payroll export

`ExportBatch.format = CSV_V1` — это первый (и на сегодня единственный) формат. Он документирует
рабочее время (gross/paid break/unpaid break/worked minutes, сегменты) по образцу T8.1/T8.2/T8.3 —
**не** зарплату. Ни одного денежного поля, ни одной payroll-категории (overtime/night/sunday/
holiday/travel) в `ExportBatch`/`ExportItem` нет и не планируется в CSV_V1 — они отложены до
отдельного, отдельно утверждённого payroll/TES-этапа (см. §0 design doc выше — тот же принцип,
что T8.1–T8.3 уже устанавливают для всего ЭТАПа 8).

### AH. Canonical bucket — без изменений

`(employeeId, siteId, date)` — тот же bucket, что T8.1/T8.2/T8.3 (см. §2-3 плюс "T8 ROUNDING
FOLLOW-UP" addendum выше). `ExportItem` — это строка на bucket: один `(exportBatchId, employeeId,
siteId, date)` — `@@unique`, зеркалирует сам bucket один-в-один. `grossMinutes`/`paidBreakMinutes`/
`unpaidBreakMinutes` на строке `ExportItem` — те же уже округлённые daily-bucket числа, что
T8.1/T8.2/T8.3 уже вычисляют через `lib/reporting/worked-time.ts`; любые более высокие уровни
(будущий company/period totals row, если T8.4B его добавит) обязаны складываться только из уже
округлённых `ExportItem`-строк, никогда не пересчитывать ms заново — тот же принцип, что
T8.1–T8.3 уже устанавливают.

### AI. `ExportItem.workedMinutes` — canonical worked-time semantics (исправлено `[2026-08-19]` FOLLOW-UP)

**Текущее состояние (после FOLLOW-UP-миграции `20260819170000_fix_export_item_worked_minutes_bounds`)**:
`ExportItem.workedMinutes` использует **ту же** canonical worked-time семантику, что и `lib/
reporting/worked-time.ts` (`computeSegmentMs`) и, транзитивно, T8.1/T8.2/T8.3's собственные
`workedMinutes`-поля:

```
workedMs = grossMs - unpaidBreakMs   (paid break ОСТАЁТСЯ внутри workedMs, не вычитается)
```

**CSV_V1, T8.1, T8.2 и T8.3 используют одну и ту же canonical worked-time семантику и обязаны
давать одинаковые bucket totals** для одного и того же `(employeeId, siteId, date)` — это теперь
явный, зафиксированный инвариант, не расхождение, которое T8.4B должен был бы воспроизводить
отдельно.

**История (первая версия T8.4A, исправлена этим FOLLOW-UP'ом, сохранена здесь для
прозрачности)**: исходная задача T8.4A по ошибке явно требовала другой CHECK-предикат —
`workedMinutes = max(0, grossMinutes - paidBreakMinutes - unpaidBreakMinutes)` — который вычитал
paid break из worked time, расходясь с canonical формулой на любом bucket с хотя бы одним paid
break (пример: gross=60, paid=15, unpaid=0 → canonical worked=60, старая формула давала 45). Этот
CHECK (`ck_export_item_worked_minutes_formula`, CK-43) был реализован дословно по тексту задачи в
исходной миграции `20260819150000_add_export_batch_schema` и явно задокументирован здесь как
"расхождение" с инструкцией для T8.4B вычислять `workedMinutes` по ЭТОЙ (неверной) формуле. Дальнейший
review выявил, что сама эта формула была ошибкой спецификации, а не намеренным design-решением —
FOLLOW-UP-задача её отменила.

**Почему арифметическое равенство между этими тремя колонками невозможно в принципе (не только
исходная формула была неверна)**: `grossMinutes`, `paidBreakMinutes`, `unpaidBreakMinutes` и
`workedMinutes` каждый независимо округляется от своего собственного ms-значения на уровне ОДНОГО
bucket (`msToMinutes = Math.round(ms / 60000)`), а не выводится из других уже округлённых колонок.
Независимое округление не коммутирует с вычитанием. Контрпример: `grossMs=31000` (31с) →
`grossMinutes=round(31000/60000)=1`; `unpaidBreakMs=29000` (29с) → `unpaidBreakMinutes=round(29000/
60000)=0`; `workedMs=2000` (2с) → `workedMinutes=round(2000/60000)=0`. Но `grossMinutes -
unpaidBreakMinutes = 1 - 0 = 1 ≠ 0`. Значит, никакой CHECK, выражающий точное арифметическое
равенство между уже округлёнными целочисленными колонками, не может держаться в общем случае — даже
формула `workedMinutes = grossMinutes - unpaidBreakMinutes` (без paid-члена) не является валидным DB-
инвариантом.

**Замена**: `ck_export_item_worked_minutes_formula` (CK-43) — **удалён**. Новый CHECK
`ck_export_item_minute_bounds` (CK-44) — слабее, но верен всегда независимо от округления:
`workedMinutes <= grossMinutes AND paidBreakMinutes <= grossMinutes AND unpaidBreakMinutes <=
grossMinutes`. Существующий `ck_export_item_minutes_nonnegative` не тронут.

**Что это означает для T8.4B**: `ExportItem.workedMinutes` должен буквально содержать canonical
daily-bucket `workedMinutes`, вычисленный так же, как T8.1/T8.2/T8.3 уже это делают —
`computeSegmentMs()` → суммирование внутри `(employeeId, siteId, date)` → `msToMinutes(workedMs)`.
T8.4B **обязан переиспользовать** этот путь (например, через `lib/reporting/canonical-source.ts` +
`lib/reporting/worked-time.ts`), а не вычислять `ExportItem.workedMinutes` какой-то отдельной,
собственной формулой — предыдущая версия этого документа ошибочно требовала обратное, эта
инструкция удалена. Paid break учитывается на строке отдельно (`paidBreakMinutes`) для отчётности,
но никогда не вычитается из worked time — ни здесь, ни где-либо ещё на ЭТАПе 8.

### AJ. FULL/CORRECTION semantics

- **FULL** — `correctsBatchId IS NULL` (CHECK). Один FULL на period — `ux_export_batch_full_per_period`,
  partial unique index `("periodId") WHERE "kind" = 'FULL'`.
- **CORRECTION** — `correctsBatchId IS NOT NULL` (CHECK), обязан ссылаться на batch **того же**
  period (`fn_export_batch_correction_chain_check`, поскольку ни CHECK, ни FK не может сравнить
  колонку одной строки с колонкой ДРУГОЙ строки — нужен trigger). Predecessor может быть FULL или
  предыдущим CORRECTION — никакого дополнительного ограничения на тип predecessor не накладывается
  (уже разрешено самой природой self-FK). Self-reference (`correctsBatchId = id`) отклоняется CHECK
  `ck_export_batch_no_self_correction`. Цикл структурно недостижим через чистый INSERT-путь (batch
  обязан существовать ДО того, как на него можно сослаться, а строки immutable — future batch не
  может задним числом "стать" предком уже существующего), но trigger всё равно проверяет цикл
  явно (`WITH RECURSIVE` вверх по цепочке) — defense-in-depth и тестируемость требования, а не
  единственная защита.
- **Период-статус gating** (FULL только для `LOCKED` period; CORRECTION только для `EXPORTED`
  period при наличии `APPROVED` `CorrectionRequest` с `pendingExport=true`) — **документируется
  здесь, но НЕ enforced DB-constraint'ом в T8.4A**. Причина: это не входит в явный список из 14
  DB-инвариантов задачи (структурные свойства `ExportBatch`/`ExportItem` — то, что список
  перечисляет), а требует чтения МУТАБЕЛЬНОЙ колонки на ДРУГОЙ таблице (`PayrollPeriod.status`,
  `CorrectionRequest.status`/`pendingExport`) в момент создания batch — то есть это gate уровня
  create-batch service, которого в этом слайсе физически не существует (T8.4B). `CorrectionRequest.
  pendingExport` (уже существующее поле, не создаётся заново) — единственный крючок, который T8.4B
  будет читать для этого.

### AK. Immutable bytes — decision

`ExportBatch.content` хранит **точные сформированные bytes** (Postgres `bytea`), не путь к файлу и
не JSON-реконструкцию. Причина: последующий download (T8.4B) не должен зависеть от того, изменились
ли имена работников/объектов (snapshot-колонки на `ExportItem` уже решают эту часть для
per-row данных), от доступности файловой системы, или от повторной генерации, которая могла бы
дать иной byte-for-byte результат при изменении форматирующего кода между генерацией и загрузкой.
`fileSizeBytes` обязан буквально равняться `octet_length(content)` (CHECK) — колонка не может
разъехаться с реальным содержимым. `fileHash` — lowercase SHA-256 hex ровно 64 символа (CHECK,
regex) — вычисляется на уровне приложения (T8.4B) над `content` и хранится для integrity-проверки
без повторного чтения полного blob'а на каждый запрос списка.

### AL. PDF / payroll — явно отложены

PDF не входит в CSV_V1 и не имеет собственного `ExportFormat` значения в этой миграции —
добавление `PDF_V1` (или аналога) в enum `ExportFormat` — отдельная будущая additive-миграция,
не в этом слайсе. `overtime`/`night`/`sunday`/`holiday`/`travel`/любые денежные категории —
отдельный, отдельно утверждённый payroll/TES-этап, ни одного поля для них в этой schema нет.

### AM. Статус реализации — `[2026-08-19]` завершено

Реализовано ровно то, что описано в §AG–AL, без отклонений от спецификации задачи по 14
DB-инвариантам. `scripts/_test-export-batch-schema.ts` — 51 проверка на 23 пронумерованных
сценариях задачи, 100% pass на disposable PostgreSQL 16 (включая отдельный dump/restore на втором
одноразовом экземпляре). Полная регрессия T8.1–T8.3/rounding-consistency/activation/corrections —
без изменений, без побочных эффектов. Единственная находка при тестировании — порядок исполнения
`BEFORE ROW` trigger'ов раньше CHECK constraint'ов в PostgreSQL означает, что два конкретных
негативных случая (`CORRECTION` без `correctsBatchId`; self-reference) отклоняются с identifier'ом
FN-25 (`EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND`), а не CK-37/CK-38 — сама строка всё равно
всегда отклоняется, различается только то, какой identifier наблюдает вызывающий код;
задокументировано подробно в `05_RAW_SQL_REGISTER.md` §12 (CK-37/CK-38 entries). T8.4B (генерация/
API/download) и T8.4C (admin UI) этим коммитом не начаты.

### AN. FOLLOW-UP — canonical worked-time semantics, статус `[2026-08-19]` завершено

Исправлен ошибочный DB-инвариант из §AI (см. исправленный текст §AI выше — историческая версия
сохранена там же для прозрачности, не удалена молча). Corrective migration
`20260819170000_fix_export_item_worked_minutes_bounds` — additive, не редактирует уже закоммиченную
`20260819150000_add_export_batch_schema`. `ck_export_item_worked_minutes_formula` (CK-43) удалён;
`ck_export_item_minute_bounds` (CK-44) добавлен. `scripts/_test-export-batch-schema.ts` расширен —
68 проверок (было 51), включая 15 FOLLOW-UP-сценариев (FU-1..FU-15, из них FU-1/2/12/13/15
переиспользуют уже существующие проверки 1/2/14b/18-19/4-5 вместо дублирования), 100% pass на
disposable PostgreSQL 16, включая повторный dump/restore на отдельном одноразовом экземпляре
(новый constraint подтверждён переживающим restore). Полная регрессия
rounding-consistency (105/105) и T8.3A period-time-report (110/110) — без изменений. `lib/
reporting/worked-time.ts`, T8.1/T8.2/T8.3 services/DTO/API, колонки `ExportBatch`/`ExportItem`,
permissions и старые миграции — не тронуты. T8.4B/T8.4C по-прежнему не начаты.

## Addendum — T8.4B Immutable CSV Generation, Export APIs and Download (2026-08-19)

Написано **до** реализации, как требует STOP-GATE задачи. Строит генерацию/API/download поверх
уже реализованного и не редактируемого T8.4A schema foundation (§AG–AN выше). Явно не входит:
`/admin/export` UI (T8.4C, отдельный слайс), PDF, зарплата/ставки/TES-категории
(overtime/night/sunday/holiday/travel), production deployment.

### BA. FULL export — semantics

- Разрешён **только** для `PayrollPeriod.status = LOCKED`.
- Population — **ровно** `PayrollPeriodParticipant.expected = true` этого `periodId`. Это **не** та
  же (более широкая, union-based) population, что T8.1–T8.3 используют — здесь она намеренно узкая
  и буквальная, как того требует задача: только официально ожидаемые участники периода, ни assignment-
  only, ни segment-only "исторические" работники (T8.2A §A/T8.3A §Q) сюда не попадают. Не-`expected`
  (`excluded`) участники периода **никогда** не появляются ни в одном `ExportBatch` (ни FULL, ни
  CORRECTION) — это тот же смысл, что `expected=false` уже несёт в T8.1–T8.3 ("официально исключён
  из отчётности за этот период"), только здесь population вообще не строит union с assignment/segment
  путями.
- Каждый expected participant **обязан** иметь `Timesheet.status = FINAL_APPROVED` и непустой,
  валидный `currentVersionId` — это уже гарантировано существующим инвариантом `period.lock`
  (`lib/periods.ts::lockPeriod` не переводит период в `LOCKED`, пока хотя бы один expected participant
  не `FINAL_APPROVED`, §"Владелец блокеров" — `LockBlocker[]`), но `lib/csv-export.ts` **не доверяет**
  этому проверенному-в-прошлом факту слепо: он перечитывает и валидирует его заново внутри своей
  собственной транзакции (тот же "TOCTOU-safe re-check under the lock" принцип, что `lockPeriod` уже
  устанавливает для себя). Нарушение инварианта (participant без Timesheet, либо Timesheet не
  `FINAL_APPROVED`, либо `currentVersionId`/`currentVersion` отсутствует) — **throw** (500,
  safe-логированный), никогда не молчаливый пропуск строки — тот же принцип, что
  `resolveCanonicalSource` уже устанавливает для T8.1–T8.3 (§1 выше).
- Данные — только из immutable current `TimesheetVersion` (`WorkSegment`/`BreakSegment` по
  `currentVersionId`) — FULL/CORRECTION **никогда** не читают `TimesheetDraft` (в отличие от
  T8.1–T8.3, которые переключаются по статусу — здесь статус всегда `FINAL_APPROVED`, поэтому
  единственный источник и есть `CURRENT_VERSION`; `lib/csv-export.ts` не импортирует
  `resolveCanonicalSource`/`usesDraftSource` вообще — они не нужны, ветвление там было бы мёртвым
  кодом).
- После успешной транзакции: `PayrollPeriod.status: LOCKED → EXPORTED`, `exportedAt` устанавливается
  **один раз** (только эта единственная FULL-транзакция когда-либо переводит период в `EXPORTED` —
  CORRECTION никогда не трогает `exportedAt`, он уже установлен).
- Ровно один FULL batch на period — гарантировано на трёх независимых уровнях: (1) сервисная логика
  ниже (§BF) читает `PayrollPeriod.status` под `FOR UPDATE`-локом и создаёт FULL только пока статус
  `LOCKED`; как только он становится `EXPORTED` внутри той же транзакции, следующий вызов (после
  коммита) уже не видит `LOCKED`; (2) T8.4A's `ux_export_batch_full_per_period` (partial unique index)
  — DB-уровневый backstop даже если бы сервисная логика содержала баг; (3) конкурентный тест §BJ.

### BB. CORRECTION export — semantics

- Разрешён **только** для `PayrollPeriod.status = EXPORTED`.
- Требует минимум один `CorrectionRequest(status=APPROVED, pendingExport=true)`, **чей `Timesheet`
  принадлежит expected-участнику этого периода** (см. §BC ниже за обоснование этого сужения — задача
  не описывает этот пограничный случай явно, это задокументированное архитектурное решение этого
  слайса). Если таких нет — `409 NOTHING_TO_EXPORT`, batch не создаётся.
- Создаёт **полный replacement snapshot** всех expected participants периода — **буквально та же**
  population-логика, что FULL (§BA), не CSV-дельту. Причина (дословно из задачи, подтверждена
  архитектурно): отсутствие строки `(employeeId, siteId, date)` в новом snapshot, которая
  присутствовала в предыдущем batch, — единственный способ корректно представить "этот bucket больше
  не существует" (например, последний рабочий сегмент дня был удалён корректировкой) без отдельного
  tombstone/delete-маркера в append-only CSV формате. Consumer (внешняя payroll-система) обязан
  **заменить** предыдущий snapshot новым **целиком**, не накладывать построчный diff.
- `correctsBatchId` указывает на **последний committed batch** этого period — `ExportBatch` этого
  `periodId` с максимальным `createdAt` (`id DESC` как детерминированный tie-break на случай равного
  `createdAt`, той же гранулярности, что и `ExportBatch_periodId_createdAt_id_idx`, T8.4A). Это может
  быть либо FULL, либо более ранний CORRECTION — самой FK/trigger-схемой (T8.4A FN-25) оба варианта
  уже разрешены, T8.4B не добавляет ограничения на тип предшественника.
- Старые `ExportBatch`/`ExportItem` строки **не изменяются** — immutability-триггеры (T8.4A FN-23/24)
  и так физически запрещают `UPDATE`/`DELETE`; T8.4B ничего не пишет в уже существующие batch/item.
- Все pending corrections, **зафиксированные транзакцией** (т.е. видимые под `FOR UPDATE`-локом в
  момент построения snapshot — см. §BF шаг 4/11), связываются с новым batch:
  `coveredByExportBatchId = <новый batch id>`, `pendingExport = false`. Correction, `APPROVED`
  **после** того, как эта транзакция уже сделала свой snapshot/commit, остаётся `pendingExport=true`
  для следующего вызова `export.create` — она физически не могла быть частью snapshot, который
  строился до её появления.

### BC. Correction coverage — scoping to expected participants (документированное архитектурное решение)

`pendingExport=true` correction, чей `Timesheet` принадлежит **не-expected** (excluded) участнику
периода, никогда не входит ни в FULL, ни в CORRECTION population (§BA читает только `expected=true`
participants) — excluded участник структурно никогда не попадает ни в один `ExportItem` ни одного
batch. Eligibility-проверка (`§BB` — "минимум один pending correction") и coverage-шаг (§BF шаг 4/11)
оба scoped к тем же `employeeId`, что и population — pending correction excluded-участника никогда
не делает batch "нужным" (`NOTHING_TO_EXPORT`, если это единственная pending correction периода) и
никогда не покрывается никаким batch.

**`[2026-08-19]` T8.4B FOLLOW-UP — исправлен смежный баг спецификации, найденный после
первоначальной реализации.** Первая версия этого addendum'а здесь ошибочно утверждала, что
`pendingExport` такой correction "остаётся `true` навсегда" — то есть `decideCorrection` сначала
СТАВИЛ `pendingExport=true` (формула была буквально `period.status === 'EXPORTED'`, без учёта
`expected`), а уже потом eligibility/coverage просто никогда её не трогали. Это создавало реально
недостижимое, противоречивое состояние: `pendingExport=true` навечно у correction, которая
структурно никогда не может быть покрыта ни одним batch — не "правильно исключённая из экспорта
запись" (как `expected=false` означает везде в T8.1–T8.3), а сломанный, вводящий в заблуждение флаг.
`pendingExport` обязан значить "существует реальный export snapshot, который мог бы покрыть эту
correction, и ещё не покрыл" — а не просто "correction была одобрена после того, как период стал
`EXPORTED`".

**Исправленная формула** (`lib/corrections.ts::decideCorrection`, читается внутри уже существующей
authoritative FOR-UPDATE-locked транзакции, без отдельного unlocked pre-read):

```
pendingExport =
  period.status === 'EXPORTED'
  AND PayrollPeriodParticipant.expected === true
```

Excluded participant + `EXPORTED` → `pendingExport=false` сразу, `coveredByExportBatchId` остаётся
`null` — то же самое "формально удовлетворено, реально не покрыто" не возникает вообще, потому что
`pendingExport` никогда не становится `true` для такой correction в первую очередь. `LOCKED`/`OPEN`
периоды — `pendingExport=false`, как и раньше (без изменений).

**DB enforcement** — `fn_correction_request_covered_batch_check` (FN-26/TRG-31, тот же trigger, не
новый) расширен дополнительной веткой: `NEW.pendingExport=true` теперь cross-table-проверяется на
`PayrollPeriod.status=EXPORTED` И `PayrollPeriodParticipant.expected=true` (through the correction's
own `Timesheet`), поверх уже существующих same-row условий `ck_correction_request_pending_export_
shape` (CK-45 — `status=APPROVED`, `resultingVersionId IS NOT NULL`, `coveredByExportBatchId IS
NULL`, не переизобретены в триггере). Additive corrective migration
`20260819190000_fix_correction_pending_export_excluded_participant` — не редактирует
`20260819180000`. Полная регистрация — `05_RAW_SQL_REGISTER.md` §13 (FN-26 запись расширена, не
заменена — историческая версия видна там же).

**Legacy repair**: та же миграция атомарно приводит любые уже существующие строки с
`pendingExport=true` при отсутствующем/excluded участнике к `pendingExport=false,
coveredByExportBatchId=NULL` — количество затронутых строк считается и логируется через `RAISE
NOTICE` (только целое число, без employee/correction/reason данных) до repair.

Проверено тестами: `scripts/_test-csv-export.ts`, сценарии "excluded participant pending correction
never becomes true / never blocks / never gets covered" + прямые SQL-негативные тесты на новую
trigger-ветку.

### BD. Canonical arithmetic — `lib/reporting/canonical-daily-buckets.ts`

Bucket — `(employeeId, siteId, date)`, буквально тот же, что T8.1–T8.3 (§2-3 плюс "T8 ROUNDING
FOLLOW-UP" addendum выше) и T8.4A's `ExportItem` (§AH). Новый чистый (`ноль Prisma/HTTP/UI`)
reusable-модуль:

```ts
export interface CanonicalDailyBucketSegmentInput {
  employeeId: string;
  timesheetVersionId: string | null;
  siteId: string;
  date: Date;
  startAt: Date;
  endAt: Date;
  breaks: WorkedTimeBreakInput[];
}

export interface CanonicalDailyBucket {
  employeeId: string;
  timesheetVersionId: string | null;
  siteId: string;
  date: string; // YYYY-MM-DD
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
}

export function buildCanonicalDailyBuckets(segments: CanonicalDailyBucketSegmentInput[]): CanonicalDailyBucket[]
```

Группирует по `(employeeId, siteId, formatDate(date))`, суммирует ms всех сегментов bucket'а через
`computeSegmentMs`/`sumWorkedTimeMs` (буквально `lib/reporting/worked-time.ts`, без копии формулы),
округляет **один раз на bucket** через `msToMinutes` — тот же §2 п.2 rounding rule. `timesheetVersionId`
— `string | null`, а не обязательный `string`: T8.1–T8.3 иногда читают `TimesheetDraft`-сегменты (нет
версии вообще), поэтому строгая обязательность поля сделала бы helper непригодным для них без
фиктивного значения. CSV_V1 (единственный вызывающий, где источник всегда `CURRENT_VERSION` — §BA)
всегда передаёт реальный `timesheetVersionId`; helper не проверяет и не требует его непустоты — это
обязанность вызывающего (`lib/csv-export.ts` уже отвергает FULL/CORRECTION population без
`currentVersionId` до вызова helper'а, §BA).

**Никакого повторного округления выше bucket-уровня** — `ExportItem` пишет уже округлённые
bucket-числа буквально как helper их вернул; более высоких уровней агрегации (site/period totals) в
CSV_V1 нет вообще (одна CSV data row = один bucket, §BG) — поэтому вопрос "повторной суммы округлённых
чисел", актуальный для T8.1–T8.3, здесь не возникает: нет более высокого уровня, который бы что-то
складывал.

**T8.3 переключён на этот helper** (обязательное минимальное требование задачи — "Минимум T8.3 и
новый CSV service должны использовать этот helper"). `lib/period-time-report.ts`'s инлайновый
`bucketMap`/`roundedBuckets`-блок (было: локальная `Map<string, {...}>` + локальный
`sumWorkedTimeMs`/`msToMinutes`-проход) заменён на прямой вызов `buildCanonicalDailyBuckets()`,
передавая `timesheetVersionId: null` для draft-сегментов (T8.3 не использует это поле дальше — его
собственный `DailyBucketMinutes`-DTO как не имел, так и не имеет `timesheetVersionId`) и реальный
`s.timesheetVersionId` для version-сегментов. Поведение/DTO/query count **не изменились** — доказано
регрессией (`_test-report-rounding-consistency.ts` 105/105, `_test-period-time-report.ts` 110/110,
оба без изменений численных результатов до/после переключения).

**T8.1 (`lib/worker-time-report.ts`) и T8.2 (`lib/site-time-report.ts`) НЕ переключены** —
задокументированное, разрешённое задачей решение ("Если это создаёт ненужный риск, оставить их и
доказать равенство regression-тестами"). Причина: их собственная внутренняя группировка уже
фиксирует одно измерение bucket'а через URL (T8.1 фиксирует `employeeId`, группирует только по
`(siteId, date)`; T8.2 фиксирует `siteId`, группирует только по `(employeeId используется отдельно,
date)`) — принудительное протягивание через общий 3-осевой `(employeeId, siteId, date)`-helper
потребовало бы реструктуризации их собственного, уже полностью протестированного и задеплоенного
grouping-кода (57/57 и 80/80 own regression) ради нулевой продуктовой выгоды (арифметика и так уже
общая через `lib/reporting/worked-time.ts` — дублируется только сама group-by-Map-механика, не
формула). Эквивалентность их текущей арифметики T8.3/CSV_V1 доказывается тем же
`_test-report-rounding-consistency.ts` (105/105) и явными cross-endpoint reconciliation-тестами T8.3A
(§V design doc выше) — не нужен отдельный повторный proof в этом addendum.

**Никакого `localeCompare`** нигде в byte-deterministic export path (helper сам не сортирует —
сортировка бакетов в CSV-строки происходит в `lib/csv-export.ts`, §BH).

### BE. Schema completion — `CorrectionRequest.coveredByExportBatchId`

Additive migration `20260819180000_add_correction_covered_by_export_batch` (не редактирует ни
`20260819150000_add_export_batch_schema`, ни `20260819170000_fix_export_item_worked_minutes_bounds`).

Prisma:

```prisma
model CorrectionRequest {
  // ...существующие поля без изменений...
  coveredByExportBatchId String?      @db.Uuid
  coveredByExportBatch   ExportBatch? @relation("ExportBatchCoveredCorrections", fields: [coveredByExportBatchId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  // ...существующие индексы...
  @@index([coveredByExportBatchId])
}

model ExportBatch {
  // ...существующие поля без изменений...
  coveredCorrections CorrectionRequest[] @relation("ExportBatchCoveredCorrections")
}
```

Raw SQL (Section B, зарегистрировано `05_RAW_SQL_REGISTER.md` §13):

- Столбец + FK (`ON DELETE RESTRICT` — покрытая correction не даёт удалить свой batch; batch и так
  immutable/неудаляем через FN-23, это защита на случай гипотетического будущего изменения того
  триггера) + индекс `CorrectionRequest(coveredByExportBatchId)` — буквально как в задаче.
- **CK-45 `ck_correction_request_pending_export_shape`**: `NOT "pendingExport" OR ("status" =
  'APPROVED' AND "resultingVersionId" IS NOT NULL AND "coveredByExportBatchId" IS NULL)`.
- **CK-46 `ck_correction_request_covered_shape`**: `"coveredByExportBatchId" IS NULL OR ("status" =
  'APPROVED' AND "resultingVersionId" IS NOT NULL AND NOT "pendingExport")`.
- **FN-26 `fn_correction_request_covered_batch_check`** / **TRG-31
  `trg_correction_request_covered_batch_check`** (`BEFORE INSERT OR UPDATE` — в отличие от
  `ExportBatch`/`ExportItem`, `CorrectionRequest` остаётся mutable-таблицей, поэтому здесь нужен и
  `UPDATE`-путь, не только `INSERT`, в отличие от FN-25):
  1. Immutability одного конкретного поля: `IF TG_OP = 'UPDATE' AND OLD."coveredByExportBatchId" IS
     NOT NULL AND NEW."coveredByExportBatchId" IS DISTINCT FROM OLD."coveredByExportBatchId"` →
     `CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE`. Проверяется **первой**, безусловно — даже если
     остальная строка меняется, однажды установленный `coveredByExportBatchId` никогда не может ни
     очиститься, ни замениться на другой batch.
  2. Только в момент **перехода** `NULL → значение` (`TG_OP = 'INSERT'` **или** `OLD.
     coveredByExportBatchId IS NULL`) — валидирует ссылку: batch существует
     (`CORRECTION_REQUEST_COVERED_BATCH_NOT_FOUND` — belt-and-suspenders рядом с самим FK, тот же
     стиль, что FN-25 уже устанавливает для `ExportBatch.correctsBatchId`), `batch.kind = 'CORRECTION'`
     (`CORRECTION_REQUEST_COVERED_BATCH_WRONG_KIND`), `batch.periodId` совпадает с `Timesheet.periodId`
     этого correction request'а (`CORRECTION_REQUEST_COVERED_BATCH_PERIOD_MISMATCH`, тот же паттерн
     cross-table сравнения, что FN-25 уже использует для `correctsBatchId`'s period).
  - Row-lock contract: читает `ExportBatch`/`Timesheet` плоским `SELECT` без явного лока — оба чтения
    происходят **внутри** транзакции `lib/csv-export.ts`, которая уже держит `FOR UPDATE` на
    затрагиваемых `Timesheet`/`CorrectionRequest`/`PayrollPeriod` строках (§BF) и никогда не читает
    ещё не закоммиченный `ExportBatch` (тот вставляется в этой же транзакции раньше UPDATE
    `CorrectionRequest`, см. §BF порядок шагов) — нет TOCTOU-окна.
- **Ordering note (тот же класс, что T8.4A's CK-37/38 vs FN-25)**: `BEFORE ROW`-триггеры выполняются
  раньше CHECK на том же `INSERT`/`UPDATE`. Установка `coveredByExportBatchId` на batch неправильного
  `kind` всегда наблюдается как `CORRECTION_REQUEST_COVERED_BATCH_WRONG_KIND` (из триггера), а не как
  какое-либо нарушение CK-45/46 — но CK-45/46 сами по себе (проверка status/resultingVersionId/
  pendingExport shape **без** упоминания `coveredByExportBatchId`'s ссылочной валидности) остаются
  полностью независимо достижимы через прямой `INSERT`/`UPDATE`, не пересекающийся с триггером's
  условиями (например: `pendingExport=true` с `status != APPROVED`, без затрагивания
  `coveredByExportBatchId` вообще — чистое попадание в CK-45, триггер даже не запускает свою
  валидационную ветку).

Никакие старые миграции не редактируются. Полная регистрация — `05_RAW_SQL_REGISTER.md` §13.

### BF. Service layer — `lib/csv-export.ts`

Единый владелец CSV_V1-логики. Экспортирует:

```ts
export async function createExportBatch(periodId: string, actorUserId: string, requestId: string): Promise<CreateExportBatchResult | CreateExportBatchError>
export async function listExportBatches(filter, pagination): Promise<ExportBatchListResult>
export async function getExportBatchDetail(batchId: string, itemPagination): Promise<ExportBatchDetail | null>
export async function getExportBatchDownload(batchId: string): Promise<{ fileName: string; fileHash: string; content: Buffer } | null>
```

`createExportBatch` — одна `prisma.$transaction`, шаги буквально по задаче:

1. `SELECT ... FROM "PayrollPeriod" WHERE id = $1 FOR UPDATE` — тот же idiom, что `lockPeriod`.
2. Re-read `status` под локом. `OPEN` → `PERIOD_NOT_EXPORTABLE`. `LOCKED` → `kind = FULL`. `EXPORTED`
   → смотреть шаг 3 для eligibility. Любой другой (structurally unreachable, `PayrollPeriodStatus` —
   закрытый enum из трёх значений) не имеет отдельной ветки.
3. Для `EXPORTED`: читает expected participant `employeeId[]` (нужны для eligibility-scoping, §BC) и
   считает `CorrectionRequest.count({status: APPROVED, pendingExport: true, timesheet: {periodId,
   employeeId: {in: expectedEmployeeIds}}})`. Ноль → `NOTHING_TO_EXPORT`. Иначе → `kind = CORRECTION`.
4. Timesheet rows expected participants блокируются `FOR UPDATE` в порядке `ORDER BY id` (тот же
   `SELECT id FROM "Timesheet" WHERE id = ANY($1) ORDER BY id FOR UPDATE` idiom, что `createPeriod`
   уже использует для `Employee`). Для `CORRECTION` — следом, pending `CorrectionRequest` рядов (тот
   же eligibility-scope, что шаг 3) блокируются `ORDER BY id FOR UPDATE`.
5. Свежепрочитанный (под локом) `currentVersionId` каждого expected Timesheet фиксируется — инвариант
   (`FINAL_APPROVED` + непустой `currentVersionId`) проверяется здесь; нарушение → throw (§BA).
6. Один `employee.findMany({where: {id: {in: employeeIds}}})`, один
   `workSegment.findMany({where: {timesheetVersionId: {in: versionIds}}, include: {breaks: true}})`
   (включает breaks через `include`, не отдельный запрос на сегмент), один `workSite.findMany`
   ограниченный только теми `siteId`, что реально встретились в сегментах — все три set-based, ни
   одного запроса внутри worker/day-цикла.
7. `buildCanonicalDailyBuckets()` (§BD) над всеми сегментами разом.
8. `randomUUID()` для batch id — **до** генерации CSV bytes (нужен внутри каждой строки, §BH). CSV
   bytes/hash/fileName/fileSizeBytes строятся чистой функцией (§BG-BI) над отсортированными buckets +
   snapshot-полями (resolved из шага 6's employee/site maps).
9. `tx.exportBatch.create({data: {id: batchId, ...}})`.
10. `tx.exportItem.createMany({data: rows})` — один bulk insert, не цикл `create()` на строку.
11. `CORRECTION`: `tx.correctionRequest.updateMany({where: {id: {in: pendingIds}}, data:
    {coveredByExportBatchId: batchId, pendingExport: false}})`.
12. `FULL`: `tx.payrollPeriod.update({where: {id: periodId}, data: {status: 'EXPORTED', exportedAt:
    new Date()}})`.
13. Один `createAuditEvent(tx, {eventType: 'EXPORT_CREATED', ...})` — только whitelisted поля (§BM).
14. Commit — функция возвращает `{ batch, period, coveredCorrectionCount }`.

Транзакционные опции — `{ maxWait: 10_000, timeout: 20_000 }`, **без** `isolationLevel` override —
т.е. Postgres/Prisma's обычный default `READ COMMITTED`, **не** `RepeatableRead`, который T8.1-T8.3's
`*_TX_OPTIONS` использует. Это не тот же паттерн, что read-only отчёты, а тот же паттерн, что
`lib/periods.ts::lockPeriod`/`lib/corrections.ts::decideCorrection` — обе тоже "лочим FOR UPDATE,
затем перечитываем и условно пишем", обе тоже без isolation override. Причина, найденная эмпирически
при написании тестов D37/D38 (два конкурентных export'а): под `RepeatableRead` `SELECT ... FOR UPDATE`,
который блокируется за уже держащим лок конкурентом и затем разблокируется после его коммита, не
просто перечитывает свежую закоммиченную строку — Postgres поднимает настоящий `40001 could not
serialize access due to concurrent update`, потому что `RepeatableRead`-транзакция не имеет права
увидеть запись, сделанную транзакцией, которая закоммитилась ПОСЛЕ начала её собственного snapshot.
`READ COMMITTED` не имеет этой проблемы — заблокированный `FOR UPDATE` после разблокировки просто
видит свежую строку, ровно то поведение, на которое рассчитаны шаги "залочили → перечитали fresh
state" по всему §BF. Единственный реальный concurrency-риск по-прежнему сериализуется явными
`FOR UPDATE`-локами шагов 1/4, не изоляцией транзакции — но именно поэтому `READ COMMITTED`
достаточен и корректен, а `RepeatableRead` был бы не просто избыточен, а активно ошибочен здесь.

### BG. CSV_V1 — exact byte contract

Зафиксировано буквально по тексту задачи, реализовано в `lib/csv-export.ts`:

- Encoding UTF-8, BOM `EF BB BF` в начале, RFC 4180, delimiter `,`, line ending `CRLF`, terminal
  `CRLF` после последней строки (естественное следствие того, что каждая строка, включая последнюю,
  заканчивается `\r\n` — нет отдельного "последняя строка без терминатора" пути).
- **Все** cells в двойных кавычках (не только те, что формально требуют — литеральное требование
  задачи, отступление от "quote-if-needed" RFC 4180 экономии).
- Внутренняя `"` удваивается (`"` → `""`) до оборачивания в кавычки.
- Header — ровно 17 колонок, в заданном порядке (§BH).
- Одна data row = один `ExportItem` bucket. `rowCount` = число data rows (без header). Zero-hours
  period — допустим: content = `BOM + header + CRLF`, `rowCount = 0`, `ExportItem` строк нет вообще
  (естественное следствие: `buildCanonicalDailyBuckets([])` возвращает `[]`, дальше по конвейеру
  ничего не меняется — не отдельная ветка кода).

### BH. Header, columns, deterministic ordering

Header (буквально, в этом порядке):

```
period_id,period_start_date,period_end_date,export_batch_id,export_kind,employee_id,
employee_number,employee_name,site_id,site_name,date,timesheet_version_id,
gross_minutes,paid_break_minutes,unpaid_break_minutes,worked_minutes,segment_count
```

(17 колонок; перенос строки здесь — только для читаемости этого документа, в реальном файле header —
одна CRLF-строка). Row order — сортировка `ExportItem`-строк перед записью в CSV:

1. `employeeNumberSnapshot` ASC, code-point/binary (**не** `localeCompare`).
2. `employeeId` ASC (tie-break при равном `employeeNumberSnapshot` — не должно происходить, т.к.
   `employeeNumber` уникален на `Employee`, но снимок технически мог быть скопирован до переименования
   другого работника; tie-break делает порядок детерминированным независимо).
3. `date` ASC (строковое `YYYY-MM-DD` сравнение — лексикографически совпадает с хронологическим).
4. `siteNameSnapshot` ASC, code-point/binary.
5. `siteId` ASC.

Компаратор — цепочка `a < b ? -1 : a > b ? 1 : 0` на JS-строках (UTF-16 code unit сравнение), без
`Intl`/`localeCompare` где бы то ни было в этом пути.

### BI. Spreadsheet formula injection

До escaping, для **только** трёх human-controlled text колонок (`employee_number`,
`employee_name`, `site_name` — **не** `period_id`/UUID/дат/целых чисел/`export_kind`): если значение
после ведущих `ASCII space`-символов (**не** любого whitespace — само правило задачи перечисляет
`tab`/`CR`/`LF` как отдельные триггер-символы, а не как то, что "leading whitespace" уже съедает)
начинается с `=`, `+`, `-`, `@`, tab, CR или LF — добавляется ведущий ASCII apostrophe `'` **в самое
начало** исходной строки (до любых ведущих пробелов, не после них — гарантирует, что символ, который
формульный движок видит первым, всегда `'`).

```ts
const CSV_FORMULA_TRIGGER = /^ *[=+\-@\t\r\n]/;
function sanitizeHumanTextCell(value: string): string {
  return CSV_FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}
```

Применяется **до** quote-doubling/wrapping (§BG) — apostrophe становится частью cell-содержимого,
затем вся cell проходит обычный CSV-escaping. Реальные injection-cases (`=1+1`, `+SUM(A1:A9)`,
`-2+3`, `@SUM(...)`, `\tCMD(...)`, значение начинающееся с CR/LF) проверены тестом §BJ item 19 —
литеральным содержимым CSV, не только вызовом функции изолированно.

### BJ. File identity

- Batch UUID (`randomUUID()`) генерируется **до** построения CSV bytes — входит в CSV как
  `export_batch_id` каждой строки (§BF шаг 8).
- `fileName`: `titanor-time_<startDate>_<endDate>_<full|correction>_<batchId>.csv` — все компоненты
  уже ASCII-safe (даты — `YYYY-MM-DD`, kind — литерал `full`/`correction`, batchId — UUID hex);
  никакого пользовательского ввода в имени файла.
- `fileHash` — lowercase SHA-256 hex **точных** сохранённых bytes (включая BOM и все CRLF) —
  `createHash('sha256').update(contentBuffer).digest('hex')`.
- `fileSizeBytes` — `contentBuffer.byteLength` (точная длина в байтах, не `.length` JS-строки, которая
  считает UTF-16 code units, а не байты — не эквивалентно для не-ASCII содержимого вроде кириллицы/
  финских букв в именах). CHECK `ck_export_batch_file_size_matches_content` (T8.4A, `= octet_length
  (content)`) — DB-уровневый backstop, совпадает по построению.
- `ExportBatch.content` = точные сгенерированные bytes, вставленные как есть — download (§BL) **никогда**
  не реконструирует CSV из текущей БД, только отдаёт уже сохранённый `content` буквально.

### BK. API contracts

Четыре endpoint'а, все под `/api/admin/*`. `X-Requested-With: titanor-time` обязателен на POST (тот
же `403 CSRF_REJECTED`, что весь остальной admin API) — GET-эндпоинты (list/detail/download) CSRF не
проверяют (тот же паттерн, что весь остальной read-only admin API этого проекта).

#### `POST /api/admin/periods/:periodId/export`

Permissions: **обе одновременно** — `period.export` **и** `export.create` (`hasPermission`-цикл, не
`||`). `Idempotency-Key` (UUID) **обязателен** (`400 VALIDATION_ERROR`, если отсутствует/не UUID) —
тот же паттерн, что `POST .../geofence-versions` уже устанавливает для mandatory-idempotency
endpoint'ов. Body — либо отсутствует, либо `{}`; **любое** поле в теле → `400 VALIDATION_ERROR` (нет
ни одного допустимого поля вообще, так что "неизвестное" = "любое").

State routing → HTTP:

| Состояние периода | Действие | HTTP |
|---|---|---|
| malformed `periodId` | — | `400 VALIDATION_ERROR` |
| period не существует | — | `404 PERIOD_NOT_FOUND` |
| `OPEN` | — | `409 PERIOD_NOT_EXPORTABLE` |
| `LOCKED` | создаёт FULL | `201` |
| `EXPORTED`, есть eligible pending correction | создаёт CORRECTION | `201` |
| `EXPORTED`, нет eligible pending correction | — | `409 NOTHING_TO_EXPORT` |

Response `201` — буквально по контракту задачи (`batch`/`period`/`coveredCorrectionCount`,
`downloadUrl: /api/admin/export-batches/:id/download`). Idempotency replay — тот же контракт, что
`04_ADMIN_FIRST_API_CONTRACTS.md` §0 уже фиксирует для всего API: тот же key/period/body →
byte-identical cached `201`; тот же key, другая цель/тело → `409 IDEMPOTENCY_KEY_REUSED`; конкурентный
тот же key → `409 IDEMPOTENCY_KEY_IN_PROGRESS` (естественно из `beginIdempotentRequest`, без нового
кода).

#### `GET /api/admin/export-batches`

Permission: `export.read`. Query: `periodId?` (UUID, если задан и невалиден — `400`), `page`
(default 1), `pageSize` (default 20, max 100). Sort: `createdAt DESC, id DESC`. Response —
`{items, page, pageSize, totalItems, totalPages}`, тот же общий пагинационный контракт
(`04_ADMIN_FIRST_API_CONTRACTS.md` §0). Каждый item — та же форма, что `batch` в POST-ответе
(без `content`).

#### `GET /api/admin/export-batches/:batchId`

Permission: `export.read`. Malformed UUID → `400`. Отсутствующий batch → `404
EXPORT_BATCH_NOT_FOUND` (единый код, тот же, что malformed путь не отдаёт — оба ведут к одному и тому
же "no oracle" 404 для malformed-vs-missing, тот же принцип, что остальной API уже устанавливает,
кроме самого формата UUID, который проверяется первым и даёт `400`, а не `404`, — валидный, но
несуществующий UUID даёт `404`). Response — `batch`-метаданные (та же форма, без `content`),
`coveredCorrectionIds: string[]` + `coveredCorrectionCount`, и paginated `items` (`page`/`pageSize`,
query params, default 1/20 max 100) — каждый item: `id, employeeId, employeeNumberSnapshot,
employeeNameSnapshot, siteId, siteNameSnapshot, date, timesheetVersionId, grossMinutes,
paidBreakMinutes, unpaidBreakMinutes, workedMinutes, segmentCount`. **Не** отдаёт correction reason
или любой другой correction-payload — только `id` покрытых `CorrectionRequest`.

#### `GET /api/admin/export-batches/:batchId/download`

Permission: `export.read`. Возвращает **точный** `ExportBatch.content` без какой-либо
реконструкции. Заголовки:

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="<stored fileName>"
Content-Length: <fileSizeBytes>
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
X-Content-SHA256: <fileHash>
```

Malformed/missing batch → тот же безопасный `404 EXPORT_BATCH_NOT_FOUND` JSON-envelope (не
HTML/stack trace — `jsonError()`, тот же путь, что весь остальной API).

GET-эндпоинты (list/detail/download) **не создают** `AuditEvent` и ничего не мутируют — только
`tx.*.findMany`/`findUnique` (list/detail — внутри короткой read-only транзакции для консистентного
`page`/`totalItems`-снимка; download — один `findUnique` по `id`, без транзакции, поскольку это
единственное чтение).

### BL. Audit — allowed fields only

`AuditEvent(EXPORT_CREATED)` — `afterValue` содержит **только**: `exportBatchId`, `periodId`,
`format`, `kind`, `correctsBatchId`, `rowCount`, `fileSizeBytes`, `fileHash`, `coveredCorrectionCount`.
**Никогда**: CSV content, employee names/numbers, individual `ExportItem`, correction reason,
GPS/device/payload/request data — тот же redaction-принцип, что весь T8-этап уже устанавливает.
`entityType: 'EXPORT_BATCH'`, `entityId: <batch id>`, `actorUserId`, `requestId` — стандартные поля
`createAuditEvent()` (`lib/audit.ts`, не меняется).

### BM. Locking/concurrency — доказательство

Lock order внутри `createExportBatch`: `PayrollPeriod` → `Timesheet[]` (`ORDER BY id`) →
(`CORRECTION` only) `CorrectionRequest[]` (`ORDER BY id`) — расширяет существующий canonical order
§8.1 (`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md`), добавляя `PayrollPeriod` как самую
внешнюю позицию (period-level операции, `lockPeriod`, уже устанавливают этот же приоритет — период
блокируется раньше входящих в него Timesheet-строк).

Поскольку **и** `createExportBatch`, **и** `decideCorrection` оба блокируют затронутые `Timesheet`-
строки `FOR UPDATE` (последний — по одной, `lib/corrections.ts:748`; первый — bulk, `ORDER BY id`),
Postgres-уровневая row-lock serialization на общей `Timesheet`-строке — единственный реальный
координационный механизм между этими двумя независимыми путями (ни один явно не знает о другом):

- **Correction approval выигрывает первым** (коммитит до того, как export взял свой Timesheet-лок):
  export видит `pendingExport=true` уже выставленным (поскольку approval сам проверяет `period.status
  === 'EXPORTED'` в момент своего коммита) → correction входит в новый batch.
- **Export выигрывает первым** (уже держит/закоммитил Timesheet-лок до начала approval): approval
  блокируется на `FOR UPDATE`, затем продолжает с уже закоммиченным состоянием после — его
  `pendingExport=true` устанавливается уже ПОСЛЕ snapshot предыдущего export'а → остаётся pending для
  следующего вызова.
- **Два FULL** (разные idempotency keys, конкурентно): оба берут `PayrollPeriod FOR UPDATE` — второй
  блокируется до коммита первого, затем перечитывает статус (уже `EXPORTED`, не `LOCKED`) → второй
  либо видит eligible pending correction (маловероятно тут же) → CORRECTION, либо `NOTHING_TO_EXPORT`.
  Ровно один FULL batch (§BA, тройная гарантия).
- **Два CORRECTION** (конкурентно, один pending item): оба берут `PayrollPeriod FOR UPDATE` — второй
  блокируется, затем видит `pendingExport=false` (уже очищено первым) → `NOTHING_TO_EXPORT`. Ровно
  один batch покрывает pending snapshot.
- Нет lost `pendingExport`-update: `pendingExport=false` устанавливается **в той же транзакции**, что
  вставляет покрывающий batch (§BF шаг 11) — не отдельным, потенциально гонка-подверженным вызовом.
- Нет duplicate batch/item: `tx.exportBatch.create`/`createMany` — единственные insert-точки, обе
  внутри единственной транзакции на попытку; при откате транзакции (см. §BN) ничего не остаётся.

Тест §BJ (concurrency-раздел задачи) доказывает это через реальные **разные PostgreSQL backend PID**
(`pg_stat_activity`), не только `Promise.all`-таймингом на одном соединении — та же техника, что T7A's
"held-open-transaction + `wait_event_type='Lock'`" паттерн (см. `[[titanor_time_conventions]]`).

### BN. Security / redaction — сводка

- WORKER/FOREMAN — `403` на все четыре endpoint'а (ни `period.export`/`export.create`/`export.read`
  не выданы им, T8.4A permissions-миграция).
- Отзыв **любого** из `period.export`/`export.create` блокирует следующий `POST` (`hasPermission`
  перечитывается на каждый запрос, без кэша — тот же принцип, что весь остальной API).
- Отзыв `export.read` блокирует list/detail/download на следующий запрос.
- CSRF (`X-Requested-With`) — только `POST`.
- `content` **никогда** не попадает в JSON list/detail-ответ, ни в лог, ни в `AuditEvent`.
- CSV не содержит: `phone`/`email`/GPS/device identifiers/`payloadHash`/`requestId`/correction reason
  — структурно (17 фиксированных колонок §BH, ни одна не ссылается на эти поля).
- Formula injection — нейтрализован (§BI), проверено реальным содержимым.
- `fileName` не зависит от пользовательского ввода (§BJ — все компоненты server-generated).
- Никакого filesystem temp CSV — bytes существуют только в памяти процесса (JS `Buffer`) до записи
  `content` в PostgreSQL; ни один шаг не пишет на диск.

### BO. Transaction rollback / query-count / EXPLAIN — обязательства

- Rollback (любая ошибка внутри транзакции — invariant failure throw, DB constraint violation) не
  оставляет half-batch/half-item/half-мутированный `PayrollPeriod`/`CorrectionRequest` — вся работа
  §BF шагов 1–13 — одна Postgres-транзакция, атомарна по построению; проверяется тестом (F.54).
- Query count — ограничено и не растёт с числом workers (§BF шаги 1/4/6 — все bulk/set-based, ни
  одного per-worker/per-day цикла с собственным Prisma-вызовом); измеряется на 1/50/200-worker
  фикстурах (F.55).
- `ExportItem`-вставка — один `createMany`, не цикл (F.56).
- `EXPLAIN ANALYZE` — на большой фикстуре, подтверждает индексное использование (F.57).

### BP. Область, явно не реализованная этим слайсом

`/admin/export` UI (T8.4C — отдельный, не начатый слайс), PDF (`ExportFormat` — по-прежнему только
`CSV_V1`, добавление `PDF_V1` — отдельная будущая additive-миграция), зарплата/ставки/деньги, любые
payroll/TES-категории (overtime/night/sunday/holiday/travel — по-прежнему ноль полей для них ни в
`ExportBatch`, ни в `ExportItem`), production deployment (все проверки — на disposable-ресурсах;
preview `127.0.0.1:3244` и production контейнеры — не трогаются, только read-only inspect/health).

### BQ. Статус реализации — `[2026-08-19]` завершено

Реализовано ровно то, что описано в §BA-BP, без отклонений от спецификации задачи. Одна находка,
исправленная до коммита: изначальная транзакционная конфигурация `createExportBatch` копировала
T8.1-T8.3's `RepeatableRead`-изоляцию — под ней конкурентный экспорт, чей `FOR UPDATE` блокируется за
уже держащим лок конкурентом и затем разблокируется после его коммита, падает с настоящим `40001
could not serialize access due to concurrent update` вместо простого перечитывания свежей строки
(обнаружено тестами concurrency-раздела). Исправлено переключением на Postgres/Prisma default `READ
COMMITTED` (§BF) — тот же паттерн, что `lockPeriod`/`decideCorrection` уже используют.

`scripts/_test-csv-export.ts` — 171/171 проверок на всех 58 сценариях задачи (A-F), 100% pass на
disposable PostgreSQL 16, включая реальные многопроцессные concurrency-доказательства (`pg_stat_
activity` distinct backend PID) и dump/restore round trip на отдельном одноразовом экземпляре.
`scripts/_test-csv-export-querycount.ts` подтверждает bounded query count (15 SQL statements
одинаково для 1/50/200 workers) и единственный bulk `INSERT` в `ExportItem`. Полная регрессия
T8.1-T8.3/rounding-consistency/activation/corrections — без изменений (каждый скрипт на своей
изолированной disposable БД). T8.4C (admin UI) и PDF/payroll/TES-категории этим коммитом по-прежнему
не начаты.

## Addendum — T8.4C CSV Export Admin UI (2026-08-19)

Написано **до** реализации. UI поверх уже полностью реализованного и **не изменяемого** T8.4B
backend (`lib/csv-export.ts`, все четыре endpoint'а — §BK выше). Ни один запрос/DTO/permission/CSV
byte contract этим addendum'ом не меняется — только presentation, navigation, client-side
idempotency UX и CSS.

### BR. Routes и Server Component wiring — тот же паттерн, что T8.1-T8.3

`app/admin/export/page.tsx` (история + create panel) и `app/admin/export/[batchId]/page.tsx`
(detail) — тонкие Server Component обёртки, буквально тот же split, что `app/admin/reports/
periods/page.tsx` уже устанавливает: резолвят сессию, проверяют permission через `hasPermission`
(не `roles.includes` — тот же принцип, что T8.1-T8.3), парсят `searchParams`/`params`, вызывают
`listExportBatches()`/`getExportBatchDetail()` **напрямую** (никакого HTTP self-fetch), передают
результат presentation-компоненту как props. `export const dynamic = 'force-dynamic'` на обеих
страницах (тот же паттерн, что все остальные admin-страницы).

- `/admin/export?periodId=&page=&pageSize=` — все три в query. `periodId` **отсутствует** →
  история всех batches (`listExportBatches({}, ...)`). `periodId` present, malformed (не UUID) →
  `outcome: 'invalid'`, inline banner, не 500 — та же `parsePageQuery()`
  (`lib/csv-export.ts`, уже существует) переиспользуется для `page`/`pageSize`, periodId-формат
  проверяется тем же `UUID_PATTERN` (`lib/attendance-exceptions.ts`), что весь остальной admin API
  уже использует. `periodId` present, валидный UUID, но период не существует (или существует, но
  batches нет) → `listExportBatches` просто не находит совпадений — **пустая история**, не ошибка
  (тот же принцип, что T8.1-T8.3: несуществующий, но синтаксически валидный id никогда не течёт
  внутреннюю ошибку наружу отдельным кодом, если сама операция не требует существования сущности —
  здесь это чистый WHERE-фильтр, не FK-lookup).
- `page` не является полем формы фильтра — только в pagination-ссылках, несущих текущие
  `periodId`+`pageSize` (тот же structural-reset-to-1 приём, что T8.2B/T8.3B уже устанавливают —
  §K/§AB design doc выше). Смена `periodId`/`pageSize` через саму форму естественно уходит на URL
  без `page`.
- `/admin/export/:batchId?page=&pageSize=` — `batchId` path param, `page`/`pageSize` query для
  paginated `ExportItem`. Malformed `batchId` (не UUID) и несуществующий `batchId` (валидный UUID,
  `getExportBatchDetail` вернул `null`) — **один и тот же** inline "not found" state, без различия в
  тексте (то же "no oracle"-рассуждение, что `04_ADMIN_FIRST_API_CONTRACTS.md` §22 уже устанавливает
  для download-эндпоинта — malformed и missing неотличимы для читателя).

### BS. Permissions

`/admin/export` и `/admin/export/:batchId` (чтение/просмотр) — обе требуют `export.read`
(`hasPermission`, проверяется явно в page.tsx, **не** полагается только на `app/admin/layout.tsx`'s
literal-role-name гейт — тот же дефицит, что T8.3B уже задокументировал как архитектурное
наблюдение: layout блокирует по имени роли ADMIN/SUPER_ADMIN раньше любой page-level permission-
проверки, так что отзыв гранта у самой роли ADMIN — единственный способ протестировать revocation
здесь, тот же приём, что T8.2B/T8.3B тестов уже используют). Create panel (кнопка "Create... export")
требует **обе** `period.export` **и** `export.create` одновременно — то же требование, что сам POST
endpoint уже enforced на сервере (§BK); UI-проверка — вторая линия обороны, не единственная. Если у
пользователя есть `export.read`, но нет одной/обеих create-permissions — история и detail полностью
доступны, но create panel **вообще не рендерится** (не disabled-кнопка в DOM — задача явно требует
"никакой скрытой активной кнопки", поэтому серверная страница даже не выводит `<ExportCreateControl>`,
а вместо него — статичный `<p>` "You do not have permission to create exports."). WORKER/FOREMAN —
блокируются `app/admin/layout.tsx` раньше, чем достигают этих страниц вообще (тот же гейт, что весь
остальной `/admin/*`).

### BT. Navigation

`components/reports/AdminReportTabs.tsx` расширен четвёртой вкладкой `'export'` → `/admin/export`
("CSV exports"), рядом с "By worker"/"By site"/"By period" — тот же компонент, та же `aria-current`
семантика, никакого нового inline `<nav>`. `SiteTimeReportView`'s FOREMAN-ветка (`role="foreman"`)
по-прежнему рендерит `null` вместо этого компонента — ноль admin-ссылок для FOREMAN, без изменений.
`app/admin/layout.tsx`'s `ADMIN_NAVIGATION` получает один новый пункт `{ href: '/admin/export', label:
'Exports' }`. Contextual links — `app/admin/periods/[periodId]/page.tsx` получает пятую ссылку "View
CSV exports for this period" → `/admin/export?periodId=<id>` (рядом с уже существующими T8.1/T8.2B/
T8.3B ссылками, ни одна не убирается); `PeriodTimeReportView.tsx`'s `'ok'`-ветка (когда конкретный
period выбран) получает ту же ссылку рядом с существующим период-заголовком. Ни один из двух не
дублирует вкладки вручную — оба линкуют В `/admin/export`, которое само уже показывает
`AdminReportTabs`.

### BU. Period selector — одна форма, два потребителя (история-фильтр и create-target)

`/admin/export`'s единственный `<select name="periodId">` (GET-форма, тот же `.ov-filters`
структурный паттерн, что T8.1-T8.3) одновременно: (1) фильтрует историю (пустое значение = "All
periods", только для истории — create panel не может таргетировать "все периоды" сразу) и (2)
определяет, какой period create panel таргетирует. Опции — `listPeriodOptions()`
(`lib/attendance-overview-lookups.ts`, уже существует, `label` уже содержит даты+status — переиспользуется
как есть, без копии). Когда `periodId` в URL пуст/отсутствует — create panel показывает placeholder
"Select a specific period above to create an export." (без кнопки в DOM). Когда `periodId` present и
валиден — страница читает актуальный `PayrollPeriod.status` через `getPeriodDetail(periodId)`
(`lib/periods.ts`, уже существует, read-only) и рендерит:

- `OPEN` → explanation "Lock the period before exporting.", без кнопки в DOM;
- `LOCKED` → `<ExportCreateControl periodId=... />`, кнопка "Create full CSV export";
- `EXPORTED` → тот же `<ExportCreateControl>`, кнопка "Create correction CSV export" + заметка
  "EXPORTED does not guarantee a pending correction — the server remains authoritative and may
  return 'Nothing to export'." — сервер (`createExportBatch`) остаётся единственным источником
  истины про `FULL`/`CORRECTION`/`NOTHING_TO_EXPORT`; UI-label — подсказка, не обещание конкретного
  исхода.
- период не найден (`getPeriodDetail` вернул `null`, хотя UUID валиден) — та же безопасная
  not-found-подобная заметка, без кнопки.

### BV. `components/exports/ExportCreateControl.tsx` — frozen idempotency attempt

Buквально тот же паттерн, что `components/attendance-policy/PolicyForm.tsx` уже устанавливает
(T7A.10B §7) — единственный существующий "frozen attempt" UI в кодовой базе, переиспользуется
архитектурно (не копипастой файла целиком — форма другая, но structure/state-machine та же):

```ts
interface Attempt { key: string; periodId: string }
type CreateStatus = 'idle' | 'creating' | 'success' | 'error' | 'network-unknown';
```

- Один клик по "Create..." → один новый `Attempt` (`crypto.randomUUID()` как `Idempotency-Key`,
  `periodId` — неизменяемый prop, никогда не читается заново из какого-либо state внутри контрола).
  `pendingRef` (synchronous `useRef<boolean>`) блокирует двойной клик до React re-render — тот же
  механизм, что `PolicyForm`.
- Запрос: `POST /api/admin/periods/:periodId/export`, `headers: { 'Content-Type': 'application/json',
  'X-Requested-With': 'titanor-time', 'Idempotency-Key': attempt.key }`, `body: '{}'` — тело всегда
  ровно `{}` (детерминированно, никогда не варьируется), Content-Type присутствует именно потому что
  тело реально отправляется.
- Definitive HTTP response (`res.ok` или любой не-network HTTP статус, включая malformed/non-JSON
  body с реальным status code) **завершает** attempt — `attempt` сбрасывается в `null` независимо от
  исхода. Network/timeout (`fetch` бросает исключение) → `status: 'network-unknown'`, **тот же**
  `attempt` (тот же key, тот же periodId) остаётся живым для Retry — Retry вызывает `runAttempt` с
  тем же объектом, байт-идентичный повторный запрос.
- `success` — **sticky**: показывает `batch.kind`/`batch.id`, ссылки "View details"
  (`/admin/export/:id`) и "Download CSV" (`batch.downloadUrl`, обычный `<a>`), затем `router.
  refresh()` (обновляет history/period-status у родительского Server Component). Кнопка Create
  **не** появляется снова в этом же экземпляре компонента — заметка "To create another export,
  reload this page." вместо неё. Компонент замонтирован с `key={periodId}` на родительской
  странице — навигация на **другой** period (реальная смена URL) естественно демонтирует/
  перемонтирует его (`attempt=null`, `status='idle'`), навигация на **тот же** period (`router.
  refresh()`) — нет, состояние сохраняется намеренно (React не ремонтирует по `key`, если он не
  изменился) — это и есть "не создавать второй export автоматически" (rule 6) и "следующий отдельный
  create attempt получает новый key" (rule 31, тривиально верно для НОВОГО mount).
- Период "нельзя менять, пока pending/unknown" (rule 8) — достигается структурно: единственный
  способ сменить целевой period — submit'нуть отдельную GET-форму фильтра на родительской странице
  (полная навигация браузера), что естественно демонтирует текущий `ExportCreateControl` целиком —
  контрол сам никогда не предоставляет собственного UI для смены `periodId` (`periodId` — read-only
  prop). Отдельная client-side блокировка родительской `<select>`-формы во время pending/unknown НЕ
  реализована — намеренное, задокументированное решение: submit фильтра во время pending-запроса —
  обычная браузерная навигация, которая либо отменяет ещё не отправленный fetch, либо просто
  демонтирует компонент, ожидающий уже отправленного (сервер всё равно останется authoritative и
  idempotent — сама эта фильтр-навигация не создаёт новый POST).
- `aria-live="polite"` announcement region (progress/result текстом, тот же `role="status"`
  паттерн, что `PolicyForm`'s `.policy-sr-announce`), `aria-busy` на кнопке/форме во время `creating`,
  `disabled` на кнопке во время `creating`/`network-unknown` (Retry — отдельная кнопка, не тот же
  disabled-элемент).

### BW. Human error mapping — `describeExportErrorCode()`

Тот же `describeErrorCode()`-паттерн, что `PolicyForm.tsx` уже устанавливает, отдельная функция для
export-контекста (разные коды, разные сообщения):

| `error.code` | Сообщение |
|---|---|
| `PERIOD_NOT_FOUND` | "This payroll period no longer exists." |
| `PERIOD_NOT_EXPORTABLE` | "This period is still open — lock it before exporting." |
| `NOTHING_TO_EXPORT` | "No approved corrections are waiting for export. The latest CSV remains current." (дословно, задача требует точный текст) |
| `VALIDATION_ERROR` | "Please reload the page and try again." (не должно происходить при корректном UI — тело всегда `{}` — но обрабатывается, не крашит) |
| `NOT_AUTHENTICATED` | "Your session has expired — please log in again." |
| `FORBIDDEN` | "You no longer have permission to create exports." |
| `CSRF_REJECTED` | "Your session needs a refresh — please reload the page and try again." |
| `IDEMPOTENCY_KEY_REUSED` | "This export could not be completed as a new request. Please reload and try again." |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | "This export is still being processed. Please wait a moment and try again." |
| malformed/non-JSON body, любой статус | "Something went wrong. Please try again." (generic — не парсим未known shape) |
| 5xx (любой код без известного `error.code`) | тот же generic fallback |
| network failure (`fetch` throw) | `network-unknown` — отдельная ветка, не часть этой таблицы (§BV) |

Никогда — raw `error.message`/stack/response text напрямую в UI.

### BX. Detail presentation — `ExportItem`, mobile-first

`components/exports/ExportBatchDetailView.tsx` рендерит каждый `ExportItem` тем же `dl`-based
card-паттерном, что `SiteTimeReportView`/`PeriodTimeReportView` уже устанавливают (`.ov-worker-card`/
`.ov-worker-grid`, переиспользуются как есть, не копируются) — естественно reflow'ится на 390px без
отдельного mobile/desktop JS-переключения (задача **допускает**, не требует, отдельную desktop-таблицу
— переиспользование уже проверенного на 390×844 в T8.2B/T8.3B паттерна безопаснее, чем добавлять
новый). Поля: `employeeNumberSnapshot`/`employeeNameSnapshot`, `siteNameSnapshot`, `date`,
`grossMinutes`/`paidBreakMinutes`/`unpaidBreakMinutes`/`workedMinutes` через **тот же**
`formatWorkedDuration()` (`lib/reporting/report-format.ts`, переиспользуется, не пересчитывается),
`segmentCount`, `timesheetVersionId` — последним, меньшим/приглушённым текстом (`.ov-muted`),
подписанным "Version" — audit-only, не кликабельно (нет UI route на голую `TimesheetVersion` вне
контекста конкретного worker report).

### BY. Security — DTO уже redaction-safe, UI ничего нового не добавляет

`lib/csv-export.ts`'s DTOs (`ExportBatchSummaryDto`/`ExportItemDto`/`ExportBatchDetail`) уже
структурно не содержат `content`/`phone`/`email`/GPS/device identifiers/`payloadHash`/`requestId`/
correction reason/`AuditEvent` payload (T8.4B §BL/BN) — presentation-слой не может утечь то, чего
нет в типе. `fileHash` (SHA-256) и уже задокументированные id (`batch.id`, `periodId`,
`employeeId`, `siteId`, `timesheetVersionId`, `correctionRequestId`) — разрешены явно, не PII.
Download — всегда `<a href={batch.downloadUrl}>` (обычная browser-authenticated GET через
существующую session-cookie, тот же origin) — **никогда** `fetch()`+`Blob()`+`URL.createObjectURL`
на клиенте (задача явно запрещает пересборку/повторную загрузку CSV на клиенте) и никогда data:
URL/публичный URL. Ни один React prop/HTML attribute во всех новых компонентах не несёт CSV bytes —
blanket-scan тест (пункт 44 списка задачи) — дополнительное доказательство, не единственная защита.

### BZ. Loading/error states

`app/admin/export/loading.tsx`, `app/admin/export/error.tsx`, `app/admin/export/[batchId]/
loading.tsx`, `app/admin/export/[batchId]/error.tsx` — тот же паттерн, что `app/admin/reports/
periods/loading.tsx` (`role="status" aria-live="polite"`) и `app/admin/error.tsx` (генерический
App Router `error.tsx`: `'use client'`, `{ error, reset }` props, "Try again" вызывает `reset()`,
ссылка назад — здесь на `/admin/export`) уже устанавливают. Никогда `error.message`/`error.stack` в
рендере.

### CA. CSS — additive only, `.exp-*` prefix

Новый блок в конце `app/globals.css`, тот же "additive-only, собственный comment header со ссылкой
на design doc" паттерн, что `.policy-*` (T7A.10B) уже устанавливает. Переиспользуются без изменения:
`.setup-page`/`.setup-card`, `.ov-filters`/`.ov-filter-field`/`.ov-filter-actions`,
`.exc-apply-button`/`.exc-reset-link`/`.exc-pagination`, `.ov-worker-list`/`.ov-worker-card`/
`.ov-worker-grid`, `.ov-muted`/`.ov-badge*`, `.login-error`, `.policy-network-unknown`/`.policy-
sr-announce`/`.policy-error-banner` (переименованы под `.exp-*` для семантической ясности create-
контрола, но идентичны по стилю — не копия дизайна, тот же visual language). Новые классы —
только для того, чего не существует: `.exp-create-panel`, `.exp-history-card`, `.exp-hash` (`font-
family: monospace`, для сокращённого hash), `.exp-replacement-badge` (визуальная метка "Full
replacement snapshot" на CORRECTION batches). Ни одно существующее правило не редактируется.

### CB. Browser test plan

Постоянный `scripts/_test-export-ui.ts` (Playwright, тот же паттерн, что T8.2B/T8.3B уже
устанавливают — реальный Chromium, production standalone build, disposable PostgreSQL 16, `TEST_
BASE_URL`, не `next dev`, не preview). Покрывает все 46 пунктов задачи — permissions/roles (1-5),
history/filter/pagination/URL (6-11), create flow OPEN/LOCKED/EXPORTED (12-14), success/history/
links (15-18), NOTHING_TO_EXPORT/CORRECTION semantics (19-23), detail pagination/exact download
(24-25), idempotency/retry/double-click/network-unknown (26-31), error mapping (32-35),
accessibility (36-38), responsive (39-40), edge/security (41-46).

### CC. Не входит в этот слайс

Новые export API/endpoints, изменение CSV bytes/формата/FULL-CORRECTION semantics (backend —
абсолютно read-only потребитель для этого addendum'а), PDF, payroll/TES/деньги, production
deployment, глобальный redesign/localization (i18n остаётся английским, тот же язык, что весь
остальной admin UI на сегодня).

### CD. Статус реализации — `[2026-08-20]` завершено

Реализовано ровно то, что описано в §BR-CC, без отклонений от спецификации задачи. Одна находка,
исправленная до коммита — в собственном коде этого addendum'а, не в T8.4B backend: `CreatePanel`
держал `<ExportCreateControl key={periodId}>` в двух раздельных conditional JSX-ветках
(`kind === 'locked'` / `kind === 'exported'`); `router.refresh()` после успешного FULL-экспорта
немедленно переводит `kind` `'locked'` → `'exported'`, что React трактует как unmount+remount
(тот же `key`, другая позиция в дереве) — sticky success-панель (§BV rule 6) молча заменялась
свежей кнопкой через ~300-500ms после появления (найдено покадровым 100ms-polling реального
Chromium, не догадкой). Исправлено вынесением `ExportCreateControl` в единый стабильный JSX-слот —
меняется только `buttonLabel` prop, компонент больше не размонтируется при смене `kind`.

`scripts/_test-export-ui.ts` — 87/87 проверок на всех 46 сценариях задачи, 100% pass на disposable
PostgreSQL 16 + production standalone build (никогда `next dev`, никогда preview), включая точную
byte-for-byte верификацию скачивания, double-click/delayed-response/network-unknown/retry
concurrency-доказательства (прямые запросы к БД, не только UI-наблюдение) и forbidden-field DOM-scan.
Полная регрессия T8.4A/T8.4B/T8.1-T8.3/rounding-consistency/corrections — без изменений (каждый
скрипт на своей изолированной disposable БД). Один инфраструктурный (не продуктовый) фикс:
`tsconfig.build.json` + `next.config.mjs`'s `typescript.tsconfigPath`, чтобы `docker compose build
app`'s typecheck не требовал Playwright как production-зависимость (см. `IMPLEMENTATION_STATUS.md`
`[2026-08-20]` записи за подробностями). **T8.4 полностью завершён** (T8.4A schema + T8.4B backend +
T8.4C admin UI). PDF export и payroll/TES-категории этим коммитом по-прежнему не начаты.

## Addendum "Custom Report" (Qualifications Matrix + Custom Report task, 2026-08-24)

Реализует PDF, но не через `ExportFormat.PDF_V1`, предсказанный выше — этот PDF намеренно
stateless (прямой download, ноль `ExportBatch` строки), в то время как `ExportFormat` enum целиком
принадлежит immutable `ExportBatch`-моделированию (T8.4A). `PDF_V1` как значение `ExportFormat`
остаётся не начатым — если будущая задача захочет persisted/immutable PDF export batch (аналог
CSV_V1's `ExportBatch`), это по-прежнему отдельная additive-миграция, не затронутая этим
addendum'ом.

**Новый модуль**: `lib/reporting/custom-time-report.ts`'s `getCustomTimeReport()` — не четвёртый
независимый report engine. Переиспользует ровно те же примитивы, что T8.1-T8.4:
`resolveCanonicalSource()` для DRAFT vs CURRENT_VERSION per-timesheet, `computeSegmentMs`/
`sumWorkedTimeMs`/`msToMinutes` для per-segment расчёта, и `buildCanonicalDailyBuckets()` (shared
`(employeeId, siteId, date)` bucket) для Summary-агрегации — те же правила округления ("round once
at the bucket, sum only already-rounded numbers above"), никакой второй формулы.

**Что генуинно новое** (не было ни у одного из T8.1-T8.4): запрос по произвольному диапазону дат,
не привязанному к одному `PayrollPeriod` — резолвится через все `PayrollPeriod`, пересекающие
диапазон, затем сегменты дополнительно фильтруются по собственной `date` в пределах запрошенного
диапазона (шире period). Максимум диапазона — 366 календарных дней включительно. Два data-mode:
`FINAL_APPROVED_ONLY` (только `Timesheet.status=FINAL_APPROVED`, источник всегда
`CURRENT_VERSION`) и `CURRENT_CANONICAL` (любой статус, источник per-timesheet через
`resolveCanonicalSource()`, тот же canonical rule, что и везде).

**Detailed vs Summary — единственное намеренное отклонение от "round once" правила.** Summary-строки
(группировка по работнику и объекту) — сумма уже округлённых bucket-минут, как и весь T8. Detailed
report показывает один ряд на сырой сегмент (не bucket) — Date/Employee/Site/Work area/Start/End/
Paid break/Unpaid break/Worked time/Timesheet status, каждый со своим собственным
`computeSegmentMs`→`msToMinutes` round. Для типичного случая (один сегмент на bucket-день)
Detailed-сумма и Summary-bucket совпадают побитово (проверено
`scripts/_test-custom-report-canonical.ts`); при нескольких сегментах в один bucket-день
Detailed-строки могут разойтись с Summary на до плюс-минус минуты каждая (сумма-до-округления
против округления-каждого-сегмента отдельно) — та же, неизбежная для любой dual-granularity
бухгалтерской системы разница, что между построчным журналом и агрегированной сводкой; сам T8
никогда не показывал detail-уровень ниже bucket'а, так что прямого прецедента для сравнения нет.
Cross-check против существующих T8.1/T8.2/T8.3 отчётов (для эквивалентного scope, всегда
bucket-уровень) — точное побитовое совпадение totals, не приближение.

**CSV**: человекочитаемые значения (`formatWorkedDuration()`, не сырые целые минуты как в CSV_V1),
ноль UUID (в отличие от CSV_V1, которая включает `employee_id`/`site_id`). Переиспользует CSV_V1's
byte-level примитивы (`CSV_BOM`, обобщённый `buildCsvRow()` — экспортирован из
`lib/csv-export.ts` этим addendum'ом, набор human-text колонок теперь параметр, не константа;
default-параметр сохраняет CSV_V1's собственное поведение без изменений), но собственный,
отдельный column set (Summary/Detailed) и собственный formula-injection guard scope — не
`CSV_V1_COLUMNS`.

**PDF**: одна новая server-side зависимость — `pdfkit` (production dependency, никакого
headless-Chromium). DejaVu Sans embedded (`titanor-time-app/assets/fonts/DejaVuSans*.ttf`,
Bitstream Vera License, свободно распространяем) — pdfkit's built-in Helvetica не имеет кириллицы
вовсе, без embedded Unicode-шрифта русские имена рендерились бы пустыми прямоугольниками.
`Dockerfile` явно копирует `assets/` в runner stage — Next's output-file tracing не отслеживает
пути, построенные через `path.join(process.cwd(), ...)` (та же категория пробела, что и Prisma
query engine binary, уже решённая через `outputFileTracingIncludes` в `next.config.mjs`),
проверено реальной сборкой образа. Summary — A4 portrait; Detailed — A4 landscape; repeatable
table header на новых страницах, page numbers через `bufferPages`+`switchToPage` (footer-запись
поверх temporarily-обнулённого `page.margins.bottom` — иначе pdfkit's auto-flow молча создаёт
лишнюю пустую страницу, найдено визуальной проверкой сгенерированного PDF).
