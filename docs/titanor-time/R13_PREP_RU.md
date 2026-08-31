# R13 — подготовка и evidence package

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R13; ТЗ §20/§22.
- **Дата:** 2026-08-31.
- **Текущий hotfix-кандидат:** `titanor-time-app:r13-hotfix-1416503`
  (image ID `sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb`).
  Предыдущий R12-кандидат `367420e` заменён и не может идти в R14.
- **Статус:** автоматизированная device/role acceptance и повтор R12 на hotfix `1416503`
  пройдены; полный отчёт — `R13_AUTOMATED_ACCEPTANCE_RU.md`. Осталась короткая
  owner-часть acceptance + R13 checkpoint.
  **Production cutover / R14 / maintenance window — не начаты и не подтверждены.**

---

## 1. Зафиксированные решения владельца (2026-08-31)

| # | решение |
|---|---|
| 1 | **FI-ссылка входа:** `login` FI = «Työntekijän kirjautuminen», EN = «Employee login» |
| 2 | **Production web bind:** только `127.0.0.1:3199` (за Caddy) |
| 3 | **`ufw`:** пока только read-only проверить; **внешний порт 3199 открывать нельзя** |
| 4 | **После restore перед запуском scheduler:** обязательно `DELETE FROM "SchedulerLease"` |
| 5 | **`docker builder prune`:** пока НЕ выполнять — сначала read-only `du` + план (§5) |

## 2. Актуальные pilot-ссылки

| | URL |
|---|---|
| внешняя (Caddy, grey-cloud) | `https://t97-dd686bc3d4.84.247.130.242.nip.io` |
| логин | `https://t97-dd686bc3d4.84.247.130.242.nip.io/login` |
| локально (SSH-туннель / на хосте) | `http://127.0.0.1:3297` |
| health / ready | `…/api/health` · `…/api/ready` (тело `schema:current`, applied=expected=98) |

**Это пилот, не production.** `app.titanorgroup.fi` пока отдаёт 503 holding (R14). Тестовые
действия оставляют данные в pilot DB — это нормально для acceptance.

## 3. Тестовые аккаунты для R13 (на пилоте)

Созданы 2026-08-31 с префиксом `r13-`, все `ACTIVE`, locale EN. **Пароли — в приватном чате
владельцу, не в Git и не в отчётах.** Логины (вход проверен, 200, роли корректны):

| роль | username | привязка |
|---|---|---|
| SUPER_ADMIN | `r13-super` | — |
| ADMIN | `r13-admin` | — |
| WORKER | `r13-worker` | Employee `R13-…`, Employment active, SiteAssignment (primary) → **Meyer Turku Shipyard** |
| FOREMAN | `r13-foreman` | ForemanAssignment → **Meyer Turku Shipyard** |

Убрать после R13: удалить всех `User where username like 'r13-%'` + их Employee/Employment/
SiteAssignment/ForemanAssignment (одноразовый скрипт не коммитился).

## 4. Owner-checklist R13 (коротко)

**A. Авторизация (desktop, ~10 мин)** — вход каждой ролью, проверка лендинга:

| # | шаг | ожидание |
|---|---|---|
| A1 | `r13-super` вход по username | `/admin` (Today), не `/admin/setup` |
| A2 | `r13-admin` вход | `/admin`, видит только разрешённое |
| A3 | `r13-foreman` вход | `/foreman`, свои объекты; открыть `/admin/users` → «нет доступа» (человеческий текст, не 500, не редирект) |
| A4 | `r13-worker` вход | `/worker` (экран учёта), никакой админки |
| A5 | неверный пароль ×6 для `r13-admin` | после ~5 попыток «слишком много попыток» (429) |
| A6 | сменить пароль `r13-admin` в кабинете, затем «выйти со всех устройств» | текущая сессия по правилам; старые сессии больше не открывают приложение |

**B. WORKER на телефоне (iPhone/Safari + Android/Chrome)** — `r13-worker`:

| # | шаг | ожидание |
|---|---|---|
| B1 | установить PWA («на экран Домой»), открыть с иконки | открывается сразу на экране учёта, без адресной строки |
| B2 | Check In с GPS | смена открыта, таймер идёт |
| B3 | Check In с выключенным GPS | не блокирует, отметка «GPS не подтверждён», понятный текст |
| B4 | Check In вне геозоны (хороший GPS) | недискардируемая модалка, Check In всё равно возможен |
| B5 | Check Out | смена закрыта |
| B6 | режим полёта → Check In/Out → вернуть сеть | действие в очередь (pending N), синхронизируется само |
| B7 | полностью закрыть приложение офлайн → открыть офлайн | кэш-оболочка экрана учёта, **на английском** (locale аккаунта — EN; проверка фикса `ef5548b`) |
| B8 | офлайн открыть `/worker/periods`, период, часы | кэш-снимок + плашка «Offline — read-only» + время снимка |
| B9 | горизонтальный скролл | нет нигде |

**C. FOREMAN (планшет/телефон)** — `r13-foreman`:

| # | шаг | ожидание |
|---|---|---|
| C1 | `/foreman` — список работников | только Meyer Turku Shipyard |
| C2 | открыть отчёт/работника чужого объекта по прямой ссылке | 404 / «нет доступа», без утечки |
| C3 | навигация на телефоне | ⚠️ FOREMAN UI вне scope R09 — переполнение ряда ссылок = известный backlog, не блокер |

**D. ADMIN / SUPER_ADMIN (desktop + телефон)** — `r13-admin` / `r13-super`:

| # | шаг | ожидание |
|---|---|---|
| D1 | `/admin` Today | цифры соответствуют реальности, карточки кликабельны |
| D2 | `/admin/users` — поиск, фильтры роль/статус, страницы | работает, значения в URL |
| D3 | `/admin/workforce` — фильтры EXPIRED/CRITICAL/EXPIRING_SOON/MISSING | работают |
| D4 | создать работника | открывается карточка нового работника (не `/admin/setup`) |
| D5 | ревью табеля: вернуть → исправить → одобрить | цепочка проходит; отчёты сходятся |
| D6 | отчёты worker/site/period на экране + PDF-экспорт + CSV-экспорт периода | цифры верные; PDF на английском (by design); CSV — иммутабельные батчи |
| D7 | открыть страницу без права | короткий человеческий текст + «спросите SUPER_ADMIN», без permission-кода |
| D8 | узкое окно / телефон: `/admin` шапка и таблицы | нет горизонтального скролла страницы; таблицы скроллятся внутри себя |
| D9 | admin-recovery: выдать одноразовый код `r13-worker`, войти по нему | код работает один раз |

**E. Инфраструктура (на пилоте, ~5 мин):**

| # | шаг | ожидание |
|---|---|---|
| E1 | `GET /api/health` и `/api/ready` | оба 200; `/api/ready` тело `schema:current`, applied=expected=98 |
| E2 | подождать 3–5 мин, логи `t97-pilot-scheduler` | несколько успешных тиков, `lastOutcome:ok`, `consecutiveFailures:0` |
| E3 | `docker restart t97-pilot-app` | через ~1 мин снова healthy, `/api/ready` 200 |
| E4 | заголовки безопасности на `/login` | nosniff, X-Frame, HSTS, X-Robots noindex, Permissions-Policy; нет X-Powered-By |

**Оформление:** ☑ / ✗ + короткая заметка. P0/P1 → фиксируется отдельным hotfix-кандидатом с
повтором затронутых тестов и **пересборкой candidate image** (после этого R12 rehearsal повторить).
P2 → backlog, релиз не блокирует.

## 5. Docker: read-only состояние + безопасный план очистки

**`docker builder du` (2026-08-31):** Total **67.5 GB**, Reclaimable **~45 GB** (61 активных
слоёв ≈ 22.5 GB держит кэш последней сборки). `docker system df`: images 28.4 GB (7.2 GB
reclaimable), build cache 67.5 GB (45 GB reclaimable). Диск `/` — **83 %** (26 GB свободно).
Dangling images — **0**.

**Образы, которые НЕЛЬЗЯ трогать (используются):**
`titanor-time-app:t97-pilot-edd950c` (пилот + rollback-таргет), `titanor-time-app:latest`
(старый prod `titanor-time-app-1`), `titanorgroup-web:site-3321c09` (публичный сайт),
`titanor-time-app:r12-candidate-367420e` (R12-кандидат), `collab-studio-app`, `ardor-*:local`,
`postgres:16*`.

**Безопасный план (НЕ выполнен — на подтверждение владельца):**

1. **Старые t97-pilot build-образы** (все НЕ используются — пилот на `edd950c`, кандидат
   `367420e`), освобождает ~18 GB:
   ```bash
   docker image rm \
     titanor-time-app:t97-pilot-{1e4dc92,22e8b12,26fac53,43e2d26,4d24469,6ab1e12,b840ad5,d15586c,f486977} \
     titanor-time-app:t97-pilot-{256565a,6a47ed3,8724480}
   ```
   (сохраняем `edd950c` и `367420e`.)
2. **Прочее не используемое** (~2 GB, подтвердить): `collab-stage3-rollback-app:latest`
   (8 недель), `deploy-web:latest`, `hello-world:latest`, `alpine:3.20`.
3. **Старые rollback-контейнеры** `t97-pilot-*-pre-*` кроме `-pre-edd950c` (из `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §6).
4. **`docker builder prune -f`** — освобождает ~45 GB. **Владелец отложил.** Безопасно (build
   cache не уникален; следующая сборка просто будет дольше). Выполнять последним, когда владелец
   готов.

Без шага 4: ~20 GB. С шагом 4: ~65 GB.

## 6. Evidence package для R13 (ТЗ §20 Шаг 10 / roadmap R13)

| пункт | значение |
|---|---|
| Git SHA / release tag | hotfix HEAD `1416503`; предыдущий R12-кандидат `367420e` более не финальный |
| image tag / ID | `titanor-time-app:r13-hotfix-1416503` · `sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb` |
| migration count / status | 98 applied, 0 unfinished/rolled-back; schema current (fresh + restored pilot) |
| baseline / final row-count manifests | `docs/titanor-time/baseline-r12/pilot-snapshot-manifest.txt` — 1727 rows, `all_data_sha256 907d3219…` |
| backup paths / sizes / checksums | snapshot `pilot-20260831T121948Z-manual` (db.dump 492 469 б, SHA256SUMS OK); финальный — на R14 шаг 7 |
| restore / rehearsal evidence | hotfix `1416503`: fresh-pilot restore-smoke 14/14 + live rehearsal 10/10 + rollback PASS (`R13_AUTOMATED_ACCEPTANCE_RU.md` §6) |
| test / acceptance / dependency reports | `R13_AUTOMATED_ACCEPTANCE_RU.md` (16/16 browser files), `R10_PILOT_ACCEPTANCE_REPORT_RU.md` (80/80 unit+db+sched, restore 13/13, 0 CVE), этот checklist §4 |
| точное maintenance window | **не подтверждено владельцем** (roadmap R13 п.2) |
| ожидаемый downtime | ~1–2 мин реального простоя, окно 10 мин (`R12_REHEARSAL_RU.md` §5) |
| DNS status | `app.titanorgroup.fi` → `84.247.130.242` (DNS only), TLS Let's Encrypt до 2026-11-29, 503 holding |
| пошаговый cutover / rollback | `R12_REHEARSAL_RU.md` §4 (19 шагов) / §5 |
| остаточные риски | old prod БД «неважна» но backup обязателен (R14 шаг 5); FOREMAN UI backlog; orange-cloud (Вариант B) отложен |
| что увидит пользователь после первого входа | существующий пароль работает; старые сессии отозваны → повторный вход; RU/EN по `User.locale`; экран учёта / `/admin` по роли |

## 7. Три подтверждения владельца (roadmap R13, отдельно каждое)

1. **Pilot acceptance** — после owner-checklist §4 без открытых P0/P1.
2. **Maintenance window** — конкретные дата/время.
3. **Production cutover** — явное разрешение начать R14.

Молчание или общее «продолжай» подтверждением разрушительной замены БД **не считается**.
