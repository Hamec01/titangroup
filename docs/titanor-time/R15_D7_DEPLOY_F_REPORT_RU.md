# R15-D7 — Deploy F («Часы заказчику»): отчёт

**Статус:** ✅ **РАЗВЁРНУТО НА PRODUCTION 2026-09-03 ~19:34 UTC** — образ `titanor-time-app:d7f-d216482`,
**без миграции**, схема 100, простой **≈ 2.6 c** (со 2-й попытки — 1-я оборвалась на баге скрипта и
авто-откатилась, ~11.5 c, потерь нет; см. §3.1). Разрешение владельца — 2026-09-03. Итог — §6.
Deploy F закрывает R15-D7 (A→F).

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

### 2.1 Follow-up review (до production, 2026-09-03)

- `resolveCustomerReadiness` больше **не ограничивает** `WorkSegment` / `TimesheetDraftSegment` первыми 200 строками. Иначе сильно фрагментированный табель мог скрыть сегмент выбранного заказчика и неверно разрешить FINAL export. Регрессия создаёт 200 чужих сегментов перед сегментом выбранного заказчика и доказывает блокировку.
- `deploy-f-swap.sh` / `deploy-f-rollback.sh` переведены на fail-fast: неготовность за 40 секунд теперь даёт ненулевой exit; swap автоматически восстанавливает сохранённый `d7e-5cce319`, а failed d7f оставляет для диагностики. Эти правки требуют пересборки финального образа под новый commit; `d7f-18c2091` не является кандидатом к выкладке после данного review.

---

## 3. Disposable-проверка

Всё гоняется на disposable PG16 + одноразовых app-контейнерах из релизного образа
(`ops/titanor-time/run-browser-acceptance.sh` — на тест своя чистая клон-БД). Production не
затронут. Прогон 2026-09-03.

**Финальный образ (кандидат к выкладке):** `titanor-time-app:d7f-d216482` — см. §3.1. Первичная
disposable-регрессия (таблица ниже) прошла на `d7f-3abf4ea` (== `d7f-f6922cf` по runtime); после
follow-up review (§2.1) ветка сдвинулась до `d216482` и образ пересобран как `d7f-d216482`, на
котором db lane (64/64, вкл. новый тест readiness) и `_test-customer-report-scope-ui` перепрогнаны
(§3.1). `d7f-18c2091` / `d7f-f6922cf` — **не** кандидаты к выкладке.

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

### 3.1 Production-выкладка — попытка 1 (провал + авто-откат) и повторная проверка

**Попытка 1 (2026-09-03 19:08Z, образ `d7f-18c2091`) — НЕ удалась, авто-откат сработал.**
`deploy-f-swap.sh` после review получил `set -euo pipefail`; из-за этого `code=$(curl … /api/ready)`
в цикле ожидания стал фатальным — новый контейнер ещё поднимался (~1–2 c), первый `curl` вышел с
кодом 56, `set -e` оборвал скрипт на 1-й итерации → сработал trap авто-восстановления. Хронология:
`docker stop` 19:08:58.2Z → старый контейнер вернулся 19:09:09.7Z → **простой ≈ 11.5 c** (Caddy
отдавал 503). Данные не затронуты (схему/БД не трогали), scheduler не заметил. `/api/ready` 200
`current 100/100` и локально, и через Caddy сразу после отката. Прод остался на `d7e-5cce319`.

**Исправление:** `code=$(curl … || true)` в цикле обоих скриптов (curl всё равно пишет `000` через
`-w` при ошибке); `set -e` для остальных шагов и trap сохранены.

**Ветка затем сдвинулась** до `d216482` (снят лимит `take:200` в `resolveCustomerReadiness` +
регрессионный тест — см. §2.1). `d7f-18c2091` устарел. Пересобран **`titanor-time-app:d7f-d216482`**
из `d216482` (runtime = HEAD `9e70e07`; `9e70e07` — только ops-скрипты, в образ не входят).

**Повторная disposable-проверка на `d216482`:**

| Проверка | Результат |
|---|---|
| db lane (вкл. новый тест readiness в `_test-customer-hours`) | ✅ **64/64** |
| `_test-customer-report-scope-ui` (browser) | ✅ PASS · 17/17 |
| backup `production-20260903T175352Z-pre-deploy` (on+off-box) + `restore-test` | ✅ **13/13** |
| кандидат `d7f-d216482` на `:3198` против **реальной prod-БД** | ✅ `/api/ready` 200 `current 100/100`, healthy, лог чистый; `/login` 200 · `/reset-password` 200 · `/admin/reports/customer` 307→login · scope API 401 · неверные креды 401 |

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

Скрипты: `ops/titanor-time/r15-d7/deploy-f-swap.sh` (с trap авто-отката) + `deploy-f-rollback.sh`.

Шаги (тот же паттерн, что A→E):
1. Образ `titanor-time-app:d7f-d216482` собран из `d216482` (`org.opencontainers.image.revision=d216482`;
   runtime = HEAD, ops-коммит `9e70e07` в образ не входит). Пересобрать под точный HEAD, если ветка
   сдвинется.
2. `backup-titanor-time.sh pre-deploy` + off-box копия + `restore-test` (13/13) — **свежий**, перед свапом.
   Готовый: `production-20260903T175352Z-pre-deploy`.
3. Кандидат на `127.0.0.1:3198` из `d7f-d216482` — **только read-only smoke**: `/api/ready` 200,
   `/admin/reports/customer` 307→login, `/login` 200, `/reset-password` 200, scope API 401. **Ни одного write.**
   (сделано 2026-09-03 — см. §3.1.)
4. Web-only swap: `bash ops/titanor-time/r15-d7/deploy-f-swap.sh` — `docker stop -t 30
   titanor-time-prod-app` → `docker rename … titanor-time-prod-app-pre-d216482` → `docker run` с
   идентичным конфигом (сеть `titanor-time-prod-net`, `-p 127.0.0.1:3199:3000`, uploads-bind, тот же
   `--env-file`, healthcheck 15s/5s/40s/×4, `--restart unless-stopped`) из `d7f-d216482`. При любом
   сбое / неготовности за 40 c скрипт сам возвращает `d7e-5cce319`.
5. Post-swap: `/api/ready` 200, `/admin/reports/customer` + `/reset-password` рендерятся, `schema 100/100`,
   0 ошибок в логах приложения и scheduler. **Read-only.**
6. Откат: `bash ops/titanor-time/r15-d7/deploy-f-rollback.sh` — контейнер `titanor-time-prod-app-pre-d216482`
   назад под именем `titanor-time-prod-app`. Rollback-образ = `d7e-5cce319` (Deploy E). Только revert
   образа, **без отката схемы** (миграции нет). Держать `-pre-d216482` контейнер + `pre-deploy` backup
   до owner sign-off всего R15-D7.

**Без миграции** (схема остаётся 100). scheduler / Caddy / DNS / пароли / публичный сайт / backup+gps
таймеры — не трогать. **Production write-smoke не выполняется** — отчёт доказан на disposable-базе.
Ожидаемый простой ~3–4 c.

---

## 5. Что НЕ входит
- Ничего — Deploy F закрывает R15-D7 (A→F).

---

## 6. Production deploy — выполнено 2026-09-03

**Разрешение владельца:** «Ок на d7f-d216482, делай swap. Больше коммитов не будет; деплой строго с
d216482. Разрешаю только web-only docker stop/rename/run для titanor-time-prod-app, без миграций,
scheduler/Caddy/DNS/БД не менять.»

### Хронология
| шаг | детали |
|---|---|
| Образ | `titanor-time-app:d7f-d216482` (`org.opencontainers.image.revision=d216482`; runtime = коммит `d216482`, ops-коммиты `9e70e07`/`defa11f` в образ не входят). |
| Backup | `production-20260903T175352Z-pre-deploy` (on+off-box), `restore-test` **13/13**. 2399 строк, 100 миграций. |
| Кандидат `:3198` | `d7f-d216482` против реальной prod-БД: `/api/ready` 200 `current 100/100`, healthy, лог чистый; `/login` 200, `/reset-password` 200, `/admin/reports/customer` 307, scope API 401. **Только read-only.** |
| **Попытка 1** | 19:08Z, образ `d7f-18c2091`. Оборвалась на баге `curl`-под-`set -e` в упрочнённом скрипте; EXIT-trap вернул `d7e-5cce319` (19:08:58→19:09:10Z, **~11.5 c** 503). Потерь нет. Причина исправлена в `d216482`, образ пересобран как `d7f-d216482`. |
| **Web-only swap (попытка 2)** | `bash ops/titanor-time/r15-d7/deploy-f-swap.sh`. T0 `docker stop -t 30` **19:34:00.875Z** → остановлен 19:34:01.492Z → `docker rename → titanor-time-prod-app-pre-d216482` → `docker run` новый (идентичная конфигурация) 19:34:02.360Z → **`/api/ready` 200 в 19:34:04.128Z**. **Простой ≈ 2.6 c.** |
| Health | `healthy` через ~45 c. |

### Пост-swap проверки — только read-only (live prod, через Caddy)
- `/api/ready` → **200 `current 100/100`** (локально и через Caddy);
- `/login` 200, `/reset-password` 200, `/worker` 307, `/admin` 307, `/admin/reports/customer` 307, `/admin/reports/sites` 307;
- `GET /api/admin/reports/customer/scope?action=search` без сессии → **401** (роут на месте, права требуются);
- неверные креды → `INVALID_CREDENTIALS` (чистый отказ, не 500);
- лог приложения после swap — **чистый** (только строки старта Next.js);
- scheduler (`r14-release-1416503`) — **не трогали**, тикает каждую минуту, `runnerOutcome: ok`, `failed: 0` (тик в 19:34:03Z во время свапа прошёл).
- **Никаких write на production не выполнялось.**

### Что НЕ менялось
Схема (100), БД, scheduler, Caddy, DNS, пароли, публичный сайт, backup+gps таймеры.

### Rollback
Контейнер **`titanor-time-prod-app-pre-d216482` (образ `d7e-5cce319`)** сохранён.
`bash ops/titanor-time/r15-d7/deploy-f-rollback.sh` — revert образа (~3 c), **без отката схемы**
(миграций не было). Backup `production-20260903T175352Z-pre-deploy` (on+off-box). Держать контейнер
+ backup до owner sign-off всего R15-D7.
