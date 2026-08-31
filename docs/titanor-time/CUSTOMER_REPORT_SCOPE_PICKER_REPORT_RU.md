# Отчёт — выбор объектов и работников в отчёте заказчика

- **Задача:** улучшить выбор объектов/работников на `/admin/reports/customer`.
- **Design note:** `CUSTOMER_REPORT_SCOPE_PICKER_RU.md` (написан до реализации).
- **Дата:** 2026-08-31.
- **Изолированная работа.** Production, Caddy, DNS, production-БД, rollback-контейнеры — **не
  затронуты** (см. §8). **Не задеплоено.** Ждёт просмотра владельцем и отдельного разрешения.

---

## 1. Что сделано (по ТЗ)

| ТЗ | реализовано |
|---|---|
| §1 порядок фильтров | даты → **панель «Объекты»** → **панель «Работники выбранных объектов»** → **резюме выбора** → **«Показать и проверить»** → результат |
| §2 выбор объектов | нативный `<select multiple>` **удалён**. Панель: поиск по названию, 20/страница + внутренняя прокрутка, строка = `☐/☑` + название, клик по строке или чекбоксу переключает, повторный клик снимает, выбранная строка — галочка + фон + рамка (`.scope-row.is-selected`), «Выбрать все / Снять выбор», счётчик «Выбрано объектов: N» (`aria-live`), клавиатура/focus/`<label for>`. Никаких крестиков. |
| §3 список работников объекта | новый `resolveCustomerScopeWorkers` — работник в списке, если за диапазон: назначение на объект **пересекает** диапазон (`validFrom<=dateTo && (validTo IS NULL || validTo>=dateFrom)`) **или** есть canonical-сегмент (`WorkSegment` canonical-версии / `TimesheetDraftSegment`) на объекте в диапазоне. Исторические часы не скрываются (`hasHours` не смотрит на `validTo`). Строка: `Фамилия Имя` · `#табельный` · объект(ы) · метка «есть часы за период» / «назначен на объект». Один работник — одна строка, объекты перечислены рядом. |
| §4 выбор работников | поиск по имени/фамилии/табельному, 20/страница + прокрутка, чекбоксы, клик по строке, повторный клик снимает, выбранная строка выделена, счётчик «Выбрано работников: N из M», «Выбрать всех работников объекта „…"» (1 объект) / «…выбранных объектов» (>1), «Снять выбор со всех». **«Выбрать всех» выбирает все страницы**, не только видимые 20. После массового выбора можно снять галочку с отдельных. |
| §5 смена объектов | при изменении объектов список работников пере-запрашивается (`/api/admin/reports/customer/scope`, debounce 250 мс); работники вне нового scope **снимаются**; показывается уведомление «Снято N работников, которые не относятся к выбранным объектам» (`role="status"`). Скрытых выбранных работников вне списка нет — `wx`-множество исключений тримится к актуальному scope. |
| §6 явная семантика «все» | правило «пусто = все» **убрано**. Явные режимы: радио «Выбрать объекты» / «Все объекты»; для работников — «Выбрать всех…» = режим ALL. Пустой выбор → кнопка «Показать и проверить» заблокирована с подсказкой. **Совместимость backend сохранена** (см. §3 отчёта). |
| §7 резюме выбора | перед кнопкой: `Объекты: <имя>` (1) / `выбрано N` (>1) / `все`; `Работники: все работники выбранных объектов` / `выбрано N из M`. |
| §8 URL и состояние | URL — источник истины: `dateFrom/dateTo/customer/projectReference`, `sites=all` **или** `siteIds=…`, `workers=all` (+ `wx=…` для ручных снятий) **или** `workerIds=…`. `router.replace` (debounce 400 мс, `scroll:false`). Reload / Back-Forward / ссылка воспроизводят выбор. «Все» = `sites=all` / `workers=all` — **сотни ID в URL не попадают**. |
| §9 расчёты не меняются | `lib/reporting/customer-hours.ts`, `custom-time-report.ts`, `customer-hours-{pdf,csv}.ts`, `app/api/admin/reports/customer/export/route.ts`, `prisma/schema.prisma`, permissions — **не тронуты**. `_test-customer-hours.ts` не изменён, зелёный. |
| §10 тесты | см. §5 отчёта |
| §11 результат | этот файл |

## 2. Список изменённых / новых файлов

**Новые:**
- `titanor-time-app/lib/reporting/customer-report-scope.ts` — `parseCustomerReportScope`,
  `serializeScopeToExportParams`, `resolveCustomerScopeWorkers` (read-only, 6 set-based запросов).
- `titanor-time-app/app/api/admin/reports/customer/scope/route.ts` — `GET` JSON-эндпоинт scope
  (те же 4 permission'а, read-only, `no-store`).
- `titanor-time-app/components/reports/ScopePickerPanel.tsx` — переиспользуемая панель
  поиск/пагинация/чекбоксы (используется для объектов и работников).
- `titanor-time-app/scripts/_test-customer-report-scope.ts` — db-lane.
- `titanor-time-app/scripts/_test-customer-report-scope-ui.ts` — browser-lane (Chromium).
- `docs/titanor-time/CUSTOMER_REPORT_SCOPE_PICKER_RU.md` — design note.
- `docs/titanor-time/CUSTOMER_REPORT_SCOPE_PICKER_REPORT_RU.md` — этот отчёт.
- `docs/titanor-time/baseline-customer-scope/{desktop-1440,mobile-390}.png` — скриншоты.

**Изменённые:**
- `titanor-time-app/app/admin/reports/customer/page.tsx` — читает `searchParams`, парсит scope,
  грузит все объекты; список работников грузит клиент из `/scope`.
- `titanor-time-app/app/admin/reports/customer/CustomerHoursForm.tsx` — переписан на новый поток;
  владеет состоянием, синхронизирует URL, пере-запрашивает scope, снимает вне-scope работников.
- `titanor-time-app/app/globals.css` — `.scope-*` (панель, строки, пагинация, уведомление, резюме),
  `.ov-filter-actions { flex-wrap: wrap }`.
- `titanor-time-app/scripts/test-manifest.json` — 2 записи.

## 3. Модель «объект → работники» и совместимость backend

Отчёт заказчика и `resolveCustomerReadiness` **сегментные** — работник, сменивший объект, всё равно
показывает исторические часы (`lib/reporting/customer-hours.ts:10`). Список-кандидат — **надмножество**:
показывает и назначенных без часов, и тех, у кого есть часы. При «Показать и проверить» выбор
сериализуется обратно в **существующие** параметры export API (`siteIds` / `employeeIds`; их
отсутствие = «все»):

| режим | → export API | результат |
|---|---|---|
| Все объекты + Все работники | `siteIds` и `employeeIds` опущены | backend «все/все» — байт-в-байт как раньше |
| Объекты PICK + Все работники | `siteIds=…`, `employeeIds` опущен | backend сам берёт всех с часами на этих объектах (сегментный отчёт) |
| любой + PICK работники | `[siteIds=…]`, `employeeIds=<выбранные>` | ручной подмножество |
| любой + Все минус N | `[siteIds=…]`, `employeeIds=<scope − wx>` (клиент разворачивает из уже загруженного scope) | URL остаётся коротким (`workers=all&wx=…`) |

**Из-за FK + триггеров** (`WorkSegment.sourceAssignmentId` + `ck_...` на окно назначения) любой
`WorkSegment` за дату D всегда имеет назначение, покрывающее D → `hasHours ⇒ assigned` для того же
объекта. «Historical» кейс (§10 п.4) = назначение закончилось внутри/в конце диапазона, а часы
остались: правило пересечения оставляет работника (наивный фильтр «назначение активно на `dateTo`»
— выкинул бы).

## 4. Запросы (bounded, read-only)

`resolveCustomerScopeWorkers`: `payrollPeriod` → `timesheet` (+ `resolveCanonicalSource`, pure) →
параллельно [`workSegment` distinct(version,site) · `timesheetDraftSegment` distinct(draft,site) ·
`siteAssignment` distinct(employee,site)] → `employee`. **6 запросов**, не зависит от числа
работников/объектов, все `select`-узкие. `/scope` эндпоинт вызывает только её. Экспорт/preview —
без изменений.

## 5. Результаты тестов

| проверка | результат |
|---|---|
| `npm run typecheck` | ✅ 0 |
| `npm run lint` | ✅ (prisma validate, schema-format, **manifest sync**, migration-inventory, runtime-bundle, secret-scan) |
| `npm run build` | ✅ Compiled successfully (`/api/admin/reports/customer/scope` зарегистрирован) |
| **db-lane** (полный, disposable PG16) | ✅ **64/64**, 0 fail — включая `_test-customer-report-scope.ts` **25/0** и `_test-customer-hours.ts` **11/0** (регрессия §10 п.16/18, файл не изменён) |
| **browser-lane** `_test-customer-report-scope-ui.ts` (Chromium, standalone-сервер + свежая disposable БД, 28 объектов + 55 работников поверх buildFixture) | ✅ **30/0** — ТЗ §10 п. 5,6,7,9,10,11,12,13,14,15,16,17; desktop-1440 + mobile-390 скриншоты |

**Покрытие ТЗ §10:**
1–4, 8 (модель scope) — `_test-customer-report-scope.ts` (db): один объект → его работники;
несколько → объединение без дублей; работник на неск. объектах — один раз с обоими объектами;
историч. работник с часами не исчезает; смена объекта меняет набор; + сериализация (все 5 строк
таблицы §3). 5–7, 9–15, 17 — `_test-customer-report-scope-ui.ts` (browser). 16, 18 — `_test-customer-hours.ts`
(не изменён) + browser-проверка «ALL/ALL == legacy no-params».

Скриншоты: `docs/titanor-time/baseline-customer-scope/desktop-1440.png`, `mobile-390.png`.

## 6. Объяснение UX для начальника

1. Выбираю диапазон дат.
2. Панель **«Объекты»**: ищу и отмечаю объекты (или «Все объекты»). Видно «Выбрано объектов: N».
3. Появляется панель **«Работники выбранных объектов»** — только те, кто за период назначен на эти
   объекты или отработал на них часы. Отмечаю всех («Выбрать всех работников объекта „…"») или
   отдельных. Видно «Выбрано работников: N из M».
4. Если меняю объекты — список работников пересчитывается, лишние снимаются, показывается «Снято N…».
5. **Резюме** перед кнопкой показывает итог. **«Показать и проверить»** — предпросмотр готовности +
   итогов; кнопки скачивания PDF/CSV (финал — только если все табели окончательно одобрены).
6. Ссылку на этот выбор можно скинуть/сохранить — URL всё помнит.

## 7. `git`

Commit `<sha>` — `feat(time): scope picker for the customer hours report (/admin/reports/customer)`.
Рабочее дерево чистое после коммита. Ветка `feature/titanor-time-foundation`.

## 8. Подтверждение изоляции

- **Production** (`titanor-time-prod-{app,scheduler,db}`, образ `r14-release-1416503`) — **не
  трогался**: контейнеры, образ, БД, `app.titanorgroup.fi` без изменений.
- **Caddy / DNS** — не трогались.
- **production-БД** — не трогалась. Вся работа: ветка + локальные disposable PostgreSQL 16
  (контейнер `r02-testdb`, порт 55440) + временный standalone-сервер на `127.0.0.1:39917`,
  снесённые после прогонов.
- **rollback-контейнеры** (`titanor-time-app-1`, `titanor-time-db-1`, `t97-pilot-*`) — не трогались.
- **Не задеплоено.** Ни одной миграции (schema не менялась). Образ не пересобирался под prod/pilot-тег.
