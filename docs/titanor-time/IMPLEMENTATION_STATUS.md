# Titanor Time — Implementation Status

Обновлено: 2026-07-28 09:49 Europe/Helsinki
Ветка: feature/titanor-time-foundation
HEAD на момент этого аудита (runtime-тест): bebd6aab5f7a041e6272f24fe32db105ca04f92b
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

Existing initial migration была применена к чистому одноразовому PostgreSQL 16 (изолированный
Docker-контейнер, полностью удалён после проверки). Это не означает создание production/dev базы
Titanor Time и не означает production deployment. Applying the migration succeeded structurally
(`prisma migrate deploy` — exit 0, идемпотентный повтор подтверждён), и catalog-аудит подтвердил 8
enum, 24 таблицы, 55 foreign keys, 6 EXCLUDE, 11 функций, 13 триггеров, 1 extension `btree_gist`, 0
future-объектов. Однако тот же catalog-аудит выявил **подтверждённый дефект**: два из 21 CHECK
constraint (`CK-08`, `CK-13`) имеют имена длиннее 63 байт и PostgreSQL молча обрезает их при
применении миграции — фактическое имя ограничения в каталоге не совпадает с exact frozen identifier
из `05_RAW_SQL_REGISTER.md`. Это ломает документированный контракт «service identity: exact
constraint name» (register §7) для этих двух constraint. Поведенческие runtime-тесты (21 CHECK / 6
EXCLUDE / 13 триггеров) не выполнялись после обнаружения этого дефекта — задача была остановлена по
правилу «подтверждённый дефект → зафиксировать, не исправлять, не расширять проверку» (см. §8).
Production-код (seed, аутентификация, API, UI) по-прежнему не начат.

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
| Initial migration | `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` | создана и статически проверена, commit `30d2364`; runtime-применена к одноразовому PostgreSQL 16 — структурно успешно, но с подтверждённым дефектом именования CK-08/CK-13 (см. §7) |

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
- Runtime-применена к одноразовому PostgreSQL 16 — см. §7. Структурно успешна и идемпотентна; catalog
  identity-аудит выявил подтверждённый дефект именования у 2 из 21 CHECK constraint (см. §7, §9).
  Поведенческие runtime-тесты (позитив/негатив по каждому CHECK/EXCLUDE/триггеру) ещё не выполнены.

**Не объявляются реализованными**: seed, аутентификация, API, UI, отдельная постоянная база Titanor
Time (production или dev), поведенческие runtime-тесты 21 CHECK / 6 EXCLUDE / 13 триггеров.

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

## 8. Не начато

- Отдельный PostgreSQL-контейнер/volume для Titanor Time (production или dev).
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

## 9. Blockers и открытые решения

### Технические blockers

Есть один подтверждённый runtime-blocker (обнаружен catalog identity-аудитом §7, не статическим
текстовым аудитом §6 — статический аудит его пропустил, так как не проверял фактическую длину
идентификатора против лимита PostgreSQL):

- **CK-08 / CK-13 constraint name truncation.** Два CHECK constraint из frozen register
  (`ck_work_schedule_template_version_day_planned_break_minutes_nonnegative`, 71 байт;
  `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative`, 66 байт) превышают лимит
  PostgreSQL в 63 байта на длину идентификатора и после применения migration физически существуют в
  каталоге под другим, усечённым именем (см. точные значения в §7). Это ломает документированный
  service-mapping контракт `05_RAW_SQL_REGISTER.md` §7 («service identity: exact constraint name»)
  для этих двух constraint. Сам предикат ограничения (`>= 0`) работает корректно — проблема только в
  имени. Не исправлено в рамках этой задачи (задача — только runtime-проверка, не правка migration).
  Минимальное исправление: сократить имя constraint (и, при необходимости, синхронизировать
  `05_RAW_SQL_REGISTER.md`) до ≤63 байт отдельной задачей владельца.

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

## 10. Следующий рекомендуемый шаг

Отдельной минимальной задачей исправить только имена constraint CK-08 и CK-13 (сократить до ≤63
байт, сохранив предикат/семантику), синхронизировать `05_RAW_SQL_REGISTER.md`, и затем повторить
полный runtime-тест (structural + catalog identity + все 21 CHECK / 6 EXCLUDE / 13 триггеров
поведенчески) на новом чистом одноразовом PostgreSQL 16 — до сих пор не выполненные поведенческие
тесты остаются обязательными перед тем, как считать миграцию runtime-подтверждённой полностью. Не
затрагивать production и CollabStudio.

## 11. Правило обновления

1. Каждая следующая задача сначала читает этот файл.
2. После успешного commit агент обновляет статус отдельной минимальной задачей либо включает
   обновление в task scope, если это заранее разрешено владельцем.
3. Запись содержит commit hash, изменённые файлы и фактические проверки.
4. Планируемая работа не записывается как выполненная.
5. Чат не является единственным хранилищем отчёта — этот файл им является.
