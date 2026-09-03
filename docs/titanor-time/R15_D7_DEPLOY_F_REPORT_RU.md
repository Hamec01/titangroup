# R15-D7 — Deploy F («Часы заказчику»): отчёт

**Статус:** разработка + disposable-тесты завершены. **Production не изменялся.** Ждёт отдельного
разрешения владельца. Deploy F — последний этап R15-D7.

Ветка `feature/titanor-time-foundation`. **Миграции нет** (`WorkArea` уже несёт `workAreaId` на
`WorkSegment` / `TimesheetDraftSegment` с Миграции 1). Схема остаётся **100**.

---

## 0. Устранённый дефект

Прежняя `/admin/reports/customer`: `customer` — свободный текст (только заголовок PDF), `scope` —
`siteIds`/`employeeIds`, `export` **не фильтровал сегменты по `workAreaId`**. На одном объекте
бывает несколько заказчиков (`WorkArea`) ⇒ **в документ одного заказчика попадали часы другого**.

Deploy F: отчёт **привязан к настоящим `WorkArea` id**, каждый сегмент фильтруется по `workAreaId`.

---

## 1. Что вошло (по `R15_D7_DEPLOY_F_SPEC_RU.md`)

| Требование | Как сделано |
|---|---|
| Даты «с»/«по» | `dateFrom`/`dateTo`, `YYYY-MM-DD`, ≤366 дней. |
| Настоящий заказчик (не свободный текст) | выбор `WorkArea` из БА. `GET …/scope?action=search&q=` — поиск по названию **заказчика и объекта**, строка `«Aros Marine — Meyer Turku Shipyard»`, активные **и отключённые**. Множественный выбор, повторный клик снимает, «Выбрать всех показанных» / «Снять выбор», выбранные — крупными зелёными чипами. |
| Внутренний «Без указанного заказчика» | `workAreaId IS NULL`, чек-бокс; **финальный клиентский PDF/CSV с ним сервер отклоняет** (`409 NO_CUSTOMER_NOT_EXPORTABLE`), внутренний предпросмотр работает. |
| Карточка по каждому заказчику | `Заказчик / Объект / Сейчас назначено N / Работали за период N / Всего часов X ч Y мин`. Несколько заказчиков → отдельная секция + итог каждой + общий итог. |
| Список работников (20/стр.) | галочка · ФИО · таб.№ · объект · заказчик · даты работы · часы за период · статус табеля. Поиск по имени/номеру/объекту/заказчику. «Выбрать всех». **Выбор сохраняется между страницами** (Set в state). Строка на пару (работник × заказчик). |
| Учитывает переведённых / уволенных | список = (назначены сейчас на выбранного заказчика) ∪ (есть сегменты этого заказчика в периоде). **Историческая принадлежность — по `workAreaId` самого сегмента**, не по сегодняшнему назначению. |
| Главный дефект — фильтр по `workAreaId` | `getCustomerTimeReport` фильтрует `WorkSegment` + `TimesheetDraftSegment` по `workAreaId` (в SQL `where`), бакет = `(employeeId, siteId, workAreaId, date)`, округление один раз на бакет (`computeDayWorkedMs` + `msToMinutes` — общий канонический код, без копии формулы). `resolveCustomerReadiness` — блокер только если у покрывающего табеля есть сегмент выбранного заказчика (**readiness строго внутри customer-scope**). Имя заказчика для PDF/CSV — **по id из БД, текст браузера игнорируется**. |
| Предпросмотр до скачивания | карточки + список работников + часы каждого + итоги + **список неутверждённых табелей со ссылками** `/admin/timesheets/:id`. Все суммы UI/preview/PDF/CSV совпадают до минуты. |
| PDF/CSV | заказчик · объект · период · ФИО+номера · часы каждого · итог по заказчику · общий итог · отметка `FINAL APPROVED` / `NOT FINAL — INTERNAL PREVIEW`. **Без зарплат, ставок, GPS, персональных документов, внутренних замечаний.** CSV: UTF-8 BOM, CRLF, formula-injection guard, `WORKER` / `CUSTOMER_TOTAL` / `GRAND_TOTAL` строки, минуты и десятичные часы. |
| Блокировка финального PDF | нет настоящего заказчика → `400 CUSTOMER_REQUIRED`; выбран «Без заказчика» → `409`; в customer-scope есть не-`FINAL_APPROVED` табель → `409 NOT_FINAL_APPROVED` (со списком). `mode=PREVIEW` всегда доступен. |
| RU/EN | через `localeText`. |
| Права | `worker.read.all` + `site.read.all` + `timesheet.read.all` + `export.read` (без изменений). |

---

## 2. Изменённые / новые файлы

**Новое:**
- `lib/reporting/customer-time-report.ts` — `getCustomerTimeReport` (per-customer sections + grand total).
- `lib/reporting/customer-workarea-picker.ts` — `searchCustomerWorkAreas`, URL-selection parse/serialize.

**Правки:**
- `lib/reporting/customer-hours.ts` — `resolveCustomerReadiness` scoped by `workAreaIds` + `includeNoCustomer`.
- `lib/reporting/customer-hours-csv.ts` / `customer-hours-pdf.ts` — переписаны под секции.
- `app/api/admin/reports/customer/scope/route.ts` — `action=search | preview`.
- `app/api/admin/reports/customer/export/route.ts` — `waIds` + `noCustomer` + все ворота финального экспорта.
- `app/admin/reports/customer/{page,CustomerHoursForm}.tsx` — переписаны.
- `docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md` — секция «R15-D7 Deploy F».
- `scripts/_test-customer-hours.ts` (db), `scripts/_test-customer-report-scope-ui.ts` (browser) — переписаны под Deploy F.
- `scripts/_test-custom-report-canonical.ts` + `_test-customer-report-scope.ts` — **фикстуры исправлены** под Миграцию 100 (worker не получает два пересекающихся `isPrimary` назначения; ограничение не отключается, ошибки не маскируются). Отдельный коммит `34ff631`.

**Оставлено как есть:** `lib/reporting/customer-report-scope.ts` + `_test-customer-report-scope.ts` — чистые функции ещё работают (тест, который просил починить владелец, зелёный); новый роут/форма их больше не используют, можно удалить позже.

---

## 3. Disposable-проверка

*(таблица дополняется после прогона; tsc + lint + `next build` — <в прогоне>)*

| Тест | Результат |
|---|---|
| `_test-customer-hours` (db, **переписан**, сценарии 1–5, 8–10) | _<в прогоне>_ |
| `_test-customer-report-scope-ui` (browser, **переписан**, 1, 6, 7, 10 + ворота + RU/EN + URL) | _<в прогоне>_ |
| `_test-custom-report-canonical` / `_test-customer-report-scope` (фикс) | _<в прогоне>_ |
| `_test-custom-report-pdf-csv` (регрессия «custom report») | _<в прогоне>_ |
| Deploy B/C/E: `_test-t9-worker-card-b` / `_test-t9-site-lifecycle` / `_test-t9-group-transfer` | _<в прогоне>_ |
| `_test-t9-assignment-lifecycle` / `_test-t9-full-flow` / `_test-t9-setup-lifecycle` / `_test-t9-setup-ui` / `_test-t9-role-matrix` | _<в прогоне>_ |
| db lane / unit lane | _<в прогоне>_ |
| восстановление пароля + QR (boot/read-only smoke) | _<в прогоне>_ |

### Обязательные сценарии (§8)
- **1** — один объект, два заказчика (Aros/Beta), разные работники: отчёт(Aros) содержит только работника A и только 450 мин; CSV(Aros) не содержит Beta и номер работника B.
- **2** — один работник, два заказчика в разные дни: 450 мин на Aros (один день), 450 на Beta (другой день), даты не совпадают.
- **3** — работник переведён (старое назначение снято `clockInDisabledAt`): в отчёте Aros он **остаётся** за отработанный день (450 мин, `workedInPeriod`), но **не** «назначен сейчас»; в отчёте Beta его Aros-часов нет.
- **4** — отключённый (`active=false`) заказчик: секция + 450 мин по-прежнему возвращаются, `customerActive=false`.
- **5** — не утверждённый табель блокирует финальный экспорт **только своего** заказчика: readiness(Ready) = `CUSTOMER_FINAL`, readiness(Pending) = `INTERNAL_PREVIEW_ONLY` (1 блокер), readiness(Ready+Pending) заблокирован.
- **8** — CSV `GRAND_TOTAL` = 900 мин / 15.00 ч, `grandTotal` = сумма секций до минуты, PDF строится.
- **9** — фильтрация по `workAreaId`; CSV одного заказчика не содержит имени/номеров/минут другого.
- **10** — `includeNoCustomer` помечает отчёт (`includesNoCustomer=true`), роут отклоняет финальный клиентский PDF/CSV.
- **6/7** (browser) — 22 работника Aros → 20/стр. + 2-я страница, выбор сохраняется между страницами; reload и Back/Forward сохраняют выборку; RU-локаль.

---

## 4. План production (после отдельного разрешения)

Web-only swap `d7e-5cce319` → `d7f-<sha>`, **без миграции** (схема 100). Standard verified backup +
restore-test; кандидат `:3198` **read-only** smoke; rollback-контейнер `titanor-time-prod-app-pre-<sha>`
(образ `d7e-5cce319`), откат = revert образа. scheduler / Caddy / DNS / пароли / публичный сайт —
не трогать. **Production write-smoke не выполняется** — отчёт доказан на disposable-базе. Ожидаемый
простой ~3–4 c.

---

## 5. Что НЕ входит
- Ничего — Deploy F закрывает R15-D7 (A→F).
