# Titanor Time — Implementation Status

Обновлено: 2026-07-28 16:34 Europe/Helsinki
Ветка: feature/titanor-time-foundation
Isolated PostgreSQL config commit: `c28af00521ffef322211e2cfae840a5568dc8c03`
Next.js app scaffold commit: этот commit (см. Git checkpoint)
Runtime-tested HEAD (полная повторная verification, full green): `991b8fb8381bff11accd09e2c1c3a3f7748d0832`
Source fix commit (CK-08/CK-13 rename): `991b8fb8381bff11accd09e2c1c3a3f7748d0832`
HEAD на момент первого runtime-теста, обнаружившего дефект: bebd6aab5f7a041e6272f24fe32db105ca04f92b
HEAD на момент предыдущего (статического) аудита: 30d2364ffe58679856d6a29d91c9992a941c2b65
Статус документа: living implementation record

## 1. Назначение документа

Этот файл фиксирует только доказанное состояние реализации Titanor Time — то, что реально
подтверждается файлами репозитория и историей Git на момент последнего аудита. Он не пересказывает
архитектурные документы и не дублирует roadmap. `TITANOR_TIME_DEVELOPMENT_ROADMAP.md` и
`docs/PROJECT_ROADMAP.md` описывают, что планируется сделать; этот файл описывает, что уже сделано.
Если запись здесь противоречит более свежему состоянию Git/файловой системы — доверять нужно Git и
файловой системе, а не этому документу, и обновить его отдельной задачей.

## 2. Текущий этап

Архитектурный комплект Titanor Time v5.4.1 (пять документов) и Prisma data-model foundation (24
модели, 8 enum) завершены и зафиксированы в Git. Frozen raw-SQL register (21 CHECK, 6 EXCLUDE, 11
функций, 13 триггеров, 1 extension) зафиксирован отдельным документом. На его основе создана и
статически проверена одна initial migration, объединяющая Prisma-generated структуру и raw-SQL
объекты register.

Existing initial migration с исправленными именами CK-08/CK-13 успешно применена, повторно
идемпотентно проверена и детерминированно runtime-верифицирована на чистом одноразовом PostgreSQL 16.
Подтверждены catalog identities и single-session поведенческие сценарии всех current CHECK, EXCLUDE
и triggers. Это не означает создание permanent dev/preview/production базы Titanor Time и не означает
production deployment.

История: первый runtime-аудит (HEAD `bebd6aa`) обнаружил, что два из 21 CHECK constraint (`CK-08`,
`CK-13`) имели имена длиннее 63 байт и PostgreSQL молча обрезал их при применении миграции — см. §7.
Отдельной задачей (commit `991b8fb`) оба имени были сокращены до ≤63 байт синхронно в
`05_RAW_SQL_REGISTER.md` и в единственной existing migration. Эта задача (тот же commit `991b8fb`
как проверяемый HEAD) провела полную повторную runtime-верификацию исправленной migration на новом
чистом одноразовом PostgreSQL 16 — см. §8. Результат: **full green** — structural + catalog identity
аудит подтвердил exact новые имена CK-08/CK-13 в `pg_constraint.conname`, отсутствие старых
(усечённых) имён, и все 21 CHECK / 6 EXCLUDE / 13 триггеров / 11 функций / 7 frozen identifiers прошли
позитивные и негативные поведенческие сценарии. Blocker CK-08/CK-13 закрыт: **resolved by source fix
`991b8fb` and confirmed by clean PostgreSQL 16 runtime verification** (см. §10).

После этого подготовлена (но не запущена) изолированная постоянная конфигурация PostgreSQL 16
(commit `c28af00`, `compose.titanor-time.yaml`) — отдельный Compose-проект `titanor-time`, отдельная
internal-network, отдельный named volume, без публикации database-порта, без CollabStudio. Никакая
постоянная база фактически не создана и не запущена; migration к ней не применялась.

Следующим шагом добавлен bare-каркас Titanor Time Next.js-приложения (`titanor-time-app/`) — App
Router, TypeScript, health endpoint, multi-stage Dockerfile (standalone output), подключён как
service `app` в `compose.titanor-time.yaml` (`127.0.0.1:3200`, только internal network). Каркас
типизируется (`tsc --noEmit`) и собирается (`next build`, `docker compose build`) без ошибок, но не
запускался ни разу — нет login, нет данных, нет реальных страниц/API кроме `/api/health`.
Production-код (seed, аутентификация, реальный API, UI) по-прежнему не начат.

## 3. Источники истины

| Область | Источник | Статус |
|---|---|---|
| Общая архитектура | `docs/titanor-time/README.md` | завершено, v5.4.1 |
| Карта экранов | `docs/titanor-time/01_SCREEN_MAP.md` | завершено, v5.4.1 |
| Роли и разрешения | `docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md` | завершено, v5.4.1 |
| Модель данных | `docs/titanor-time/03_DATA_MODEL_ERD.md` | завершено, v5.4.1 |
| API | `docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md` | завершено, v5.4.1 (admin-first первый срез) |
| Raw SQL | `docs/titanor-time/05_RAW_SQL_REGISTER.md` | завершено, FROZEN, current-scope |
| Исходное ТЗ | `docs/titanor-time/TITANOR_TIME_DEVELOPMENT_ROADMAP.md` | provenance-копия ТЗ владельца; детализирована и заменена пятью документами выше для целей проектирования |
| Общий roadmap проекта | `docs/PROJECT_ROADMAP.md` (ЭТАП 4 T4.1–T4.5, ЭТАП 5 T5.1–T5.4) | набросок ЭТАПА 4 заменён комплектом `docs/titanor-time/`; ЭТАП 5 (T5.2 Prisma schema, T5.3 первая migration) — этап, в котором сейчас находится проект |
| Prisma schema | `prisma/schema.prisma` | зафиксирована, commit `9b2cbab` |
| Initial migration | `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` | создана, статически проверена (commit `30d2364`), CK-08/CK-13 переименованы (commit `991b8fb`); полностью runtime-верифицирована на одноразовом PostgreSQL 16 — catalog identity + поведенческие тесты 21 CHECK/6 EXCLUDE/13 триггеров, full green (см. §8) |
| PostgreSQL infra | `compose.titanor-time.yaml`, `docs/titanor-time/06_DATABASE_INFRASTRUCTURE.md` | подготовлено, commit `c28af00`; не запущено |
| Next.js app scaffold | `titanor-time-app/` | bare scaffold, этот commit; типизируется/собирается, не запускался |

## 4. Git checkpoint

- Текущая ветка: `feature/titanor-time-foundation`.
- HEAD до создания этого status-файла: `30d2364ffe58679856d6a29d91c9992a941c2b65`.
- Commit Prisma schema: `9b2cbab` — `feat(titanor-time): add Prisma foundation`.
- Commit frozen register: `42b839d` — `docs(titanor-time): freeze raw SQL register`.
- Commit initial migration: `30d2364` — `feat(titanor-time): add initial Prisma migration`.
- Файлы в commit `30d2364`: ровно один — `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` (1441 строка, только добавление).
- Push status: не установлен как доказанный факт этим аудитом — `git remote -v` показывает `origin https://github.com/Hamec01/titangroup.git`, но проверка, дошли ли коммиты `9b2cbab`/`42b839d`/`30d2364` до `origin`, не выполнялась (запуск `git push`/`git fetch` вне read-only scope этой задачи). `origin/migration/vps-self-hosted` в локальных ref указывает на более ранний commit `64e6b1a` — ветка `feature/titanor-time-foundation` в этом аудите не сверялась с `origin`.
- Worktree до аудита: clean (`git status -sb` — без изменений, `git diff --check` — exit 0).

## 5. Реализовано

**Архитектурные документы** (все версия 5.4.1, статус «proposed architecture» внутри самих
документов, но по факту это финальная утверждённая версия комплекта, использованная для реализации
ниже):
- `README.md`, `01_SCREEN_MAP.md`, `02_ROLE_PERMISSION_MATRIX.md`, `03_DATA_MODEL_ERD.md`,
  `04_ADMIN_FIRST_API_CONTRACTS.md` — пять документов, тридцать семь сквозных сценариев (A–AK) в
  README §9.
- `05_RAW_SQL_REGISTER.md` — frozen raw-SQL object register, отдельный шестой документ.

**Prisma schema** (`prisma/schema.prisma`, commit `9b2cbab`):
- 24 модели, 8 enum — покрывают foundation-слой (Identity/User, Employee/Employment/Absence,
  City/WorkSite/WorkArea, WorkScheduleTemplate*, SiteAssignment, PayrollPeriod/Participant, Timesheet/
  TimesheetDraft* и immutable Timesheet*/WorkSegment/BreakSegment).
- Роли/разрешения (`Role`/`Permission`/`UserRole`), сессии, review-scope/proposal, correction-flow,
  audit, export — сознательно не входят в этот слой (более поздние этапы по архитектуре).

**Frozen raw-SQL register** (`05_RAW_SQL_REGISTER.md`, commit `42b839d`):
- 21 CHECK, 6 EXCLUDE, 1 extension (`btree_gist`), 11 trigger-функций, 13 trigger-экземпляров —
  каждый с exact именем, предикатом/контрактом, source-цитатой и минимальным тестом.
- Отдельно зафиксирован `+1 future CHECK` (`CorrectionRequest.approvalOverride`) — не входит в current
  totals.

**Initial migration** (`prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`,
commit `30d2364`):
- Structural-часть — фактический offline-вывод `prisma migrate diff --from-empty
  --to-schema-datamodel`, не переписана вручную.
- Raw-SQL часть — точное исполняемое соответствие всем 21 CHECK / 6 EXCLUDE / 1 extension / 11
  функциям / 13 триггерам register.
- Статически проверена дважды (в предыдущем ходе и в этом аудите) — см. §6.
- Первый runtime-прогон на одноразовом PostgreSQL 16 (HEAD `bebd6aa`) — см. §7: структурно успешна и
  идемпотентна; catalog identity-аудит выявил подтверждённый дефект именования у 2 из 21 CHECK
  constraint (CK-08/CK-13).
- Имена CK-08/CK-13 исправлены (commit `991b8fb`), затем полная повторная runtime-верификация на
  новом чистом одноразовом PostgreSQL 16 — см. §8: full green — catalog identities (8 enum, 24
  таблицы, 55 FK, 21 CHECK с точными исправленными именами, 6 EXCLUDE, 11 функций, 13 триггеров, 1
  extension, 0 future) и все поведенческие сценарии (21 CHECK позитив+негатив, 6 EXCLUDE
  adjacent+overlap, 13 триггеров позитив+негатив, 11 функций достигнуты, 7 frozen identifiers
  наблюдались) подтверждены детерминированно в single-session тестах.

**Не объявляются реализованными**: seed, аутентификация, API, UI, отдельная постоянная база Titanor
Time (production или dev), concurrency/многосессионное поведение constraints и triggers (намеренно
вне scope).

**Изолированная PostgreSQL 16 конфигурация** (`compose.titanor-time.yaml`, `.env.titanor-time.example`,
`docs/titanor-time/06_DATABASE_INFRASTRUCTURE.md`, commit `c28af00`):
- Отдельный Compose-проект `titanor-time`, отдельная `internal`-network (`titanor-time_internal`),
  отдельный named volume (`titanor-time_db_data`), без публикации database-порта, без CollabStudio.
- `docker compose config --quiet` — exit 0. Ничего не запущено: контейнер, network и volume фактически
  не созданы.

**Titanor Time Next.js app — bare scaffold** (`titanor-time-app/`, добавлен service `app` в
`compose.titanor-time.yaml`, этот commit):
- Next.js App Router + TypeScript, свой `package.json`/`Dockerfile`/`tsconfig.json` (изолированные
  зависимости), `prisma/schema.prisma` и migration остаются общими на уровне репозитория и не
  скопированы/не перемещены.
- Единственная функциональность: `GET /api/health` → `{"status":"ok","service":"titanor-time"}` и
  placeholder-страница `/`. Нет auth, нет БД-кода, нет реального API/UI.
- `npx tsc --noEmit` — exit 0; `npm run build` (standalone output) — success; `docker compose build
  app` — success. Ни разу не запускался (`docker compose up` не выполнялся).
- Service `app` в compose: `127.0.0.1:3200` (host), только `internal` network (нет outbound-доступа
  из контейнера — при необходимости внешних вызовов в будущем нужно будет добавить вторую network).

## 6. Статический аудит initial migration

- Exact migration path: `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`.
- Размер файла: 1441 строка.
- Prisma validation: `static verification completed` — `./node_modules/.bin/prisma validate --schema prisma/schema.prisma` вернул «The schema at prisma/schema.prisma is valid», exit 0 (потребовалась временная синтаксическая переменная `DATABASE_URL` — команда не устанавливает соединение, только парсит конфигурацию datasource).
- Prisma CLI/version: локальный, 6.19.0 (`@prisma/client` 6.19.0), Node v22.23.1, npm 10.9.8.
- migrate diff command form: `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
- Baseline drift result: `static verification completed` — свежая офлайн-генерация в `mktemp -d` (вне репозитория, удалён после сравнения) дала 0-строчный diff против Prisma-generated секции существующей migration.sql.
- CHECK count: 21 (все exact имена из register присутствуют ровно один раз).
- EXCLUDE count: 6 (все exact имена присутствуют ровно один раз).
- function count: 11 (все exact имена присутствуют ровно один раз).
- trigger count: 13 (все 13 комбинаций table+trigger name присутствуют ровно один раз).
- extension count: 1 (`CREATE EXTENSION IF NOT EXISTS btree_gist;` — ровно одно точное вхождение).
- future CHECK count: 0.
- future function count: 0 (в т.ч. `PROPOSAL_RESOLVED_IMMUTABLE` не создаёт функцию/триггер).
- future trigger count: 0.
- placeholder search (`TODO`/`TBD`/`FIXME`/незавершённый SQL/`message-substring`/`approvalOverride`): 0 физических совпадений — единственное текстовое совпадение `approvalOverride` находится в explanatory-комментарии, поясняющем, что именно исключено, не в исполняемом SQL.
- dangerous statement search (`DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE`/`DELETE FROM`/`DATABASE_URL`/`postgresql://`/`password`/`secret`): 0 опасных выражений — единственное совпадение слова «password» это Prisma-generated колонка `"passwordHash" TEXT` в таблице `User` (имя поля, не значение/секрет).
- exception contract: 22 `RAISE EXCEPTION`, все с `ERRCODE = 'P0001'`, ни одного другого кода; все используют один из 7 текущих frozen identifiers, `PROPOSAL_RESOLVED_IMMUTABLE` не используется нигде в этой миграции.
- Известное стилевое отличие (не блокер): custom-исключения записаны как `RAISE EXCEPTION '<IDENTIFIER>' USING ERRCODE = 'P0001';`, а не как `RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '<IDENTIFIER>';` — семантически идентично (первый аргумент `RAISE EXCEPTION` и есть `MESSAGE`), но иная допустимая форма записи того же PL/pgSQL-контракта.
- schema/register contradictions: не обнаружено.
- database connection: на момент этого (static) аудита не выполнялось; выполнено отдельной
  runtime-задачей позже — см. §7.
- migration application: на момент этого (static) аудита не выполнялось; выполнено отдельной
  runtime-задачей позже — см. §7.
- runtime test: на момент этого (static) аудита `intentionally not performed`; выполнен отдельной
  задачей позже — см. §7 (обнаружен подтверждённый дефект).

## 7. Runtime-аудит initial migration (PostgreSQL 16)

Дата: 2026-07-28. HEAD на момент этого runtime-аудита: `bebd6aab5f7a041e6272f24fe32db105ca04f92b`.

**Временная среда:**
- Exact migration path: `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`.
- PostgreSQL exact version: `16.14 (Debian 16.14-1.pgdg13+1)`.
- Docker image: `postgres:16`, image ID `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`.
- База временная: одноразовый контейнер, `--rm`, `--restart=no`, случайные user/db/password (не
  сохранены), данные на `tmpfs`, без named Docker volume.
- Порт: опубликован только на `127.0.0.1`, случайный host-port; не порт и не база CollabStudio.

**Применение migration (Prisma CLI 6.19.0, локальный):**
- Первый `prisma migrate deploy --schema prisma/schema.prisma`: обнаружена ровно одна migration
  (`20260728012114_init_titanor_time_foundation`), применена, exit code 0.
- `_prisma_migrations`: ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст, без failed
  migration artifacts.
- `prisma migrate status`: «Database schema is up to date!», exit 0.
- Повторный `prisma migrate deploy` на той же базе: «No pending migrations to apply.», exit 0,
  `_prisma_migrations` по-прежнему содержит ровно одну запись — идемпотентность подтверждена.

**Catalog-аудит структурного (Prisma) слоя:**
- Enum types: 8/8 (exact names совпадают с `prisma/schema.prisma`).
- Application tables: 24/24 (exact names совпадают), плюс отдельно существующая служебная
  `_prisma_migrations`.
- Индексы: 98 в `pg_indexes` = 68 explicit (29 unique + 39 plain, exact names из migration.sql) + 24
  backing-индекса primary key + 6 backing-индекса EXCLUDE-ограничений — совпадает с ожиданием, без
  unexpected записей.
- Foreign keys: 55/55 (exact `conname` совпадают с `AddForeignKey`-секцией migration.sql).
- Failed/partial migration artifacts: не обнаружено.

**Catalog-аудит raw-SQL (frozen register) слоя:**
- `btree_gist` extension: 1/1.
- EXCLUDE constraints: 6/6, все exact names совпадают с register.
- Trigger functions: 11/11, все exact names совпадают с register.
- Trigger instances (table+name): 13/13, все exact пары совпадают с register; `tgenabled = 'O'` для
  всех 13 (enabled).
- Future objects: `PROPOSAL_RESOLVED_IMMUTABLE` — 0 совпадений в теле функций; `approvalOverride` /
  `approval_override` CHECK — 0 совпадений; таблицы `CorrectionRequest` / `TimesheetReviewProposal` /
  `CorrectionDraftSegment` — 0 совпадений. Future-объекты подтверждённо отсутствуют физически.
- CHECK constraints: 21/21 по количеству, но **2 из 21 имеют неверное exact-имя в каталоге** — см.
  ниже.

**Подтверждённый дефект migration (не исправлен в рамках этой задачи):**

PostgreSQL обрезает идентификаторы длиннее 63 байт (`NAMEDATALEN` limit) без ошибки. Два CHECK
constraint из frozen register превышают этот лимит и после `prisma migrate deploy` физически
существуют в каталоге под усечённым, а не frozen-именем:

| ID | Table | Frozen name (register) | Длина | Фактическое имя в `pg_constraint.conname` | Длина |
|---|---|---|---|---|---|
| CK-08 | `WorkScheduleTemplateVersionDay` | `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative` | 71 | `ck_work_schedule_template_version_day_planned_break_minutes_non` | 63 |
| CK-13 | `TimesheetDraftPlannedShift` | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative` | 66 | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegat` | 63 |

- SQLSTATE: не применимо — это не runtime-ошибка приложения, migration применяется без ошибки
  (exit 0); это несовпадение физического имени объекта с frozen-спецификацией, обнаруженное catalog
  identity-аудитом.
- Проверено на коллизии: два разных CHECK на одной таблице не сливаются под одним усечённым именем
  (`having count(*) > 1` по `(conrelid, conname)` — 0 строк).
- Нарушенный контракт: `05_RAW_SQL_REGISTER.md` §7 — «service identity: exact constraint name from
  the PostgreSQL constraint field» для CHECK-нарушений. Сервис, сопоставляющий ошибки по
  frozen-имени `ck_..._nonnegative`, не распознает нарушение этих двух constraint, так как реальное
  имя в PostgreSQL другое.
- Предикат/поведение самого ограничения (`"plannedBreakMinutes" >= 0`) не пострадали — это
  исключительно проблема именования/service-mapping контракта, не проблема бизнес-логики.
- Ожидаемый результат: exact match с register-именем для всех 21 CHECK. Фактический результат: 19/21
  совпали exact, 2/21 (CK-08, CK-13) усечены PostgreSQL.

**Update (source-level fix, commit `991b8fb`):** имена CK-08 и CK-13 сокращены синхронно в
`05_RAW_SQL_REGISTER.md` и в этой existing migration до:
`ck_schedule_template_version_day_break_minutes_nonnegative` (58 bytes, CK-08) и
`ck_timesheet_draft_shift_break_minutes_nonnegative` (50 bytes, CK-13). Таблица выше оставлена
как есть — это исторический снимок первого runtime-аудита (HEAD `bebd6aa`), доказывающий факт
обнаруженного дефекта; текущие имена в репозитории уже другие (см. §10). Исправление
**подтверждено повторной runtime-верификацией на чистом PostgreSQL 16 — см. §8, §10.**

**Поведенческие runtime-тесты (21 CHECK / 6 EXCLUDE / 13 триггеров / 11 функций / 7 frozen
identifiers): не выполнялись.** Задача была остановлена сразу после обнаружения подтверждённого
дефекта каталога, по явному правилу задачи «подтверждённый дефект → зафиксировать, не исправлять, не
расширять проверку дальше». Concurrency runtime test: намеренно не выполнялся (вне scope этой задачи
независимо от исхода).

**Очистка временной среды:**
- Временный контейнер удалён (`docker rm -f` по точному имени + label
  `titanor-time.runtime-test=true`); `docker ps -a --filter label=titanor-time.runtime-test=true`
  после очистки — пусто.
- Временный каталог тестов (`mktemp -d` под `/tmp`, вне репозитория) удалён.
- Named Docker volume не создавался; `docker volume ls` до и после — идентичны.
- Отдельная постоянная Docker network не создавалась; `docker network ls` до и после — идентичны.
- Все 3 ранее существовавших контейнера (`collab-studio-app-1`, `titanorgroup-web-1`,
  `collab-studio-postgres-1`) продолжают работать без перезапуска.
- Public site healthcheck (`https://titanorgroup.fi/api/health`) — до и после: `200 OK`.
- CollabStudio (`https://collabstudio.run`) — до и после: `200 OK`.
- Секреты временной базы (пароль, полный `DATABASE_URL`) нигде не сохранены и не выведены.

**Не затронуто этой задачей:** production база, CollabStudio база/контейнеры/сеть/secrets, вторая
migration, `prisma/schema.prisma`, существующая migration.sql, `05_RAW_SQL_REGISTER.md`.

## 8. Повторный runtime-аудит исправленной migration (PostgreSQL 16) — full green

Дата: 2026-07-28. Runtime-tested HEAD: `991b8fb8381bff11accd09e2c1c3a3f7748d0832` (тот же commit, что
и source-level fix CK-08/CK-13).

**Проверяемые hashes (совпали с ожидаемыми на всём протяжении задачи):**
- `prisma/schema.prisma`: `3552c36f6725ecfa7ff15fe1b34b9ecfa38c352da40e49f91c1c9d0dcece0506`.
- `05_RAW_SQL_REGISTER.md`: `8c014d664319c74ee17c3aff9c42d023a86f8456c2cf6fdd0dce591b5bdcd9c2`.
- `migration.sql`: `a0d2059582079846a0c70658b24c6162830ae5b8e3e9ffcffe077ded4c862d7b` (не изменился в ходе этой
  задачи — задача только тестировала, не редактировала).

**Временная среда:**
- Exact migration path: `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`.
- PostgreSQL exact version: `16.14 (Debian 16.14-1.pgdg13+1)`.
- Docker image: `postgres:16`, image ID `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`
  (уже присутствовал локально, pull не потребовался).
- База временная: новый одноразовый контейнер (`--rm`, `--restart=no`), случайные user/db/password (не
  сохранены), данные на `tmpfs` (`size=512m`), без named Docker volume, без новой постоянной network.
- Порт: опубликован только на `127.0.0.1:<dynamic>`; internal PostgreSQL port остаётся `5432`; не порт
  и не база CollabStudio.

**Применение migration (Prisma CLI 6.19.0, локальный):**
- Первый `prisma migrate deploy --schema prisma/schema.prisma`: обнаружена ровно одна migration,
  применена, exit code 0.
- `_prisma_migrations`: ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст.
- `prisma migrate status`: «Database schema is up to date!», exit 0.
- Повторный `prisma migrate deploy`: «No pending migrations to apply.», exit 0; `_prisma_migrations`
  по-прежнему содержит ровно одну запись — идемпотентность подтверждена.

**Catalog-аудит структурного (Prisma) слоя — всё совпало exact:**
- Enum types: 8/8. Application tables: 24/24 (плюс отдельная служебная `_prisma_migrations`).
- Primary keys: 25 (24 приложения + 1 `_prisma_migrations`).
- Индексы: 98 в `pg_indexes` = 68 explicit (29 unique + 39 plain, exact имена из migration.sql) + 24
  PK-backing + 6 EXCLUDE-backing — без unexpected записей.
- Foreign keys: 55/55, все `convalidated = true`, exact `conname` совпадают с migration.sql.
- Failed/partial migration artifacts: не обнаружено.

**Catalog-аудит raw-SQL слоя — включая исправленные CK-08/CK-13:**
- CHECK constraints: 21/21, все `convalidated = true`.
- **CK-08 exact identity подтверждена**: `pg_constraint.conname = ck_schedule_template_version_day_break_minutes_nonnegative`,
  `octet_length = 58`, table `WorkScheduleTemplateVersionDay`, `convalidated = true`.
- **CK-13 exact identity подтверждена**: `pg_constraint.conname = ck_timesheet_draft_shift_break_minutes_nonnegative`,
  `octet_length = 50`, table `TimesheetDraftPlannedShift`, `convalidated = true`.
- Старые имена (полное и усечённое, для обоих CK) отсутствуют в каталоге — прямой запрос вернул 0
  строк.
- EXCLUDE constraints: 6/6, все `convalidated = true`, exact tables совпадают.
- Trigger functions: 11/11, все return type `trigger`, без duplicate/overload.
- Trigger instances (table+name): 13/13, все `tgenabled = 'O'`, exact event/timing/function binding
  подтверждены через `pg_get_triggerdef` — точное совпадение с migration.sql.
- `btree_gist` extension: 1/1.
- Future objects: `PROPOSAL_RESOLVED_IMMUTABLE` — 0; `approvalOverride`/`approval_override` CHECK — 0;
  таблицы `CorrectionRequest`/`TimesheetReviewProposal`/`CorrectionDraftSegment` — 0. Подтверждённо
  отсутствуют физически.

**Поведенческие runtime-тесты — все выполнены, single-session, каждый сценарий в изолированной
subtransaction (`SAVEPOINT`/`ROLLBACK TO SAVEPOINT`), вся сессия завершена финальным `ROLLBACK`
(ничего не закоммичено):**

- CHECK positive controls: 21/21 passed.
- CHECK negative cases: 21/21 passed — exact SQLSTATE `23514` и exact `CONSTRAINT_NAME` для каждого,
  включая **CK-08 → `ck_schedule_template_version_day_break_minutes_nonnegative`** и **CK-13 →
  `ck_timesheet_draft_shift_break_minutes_nonnegative`** (новые имена подтверждены в реальном
  runtime-нарушении, не только в каталоге).
- unexpected CHECK SQLSTATE/names: 0.
- EXCLUDE positive controls (adjacent-range allowed): 6/6 passed.
- EXCLUDE overlap cases: 6/6 passed — exact SQLSTATE `23P01` и exact `CONSTRAINT_NAME` для каждого.
- unexpected EXCLUDE SQLSTATE/names: 0.
- Trigger positive controls: 13/13 passed. Trigger identities tested (table+trigger): 13/13.
- Trigger functions reached: 11/11 (каждая через минимум один свой trigger instance).
- Mandatory function branches: обе ветки (`DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`) протестированы
  отдельно для всех четырёх day-state триггеров (day-side и child-side, draft и immutable слои).
- Current frozen identifiers observed: 7/7 — `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`,
  `BREAK_OUTSIDE_PARENT`, `ASSIGNMENT_SCOPE_MISMATCH`, `ASSIGNMENT_DATE_OUTSIDE_VALIDITY`,
  `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY`, `ASSIGNMENT_DEPENDENTS_CONFLICT` — каждый с exact
  SQLSTATE `P0001` и exact `MESSAGE_TEXT` (точное совпадение с frozen identifier, не substring).
- Future identifier (`PROPOSAL_RESOLVED_IMMUTABLE`) observed as current test: 0 (не тестировался как
  current functionality, физически отсутствует).
- unexpected trigger SQLSTATE/messages: 0.
- Итого: 94/94 поведенческих сценария passed (42 CHECK + 14 EXCLUDE + 38 trigger-сценариев, включая
  positive controls и обе day-state ветки).
- Concurrency runtime test: намеренно не выполнялся — вне scope этой задачи независимо от исхода;
  проверялось только детерминированное single-session поведение constraints/triggers.

**Финальный контроль пустоты:**
- Application tables empty after tests: 24/24 — суммарный подсчёт по всем таблицам вернул `0` строк
  (проверено отдельным запросом после завершения тестового скрипта и его `ROLLBACK`, т.е. на реально
  сохранённом состоянии базы, а не только в рамках транзакции).
- `_prisma_migrations`: по-прежнему ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст,
  migration остаётся applied.
- Временные объекты (session-local temp table + temp helper functions) отсутствуют после разрыва
  сессии — проверено отдельным запросом.
- Test fixtures не сохранились.

**Очистка временной среды:**
- Временный контейнер удалён (`docker rm -f` по точному имени + обоим label,
  `titanor-time.runtime-test=true` и уникальному `titanor-time.runtime-test-id`); проверка ID/имени/
  label перед удалением прошла; `docker ps -a --filter label=titanor-time.runtime-test=true` после
  очистки — пусто.
- Точный `TEST_TMP_DIR` (`mktemp -d` под `/tmp`, вне репозитория) удалён.
- Named Docker volume не создавался; `docker volume ls` до и после — идентичны (тот же список).
- Отдельная постоянная Docker network не создавалась; `docker network ls` до и после — идентичны.
- Все 3 ранее существовавших контейнера (`collab-studio-app-1`, `titanorgroup-web-1`,
  `collab-studio-postgres-1`) — те же container ID, те же `StartedAt`, `RestartCount = 0` без
  изменений, `healthy` — не перезапускались.
- Public site healthcheck (`https://titanorgroup.fi/api/health`) — до и после: `200`.
- CollabStudio (`https://collabstudio.run`) — до и после: `200`.
- Секреты временной базы (пароль, полный `DATABASE_URL`) нигде не сохранены и не выведены.

**Не затронуто этой задачей:** production база, production migration application, CollabStudio база/
контейнеры/сеть/secrets, вторая migration, `prisma/schema.prisma`, `05_RAW_SQL_REGISTER.md`,
`migration.sql` (только протестирована, не редактировалась).

## 9. Не начато

- Фактический запуск изолированного PostgreSQL 16 (`compose.titanor-time.yaml` подготовлен, но
  `docker compose up` не выполнялся; контейнер/network/volume не существуют).
- Фактический запуск Titanor Time Next.js app (`titanor-time-app/` собирается, но не запускался).
- Применение existing migration к постоянной (не одноразовой тестовой) базе.
- Seed.
- Первый `SUPER_ADMIN`.
- Password delivery (доставка первого пароля/кода активации).
- MFA production gate (`REQUIRE_MFA_FOR_ADMIN=true`).
- Login.
- `UserSession`.
- Role guard / permission enforcement.
- Admin-first API (`04_ADMIN_FIRST_API_CONTRACTS.md`).
- `/admin/setup`.
- Worker flow.
- Foreman flow.
- Production deployment Titanor Time (`app.titanorgroup.fi`).

## 10. Blockers и открытые решения

### Технические blockers

Нет открытых технических blockers.

- **CK-08 / CK-13 constraint name truncation — RESOLVED.** Статус: **resolved by source fix `991b8fb`
  and confirmed by clean PostgreSQL 16 runtime verification.** Два CHECK constraint из frozen register
  имели имена длиннее лимита PostgreSQL в 63 байта на идентификатор и после применения migration
  физически существовали в каталоге под другим, усечённым именем (историческая таблица — §7,
  обнаружено на HEAD `bebd6aa`). Это ломало документированный service-mapping контракт
  `05_RAW_SQL_REGISTER.md` §7 («service identity: exact constraint name») для этих двух constraint.
  Сам предикат ограничения (`>= 0`) работал корректно — проблема была только в имени.

  **Source-level исправление (commit `991b8fb`):**

  | ID | Table | Старое имя (историческое, HEAD `bebd6aa`) | Старая длина | Новое имя (текущее, подтверждено в каталоге) | Новая длина |
  |---|---|---|---|---|---|
  | CK-08 | `WorkScheduleTemplateVersionDay` | `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative` | 71 bytes | `ck_schedule_template_version_day_break_minutes_nonnegative` | 58 bytes |
  | CK-13 | `TimesheetDraftPlannedShift` | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative` | 66 bytes | `ck_timesheet_draft_shift_break_minutes_nonnegative` | 50 bytes |

  Изменены синхронно `05_RAW_SQL_REGISTER.md` (exact constraint name + errata) и единственная existing
  migration (`ADD CONSTRAINT` identifier + предшествующий комментарий). CHECK predicate
  (`"plannedBreakMinutes" >= 0`), таблица, колонка, SQLSTATE и минимальный тест — без изменений.
  `prisma/schema.prisma` не менялась. Вторая migration не создавалась.

  **Подтверждено повторной runtime-верификацией (§8, тот же commit `991b8fb` как проверяемый HEAD):**
  оба новых имени присутствуют exact в `pg_constraint.conname` (58 и 50 байт соответственно), старые
  (полное и усечённое) имена отсутствуют, и оба constraint успешно прошли поведенческий negative-тест
  (SQLSTATE `23514`, exact новое `CONSTRAINT_NAME`) на чистом одноразовом PostgreSQL 16. Blocker
  закрыт.

Стилевая форма `RAISE EXCEPTION` (см. §6) остаётся отмеченным, но не блокирующим расхождением.

### Owner decisions

Незакрытые вопросы, зафиксированные в самих архитектурных документах и всё ещё требующие решения
владельца до соответствующего этапа (не переоткрываются здесь — только перечисляются со ссылкой):

- Правило для смены, пересекающей границу расчётного периода (`README.md` §8.1, `04_...` §12).
- Финальный список действий, требующих свежий MFA (`README.md` §8.2).
- Максимальная разумная длительность одного `WorkSegment`/`TimesheetDraftSegment` (`README.md` §8.3).
- Нужна ли `WorkScheduleTemplateVersion` видимой пользователю как отдельная сущность в UI
  (`README.md` §8.4).
- Кому, кроме `ADMIN`/`SUPER_ADMIN`, можно делегировать `correction.draft.edit` (`README.md` §8.5,
  `02_...` §6).
- Partial-day отсутствия — нужна ли отдельная будущая модель (`README.md` §8.6).
- Когда именно строится route/API для `absence.*` (`README.md` §8.7, `04_...` §12).
- Известен ли первый `SUPER_ADMIN` и способ передачи первого пароля — явно указано в `README.md`
  §11 как критерий, предшествующий production-коду, и пока не закрыто.

## 11. Следующий рекомендуемый шаг

Изолированная PostgreSQL 16 конфигурация и bare-каркас Next.js-приложения подготовлены, но ни разу не
запускались (см. §5). Следующей отдельной задачей, после checkpoint владельца:
1. Реально поднять `db` (`docker compose -f compose.titanor-time.yaml up -d db`), проверить health.
2. Применить existing migration к этой (теперь реальной, но ещё не production) базе.
3. Только затем начинать T5.2/T5.4-T5.6 по `docs/PROJECT_ROADMAP.md` (ORM-интеграция в
   `titanor-time-app`, первый `SUPER_ADMIN`, login, role guard) — не начинать раньше проверки health
   и migration. Не запускать в production и не менять CollabStudio без отдельного checkpoint
   владельца.

## 12. Правило обновления

1. Каждая следующая задача сначала читает этот файл.
2. После успешного commit агент обновляет статус отдельной минимальной задачей либо включает
   обновление в task scope, если это заранее разрешено владельцем.
3. Запись содержит commit hash, изменённые файлы и фактические проверки.
4. Планируемая работа не записывается как выполненная.
5. Чат не является единственным хранилищем отчёта — этот файл им является.
