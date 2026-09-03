# R15-D7 — Deploy F («Часы заказчику»): отчёт

**Статус:** разработка + disposable-тесты завершены, всё зелёное (browser 9/9, db 64/64, unit 18/18,
typecheck/lint/build clean). **Production НЕ изменялся.** Ждёт отдельного разрешения владельца.
Deploy F — последний этап R15-D7 (A→F).

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

Всё гоняется на disposable PG16 + одноразовых app-контейнерах из релизного образа
(`ops/titanor-time/run-browser-acceptance.sh` — на тест своя чистая клон-БД). Production не
затронут. Прогон 2026-09-03.

**Финальный образ:** `titanor-time-app:d7f-f6922cf` (HEAD `f6922cf`, ветка `feature/titanor-time-foundation`,
`org.opencontainers.image.revision=f6922cf`, digest `sha256:f7c03ced74c2d9a8590126184cf235d86a1db349bce2920e062e6c90f43157ef`).
Browser/db/unit прогоны сделаны на `d7f-3abf4ea` — runtime-код идентичен `d7f-f6922cf` (единственная
разница `3abf4ea..f6922cf` — тест-файл `_test-customer-report-scope-ui.ts` + этот отчёт, ни то ни
другое не попадает в standalone-бандл). Boot / read-only smoke ниже — на самом `d7f-f6922cf`.

| Тест | Результат |
|---|---|
| `_test-customer-hours` (db, **переписан**, сценарии 1–5, 8–10) | ✅ PASS |
| `_test-customer-report-scope-ui` (browser, **переписан**, 1, 6, 7, 10 + ворота + RU/EN + URL) | ✅ PASS · 17/17 |
| `_test-custom-report-canonical` / `_test-customer-report-scope` (фикс Миграции 100) | ✅ PASS / PASS |
| `_test-custom-report-pdf-csv` (регрессия «custom report») | ✅ PASS |
| Deploy B/C/E: `_test-t9-worker-card-b` / `_test-t9-site-lifecycle` / `_test-t9-group-transfer` | ✅ 34/34 · 38/38 · 16/16 |
| `_test-t9-assignment-lifecycle` / `_test-t9-full-flow` / `_test-t9-setup-lifecycle` / `_test-t9-setup-ui` / `_test-t9-role-matrix` | ✅ 118/118 · 84/84 · 113/113 · 26/26 · 33/33 |
| browser lane (серийно, 9 тестов) | ✅ **9 pass / 0 fail** |
| db lane / unit lane | ✅ **64/64** · **18/18** |
| `npm run typecheck` / `npm run lint` / `next build` | ✅ clean / clean / clean (сборка образа прошла) |
| boot / read-only smoke на `d7f-f6922cf` | ✅ `/api/ready` 200 `schema:current 100/100 aheadBy 0` · `/reset-password` 200 · `/admin/reports/customer` 307→login (роут на месте) · `/login` 200 · 0 ошибок в логах приложения |
| восстановление пароля + QR | ✅ `_test-recovery-link` (unit) · `_test-account-recovery` + `_test-recovery-api` (db lane) зелёные; `/reset-password` рендерится на финальном образе. Комбинированный релиз их не теряет. |

Правки тестов после сборки образа (только тест-файл, app-код не менялся):
- `_test-customer-report-scope-ui.ts` — CSV качается in-page fetch'ем (cookie `tt_session` — `Secure`;
  Playwright `APIRequestContext` не шлёт `Secure`-cookie по `http://127.0.0.1`, а Chromium — шлёт);
  проверка суммы по `"9900"` (все поля CSV в кавычках); RU-локаль через `User.locale` (cookie
  `NEXT_LOCALE` — только для неаутентифицированных).

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

**Текущий prod-образ:** `d7e-5cce319` (Deploy E), контейнер `titanor-time-prod-app`, порт 3199, схема 100.

Шаги (тот же паттерн, что A→E):
1. Образ `titanor-time-app:d7f-f6922cf` уже собран (digest выше). При деплое — пересобрать под точный
   HEAD ветки на момент разрешения и сверить `org.opencontainers.image.revision`.
2. `backup-titanor-time.sh pre-deploy` + off-box копия + `restore-test` (ожидается 13/13).
3. Кандидат на `127.0.0.1:3198` из нового образа — **только read-only smoke**: `/api/ready` 200,
   `/admin/reports/customer` рендерит форму, `?action=search` отдаёт заказчиков,
   `?action=preview` для тест-диапазона (только чтение), `/reset-password` 200. **Ни одного write.**
4. Web-only swap: `docker stop -t 30 titanor-time-prod-app` → `docker rename titanor-time-prod-app
   titanor-time-prod-app-pre-f6922cf` → `docker run` с идентичным конфигом (сеть `titanor-time-prod-net`,
   `-p 127.0.0.1:3199:3000`, uploads-bind, тот же `--env-file`, healthcheck 15s/5s/40s/×4,
   `--restart unless-stopped`) из `d7f-f6922cf`.
5. Post-swap: `/api/ready` 200, `/admin/reports/customer` + `/reset-password` рендерятся, `schema 100/100`,
   0 ошибок в логах. **Read-only.**
6. Откат: `docker stop titanor-time-prod-app` → `docker rename titanor-time-prod-app-pre-f6922cf
   titanor-time-prod-app` → `docker start`. Rollback-образ = `d7e-5cce319` (Deploy E). Только revert
   образа, **без отката схемы** (миграции нет). Держать `-pre-f6922cf` контейнер + `pre-deploy` backup
   до owner sign-off всего R15-D7.

**Без миграции** (схема остаётся 100). scheduler / Caddy / DNS / пароли / публичный сайт / backup+gps
таймеры — не трогать. **Production write-smoke не выполняется** — отчёт доказан на disposable-базе.
Ожидаемый простой ~3–4 c.

---

## 5. Что НЕ входит
- Ничего — Deploy F закрывает R15-D7 (A→F).
