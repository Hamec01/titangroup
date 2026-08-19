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
2. Округление в минуты (`msToMinutes`, `Math.round`) происходит **на каждом уровне группировки
   отдельно** (T8.1: на уровне site bucket), не один раз на весь отчёт.
3. Более высокий уровень группировки (T8.1: `total`) — это **сумма уже округлённых чисел** более
   низкого уровня, не повторное округление суммы миллисекунд. Так `total.workedMinutes` всегда
   буквально равен `Σ site.workedMinutes` в JSON, без визуального расхождения на ±1 минуту, которое
   давало бы отдельное округление total из мс.
4. Единственное исключение — `workedDayCount` (см. §3): это **count distinct calendar dates**, не
   сумма и не миллисекунды, у него нет ms-уровня вообще.

`lib/attendance-overview.ts`'s `segmentReportedMs` (текущий source of truth формулы, до этого
слайса) переписывается на `computeSegmentMs`+`sumWorkedTimeMs`+`msToMinutes` без изменения
поведения (regression-тест п.32 подтверждает identical `recordedMinutes`/`reportedMinutes`/
`deltaMinutes` до и после рефакторинга) — единственная общая формула, ни одной копии.

## 3. Правила группировки (T8.1)

- Группировка по `siteId` — один bucket на объект, где у работника есть хотя бы один сегмент в этом
  Timesheet за выбранный период.
- Bucket-уровень: `grossMinutes`/`paidBreakMinutes`/`unpaidBreakMinutes`/`workedMinutes` — округление
  §2 п.2 (сумма ms всех сегментов этого site, один `msToMinutes` в конце).
- `segmentCount` — количество сегментов (WorkSegment/TimesheetDraftSegment) с этим `siteId`.
- `workedDayCount` (per site) — `COUNT(DISTINCT date)` среди сегментов этого site.
- `total.*Minutes` — сумма соответствующих **уже округлённых** site-полей (§2 п.3).
- `total.workedDayCount` — `COUNT(DISTINCT date)` **по всем** сегментам timesheet'а разом (не сумма
  per-site `workedDayCount` — один календарный день с сегментами на двух объектах не должен считаться
  дважды в total).
- `total.segmentCount` — сумма per-site `segmentCount` (сегмент принадлежит ровно одному site, суммa
  корректна и без distinct).
- `total.siteCount` — `sites.length`.
- Site sorting: `siteName ASC, siteId ASC` (детерминированная сортировка даже при совпадающих именах
  объектов — тест п.25).

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
