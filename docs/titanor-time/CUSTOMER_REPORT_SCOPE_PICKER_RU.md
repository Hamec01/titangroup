# Design note — выбор объектов и работников в отчёте заказчика

- **Страница:** `/admin/reports/customer` (Customer Project Working Hours, T13.11).
- **Дата:** 2026-08-31. **Изолированная работа:** только код + тесты + отчёт. Production, Caddy, DNS,
  production-БД, rollback-контейнеры — **не трогаются**. Деплой — только по отдельному разрешению.
- **Тип задачи:** UX выбора scope. **Расчёты, округление, статусы, readiness, PDF/CSV, permissions,
  Prisma schema — не меняются** (ТЗ §9).

---

## 1. Проблема

Сейчас «Работники» и «Объекты» — нативный `<select multiple size={6}>`. Непонятно кто выбран, как
снять выбор, кто относится к объекту, как выбрать весь объект. Действует неявное правило
**«ничего не выбрано = выбраны все»**. Состояние живёт в `useState`, не в URL — reload / Back /
Forward / ссылка не воспроизводят выбор.

## 2. Целевой поток (ТЗ §1)

```
1. Объекты          → панель с поиском, чекбоксами, «Выбрать все / Снять выбор», счётчиком
2. Работники        → появляется после выбора объектов; список = работники выбранных объектов
                      за диапазон дат; поиск, чекбоксы, «Выбрать всех …», счётчик
3. Резюме выбора    → «Объекты: … · Работники: выбрано N из M»
4. [Показать и проверить]
5. Результат        → readiness + итоги + кнопки скачивания (как сейчас)
```

## 3. Модель «объект → работники» (ТЗ §3)

Отчёт заказчика и `resolveCustomerReadiness` **сегментные, а не по текущему назначению** — работник,
сменивший объект, всё равно показывает исторические часы (`lib/reporting/customer-hours.ts:10`).
Поэтому список-кандидат — **надмножество** того, что попадёт в отчёт:

Работник входит в список для выбранных объектов и диапазона `[dateFrom, dateTo]`, если:
- **assigned** — есть `SiteAssignment` на один из выбранных объектов, где
  `validFrom <= dateTo` и (`validTo IS NULL` или `validTo >= dateFrom`); **или**
- **hasHours** — есть canonical-сегмент на одном из выбранных объектов с `date` в диапазоне:
  - `WorkSegment` версии, которая является canonical-источником своего табеля
    (`resolveCanonicalSource` — та же логика, что в отчёте), **или**
  - `TimesheetDraftSegment` черновика, если черновик — canonical-источник.

Режим «Все объекты» → фильтр по `siteId` снимается (работник входит при назначении/часах на
**любой** объект в диапазоне).

Каждый работник в списке: `firstName lastName`, `employeeNumber`, список **выбранных** объектов,
к которым он относится, и метки `assigned` / `hasHours`. Один работник — одна строка, даже если он
на нескольких выбранных объектах (объекты перечисляются рядом) — ТЗ §3.

Исторические часы не скрываются из-за законченного назначения: `hasHours` не зависит от `validTo`.

### `resolveCustomerScopeWorkers({ siteMode, siteIds, dateFrom, dateTo })` — bounded, read-only

| # | запрос | назначение |
|---|---|---|
| 1 | `payrollPeriod.findMany` (периоды, пересекающие диапазон) | id'ы периодов |
| 2 | `timesheet.findMany` (в периодах, все работники; select id/employeeId/status/currentVersionId/draft) | → `resolveCanonicalSource` → versionIds + draftIds |
| 3 | `workSegment.findMany({ timesheetVersionId in versionIds, [siteId in siteIds], date in range }, select employeeId, siteId)` | hasHours (версии) |
| 4 | `timesheetDraftSegment.findMany({ draftId in draftIds, [siteId in siteIds], date in range }, select draftId, siteId)` | hasHours (черновики) |
| 5 | `siteAssignment.findMany({ [siteId in siteIds], validFrom<=dateTo, OR validTo null/>=dateFrom }, select employeeId, siteId)` | assigned |
| 6 | `employee.findMany({ id in <union> }, select id, firstName, lastName, employeeNumber)` | имена |
| 7 | `workSite.findMany` — уже загружен на странице; повторно не запрашивается |

7 set-based запросов, без N+1, всё `select` минимальный. Порядок сортировки: `lastName, firstName`.

## 4. Состояние и URL (ТЗ §6, §8)

**URL — источник истины.** Явные режимы, без «пусто = все».

| param | значения |
|---|---|
| `dateFrom`, `dateTo` | `YYYY-MM-DD` (как сейчас) |
| `customer`, `projectReference` | текст (как сейчас) |
| `sites` | `all` — режим «Все объекты»; отсутствует → режим PICK |
| `siteIds` | повторяющийся UUID; действует только в PICK |
| `workers` | `all` — «Все работники выбранных объектов»; отсутствует → PICK |
| `workerIds` | повторяющийся UUID; действует только в PICK |
| `wx` | повторяющийся UUID; исключения при `workers=all` (начальник вручную снял галочку) |

**Незаданный scope ≠ вся компания.** Если ни `sites=all`, ни `siteIds` — кнопка «Показать и
проверить» заблокирована с подсказкой «Выберите объекты или режим „Все объекты“». То же для
работников.

### Сериализация в существующий backend (ТЗ §6, §9 — API не меняем)

Экспорт/preview вызывается со **старыми** параметрами (`siteIds`, `employeeIds`; отсутствие = «все»):

| режим объектов | режим работников | → export API |
|---|---|---|
| ALL | ALL_IN_SCOPE | `siteIds` опущен, `employeeIds` опущен → backend «все/все» |
| PICK | ALL_IN_SCOPE | `siteIds=<…>`, `employeeIds` опущен → backend сам берёт всех работников с часами на этих объектах (сегментный отчёт) |
| ALL / PICK | PICK | `[siteIds=<…>]`, `employeeIds=<выбранные>` |
| ALL / PICK | ALL_IN_SCOPE минус `wx` | `[siteIds=<…>]`, `employeeIds=<scope-список минус wx>` (клиент разворачивает из уже загруженного scope; URL остаётся коротким — `workers=all&wx=…`) |

Так **URL никогда не несёт сотни ID** (ТЗ §8): «все» — это `sites=all` / `workers=all`, ручной
выбор ограничен тем, что человек кликнул; «все минус N» — короткий `wx`.

**Идентичность отчёта (ТЗ §10 п.16):** при одном и том же фактическом scope сериализация даёт те же
`siteIds`/`employeeIds` (или их отсутствие), что и сейчал → `getCustomTimeReport` получает
идентичный вход → отчёт/PDF/CSV байт-в-байт те же. `_test-customer-hours.ts` не трогается и
остаётся зелёным.

## 5. Компоненты

- **`components/reports/ScopePickerPanel.tsx`** — переиспользуемая панель: заголовок, счётчик
  «Выбрано …: N», поиск, кнопки «Выбрать все / Снять выбор», список с внутренней прокруткой
  (`max-height` + `overflow-y:auto`), пагинация по 20, строка = `<label>` с `<input type=checkbox>`
  + текст; клик по строке или чекбоксу переключает; выбранная строка — галочка + фон + рамка
  (`.scope-row.is-selected`); `role="group"` + `aria-label`, каждый чекбокс с настоящим `<label>`,
  focus-visible, стрелки/Space/Enter работают нативно (обычные чекбоксы в списке). **Никаких
  крестиков** — только `☐` / `☑`.
- **`CustomerHoursForm.tsx`** — переписан: даты + customer/project (как есть) → `ScopePickerPanel`
  объектов → (если scope готов) `ScopePickerPanel` работников → блок резюме → кнопка → результат.
  Владеет рабочим состоянием, синхронизирует URL (`router.replace`, `scroll:false`), при смене
  объектов/дат вызывает `/scope` (debounce 250 мс), обновляет список, **снимает выбор с работников
  вне нового scope** и показывает уведомление «Снято N работников, которые не относятся к выбранным
  объектам» (ТЗ §5).
- **`app/api/admin/reports/customer/scope/route.ts`** — `GET ?siteMode&siteIds&dateFrom&dateTo`
  → `{ workers: [...] }`. Те же 4 permission'а, что и export. Read-only, `Cache-Control: private,
  no-store`.
- **`app/admin/reports/customer/page.tsx`** — читает `searchParams`, парсит scope, при готовых
  датах+объектах резолвит `resolveCustomerScopeWorkers` server-side (нет мелькания при первом
  рендере и при reload), передаёт `initialScopeWorkers` в форму.
- **`lib/reporting/customer-report-scope.ts`** — `parseCustomerReportScope(params)` (общий парсер
  URL, лоялен к мусору) + `serializeScopeToExportParams(scope)` + `resolveCustomerScopeWorkers(...)`.

## 6. Резюме выбора (ТЗ §7)

Перед кнопкой:
```
Объекты: Meyer Turku Shipyard                 (1 объект → имя)
Объекты: выбрано 3                             (>1 → счётчик)
Объекты: все                                   (режим ALL)
Работники: выбрано 18 из 24                    (PICK или ALL-минус-wx, из scope)
Работники: все работники выбранных объектов    (ALL_IN_SCOPE без wx)
```

## 7. Доступность и адаптив (ТЗ §2, §4, §14, §15)

- Каждый чекбокс — настоящий `<input type="checkbox" id>` + `<label for>`; клик по всей строке =
  клик по чекбоксу (label оборачивает всё).
- `role="group"` + `aria-label` на списке; счётчик — `aria-live="polite"`.
- Tab по: поиск → «Выбрать все» → «Снять выбор» → чекбоксы → пагинация. focus-visible везде.
- Список: `max-height: 320px; overflow-y: auto` — своя прокрутка, страница не растягивается.
- Mobile 390px: панели в один столбец, строки в полную ширину, без horizontal overflow
  (`.scope-panel` внутри `.worker-card` — уже `max-width` + `overflow-x` guard R09.6).

## 8. Тесты (ТЗ §10)

| # | сценарий | где |
|---|---|---|
| 1–4, 8 | scope-резолвер: один объект → его работники; несколько → объединение без дублей; работник на неск. объектах — один раз; исторический работник с часами не исчезает; смена объекта убирает вне-scope | `_test-customer-report-scope.ts` (db) |
| — | сериализация scope → export params (все 5 строк таблицы §4) | там же |
| 5–7, 9–15, 17 | UI: «выбрать всех объекта», снять одного после массового выбора, повторный клик снимает, поиск (имя/номер/объект), 25+ объектов и 50+ работников по 20 на страницу, «Выбрать всех» = все страницы, reload + Back/Forward, RU/EN, keyboard/focus/labels, mobile 390 + desktop без overflow, нет console errors | `_test-customer-report-scope-ui.ts` (browser, изолированный раннер) |
| 16, 18 | отчёт идентичен при одном scope; customer/PDF/CSV regression | `_test-customer-hours.ts` — **не изменяется**, остаётся зелёным |

## 9. Что НЕ меняется

`lib/reporting/customer-hours.ts`, `custom-time-report.ts`, `customer-hours-pdf.ts`,
`customer-hours-csv.ts`, `app/api/admin/reports/customer/export/route.ts`, `prisma/schema.prisma`,
любые permissions, canonical worked-time, округление, readiness-уровни, статусы табелей.
`/admin/reports/custom` (тот же старый `<select multiple>`) в этой задаче **не трогается** — ТЗ про
`/admin/reports/customer`.
