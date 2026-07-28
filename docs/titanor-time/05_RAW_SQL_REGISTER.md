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
| CK-08 | `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative` | `WorkScheduleTemplateVersionDay` | current |
| CK-09 | `ck_payroll_period_date_range` | `PayrollPeriod` | current |
| CK-10 | `ck_payroll_period_status_metadata_shape` | `PayrollPeriod` | current |
| CK-11 | `ck_payroll_period_participant_exclusion_metadata_shape` | `PayrollPeriodParticipant` | current |
| CK-12 | `ck_timesheet_draft_planned_shift_shape` | `TimesheetDraftPlannedShift` | current |
| CK-13 | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative` | `TimesheetDraftPlannedShift` | current |
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

### CK-08 `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative`

- Table: `WorkScheduleTemplateVersionDay`
- Predicate:
  ```sql
  "plannedBreakMinutes" >= 0
  ```
- Structural readiness: `prisma/schema.prisma:227` — `plannedBreakMinutes Int`.
- Source: DEC-05 (owner-approved).
- Documentation synchronization: MISSING — `03_DATA_MODEL_ERD.md` не содержит явного `>= 0` требования для этого поля.
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

### CK-13 `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative`

- Table: `TimesheetDraftPlannedShift`
- Predicate:
  ```sql
  "plannedBreakMinutes" >= 0
  ```
- Structural readiness: `prisma/schema.prisma:378`.
- Source: DEC-05 (owner-approved).
- Documentation synchronization: MISSING.
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
| EX-03 | `ex_payroll_period_date_overlap` | `PayrollPeriod` | current |
| EX-04 | `ex_timesheet_draft_segment_time_overlap` | `TimesheetDraftSegment` | current |
| EX-05 | `ex_timesheet_draft_break_segment_time_overlap` | `TimesheetDraftBreakSegment` | current |
| EX-06 | `ex_break_segment_time_overlap` | `BreakSegment` | current |

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
- Несколько `OPEN`-периодов допустимы, если их даты не пересекаются.
- SQLSTATE: `23P01` (`exclusion_violation`).
- Service identity: точное имя `ex_payroll_period_date_overlap`.
- `[)`-семантика (date range): доменная `endDate` включительна, поэтому верхняя exclusive-граница строится как следующий календарный день (`endDate + 1`). Смежные периоды, где `left.endDate + 1 = right.startDate`, допустимы. Реальное пересечение дат отклоняется.
- Source: `03_DATA_MODEL_ERD.md` §4.5, строки 521-524.
- Documentation synchronization: SYNCED.
- Minimum negative test: два `PayrollPeriod` с пересекающимися датами — второй `INSERT` отклонён, SQLSTATE `23P01`; смежные периоды (`endDate` одного = `startDate - 1` следующего) — оба `INSERT` проходят.

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
