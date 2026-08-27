# T10 · Задача B — единый экран утверждения табелей

Статус: **design checkpoint** — код не начат, жду утверждения владельца.
Дата: 2026-08-27. Часть пакета A–F (делаем последовательно; A уже готова, `fe28442`).

## 1. Проблема

Сейчас, чтобы утвердить недельные часы, начальник ходит по трём экранам:

1. `/admin/review-scopes` — подтвердить каждый «раздел» табеля (по объектам + отсутствия);
2. `/admin/timesheets` — найти табель в статусе «Одобрен прорабом» и нажать «Финально утвердить»;
3. `/admin/corrections` — если нужна правка (теперь ещё и задача A).

Прорабов у заказчика нет и пока не будет — начальник и есть последняя инстанция. Значит шаги 1 и 2
для него — лишняя церемония. Нужен **один экран**: список всех работников, чьи часы ждут решения →
клик на работника → его табель → «Утвердить». Не громоздко.

## 2. Что делаем

### 2.1 Новый экран `/admin/review` — «Часы на утверждении»

Server Component. Одна строка на каждый **`Timesheet` в статусе `SUBMITTED` или `FOREMAN_APPROVED`,
период которого `OPEN`** (все открытые периоды сразу — недельные и двухнедельные когорты вместе, а
не по одному периоду, как сейчас `/admin`).

Строка показывает:

| Поле | Источник |
|---|---|
| Работник (фамилия имя, номер) | `Employee` |
| Период | `PayrollPeriod.startDate–endDate` |
| Всего часов | сумма по `WorkSegment` текущей версии через `lib/reporting/worked-time.ts` |
| Объект(ы) | `WorkSegment.siteId` → имена |
| Статус | `SUBMITTED` → «На проверке», `FOREMAN_APPROVED` → «Готов к утверждению» (позже с прорабом — «Утверждён прорабом») |
| Замечания | число `AttendanceException(OPEN)` за период + флаг «план ≠ факт» (`computeSiteScopeHasExceptionBulk`) |

**Управление (не тяжёлое):**

- фильтр по объекту (один `<select>`);
- переключатель «только с замечаниями»;
- сортировка: по фамилии / по часам / по объекту (radio или `<select>`);
- всё через `<form method="GET">` — без client-side fetch, как остальные admin-списки.

**Действие:** строка — ссылка на `/admin/timesheets/[id]` (карточка из задачи A: дни, «Исправить
часы», утверждение). Плюс **inline-кнопка «Утвердить»** прямо в строке — только для строк **без
замечаний** (быстрый проход по чистым табелям, не открывая каждый). Строки с замечаниями inline-кнопки
не имеют — их обязательно открыть.

### 2.2 Одна кнопка «Утвердить табель» — `adminApproveTimesheet()`

Новая lib-функция (`lib/admin-timesheets.ts`), одна транзакция, `Employee → Timesheet FOR UPDATE`:

- **статус `SUBMITTED`:**
  - для каждого `TimesheetReviewScope(PENDING)` текущей версии: если на объекте этого scope есть
    активный `ForemanAssignment` → **отказ `FOREMAN_REVIEW_PENDING`** (с перечнем объектов) —
    двухшаговую модель с прорабом не ломаем;
  - иначе — подтвердить все scope → `FOREMAN_APPROVED` → `FINAL_APPROVED`, одним переходом,
    `AuditEvent(FOREMAN_APPROVED)` на каждый scope + `AuditEvent(FINAL_APPROVED)` на табель;
- **статус `FOREMAN_APPROVED`:** просто `FINAL_APPROVED` (как сейчас `finalApproveTimesheet`);
- иначе → `INVALID_STATE_TRANSITION`;
- **запрет самоутверждения:** `actor.employeeId != Timesheet.employeeId` (как в `approveReviewScope`).

Права: требует `timesheet.scope_review.all` **и** `timesheet.final_approve` (обе уже есть, ADMIN/
SUPER_ADMIN). **Миграции нет.**

Роут: `POST /api/admin/timesheets/:id/approve` (новый; existующий `/final-approve` остаётся для
обратной совместимости, но UI переключается на `/approve`).

Карточка `/admin/timesheets/[id]`: для `SUBMITTED` и `FOREMAN_APPROVED` — кнопка «Утвердить часы»
(зовёт `/approve`). Для `SUBMITTED` рядом остаётся «Исправить часы» (задача A). «Вернуть работнику с
причиной» — тоже здесь (переиспечь `/return`).

### 2.3 Индикатор у колокольчика

Новый маленький client-компонент `ReviewQueueIndicator` в `app/admin/layout.tsx` — **слева от
`NotificationCenter`**. Иконка-календарь (inline SVG, как `BellIcon`) + бейдж с числом. Опрос
`GET /api/admin/review-queue` (`{ count }` — число табелей `SUBMITTED`+`FOREMAN_APPROVED` в `OPEN`
периодах) раз в 5 мин и на `focus`, как у колокольчика. Клик → `/admin/review`. Ноль → без бейджа.

### 2.4 Навигация

Группа «Проверка» (`ADMIN_NAV`): `/admin/review` первым пунктом («Часы на утверждении»), затем
существующие «Табели», «Проверка по разделам» (= `/admin/review-scopes`, оставляем как fallback для
будущих прорабов и NON_SITE), «Корректировки».

## 3. Что НЕ трогаем

- `/admin/review-scopes`, `/admin/timesheets` (список), `/admin/corrections` — остаются, просто
  перестают быть основным путём;
- модель `SUBMITTED → FOREMAN_APPROVED → FINAL_APPROVED` и review-scopes — без изменений, кнопка
  просто проходит их за один шаг, когда прораба нет;
- `/admin` Today dashboard — отдельный экран (оперативный обзор дня), его блок «Табели и
  утверждение» можно позже заменить ссылкой на `/admin/review`, но не в этой задаче.

## 4. Файлы (оценка)

`lib/admin-timesheets.ts` (`adminApproveTimesheet` + `getReviewQueue`) · `lib/review-queue.ts` (new,
или в admin-timesheets) · `app/api/admin/timesheets/[timesheetId]/approve/route.ts` (new) ·
`app/api/admin/review-queue/route.ts` (new) · `app/admin/review/page.tsx` + фильтр-компонент (new) ·
`app/admin/timesheets/[timesheetId]/page.tsx` + `ApproveTimesheetButton.tsx` (new) ·
`components/admin/ReviewQueueIndicator.tsx` (new) · `app/admin/layout.tsx` · `lib/i18n/admin*.ts` ·
`docs/titanor-time/{01_SCREEN_MAP.md, 02_ROLE_PERMISSION_MATRIX.md}` · тест
`scripts/_test-admin-approve-timesheet.ts` (new).

## 5. Проверки

`_test-admin-approve-timesheet.ts` на одноразовом PostgreSQL 16: `SUBMITTED` без прораба → один клик
→ `FINAL_APPROVED` + аудит; `SUBMITTED` с прорабом на объекте → `FOREMAN_REVIEW_PENDING`;
`FOREMAN_APPROVED` → `FINAL_APPROVED`; самоутверждение запрещено; `getReviewQueue` фильтры/сортировка;
регрессия `approveReviewScope` / `finalApproveTimesheet`. `tsc --noEmit` + `next build` + HTTP E2E
против собранного образа + прогон на пилоте.

## 6. Решения владельца (2026-08-27)

1. **Inline-кнопка «Утвердить» в списке для строк без замечаний — ДА.** Строки с замечаниями
   inline-кнопки не имеют.
2. **Тех, кто ещё не сдал табель — ДА**, отдельным блоком «Ещё не сдали: N» (список имён + период),
   не в основном списке.
3. **«Замечания» = открытые `AttendanceException` + расхождение отработанных часов с плановым
   шаблоном** (`computeSiteScopeHasExceptionBulk`).
4. **Название экрана: «На утверждении».** Путь `/admin/review`.
