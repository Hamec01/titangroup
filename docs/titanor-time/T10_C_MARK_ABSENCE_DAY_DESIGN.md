# T10 · Задача C — отметить день (больничный / отпуск / …) при проверке табеля

Статус: реализовано (`[2026-08-27]`). Часть пакета A–F. A и B готовы.

## 1. Проблема

Владелец: *«нужна функция утвердить любые часы любого дня админу по желанию (человек отработал 3 дня,
начальник знает — сразу утверждает)»* и *«кнопка: больничный, отпуск, другая ситуация, где работник
может оставить комментарий»*.

Технически: любой не-`WORK` тип дня (`SICK_LEAVE / VACATION / UNPAID_LEAVE / OTHER / PUBLIC_HOLIDAY`)
требует **одобренного `Absence`**, покрывающего дату (`DAY_TYPE_REQUIRES_ABSENCE`). Но в системе
**нет ни одного пути создать `Absence`** — ни API, ни UI, ни разрешения. То есть отметить день
отсутствием сейчас в принципе невозможно.

## 2. Решение (минимальное, без миграции)

Редактор дня корректировки (задача A: `CorrectionDayEditor` + `patchCorrectionDraftDay`) уже
принимает `dayType` и `note`. Достраиваем:

- **`patchCorrectionDraftDay(..., actorUserId?)`** — новый 4-й аргумент. Когда админ ставит
  absence-тип (`SICK_LEAVE / VACATION / UNPAID_LEAVE / OTHER`) и покрывающего `Absence` нет,
  функция **сама создаёт однодневный `APPROVED Absence`** (`startDate = endDate = дата`, `type`,
  `note` из поля, `createdBy = approvedBy = этот админ`, `overlayAppliedDates/overlayConflicts = []`
  чтобы удовлетворить `ck_absence_status_metadata_shape`) + `AuditEvent(ABSENCE_CREATED)`. Если
  `Absence` уже есть — переиспользуется. `PUBLIC_HOLIDAY` по-прежнему отклоняется (нет
  соответствующего `AbsenceType`). Без `actorUserId` поведение прежнее — обратная совместимость.
- День-роут `PATCH /api/admin/corrections/:id/days/:date` передаёт `authenticated.user.id`.
- **`CorrectionDayEditor`** получает `<select>` типа дня (Работал / Больничный / Отпуск /
  Неоплачиваемый отпуск / Другое) + поле комментария для не-`WORK`. Для не-`WORK` часы прячутся,
  PATCH шлёт `{ dayType, note, segments: [] }`. Обратно в «Работал» — тоже одним выбором.
- Кнопка «Исправить часы» на карточке табеля переименована в **«Исправить часы / отметить
  больничный, отпуск»** — та же точка входа (задача A), просто явная.

«Утвердить как есть» отдельной кнопкой не требуется: пустой день не блокирует утверждение (задача B
считает его как 0 ч). Сценарий «отработал 3 дня» = 3 дня с часами + 4 пустых/отмеченных → «Утвердить».

## 3. Что НЕ делаем в C

- Отдельный экран/раздел управления отсутствиями, `absence.manage` permission, редактирование
  диапазонов, отмену/удаление `Absence` — отдельная задача (при необходимости).
- Работник сам себе отсутствие не ставит (по-прежнему только через админа).
- Overlay-движок (`lib/periods.ts`) не меняется — созданный здесь `Absence` он просто увидит как
  готовую строку.

## 4. Файлы

`lib/corrections.ts` · `app/api/admin/corrections/[correctionRequestId]/days/[date]/route.ts` ·
`app/admin/corrections/[correctionRequestId]/days/[date]/CorrectionDayEditor.tsx` ·
`app/admin/timesheets/[timesheetId]/StartCorrectionForm.tsx` ·
`scripts/_test-admin-mark-absence-day.ts` (new).

## 5. Проверки

`_test-admin-mark-absence-day.ts` — 12/12 на одноразовом PostgreSQL 16: авто-создание `APPROVED
Absence` + аудит + `sourceAbsenceId` на замороженном `TimesheetDay` + нулевые часы за день;
переиспользование существующего `Absence`; без `actorUserId` → прежний `DAY_TYPE_REQUIRES_ABSENCE`;
`PUBLIC_HOLIDAY` отклоняется. Регрессия A (28/28) и B (22/22). `tsc` + `next build` — зелёные.
