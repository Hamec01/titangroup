# SMOKE-C — очистка тестовых записей write-smoke (production)

**Статус:** ✅ **ВЫПОЛНЕНО 2026-09-03 ~12:00 UTC** одной транзакцией. Production healthy, schema **100/100**.
Разрешение владельца — 2026-09-03. SQL: `ops/titanor-time/r15-d7/cleanup-smoke-c.sql`.

## Что чистили

Записи, созданные write-smoke Deploy C (2026-09-03 09:36–09:38): 8 работников `firstName='SMOKEC'`
(№1011–1018), 4 объекта `SMOKE-C …`, 3 заказчика, 3 payroll-периода (созданы smoke'ом), и всё
связанное. Настоящие данные №1000–1010 и 3 настоящих объекта не затрагивались.

## Как

Одна транзакция (`psql -v ON_ERROR_STOP=1`):
1. **Verified backup** `production-20260903T115811Z-pre-migration` (on-box + off-box, `restore-test` 13/13). Плюс контрольный прогон всего SQL на **восстановленной копии** в disposable-БД — COMMIT чистый, все проверки зелёные.
2. `BEGIN` → **preflight** (8×`SMOKEC`, 4×`SMOKE-C`, 3 периода без реальных участников, изоляция назначений) + снимок baseline настоящих данных.
3. `ALTER TABLE … DISABLE TRIGGER` для **4** immutable/no-delete триггеров: `trg_assignment_transition_immutable`, `trg_auto_submission_attempt_immutable`, `trg_clock_event_immutable`, `trg_clock_shift_no_delete`. **`trg_audit_event_immutable` не отключался.**
4. `DELETE` строго по FK-порядку (children → parents), scoped по 8 emp / 8 user / 4 site / 3 workArea / 3 period id.
5. `ALTER TABLE … ENABLE TRIGGER` — все 4 обратно.
6. **postcheck**: 4 триггера снова `ENABLED` (через `pg_trigger.tgenabled`); baseline настоящих данных без изменений; остаток №1017 ровно Employee=1 / User=1 / inactive Employment=1 / AuditEvent(CLOCK_*)=2; все прочие SMOKE-строки = 0. Любое расхождение → `RAISE EXCEPTION` → `ROLLBACK`.
7. `COMMIT`.

## Удалено (счётчики совпали с dry-run на восстановленной копии)

| | | | | | |
|---|---|---|---|---|---|
| AttendanceException 4 | AdminNotification 13 | AutoSubmissionAttempt 13 | TimesheetReviewScope 13 | TimesheetPlannedShift 91 | TimesheetDay 91 |
| TimesheetVersion 13 | TimesheetDraftPlannedShift 30 | TimesheetDraftDay 112 | TimesheetDraft 29 | Timesheet 29 | PayrollPeriodParticipant 29 |
| ClockShift 1 | ClockEvent 2 | AssignmentTransition 9 | SiteAssignment 9 | EmployeeTimesheetSchedule 7 | UserRole 1 |
| Employment 7 | User 7 | Employee 7 | WorkArea 3 | WorkSite 4 | PayrollPeriod 3 |

`Timesheet.currentVersionId` обнулён (29). Прод: 2906 → 2379 строк.

## Оставлено — №1017 (архивная запись, согласовано)

№1017 делал реальный Check In/Out → 2 immutable `AuditEvent` (`CLOCK_CHECK_IN`/`CLOCK_CHECK_OUT`)
ссылаются на его user как actor. Так как AuditEvent сохраняем и аудит-триггер не трогаем — остаётся:
`Employee` + `User` + неактивный `Employment` + 2 записи аудита CLOCK_*. Все его табели, назначения,
смены, исключения, уведомления, участия в периодах — удалены.

## Проверка после очистки (live prod)

| | до | после |
|---|---|---|
| `/admin/review` — на утверждении | 13 SMOKE | **0** |
| `/admin/review` — черновики | 16 SMOKE + 22 наст. | **22** (только настоящие) |
| Уведомления (не разрешены) | 13 SMOKE + 1 наст. | **1** |
| Исключения посещаемости OPEN | 4 SMOKE + 19 наст. | **19** |
| Список работников (по умолч.) | 7 SMOKE + 11 наст. | **11** |
| Список объектов | 0 (скрыты) | **0** |
| Отчёты по периодам | 29 SMOKE-участий | **0** |
| SMOKE-C в HTML `/admin/review`,`/admin/workers`,`/admin/sites` | — | **0 упоминаний** |
| `/admin/workers?archived=1` | — | 1 (№1017 — архивная запись, ожидаемо) |
| Настоящие данные №1000–1010, 3 объекта, 3 наст. периода, 491 AuditEvent, 100 миграций | — | **без изменений** |
| 4 триггера | — | **все ENABLED** |
| `/api/ready` | — | 200 `current 100/100` |

Post-cleanup backup: `production-20260903T120911Z-manual`.
