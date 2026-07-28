# Titanor Time — Implementation Status

Обновлено: 2026-07-28 04:52 Europe/Helsinki
Ветка: feature/titanor-time-foundation
HEAD на момент аудита: 30d2364ffe58679856d6a29d91c9992a941c2b65
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
объекты register — она закоммичена, но ни разу не применялась к какому-либо PostgreSQL (ни production,
ни временному). Production-код (seed, аутентификация, API, UI) не начат. Перед продолжением
разработки необходим отдельный runtime-тест миграции на чистом временном PostgreSQL 16 — статическая
проверка не заменяет фактическое применение SQL.

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
| Initial migration | `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` | создана и статически проверена, commit `30d2364`; не применена ни к одной базе |

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

**Не объявляются реализованными**: seed, аутентификация, API, UI, runtime-применение миграции к
какой-либо базе.

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
- database connection: не выполнялось.
- migration application: не выполнялось.
- runtime test: `database application test intentionally not performed`.

## 7. Не начато

- Runtime migration test на чистом PostgreSQL 16.
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

## 8. Blockers и открытые решения

### Технические blockers

Нет. Статический аудит existing initial migration (§6) не выявил ни одного содержательного дефекта.
Единственное отмеченное расхождение — стилевая форма `RAISE EXCEPTION` (см. §6) — не является
функциональной ошибкой и не блокирует runtime-тест.

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

## 9. Следующий рекомендуемый шаг

Отдельной задачей провести runtime-применение единственной existing initial migration к чистому
временному PostgreSQL 16, проверить все ограничения, функции и триггеры, не затрагивая
production-базу и CollabStudio.

## 10. Правило обновления

1. Каждая следующая задача сначала читает этот файл.
2. После успешного commit агент обновляет статус отдельной минимальной задачей либо включает
   обновление в task scope, если это заранее разрешено владельцем.
3. Запись содержит commit hash, изменённые файлы и фактические проверки.
4. Планируемая работа не записывается как выполненная.
5. Чат не является единственным хранилищем отчёта — этот файл им является.
