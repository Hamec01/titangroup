# Titanor Time — Implementation Status

Обновлено: 2026-07-30 02:44 Europe/Helsinki
Ветка: feature/titanor-time-foundation
Isolated PostgreSQL config commit: `c28af00521ffef322211e2cfae840a5568dc8c03`
Next.js app scaffold commit: `e15b203fe334fa4e2c68335f1169f78ed9c18ec9`
Real (persistent, non-disposable) `db` service started + migration applied: см. §5, HEAD `e15b203`
ORM integration + first `app` launch (Prisma Client, `/api/ready`): см. §5, commit `7a854ac`
First backup + verified restore (throwaway db; predates second migration — 24 tables only, now
stale): см. §5, commit `c0f5425`
Second migration (Role/Permission/RolePermission/UserRole): см. §5, commit `c0f5425` (schema.prisma
changed for the first time since commit `9b2cbab`; first initial migration remains frozen/untouched)
Fresh backup + verified restore after second migration (28 tables, 59 FK, 2 migrations), Prisma
Client regenerated + `app` rebuilt, bootstrap SUPER_ADMIN CLI implemented + tested on disposable
PostgreSQL 16 only: см. §5, commit `9fbcd1a`
Docker image gap fix (bootstrap CLI missing from `output: 'standalone'` runner stage) — `app` rebuilt,
CLI confirmed runnable inside the real image; real SUPER_ADMIN still not created: см. §5, commit
`122c884`
First production SUPER_ADMIN created in persistent `titanor-time-db-1` (`andrei.sakki`, owner-run,
owner-confirmed state — see caveat in §5): см. §5, commit `836ef49`
Third migration (`UserSession`, T5.5 first sub-step) — schema created + tested on disposable
PostgreSQL 16, commit `e273490`; **owner-applied** to persistent `titanor-time-db-1`, `app` rebuilt +
Prisma Client regenerated: см. §5, commit `7795d3e`
tsconfig fix (root project no longer type-checks the isolated `titanor-time-app` subproject): commit
`3c39d84`
`POST /api/auth/login` (T5.5 core) implemented per `04_ADMIN_FIRST_API_CONTRACTS.md` §0/§1 — tested
on disposable PostgreSQL 16, commit `ecb37b2`
`reset-password` CLI added (owner forgot the bootstrap-set password) + deployed to real `app`: commit
`be598f8`
Real `SUPER_ADMIN` password reset by owner + real login against `titanor-time-db-1` confirmed —
`200`, correct `id`/`username`/`roles: ["SUPER_ADMIN"]`: см. §5, этот commit
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

После этого подготовлена изолированная постоянная конфигурация PostgreSQL 16 (commit `c28af00`,
`compose.titanor-time.yaml`) — отдельный Compose-проект `titanor-time`, отдельная internal-network,
отдельный named volume, без публикации database-порта, без CollabStudio.

Следующим шагом добавлен bare-каркас Titanor Time Next.js-приложения (`titanor-time-app/`, commit
`e15b203`) — App Router, TypeScript, health endpoint, multi-stage Dockerfile (standalone output),
подключён как service `app` в `compose.titanor-time.yaml` (`127.0.0.1:3200`, только internal
network). Каркас типизируется и собирается без ошибок, но `app` ни разу не запускался — нет login,
нет данных, нет реальных страниц/API кроме `/api/health`.

После checkpoint владельца сервис `db` был реально запущен и existing migration реально применена к
этой (теперь постоянной, не одноразовой) базе — см. §5. Это по-прежнему не production:
`titanor-time-db-1` изолирован (отдельные network/volume, без published port, без CollabStudio), не
обслуживает `app.titanorgroup.fi`, не содержит seed-данных.

После отдельного owner checkpoint `titanor-time-app` впервые подключён к `db` через Prisma Client и
впервые запущен как service `app` — см. §5. Общая `prisma/schema.prisma` и existing migration не
менялись; `app` использует уже сгенерированный из неё Prisma Client, полученный при сборке Docker
image (без копирования schema/migrations в приложение). Добавлен readiness endpoint
`GET /api/ready`, выполняющий `SELECT 1` через Prisma. `app` реально запущен, healthy, отвечает на
`/api/health`, `/api/ready` (`database: connected`) и `/`; опубликован только на `127.0.0.1:3200`.
`db` по-прежнему без published port. В базе по-прежнему 0 business rows — только применённая схема,
без seed.

Первый backup постоянной database выполнен и **проверен restore-ом в отдельную одноразовую тестовую
базу** (`pg_dump` → `pg_restore` на throwaway PostgreSQL 16, не на реальном `db`) — **до второй
migration**: каталог на тот момент совпал с 24 таблицами, 8 enum, 21 CHECK, 6 EXCLUDE, 55 FK,
11 функциями, 13 триггерами, `_prisma_migrations` = 1 запись — `Role`/`Permission`/`UserRole` тогда
ещё не существовали. Этот первый backup устарел сразу после второй migration (см. ниже) и заменён
свежим (см. следующую задачу/секцию). Backup-файлы не закоммичены (`backups/`, добавлено в
`.gitignore`).

Далее обнаружено и устранено архитектурное ограничение: у схемы не было способа хранить роль
пользователя вообще (`Role`/`Permission`/`UserRole` были только в `03_DATA_MODEL_ERD.md`, не в
foundation-схеме). После явного подтверждения владельца добавлена **вторая migration**
(`20260728161708_add_role_permission_user_role`) — `Role`, `Permission`, `RolePermission`, `UserRole`,
плюс частичный unique index (`ex_user_role_active_unique`, раз в raw SQL — не выразим через
`@@unique`) и 4 фиксированные seed-строки `Role` (`SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`) из
`02_ROLE_PERMISSION_MATRIX.md` §1. Первая initial migration и frozen register не изменялись.
`Permission`/`RolePermission` намеренно оставлены пустыми (заполнение ~50+ permission-строк отложено
до реализации соответствующих endpoint'ов). Применена сначала к одноразовому PostgreSQL 16 (с нуля,
обе migrations вместе, плюс идемпотентный повтор, плюс позитивный/негативный поведенческий тест
partial unique index), затем к реальной постоянной `titanor-time-db-1`.

Далее (T5.4, этот commit): взят **свежий** backup постоянной database — теперь корректно отражающий
обе migrations (28 таблиц, 59 FK — 55 + 4 RBAC — 8 enum, 21 CHECK, 6 EXCLUDE, 11 функций, 13
триггеров, `_prisma_migrations` = 2 записи, `Role` = ровно 4 строки, `User`/`UserRole`/`Permission`/
`RolePermission` = 0) и **проверен restore-ом** в отдельную одноразовую тестовую базу — эта проверка
подтвердила counts и ключевые identities (роли по именам, migration-записи по именам), а не
построчный re-audit каждого constraint/trigger (тот уже пройден в §8 на идентичном migration.sql).
Prisma Client регенерирован из корневой `prisma/schema.prisma` (теперь включает `Role`/`Permission`/
`RolePermission`/`UserRole`); `titanor-time-app` пересобран и `app` пересоздан (`--no-deps`, `db` не
перезапускался) — healthy, `/api/health`/`/api/ready` по-прежнему `200`.

Добавлен `titanor-time-app/scripts/bootstrap-super-admin.ts` — безопасный CLI первого `SUPER_ADMIN`:
Argon2id, пароль только через скрытый интерактивный TTY-ввод (дважды, никогда не через CLI-аргумент
или environment), один Serializable Prisma transaction + PostgreSQL transaction-scoped advisory lock
(`pg_advisory_xact_lock`) против гонки двух одновременных запусков, dry-run режим, отказ без
изменений при уже существующем активном `SUPER_ADMIN` или занятом username/email, полный rollback
при ошибке. Проверен только на одноразовом PostgreSQL 16 (обе migrations с нуля) — dry-run, реальное
создание, повтор с тем же username, повтор при существующем `SUPER_ADMIN`, искусственный сбой между
`User` и `UserRole` (полный rollback подтверждён). Реальный `SUPER_ADMIN` в постоянной базе **не
создан** — это следующий шаг, требующий отдельного подтверждения владельца (см. §11). Production-код
(seed, аутентификация, `Session`, role guard, реальный UI) по-прежнему не начат.

Ход этой задачи также выявил и исправил две ошибки в самом CLI до применения к какой-либо базе:
`pg_advisory_xact_lock()` возвращает `void`, что несовместимо с `$queryRaw` (исправлено на
`$executeRaw`); и модуль запускал `main()` как побочный эффект самого импорта, а не только при прямом
запуске (добавлена проверка `require.main === module`). Обе найдены и исправлены тестами на
одноразовой базе, до применения к реальной.

Далее, после получения от владельца подтверждения username (`andrei.sakki`) для реального первого
`SUPER_ADMIN`, владелец сам запустил предоставленную команду в своём терминале и получил `npm error
Missing script: "bootstrap:super-admin"`. Диагностика (`docker exec titanor-time-app-1 ...`)
подтвердила реальный дефект образа, а не ошибку ввода: Next.js `output: 'standalone'` трассирует и
копирует в `runner`-стадию только то, что достижимо из самих app-роутов — `scripts/`, `lib/`,
CLI-зависимости (`tsx`, `argon2`) и реальный `package.json` со скриптом `bootstrap:super-admin` в
собранный образ не попадали; вместо него в `/app/package.json` лежал собственный минимальный
package.json Next.js (только `dev`/`build`/`start`). Исправлено в `titanor-time-app/Dockerfile`
(`runner`-стадия): полный `node_modules` из `builder` копируется до наложения standalone-поддерева,
затем явно добавлены `scripts/`, `lib/`, `package.json`, `tsconfig.json` из `builder`. `app`
пересобран и пересоздан (`--no-deps`, `db` не перезапускался). Проверено внутри контейнера
`titanor-time-app-1`: `npm run` показывает `bootstrap:super-admin`; `node_modules` содержит `tsx` и
`argon2`; `node_modules/.prisma/client` сгенерирован; `docker exec ... npm run bootstrap:super-admin
-- --username=sanitycheck --dry-run` без `-it` корректно завершается `UsageError` про обязательный
реальный TTY (exit 1) — то есть CLI действительно исполняется внутри образа и его защита от
non-TTY запуска работает; `/api/ready` по-прежнему `{"status":"ready",...,"database":"connected"}`.
Реальный `SUPER_ADMIN` в постоянной базе всё ещё **не создан** — владельцу нужно повторить команду
самому, уже с `-it`, из своего терминала.

После этого владелец сам выполнил `docker compose -f compose.titanor-time.yaml exec -it app npm run
bootstrap:super-admin -- --username=andrei.sakki` из своего терминала (реальный `-it` TTY, пароль
введён только туда) и сообщил результат: первый production `SUPER_ADMIN` создан и подтверждён.
Эта задача (этот commit) обновляет только документацию на основе состояния, сообщённого владельцем
напрямую в чате, — независимый read-only SQL-запрос к `titanor-time-db-1` для перепроверки этой же
информации агентом был заблокирован политикой инструментов (tool policy) до выполнения и не
повторялся; `db`/`app`/bootstrap CLI этой задачей не запускались и не перезапускались. Сообщённое
состояние: `username=andrei.sakki`, `status=ACTIVE`, `locale=FI`, `role=SUPER_ADMIN`,
`passwordSet=true`, `passwordHash` — Argon2id (сам хеш не выводился и не проверялся этой задачей),
`User=1`, `UserRole=1`, `Role=4`, `activeSuperAdmins=1`. Повторный запуск bootstrap CLI (проверка
идемпотентности) корректно завершился без изменений: `No changes made: An active SUPER_ADMIN already
exists.` — согласуется с проверенным ранее (§5, commit `9fbcd1a`) поведением guard на одноразовой базе.

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
| Prisma schema | `prisma/schema.prisma` | зафиксирована, commit `9b2cbab`; расширена (Role/Permission/RolePermission/UserRole) commit `c0f5425` — 28 моделей, 8 enum; расширена вторично (`UserSession`, `AuthLevel`) этим commit — 29 моделей, 9 enum |
| Initial migration | `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` | создана, статически проверена (commit `30d2364`), CK-08/CK-13 переименованы (commit `991b8fb`); полностью runtime-верифицирована на одноразовом PostgreSQL 16 — catalog identity + поведенческие тесты 21 CHECK/6 EXCLUDE/13 триггеров, full green (см. §8); frozen/unchanged с тех пор, включая эту задачу |
| Second migration | `prisma/migrations/20260728161708_add_role_permission_user_role/migration.sql` | создана и применена commit `c0f5425` — Role/Permission/RolePermission/UserRole; не менялась этой задачей |
| Third migration | `prisma/migrations/20260729220524_add_user_session/migration.sql` | создана commit `e273490` — `UserSession` (T5.5, первый под-шаг); протестирована на одноразовом PostgreSQL 16 (все три migrations с нуля, идемпотентность, catalog identity, поведенческие тесты); **применена владельцем** к `titanor-time-db-1` commit `7795d3e` — `prisma migrate deploy` вернул «All migrations have been successfully applied» |
| Root tsconfig | `tsconfig.json` | исправлен commit `3c39d84` — `titanor-time-app` добавлен в `exclude` (изолированный подпроект со своим `@/*` alias, ранее ошибочно захватывался корневым `**/*.ts`) |
| Login endpoint | `titanor-time-app/app/api/auth/login/route.ts`, `titanor-time-app/lib/{api-error,rate-limit,session}.ts` | реализован этим commit — `POST /api/auth/login` (T5.5 core); протестирован только на одноразовом PostgreSQL 16, не на `titanor-time-db-1` |
| PostgreSQL infra | `compose.titanor-time.yaml`, `docs/titanor-time/06_DATABASE_INFRASTRUCTURE.md` | подготовлено (commit `c28af00`); `db` реально запущен, обе migrations применены; свежий backup после второй migration проверен restore-ом (этот commit) |
| Next.js app scaffold | `titanor-time-app/` | commit `e15b203` (scaffold) + `7a854ac` (Prisma Client, `/api/ready`) + этот commit (Prisma Client регенерирован под RBAC-схему, `app` пересобран) |
| Bootstrap SUPER_ADMIN CLI | `titanor-time-app/scripts/bootstrap-super-admin.ts` | реализован и проверен на одноразовом PostgreSQL 16 (commit `9fbcd1a`); Docker-образ `app` не содержал CLI/зависимости (standalone-трассировка), исправлено в `titanor-time-app/Dockerfile` этим commit — CLI подтверждён исполняемым внутри реального образа; реальный SUPER_ADMIN в постоянной базе не создан |

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

**Prisma schema** (`prisma/schema.prisma`, изначально commit `9b2cbab`, расширена commit `c0f5425`):
- Изначально (commit `9b2cbab`): 24 модели, 8 enum — foundation-слой (Identity/User,
  Employee/Employment/Absence, City/WorkSite/WorkArea, WorkScheduleTemplate*, SiteAssignment,
  PayrollPeriod/Participant, Timesheet/TimesheetDraft* и immutable Timesheet*/WorkSegment/
  BreakSegment). На тот момент `Role`/`Permission`/`UserRole`, сессии, review-scope/proposal,
  correction-flow, audit, export сознательно не входили в этот слой.
- С commit `c0f5425`: **сейчас 28 моделей** — добавлены `Role`, `Permission`, `RolePermission`,
  `UserRole` (см. «Вторая migration» ниже). Сессии (`UserSession`), review-scope/proposal,
  correction-flow, audit, export по-прежнему не входят — остаются более поздними этапами.

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
- `docker compose config --quiet` — exit 0.

**Реальный запуск `db` + применение migration** (после отдельного owner checkpoint, HEAD `e15b203`):
- `.env.titanor-time` создан локально (реальный случайный пароль через `openssl rand -hex 32`), не
  закоммичен, покрыт `.env.*` в `.gitignore` — проверено `git check-ignore -v`.
- `docker compose -f compose.titanor-time.yaml up -d db` — создан ровно один контейнер
  `titanor-time-db-1`, ровно одна network `titanor-time_internal`, ровно один volume
  `titanor-time_db_data`; healthcheck перешёл в `healthy` при первой же проверке.
- Подтверждено: PostgreSQL `16.14`, `current_database=titanor_time`, `current_user=titanor_time_app`,
  порт не опубликован (`docker port` — пусто), container ID отличается от
  `collab-studio-postgres-1`, network — только `titanor-time_internal`.
- Existing migration применена через одноразовый `node:22`-контейнер, подключённый только к
  `titanor-time_internal` (без npm install — использован уже установленный `node_modules` репозитория
  через bind-mount, DATABASE_URL передан только in-memory, не выведен и не сохранён): exit 0,
  `_prisma_migrations` — ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст.
- `prisma migrate status` сразу после — «Database schema is up to date!».
- Lightweight catalog sanity (не полный поведенческий re-audit — тот уже пройден в §8 на идентичном
  migration.sql): 24 таблицы, 8 enum, `btree_gist` присутствует, точные имена `CK-08`/`CK-13`
  подтверждены в `pg_constraint.conname` этой реальной базы.
- Production/CollabStudio контейнеры не перезапускались (те же `StartedAt`/`RestartCount`);
  `titanorgroup.fi` и `collabstudio.run` — 200 до и после.
- База пустая (только схема, без данных) — seed не выполнялся.

**Titanor Time Next.js app — bare scaffold** (`titanor-time-app/`, добавлен service `app` в
`compose.titanor-time.yaml`, commit `e15b203`):
- Next.js App Router + TypeScript, свой `package.json`/`Dockerfile`/`tsconfig.json` (изолированные
  зависимости), `prisma/schema.prisma` и migration остаются общими на уровне репозитория и не
  скопированы/не перемещены.
- Единственная функциональность: `GET /api/health` → `{"status":"ok","service":"titanor-time"}` и
  placeholder-страница `/`. Нет auth, нет БД-кода, нет реального API/UI.
- `npx tsc --noEmit` — exit 0; `npm run build` (standalone output) — success; `docker compose build
  app` — success. На момент этого commit ни разу не запускался.

**ORM-интеграция + первый запуск `app`** (`titanor-time-app/lib/prisma.ts`,
`titanor-time-app/app/api/ready/route.ts`, `titanor-time-app/Dockerfile`, `compose.titanor-time.yaml`,
после отдельного owner checkpoint, этот commit):
- `@prisma/client` 6.19.0 (dependency) и `prisma` 6.19.0 (devDependency) — exact, совпадают с общей
  `prisma/schema.prisma` и версией, использованной для существующей migration. `npm update` не
  выполнялся; Next.js/React/прочие зависимости не менялись.
- Единственный источник Prisma-схемы остаётся `prisma/schema.prisma` — не скопирована и не
  продублирована в `titanor-time-app`. Docker build получает её из repository root через build
  context `.` (repo root) + `titanor-time-app/Dockerfile` (ранее было `./titanor-time-app`) — с
  отдельным `titanor-time-app/Dockerfile.dockerignore`, не затрагивающим корневой `.dockerignore`
  публичного сайта. `prisma generate` выполняется во время build; `prisma migrate` во время build не
  выполняется.
- `titanor-time-app/lib/prisma.ts` — один `PrismaClient` на process, singleton через `globalThis` для
  hot-reload в dev, без запросов к БД при импорте модуля, без credentials в исходном коде.
- `GET /api/ready` — выполняет `SELECT 1` через Prisma; `200 {"status":"ready","service":"titanor-time","database":"connected"}`
  при успехе, `503 {"status":"not_ready","service":"titanor-time","database":"unavailable"}` при
  ошибке; ответ и server-лог не содержат DATABASE_URL/host/user/password/stack trace — лог пишет
  только фиксированную credential-free строку.
- `GET /api/health` не изменён — остаётся liveness-эндпоинтом, не зависящим от БД.
- Dockerfile: `node:22-bookworm-slim` (не alpine — glibc, совместим с Prisma query engine), три
  стадии (dependencies/builder/runner), `prisma generate` только в builder, non-root (`USER node`),
  standalone output, слушает `0.0.0.0:3000` внутри контейнера.
- **Исправлена архитектурная ошибка, найденная в этой же задаче**: сеть с `internal: true` блокирует
  не только outbound-трафик контейнера, но и весь host→container port-publishing путь — с `app`
  только на `internal` `127.0.0.1:3200` физически не слушал ни разу, несмотря на healthy-статус
  контейнера. Исправлено добавлением второй, обычной (не `internal`) network `lan` только для `app`;
  `db` остаётся исключительно на `internal` и по-прежнему полностью недоступен снаружи Docker.
- `.env.titanor-time` (локальный, не закоммичен) дополнен `DATABASE_URL` на основе уже существующих
  `POSTGRES_*` значений; `.env.titanor-time.example` дополнен пустым placeholder `DATABASE_URL=`.
  `chmod 600` сохранён; `git check-ignore -v` подтверждён.
- **Инцидент и устранение**: в ходе проверки один раз был выполнен полный (без `--quiet`)
  `docker compose config`, который вывел реальный `POSTGRES_PASSWORD`/`DATABASE_URL` в открытом виде.
  Пароль немедленно ротирован через `ALTER USER ... WITH PASSWORD` (без потери данных — миграция и
  таблицы сохранены), `.env.titanor-time` обновлён новым значением; старый (утёкший) пароль более не
  действителен. Далее использовался только `docker compose config --quiet` либо вывод с ручной
  редакцией строк `PASSWORD`/`DATABASE_URL`.
- Первый реальный запуск: `docker compose -f compose.titanor-time.yaml up -d --build app` — образ
  собран, `app` healthy (healthcheck на `http://127.0.0.1:3000/api/ready`), `depends_on: db:
  condition: service_healthy` сохранён.
- Подтверждено: `GET http://127.0.0.1:3200/api/health` → `200`; `GET .../api/ready` → `200,
  database: connected`; `GET .../` → `200`. `db` port по-прежнему не опубликован. Во всех 24
  application tables суммарно 0 строк; `_prisma_migrations` — 1 запись, `finished_at` заполнен,
  `rolled_back_at` пуст (без изменений). `titanorgroup-web-1`, `collab-studio-app-1`,
  `collab-studio-postgres-1` — те же `StartedAt`/`RestartCount`, не перезапускались;
  `titanorgroup.fi`/`collabstudio.run` — `200` до и после.
- Примечание о ходе задачи: `db` был один раз пересоздан (`Recreate`, не просто restart) как побочный
  эффект смены содержимого `.env.titanor-time` при ротации пароля (Compose учитывает содержимое
  `env_file` в конфигурационном хэше сервиса) — тот же named volume, данные и миграция не пострадали;
  это не было намеренным/лишним перезапуском `db`.

**Первый backup + verified restore постоянной database — устарел, см. новый backup ниже**
(`backups/` — не закоммичен, добавлен в `.gitignore`, commit `c0f5425`):
- `pg_dump -F c` из `titanor-time-db-1` в локальный файл `backups/titanor-time-<timestamp>.dump`.
- Восстановление (`pg_restore`) выполнено **только** в отдельный одноразовый throwaway PostgreSQL 16
  (`--rm`, tmpfs, случайные credentials, `127.0.0.1`-only dynamic port, удалён сразу после проверки)
  — реальный `db` не трогался операцией restore.
- Восстановленный каталог полностью совпал с оригиналом: 24 application-таблицы, 8 enum, 21 CHECK,
  6 EXCLUDE, 55 FK, 11 функций, 13 триггеров, `btree_gist`, точные имена `CK-08`/`CK-13`,
  `_prisma_migrations` — 1 запись (на момент backup, до второй migration).
- Throwaway restore-контейнер удалён; реальный `db`/`app` не перезапускались этой операцией.

**Вторая migration: Role/Permission/RolePermission/UserRole** (`prisma/schema.prisma`,
`prisma/migrations/20260728161708_add_role_permission_user_role/migration.sql`, commit `c0f5425`,
после отдельного owner checkpoint):
- Причина: у foundation-схемы не было ни единого поля/таблицы для хранения роли пользователя —
  `Role`/`Permission`/`UserRole` описаны в `03_DATA_MODEL_ERD.md`, но сознательно не входили в первую
  migration (см. §5 выше, `IMPLEMENTATION_STATUS.md` истории). Без этого «первый SUPER_ADMIN» не мог
  быть технически отмечен как SUPER_ADMIN нигде в БД.
- Схема дизайна показана и утверждена владельцем до создания migration (сущности/поля/связи/
  ограничения/индексы/правила удаления), в соответствии с `AGENT_RULES.md` §11.
- Добавлены таблицы `Role`, `Permission`, `RolePermission`, `UserRole` (все FK `onDelete: Restrict`).
  `UserRole` включает частичный unique index `ex_user_role_active_unique` на `("userId","roleId")
  WHERE "validTo" IS NULL` — не выразим через Prisma `@@unique`, добавлен как raw SQL прямо в эту
  migration (frozen register `05_RAW_SQL_REGISTER.md`, scoped только к первой migration, не менялся).
  4 фиксированные строки `Role` (`SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`, тексты из
  `02_ROLE_PERMISSION_MATRIX.md` §1) засеяны прямо в migration. `Permission`/`RolePermission` оставлены
  пустыми намеренно.
- Migration сгенерирована offline (`prisma migrate diff --from-schema-datamodel <снимок схемы до
  правки> --to-schema-datamodel prisma/schema.prisma --script`), затем протестирована с нуля (обе
  migrations вместе) на одноразовом PostgreSQL 16: `prisma migrate deploy` — exit 0, идемпотентный
  повтор — «No pending migrations to apply», `_prisma_migrations` — 2 записи, обе `finished`. Позитивный
  и негативный поведенческий тест `ex_user_role_active_unique` (дубликат активной роли отклонён;
  истёкшая + новая активная роль одного пользователя/роли — разрешены) прошёл на этой одноразовой
  базе. Только после этого применена к реальной `titanor-time-db-1` (тем же throwaway-node-container
  паттерном, что и первая migration) — exit 0, идемпотентность подтверждена повторно.
- После применения к реальной базе: 28 таблиц (24+4), `Role` содержит ровно 4 строки с ожидаемыми
  именами, `User`/`UserRole`/`RolePermission`/`Permission` — 0 строк (никакого seed пользователей).
  `app`/`db` не перезапускались этой операцией; `titanorgroup-web-1`/CollabStudio — те же
  `StartedAt`/`RestartCount`; `titanorgroup.fi`/`collabstudio.run` — `200`.
- Первая initial migration (hash `a0d2059582079846a0c70658b24c6162830ae5b8e3e9ffcffe077ded4c862d7b`)
  и `05_RAW_SQL_REGISTER.md` (hash `8c014d664319c74ee17c3aff9c42d023a86f8456c2cf6fdd0dce591b5bdcd9c2`)
  — не изменены, подтверждено повторной проверкой hash.

**Свежий backup + verified restore после второй migration** (T5.4, этот commit — заменяет устаревший
первый backup выше):
- `pg_dump -F c` из реальной `titanor-time-db-1`; файл создан с `umask 077`, права `600` (проверено
  `stat`), каталог `backups/` по-прежнему не отслеживается git.
- Восстановление только в новый, отдельный, одноразовый throwaway PostgreSQL 16 (`--rm`, tmpfs, без
  named volume, порт только `127.0.0.1:<random>`, единый shell lifecycle с cleanup trap, пароль
  только в памяти процесса, контейнер удалён по завершении) — реальный `db` не трогался restore.
- Подтверждены counts и ключевые identities (это **не** построчный re-audit каждого
  constraint/trigger — тот уже пройден в §8 на идентичном migration.sql): 28 application-таблиц,
  8 enum, 21 CHECK, 6 EXCLUDE, **59 FK** (55 из первой migration + 4 из второй — проверено фактическим
  catalog count, не предположением), 11 функций, 13 триггеров, `_prisma_migrations` — 2 записи, обе
  `finished`; `Role` содержит ровно `SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`; `User`/`UserRole`/
  `Permission`/`RolePermission` — 0 строк.
- Throwaway restore-контейнер удалён; реальный `db`/`app` не перезапускались этой операцией.

**Prisma Client регенерирован, `app` пересобран** (T5.4, этот commit):
- `prisma validate`/`prisma generate --schema prisma/schema.prisma` из корня — Prisma 6.19.0, exit 0;
  клиент теперь включает `Role`/`Permission`/`RolePermission`/`UserRole`.
- `npx tsc --noEmit` и `npm run build` в `titanor-time-app` — оба зелёные (локальный sibling-directory
  edge case из предыдущих задач устранён рабочим приёмом: сгенерированный клиент физически
  скопирован, а не симлинкнут, в `titanor-time-app/node_modules` — Turbopack не резолвит симлинки за
  пределы своего package boundary; сам приём не влияет на Docker build, который остаётся
  самодостаточным).
- `docker compose build app` — success; `docker compose -f compose.titanor-time.yaml up -d --build
  --no-deps app` — пересоздан только `app` (`db` остался `Running`, не пересоздавался); `app`
  healthy, `/api/health`/`/api/ready` (`database: connected`) — оба `200`; опубликован только на
  `127.0.0.1:3200`; `db` по-прежнему без published port.

**Bootstrap CLI первого SUPER_ADMIN** (`titanor-time-app/scripts/bootstrap-super-admin.ts`, T5.4,
этот commit):
- Зависимости: `argon2` 0.45.1 (dependency), `tsx` 4.23.1 (devDependency) — только эти, `npm update`
  не выполнялся, Next.js/React/прочее не менялись.
- Пароль: только интерактивный скрытый (no-echo) TTY-ввод дважды подряд с подтверждением совпадения;
  никогда не через CLI-аргумент (явно отклоняется с ошибкой) или environment; нигде не записывается
  на диск; минимум 16 символов; хешируется Argon2id (`$argon2id$...`) непосредственно перед вызовом
  транзакции — plaintext нигде не логируется и не хранится.
- `requireRealTty()` отклоняет запуск без настоящего TTY на обоих stdin/stdout.
- `username`: обязателен, 3-64 символа, нормализуется в lowercase (и внутри `parseArgs`, и
  избыточно/защитно внутри самой `bootstrapSuperAdmin()` — устраняет класс ошибок, если функцию
  когда-либо вызовут напрямую без прохождения через CLI-парсинг). `email`: опционален, аналогично
  нормализуется. `locale`: `FI` по умолчанию, `FI`/`EN`/`RU` допустимы. Создаваемый `User`:
  `status=ACTIVE`, `employeeId=null`, `twoFactorEnabled=false`.
- Роль ищется строго по точному имени `SUPER_ADMIN` в уже существующей таблице `Role` (не создаётся
  заново, свободный текст не допускается).
- `User` и `UserRole` создаются в одной Prisma `$transaction` с `isolationLevel: Serializable`,
  первым действием — `pg_advisory_xact_lock` (фиксированный ключ через `hashtext()`, не magic-число),
  защищающий от гонки двух одновременных первых запусков.
- Если активный `SUPER_ADMIN` уже существует, либо `username`/`email` заняты — завершение без
  изменений (`AlreadyExistsError`, отдельные, не путаемые между собой message). Dry-run режим:
  выполняет все проверки, ничего не пишет (гарантировано тем же transaction-throw механизмом, что и
  реальные ошибки — Prisma откатывает транзакцию целиком).
- Успешный вывод — строго `{ userId, username, locale, role }`, без пароля/хеша/иных полей.
- Проверено **только на одноразовом PostgreSQL 16** (обе migrations с нуля): 4 роли подтверждены;
  dry-run не создаёт строк; реальное создание даёт ровно 1 `User` + 1 активный `UserRole`
  (`SUPER_ADMIN`); `passwordHash` — валидный `$argon2id$`, подтверждён `argon2.verify()`, plaintext
  отсутствует в хеше; повтор с тем же (и с любым другим) `username` при уже существующем активном
  `SUPER_ADMIN` отклонён без новых строк; отдельно (симулированный «уже существующий обычный
  `User`», ещё до появления активного `SUPER_ADMIN`) подтверждена изолированная проверка занятости
  `username`/`email`; искусственный сбой между `tx.user.create` и `tx.userRole.create` (тот же паттерн
  Serializable transaction + advisory lock) откатился полностью — 0 лишних строк. Одноразовый
  контейнер и весь тестовый код удалены после проверки, ничего не оставлено в репозитории.
- В ходе именно этой проверки найдены и исправлены две ошибки до применения к какой-либо базе:
  `pg_advisory_xact_lock()` возвращает `void`, что несовместимо с `$queryRaw` (исправлено на
  `$executeRaw`); и `main()` запускался как побочный эффект самого импорта модуля, а не только при
  прямом запуске (добавлена проверка `require.main === module`).
- **Реальный `SUPER_ADMIN` в постоянной базе не создан.** `User`/`UserRole` в `titanor-time-db-1`
  по-прежнему 0/0 — не тронуты этой задачей. `Permission`/`RolePermission` по-прежнему пусты; перед
  реальным permission-guard понадобится отдельная задача — seed полной permission-матрицы из
  `02_ROLE_PERMISSION_MATRIX.md`.

**Первый production SUPER_ADMIN создан** (`titanor-time-db-1`, владелец лично запустил bootstrap CLI
из своего терминала с `-it`, этот commit — документация only, код/схема/данные этой задачей не
менялись):
- Источник состояния: сообщено владельцем напрямую в чате после реального запуска. Независимая
  read-only проверка агентом (`docker exec` в `titanor-time-db-1` с `SELECT count(*)`-запросами, без
  записи) была заблокирована политикой инструментов до выполнения — попытка не повторялась, other
  db/bootstrap actions этой задачей не выполнялись. Ниже — сообщённое, не самостоятельно
  верифицированное агентом, состояние.
- `username=andrei.sakki`, `status=ACTIVE`, `locale=FI`, ровно одна активная роль `SUPER_ADMIN`
  (`UserRole.validTo IS NULL`).
- `passwordSet=true`, hash-алгоритм Argon2id (`$argon2id$...`) — сам хеш не выводился в чат и не
  записан в этот документ, согласуется с CLI-контрактом (§5 выше, «Bootstrap CLI первого
  SUPER_ADMIN»).
- Каталог: `User=1`, `UserRole=1` (активная), `Role=4` (без изменений — `SUPER_ADMIN`/`ADMIN`/
  `FOREMAN`/`WORKER`), `activeSuperAdmins=1`. `Permission`/`RolePermission` по-прежнему пусты (без
  изменений).
- Idempotency-guard подтверждён на реальной базе: повторный запуск того же bootstrap-скрипта завершился
  без изменений — `No changes made: An active SUPER_ADMIN already exists.` Эта задача **не** запускала
  bootstrap повторно — сообщённый результат относится к попытке владельца, предшествовавшей этой
  документационной задаче.
- `db`/`app` этой задачей не перезапускались и не пересоздавались; migrations и `prisma/schema.prisma`
  не менялись; `passwordHash` не читался и не изменялся этой задачей.
- Governance-ограничения для `SUPER_ADMIN` (последний активный не удаляется/не блокируется/не
  понижается, второй `SUPER_ADMIN` — только через аутентифицированный admin API, не через bootstrap
  CLI, role-изменения — в audit trail после появления модели `AuditEvent`) зафиксированы отдельно и
  остаются в силе для последующих задач (login/role guard/admin API) — сам bootstrap CLI и так уже
  отказывается создавать второго `SUPER_ADMIN` (см. §5 выше).

**Третья migration: `UserSession`, T5.5 первый под-шаг** (`prisma/schema.prisma`,
`prisma/migrations/20260729220524_add_user_session/migration.sql`, этот commit, после отдельного
owner checkpoint на дизайн):
- Причина: `PROJECT_ROADMAP.md` ЭТАП 5 T5.5 (Login) требует secure server-side сессии;
  соответствующей модели в схеме не было (см. §9 предыдущей версии этого файла).
- Дизайн — точное соответствие `03_DATA_MODEL_ERD.md` §4.1 (уже утверждённая архитектура), без
  отклонений: `id`, `userId FK → User` (`onDelete: Restrict`, как у `UserRole`/`RolePermission` —
  `User` никогда не удаляется физически), `tokenHash` (unique, `SHA-256` opaque-токена ≥32 байта —
  сам токен только в cookie, не в базе), `authLevel` (новый enum `AuthLevel`: `PASSWORD` default,
  `MFA_VERIFIED`), `mfaVerifiedAt`, `expiresAt`, `lastSeenAt`, `ipAddress`, `userAgent`, `revokedAt`
  (soft-revoke — сессия никогда не удаляется физически, только помечается), `createdAt`. Индексы:
  unique на `tokenHash`, plain на `userId` и `expiresAt`. Дизайн показан владельцу и подтверждён до
  создания migration (`AGENT_RULES.md` §11).
- Migration сгенерирована offline (`prisma migrate diff --from-schema-datamodel <снимок до правки>
  --to-schema-datamodel prisma/schema.prisma --script`) — только `CREATE TYPE "AuthLevel"`,
  `CREATE TABLE "UserSession"`, три индекса, один FK; ни одна из первых двух migrations не изменена.
- Проверено **только на одноразовом PostgreSQL 16** (`--rm`, tmpfs, случайные credentials, порт
  только `127.0.0.1:<random>`, без named volume): `prisma migrate deploy` с нуля применил все три
  migrations подряд, exit 0; повторный `deploy` — «No pending migrations to apply», `migrate status`
  — «Database schema is up to date!» (идемпотентность подтверждена). Catalog-аудит: enum `AuthLevel`
  содержит ровно `PASSWORD`/`MFA_VERIFIED` в этом порядке; 11 колонок `UserSession` — точные
  имена/типы/nullability совпадают с дизайном; 4 индекса (`_pkey`, unique `tokenHash`, `userId`,
  `expiresAt`); ровно один FK (`UserSession_userId_fkey → User`); `_prisma_migrations` — 3 записи, все
  `finished`, ни одной `rolled_back`; существующие данные (`Role` = 4 строки, `User`/`UserSession` = 0)
  не задеты. Поведенческие тесты (всё внутри одной транзакции, завершённой `ROLLBACK` — ничего не
  закоммичено): дубликат `tokenHash` отклонён (`unique constraint violation`); попытка удалить `User`,
  на которого ссылается `UserSession`, отклонена (`foreign key constraint violation` —
  `onDelete: Restrict` работает); soft-revoke через `revokedAt` подтверждён. Одноразовый контейнер
  удалён, временные файлы удалены, `docker ps`/`docker volume ls` для реальных сервисов не менялись.
- Login-эндпоинт (password-check, выдача сессии, `Set-Cookie`, rate limit, блокировка неактивных
  пользователей) этой (тестовой) задачей **не** реализован — только схема хранения сессии.

**Third migration применена владельцем к реальной `titanor-time-db-1`, `app` пересобран** (этот
commit, после отдельного owner checkpoint):
- Инструмент политики окружения заблокировал агенту прямое обращение к `titanor-time-db-1` — как
  read-only `docker exec` (см. §2/§5 выше, история с bootstrap), так и network-based one-off
  контейнер для применения migration. Поэтому команды выполнил лично владелец на VPS, тем же
  паттерном, что первую и вторую migration (одноразовый `node:22`-контейнер, подключённый только к
  `titanor-time_internal`, `DATABASE_URL` только in-memory через `.env.titanor-time`, без npm
  install — bind-mount существующего `node_modules`).
- `prisma migrate deploy --schema prisma/schema.prisma` (владелец): «Datasource "db": PostgreSQL
  database "titanor_time" ... at "db:5432"» → «Applying migration `20260729220524_add_user_session`»
  → «All migrations have been successfully applied.» — точный вывод, не пересказ.
- Отдельная попытка `npx prisma migrate status` сразу после — выполнена владельцем **вне** обёртки
  (без `source .env.titanor-time`/без docker-контейнера), поэтому закономерно упала с `P1012
  Environment variable not found: DATABASE_URL` — это ошибка команды/окружения запуска, не признак
  проблемы с самой migration. Отдельного успешного повторного `migrate status` с явным «Database
  schema is up to date!» против реальной базы не зафиксировано.
- `docker compose -f compose.titanor-time.yaml build app` + `up -d --no-deps app` (владелец) — образ
  пересобран (`prisma generate` в builder-стадии против уже обновлённой `prisma/schema.prisma`),
  `titanor-time-db-1` остался `Running` (не пересоздан — подтверждено выводом `up`: `Container
  titanor-time-db-1 Running` без `Recreate`), `titanor-time-app-1` создан заново и стал `healthy`.
- Проверено этим агентом (доступные, не заблокированные политикой действия — `docker compose ps`,
  `curl` на `127.0.0.1:3200`, `docker exec` в **`app`**, не в `db`): `titanor-time-app-1` — `healthy`;
  `GET /api/health` → `200 {"status":"ok",...}`; `GET /api/ready` → `200
  {"status":"ready",...,"database":"connected"}`; сгенерированный внутри образа Prisma Client
  (`node_modules/.prisma/client/index.d.ts` в контейнере `app`) содержит `UserSession` (прямой grep,
  не предположение) — подтверждает, что клиент действительно регенерирован из схемы с новой моделью.
  Прямой `prisma migrate status` внутри `app` не выполним — `runner`-стадия образа намеренно не
  копирует `prisma/schema.prisma`/`migrations/` (не нужны в runtime, см. commit `122c884`
  про standalone-трассировку) — попытка дала ожидаемую `schema.prisma not found`, не ошибку базы.
  `titanor-time-db-1` — `Up 32 hours` (то же время работы, что до этой задачи, не пересоздан);
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` не менялись.
- **Итог:** миграция подтверждена применённой к реальной базе прямым выводом `migrate deploy`
  владельца + косвенно подтверждена рабочим `app` с регенерированным клиентом; отдельного успешного
  `migrate status`/catalog-запроса против самой `titanor-time-db-1` в этой записи нет (агенту
  заблокировано, владелец его не переповторил в рабочей обёртке). Если нужна полная уверенность —
  повторить `migrate status` в той же обёртке, что и `migrate deploy` (см. §11).

**Root tsconfig fix** (`tsconfig.json`, commit `3c39d84`, отдельная изолированная задача до
login-эндпоинта): корневой `tsconfig.json` через `**/*.ts`/`**/*.tsx` захватывал файлы
`titanor-time-app` — самостоятельного подпроекта со своим `tsconfig.json` (включая alias `@/*`),
из-за чего `npx tsc --noEmit` из корня падал на `Cannot find module '@/lib/prisma'`, хотя собственная
проверка `titanor-time-app` всегда была зелёной. Причина подтверждена на чистом HEAD без изменений
этой задачи. Минимальный фикс — `titanor-time-app` добавлен в `exclude` корневого `tsconfig.json`;
`titanor-time-app/tsconfig.json`, Prisma schema/migrations, контейнеры не менялись. После очистки
`tsconfig.tsbuildinfo` (оба проекта) обе проверки — `npx tsc --noEmit` из корня и из
`titanor-time-app` — `exit 0`, стабильно на повторном запуске; `git diff --check` — `exit 0`.

**`POST /api/auth/login` — T5.5 core** (`titanor-time-app/app/api/auth/login/route.ts`,
`titanor-time-app/lib/api-error.ts`, `titanor-time-app/lib/rate-limit.ts`,
`titanor-time-app/lib/session.ts`, этот commit):
- Контракт — точное соответствие `04_ADMIN_FIRST_API_CONTRACTS.md` §0/§1: `identifier` (username или
  email, регистронезависимо, одно поле — не два) + `password`; `httpOnly`/`Secure`/`SameSite=Lax`
  cookie `tt_session` с непрозрачным токеном ≥32 байта, в базе — только `SHA-256(token)` в
  `UserSession.tokenHash`; обязательный `X-Requested-With: titanor-time` (иначе `403 CSRF_REJECTED`);
  единый формат ошибок с `X-Request-Id`; rate limit 5/15мин на `identifier` + 50/15мин на IP → `429
  RATE_LIMITED`.
- Порядок проверок — статус аккаунта проверяется **до** пароля: `PENDING_ACTIVATION`-аккаунт обычно
  не имеет `passwordHash` вообще (выставляется отдельным `set-initial-password`-flow), поэтому если
  проверять пароль первым, `403 ACCOUNT_PENDING_ACTIVATION` была бы физически недостижима. `DEACTIVATED`
  проверяется тем же способом — до пароля. `OFFBOARDING` login **разрешён** (не блокируется) — по
  правилу `03_DATA_MODEL_ERD.md` §4.2 (offboarding сохраняет доступ до завершения незакрытых табелей).
  Неизвестный `identifier` — единственный случай, где нет аккаунта, статус которого можно раскрыть:
  выполняется `argon2.verify` против фиксированного dummy-хеша ради timing-паритета с реальной
  проверкой пароля, затем `401 INVALID_CREDENTIALS`.
- Два допущения, не зафиксированных ни в одном архитектурном документе на момент этой задачи (отмечены
  комментарием прямо в коде, не только здесь): срок жизни сессии — 30 дней (`SESSION_DURATION_MS`,
  `lib/session.ts`); хранилище rate-limit — in-memory `Map` (`lib/rate-limit.ts`), корректно только
  для текущего single-instance деплоя (`compose.titanor-time.yaml` — один `app`-реплик), потребует
  общего хранилища (например Redis) при масштабировании на несколько инстансов.
- **Не входит в эту задачу**: `GET /api/auth/session`, `POST /api/auth/logout`/`logout-all`, и сама
  middleware проверки `UserSession` на остальных роутах (login только выдаёт сессию, ничего пока её не
  читает) — отдельные последующие задачи. `LOGIN_SUCCEEDED`/`LOGIN_FAILED` audit-события не пишутся —
  модели `AuditEvent` всё ещё нет (см. §9).
- **Проверено только на одноразовом PostgreSQL 16** (`--rm`, tmpfs, случайные credentials, без named
  volume): все три migrations с нуля, засеяны по одному тестовому `User` на каждый статус
  (`ACTIVE` с двумя ролями `WORKER`+`FOREMAN`, `PENDING_ACTIVATION` без `passwordHash`, `DEACTIVATED`,
  `OFFBOARDING`). Приложение запущено локально (`next dev`, не Docker) поверх этой базы, порт только
  `127.0.0.1:3987` (не production-порт `3200`). Сценарии, все через `curl`:
  - без `X-Requested-With` → `403 CSRF_REJECTED`;
  - пустое тело → `400 VALIDATION_ERROR` с `fieldErrors` на оба поля;
  - неизвестный `identifier` → `401 INVALID_CREDENTIALS`;
  - верный `identifier`, неверный пароль → `401 INVALID_CREDENTIALS`;
  - верный пароль, `ACTIVE`, две активные роли → `200`, `Set-Cookie: tt_session=...; Path=/;
    Max-Age=2592000; Secure; HttpOnly; SameSite=lax`, тело `{"user":{"id","username","roles":
    ["WORKER","FOREMAN"],"locale":"FI"}}`;
  - тот же пользователь через email вместо username, в верхнем регистре → `200` (регистронезависимая
    нормализация подтверждена);
  - `PENDING_ACTIVATION`, любой пароль → `403 ACCOUNT_PENDING_ACTIVATION`;
  - `DEACTIVATED`, **верный** пароль → `403 ACCOUNT_DEACTIVATED` (не `200`, не `401`);
  - `OFFBOARDING`, верный пароль → `200` (login разрешён, подтверждает правило выше);
  - rate limit по `identifier`: 5-я подряд попытка на тот же `identifier` — ещё разрешена (`401`),
    6-я — `429 RATE_LIMITED`; независимый `identifier` с того же IP в этот момент — не заблокирован
    (счётчики раздельные).
  - Прямая проверка в БД (throwaway, не production): `SHA-256` реального токена из `Set-Cookie` в
    ответе совпал точно с `UserSession.tokenHash` соответствующей новой строки; `authLevel=PASSWORD`;
    `User.lastLoginAt` обновлён.
  - Тестовый dev-сервер поднимался только на `127.0.0.1` (не `0.0.0.0`) — после первой попытки,
    случайно забиндившей все интерфейсы, перезапущен с явным `-H 127.0.0.1` до продолжения тестов.
  - Очистка: dev-сервер остановлен (`pkill`, подтверждено `pgrep`+`curl` на порт), одноразовый
    контейнер удалён, тестовый seed-скрипт и временные файлы удалены, ничего не закоммичено из
    тестового прогона.
- **Реальные `titanor-time-db-1`/`app` этой задачей не тронуты** — эндпоинт не вызывался против
  production, `app`-контейнер не пересобирался. Локальный Prisma Client в `titanor-time-app/node_modules`
  регенерирован и скопирован (тот же приём, что раньше — физическая копия, не symlink) только для
  типизации/локального теста; Docker-образ `app` эту копию не использует (пересобирает свою во время
  build).

**Login задеплоен на реальный `app` + структурная проверка на реальной базе** (тот же commit `ecb37b2`
как код, деплой отдельным шагом сразу после): `docker compose build app` + `up -d --no-deps app` —
`db` не пересоздавался (`Running`, то же время), `app` пересоздан, healthy. Проверено без знания
реального пароля (агенту он не известен и не должен быть): отсутствие `X-Requested-With` → `403`;
пустое тело → `400`; неизвестный `identifier` → `401`; **`andrei.sakki` + заведомо неверный пароль →
`401`** — последнее прямо подтверждает, что реальный пользователь найден в `titanor-time-db-1`, его
`status` дошёл до проверки пароля (не `PENDING_ACTIVATION`/`DEACTIVATED`), и сама проверка пароля
физически выполняется против реальной строки, а не заглушки.

**`reset-password` CLI** (`titanor-time-app/scripts/reset-password.ts`,
`titanor-time-app/lib/tty-prompt.ts`, commit `be598f8`) — владелец не мог вспомнить пароль,
установленный во время bootstrap; самостоятельного «forgot password» flow ещё нет
(`PasswordResetToken`/доставка — более поздняя, ещё не начатая фича), а bootstrap CLI намеренно
одноразовый и второй раз не запускается:
- Тот же security-паттерн, что bootstrap: новый пароль только через скрытый real-TTY double-prompt,
  никогда не CLI-аргументом/env var; минимум 16 символов — **не понижен**, несмотря на более ранний
  вопрос владельца про более короткий пароль (см. обсуждение в чате) — это сброс credentials
  потенциально для `SUPER_ADMIN`, самого чувствительного аккаунта.
- Общий TTY-код (`promptHidden`) вынесен в `lib/tty-prompt.ts`, чтобы не дублироваться между
  скриптами; `bootstrap-super-admin.ts` отдельно перепроверен — неизменное поведение (non-TTY
  отклонение даёт тот же `Usage error`, exit 1).
- Сброс пароля в той же транзакции отзывает все активные `UserSession` этого пользователя —
  забытый/потенциально скомпрометированный пароль означает, что и старые сессии доверять не стоит.
- Проверено на одноразовом PostgreSQL 16: non-TTY, `--password`-аргумент отклонён, отсутствующий
  `--username`, dry-run (ничего не пишет — старый пароль и сессия по-прежнему валидны после),
  несуществующий username, реальный сброс (прямой `argon2.verify()`: старый пароль перестал работать,
  новый заработал; единственная активная сессия отозвана), и сквозной сценарий через настоящий
  login-эндпоинт (старый пароль → `401`, новый → `200`). Одноразовый контейнер и все временные
  seed/invoke-скрипты удалены.
- Задеплоен на реальный `app` тем же паттерном (`build` + `up -d --no-deps`) — `db` не пересоздавался;
  `docker exec ... npm run` внутри реального образа подтвердил наличие обеих команд
  (`bootstrap:super-admin`, `reset-password`).

**Реальный пароль `SUPER_ADMIN` сброшен владельцем + реальный login подтверждён** (этот commit):
владелец лично выполнил `docker compose exec -it app npm run reset-password -- --username=andrei.sakki`
на VPS (реальный `-it` TTY), затем вошёл через `POST /api/auth/login` против реальной
`titanor-time-db-1`. Точный ответ (не пересказ): `200`, `{"user":{"id":"f227b077-a84d-4f4c-8acc-c13b38728e1a","username":"andrei.sakki","roles":["SUPER_ADMIN"],"locale":"FI"}}`.
Как и раньше, это владелец-сообщённый факт, не независимо перепроверенный агентом запросом к базе —
`docker exec`/network-based доступ к `titanor-time-db-1` заблокирован агенту политикой инструментов
(см. §2/§5 выше). Прямой HTTP-ответ с реальным (не тестовым) `id` и точной ролью — сильное прямое
доказательство сам по себе, не только словесное подтверждение. Второй вызов той же командой сразу
после вернул `401 INVALID_CREDENTIALS` — ожидаемо, скорее всего опечатка при повторном скрытом вводе
пароля, не проблема системы (неверный пароль корректно отклонён, не пропущен).

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

- Seed permission-матрицы (заполнение `Permission`/`RolePermission` из
  `02_ROLE_PERMISSION_MATRIX.md` — таблицы созданы, но пусты; нужно перед реальным permission guard).
- Password delivery как общий процесс для будущих (не первого) аккаунтов (доставка пароля/кода
  активации при создании новых пользователей через admin API — для первого `SUPER_ADMIN` уже закрыто:
  владелец ввёл собственный пароль напрямую в TTY, см. §5).
- MFA production gate (`REQUIRE_MFA_FOR_ADMIN=true`).
- `GET /api/auth/session`, `POST /api/auth/logout`/`logout-all`, и middleware чтения `UserSession` на
  защищённых роутах — не начаты (login задеплоен и подтверждён реальным входом `SUPER_ADMIN`, см. §5,
  но пока ничего не проверяет выданную им сессию на других роутах).
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
- ~~Известен ли первый `SUPER_ADMIN` и способ передачи первого пароля~~ — **закрыто этим commit**:
  первый `SUPER_ADMIN` (`andrei.sakki`) создан в постоянной базе, пароль введён владельцем лично через
  интерактивный TTY bootstrap CLI, нигде не передавался и не проходил через чат (см. §5).

## 11. Следующий рекомендуемый шаг

Первый production `SUPER_ADMIN` (`andrei.sakki`) создан в постоянной `titanor-time-db-1` (см. §5, §2).
`UserSession` применена к реальной базе (commit `7795d3e`). Root tsconfig исправлен (commit `3c39d84`).
`POST /api/auth/login` (T5.5 core, commit `ecb37b2`) задеплоен на реальный `app` и подтверждён —
владелец сбросил забытый пароль через новый `reset-password` CLI (commit `be598f8`) и реально вошёл:
`200`, корректные `id`/`username`/`roles: ["SUPER_ADMIN"]` (см. §5, этот commit). `db` ни разу не
пересоздавался за все эти шаги.

**Открытый хвост от более ранней задачи:** явный успешный `prisma migrate status` против самой
`titanor-time-db-1` всё ещё не зафиксирован (см. §5) — не блокирует, но стоит закрыть при случае.

Следующей отдельной задачей:
1. `GET /api/auth/session` + `POST /api/auth/logout`/`logout-all` (§1 контракта) — без них
   выданная login'ом сессия ничем не проверяется и не отзывается.
2. Route-protection middleware, читающая `UserSession` по cookie `tt_session` (`SHA-256` → поиск по
   `tokenHash`, проверка `expiresAt`/`revokedAt`) — нужна любому будущему защищённому route.
3. Только после этого: role guard (T5.6) — вместе с ним seed `Permission`/`RolePermission` по мере
   реализации каждого endpoint (не одним массовым шагом — см. обоснование в комментарии второй
   migration). Role guard и любой будущий role-management endpoint обязаны на сервере запрещать
   удаление/блокировку/понижение последнего активного `SUPER_ADMIN` и писать grant/revoke роли в audit
   trail (требует модели `AuditEvent`, которой пока нет — см. §9). Второй `SUPER_ADMIN` создаётся
   только через аутентифицированный admin API, не через bootstrap CLI. Не начинать реальный admin API
   или UI раньше отдельного подтверждения владельца. Не запускать `app` в production и не менять
   CollabStudio без отдельного checkpoint владельца.

## 12. Правило обновления

1. Каждая следующая задача сначала читает этот файл.
2. После успешного commit агент обновляет статус отдельной минимальной задачей либо включает
   обновление в task scope, если это заранее разрешено владельцем.
3. Запись содержит commit hash, изменённые файлы и фактические проверки.
4. Планируемая работа не записывается как выполненная.
5. Чат не является единственным хранилищем отчёта — этот файл им является.
