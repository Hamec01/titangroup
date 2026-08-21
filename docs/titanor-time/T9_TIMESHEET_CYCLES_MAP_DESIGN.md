# T9 — индивидуальные циклы табелей, live attendance и карта

Статус: design checkpoint до schema/product code. Дата: 2026-08-21.

## 1. Проблема текущей модели

`PayrollPeriod` сейчас является company-wide диапазоном. EX-03
`ex_payroll_period_date_overlap` запрещает пересечение любых двух периодов, а `createPeriod()`
включает всех работников с пересекающимся `SiteAssignment`. Поэтому недельный цикл одного
работника и двухнедельный цикл другого непредставимы.

Рабочий шаблон и частота сдачи табеля — разные настройки:

- `WorkScheduleTemplateVersion` описывает ожидаемые рабочие дни/часы;
- `TimesheetSubmissionSchedule` описывает границы и частоту сдачи табеля.

## 2. Целевая модель

### 2.1 TimesheetSubmissionSchedule

Разделяем работников на переиспользуемые schedule cohorts:

- `id` UUID;
- `name`;
- `cadence`: `WEEKLY | BIWEEKLY`;
- `weekStartsOn`: в первом релизе `0` (понедельник), поле остаётся явным;
- `anchorDate`: понедельник, от которого считаются двухнедельные границы;
- `isCompanyDefault`;
- `active`, `version`, timestamps;
- audit actor для административных изменений.

Начальный набор: `Weekly` (company default) и `Every two weeks`. Позже можно безопасно добавить
monthly/custom без изменения смысла существующих строк.

### 2.2 EmployeeTimesheetSchedule

Версионированная effective-dated связь:

- `employeeId`, `scheduleId`;
- inclusive `effectiveFrom`, nullable inclusive `effectiveTo`;
- `assignedByUserId`, timestamps.

DB invariant: диапазоны одного `employeeId` не пересекаются. Изменение по умолчанию начинает новую
строку со следующей границы, закрывая старую днём ранее. История не переписывается.

### 2.3 PayrollPeriod

Добавляется nullable `submissionScheduleId`. `null` означает legacy/manual период. Для generated
period identity: `(submissionScheduleId, startDate, endDate)` unique.

EX-03 в company-wide форме удаляется. Вместо него DB trigger/advisory row-lock обеспечивает:

> Один работник не может быть expected participant двух пересекающихся периодов. Периоды разных
> schedule cohorts могут пересекаться.

Триггер проверяется при INSERT/UPDATE `PayrollPeriodParticipant` и при изменении дат legacy OPEN
периода. `Employee` блокируется до overlap-read, чтобы два конкурентных генератора не прошли
проверку одновременно.

## 3. Генерация

`ensureTimesheetPeriods(asOf, horizon)`:

1. вычисляет текущий и следующий диапазон каждой активной schedule-конфигурации;
2. `INSERT ... ON CONFLICT DO NOTHING` создаёт ровно один `PayrollPeriod` на cohort/range;
3. выбирает effective employee schedule rows и актуальные employment/assignment;
4. создаёт participant/timesheet/draft тем же общим core, который сегодня использует
   `createPeriod()`; отдельная копия формулы запрещена;
5. повторный запуск идемпотентен.

Запуск: один раз при сохранении worker schedule и один раз в scheduler daily pacing. Ручная кнопка
«Создать период» остаётся только для legacy/admin repair и не является частью обычного setup.

## 4. Изменение периода

Generated period получает даты из schedule и напрямую не редактируется: UI ведёт к изменению
schedule со следующей границы.

Legacy/manual `OPEN` period можно изменить с optimistic `version`, `Idempotency-Key`, CSRF и
`period.update`:

- `LOCKED`/`EXPORTED` неизменяемы;
- наличие submitted/approved version блокирует смену дат;
- ни ClockEvent/ClockShiftFragment/draft segment/exception не может оказаться вне нового диапазона;
- при расширении общая generation-функция добавляет недостающие days/planned shifts;
- при сокращении удаляются только пустые generated days/planned shifts;
- ответ перечисляет конкретные blockers без GPS/PII;
- AuditEvent содержит только старые/новые даты и version.

Pilot legacy период после проверки можно сократить до корректной границы, затем назначить
работникам schedules со следующего понедельника.

## 5. UI начальника

В worker card единый блок «Настройка работы»:

- объект и optional work area;
- рабочий шаблон;
- «Сдача табеля»: company default / weekly / every two weeks;
- preview трёх следующих диапазонов и даты auto-submit;
- изменение: рекомендуемое «со следующего периода»;
- явная подсказка, что рабочий шаблон не задаёт частоту сдачи.

Setup checklist заменяет ручной `Open payroll period` на `Timesheet schedule configured`.
Periods list группирует одновременно открытые cohorts и показывает cadence/число участников.

## 6. Live attendance

`EmployeeOpenShift.openedAt` — durable source. ADMIN view:

- зелёный `WORKING_NOW`;
- elapsed duration обновляется локально раз в минуту;
- authoritative overview перечитывается раз в 30 минут только в видимой вкладке;
- никаких heartbeat/time-fragment записей по таймеру.

Check Out создаёт точный durable `ClockShift`/fragment. Submit замораживает immutable
`TimesheetVersion`; worker edit запрещён, пока ADMIN явно не вернёт табель.

Все instants хранятся UTC и показываются в `Europe/Helsinki` с DST.

## 7. Округление

Raw ClockEvent/ClockShift никогда не округляется. Отдельная company policy задаёт presentation/
payroll rounding. Подтверждённая входная формула: nearest 30 minutes, half-up:

- 07:10 → 07:00;
- 07:15 → 07:30;
- 07:24 → 07:30;
- 07:52 → 08:00.

Округлённые start/end сохраняются как timesheet reported segment, с origin fragment link. UI
показывает `Recorded` и `Payable/Reported`, чтобы ADMIN видел разницу. То же правило подтверждено
владельцем для Check Out. Если две округлённые границы редкого короткого интервала совпали бы,
reported projection сохраняет точные положительные границы: нулевая строка запрещена моделью,
тихое удаление потеряло бы время, а искусственные 30 минут завысили бы оплату.

## 8. Бесплатная карта и GPS

Renderer: npm `maplibre-gl`; base style: configurable OpenFreeMap URL. Никакого Google key/billing.
Provider URL находится в env/config и может быть заменён без новой сборки.

Address search: server-side proxy к Nominatim для pilot с обязательными ограничениями:

- только явный Search submit, без autocomplete;
- global rate limit <= 1 req/s;
- identifying User-Agent/Referer, attribution;
- нормализованный query cache;
- результаты — allowlisted address/lat/lon, без передачи персональных данных;
- provider заменяем; production scale требует hosted provider/self-hosting.

Site editor:

- найти адрес;
- выбрать результат или кликнуть/перетащить pin;
- увидеть координаты и radius circle;
- сохранить новую immutable GeofenceVersion;
- выбранные координаты остаются единственным источником геозоны; нормализованный запрос и
  allowlisted результаты живут только в серверном cache провайдера.

Attendance location viewer:

- отдельное `attendance.gps.read.raw`, только ADMIN/SUPER_ADMIN;
- worker-scoped экран за выбранный диапазон (не более 31 дня и 200 событий), не постоянный tracking;
- check-in/check-out markers и текстовые accuracy/verdict/distance, только для событий с реально
  сохранённым GPS snapshot;
- каждое раскрытие создаёт sanitized AuditEvent;
- Cache-Control no-store, координаты не попадают в overview/HTML/log;
- существующий 90-day retention сохраняется;
- FOREMAN/WORKER доступа к raw GPS не получают.

## 9. Последовательность реализации

1. schedule schema + permissions + participant overlap invariant;
2. shared generation core + scheduler integration + migration legacy behavior;
3. worker/company schedule API и UI;
4. guarded legacy period update;
5. mixed-cycle overview/report/export reconciliation;
6. MapLibre site picker + geocoding proxy;
7. audited GPS detail viewer;
8. rounding policy после подтверждения Check Out semantics.

## 10. Реализованное продолжение (2026-08-21)

- Worker page: выбор Weekly/Every two weeks и только допустимых границ выбранного цикла;
- current+next period создаются только для выбранного Employee; scheduler каждые 6 часов
  идемпотентно поддерживает тот же горизонт;
- legacy OPEN period меняется только без потери fragment/segment/immutable version;
- overview без periodId объединяет текущие cohorts;
- TimesheetDraftSegment получает nearest-30 границы, raw ClockEvent/ClockShift не меняются;
- site editor использует MapLibre 5.24 + OpenFreeMap, pin/radius и button-only Nominatim proxy с
  DB-cache и межпроцессным rate gate;
- raw GPS вынесен в отдельный audited/no-store ADMIN screen, retention остаётся 90 дней.
