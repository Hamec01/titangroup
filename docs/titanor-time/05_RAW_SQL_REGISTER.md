# Titanor Time — Frozen Raw-SQL Object Register

```text
Status: FROZEN
Scope: current foundation initial migration
Authority: owner-approved DEC-01…DEC-05
Prisma version: 6.19.0
PostgreSQL target: 16
```

This register defines the mandatory manual PostgreSQL objects that Prisma schema syntax cannot express.
It is a specification, not an applied migration.
Changing object identity, predicates, timing, lock behavior, SQLSTATE, or stable identifiers requires a new owner decision.

Источник этого документа — решения владельца `DEC-01…DEC-05` и архитектура `03_DATA_MODEL_ERD.md`
(версия 5.4.1). Там, где `03_DATA_MODEL_ERD.md` ещё не содержит текста конкретного `DEC`, это
зафиксировано как `Documentation synchronization: MISSING` или `PARTIAL` в соответствующей строке —
это состояние документации, а не отмена решения владельца.

**Errata (identifier length):** runtime-аудит на одноразовом PostgreSQL 16 (HEAD `bebd6aa`) показал,
что имена CK-08 и CK-13 превышали лимит PostgreSQL в 63 bytes и были молча обрезаны движком при
применении migration. Оба имени сокращены до ≤63 bytes до первого permanent deployment — см. записи
CK-08 и CK-13 ниже. Бизнес-предикаты этих CHECK не изменялись. Architecture version 5.4.1 не
повышается из-за этого исправления физического identifier; остальные current-объекты register не
затронуты.

---

## 1. Current CHECK constraint register

| ID | Exact constraint name | Table | Current / Future |
|---|---|---|---|
| CK-01 | `ck_employment_date_range` | `Employment` | current |
| CK-02 | `ck_employment_inactive_metadata_shape` | `Employment` | current |
| CK-03 | `ck_absence_date_range` | `Absence` | current |
| CK-04 | `ck_absence_status_metadata_shape` | `Absence` | current |
| CK-05 | `ck_site_assignment_date_range` | `SiteAssignment` | current |
| CK-06 | `ck_work_schedule_template_version_day_weekday_range` | `WorkScheduleTemplateVersionDay` | current |
| CK-07 | `ck_work_schedule_template_version_day_shape` | `WorkScheduleTemplateVersionDay` | current |
| CK-08 | `ck_schedule_template_version_day_break_minutes_nonnegative` | `WorkScheduleTemplateVersionDay` | current |
| CK-09 | `ck_payroll_period_date_range` | `PayrollPeriod` | current |
| CK-10 | `ck_payroll_period_status_metadata_shape` | `PayrollPeriod` | current |
| CK-11 | `ck_payroll_period_participant_exclusion_metadata_shape` | `PayrollPeriodParticipant` | current |
| CK-12 | `ck_timesheet_draft_planned_shift_shape` | `TimesheetDraftPlannedShift` | current |
| CK-13 | `ck_timesheet_draft_shift_break_minutes_nonnegative` | `TimesheetDraftPlannedShift` | current |
| CK-14 | `ck_timesheet_draft_segment_interval` | `TimesheetDraftSegment` | current |
| CK-15 | `ck_timesheet_draft_segment_local_date` | `TimesheetDraftSegment` | current |
| CK-16 | `ck_timesheet_draft_break_segment_interval` | `TimesheetDraftBreakSegment` | current |
| CK-17 | `ck_timesheet_planned_shift_shape` | `TimesheetPlannedShift` | current |
| CK-18 | `ck_timesheet_planned_shift_planned_break_minutes_nonnegative` | `TimesheetPlannedShift` | current |
| CK-19 | `ck_work_segment_interval` | `WorkSegment` | current |
| CK-20 | `ck_work_segment_local_date` | `WorkSegment` | current |
| CK-21 | `ck_break_segment_interval` | `BreakSegment` | current |

### CK-01 `ck_employment_date_range`

- Table: `Employment`
- Predicate:
  ```sql
  "endDate" IS NULL OR "endDate" >= "startDate"
  ```
- Source / architecture section: `03_DATA_MODEL_ERD.md` §4.2, строка 250 ("CHECK: `endDate IS NULL OR endDate >= startDate`").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT`/`UPDATE Employment` с `startDate` позже `endDate` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-02 `ck_employment_inactive_metadata_shape`

- Table: `Employment`
- Predicate:
  ```sql
  "active" = true
  OR
  ( "active" = false AND "endDate" IS NOT NULL AND "deactivationReason" IS NOT NULL )
  ```
- Правило DEC-05: `active=true` не обязан принудительно очищать исторические `endDate`/`deactivationReason` — предикат допускает оба варианта при `active=true`.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.2, строка 248 ("обязателен при `active=false`").
- Documentation synchronization: PARTIAL — правило описано прозой, точного CHECK-предиката в `03_DATA_MODEL_ERD.md` нет.
- Minimum negative test: `UPDATE Employment SET active=false` без `endDate` или без `deactivationReason` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-03 `ck_absence_date_range`

- Table: `Absence`
- Predicate:
  ```sql
  "endDate" >= "startDate"
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.2, строка 283 ("CHECK: `endDate >= startDate`").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT Absence` с `endDate < startDate` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-04 `ck_absence_status_metadata_shape`

- Table: `Absence`
- Predicate (точная утверждённая форма, DEC-05):
  ```sql
  CHECK (
    (
      "status" = 'PENDING'
      AND "approvedByUserId" IS NULL
      AND "approvedAt" IS NULL
      AND "overlayAppliedDates" IS NULL
      AND "overlayConflicts" IS NULL
    )
    OR
    (
      "status" = 'REJECTED'
      AND "approvedByUserId" IS NULL
      AND "approvedAt" IS NULL
      AND "overlayAppliedDates" IS NULL
      AND "overlayConflicts" IS NULL
    )
    OR
    (
      "status" = 'APPROVED'
      AND "approvedByUserId" IS NOT NULL
      AND "approvedAt" IS NOT NULL
      AND "overlayAppliedDates" IS NOT NULL
      AND jsonb_typeof("overlayAppliedDates") = 'array'
      AND "overlayConflicts" IS NOT NULL
      AND jsonb_typeof("overlayConflicts") = 'array'
    )
  )
  ```
- Structural readiness: `prisma/schema.prisma:120-142` — `status`, `approvedByUserId`, `approvedAt`, `overlayAppliedDates`, `overlayConflicts` присутствуют с nullability, точно соответствующей предикату.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.2, строки 279-280 (описание nullability полей, без явного CHECK).
- Documentation synchronization: PARTIAL.
- Minimum negative test: `UPDATE Absence SET status='APPROVED'` без одновременной записи `approvedByUserId`/`approvedAt`/`overlayAppliedDates`/`overlayConflicts` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-05 `ck_site_assignment_date_range`

- Table: `SiteAssignment`
- Predicate:
  ```sql
  "validTo" IS NULL OR "validTo" >= "validFrom"
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.4, строка 465 ("CHECK: `validTo IS NULL OR validTo >= validFrom`").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT SiteAssignment` с `validTo < validFrom` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-06 `ck_work_schedule_template_version_day_weekday_range`

- Table: `WorkScheduleTemplateVersionDay`
- Predicate:
  ```sql
  "weekday" BETWEEN 0 AND 6
  ```
- Structural readiness: `prisma/schema.prisma:223` — `weekday Int @db.SmallInt`.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.5, строка 515 (`weekday smallint (0=Mon..6=Sun)` — комментарий, без CHECK).
- Documentation synchronization: MISSING.
- Minimum negative test: `INSERT WorkScheduleTemplateVersionDay` с `weekday=7` или `weekday=-1` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-07 `ck_work_schedule_template_version_day_shape`

- Table: `WorkScheduleTemplateVersionDay`
- Predicate:
  ```sql
  (
    "isWorkingDay" = true
    AND "plannedStartTime" IS NOT NULL
    AND "plannedEndTime" IS NOT NULL
  )
  OR
  (
    "isWorkingDay" = false
    AND "plannedStartTime" IS NULL
    AND "plannedEndTime" IS NULL
    AND "plannedBreakMinutes" = 0
  )
  ```
- Structural readiness: `prisma/schema.prisma:220-234` — `isWorkingDay Boolean`, `plannedStartTime DateTime? @db.Time(0)`, `plannedEndTime DateTime? @db.Time(0)`, `plannedBreakMinutes Int`.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.5, строки 515-517 (список полей, без явного shape-CHECK).
- Documentation synchronization: MISSING.
- Minimum negative test 1: `INSERT WorkScheduleTemplateVersionDay` с `isWorkingDay=true` и `plannedStartTime IS NULL` — ожидается отказ, SQLSTATE `23514` (`check_violation`).
- Minimum negative test 2: `INSERT WorkScheduleTemplateVersionDay` с `isWorkingDay=false`, `plannedStartTime=NULL`, `plannedEndTime=NULL`, `plannedBreakMinutes=1` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-08 `ck_schedule_template_version_day_break_minutes_nonnegative`

- Table: `WorkScheduleTemplateVersionDay`
- Predicate:
  ```sql
  "plannedBreakMinutes" >= 0
  ```
- Structural readiness: `prisma/schema.prisma:227` — `plannedBreakMinutes Int`.
- Source: DEC-05 (owner-approved).
- Documentation synchronization: MISSING — `03_DATA_MODEL_ERD.md` не содержит явного `>= 0` требования для этого поля.
- Name revision: исходное имя `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative`
  (71 bytes) превышало лимит PostgreSQL в 63 bytes и было молча обрезано движком при runtime-проверке
  (см. `IMPLEMENTATION_STATUS.md`, runtime-аудит на HEAD `bebd6aa`). Имя сокращено до
  `ck_schedule_template_version_day_break_minutes_nonnegative` (58 bytes) до первого permanent
  deployment. Предикат и семантика не изменились.
- Minimum negative test: `INSERT WorkScheduleTemplateVersionDay` с `plannedBreakMinutes=-1` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-09 `ck_payroll_period_date_range`

- Table: `PayrollPeriod`
- Predicate:
  ```sql
  "endDate" >= "startDate"
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.5, строка 521 ("CHECK: `endDate >= startDate`").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT PayrollPeriod` с `endDate < startDate` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-10 `ck_payroll_period_status_metadata_shape`

- Table: `PayrollPeriod`
- Predicate:
  ```sql
  ( "status" = 'OPEN' AND "lockedAt" IS NULL AND "lockedByUserId" IS NULL AND "exportedAt" IS NULL )
  OR
  ( "status" = 'LOCKED' AND "lockedAt" IS NOT NULL AND "lockedByUserId" IS NOT NULL AND "exportedAt" IS NULL )
  OR
  ( "status" = 'EXPORTED' AND "lockedAt" IS NOT NULL AND "lockedByUserId" IS NOT NULL AND "exportedAt" IS NOT NULL )
  ```
- Structural readiness: `prisma/schema.prisma:267-285` — `status`, `lockedAt`, `lockedByUserId`, `exportedAt` присутствуют с нужной nullability.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.5, строки 519-521 (список полей, без CHECK).
- Documentation synchronization: MISSING.
- Minimum negative test: `UPDATE PayrollPeriod SET status='LOCKED'` без `lockedAt`/`lockedByUserId` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-11 `ck_payroll_period_participant_exclusion_metadata_shape`

- Table: `PayrollPeriodParticipant`
- Predicate:
  ```sql
  ( "expected" = true AND "exclusionReason" IS NULL AND "excludedByUserId" IS NULL AND "excludedAt" IS NULL )
  OR
  ( "expected" = false AND "exclusionReason" IS NOT NULL AND "excludedByUserId" IS NOT NULL AND "excludedAt" IS NOT NULL )
  ```
- Structural readiness: `prisma/schema.prisma:287-304` — `expected`, `exclusionReason`, `excludedByUserId`, `excludedAt` присутствуют с нужной nullability.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.5, строка 527 ("обязателен при `expected=false`").
- Documentation synchronization: PARTIAL.
- Minimum negative test: `UPDATE PayrollPeriodParticipant SET expected=false` без `exclusionReason` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-12 `ck_timesheet_draft_planned_shift_shape`

- Table: `TimesheetDraftPlannedShift`
- Predicate:
  ```sql
  ( "plannedStartAt" IS NOT NULL AND "plannedEndAt" IS NOT NULL AND "plannedEndAt" > "plannedStartAt" )
  OR
  ( "plannedStartAt" IS NULL AND "plannedEndAt" IS NULL AND "plannedBreakMinutes" = 0 )
  ```
- Structural readiness: `prisma/schema.prisma:368-390` — `plannedStartAt DateTime?`, `plannedEndAt DateTime?`, `plannedBreakMinutes Int`.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.6, строки 797-811 (описание полей), строка 1207 (снимок non-working дня: `plannedStartAt=plannedEndAt=null`, `plannedBreakMinutes=0`).
- Documentation synchronization: PARTIAL — non-working-снимок описан прозой, working-снимок и точный CHECK-предикат не приведены явно.
- Minimum negative test: `INSERT TimesheetDraftPlannedShift` с `plannedStartAt` заполнен и `plannedEndAt IS NULL` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-13 `ck_timesheet_draft_shift_break_minutes_nonnegative`

- Table: `TimesheetDraftPlannedShift`
- Predicate:
  ```sql
  "plannedBreakMinutes" >= 0
  ```
- Structural readiness: `prisma/schema.prisma:378`.
- Source: DEC-05 (owner-approved).
- Documentation synchronization: MISSING.
- Name revision: исходное имя `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative`
  (66 bytes) превышало лимит PostgreSQL в 63 bytes и было молча обрезано движком при runtime-проверке
  (см. `IMPLEMENTATION_STATUS.md`, runtime-аудит на HEAD `bebd6aa`). Имя сокращено до
  `ck_timesheet_draft_shift_break_minutes_nonnegative` (50 bytes) до первого permanent deployment.
  Предикат и семантика не изменились.
- Minimum negative test: `INSERT TimesheetDraftPlannedShift` с `plannedBreakMinutes=-1` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-14 `ck_timesheet_draft_segment_interval`

- Table: `TimesheetDraftSegment`
- Predicate:
  ```sql
  "endAt" > "startAt"
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.6, строка 840 ("CHECK: `endAt > startAt`").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT TimesheetDraftSegment` с `endAt <= startAt` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-15 `ck_timesheet_draft_segment_local_date`

- Table: `TimesheetDraftSegment`
- Predicate:
  ```sql
  "date" = ("startAt" AT TIME ZONE 'Europe/Helsinki')::date
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.6, строки 832, 920-921.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT TimesheetDraftSegment` с `date`, не совпадающим с хельсинкской календарной датой `startAt` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-16 `ck_timesheet_draft_break_segment_interval`

- Table: `TimesheetDraftBreakSegment`
- Predicate:
  ```sql
  "endAt" > "startAt"
  ```
- Source: `03_DATA_MODEL_ERD.md` §5, строка 1629 ("`endAt > startAt`, оба поля обязательны" — "CHECK на каждой из трёх таблиц").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT TimesheetDraftBreakSegment` с `endAt <= startAt` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-17 `ck_timesheet_planned_shift_shape`

- Table: `TimesheetPlannedShift`
- Predicate:
  ```sql
  ( "plannedStartAt" IS NOT NULL AND "plannedEndAt" IS NOT NULL AND "plannedEndAt" > "plannedStartAt" )
  OR
  ( "plannedStartAt" IS NULL AND "plannedEndAt" IS NULL AND "plannedBreakMinutes" = 0 )
  ```
- Structural readiness: `prisma/schema.prisma:477-499`.
- Source: DEC-05 (owner-approved). Legacy prose: `03_DATA_MODEL_ERD.md` §4.6, строка 1008 ("заморожен из `TimesheetDraftPlannedShift`") — та же форма наследуется по построению.
- Documentation synchronization: PARTIAL.
- Minimum negative test: `INSERT TimesheetPlannedShift` с `plannedStartAt` заполнен и `plannedEndAt IS NULL` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-18 `ck_timesheet_planned_shift_planned_break_minutes_nonnegative`

- Table: `TimesheetPlannedShift`
- Predicate:
  ```sql
  "plannedBreakMinutes" >= 0
  ```
- Structural readiness: `prisma/schema.prisma:487`.
- Source: DEC-05 (owner-approved).
- Documentation synchronization: MISSING.
- Minimum negative test: `INSERT TimesheetPlannedShift` с `plannedBreakMinutes=-1` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-19 `ck_work_segment_interval`

- Table: `WorkSegment`
- Predicate:
  ```sql
  "endAt" > "startAt"
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.6, строка 1055 ("CHECK: `endAt > startAt`").
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT WorkSegment` с `endAt <= startAt` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-20 `ck_work_segment_local_date`

- Table: `WorkSegment`
- Predicate:
  ```sql
  "date" = ("startAt" AT TIME ZONE 'Europe/Helsinki')::date
  ```
- Source: `03_DATA_MODEL_ERD.md` §4.6, строка 1046.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT WorkSegment` с несовпадающей `date` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

### CK-21 `ck_break_segment_interval`

- Table: `BreakSegment`
- Predicate:
  ```sql
  "endAt" > "startAt"
  ```
- Source: `03_DATA_MODEL_ERD.md` §5, строка 1629 (та же строка, три таблицы).
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT BreakSegment` с `endAt <= startAt` — ожидается отказ, SQLSTATE `23514` (`check_violation`).

---

## 2. Future backlog — excluded from current totals

| ID | Table | Subject | Counted in current 21 | Future delta |
|---|---|---|---|---|
| CK-F01 | `CorrectionRequest` | `approvalOverride` / `overrideReason` shape | no | +1 CHECK |

`CorrectionRequest` не входит в current foundation schema (`prisma/schema.prisma`), поэтому точный SQL-предикат CK-F01 не фиксируется в этом register — таблица, к которой он применится, ещё не существует.

---

## 3. Current EXCLUDE constraint register

| ID | Exact constraint name | Table | Current / Future |
|---|---|---|---|
| EX-01 | `ex_absence_active_date_overlap` | `Absence` | current |
| EX-02 | `ex_site_assignment_scope_date_overlap` | `SiteAssignment` | current |
| EX-03 | `ex_payroll_period_date_overlap` | `PayrollPeriod` | retired by `20260821100000` (T9 worker-specific submission cycles) |
| EX-04 | `ex_timesheet_draft_segment_time_overlap` | `TimesheetDraftSegment` | current |
| EX-05 | `ex_timesheet_draft_break_segment_time_overlap` | `TimesheetDraftBreakSegment` | current |
| EX-06 | `ex_break_segment_time_overlap` | `BreakSegment` | current |
| EX-07 | `ex_employee_timesheet_schedule_date_overlap` | `EmployeeTimesheetSchedule` | current |

### EX-01 `ex_absence_active_date_overlap`

- Table: `Absence`
- Key:
  ```sql
  "employeeId" WITH =,
  daterange("startDate", "endDate" + 1, '[)') WITH &&
  ```
- Partial predicate:
  ```sql
  WHERE ("status" IN ('PENDING', 'APPROVED'))
  ```
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_absence_active_date_overlap`.
- `[)`-семантика (date range): доменная `endDate` включительна, поэтому верхняя exclusive-граница строится как следующий календарный день (`endDate + 1`) — это конвертирует включительную календарную дату в exclusive-границу диапазона, сохраняя обе даты (`startDate`, `endDate`) включительными в терминах предметной области. Смежные периоды одного `employeeId`, где `left.endDate + 1 = right.startDate`, допустимы. Реальное пересечение дат отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §4.2, строки 283-295.
- Documentation synchronization: SYNCED.
- Minimum negative test: два `Absence` одного `employeeId`, оба `status IN (PENDING, APPROVED)`, с пересекающимися датами — второй `INSERT` отклонён, SQLSTATE `23P01`.

### EX-02 `ex_site_assignment_scope_date_overlap`

- Table: `SiteAssignment`
- Key:
  ```text
  employeeId
  siteId
  COALESCE(workAreaId, zero UUID)
  daterange(validFrom, validTo + 1 day, '[)')
  ```
- `validTo IS NULL` трактуется как infinity в фактической миграции.
- Ограничение запрещает только пересекающийся дубликат одного назначения на тот же `employeeId + siteId + workAreaId`; разные объекты одновременно разрешены.
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_site_assignment_scope_date_overlap`.
- `[)`-семантика (date range): доменная `validTo` включительна, поэтому верхняя exclusive-граница строится как следующий календарный день (`validTo + 1`), либо `infinity` при `validTo IS NULL`. Смежные назначения одного `employeeId+siteId+workAreaId`, где `left.validTo + 1 = right.validFrom`, допустимы. Реальное пересечение дат отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §4.4, строки 465-471.
- Documentation synchronization: SYNCED.
- Minimum negative test: два `SiteAssignment` одного `employeeId`+`siteId`+`workAreaId` с пересекающимися `[validFrom, validTo]` — второй `INSERT` отклонён, SQLSTATE `23P01`; тот же тест с разным `siteId` — оба `INSERT` проходят.

### EX-03 `ex_payroll_period_date_overlap`

- Table: `PayrollPeriod`
- Key:
  ```sql
  daterange("startDate", "endDate" + 1, '[)') WITH &&
  ```
- Historical foundation rule. Retired by additive migration `20260821100000`: weekly and
  biweekly worker cohorts must be allowed to overlap. Its replacement is the participant-scoped
  trigger registered in §14, which rejects overlap only for the same expected employee.
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_payroll_period_date_overlap`.
- `[)`-семантика (date range): доменная `endDate` включительна, поэтому верхняя exclusive-граница строится как следующий календарный день (`endDate + 1`). Смежные периоды, где `left.endDate + 1 = right.startDate`, допустимы. Реальное пересечение дат отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §4.5, строки 521-524.
- Documentation synchronization: SYNCED.
- Minimum negative test: два `PayrollPeriod` с пересекающимися датами — второй `INSERT` отклонён, SQLSTATE `23P01`; смежные периоды (`endDate` одного = `startDate - 1` следующего) — оба `INSERT` проходят.

### EX-07 `ex_employee_timesheet_schedule_date_overlap`

- Table: `EmployeeTimesheetSchedule`.
- Key: `employeeId WITH =` plus inclusive effective date range converted to `[effectiveFrom,
  effectiveTo + 1)`, with null end as infinity.
- SQLSTATE: `23P01`; exact service identity above.
- Different employees may use overlapping schedules. The same employee cannot have two active
  schedule definitions on one date.
- Source: `T9_TIMESHEET_CYCLES_MAP_DESIGN.md` §2.2.

### EX-04 `ex_timesheet_draft_segment_time_overlap`

- Table: `TimesheetDraftSegment`
- Key:
  ```sql
  "draftId" WITH =,
  "employeeId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
  ```
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_timesheet_draft_segment_time_overlap`.
- `[)`-семантика (time range): момент `endAt` не принадлежит интервалу. Смежные интервалы одного `draftId`+`employeeId`, где `left.endAt = right.startAt`, допустимы. Реальное пересечение интервалов отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §3, строка 154; §4.6, строка 967.
- Documentation synchronization: SYNCED.
- Minimum negative test: два сегмента одного `draftId` с пересекающимися `[startAt, endAt)` — второй `INSERT` отклонён, SQLSTATE `23P01`; смежные интервалы (`endAt` одного = `startAt` следующего) — оба `INSERT` проходят, поскольку верхняя граница `[)` исключена.

### EX-05 `ex_timesheet_draft_break_segment_time_overlap`

- Table: `TimesheetDraftBreakSegment`
- Key:
  ```sql
  "draftSegmentId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
  ```
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_timesheet_draft_break_segment_time_overlap`.
- `[)`-семантика (time range): момент `endAt` не принадлежит интервалу. Смежные перерывы одного `draftSegmentId`, где `left.endAt = right.startAt`, допустимы. Реальное пересечение интервалов отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §5, строка 1631 ("Перерывы одного родителя не пересекаются друг с другом" — "на каждой из трёх таблиц").
- Documentation synchronization: SYNCED.
- Minimum negative test: два перерыва одного `draftSegmentId` с пересекающимися интервалами — второй `INSERT` отклонён, SQLSTATE `23P01`.

### EX-06 `ex_break_segment_time_overlap`

- Table: `BreakSegment`
- Key:
  ```sql
  "workSegmentId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
  ```
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_break_segment_time_overlap`.
- `[)`-семантика (time range): момент `endAt` не принадлежит интервалу. Смежные перерывы одного `workSegmentId`, где `left.endAt = right.startAt`, допустимы. Реальное пересечение интервалов отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §5, строка 1631 (та же строка, три таблицы).
- Documentation synchronization: SYNCED.
- Minimum negative test: два перерыва одного `workSegmentId` с пересекающимися интервалами — второй `INSERT` отклонён, SQLSTATE `23P01`.

---

## 4. Required PostgreSQL extension

| ID | Exact extension | Required form | Current count |
|---|---|---|---|
| EXT-01 | `btree_gist` | `CREATE EXTENSION IF NOT EXISTS btree_gist;` | 1 |

Reason: scalar equality operators (`employeeId`, `siteId`, `workAreaId`, `draftId`, `draftSegmentId`, `workSegmentId` — все `uuid`) внутри GiST-backed `EXCLUDE`-ограничений (EX-01…EX-06) требуют операторного класса, который предоставляет `btree_gist`. Это запись спецификации — `CREATE EXTENSION` в рамках этой задачи не выполняется.

---

## 5. Trigger function register

| ID | Exact function name | Current / Future |
|---|---|---|
| FN-01 | `fn_segment_assignment_scope_check` | current |
| FN-02 | `fn_planned_shift_validity_check` | current |
| FN-03 | `fn_timesheet_draft_day_state_check` | current |
| FN-04 | `fn_timesheet_draft_segment_day_state_check` | current |
| FN-05 | `fn_timesheet_day_state_check` | current |
| FN-06 | `fn_work_segment_day_state_check` | current |
| FN-07 | `fn_timesheet_draft_break_segment_containment_check` | current |
| FN-08 | `fn_break_segment_containment_check` | current |
| FN-09 | `fn_site_assignment_dependents_guard` | current |
| FN-10 | `fn_timesheet_draft_segment_breaks_guard` | current |
| FN-11 | `fn_work_segment_breaks_guard` | current |

### FN-01 `fn_segment_assignment_scope_check`

- Affected tables: `TimesheetDraftSegment`, `WorkSegment`.
- Purpose: проверяет, что `sourceAssignmentId` строки принадлежит тому же `employeeId` и `siteId`; что `workAreaId`, если указан, принадлежит тому же `siteId`; что `date` строки входит в диапазон `SiteAssignment.validFrom..validTo`.
- Row-lock behavior: связанная строка `SiteAssignment` блокируется через `FOR SHARE` перед чтением её `employeeId`/`siteId`/`workAreaId`/`validFrom`/`validTo`.
- Stable exception identifiers: `ASSIGNMENT_SCOPE_MISMATCH`, `ASSIGNMENT_DATE_OUTSIDE_VALIDITY`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md`, строки 866-893 (определение функции), строки 907-908 (legacy текст исключения — см. раздел 7).
- Negative tests: сегмент с `sourceAssignmentId`, чей `employeeId`/`siteId` не совпадает со строкой сегмента — отказ `ASSIGNMENT_SCOPE_MISMATCH`; сегмент с `date` вне `validFrom..validTo` назначения — отказ `ASSIGNMENT_DATE_OUTSIDE_VALIDITY`.
- Concurrency tests: параллельный `INSERT` сегмента и `UPDATE SiteAssignment.validTo`, сокращающий валидность — одна из транзакций должна дождаться `FOR SHARE`-блокировки другой, итоговое состояние не должно допускать сегмент вне итоговой валидности.

### FN-02 `fn_planned_shift_validity_check`

- Affected tables: `TimesheetDraftPlannedShift`, `TimesheetPlannedShift`.
- Purpose: проверяет, что plan-снимок (`date`, `plannedStartAt`, `plannedEndAt`) не выходит за пределы валидности исходного `SiteAssignment`.
- Row-lock behavior: связанная строка `SiteAssignment` блокируется через `FOR SHARE` перед проверкой.
- Stable exception identifier: `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md`, строки 945-954 (legacy текст исключения — см. раздел 7).
- Negative tests: снимок с `date` вне `validFrom..validTo` назначения — отказ `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY`.
- Concurrency tests: параллельный `INSERT` снимка и `UPDATE SiteAssignment.validTo` — тот же порядок блокировки, что в FN-01.

### FN-03 `fn_timesheet_draft_day_state_check`

- Affected table: `TimesheetDraftDay` (day-side функция пары).
- Purpose: при изменении `dayType`/`confirmedZero` проверяет согласованность итогового состояния строки дня с количеством уже существующих дочерних `TimesheetDraftSegment`.
- Row-lock behavior: целевая строка дня уже заблокирована самим `UPDATE` (Postgres блокирует целевую строку до вызова `BEFORE ROW`-триггера); функция читает количество дочерних сегментов после того, как эта блокировка уже удерживается.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md` §4.6, строки 727-741 («Concurrency-safe реализация — единый порядок блокировок»).
- Negative tests: `UPDATE TimesheetDraftDay SET dayType != WORK` при существовании дочерних сегментов — отказ `DAY_TYPE_CONFLICT`; `UPDATE TimesheetDraftDay SET confirmedZero=true` при существовании сегментов — отказ `DAY_STATE_CONFLICT`.
- Concurrency tests: параллельный `INSERT` сегмента (FN-04) и `UPDATE` дня (FN-03) на одну и ту же день-строку — обе стороны обязаны получить блокировку день-строки до принятия решения; порядок блокировки должен быть единым.

### FN-04 `fn_timesheet_draft_segment_day_state_check`

- Affected table: `TimesheetDraftSegment` (child-side функция пары).
- Purpose: первым действием блокирует соответствующую строку `TimesheetDraftDay` через `FOR UPDATE`, затем читает её `dayType`/`confirmedZero` и разрешает вставку/изменение сегмента только при `dayType=WORK` и `confirmedZero=false`.
- Row-lock behavior: `FOR UPDATE` на родительской `TimesheetDraftDay` — первое действие функции, до чтения `dayType`/`confirmedZero`.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md` §4.6, строки 733-738.
- Negative tests: `INSERT TimesheetDraftSegment` на день с `dayType != WORK` — отказ `DAY_TYPE_CONFLICT`; на день с `confirmedZero=true` — отказ `DAY_STATE_CONFLICT`.
- Concurrency tests: см. FN-03.

### FN-05 `fn_timesheet_day_state_check`

- Affected table: `TimesheetDay` (day-side функция immutable-пары).
- Purpose: тот же контракт, что FN-03, применённый к immutable `TimesheetDay`/`WorkSegment`.
- Row-lock behavior: идентично FN-03.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md` §4.6, строки 727-741 (единое правило для всех трёх пар, включая `TimesheetDay`/`WorkSegment`).
- Negative tests: аналогичны FN-03, применены к `TimesheetDay`.
- Concurrency tests: аналогичны FN-03, применены к паре `TimesheetDay`/`WorkSegment`.

### FN-06 `fn_work_segment_day_state_check`

- Affected table: `WorkSegment` (child-side функция immutable-пары).
- Purpose: тот же контракт, что FN-04, применённый к `WorkSegment`/`TimesheetDay`.
- Row-lock behavior: идентично FN-04.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md` §4.6, строки 727-741.
- Negative tests: аналогичны FN-04, применены к `WorkSegment`.
- Concurrency tests: аналогичны FN-04.

### FN-07 `fn_timesheet_draft_break_segment_containment_check`

- Affected tables: child `TimesheetDraftBreakSegment`, parent `TimesheetDraftSegment`.
- Purpose: блокирует родительский `TimesheetDraftSegment` через `FOR UPDATE`, проверяет `parent.startAt <= child.startAt` и `child.endAt <= parent.endAt`.
- Row-lock behavior: `FOR UPDATE` на родительском сегменте — первое действие функции.
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md` §5, строка 1630 (общее описание child-side containment-триггера на трёх таблицах).
- Negative tests: `INSERT TimesheetDraftBreakSegment` с `startAt` раньше родительского `startAt`, либо `endAt` позже родительского `endAt` — отказ `BREAK_OUTSIDE_PARENT`.
- Concurrency tests: параллельный `INSERT` перерыва (FN-07) и `UPDATE TimesheetDraftSegment.startAt/endAt` (FN-10, DEC-02) — обе функции должны сериализоваться через блокировку родительского сегмента.

### FN-08 `fn_break_segment_containment_check`

- Affected tables: child `BreakSegment`, parent `WorkSegment`.
- Purpose: тот же контракт, что FN-07, применённый к immutable `BreakSegment`/`WorkSegment`.
- Row-lock behavior: идентично FN-07.
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: `03_DATA_MODEL_ERD.md` §5, строка 1630.
- Negative tests: аналогичны FN-07, применены к `BreakSegment`.
- Concurrency tests: параллельный `INSERT` перерыва (FN-08) и `UPDATE WorkSegment.startAt/endAt` (FN-11, DEC-02).

### FN-09 `fn_site_assignment_dependents_guard` — DEC-01

- Affected table: `SiteAssignment` (проверяет зависимые current-таблицы `TimesheetDraftSegment`, `WorkSegment`, `TimesheetDraftPlannedShift`, `TimesheetPlannedShift`).
- Purpose: при изменении `validFrom`/`validTo` проверяет, что новый диапазон `NEW.validFrom .. COALESCE(NEW.validTo, infinity)` совместим с существующими зависимыми строками:
  - `WorkSegment` и `TimesheetPlannedShift` всегда блокируют несовместимое сокращение;
  - пользовательский `TimesheetDraftSegment` блокирует сокращение и автоматически не переносится;
  - `TimesheetDraftPlannedShift` блокирует прямой SQL `UPDATE`;
  - контролируемый `assignment.split` может атомарно удалить или регенерировать разрешённые draft planned-снимки до изменения validity;
  - `CorrectionDraftSegment` не входит в current scope.
- Row-lock behavior: сериализующая точка — изменяемая строка `SiteAssignment`; функция не берёт без необходимости row locks на dependent-строках.
- Stable exception identifier: `ASSIGNMENT_DEPENDENTS_CONFLICT`.
- SQLSTATE: `P0001`.
- Supported service isolation level: `READ COMMITTED`. При `REPEATABLE READ`/`SERIALIZABLE` результат `40001` — retryable outcome для всей транзакции.
- Current/future: current.
- Source: DEC-01 (owner-approved).
- Documentation synchronization: MISSING — `ASSIGNMENT_DEPENDENTS_CONFLICT` и текст этой функции отсутствуют в `03_DATA_MODEL_ERD.md` (0 совпадений при поиске).
- Negative tests: `UPDATE SiteAssignment SET validTo = <дата раньше существующего WorkSegment.date>` — отказ `ASSIGNMENT_DEPENDENTS_CONFLICT`.
- Concurrency tests: параллельный `UPDATE SiteAssignment.validFrom/validTo` и child-side `INSERT` (FN-01/FN-02) на ту же assignment — сериализация через блокировку изменяемой строки `SiteAssignment`; проверка `40001`-retry под `REPEATABLE READ`.

### FN-10 `fn_timesheet_draft_segment_breaks_guard` — DEC-02

- Affected table: `TimesheetDraftSegment` (parent-side, проверяет child `TimesheetDraftBreakSegment`).
- Purpose: при изменении `startAt`/`endAt` проверяет, что все существующие дочерние перерывы остаются внутри нового интервала: `NEW.startAt <= child.startAt AND child.endAt <= NEW.endAt`.
- Row-lock behavior: запрещены блокировки дочерних break-строк — `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE` не используются этой функцией.
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: DEC-02 (owner-approved).
- Documentation synchronization: MISSING — отсутствует в `03_DATA_MODEL_ERD.md` (0 совпадений при поиске).
- Negative tests: `UPDATE TimesheetDraftSegment SET endAt = <раньше существующего child.endAt>` — отказ `BREAK_OUTSIDE_PARENT`.
- Concurrency tests: параллельный `UPDATE TimesheetDraftSegment.startAt/endAt` (FN-10) и `INSERT`/`UPDATE TimesheetDraftBreakSegment` (FN-07) — обе функции сериализуются через блокировку родительского сегмента, которую берёт исключительно child-side функция (FN-07); parent-side функция (FN-10) блокировки не берёт.

### FN-11 `fn_work_segment_breaks_guard` — DEC-02

- Affected table: `WorkSegment` (parent-side, проверяет child `BreakSegment`).
- Purpose: тот же контракт, что FN-10, применённый к immutable `WorkSegment`/`BreakSegment`.
- Row-lock behavior: идентично FN-10 — запрещены блокировки дочерних `BreakSegment`-строк.
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- SQLSTATE: `P0001`.
- Current/future: current.
- Source: DEC-02 (owner-approved).
- Documentation synchronization: MISSING.
- Negative tests: `UPDATE WorkSegment SET endAt = <раньше существующего child.endAt>` — отказ `BREAK_OUTSIDE_PARENT`.
- Concurrency tests: параллельный `UPDATE WorkSegment.startAt/endAt` (FN-11) и `INSERT`/`UPDATE BreakSegment` (FN-08) — сериализация через блокировку родительского сегмента, которую берёт исключительно FN-08.

---

## 6. Trigger instance register

Полная identity триггера — `table + trigger name` (PostgreSQL требует уникальность имени триггера внутри одной таблицы, не глобально; повторение имён `trg_segment_assignment_scope_check` и `trg_planned_shift_validity_check` на разных таблицах — намеренное).

| ID | Table | Exact trigger name | Function | Current / Future |
|---|---|---|---|---|
| TRG-01 | `TimesheetDraftSegment` | `trg_segment_assignment_scope_check` | FN-01 | current |
| TRG-02 | `WorkSegment` | `trg_segment_assignment_scope_check` | FN-01 | current |
| TRG-03 | `TimesheetDraftPlannedShift` | `trg_planned_shift_validity_check` | FN-02 | current |
| TRG-04 | `TimesheetPlannedShift` | `trg_planned_shift_validity_check` | FN-02 | current |
| TRG-05 | `TimesheetDraftDay` | `trg_timesheet_draft_day_state_check` | FN-03 | current |
| TRG-06 | `TimesheetDraftSegment` | `trg_timesheet_draft_segment_day_state_check` | FN-04 | current |
| TRG-07 | `TimesheetDay` | `trg_timesheet_day_state_check` | FN-05 | current |
| TRG-08 | `WorkSegment` | `trg_work_segment_day_state_check` | FN-06 | current |
| TRG-09 | `TimesheetDraftBreakSegment` | `trg_timesheet_draft_break_segment_containment_check` | FN-07 | current |
| TRG-10 | `BreakSegment` | `trg_break_segment_containment_check` | FN-08 | current |
| TRG-11 | `SiteAssignment` | `trg_site_assignment_dependents_guard` | FN-09 | current |
| TRG-12 | `TimesheetDraftSegment` | `trg_timesheet_draft_segment_breaks_guard` | FN-10 | current |
| TRG-13 | `WorkSegment` | `trg_work_segment_breaks_guard` | FN-11 | current |

### TRG-01

- Table: `TimesheetDraftSegment`
- Trigger name: `trg_segment_assignment_scope_check`
- Function: `fn_segment_assignment_scope_check` (FN-01)
- Timing: `BEFORE`
- Events: `INSERT OR UPDATE`
- `UPDATE OF` columns: `sourceAssignmentId, employeeId, date, siteId, workAreaId`
- `WHEN`: не задан (срабатывает на каждый `INSERT`; для `UPDATE` ограничен column list выше).
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-01.
- Stable exception identifiers: `ASSIGNMENT_SCOPE_MISMATCH`, `ASSIGNMENT_DATE_OUTSIDE_VALIDITY`.
- Minimum negative test: см. FN-01.
- Minimum concurrency test: см. FN-01.

### TRG-02

- Table: `WorkSegment`
- Trigger name: `trg_segment_assignment_scope_check`
- Function: `fn_segment_assignment_scope_check` (FN-01)
- Timing: `BEFORE`
- Events: `INSERT OR UPDATE`
- `UPDATE OF` columns: `sourceAssignmentId, employeeId, date, siteId, workAreaId`
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-01.
- Stable exception identifiers: `ASSIGNMENT_SCOPE_MISMATCH`, `ASSIGNMENT_DATE_OUTSIDE_VALIDITY`.
- Minimum negative test: см. FN-01.
- Minimum concurrency test: см. FN-01.

### TRG-03

- Table: `TimesheetDraftPlannedShift`
- Trigger name: `trg_planned_shift_validity_check`
- Function: `fn_planned_shift_validity_check` (FN-02)
- Timing: `BEFORE`
- Events: `INSERT OR UPDATE`
- `UPDATE OF` columns: `sourceAssignmentId, employeeId, siteId, date, plannedStartAt, plannedEndAt` — точный список локальных полей, изменение которых способно повлиять на исходное назначение, работника, объект, локальную дату снимка или planned-интервал; проверено по `prisma/schema.prisma:368-390`.
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-02.
- Stable exception identifier: `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY`.
- Minimum negative test: см. FN-02.
- Minimum concurrency test: см. FN-02.

### TRG-04

- Table: `TimesheetPlannedShift`
- Trigger name: `trg_planned_shift_validity_check`
- Function: `fn_planned_shift_validity_check` (FN-02)
- Timing: `BEFORE`
- Events: `INSERT OR UPDATE`
- `UPDATE OF` columns: `sourceAssignmentId, employeeId, siteId, date, plannedStartAt, plannedEndAt` — проверено по `prisma/schema.prisma:477-499`.
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-02.
- Stable exception identifier: `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY`.
- Minimum negative test: см. FN-02.
- Minimum concurrency test: см. FN-02.

### TRG-05

- Table: `TimesheetDraftDay`
- Trigger name: `trg_timesheet_draft_day_state_check`
- Function: `fn_timesheet_draft_day_state_check` (FN-03)
- Timing: `BEFORE`
- Events: `UPDATE OF dayType, confirmedZero`
- `WHEN`: `OLD.dayType IS DISTINCT FROM NEW.dayType OR OLD.confirmedZero IS DISTINCT FROM NEW.confirmedZero`
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-03.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- Minimum negative test: см. FN-03.
- Minimum concurrency test: см. FN-03.

### TRG-06 — DEC-03

- Table: `TimesheetDraftSegment`
- Trigger name: `trg_timesheet_draft_segment_day_state_check`
- Function: `fn_timesheet_draft_segment_day_state_check` (FN-04)
- Timing: `BEFORE`
- Events:
  - `INSERT`
  - `UPDATE OF draftDayId, draftId, employeeId, date, startAt, endAt, siteId, workAreaId, sourceAssignmentId`
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-04.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- Minimum negative test: см. FN-04.
- Minimum concurrency test: см. FN-04.

### TRG-07

- Table: `TimesheetDay`
- Trigger name: `trg_timesheet_day_state_check`
- Function: `fn_timesheet_day_state_check` (FN-05)
- Timing: `BEFORE`
- Events: `UPDATE OF dayType, confirmedZero`
- `WHEN`: `OLD.dayType IS DISTINCT FROM NEW.dayType OR OLD.confirmedZero IS DISTINCT FROM NEW.confirmedZero`
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-05.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- Minimum negative test: см. FN-05.
- Minimum concurrency test: см. FN-05.

### TRG-08 — DEC-03

- Table: `WorkSegment`
- Trigger name: `trg_work_segment_day_state_check`
- Function: `fn_work_segment_day_state_check` (FN-06)
- Timing: `BEFORE`
- Events:
  - `INSERT`
  - `UPDATE OF timesheetDayId, timesheetVersionId, employeeId, date, startAt, endAt, siteId, workAreaId, sourceAssignmentId`
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-06.
- Stable exception identifiers: `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`.
- Minimum negative test: см. FN-06.
- Minimum concurrency test: см. FN-06.

### TRG-09

- Table: `TimesheetDraftBreakSegment`
- Trigger name: `trg_timesheet_draft_break_segment_containment_check`
- Function: `fn_timesheet_draft_break_segment_containment_check` (FN-07)
- Timing: `BEFORE`
- Events:
  - `INSERT`
  - `UPDATE OF draftSegmentId, startAt, endAt`
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-07.
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- Minimum negative test: см. FN-07.
- Minimum concurrency test: см. FN-07.

### TRG-10

- Table: `BreakSegment`
- Trigger name: `trg_break_segment_containment_check`
- Function: `fn_break_segment_containment_check` (FN-08)
- Timing: `BEFORE`
- Events:
  - `INSERT`
  - `UPDATE OF workSegmentId, startAt, endAt`
- `WHEN`: не задан.
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-08.
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- Minimum negative test: см. FN-08.
- Minimum concurrency test: см. FN-08.

### TRG-11 — DEC-01

- Table: `SiteAssignment`
- Trigger name: `trg_site_assignment_dependents_guard`
- Function: `fn_site_assignment_dependents_guard` (FN-09)
- Timing: `BEFORE`
- Events: `UPDATE OF validFrom, validTo`
- `WHEN`:
  ```sql
  OLD.validFrom IS DISTINCT FROM NEW.validFrom
  OR OLD.validTo IS DISTINCT FROM NEW.validTo
  ```
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-09.
- Stable exception identifier: `ASSIGNMENT_DEPENDENTS_CONFLICT`.
- Minimum negative test: см. FN-09.
- Minimum concurrency test: см. FN-09.

### TRG-12 — DEC-02

- Table: `TimesheetDraftSegment`
- Trigger name: `trg_timesheet_draft_segment_breaks_guard`
- Function: `fn_timesheet_draft_segment_breaks_guard` (FN-10)
- Timing: `BEFORE`
- Events: `UPDATE OF startAt, endAt`
- `WHEN`:
  ```sql
  OLD.startAt IS DISTINCT FROM NEW.startAt
  OR OLD.endAt IS DISTINCT FROM NEW.endAt
  ```
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-10 (parent-side, без блокировок child break rows).
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- Minimum negative test: см. FN-10.
- Minimum concurrency test: см. FN-10.

### TRG-13 — DEC-02

- Table: `WorkSegment`
- Trigger name: `trg_work_segment_breaks_guard`
- Function: `fn_work_segment_breaks_guard` (FN-11)
- Timing: `BEFORE`
- Events: `UPDATE OF startAt, endAt`
- `WHEN`:
  ```sql
  OLD.startAt IS DISTINCT FROM NEW.startAt
  OR OLD.endAt IS DISTINCT FROM NEW.endAt
  ```
- `FOR EACH ROW`: да.
- Row-lock contract: см. FN-11 (parent-side, без блокировок child break rows).
- Stable exception identifier: `BREAK_OUTSIDE_PARENT`.
- Minimum negative test: см. FN-11.
- Minimum concurrency test: см. FN-11.

---

## 7. Stable exception contract

| Identifier | Reserved for | Current / Future |
|---|---|---|
| `DAY_TYPE_CONFLICT` | FN-03, FN-04, FN-05, FN-06 | current |
| `DAY_STATE_CONFLICT` | FN-03, FN-04, FN-05, FN-06 | current |
| `BREAK_OUTSIDE_PARENT` | FN-07, FN-08, FN-10, FN-11 | current |
| `ASSIGNMENT_SCOPE_MISMATCH` | FN-01 | current |
| `ASSIGNMENT_DATE_OUTSIDE_VALIDITY` | FN-01 | current |
| `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY` | FN-02 | current |
| `ASSIGNMENT_DEPENDENTS_CONFLICT` | FN-09 | current |
| `PROPOSAL_RESOLVED_IMMUTABLE` | reserved/frozen identifier, future review layer | future — not counted in current 11 functions or 13 trigger instances (`TimesheetReviewProposal` отсутствует в current foundation schema) |

Контракт для current-функций:

```text
stable uppercase identifier
SQLSTATE P0001
service maps by exact identifier
human-readable message is not an integration contract
```

### Exact service mapping

```text
Native CHECK constraint violation:
SQLSTATE 23514
condition: check_violation
service identity: exact constraint name from the PostgreSQL constraint field

Native EXCLUDE constraint violation:
SQLSTATE 23P01
condition: exclusion_violation
service identity: exact constraint name from the PostgreSQL constraint field

Custom trigger-function violation:
SQLSTATE P0001
service identity: exact stable uppercase identifier
human-readable detail is not an integration contract
```

```text
CHECK and EXCLUDE violations are mapped by exact SQLSTATE plus exact PostgreSQL constraint field.

Custom trigger exceptions use SQLSTATE P0001 and are mapped by exact equality with the frozen uppercase stable identifier.

Substring matching and human-readable message matching are prohibited.
```

### Legacy documentation incompatibility

Следующие формулировки в `03_DATA_MODEL_ERD.md` являются legacy lowercase message-text и не являются integration-контрактом; они требуют документационной синхронизации со стабильными identifiers выше, но не отменяют сами identifiers:

| Legacy text | Location | Stable identifier it must synchronize to |
|---|---|---|
| `assignment_scope_mismatch: workAreaId` | `03_DATA_MODEL_ERD.md`, строки 880, 907 | `ASSIGNMENT_SCOPE_MISMATCH` |
| `assignment_scope_mismatch: date_outside_validity` | `03_DATA_MODEL_ERD.md`, строки 883, 908 | `ASSIGNMENT_DATE_OUTSIDE_VALIDITY` |
| `planned_shift_outside_assignment_validity` | `03_DATA_MODEL_ERD.md`, строка 954 | `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY` |
| `proposal_resolved_immutable` | `03_DATA_MODEL_ERD.md`, строка 1313 | `PROPOSAL_RESOLVED_IMMUTABLE` |

`DAY_TYPE_CONFLICT` и `DAY_STATE_CONFLICT` уже используются в `03_DATA_MODEL_ERD.md` и `README.md` в корректной uppercase-форме как реальные HTTP `409`-коды (например, `03_DATA_MODEL_ERD.md`, строки 157-158, 723-738) — синхронизация не требуется для этих двух identifiers.

---

## 8. Concurrency contracts

### Assignment scope versus validity shrink

- Child-side writes (FN-01, FN-02) блокируют `SiteAssignment` через `FOR SHARE`.
- `UPDATE SiteAssignment` (FN-09/TRG-11) является сериализующей точкой.
- Reverse guard (FN-09) проверяет dependents после получения блокировки изменяемой assignment-строки.
- Reverse guard не берёт необязательные row locks на dependent-строках.
- Основной поддерживаемый isolation level — `READ COMMITTED`.
- `40001` на более сильных isolation levels (`REPEATABLE READ`, `SERIALIZABLE`) повторяет всю транзакцию.

### Day state

- Child segment (FN-04/FN-06) первым действием блокирует день-строку через `FOR UPDATE`.
- Day-side `UPDATE` (FN-03/FN-05) уже владеет блокировкой день-строки к моменту вызова триггера.
- После получения единственной блокировки обе стороны читают актуальное состояние.
- Запрещено принимать решение о валидности до получения блокировки день-строки.

### Break containment

- Child-side break-функция (FN-07/FN-08) блокирует parent segment через `FOR UPDATE`.
- Parent-side segment-функция (FN-10/FN-11) не блокирует child break-строки.
- Оба направления сериализуют изменение границ parent и создание/изменение child через единственную точку блокировки — parent segment row.
- Любое несовместимое итоговое состояние возвращает `BREAK_OUTSIDE_PARENT`, SQLSTATE `P0001`.

---

## 9. Test register

Раздел перечисляет обязательства будущих проверок. Ни один тест не считается выполненным этим документом.

**Specification test obligation** (минимум для каждого current-объекта, обязателен к выполнению до применения migration.sql):

```text
one positive and one negative test per CHECK
one overlap-boundary test per EXCLUDE
adjacent [) ranges accepted
real overlap rejected
one direct-SQL negative test per trigger contract
day-state INSERT versus concurrent day UPDATE
break INSERT/UPDATE versus concurrent parent shrink
assignment child write versus concurrent validity shrink
stable identifier exact-match test
SQLSTATE 23514 test for every CHECK
SQLSTATE 23P01 test for every EXCLUDE
SQLSTATE P0001 test for every trigger function
40001 transaction-retry test for stronger isolation levels
```

**Future migration test** (после появления `migration.sql`, до применения к любой базе, кроме локальной тестовой): повторный прогон всего specification test obligation против реально применённой миграции — сверка, что фактическое поведение СУБД совпадает с этим register.

**Future endpoint/service test** (после появления слоя сервиса/API): проверка, что сервисный слой различает нарушения исключительно по точному SQLSTATE плюс точному имени PostgreSQL-ограничения (для CHECK/EXCLUDE) либо по точному совпадению с замороженным uppercase stable identifier (для custom trigger-исключений); проверка ретрая `40001` на уровне сервиса. Сопоставление по человекочитаемому тексту исключения запрещено.

---

## 10. Arithmetic assertions

```text
CURRENT RAW-SQL TOTALS
CHECK constraints: 21
EXCLUDE constraints: 6
trigger functions: 11
trigger instances: 13
PostgreSQL extensions: 1

FUTURE DELTA
CorrectionRequest.approvalOverride CHECK: +1
```

Current totals exclude CorrectionDraftSegment, correction-layer equivalents, and future review-layer physical objects.

---

## 11. T7A.1 Attendance Clock — schema foundation slice

```text
Status: ACTIVE
Scope: prisma/migrations/20260812000000_add_attendance_clock_schema_foundation
Authority: docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md (owner-approved 2026-08-12)
Prisma version: 6.19.0
PostgreSQL target: 16
```

This section is additive to, and does not modify, Sections 1–10 above (Status: FROZEN, pre-T7A
foundation). All totals in Section 10 remain as stated for the pre-T7A object set; this section's
own totals (§11.7) cover only objects introduced by the T7A.1 schema-foundation migration.

**Exception-identifier convention note**: `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §4.1's own SQL listings
use lowercase snake_case `RAISE EXCEPTION` message text (e.g. `'clock_event_immutable'`,
`'clock_shift_fragment_coverage_gap_or_overlap: %'` with interpolated detail). This migration instead
applies §7's existing stable-uppercase-identifier contract (the same one FN-01..FN-11 already use,
and the same one this register's own "Legacy documentation incompatibility" table already applies to
retrofit other lowercase text in this repo's docs) — e.g. `'clock_event_immutable'` →
`CLOCK_EVENT_IMMUTABLE`, and the two-message coverage-check pair
`'clock_shift_fragment_coverage_gap_or_overlap: %'` / interpolated shift id →
`CLOCK_SHIFT_FRAGMENT_COVERAGE_GAP_OR_OVERLAP` (identifier only, no interpolated detail — matching
the existing FN-01..FN-11 convention of bare identifiers with no dynamic content). No table, column,
condition, or trigger binding differs from the design document — only the RAISE EXCEPTION identifier
text.

**Preflight guard note (2026-08-12 review, item 2)**: one migration-level guard exists outside the
CK/UX/FK/FN/TRG categories below — a `DO $$ ... $$` block, the literal first statement in
`migration.sql`, before any T7A DDL. It checks `EXISTS (SELECT 1 FROM "User" WHERE
lower(username) = lower('system.scheduler'))` and raises stable identifier
`SYSTEM_SCHEDULER_USERNAME_OCCUPIED` (SQLSTATE `P0001`) if a pre-existing row (any `userKind`, since
that column doesn't exist yet at this point in the file) already holds the reserved SYSTEM username
case-insensitively. This replaces the original `ON CONFLICT ("username") DO NOTHING` on the SYSTEM
seed insert, which could silently succeed without ever creating a SYSTEM user if a pre-existing
`HUMAN` row happened to hold that username. Being the first statement in the file makes the
failure path atomic by construction — nothing T7A-related has executed yet when it fires, so nothing
needs to roll back. `CompanyAttendancePolicy`'s seed keeps its `ON CONFLICT ("singleton") DO NOTHING`
unchanged — see the migration's own inline comment for why that case is benign (brand-new table, no
pre-existing unrelated data can occupy it).

**This one-shot guard does not by itself close a concurrent-insert race** (fixed per 2026-08-12
review, SYSTEM identity race): it only sees rows that exist at the moment it runs, not a `HUMAN`
row — exact-case or any case-variant — inserted by a concurrent connection after it has already
passed. CK-34 (`ck_user_system_shape`, §11.1 below) is what actually closes that window: its
predicate reserves `system.scheduler` case-insensitively for the SYSTEM row for the lifetime of the
table, not just at migration time, so a late-arriving colliding `HUMAN` row is rejected by the
`ALTER TABLE ... ADD CONSTRAINT` itself (if it landed before that statement, rolling back the whole
transaction) or by the CHECK directly (if it lands after the migration has committed).

### 11.1 CHECK constraint register (CK-22 .. CK-36)

### CK-22 `ck_clock_event_device_sequence_pairing`

- Table: `ClockEvent`
- Predicate:
  ```sql
  ("deviceInstallationId" IS NULL) = ("deviceSequence" IS NULL)
  ```
- Source: `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §2.1 п.3.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ClockEvent` with `deviceSequence` set and `deviceInstallationId` NULL — expect `23514`.

### CK-23 `ck_clock_shift_recorded_interval`

- Table: `ClockShift`
- Predicate: `"recordedEndAt" > "recordedStartAt"`
- Source: §2.1 п.6.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ClockShift` with `recordedEndAt <= recordedStartAt` — expect `23514`.

### CK-24 `ck_clock_shift_close_mechanism`

- Table: `ClockShift`
- Predicate: exactly one of `{checkOutEventId set, forceClosed* all set}` — see §2.1 п.6 for the full form.
- Source: §2.1 п.6.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ClockShift` with both `checkOutEventId` and `forceClosedByUserId` set — expect `23514`.

### CK-25 `ck_clock_shift_fragment_recorded_interval`

- Table: `ClockShiftFragment`
- Predicate: `"recordedEndAt" > "recordedStartAt"`
- Source: §2.1 п.7.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ClockShiftFragment` with `recordedEndAt <= recordedStartAt` — expect `23514`.

### CK-26 `ck_clock_shift_adjustment_after_shape`

- Table: `ClockShiftAdjustment`
- Predicate: `afterX IS NULL` iff `changeType='REMOVED'`; all three `afterStartAt`/`afterEndAt`/`afterSiteId` set for `EDITED`/`RESTORED_TO_RECORDED` — see §2.1 п.8.
- Source: §2.1 п.8.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ClockShiftAdjustment` with `changeType='EDITED'` and `afterStartAt IS NULL` — expect `23514`.

### CK-27 `ck_attendance_exception_overlap_shape`

- Table: `AttendanceException`
- Predicate: `relatedClockShiftId`/`overlapEndedAt` populated (and `relatedClockShiftId != clockShiftId`) iff `type='OVERLAPPING_SHIFT'` — see §2.1 п.9 (issue 7).
- Source: §2.1 п.9.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT AttendanceException` with `type='OVERLAPPING_SHIFT'` and `relatedClockShiftId = clockShiftId` — expect `23514`.

### CK-28 `ck_attendance_exception_open_no_overlap_end`

- Table: `AttendanceException`
- Predicate: `"status" != 'OPEN' OR "overlapEndedAt" IS NULL`
- Source: §2.1 п.9 (issue 7).
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT AttendanceException` with `status='OPEN'` and `overlapEndedAt` set — expect `23514`.

### CK-29 `ck_conflict_payload_no_gps_coordinates`

- Table: `ClockEventIdConflict`
- Predicate:
  ```sql
  "sanitizedConflictingPayload" #> '{gps,latitude}'  IS NULL AND
  "sanitizedConflictingPayload" #> '{gps,longitude}' IS NULL
  ```
- Source: §4.1 (issue 7), §4.3 — defense-in-depth behind the shared sanitization function.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ClockEventIdConflict` with `sanitizedConflictingPayload={"gps":{"latitude":60,"longitude":24}}` — expect `23514`.

### CK-30 `ck_company_attendance_policy_singleton`

- Table: `CompanyAttendancePolicy`
- Predicate: `"singleton" = true`
- Source: §2.1 п.11, §4.4.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT CompanyAttendancePolicy (singleton) VALUES (false)` — expect `23514`.

### CK-31 `ck_company_attendance_policy_timezone_frozen`

- Table: `CompanyAttendancePolicy`
- Predicate: `"timezone" = 'Europe/Helsinki'`
- Source: §2.1 п.11 ("заморожено намеренно, §17.4").
- Documentation synchronization: SYNCED.
- Minimum negative test: `UPDATE CompanyAttendancePolicy SET timezone='UTC'` — expect `23514`.

### CK-32 `ck_device_event_receipt_outcome_shape`

- Table: `DeviceEventReceipt`
- Predicate: `outcome='ACCEPTED'` iff `clockEventId` set and `rejectionCode` NULL; `outcome='REJECTED_TERMINAL'` iff the reverse.
- Source: §2.1 п.13.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT DeviceEventReceipt` with `outcome='ACCEPTED'` and `clockEventId IS NULL` — expect `23514`.

### CK-33 `ck_geofence_version_radius`

- Table: `WorkSiteGeofenceVersion`
- Predicate: `"radiusMeters" > 0 AND "radiusMeters" <= 2000`
- Source: §2.1 п.1.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT WorkSiteGeofenceVersion` with `radiusMeters=5000` — expect `23514`.

### CK-34 `ck_user_system_shape`

- Table: `User`
- Predicate (**fixed per 2026-08-12 review — SYSTEM identity race**; same constraint, in-place
  predicate change, CHECK count unchanged at 15):
  ```sql
  ("userKind" = 'HUMAN' AND lower("username") <> 'system.scheduler')
  OR
  ("userKind" = 'SYSTEM' AND "username" = 'system.scheduler' AND "employeeId" IS NULL AND "passwordHash" IS NULL AND "status" = 'DEACTIVATED')
  ```
- Source: §2.2 (issue 7); username-reservation clause added §2.2/§13, 2026-08-12 review.
- Why: the original predicate only shaped the SYSTEM branch and said nothing about the reserved
  username itself. `User.username`'s plain `UNIQUE` index is case-sensitive, so a `HUMAN` row could
  hold `System.Scheduler` (or any other case-variant) without colliding with the SYSTEM row's exact
  `system.scheduler`. The one-shot preflight guard (before any T7A DDL — see the migration's own
  header comment, and §13) cannot see a `HUMAN` row inserted concurrently *after* it ran. This CHECK
  is what actually closes that residual window: it reserves `system.scheduler` case-insensitively
  for the SYSTEM row and nowhere else, requires the SYSTEM row's username to be the exact lowercase
  form (blocking a rename away from it too), and leaves the rest of the SYSTEM shape (employeeId/
  passwordHash/status) unchanged.
- Documentation synchronization: SYNCED.
- Minimum negative tests:
  - `INSERT User` with `userKind='SYSTEM'` and `passwordHash` set — expect `23514` (pre-existing).
  - `INSERT User` with `userKind='HUMAN'`, `username='system.scheduler'` — expect `23514`.
  - Same with `username='System.Scheduler'` and `username='SYSTEM.SCHEDULER'` — expect `23514` for both.
  - `UPDATE "User" SET username='someone.else' WHERE "userKind"='SYSTEM'` — expect `23514` (SYSTEM cannot be renamed).
  - `UPDATE "User" SET "userKind"='HUMAN' WHERE username='system.scheduler'` (username left unchanged) — expect `23514` (SYSTEM cannot become HUMAN while still holding the reserved username).
  - Positive: ordinary `HUMAN` usernames insert/update freely; the SYSTEM row itself is untouched by the new clause (still satisfies its own branch).

### CK-35 `ck_geofence_version_coordinates`

- Table: `WorkSiteGeofenceVersion`
- Predicate: `"latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180`
- Source: §2.1 п.1. Fixed per 2026-08-12 review (item 4) — previously only a table-comment range, not a DB-level guarantee (unlike `radiusMeters`/CK-33, which already had one).
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT WorkSiteGeofenceVersion` with `latitude=90.000001` — expect `23514`; same for `latitude=-90.000001`, `longitude=180.000001`, `longitude=-180.000001`. Positive: exact boundary values `90`/`-90`/`180`/`-180` insert successfully.

### CK-36 `ck_clock_event_location_coordinates`

- Table: `ClockEventLocation`
- Predicate: `"latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180`
- Source: §2.1 п.4. Same fix as CK-35, on the other table §4.3 names as holding raw coordinates.
- Documentation synchronization: SYNCED.
- Minimum negative test: same four boundary-violation cases as CK-35, on `ClockEventLocation`. Positive: exact boundary values insert successfully.

### 11.2 Partial / expression unique index register (UX-01 .. UX-03)

Not expressible via Prisma `@@unique` — filtered by a column other than the indexed columns'
own nullability (UX-01, UX-02), or an expression index on a constant (UX-03).

### UX-01 `ux_attendance_exception_missing_checkout_dedup`

- Table: `AttendanceException`
- Index: `("clockEventId", "payrollPeriodId") WHERE "type" = 'MISSING_CHECKOUT_AT_CUTOFF'`
- Source: §2.1 п.9 [3.1] (issue 3).
- Documentation synchronization: SYNCED.
- Minimum negative test: two `INSERT`s with the same `(clockEventId, payrollPeriodId)` and `type='MISSING_CHECKOUT_AT_CUTOFF'` — second expects `23505`.

### UX-02 `ux_attendance_exception_overlap_pair_open`

- Table: `AttendanceException`
- Index: `("clockShiftId", "relatedClockShiftId") WHERE "type" = 'OVERLAPPING_SHIFT' AND "status" = 'OPEN'`
- Source: §2.1 п.9 [3.2.3] (issue 5). Canonicalization (`clockShiftId := LEAST(A,B)`, `relatedClockShiftId := GREATEST(A,B)`) happens in service code at `INSERT` time (§9.1a), not in this index.
- Documentation synchronization: SYNCED.
- Minimum negative test: two `OPEN` rows for the same unordered pair — second expects `23505`. Positive: resolving the first (`status != 'OPEN'`) allows a new `OPEN` row for the same pair; historical `RESOLVED`/`DISMISSED` rows for the same pair coexist freely (verified empirically, disposable PostgreSQL 16).

### UX-03 `ux_user_single_system`

- Table: `User`
- Index: `((true)) WHERE "userKind" = 'SYSTEM'` — **unchanged** by the 2026-08-12 SYSTEM identity race
  fix (task explicitly required this index stay as-is; only CK-34's predicate changed).
- Source: §2.2 (issue 7) — same singleton trick as `CompanyAttendancePolicy`, without an extra column.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT User (userKind, ...)` a second `SYSTEM` row — expect `23505`.
- **Note (2026-08-12)**: since CK-34's predicate now requires every `SYSTEM` row's `username` to be
  the exact literal `'system.scheduler'`, a second `SYSTEM`-shaped row also always collides with the
  plain `User_username_key` unique constraint first in practice (verified empirically — Postgres
  reports `duplicate key value violates unique constraint "User_username_key"` for this exact case,
  not `ux_user_single_system`). This index remains in place unchanged as defense-in-depth for any
  row shape not already excluded by CK-34 (e.g. if a future change ever allowed more than one
  literal SYSTEM username) — the actual current-day invariant "at most one SYSTEM row" is now
  enforced redundantly by both `User_username_key` and `ux_user_single_system` together, not by
  `ux_user_single_system` in isolation.

### 11.3 Composite foreign key register (FK-01 .. FK-16)

Not previously a tracked category in this register (Sections 1–10 treat composite FKs as
Prisma-native and out of this document's scope). T7A introduces the first explicit register for
this category since referential cross-owner integrity is a first-class architectural property of
the design (§2.1, §2.2), not an incidental detail.

| ID | Table | Columns | References | Source |
|---|---|---|---|---|
| FK-01 | `ClockEvent` | `(deviceInstallationId, employeeId)` | `WorkerDeviceInstallation(id, employeeId)` | §2.1 п.3 |
| FK-02 | `ClockEvent` | `(siteId, workAreaId)` | `WorkArea(siteId, id)` | §2.1 п.3 (inline field annotation) |
| FK-03 | `ClockEvent` | `(siteId, geofenceVersionId)` | `WorkSiteGeofenceVersion(siteId, id)` | §2.1 п.3 |
| FK-04 | `ClockShiftFragment` | `(clockShiftId, employeeId)` | `ClockShift(id, employeeId)` | §2.1 п.7 |
| FK-05 | `ClockShiftFragment` | `(timesheetId, employeeId, payrollPeriodId)` | `Timesheet(id, employeeId, periodId)` | §2.1 п.7 |
| FK-06 | `ClockShiftFragment` | `(siteId, workAreaId)` | `WorkArea(siteId, id)` | §2.1 п.7 |
| FK-07 | `ClockShiftFragment` | `(sourceAssignmentId, employeeId, siteId)` | `SiteAssignment(id, employeeId, siteId)` | §2.1 п.7 |
| FK-08 | `ClockShiftAdjustment` | `(clockShiftFragmentId, clockShiftId, employeeId)` | `ClockShiftFragment(id, clockShiftId, employeeId)` | §2.1 п.8 |
| FK-09 | `ClockShiftAdjustment` | `(afterSourceAssignmentId, employeeId, afterSiteId)` | `SiteAssignment(id, employeeId, siteId)` | §2.1 п.8 |
| FK-10 | `ClockEventIdConflict` | `(deviceInstallationId, employeeId)` | `WorkerDeviceInstallation(id, employeeId)` | §2.1 п.10 |
| FK-11 | `DeviceEventReceipt` | `(deviceInstallationId, employeeId)` | `WorkerDeviceInstallation(id, employeeId)` | §2.1 п.13 |
| FK-12 | `DeviceEventReceipt` | `(clockEventId, deviceInstallationId, employeeId, deviceSequence)` | `ClockEvent(id, deviceInstallationId, employeeId, deviceSequence)` | §2.1 п.13 |
| FK-13 | `WorkSite` | `(id, currentGeofenceVersionId)` | `WorkSiteGeofenceVersion(siteId, id)` | §2.2 |
| FK-14 | `TimesheetDraftSegment` | `(originClockShiftFragmentId, employeeId)` | `ClockShiftFragment(id, employeeId)` | §2.2 |
| FK-15 | `WorkSegment` | `(originClockShiftFragmentId, employeeId)` | `ClockShiftFragment(id, employeeId)` | §2.2 |
| FK-16 | `CorrectionDraftSegment` | `(originClockShiftFragmentId, employeeId)` | `ClockShiftFragment(id, employeeId)` | §2.2 |

**Owner-confirmed correction (2026-08-12)**: the design document's own §Финал aggregate tally
originally stated "15 composite FK всего" (`ClockEvent×2`, omitting FK-02 above). That tally's own
text documents a history of being miscounted and corrected across revisions (3.2.4's count was
itself called out as "частичный, несогласованный" and fixed by issue 6) — this was one further
instance of the same class of arithmetic slip, not a real ambiguity in the architecture. §2.1 п.3's
per-field table explicitly and precisely annotates `ClockEvent.workAreaId` as `FK (siteId,
workAreaId) → WorkArea(siteId, id) MATCH SIMPLE` inline — the same explicit, deliberate form used
for the other two `ClockEvent` composite FKs the aggregate tally did count. **The owner has reviewed
this and confirmed 16 as the correct, final total** — `T7A_1_ATTENDANCE_CLOCK_DESIGN.md`'s §16 and
"Финал" blocks are corrected to match (2026-08-12 owner correction note in each). This register, and
the migration it documents, implement all 16; FK-02 is not a candidate for removal.

All 16 use `MATCH SIMPLE` (PostgreSQL's default for multi-column FKs) — a row is exempt from the
check whenever any one of its referencing columns is `NULL`, which is the documented intent for the
still-resolving fields these composite FKs cover (e.g. `ClockEvent.sourceAssignmentId` before
resolution). Minimum negative test per row above: insert/update the referencing table with a fully-
populated value combination that exists in the target table under a *different* owner key
(device/site/employee) — expect `23503`. Where the referencing column(s) are nullable per `MATCH
SIMPLE`, a second positive test confirms the documented nullable/unresolved row inserts cleanly.
**Fixed per 2026-08-12 review (item 5), re-verified 2026-08-12 audit-closeout (item C)**: all 16,
individually, not a sample. Each row's negative test is a real cross-owner `INSERT`/`UPDATE`
executed on disposable PostgreSQL 16, expecting `23503`. For every FK with a nullable referencing
column, the positive test is a real `INSERT`/`UPDATE` that leaves that column `NULL` (or, for FK-13,
also a set→unset round trip) and asserts success — never "structurally identical to FK-N", never a
correctly-owned *non-null* reference standing in for the null case, never a bare claim. For the 4
FKs whose referencing columns are all `NOT NULL` (no nullable member exists), the table states the
exact reason MATCH SIMPLE's null-skip path can never apply, instead of a positive test.

| ID | Table.columns → target | Negative test result | Positive (nullable) test |
|---|---|---|---|
| FK-01 | `ClockEvent(deviceInstallationId,employeeId)` → `WorkerDeviceInstallation` | PASS `23503` | PASS — `deviceInstallationId=NULL` **and** `deviceSequence=NULL` together (orphan/server-originated event, the only valid nullable shape per CK-22) inserts cleanly |
| FK-02 | `ClockEvent(siteId,workAreaId)` → `WorkArea` | PASS `23503` | PASS — `workAreaId=NULL` inserts cleanly |
| FK-03 | `ClockEvent(siteId,geofenceVersionId)` → `WorkSiteGeofenceVersion` | PASS `23503` | PASS — `geofenceVersionId=NULL` inserts cleanly |
| FK-04 | `ClockShiftFragment(clockShiftId,employeeId)` → `ClockShift` | PASS `23503` | N/A — both columns `NOT NULL`; every fragment structurally belongs to exactly one shift and one employee from the moment the materializer creates it, no unresolved state exists |
| FK-05 | `ClockShiftFragment(timesheetId,employeeId,payrollPeriodId)` → `Timesheet` | PASS `23503` | N/A — all three columns `NOT NULL`; a fragment always has a resolved period/timesheet at creation time |
| FK-06 | `ClockShiftFragment(siteId,workAreaId)` → `WorkArea` | PASS `23503` | PASS — `workAreaId=NULL` on a `ClockShiftFragment` row inserts cleanly (own dedicated test, not reused from FK-02's `ClockEvent` test) |
| FK-07 | `ClockShiftFragment(sourceAssignmentId,employeeId,siteId)` → `SiteAssignment` | PASS `23503` | PASS — `sourceAssignmentId=NULL` on a `ClockShiftFragment` row inserts cleanly |
| FK-08 | `ClockShiftAdjustment(clockShiftFragmentId,clockShiftId,employeeId)` → `ClockShiftFragment` | PASS `23503` | N/A — all three columns `NOT NULL`; an adjustment always records an edit against one specific, already-resolved fragment |
| FK-09 | `ClockShiftAdjustment(afterSourceAssignmentId,employeeId,afterSiteId)` → `SiteAssignment` | PASS `23503` | PASS — `changeType='REMOVED'` row with `afterSourceAssignmentId=NULL` **and** `afterSiteId=NULL` together inserts cleanly |
| FK-10 | `ClockEventIdConflict(deviceInstallationId,employeeId)` → `WorkerDeviceInstallation` | PASS `23503` | PASS — `deviceInstallationId=NULL` inserts cleanly |
| FK-11 | `DeviceEventReceipt(deviceInstallationId,employeeId)` → `WorkerDeviceInstallation` | PASS `23503` | N/A — both columns `NOT NULL`; every receipt is the FIFO ledger entry for one specific device/employee sequence number, unlike `ClockEvent` there is no orphan/server-originated receipt |
| FK-12 | `DeviceEventReceipt(clockEventId,deviceInstallationId,employeeId,deviceSequence)` → `ClockEvent` | PASS `23503` | PASS — `clockEventId=NULL` in a valid `outcome='REJECTED_TERMINAL'` row (the shape CK-32 requires for that outcome) inserts cleanly |
| FK-13 | `WorkSite(id,currentGeofenceVersionId)` → `WorkSiteGeofenceVersion` | PASS `23503` | PASS — `currentGeofenceVersionId=NULL` verified as the actual starting state on two real `WorkSite` rows, then a set→unset→NULL round trip, all succeed |
| FK-14 | `TimesheetDraftSegment(originClockShiftFragmentId,employeeId)` → `ClockShiftFragment` | PASS `23503` | PASS — `originClockShiftFragmentId=NULL` (ordinary manually-entered segment, not derived from Attendance Clock) inserts cleanly; separately, reusing the same fragment on a second segment is rejected by the `@@unique` (not this FK) |
| FK-15 | `WorkSegment(originClockShiftFragmentId,employeeId)` → `ClockShiftFragment` | PASS `23503` | PASS — `originClockShiftFragmentId=NULL` inserts cleanly; separately, a second `WorkSegment` referencing the *same non-null* fragment also inserts cleanly (no `@@unique` here, by design — resubmits may freeze one fragment into several versions) |
| FK-16 | `CorrectionDraftSegment(originClockShiftFragmentId,employeeId)` → `ClockShiftFragment` | PASS `23503` | PASS — `originClockShiftFragmentId=NULL` inserts cleanly |

16/16 negative PASS. 12/12 applicable nullable-positive PASS. 4/4 N/A justified (FK-04/05/08/11, all-NOT-NULL columns).

### 11.4 Trigger function register (FN-12 .. FN-22)

### FN-12 `fn_clock_event_immutable`

- Tables: `ClockEvent`, `DeviceEventReceipt`, `AutoSubmissionAttempt` (same function, reused verbatim across all three — design document explicitly specifies this reuse, §4.1).
- Behavior: unconditional `RAISE EXCEPTION` on any invocation — full `UPDATE`/`DELETE` ban.
- Stable exception identifier: `CLOCK_EVENT_IMMUTABLE`.
- Row-lock contract: N/A (unconditional).
- Source: §4.1.

### FN-13 `fn_geofence_version_immutable`

- Table: `WorkSiteGeofenceVersion`.
- Behavior: unconditional ban.
- Stable exception identifier: `GEOFENCE_VERSION_IMMUTABLE`.
- Source: §4.1.

### FN-14 `fn_clock_event_conflict_immutable`

- Table: `ClockEventIdConflict`.
- Behavior: unconditional ban.
- Stable exception identifier: `CLOCK_EVENT_CONFLICT_IMMUTABLE`.
- Source: §4.1.

### FN-15 `fn_clock_shift_adjustment_immutable`

- Table: `ClockShiftAdjustment`.
- Behavior: unconditional ban.
- Stable exception identifier: `CLOCK_SHIFT_ADJUSTMENT_IMMUTABLE`.
- Source: §4.1.

### FN-16 `fn_clock_shift_immutable`

- Table: `ClockShift`.
- Behavior: narrow contract — rejects any change to a fixed field list (**`id`/`createdAt` included, fixed per 2026-08-12 review item 3** — the original field list omitted them, a real gap: `id` is the PK referenced by every composite FK onto this table with `ON UPDATE CASCADE`, so an unguarded `id` change would have cascaded silently into every child row's FK value); rejects `materializationState MATERIALIZED→PENDING`; gates `PENDING→MATERIALIZED` on all fragments existing with `sourceAssignmentId` resolved and `reportedProjectionState='SETTLED'`; rejects a second `sourceAssignmentId` change once resolved.
- Stable exception identifiers: `CLOCK_SHIFT_IMMUTABLE_FIELD_CHANGED`, `CLOCK_SHIFT_MATERIALIZATION_STATE_CANNOT_REVERT`, `CLOCK_SHIFT_FRAGMENTS_MISSING`, `CLOCK_SHIFT_FRAGMENT_NOT_SETTLED`, `CLOCK_SHIFT_SOURCE_ASSIGNMENT_ALREADY_RESOLVED`.
- Source: §4.1.
- Minimum negative test (added 2026-08-12): `UPDATE ClockShift SET id = gen_random_uuid()` — expect `CLOCK_SHIFT_IMMUTABLE_FIELD_CHANGED`; `UPDATE ClockShift SET "createdAt" = now()` — same. Positive: the two allowed transitions still succeed; a genuine no-op `UPDATE` (no column value actually changes) is not required to be rejected and isn't.

### FN-17 `fn_clock_shift_no_delete`

- Tables: `ClockShift`, `ClockShiftFragment` (same function, reused verbatim — design document explicitly specifies this reuse, §4.1).
- Behavior: unconditional `DELETE` ban.
- Stable exception identifier: `CLOCK_SHIFT_NO_DELETE`.
- Source: §4.1.

### FN-18 `fn_clock_shift_fragment_immutable`

- Table: `ClockShiftFragment`.
- Behavior: same narrow-contract shape as FN-16 for its own fixed field list (**`id`/`createdAt` included, same 2026-08-12 fix, same gap and reasoning as FN-16**) and `sourceAssignmentId`; one-way `reportedProjectionState PENDING→SETTLED` gated on the same `TimesheetDraftSegment`/`FINAL_APPROVED` prerequisite the service layer uses (§9.4 step 8f/8g); rejects `SETTLED→PENDING`.
- Stable exception identifiers: `CLOCK_SHIFT_FRAGMENT_IMMUTABLE_FIELD_CHANGED`, `CLOCK_SHIFT_FRAGMENT_SOURCE_ASSIGNMENT_ALREADY_RESOLVED`, `CLOCK_SHIFT_FRAGMENT_PROJECTION_STATE_CANNOT_REVERT`, `CLOCK_SHIFT_FRAGMENT_SETTLED_WITHOUT_SOURCE_ASSIGNMENT`, `CLOCK_SHIFT_FRAGMENT_SETTLED_WITHOUT_PREREQUISITE`.
- Source: §4.1 (3.2.4, 3.2.5 issue 4).
- Minimum negative test (added 2026-08-12): `UPDATE ClockShiftFragment SET id = gen_random_uuid()` / `SET "createdAt" = now()` — expect `CLOCK_SHIFT_FRAGMENT_IMMUTABLE_FIELD_CHANGED` for both. Positive: the two allowed transitions still succeed.

### FN-19 `fn_clock_shift_fragment_coverage_check`

- Table: `ClockShiftFragment`.
- Behavior: `STATEMENT`-level, `REFERENCING NEW TABLE AS new_rows` transition-table check — dense `0..N-1` `fragmentIndex`, contiguous `recordedStartAt`/`recordedEndAt`, first fragment starts at shift start, last ends at shift end.
- Stable exception identifiers: `CLOCK_SHIFT_FRAGMENT_COVERAGE_GAP_OR_OVERLAP`, `CLOCK_SHIFT_FRAGMENT_COVERAGE_START_MISMATCH`, `CLOCK_SHIFT_FRAGMENT_COVERAGE_END_MISMATCH`.
- Row-lock contract: none needed — the design relies on the materializer always inserting all of a shift's fragments in one `INSERT ... VALUES (...), (...)` statement inside one transaction (§2.1 п.7); no `DEFERRABLE` required.
- Source: §2.1 п.7.

### FN-20 `fn_clock_event_location_no_update`

- Table: `ClockEventLocation`.
- Behavior: unconditional `UPDATE` ban.
- Stable exception identifier: `CLOCK_EVENT_LOCATION_NO_UPDATE`.
- Source: §4.1 [3.1] (issue 7).

### FN-21 `fn_clock_event_location_retention_delete_guard`

- Table: `ClockEventLocation`.
- Behavior: `DELETE` rejected while `createdAt >= now() - interval '90 days'`.
- Stable exception identifier: `CLOCK_EVENT_LOCATION_RETENTION_WINDOW_NOT_ELAPSED`.
- Source: §4.1 [3.1] (issue 7), §4.3.

### FN-22 `fn_company_attendance_policy_no_delete`

- Table: `CompanyAttendancePolicy`.
- Behavior: unconditional `DELETE` ban (field `UPDATE`s remain allowed — admin-editable policy, not a historical fact).
- Stable exception identifier: `COMPANY_ATTENDANCE_POLICY_NO_DELETE`.
- Source: §4.1 [3.1] (issue 7).

### 11.5 Trigger instance register (TRG-14 .. TRG-27)

| ID | Table | Trigger | Function | Timing/Events |
|---|---|---|---|---|
| TRG-14 | `ClockEvent` | `trg_clock_event_immutable` | FN-12 | `BEFORE UPDATE OR DELETE` |
| TRG-15 | `DeviceEventReceipt` | `trg_device_event_receipt_immutable` | FN-12 | `BEFORE UPDATE OR DELETE` |
| TRG-16 | `AutoSubmissionAttempt` | `trg_auto_submission_attempt_immutable` | FN-12 | `BEFORE UPDATE OR DELETE` |
| TRG-17 | `WorkSiteGeofenceVersion` | `trg_geofence_version_immutable` | FN-13 | `BEFORE UPDATE OR DELETE` |
| TRG-18 | `ClockEventIdConflict` | `trg_clock_event_conflict_immutable` | FN-14 | `BEFORE UPDATE OR DELETE` |
| TRG-19 | `ClockShiftAdjustment` | `trg_clock_shift_adjustment_immutable` | FN-15 | `BEFORE UPDATE OR DELETE` |
| TRG-20 | `ClockShift` | `trg_clock_shift_immutable` | FN-16 | `BEFORE UPDATE` |
| TRG-21 | `ClockShift` | `trg_clock_shift_no_delete` | FN-17 | `BEFORE DELETE` |
| TRG-22 | `ClockShiftFragment` | `trg_clock_shift_fragment_immutable` | FN-18 | `BEFORE UPDATE` |
| TRG-23 | `ClockShiftFragment` | `trg_clock_shift_fragment_no_delete` | FN-17 | `BEFORE DELETE` |
| TRG-24 | `ClockShiftFragment` | `trg_clock_shift_fragment_coverage_check` | FN-19 | `AFTER INSERT ... FOR EACH STATEMENT` |
| TRG-25 | `ClockEventLocation` | `trg_clock_event_location_no_update` | FN-20 | `BEFORE UPDATE` |
| TRG-26 | `ClockEventLocation` | `trg_clock_event_location_retention_delete_guard` | FN-21 | `BEFORE DELETE` |
| TRG-27 | `CompanyAttendancePolicy` | `trg_company_attendance_policy_no_delete` | FN-22 | `BEFORE DELETE` |

14 bindings total, matching `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §Финал's own count exactly (`ClockEventLocation×2, AutoSubmissionAttempt×1, CompanyAttendancePolicy×1, ClockEventIdConflict×1, ClockEvent×1, WorkSiteGeofenceVersion×1, ClockShiftAdjustment×1, ClockShift×2, ClockShiftFragment×3, DeviceEventReceipt×1`). Verified empirically: 14 non-internal triggers exist on the 13 T7A tables (disposable PostgreSQL 16, `pg_trigger` introspection), each with at least one positive and one negative runtime test (§11.6).

### 11.6 Test register (T7A obligations — executed, not merely specified)

Unlike Section 9 above (obligations only), every object in this section (§11.1–§11.5) has already
been exercised on a disposable PostgreSQL 16 instance as part of the schema-foundation
implementation: one positive and one negative case per CHECK, one positive and one negative case
per trigger contract (including the coverage gap/overlap/valid-cover triple, the
`reportedProjectionState` PENDING→SETTLED-without-prerequisite / with-prerequisite /
`FINAL_APPROVED`-exemption / SETTLED→PENDING-revert quadruple, and the retention-window
before/after pair), one dedup/second-row case per partial or expression unique index (including the
`ux_attendance_exception_overlap_pair_open` resolved-then-reopened and historical-rows-coexist
cases), and one cross-owner rejection case for a representative sample of the composite FK set
(§11.3). Seed idempotency (`system.scheduler` User row, `CompanyAttendancePolicy` singleton row) was
verified by re-running both seed `INSERT ... ON CONFLICT DO NOTHING` statements a second time against
an already-migrated database and confirming row counts stayed at 1.

### 11.7 Arithmetic assertions (T7A additions only)

```text
T7A.1 SCHEMA-FOUNDATION RAW-SQL TOTALS (additive to Section 10 pre-T7A totals)
Status as of 2026-08-12 hardening fix (see §11.3/§11.1 notes and CK-35/CK-36 below)
New tables: 13
New columns on 7 pre-T7A models: 9
New columns on T7A's own tables (accumulated across design revisions): 6
CHECK constraints: 15 (CK-22..CK-36) — CK-35/CK-36 (coordinate bounds) added 2026-08-12
Partial/expression unique indexes: 3 (UX-01..UX-03)
Composite foreign keys: 16 (FK-01..FK-16) — owner-confirmed final total, §11.3
Trigger functions: 11 (FN-12..FN-22) — FN-16/FN-18 bodies extended 2026-08-12 (id/createdAt)
Trigger instances: 14 (TRG-14..TRG-27)
Preflight guards: 1 (SYSTEM_SCHEDULER_USERNAME_OCCUPIED, migration's first statement — §11.1 note)
New PostgreSQL extensions: 0
```

## 12. T8.4A CSV Export Schema Foundation slice

```text
Status: ACTIVE
Scope: prisma/migrations/20260819150000_add_export_batch_schema,
       prisma/migrations/20260819170000_fix_export_item_worked_minutes_bounds (FOLLOW-UP, additive
       corrective migration — does not edit the first one)
Authority: docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A" (2026-08-19) and its
           "FOLLOW-UP — align ExportItem with canonical worked-time semantics" addendum (2026-08-19)
Prisma version: 6.19.0
PostgreSQL target: 16
```

This section is additive to, and does not modify, Sections 1–11 above. Schema/permissions only —
zero CSV generation, zero export/download API, zero admin UI (all deferred to T8.4B/T8.4C). Two new
tables (`ExportBatch`, `ExportItem`); no changes to any pre-existing table's columns.

**CK-37/CK-38 vs FN-25 ordering note (found during `scripts/_test-export-batch-schema.ts`
scenarios 9 and 11)**: Postgres runs `BEFORE ROW` triggers before validating `CHECK` constraints on
the same `INSERT`. `trg_export_batch_correction_chain_check` (FN-25/TRG-30) gates on
`NEW."kind" = 'CORRECTION'` alone and always looks up the predecessor by `id` first. For a
`CORRECTION` row with `correctsBatchId IS NULL` (the shape CK-37 names) or `correctsBatchId` equal to
the row's own not-yet-inserted `id` (the shape CK-38 names), that lookup finds no matching row before
either CHECK ever gets evaluated, so the row is actually rejected with
`EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND`, not the CK-37/CK-38 constraint name. The row is
still always rejected either way — this only affects which identifier a caller observes. CK-37 stays
fully reachable (and is the true failure reason) for its other disjunct, `FULL` with
`correctsBatchId` set — that shape never triggers FN-25's predecessor lookup at all, since it's gated
on `kind = 'CORRECTION'`. CK-38 has no shape it is ever the true failure reason for under the current
exposed INSERT-only interface — it remains a defense-in-depth backstop against a future change to
FN-25's own logic, not a currently-reachable guard in its own right.

**FOLLOW-UP correction (2026-08-19)**: CK-43 (`ck_export_item_worked_minutes_formula`) as originally
specified was wrong on two independent counts and was **removed** by the additive corrective
migration `20260819170000_fix_export_item_worked_minutes_bounds` — see its own header comment and
`T8_REPORTS_DESIGN.md` Addendum "T8.4A FOLLOW-UP" for the full writeup. Summary: (1) it subtracted
`paidBreakMinutes` from worked time, contradicting the canonical `lib/reporting/worked-time.ts`
formula (`workedMs = grossMs - unpaidBreakMs`, paid breaks stay inside worked time) that T8.1/T8.2/
T8.3 already use; (2) even the corrected formula without the paid term is not expressible as a valid
CHECK, because `grossMinutes`/`paidBreakMinutes`/`unpaidBreakMinutes`/`workedMinutes` are each
independently rounded from their own millisecond value at the same bucket — independent rounding
does not commute with subtraction (counterexample: `grossMs=31000→grossMinutes=1`,
`unpaidBreakMs=29000→unpaidBreakMinutes=0`, `workedMs=2000→workedMinutes=0`, yet `1-0≠0`). Replaced
by CK-44 (`ck_export_item_minute_bounds`, below) — a bound that holds regardless of independent
rounding. CK-43's own entry is kept below, marked REMOVED, per this register's convention of never
silently erasing a historical entry's identifier.

### 12.1 CHECK constraint register (CK-37 .. CK-44)

### CK-37 `ck_export_batch_kind_correction_shape`

- Table: `ExportBatch`
- Predicate:
  ```sql
  ("kind" = 'FULL' AND "correctsBatchId" IS NULL) OR
  ("kind" = 'CORRECTION' AND "correctsBatchId" IS NOT NULL)
  ```
- Source: `T8_REPORTS_DESIGN.md` Addendum "T8.4A" §AJ; task invariants #3/#4.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ExportBatch` with `kind='FULL'` and `correctsBatchId` set — expect
  `23514` on this constraint by name (verified). A second shape, `kind='CORRECTION'` with
  `correctsBatchId IS NULL`, is also rejected but surfaces as FN-25's
  `EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND` instead — see the ordering note above.

### CK-38 `ck_export_batch_no_self_correction`

- Table: `ExportBatch`
- Predicate: `"correctsBatchId" IS NULL OR "correctsBatchId" != "id"`
- Source: task invariant #6 (no self-reference).
- Documentation synchronization: SYNCED.
- Minimum negative test: a hand-crafted `INSERT` supplying an explicit client-side `id` equal to
  `correctsBatchId` is rejected — but, per the ordering note above, always as FN-25's
  `EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND` (the row can never find "itself" by `id` before it
  exists), never as this constraint's own name under the current exposed interface.

### CK-39 `ck_export_batch_file_hash_format`

- Table: `ExportBatch`
- Predicate: `"fileHash" ~ '^[0-9a-f]{64}$'`
- Source: task invariant #7.
- Documentation synchronization: SYNCED.
- Minimum negative test: `INSERT ExportBatch` with a non-hex/non-64-length `fileHash` — expect `23514`.

### CK-40 `ck_export_batch_file_size_matches_content`

- Table: `ExportBatch`
- Predicate: `"fileSizeBytes" = octet_length("content")`
- Source: task invariant #8.
- Documentation synchronization: SYNCED.
- Minimum negative test: `fileSizeBytes` off by one from the real `content` length — expect `23514`.

### CK-41 `ck_export_batch_counts_nonnegative`

- Table: `ExportBatch`
- Predicate: `"fileSizeBytes" >= 0 AND "rowCount" >= 0`
- Source: task invariant #9.
- Documentation synchronization: SYNCED.
- Minimum negative test: `rowCount = -1` — expect `23514`.

### CK-42 `ck_export_item_minutes_nonnegative`

- Table: `ExportItem`
- Predicate: `"grossMinutes" >= 0 AND "paidBreakMinutes" >= 0 AND "unpaidBreakMinutes" >= 0 AND "workedMinutes" >= 0 AND "segmentCount" >= 0`
- Source: task invariant #10.
- Documentation synchronization: SYNCED.
- Minimum negative test: `grossMinutes = -10` — expect `23514`.

### CK-43 `ck_export_item_worked_minutes_formula` — **REMOVED `[2026-08-19]` FOLLOW-UP**

- Table: `ExportItem`
- Predicate (as originally specified, no longer in the schema): `"workedMinutes" = GREATEST(0,
  "grossMinutes" - "paidBreakMinutes" - "unpaidBreakMinutes")`
- Added by: `20260819150000_add_export_batch_schema`. Removed by:
  `20260819170000_fix_export_item_worked_minutes_bounds` (`ALTER TABLE "ExportItem" DROP CONSTRAINT
  "ck_export_item_worked_minutes_formula"`).
- Source: task invariant #11 of the original T8.4A task spec — this formula turned out to be an
  error in that spec, not a deliberate design decision; see the FOLLOW-UP note above and
  `T8_REPORTS_DESIGN.md` Addendum "T8.4A FOLLOW-UP" for the full writeup (wrong semantics —
  subtracted paid breaks — AND not expressible as an arithmetic equality after independent
  per-column rounding).
- Documentation synchronization: SYNCED (this entry itself now documents the removal).
- Historical minimum negative test (while it existed): an item with `workedMinutes` not equal to the
  formula's result — expected `23514`. No longer applicable — replaced by CK-44 below.

### CK-44 `ck_export_item_minute_bounds` — added `[2026-08-19]` FOLLOW-UP

- Table: `ExportItem`
- Predicate: `"workedMinutes" <= "grossMinutes" AND "paidBreakMinutes" <= "grossMinutes" AND
  "unpaidBreakMinutes" <= "grossMinutes"`
- Source: `T8_REPORTS_DESIGN.md` Addendum "T8.4A FOLLOW-UP". Replaces CK-43 — a bound that holds
  regardless of independent per-column rounding, unlike an arithmetic equality between the three
  minute columns. `ExportItem.workedMinutes` now uses the same canonical semantics as `lib/
  reporting/worked-time.ts` and T8.1/T8.2/T8.3 (`workedMs = grossMs - unpaidBreakMs`, paid breaks
  stay inside worked time) — no formula divergence remains for T8.4B to reproduce.
- Documentation synchronization: SYNCED.
- Minimum negative test: three independent cases, one per column — `workedMinutes > grossMinutes`,
  `paidBreakMinutes > grossMinutes`, `unpaidBreakMinutes > grossMinutes` — each expects `23514`.
  Positive: `gross=60,paid=15,unpaid=0,worked=60` (paid break inside worked time); `gross=60,paid=0,
  unpaid=15,worked=45`; `gross=60,paid=10,unpaid=15,worked=45`; adversarial-rounding
  `gross=1,paid=0,unpaid=0,worked=0` — all four accepted (`scripts/_test-export-batch-schema.ts`
  FU-5..FU-8).

### 12.2 Partial unique index register (UX-04)

### UX-04 `ux_export_batch_full_per_period`

- Table: `ExportBatch`
- Index: `("periodId") WHERE "kind" = 'FULL'`
- Source: task invariant #2 (at most one FULL batch per period). Not expressible via Prisma
  `@@unique` (filtered by a column, `kind`, other than the indexed column's own nullability — same
  category as UX-01/UX-02).
- Documentation synchronization: SYNCED.
- Minimum negative test: two `INSERT`s with `kind='FULL'` and the same `periodId` — second expects
  `23505`. Positive: a `CORRECTION` batch for the same period, and a second `FULL` batch for a
  *different* period, both insert cleanly.

### 12.3 Composite foreign key register (FK-17)

| ID | Table | Columns | References | Source |
|---|---|---|---|---|
| FK-17 | `ExportItem` | `(timesheetVersionId, employeeId)` | `TimesheetVersion(id, employeeId)` | Task invariant #13 |

Uses the same pre-existing `TimesheetVersion.@@unique([id, employeeId])` the §11.3 FK-01..FK-16
pattern established — no new schema surface invented to satisfy this invariant. `MATCH SIMPLE`
(Postgres default); both referencing columns are `NOT NULL` on `ExportItem`, so there is no nullable/
unresolved-row case to test positively (same N/A category as FK-04/05/08/11 in §11.3).

| ID | Table.columns → target | Negative test result | Positive (nullable) test |
|---|---|---|---|
| FK-17 | `ExportItem(timesheetVersionId,employeeId)` → `TimesheetVersion` | PASS `23503` — a `timesheetVersionId` belonging to a *different* employee than the item's own `employeeId` is rejected | N/A — both columns `NOT NULL`; every export item snapshots one specific, already-resolved timesheet version for one specific employee at generation time |

### 12.4 Trigger function register (FN-23 .. FN-25)

### FN-23 `fn_export_batch_immutable`

- Table: `ExportBatch`.
- Behavior: unconditional `RAISE EXCEPTION` on any invocation — full `UPDATE`/`DELETE` ban, same
  pattern as `fn_audit_event_immutable` (the first instance of this convention in this schema).
- Stable exception identifier: `EXPORT_BATCH_IMMUTABLE`.
- Row-lock contract: N/A (unconditional).
- Source: task invariant #1.
- Minimum negative test: `UPDATE ExportBatch SET "fileName" = ...` and `DELETE FROM "ExportBatch"` —
  both expect `EXPORT_BATCH_IMMUTABLE`.

### FN-24 `fn_export_item_immutable`

- Table: `ExportItem`.
- Behavior: unconditional ban.
- Stable exception identifier: `EXPORT_ITEM_IMMUTABLE`.
- Source: task invariant #1.
- Minimum negative test: `UPDATE ExportItem SET "grossMinutes" = ...` and `DELETE FROM "ExportItem"` —
  both expect `EXPORT_ITEM_IMMUTABLE`.

### FN-25 `fn_export_batch_correction_chain_check`

- Table: `ExportBatch`.
- Behavior: `BEFORE INSERT` only (no `BEFORE UPDATE` variant — FN-23 already rejects every `UPDATE`
  unconditionally, so `correctsBatchId` can never actually change post-insert; there is nothing for
  a second trigger to guard). No-op for `kind = 'FULL'` rows. For `kind = 'CORRECTION'` rows:
  validates the predecessor exists, validates the predecessor's `periodId` matches the new row's own
  `periodId`, and walks the correction chain via `WITH RECURSIVE` to reject a cycle. A true cycle is
  structurally unreachable through the exposed INSERT-only interface (a row can only reference an
  already-existing predecessor, and rows are immutable afterward, so nothing can retroactively become
  an ancestor of an earlier row) — the cycle check is defense-in-depth/testability, not the sole
  practical guard.
- Stable exception identifiers: `EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND`,
  `EXPORT_BATCH_CORRECTION_PERIOD_MISMATCH`, `EXPORT_BATCH_CORRECTION_CYCLE`.
- Row-lock contract: N/A — reads via plain `SELECT`, no explicit row lock; the immutability triggers
  (FN-23) mean no concurrent writer can ever be mutating a row this function reads.
- Source: task invariants #5/#6.
- Minimum negative test: see the CK-37/CK-38 ordering note above and scenarios 9–11 of
  `scripts/_test-export-batch-schema.ts`.

### 12.5 Trigger instance register (TRG-28 .. TRG-30)

| ID | Table | Trigger | Function | Timing/Events |
|---|---|---|---|---|
| TRG-28 | `ExportBatch` | `trg_export_batch_immutable` | FN-23 | `BEFORE UPDATE OR DELETE` |
| TRG-29 | `ExportItem` | `trg_export_item_immutable` | FN-24 | `BEFORE UPDATE OR DELETE` |
| TRG-30 | `ExportBatch` | `trg_export_batch_correction_chain_check` | FN-25 | `BEFORE INSERT` |

3 bindings total. Verified empirically: 3 non-internal triggers exist on the 2 T8.4A tables
(disposable PostgreSQL 16, `pg_trigger` introspection via the regression script's own migration
verification), each exercised by at least one positive and one negative runtime test (§12.6).

### 12.6 Test register (T8.4A obligations — executed, not merely specified)

Every object in this section (§12.1–§12.5) has been exercised on a disposable PostgreSQL 16 instance
via `scripts/_test-export-batch-schema.ts` (68 checks — the original 51 covering the task's 23
numbered scenarios, plus 15 FOLLOW-UP FU-scenarios added `[2026-08-19]`, 100% pass) plus a dump/
restore round trip on a second disposable PostgreSQL 16 instance, run once for the original T8.4A
migration and again after the FOLLOW-UP corrective migration (row counts, `md5(content)`,
`fileHash`, `fileSizeBytes` all identical before/after both times; `trg_export_batch_immutable`
still rejects an `UPDATE`, and `ck_export_item_minute_bounds` still rejects a bounds violation, on
the restored database). The full existing T8 report regression suite
(`_test-report-rounding-consistency.ts` 105/105, `_test-period-time-report.ts` 110/110) was re-run
against a database carrying both migrations and passes identically to the pre-T8.4A baseline.

### 12.7 Arithmetic assertions (T8.4A + FOLLOW-UP additions only)

```text
T8.4A CSV EXPORT SCHEMA FOUNDATION RAW-SQL TOTALS (additive to Sections 1–11 totals)
New tables: 2 (ExportBatch, ExportItem)
New enums: 2 (ExportFormat, ExportBatchKind)
New columns on pre-T8.4A models: 0 (five back-relation fields added — Prisma-side only, no new
  columns on any pre-existing table)
CHECK constraints, currently active: 7 (CK-37..CK-42, CK-44) — CK-43 added then REMOVED by the
  FOLLOW-UP corrective migration (20260819170000), see its entry above; net count unchanged (7),
  identifier CK-43 retired rather than reused
Partial/expression unique indexes: 1 (UX-04)
Composite foreign keys: 1 (FK-17)
Plain (non-composite) foreign keys: 6 (ExportBatch.periodId/createdByUserId/correctsBatchId,
  ExportItem.exportBatchId/employeeId/siteId)
Trigger functions: 3 (FN-23..FN-25)
Trigger instances: 3 (TRG-28..TRG-30)
New permissions: 3 (period.export, export.create, export.read — separate DML migration
  20260819160000_seed_export_permissions, granted to ADMIN+SUPER_ADMIN only, 6 RolePermission rows)
New PostgreSQL extensions: 0
```

## 13. T8.4B Immutable CSV Generation, Export APIs and Download — schema completion slice

```text
Status: ACTIVE
Scope: prisma/migrations/20260819180000_add_correction_covered_by_export_batch
Authority: docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" (2026-08-19), §BE
Prisma version: 6.19.0
PostgreSQL target: 16
```

This section is additive to, and does not modify, Sections 1–12 above. One additive migration —
`CorrectionRequest.coveredByExportBatchId` (nullable UUID FK → `ExportBatch`), its supporting index,
two new CHECK constraints, and one new trigger function/instance. No changes to `ExportBatch`/
`ExportItem` (Section 12) or any other pre-existing table.

### 13.1 CHECK constraint register (CK-45 .. CK-46)

### CK-45 `ck_correction_request_pending_export_shape`

- Table: `CorrectionRequest`
- Predicate:
  ```sql
  NOT "pendingExport" OR (
    "status" = 'APPROVED' AND "resultingVersionId" IS NOT NULL AND "coveredByExportBatchId" IS NULL
  )
  ```
- Source: task DB-invariant list, item 1 ("pendingExport=true возможно только при: status=APPROVED,
  resultingVersionId IS NOT NULL, coveredByExportBatchId IS NULL").
- Documentation synchronization: SYNCED.
- Minimum negative test: `pendingExport=true` with `status` forced to `REJECTED` (via raw SQL,
  `coveredByExportBatchId` left `NULL` so CK-46 cannot also fire) — expect `23514` on this
  constraint by name (verified, `scripts/_test-csv-export.ts` F53). A second shape —
  `pendingExport=true` with `coveredByExportBatchId` set — is also rejected, but CK-46 fires on the
  identical row shape too (its own predicate requires `NOT pendingExport` whenever
  `coveredByExportBatchId` is non-NULL) — either identifier is a correct, expected rejection reason
  for that combination; see the CK-45/CK-46 ordering note below.

### CK-46 `ck_correction_request_covered_shape`

- Table: `CorrectionRequest`
- Predicate:
  ```sql
  "coveredByExportBatchId" IS NULL OR (
    "status" = 'APPROVED' AND "resultingVersionId" IS NOT NULL AND NOT "pendingExport"
  )
  ```
- Source: task DB-invariant list, item 2 ("coveredByExportBatchId IS NOT NULL возможно только при:
  status=APPROVED, resultingVersionId IS NOT NULL, pendingExport=false").
- Documentation synchronization: SYNCED.
- Minimum negative test: `coveredByExportBatchId` set (to a genuinely valid, same-period
  `CORRECTION` batch — isolating this CHECK from FN-26's own reference checks) while `status` is
  forced away from `APPROVED` — expect `23514` on this constraint by name (verified).

**CK-45/CK-46 overlap note**: the two CHECKs are not mutually exclusive. Any row with
`pendingExport=true` AND `coveredByExportBatchId` set simultaneously violates both — CK-45's own
clause requires `coveredByExportBatchId IS NULL` whenever `pendingExport` is true, and CK-46's own
clause requires `NOT pendingExport` whenever `coveredByExportBatchId` is set. This is expected: the
task lists them as two separate invariants, but they describe overlapping regions of the same
underlying state machine (`pendingExport` and `coveredByExportBatchId` are mutually exclusive by
construction — a row is never simultaneously "still pending" and "already covered"). Which of the
two constraint names Postgres reports for that specific combined violation is not guaranteed by this
schema and is not treated as a meaningful distinction by the application (`lib/csv-export.ts` never
constructs that combination in the first place).

### 13.2 Composite / plain foreign key register

| ID | Table | Columns | References | Source |
|---|---|---|---|---|
| — | `CorrectionRequest` | `coveredByExportBatchId` | `ExportBatch(id)` | Task schema completion spec |

Plain (non-composite) FK, `ON DELETE RESTRICT ON UPDATE CASCADE` — a correction that references a
batch as its coverage must never be left dangling by deleting the batch. `ExportBatch` is already
structurally undeletable (`trg_export_batch_immutable`, FN-23) — this `RESTRICT` is defense-in-depth
against a future change to that trigger, not an operational path exercised today. Not given its own
FK-NN identifier — the §11.3/§12.3 composite-FK numbering (FK-01..FK-17) is reserved for *composite*
foreign keys specifically (this one is a single-column FK, the ordinary Prisma-expressible kind,
same category as `ExportBatch.correctsBatchId` above it).

### 13.3 Trigger function register (FN-26)

### FN-26 `fn_correction_request_covered_batch_check`

- Table: `CorrectionRequest`.
- Behavior: `BEFORE INSERT OR UPDATE` — unlike `ExportBatch`/`ExportItem` (fully immutable via
  FN-23/FN-24), `CorrectionRequest` remains a mutable table, so this needs an `UPDATE` path too, not
  only `INSERT`.
  1. Immutability of this one column: `IF TG_OP = 'UPDATE' AND OLD."coveredByExportBatchId" IS NOT
     NULL AND NEW."coveredByExportBatchId" IS DISTINCT FROM OLD."coveredByExportBatchId"` → reject.
     Checked unconditionally first — once set, `coveredByExportBatchId` can never be cleared or
     replaced by a different batch (task DB-invariant item 4).
  2. Only at the `NULL -> value` transition (`TG_OP = 'INSERT'` or `OLD."coveredByExportBatchId" IS
     NULL`): validates the referenced `ExportBatch` exists (own explicit check, belt-and-suspenders
     alongside the FK in §13.2 — same style as FN-25's own predecessor check), has `kind =
     'CORRECTION'` (a `FULL` batch can never "cover" a correction — `FULL` batches only ever happen
     for a `LOCKED` period, before any correction could exist), and belongs to the SAME period as the
     `CorrectionRequest`'s own `Timesheet` (not expressible as a CHECK or a plain FK — neither can
     compare one row's column against a DIFFERENT table's row; same cross-table-comparison category
     as FN-25's own period-match check for `ExportBatch.correctsBatchId`).
- Stable exception identifiers: `CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE`,
  `CORRECTION_REQUEST_COVERED_BATCH_NOT_FOUND`, `CORRECTION_REQUEST_COVERED_BATCH_WRONG_KIND`,
  `CORRECTION_REQUEST_COVERED_BATCH_PERIOD_MISMATCH`.
- Row-lock contract: reads `ExportBatch`/`Timesheet` via a plain `SELECT`, no explicit row lock —
  both reads happen inside the transaction `lib/csv-export.ts::createExportBatch` runs, which already
  holds `FOR UPDATE` on the affected `Timesheet`/`CorrectionRequest`/`PayrollPeriod` rows (§BF) and
  never reads an as-yet-uncommitted `ExportBatch` (that row is inserted earlier in the same
  transaction than the `CorrectionRequest` `UPDATE`, see §BF step ordering) — no TOCTOU window.
- Source: task DB-invariant list, items 3-4.
- Minimum negative test: four scenarios, one per stable identifier — nonexistent batch id; a real
  `FULL` batch (wrong kind); a real `CORRECTION` batch of a *different* period (period mismatch,
  isolated from the wrong-kind case by using a genuine same-kind, different-period predecessor); and
  attempting to change or clear an already-set `coveredByExportBatchId` (immutability, both
  "replace with a different batch" and "clear to NULL" tested separately) — all four verified,
  `scripts/_test-csv-export.ts` F53. Positive: a genuinely valid same-period `CORRECTION` batch
  reference succeeds cleanly.

### FN-26 v2 — extended `[2026-08-19]` FOLLOW-UP (same function/trigger, not replaced)

**Status**: ACTIVE. The FN-26 entry above (behavior items 1-2, both stable identifier groups) is
kept verbatim, not erased — it still describes the `coveredByExportBatchId` branch exactly as
implemented, unchanged by this FOLLOW-UP. This entry documents the branch **added** to the *same*
`fn_correction_request_covered_batch_check` function body (`CREATE OR REPLACE FUNCTION`, same name)
by the additive corrective migration
`20260819190000_fix_correction_pending_export_excluded_participant` — `trg_correction_request_
covered_batch_check` (TRG-31) is unchanged as a trigger *instance* (still one `BEFORE INSERT OR
UPDATE` binding, same function).

**Root cause this branch fixes**: `lib/corrections.ts::decideCorrection` used to set
`CorrectionRequest.pendingExport = (period.status === 'EXPORTED')` alone. A correction on an
**excluded** (`PayrollPeriodParticipant.expected=false`) participant's `Timesheet` could reach
`pendingExport=true` and then never be clearable by any future export — export population
(`T8_REPORTS_DESIGN.md` §BA) is always `expected=true` only, so no `CORRECTION` batch snapshot could
ever represent that row, and nothing in `lib/csv-export.ts` would ever set its `pendingExport` back
to `false`. An unreachable, permanently-pending, DB-level-unenforced state.

**New behavior — item 3, added to FN-26's existing body**: whenever `NEW."pendingExport"` is `true`
(on `INSERT` or `UPDATE`, re-checked on every write while `true`, not only at a `false -> true`
transition — `pendingExport` is expected to flip back and forth over a row's lifetime, unlike
`coveredByExportBatchId`, which is genuinely write-once), the function now additionally resolves,
through the correction's own `Timesheet`, the `PayrollPeriod.status` and the matching
`PayrollPeriodParticipant.expected` in one `JOIN`/`LEFT JOIN` `SELECT ... INTO`, and rejects unless
`status = 'EXPORTED'` **and** `expected = true`. The three same-row conditions the task's own DB-
invariant list also names for this case (`status=APPROVED`, `resultingVersionId IS NOT NULL`,
`coveredByExportBatchId IS NULL`) are **not** reimplemented here — `ck_correction_request_pending_
export_shape` (CK-45, unchanged) already owns them; a CHECK constraint and a trigger deliberately
split same-row vs. cross-table responsibility, same separation of concerns the original T8.4A/T8.4B
CK-vs-FN split already established.

- Stable exception identifiers (new): `CORRECTION_REQUEST_PENDING_EXPORT_PERIOD_NOT_EXPORTED`,
  `CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_EXCLUDED`. Two more, defense-in-depth only
  (structurally unreachable through the exposed application path — `CorrectionRequest.timesheetId`
  is a `NOT NULL` FK to an always-existing `Timesheet`, and `Timesheet(periodId, employeeId)` has its
  own composite FK to `PayrollPeriodParticipant`, so a resolvable `Timesheet` can never lack a
  matching participant row — same reasoning as FN-25's own correction-chain cycle check):
  `CORRECTION_REQUEST_PENDING_EXPORT_TIMESHEET_NOT_FOUND`,
  `CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_NOT_FOUND`.
- Row-lock contract: plain `SELECT ... INTO` via a `JOIN`/`LEFT JOIN`, no explicit row lock — runs
  inside `lib/corrections.ts::decideCorrection`'s existing transaction, which already holds `FOR
  UPDATE` on `Employee`/`Timesheet`/`CorrectionRequest` (unchanged by this FOLLOW-UP) before this
  branch's `UPDATE` ever executes — no new TOCTOU window opened by this addition.
- Source: T8.4B FOLLOW-UP task spec, DB enforcement list items 4-6 (`PayrollPeriod.status=EXPORTED`;
  participant exists; `participant.expected=true`); items 1-3 of that same list are CK-45, unchanged.
- Minimum negative test: two isolated scenarios, one per non-defense-in-depth identifier — a real
  `APPROVED` correction on an excluded participant, with its period already genuinely `EXPORTED`
  (isolates `PARTICIPANT_EXCLUDED` from `PERIOD_NOT_EXPORTED`, since the function checks period
  status first); a real `APPROVED` correction on an *expected* participant whose period is still
  `LOCKED` (isolates `PERIOD_NOT_EXPORTED` from `PARTICIPANT_EXCLUDED`) — both verified,
  `scripts/_test-csv-export.ts` G5/G6. Positive: an expected participant's correction on an
  `EXPORTED` period still sets/keeps `pendingExport=true` and is still covered normally by the next
  `CORRECTION` export (G1/G7/G9 — re-verifies the pre-existing, unbroken behavior after this
  extension). Legacy repair query correctness — G8 (see §13.5 below).

### 13.4 Trigger instance register (TRG-31)

| ID | Table | Trigger | Function | Timing/Events |
|---|---|---|---|---|
| TRG-31 | `CorrectionRequest` | `trg_correction_request_covered_batch_check` | FN-26 (v2, `[2026-08-19]` extended) | `BEFORE INSERT OR UPDATE` |

Verified empirically: the trigger exists on `CorrectionRequest` (disposable PostgreSQL 16, `\d
"CorrectionRequest"` introspection) and is exercised by both positive and negative runtime tests
(§13.3, §13.3 FN-26 v2). Still exactly one trigger instance — the FOLLOW-UP added a new branch to
the same function body, not a second trigger.

### 13.5 Test register (T8.4B schema-completion obligations — executed, not merely specified)

Every object in this section (§13.1–§13.4) has been exercised on a disposable PostgreSQL 16 instance
via `scripts/_test-csv-export.ts` section F (F52-F54, F53 specifically for this section's own
objects — 171/171 checks in the full script at T8.4B, 100% pass), plus a dump/restore round trip on
a second disposable PostgreSQL 16 instance (row counts, `md5(content)` for every `ExportBatch`,
`coveredByExportBatchId` values, `fileHash`/`fileSizeBytes` all identical before/after; both
`trg_export_batch_immutable` and this section's own `trg_correction_request_covered_batch_check`
still reject their respective mutation attempts on the restored database).

**`[2026-08-19]` FOLLOW-UP additions** — `scripts/_test-csv-export.ts` section G (12 scenarios,
201/201 checks in the full script, 100% pass on disposable PostgreSQL 16): G1/G7/G9 re-verify
unchanged expected-participant behavior after the FN-26 extension; G2/G3/G4/G10 cover the fixed
excluded-participant lifecycle end to end (never becomes pending, never blocks/gets covered, never
touches `ExportBatch`/`ExportItem`); G5/G6 are the FN-26 v2 negative tests above; **G8** proves the
migration's own legacy-repair `UPDATE` query correctness by disabling `trg_correction_request_
covered_batch_check` just long enough to force a real row into the otherwise now-unreachable bad
state (a genuine `APPROVED` correction, real `resultingVersionId`, real excluded participant, real
`EXPORTED` period — only `pendingExport` is forced true while the trigger is off), re-enabling the
trigger, then running the exact repair query from the migration's Section A and confirming it clears
`pendingExport`/`coveredByExportBatchId` back to `false`/`NULL`; G11 re-verifies the pre-existing
`coveredByExportBatchId` immutability/kind/period-mismatch branches (§13.3 FN-26, original) still
reject correctly after the FN-26 body was extended; G12 confirms `AuditEvent(CORRECTION_APPROVED)`
carries no `pendingExport`/`coveredByExportBatchId`/export-lifecycle/PII fields. Dump/restore was not
re-run for this FOLLOW-UP specifically (scope: a trigger-function body extension plus one column's
runtime semantics, not a new byte-storage structure — already proven for `CorrectionRequest`/
`ExportBatch` at T8.4B).

### 13.6 Arithmetic assertions (T8.4B schema-completion additions only)

```text
T8.4B SCHEMA COMPLETION RAW-SQL TOTALS (additive to Sections 1–12 totals)
New tables: 0
New enums: 0
New columns on pre-existing models: 1 (CorrectionRequest.coveredByExportBatchId)
CHECK constraints, currently active: 2 (CK-45, CK-46)
Partial/expression unique indexes: 0
Composite foreign keys: 0
Plain (non-composite) foreign keys: 1 (CorrectionRequest.coveredByExportBatchId -> ExportBatch)
Plain indexes: 1 (CorrectionRequest(coveredByExportBatchId))
Trigger functions: 1 (FN-26)
Trigger instances: 1 (TRG-31)
New permissions: 0 (period.export/export.create/export.read already seeded by T8.4A,
  20260819160000_seed_export_permissions — this slice adds zero new Permission/RolePermission rows)
New PostgreSQL extensions: 0
```

### 13.7 Arithmetic assertions — `[2026-08-19]` FOLLOW-UP additions only

```text
T8.4B FOLLOW-UP (align correction export eligibility) RAW-SQL TOTALS (additive to §13.6 totals)
New migrations: 1 (20260819190000_fix_correction_pending_export_excluded_participant — additive,
  does not edit 20260819180000 or any earlier migration)
New tables: 0
New enums: 0
New columns: 0
New/changed CHECK constraints: 0 (ck_correction_request_pending_export_shape / _covered_shape,
  CK-45/CK-46, both unchanged — same-row conditions remain their sole responsibility)
Trigger functions changed (CREATE OR REPLACE, same identifier): 1 (fn_correction_request_covered_
  batch_check, FN-26 -> v2 — one new IF branch added, all existing branches byte-identical)
Trigger instances: 0 new (TRG-31 rebinds automatically to the replaced function body)
New stable exception identifiers: 4 (CORRECTION_REQUEST_PENDING_EXPORT_PERIOD_NOT_EXPORTED,
  CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_EXCLUDED,
  CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_NOT_FOUND [defense-in-depth],
  CORRECTION_REQUEST_PENDING_EXPORT_TIMESHEET_NOT_FOUND [defense-in-depth])
Legacy data repair: 1 UPDATE statement (idempotent — zero-row no-op on a database with no
  pre-existing bad state; this project's own preview/production databases have never received the
  T8.4B migrations at all per that task's own STOP-GATE, so they hold no CorrectionRequest rows with
  this shape either way — repair correctness itself proven via a manually-crafted fixture on
  disposable PostgreSQL, scripts/_test-csv-export.ts G8, not via a real repair on a persistent
  instance)
New permissions: 0
New PostgreSQL extensions: 0
```

## 14. T9 worker-specific submission cycles

Migration `20260821100000_add_timesheet_submission_schedules` adds four CHECK constraints:

- `ck_timesheet_submission_schedule_week_start` (`0..6`);
- `ck_timesheet_submission_schedule_anchor_alignment` (anchor weekday equals `weekStartsOn`);
- `ck_timesheet_submission_schedule_version` (`version > 0`);
- `ck_employee_timesheet_schedule_dates` (`effectiveTo IS NULL OR >= effectiveFrom`).

It also adds partial unique index `ux_timesheet_submission_schedule_company_default`, EX-07, and
the following cross-table trigger objects:

| Table | Trigger | Function | Stable rejection |
|---|---|---|---|
| `PayrollPeriodParticipant` | `trg_payroll_period_participant_employee_overlap_check` | `fn_payroll_period_participant_employee_overlap_check` | `PAYROLL_PERIOD_PARTICIPANT_DATE_OVERLAP` (`P0001`) |
| `PayrollPeriod` | `trg_payroll_period_date_update_participant_overlap_check` | `fn_payroll_period_date_update_participant_overlap_check` | `PAYROLL_PERIOD_PARTICIPANT_DATE_OVERLAP` (`P0001`) |

Both paths lock affected `Employee` rows before the overlap read. Positive disposable-PostgreSQL
proof: weekly `2026-08-17..23` for employee A and biweekly `2026-08-17..30` for employee B coexist.
Negative proof: inserting A into the biweekly period is rejected with the exact stable identifier.
