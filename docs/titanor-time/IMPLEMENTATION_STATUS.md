# Titanor Time — Implementation Status

Обновлено: 2026-08-04 16:50 Europe/Helsinki
Схема `TimesheetReviewScope` (ЭТАП 7 под-задача 4, design-checkpoint перед `timesheet.submit`)
спроектирована, показана и подтверждена владельцем, протестирована на одноразовом PostgreSQL 16
(включая найденный и исправленный баг NULL-логики в CHECK), Prisma Client пересобран. Ждёт
применения владельцем к `titanor-time-db-1`: commit `a9c1838`
`PATCH /api/worker/timesheets/:timesheetId/days/:date` (ЭТАП 7 под-задача 3b) реализован —
day-state таблица, `Absence`-обоснование non-WORK `dayType`, полная замена `segments`, резолвинг
`sourceAssignmentId`, break-инварианты §5, EXCLUDE-backstop. Протестирован на одноразовом
PostgreSQL 16, migration (`timesheet.draft.edit.own` → `WORKER`) применена владельцем, `app`
пересобран и передеплоен, `healthy`: см. §5, commit `a912239`
Fix: `createAssignment()` теперь бэкфиллит `TimesheetDraftDay`/`TimesheetDraftPlannedShift` для
назначений, созданных после открытия периода (ранее — только upsert контейнеров, ноль строк дней) —
найдено при проектировании ЭТАП 7 3b, без миграции (чистый код): commit `706eb75`
`GET /api/worker/timesheets/:timesheetId`, `.../draft`, `.../current-version` (ЭТАП 7 под-задача 3a,
«Табель: read-эндпоинты») реализованы, протестированы на одноразовом PostgreSQL 16, migration
(`timesheet.read.own` → `WORKER`) применена владельцем к `titanor-time-db-1`, `app` пересобран и
передеплоен, `healthy`: см. §5, commit `baa84da`
`GET /api/worker/context`, `.../assignments/current`, `.../periods/current`, `.../periods/actionable`
(ЭТАП 7 вторая под-задача, «Кабинет работника, read-контекст») реализованы — первый живой код под
`/api/worker/*`, протестированы на одноразовом PostgreSQL 16, три WORKER-scoped migrations применены
владельцем к `titanor-time-db-1`, `app` пересобран и передеплоен, `healthy`: см. §5, commit `f002439`
`POST/GET /api/admin/periods`, `GET .../current`, `GET .../:periodId` (ЭТАП 7 первая под-задача,
«Открытие расчётного периода») реализованы, протестированы на одноразовом PostgreSQL 16, две
migrations (`period.create`/`period.read.all`) применены владельцем к `titanor-time-db-1`, `app`
пересобран и передеплоен, `healthy`: см. §5, commit `399336f`
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
`200`, correct `id`/`username`/`roles: ["SUPER_ADMIN"]`: см. §5, commit `e42025d`
`GET /api/auth/session` + `POST /api/auth/logout`/`logout-all` (§11 item 1) implemented, with shared
`lib/auth.ts` session-resolution helper — tested only on disposable PostgreSQL 16: commit `690686d`
Session/logout endpoints deployed to real `app` + structurally verified against `titanor-time-db-1`
(`app` rebuilt/recreated, `db` untouched, login regression-checked): см. §5, commit `383c7a2`
Route-protection `proxy.ts` for `/api/admin/*`+`/api/worker/*` (§11 item 1, Next.js 16 "proxy"
convention, Node.js runtime) implemented, tested via the actual standalone `server.js` against
disposable PostgreSQL 16, and deployed to real `app`: см. §5, commit `a220d39`
`hasPermission()` role-guard primitive (`lib/permissions.ts`, T5.6 first sub-step) implemented + tested
on disposable PostgreSQL 16 — not wired into any route yet (none exist under `/api/admin`/`/api/worker`)
and not deployed (no consumer to deploy): см. §5, commit `0214f80`
`GET /api/admin/cities` — first real admin endpoint (T5.6 second sub-step), fourth migration seeding
first real `Permission`/`RolePermission` row (`city.read.all` → `ADMIN`/`SUPER_ADMIN`) — implemented,
tested on disposable PostgreSQL 16, **applied to real `titanor-time-db-1` by owner** (agent blocked by
tool policy as before), deployed to real `app`, structurally verified: см. §5, этот commit
**Security incident this task**: agent printed the real `titanor_time_app` DB password (embedded in
`DATABASE_URL`, not caught by a `grep -v PASSWORD` filter) into tool output while preparing the
migration command. Owner assessed risk as insignificant (own server, chat-only exposure, no external
transmission) and explicitly declined rotation — see §10.
`prisma migrate status` against real `titanor-time-db-1` now explicitly confirmed **"Database schema is
up to date!"** — closes the long-open tail noted since §5/§11 history (owner ran it directly, commit
`834e2dc`).
`session.revoke_all.own` now enforced on `POST /api/auth/logout-all` (T5.6 third sub-step) — fifth
migration (seed to all 4 roles), applied by owner to `titanor-time-db-1`, deployed to real `app`,
structurally verified: см. §5, commit `6dbb52e`.
`AuditEvent` (T5.6 audit-trail foundation) — sixth migration, design shown to and amended by owner
(nullable `actorUserId`/`entityId`, indexed for cursor pagination), append-only enforced by a real
`BEFORE UPDATE OR DELETE` trigger, applied by owner to `titanor-time-db-1`, deployed to real `app`: см.
§5, commit `fbeec60`. No code writes to it yet — deliberately scoped out (see §11).
`X-Request-Id` now generated on every response (not just `jsonError()`, as before) across all seven
existing routes — prerequisite for `AuditEvent.requestId` — deployed to real `app`, structurally
verified: см. §5, commit `bf75962`.
`createAuditEvent()` shared helper (`lib/audit.ts`) implemented — writes one `AuditEvent` row via the
same Prisma transaction client as the business action, atomicity proven on disposable PostgreSQL 16
(rollback test: neither the business row nor the audit row exists after a simulated failure). No route
calls it yet, not deployed: см. §5, commit `f67159f`.
Owner priority change: `IdempotencyKey`/`POST /api/admin/cities` deferred; first visible working user
path chosen instead — `POST /api/auth/login` wired to `createAuditEvent()` (`LOGIN_SUCCEEDED`/
`LOGIN_FAILED`, commit `80c201d`) and a real `/login` page replacing the scaffold (commit `5bb5cb2`),
deployed to real `app`: см. §5, этот commit. **Incident this task**: agent's host-level `kill -9`
cleanup of stray local dev servers repeatedly killed the real `app` container's process instead
(indistinguishable process name, wrong assumed timezone) — 4 unwanted restarts, no data loss (`db`
untouched throughout), service self-healed each time via `restart: unless-stopped`; disclosed
immediately, see §10.
`GET /api/admin/setup-status` + `/admin/setup` — first protected admin screen, real checklist data, no
mock statistics (commits `90d2e55`/`1cba420`), plus a same-day fix (`fa7720e`, removed `loading.tsx`
that was silently downgrading unauthenticated visits from a real `307` to a client-side-only redirect)
— deployed to real `app`: см. §5, этот commit.
`IdempotencyKey` (schema `ddf44a3`, `lib/idempotency.ts` `6a322bc`) + first mutating admin-first
endpoint `POST /api/admin/sites` (`d1c6cc0`, ninth migration seeding `site.create`) + first walkable
`/admin/setup` checklist destination `/admin/sites/new` (`145bfec`) — agent-selected next step per
owner delegation ("что важней ... то и делай"); deployed to real `app`. **Incident this task**:
`docker compose up -d --build app` also recreated `db` (shared `env_file`, unrelated env var change)
despite only `app` being named — same named volume reused, no data loss, confirmed by owner login;
disclosed immediately, see §10.
`POST /api/admin/templates` (eleventh migration seeding `template.create`) + `/admin/templates/new` —
second mutating admin-first endpoint and second walkable `/admin/setup` destination (commits `6bf5232`/
`4962ac6`), same pattern as sites (`IdempotencyKey`+`createAuditEvent()`+shape-validation mirroring the
already-frozen CK-06/07/08 constraints). Deployed to real `app`: this time `db`'s `env_file` was
unchanged, so `docker compose up -d --build app` recreated only `app` — confirms the previous
incident's root cause (a shared `env_file` var change) rather than a general pattern.
Runtime-tested HEAD (полная повторная verification, full green): `991b8fb8381bff11accd09e2c1c3a3f7748d0832`
Source fix commit (CK-08/CK-13 rename): `991b8fb8381bff11accd09e2c1c3a3f7748d0832`
HEAD на момент первого runtime-теста, обнаружившего дефект: bebd6aab5f7a041e6272f24fe32db105ca04f92b
HEAD на момент предыдущего (статического) аудита: 30d2364ffe58679856d6a29d91c9992a941c2b65
Владелец зафиксировал: дальше работаем строго по `PROJECT_ROADMAP.md` ЭТАП 6 по порядку (T6.1→T6.9),
агент больше не выбирает следующий шаг сам. T6.1 («Расширить User — только утверждённые поля»)
проверен и закрыт без изменений кода — `User`/`Employee` в `prisma/schema.prisma` уже содержат ровно
поля из `03_DATA_MODEL_ERD.md` §4.1/§4.2, добавлять нечего. T6.2 («Список работников, read-only») —
`GET /api/admin/workers` + `/admin/workers`, переиспользует уже засеянный `worker.read.all` (седьмая
migration, без новой migration в этой задаче), задеплоено на реальный `app`: commit `45aece3`.
T6.3 («Создание работника») — `POST /api/admin/workers` + `/admin/workers/new`, одиннадцатая migration
(seed `worker.create`), применена **владельцем** (агент по-прежнему заблокирован tool policy на прямые
изменения реальной базы — та же одноразовая `node:22`-container команда, что и во всех предыдущих
migrations), задеплоено на реальный `app`: commit `95e2f74`.
T6.4 («Редактирование и отключение») — `GET`/`PATCH /api/admin/workers/:employeeId` +
`POST .../deactivate` + `/admin/workers/[employeeId]`, двенадцатая migration (seed `worker.update`/
`worker.deactivate`), применена **владельцем**, задеплоено на реальный `app`: commit `64cc569`.
T6.5 («Worksite schema») — проверен, закрыт без изменений кода: `City`/`WorkSite`/`WorkArea` в
`prisma/schema.prisma` уже содержат ровно поля из `03_DATA_MODEL_ERD.md` §4.3 (та же ситуация, что
T6.1), включая оба unique-индекса `WorkArea` (`(siteId,name)`, `(siteId,id)`); `05_RAW_SQL_REGISTER.md`
не содержит ни одного CHECK/EXCLUDE/триггера для этих трёх моделей.
T6.6 первая половина («Список/карточка/редактирование объекта») — `GET /api/admin/sites` +
`GET`/`PATCH /api/admin/sites/:siteId` + `/admin/sites` + `/admin/sites/[siteId]`, тринадцатая
migration (seed `site.read.all`/`site.update`), применена **владельцем**, задеплоено на реальный
`app`: commit `0978634`. `WorkArea` CRUD (вложенный ресурс) отложен отдельной задачей.
(Примечание к нумерации: migration-файлы `20260801123904`/`20260803123201`/`20260803125804` сами
содержат ошибочные ordinal-комментарии «twelfth»/«thirteenth»/«fourteenth» вместо реальных
11/12/13 — обнаружено этой задачей; файлы уже применены к реальной базе и заморожены по конвенции
проекта, поэтому не редактируются задним числом, ошибка исправлена только здесь, в живом статусе.)
T6.6 вторая половина («`WorkArea` CRUD») — `GET`/`POST /api/admin/sites/:siteId/work-areas` +
`PATCH .../work-areas/:workAreaId`, секция внутри уже существующей `/admin/sites/[siteId]` (без
отдельной страницы, per `01_SCREEN_MAP.md`), четырнадцатая migration (seed `workarea.read.all`/
`workarea.create`/`workarea.update`), применена **владельцем**, задеплоено на реальный `app`: commit
`b25a098`. **Закрывает T6.6 полностью.**
T6.7 («Assignment schema») — проверен, закрыт без изменений кода: `SiteAssignment` в
`prisma/schema.prisma` уже содержит ровно поля из `03_DATA_MODEL_ERD.md` §4.4; CK-05
(`ck_site_assignment_date_range`), EX-02 (`ex_site_assignment_scope_date_overlap`) и
`trg_site_assignment_dependents_guard` подтверждены напрямую в уже применённой frozen initial
migration (не только в `05_RAW_SQL_REGISTER.md`). `ForemanAssignment` (нужна для T6.9) в схеме
по-прежнему нет — отдельный design-checkpoint, не входит в T6.7.
T6.8 первый под-шаг («Создание назначения») — `POST /api/admin/assignments/validate-overlap` +
`POST /api/admin/assignments` + `/admin/assignments/new`, пятнадцатая migration (seed
`assignment.create`), применена **владельцем**, задеплоено на реальный `app`: commit `00c8857`.
Разблокирует `hasAssignment` в чек-листе `/admin/setup`. Список/`PATCH`/`split`/`promote`/`end`
отложены на следующие под-задачи. **Инцидент, найден и исправлен этой же задачей**: изначальное
предположение о коде ошибки Prisma для нарушения EXCLUDE constraint (`EX-02`) было неверным —
вместо `PrismaClientKnownRequestError`/`P2010` Prisma реально отдаёт нетипизированный
`PrismaClientUnknownRequestError` с сырым текстом ошибки Postgres; найдено через настоящую гонку
из 6 параллельных запросов на одноразовом PostgreSQL 16 (без фикса — `500`; с фиксом — ровно один
`201`, пять `409`, ноль дублирующихся строк, подтверждено прямым SQL-подсчётом).
T6.8 второй под-шаг («Список назначений») — `GET /api/admin/assignments` + `/admin/assignments`,
шестнадцатая migration (seed `assignment.read.all`), применена **владельцем**, задеплоено на
реальный `app`: commit `44d685c`.
T6.8 третий под-шаг («Редактирование назначения») — `PATCH /api/admin/assignments/:assignmentId`
(только `isPrimary`/`endedReason`, `siteId`/`workAreaId`/`templateId` явно отклоняются с `400
ASSIGNMENT_ALREADY_STARTED`, если назначение уже началось) + одноклик-переключатель primary на
`/admin/assignments`, семнадцатая migration (seed `assignment.update`), применена **владельцем**,
задеплоено на реальный `app`: commit `fe353af`.
T6.8 четвёртый под-шаг («Split назначения») — `POST /api/admin/assignments/:assignmentId/split`
(атомарно закрывает текущее назначение `validTo = effectiveFrom - 1 day` и создаёт новое с новым
site/work area/template, `isPrimary`/`validTo` наследуются от закрываемой строки — этих полей нет в
схеме запроса), восемнадцатая migration (seed `assignment.split`), применена **владельцем**,
задеплоено на реальный `app`: commit `d124a35`.
T6.8 пятый под-шаг («Promote назначения») — `POST /api/admin/assignments/:assignmentId/promote`,
демоушен прежнего primary через per-employee advisory lock (`pg_advisory_xact_lock(hashtext(...))`,
тот же паттерн, что `bootstrap-super-admin.ts`, но ключ включает `employeeId`, а не один
глобальный). Новой migration не понадобилось — `assignment.update` уже покрывает этот endpoint по
`02_ROLE_PERMISSION_MATRIX.md`. Задеплоено на реальный `app`: commit `22eb82d`.
T6.8 шестой (последний) под-шаг («End назначения») — `POST /api/admin/assignments/:assignmentId/end`,
только сжатие диапазона (`validTo` не может стать позже текущего — расширение не относится к
операции «end»), причина обязательна только если новая дата раньше уже запланированной (`null` =
«никогда», так что любая конкретная дата для бессрочного назначения считается «раньше»), совпадение
с уже существующей `validTo` не требует причины. Девятнадцатая migration (seed `assignment.end`),
применена **владельцем**, задеплоено на реальный `app`: commit `544f369`. **Закрывает T6.8
полностью** — весь `04_ADMIN_FIRST_API_CONTRACTS.md` §6 «Назначения» реализован.
T6.9 первый под-шаг («ForemanAssignment schema») — design-checkpoint с владельцем пройден
(`03_DATA_MODEL_ERD.md` §4.4, без отклонений), двадцатая migration: таблица `ForemanAssignment`
(`foremanUserId`/`siteId`/`isSubstitute`/`validFrom`/`validTo`/`assignedByUserId`, все FK
`onDelete: Restrict`, `CHECK ck_foreman_assignment_date_range`, без EXCLUDE — ERD осознанно
разрешает несколько строк на объект, включая перекрывающиеся). Применена **владельцем**, `app`
пересобран (полная переустановка из-за смены схемы — Prisma Client перегенерирован), задеплоено:
commit `9716f02`. Только схема — API endpoint'ов пока нет, это следующий под-шаг.
T6.9 второй под-шаг («Создание назначения прораба») — `POST /api/admin/foreman-assignments` +
секция «Foremen» на `/admin/sites/[siteId]` (список текущих + форма создания), контракт
спроектирован по аналогии с `assignment.create` и подтверждён владельцем (в `04_...` его не было).
Без проверки `ASSIGNMENT_OVERLAP` — ERD осознанно не ограничивает перекрытия для этой сущности;
единственная бизнес-проверка — активная роль `FOREMAN` у `foremanUserId` (`409 USER_NOT_FOREMAN`).
Двадцать первая migration (seed `foreman_assignment.create`), применена **владельцем**, задеплоено
на реальный `app`: commit `0b90e57`.
T6.9 третий под-шаг («Список назначений прораба») — `GET /api/admin/foreman-assignments`, без новой
страницы (секция «Foremen» на карточке объекта уже покрывает текущее состояние, сущность не входит
в чек-лист `/admin/setup`). Двадцать вторая migration (seed `foreman_assignment.read.all`),
применена **владельцем**, задеплоено на реальный `app`: commit `79d31f9`.
T6.9 четвёртый (последний) под-шаг («End назначения прораба») — `POST
/api/admin/foreman-assignments/:foremanAssignmentId/end`. Проще, чем `assignment.end`: у
`ForemanAssignment` нет ни поля `endedReason` (ERD его не предусматривает), ни EXCLUDE constraint —
поэтому здесь нет ни `reason`, ни shrink-only ограничения (расширение `validTo` явно разрешено и
проверено). Двадцать третья migration (seed `foreman_assignment.end`), применена **владельцем**,
задеплоено на реальный `app`: commit `4950c11`.

**T6.9 закрыт полностью. `PROJECT_ROADMAP.md` ЭТАП 6 («Работники, объекты и назначения») закрыт
полностью** — T6.1–T6.9 все реализованы (включая четыре чисто аудиторских под-задачи без изменений
кода: T6.1, T6.5, и частично T6.7, где схема уже существовала в frozen initial migration).
Следующий этап по роадмапу — ЭТАП 7 («Учёт часов», `PROJECT_ROADMAP.md` T7.1–T7.10) — не начат,
требует отдельного подтверждения владельца перед первой задачей.
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
| Login endpoint | `titanor-time-app/app/api/auth/login/route.ts`, `titanor-time-app/lib/{api-error,rate-limit,session}.ts` | реализован commit `ecb37b2` — `POST /api/auth/login` (T5.5 core); задеплоен и подтверждён реальным входом (commit `e42025d`) |
| Session/logout endpoints | `titanor-time-app/lib/auth.ts`, `titanor-time-app/app/api/auth/{session,logout,logout-all}/route.ts` | реализованы commit `690686d` — `GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/logout-all` (§11 item 1); задеплоены на реальный `app` и структурно проверены против `titanor-time-db-1` commit `383c7a2` |
| Route-protection proxy | `titanor-time-app/proxy.ts` | реализован, протестирован (standalone `server.js` против одноразового PostgreSQL 16) и задеплоен на реальный `app` commit `a220d39` — гейтит `/api/admin/*`+`/api/worker/*` на аутентификацию; role-level permission enforcement всё ещё требует role guard (T5.6, §9) |
| Role-guard primitive | `titanor-time-app/lib/permissions.ts` | `hasPermission(roles, code)` реализован и протестирован на одноразовом PostgreSQL 16 этим commit — чистый lookup по `RolePermission`, без консьюмеров (нет ни одного `/api/admin`/`/api/worker` роута), не задеплоен |
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

**`GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/logout-all`** (T5.5, §11 item 1 —
`titanor-time-app/lib/auth.ts`, `titanor-time-app/app/api/auth/session/route.ts`,
`titanor-time-app/app/api/auth/logout/route.ts`, `titanor-time-app/app/api/auth/logout-all/route.ts`,
commit `690686d`):
- Причина: login (§5 above, commit `ecb37b2`) issues a `UserSession`, but until this task nothing read
  or revoked it — `04_ADMIN_FIRST_API_CONTRACTS.md` §1 requires all three endpoints for the session to
  be a real session, not just a write-only cookie.
- `lib/auth.ts` adds one shared `resolveAuthenticatedSession()`, reused by all three routes: reads the
  `tt_session` cookie, `SHA-256`-hashes it, looks up `UserSession.tokenHash`, and rejects (`null`) a
  missing cookie, unknown/expired/revoked token, or a user whose account is `DEACTIVATED` — the last
  check is not in the API contract text but is required by `AGENT_RULES.md` §12 ("отключённый аккаунт
  не работает"): without it, deactivating a user after they logged in would not actually end their
  session until natural expiry (up to 30 days). `OFFBOARDING` is intentionally not rejected, matching
  login's existing rule (`03_DATA_MODEL_ERD.md` §4.2). On success, refreshes `UserSession.lastSeenAt`.
- `GET /api/auth/session`: `200 { user: { id, username, roles, locale } }` on a valid session, `401
  NOT_AUTHENTICATED` otherwise — exact contract match, no CSRF check (not a mutating request).
- `POST /api/auth/logout`: same `X-Requested-With: titanor-time` CSRF check as login (`403
  CSRF_REJECTED` if missing/wrong), `401 NOT_AUTHENTICATED` without a valid session, otherwise
  soft-revokes only the caller's own current `UserSession` (`revokedAt = now()`, row never deleted,
  same pattern as `reset-password`) and clears the `tt_session` cookie (`Max-Age=0`), `204`.
- `POST /api/auth/logout-all`: same CSRF/auth gate, then soft-revokes every `UserSession` belonging to
  the caller (`WHERE userId = ... AND revokedAt IS NULL`) — including any already-expired-but-not-yet-
  revoked rows, a deliberate blanket sweep, not a bug — clears the cookie, `204`. **Known gap, deferred
  on purpose**: the contract's stated permission is `session.revoke_all.own`, but `Permission`/
  `RolePermission` enforcement (role guard, T5.6, §9/§11) doesn't exist yet, so this endpoint is
  currently gated on "authenticated" only, same as `/logout`. Not a privilege-escalation gap in the
  meantime — the query is hard-scoped to the caller's own `userId`, so an authenticated user can only
  ever revoke their own sessions regardless of role. Must be revisited once role guard lands, per the
  same `session.revoke_all.own` contract line.
- **Tested only on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume; all
  three migrations applied from scratch via local `prisma migrate deploy`, not Docker): app run locally
  via `next dev -H 127.0.0.1 -p 3988` (not the production port `3200`) against a seed of one `ACTIVE`
  user (two roles) and one `DEACTIVATED` user, with five hand-crafted `UserSession` rows (valid,
  expired, pre-revoked, belonging to the deactivated user, and a second valid session on the `ACTIVE`
  user) — all via `curl`:
  - `GET /session` — no cookie → `401`; valid token → `200` with both roles; expired token → `401`;
    pre-revoked token → `401`; deactivated-user's token → `401` (and confirmed via direct query that
    this path does **not** touch that session's `lastSeenAt`/`revokedAt` — the `DEACTIVATED` check is
    part of the same early-return guard, not a separate write); unknown/garbage token → `401`.
  - `POST /logout` — missing CSRF header → `403`; missing cookie (CSRF present) → `401`; valid session
    + CSRF → `204` with `Set-Cookie: tt_session=; Max-Age=0; ...`; the same (now-revoked) token
    immediately returns `401` on a follow-up `GET /session` — revocation takes effect same-request, not
    on next login.
  - `POST /logout-all` — missing CSRF → `403`; with the second `ACTIVE`-user session + CSRF → `204`,
    cookie cleared, token immediately unusable. Direct `SELECT` against the five seeded `UserSession`
    rows after both calls confirmed exact expected end state: the `/logout`-revoked session and the
    `/logout-all`-revoked session both `revokedAt IS NOT NULL`; the pre-revoked session's row untouched
    (same `revokedAt`, no double-write); the previously-expired `ACTIVE`-user session was **also**
    revoked by `/logout-all`'s blanket sweep (confirms intended behavior, not scope creep); the
    `DEACTIVATED` user's own session was **not** touched (`revokedAt IS NULL`) — confirms the `userId`
    scoping, i.e. `/logout-all` cannot reach another user's sessions.
  - `npx tsc --noEmit` and `npm run build` both clean (root and `titanor-time-app`), all three new
    routes listed as `ƒ (Dynamic)` in the build output alongside the existing `login`/`health`/`ready`
    routes.
  - Cleanup: disposable `next dev` process killed, disposable PostgreSQL container removed
    (`docker rm -f`, confirmed absent from `docker ps -a` afterward), temporary seed script deleted,
    nothing committed from the test run. `next-env.d.ts` reverted (`next dev` rewrites its `.next/dev/`
    type-reference path; `git checkout --` restored the `next build`-generated committed version).
- **Real `titanor-time-db-1`/`app` untouched by this task** — no migration was needed (schema
  unchanged since commit `e273490`), and the new routes were not deployed/rebuilt against the real
  `app` container. `titanor-time-app-1`/`titanor-time-db-1`/`collab-studio-*`/`titanorgroup-web-1` —
  same `Up`-durations before and after, all `healthy`; `titanorgroup.fi`/`collabstudio.run` — `200`
  before and after. Only Docker artifact touched was the disposable test-database container, removed at
  the end of the task.
- **Not in this task**: deploying these routes to the real `app` (`docker compose build/up`), the
  route-protection middleware that will call the same `resolveAuthenticatedSession()` on other
  protected routes (§11 item 2, next), and role guard / `session.revoke_all.own` enforcement (§11 item
  3, T5.6).

**Session/logout endpoints deployed to real `app`, structurally verified against `titanor-time-db-1`**
(§11 item 1, deploy step — code unchanged from commit `690686d`, this commit is deploy + verification
only):
- `docker compose -f compose.titanor-time.yaml build app` — image rebuilt from current HEAD (same
  three-stage Dockerfile as every prior deploy, no Dockerfile changes needed); build output confirms
  all three new routes (`/api/auth/session`, `/api/auth/logout`, `/api/auth/logout-all`) present
  alongside the existing `login`/`health`/`ready` routes.
- `docker compose -f compose.titanor-time.yaml up -d --no-deps app` — `db` stayed `Running` (confirmed
  identical `StartedAt`/`RestartCount=0` before and after, i.e. not recreated); `app` recreated, became
  `healthy`.
- Verified without knowing the real password (same pattern as the original login deploy, commit
  `ecb37b2`): `GET /api/health` → `200` (unchanged); `GET /api/ready` → `200,
  database: connected`; `GET /api/auth/session` without a cookie → `401 NOT_AUTHENTICATED`; `POST
  /api/auth/logout` without `X-Requested-With` → `403 CSRF_REJECTED`, with the header but no cookie →
  `401 NOT_AUTHENTICATED`; `POST /api/auth/logout-all` — same two cases, same results. Login regression
  check: `POST /api/auth/login` without CSRF → still `403`; with CSRF and an unknown identifier → still
  `401 INVALID_CREDENTIALS` — confirms the rebuild didn't disturb the existing endpoint.
- No real session cookie was exercised against `titanor-time-db-1` in this task (would require the
  owner's real password, same constraint as every prior deploy) — full end-to-end verification (a real
  `GET /session` with a real cookie, a real `logout` that then makes that cookie unusable) is left for
  the owner to confirm opportunistically next time they log in, or for a future task.
- `titanor-time-app-1`/`titanor-time-db-1` — `db` `StartedAt` identical before/after
  (`2026-07-28T14:33:34Z`, not recreated); `app` recreated (new `StartedAt`), `healthy`.
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` — identical `StartedAt`/
  `RestartCount=0` before and after, not touched. `titanorgroup.fi`/`collabstudio.run` — `200` before
  and after.
- **Not in this task**: route-protection middleware (§11 item 2, still next), role guard /
  `session.revoke_all.own` enforcement (§11 item 3, T5.6), any real-cookie end-to-end test against
  `titanor-time-db-1`.

**Route-protection `proxy.ts` for `/api/admin/*` + `/api/worker/*`** (§11 item 1 —
`titanor-time-app/proxy.ts`, implemented, tested, and deployed to real `app` in one task, this
commit):
- Причина: `GET /api/auth/session`/`POST /api/auth/logout`/`logout-all` (commit `690686d`) only guard
  themselves — nothing else calls `resolveAuthenticatedSession()`, so any future admin/worker route
  would start out completely open unless its author remembered to add the check by hand. Centralizing
  the auth gate removes that failure mode.
- **Discovered mid-task**: Next.js 16 deprecated the `middleware.ts` file convention in favor of
  `proxy.ts` (build emits `⚠ The "middleware" file convention is deprecated. Please use "proxy"
  instead.` — see `nextjs.org/docs/messages/middleware-to-proxy`). Functionally equivalent (same
  `NextRequest`/`NextResponse` API, same `matcher` config), but two contract differences matter here:
  Proxy defaults to the Node.js runtime (was opt-in/experimental for `middleware.ts` as of Next
  15.2–15.5); and explicitly setting `runtime` in `config` is now a build error on `proxy.ts` (it
  wasn't on `middleware.ts`). Built directly as `proxy.ts` with `export async function proxy(...)`,
  never shipped as `middleware.ts`.
- `matcher: ['/api/admin/:path*', '/api/worker/:path*']` — exactly the two route prefixes
  `04_ADMIN_FIRST_API_CONTRACTS.md` defines (§2–§8 admin, §9 worker). `/api/auth/*` (self-guarding),
  `/api/health`, `/api/ready`, and `/` are deliberately outside the matcher — untouched by this proxy.
  A future `/admin/setup` **page** (§9, not started) is also out of scope: a JSON `401` is the wrong
  response shape for a page navigation, and no login page exists yet to redirect to.
- Reuses `resolveAuthenticatedSession()` from `lib/auth.ts` (commit `690686d`) unchanged — same
  rejection rules (missing/expired/revoked token, `DEACTIVATED` user), same `lastSeenAt` refresh on
  success. **Authentication only, not authorization**: any authenticated user currently passes the
  proxy for any `/api/admin/*` or `/api/worker/*` path — per-endpoint permission checks
  (`04_ADMIN_FIRST_API_CONTRACTS.md` gives each one its own required permission) need the role guard
  (T5.6, §9/§11), which needs `Permission`/`RolePermission` seeded, neither done yet. No route
  currently exists under either matched prefix, so this has no live consumer yet — it's put in place
  ahead of them specifically so no future route can be added unprotected by omission.
- **Verified the compiled artifact, not just source**: `npx tsc --noEmit`/`npm run build` clean with
  **no** deprecation warning (confirms `proxy.ts`, not `middleware.ts`, is what actually built).
  Inspected `.next/server/functions-config-manifest.json` directly (both the plain `.next/` build and
  the `.next/standalone/` copy that Docker's `runner` stage actually ships) — both register
  `/_middleware` with `"runtime": "nodejs"` and both exact matcher regexes for `/api/admin/:path*` and
  `/api/worker/:path*`. This matters because a past task (commit `122c884`) already found that
  Next.js's standalone-output file tracing can silently omit things a route only reaches indirectly;
  checking the manifest directly, rather than assuming a passing `build` means correct manifest
  content, avoids repeating that mistake for Proxy specifically.
- **Runtime-tested by actually running the standalone server** (`node .next/standalone/server.js`,
  not `next dev` — the same code path `CMD ["node", "server.js"]` in `Dockerfile` runs in production),
  against a disposable PostgreSQL 16 (`--rm`, tmpfs, random credentials, no named volume; all three
  migrations applied from scratch) seeded with one `ACTIVE` user + one valid `UserSession`, `curl`
  against `127.0.0.1:3989` (not the production port `3200`):
  - `GET /api/admin/anything` and `GET /api/worker/foo` (neither route exists) without a cookie → both
    `401 NOT_AUTHENTICATED` from the proxy itself, before Next.js ever resolves that there's no
    matching route.
  - Same two paths with a garbage cookie → `401` (same rejection path as an unknown token).
  - `GET /api/admin/anything` with the valid session cookie → `404` — proxy correctly let it through
    (`NextResponse.next()`), and Next.js's own router then correctly reports no route exists there.
    Confirms the proxy is a pure gate, not accidentally intercepting/altering successful requests.
  - Direct `SELECT` on the seeded `UserSession` row after the valid-cookie request: `lastSeenAt`
    updated to the exact request timestamp — direct proof the proxy's own Prisma query actually ran
    against the database from inside the compiled, bundled proxy code (not a crash silently
    short-circuited into some other response path).
  - `GET /api/health` (outside the matcher) → unaffected, still `200`; `GET /api/auth/session` (also
    outside the matcher) → still returns its own route-level `401`, not the proxy's — confirms the
    matcher correctly scopes the gate to only the two intended prefixes.
  - Cleanup: standalone server process killed, disposable PostgreSQL container removed (confirmed
    absent from `docker ps -a` afterward), temporary seed script deleted, nothing committed from the
    test run.
- **Deployed to real `app`** (`docker compose -f compose.titanor-time.yaml build app` + `up -d
  --no-deps app`, same pattern as every prior deploy): `db` `StartedAt` identical before/after
  (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Verified against
  `titanor-time-db-1` without a real session cookie (same constraint as every prior auth deploy — no
  real password available to this task): `GET /api/admin/anything`/`GET /api/worker/foo` without a
  cookie → both `401`; `GET /api/health`/`GET /api/ready` (`database: connected`) → unaffected;
  `GET /api/auth/session` without a cookie → still its own `401`, unaffected by the proxy. Regression
  check on the three pre-existing auth routes: `POST /api/auth/login`/`logout` without CSRF → still
  `403` each — confirms the rebuild didn't disturb them.
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` — identical `StartedAt`/
  `RestartCount=0` before and after, not touched; `titanorgroup.fi`/`collabstudio.run` — `200` before
  and after.
- **Not in this task**: any actual `/api/admin/*` or `/api/worker/*` route (none exist), permission/
  role enforcement beyond "authenticated" (§11 item 2 next, T5.6), page-level route protection (e.g. a
  future `/admin/setup`), and a real-cookie end-to-end test of the proxy against `titanor-time-db-1`
  (same open item as the session/logout endpoints, §9).

**`hasPermission()` role-guard primitive** (T5.6 first sub-step — `titanor-time-app/lib/permissions.ts`,
this commit):
- Причина: `04_ADMIN_FIRST_API_CONTRACTS.md`/`02_ROLE_PERMISSION_MATRIX.md` §5 give every future
  `/api/admin/*`/`/api/worker/*` endpoint an exact required permission code (e.g.
  `worker.read.all`, `site.update`) — this is the checking primitive those endpoints will call. Schema
  support (`Permission`, `RolePermission` tables) already existed since the second migration (commit
  `c0f5425`); this task adds no schema.
- `hasPermission(roles: string[], permissionCode: string): Promise<boolean>` — single `RolePermission`
  lookup filtered by `permission.code` + `role.name IN roles`, `select: { id: true }` (existence check,
  not a data fetch). Empty `roles` short-circuits to `false` without a query. Deliberately does **not**
  hardcode a `SUPER_ADMIN` > `ADMIN` hierarchy — `02_ROLE_PERMISSION_MATRIX.md` §2 lists `SUPER_ADMIN`
  explicitly alongside `ADMIN` on every ADMIN-held permission row, so the intended design is that
  seeding grants both roles directly; a hardcoded hierarchy in code would silently diverge from
  whatever the seed data (added later, per-endpoint, see §9) actually says.
- **Deliberately narrow scope, stopped here on purpose**: this commit does not seed any real
  `Permission`/`RolePermission` rows, does not add an `AuditEvent` model, does not touch `proxy.ts`
  (which stays a pure authentication gate — it can't route-map to per-endpoint permission codes when no
  endpoint exists yet to define that mapping), and does not create any `/api/admin/*`/`/api/worker/*`
  route. Building those is starting the real admin API, which
  `AGENT_RULES.md` §15 and this file's own §11 require a separate, explicit owner checkpoint for before
  beginning — not assumed by this task. Likewise, `AuditEvent` is a schema change, and `AGENT_RULES.md`
  §11 requires showing the design (entities/fields/relations/constraints/indexes/deletion rules) and
  getting it approved before any migration is created, same as every prior schema change in this
  project (Role/Permission/UserRole, UserSession) — not done unilaterally here.
- **Tested on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume; all three
  existing migrations applied from scratch — no new migration): seeded exactly one real permission code
  from the matrix, `worker.read.all`, granted only to `ADMIN` (deliberately not to `SUPER_ADMIN`, to
  prove the no-hierarchy design actually holds). Six assertions, all passed: `ADMIN` → `true`; `WORKER`
  → `false`; `SUPER_ADMIN` → `false` (proves no hardcoded hierarchy); `[WORKER, ADMIN]` (multi-role
  user) → `true` (any granting role is enough); unknown permission code → `false`; empty roles array →
  `false`. Disposable container removed afterward (confirmed absent from `docker ps -a`), temporary
  test script deleted, nothing committed from the test run.
- **Not deployed** — no route imports this file yet, so rebuilding/redeploying real `app` would be a
  no-op change to the running image; skipped as unnecessary churn on a production container.
- **Not in this task**: seeding any real `Permission`/`RolePermission` rows, `AuditEvent` model/
  migration, any `/api/admin/*`/`/api/worker/*` route, wiring `hasPermission()` into `proxy.ts` or any
  route, the last-active-`SUPER_ADMIN` protection invariant, and `session.revoke_all.own`/proxy
  permission enforcement (both still open, §9) — all of these need either a real admin/worker endpoint
  to attach to, an `AuditEvent` schema checkpoint, or both, none of which this task started.

**`GET /api/admin/cities` — first real admin endpoint** (T5.6 second sub-step — owner-confirmed
checkpoint to proceed; `prisma/migrations/20260730221710_seed_city_read_all_permission/migration.sql`,
`titanor-time-app/app/api/admin/cities/route.ts`, this commit):
- Причина/scope decision: per owner confirmation (chat), started T5.6 by building the narrowest
  possible first real endpoint rather than the full admin API. `GET /api/admin/cities` chosen
  specifically because, per `02_ROLE_PERMISSION_MATRIX.md` §2.4, `city.read.all` has **no** audit
  requirement and `City` needs no schema change (table exists since the first migration) — unlike
  `POST /api/admin/cities` (`city.create`), which the matrix marks `Аудит=да` and whose contract
  requires `Idempotency-Key` support, both needing schema (`AuditEvent`, an idempotency-record table)
  that hasn't been through the `AGENT_RULES.md` §11 design checkpoint. `POST /api/admin/cities`
  deliberately **not** built here.
- **Fourth migration** — pure data (`INSERT`), no DDL: adds exactly one `Permission` row
  (`city.read.all`) and grants it via `RolePermission` to `ADMIN` and `SUPER_ADMIN` only — matching
  `02_ROLE_PERMISSION_MATRIX.md` §2.4's listed holders exactly (not `FOREMAN`/`WORKER`). First real
  (non-placeholder) permission seed; follows the project's existing incremental-per-endpoint seeding
  plan (second migration's commit message) rather than transcribing the full matrix at once.
- `GET /api/admin/cities`: independently re-calls `resolveAuthenticatedSession()` even though
  `proxy.ts` already gates `/api/admin/*` for authentication — per Next.js's own Proxy docs ("Always
  verify authentication and authorization inside each Server Function rather than relying on Proxy
  alone"), not assumed safe to skip. Adds the actual permission check via `hasPermission()` (commit
  `8fb72c2`) — `403 FORBIDDEN` (code already used elsewhere in `04_ADMIN_FIRST_API_CONTRACTS.md` for
  this exact case) if the caller's roles don't grant `city.read.all`. Response is exactly
  `{ items: [{ id, name }] }` via an explicit Prisma `select` (no `createdAt`/`updatedAt` leaked),
  ordered by `name`.
- **Tested on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume): all four
  migrations applied from scratch, idempotent repeat confirmed ("No pending migrations to apply").
  Direct query confirmed seeded `RolePermission` rows: exactly `city.read.all` × `{ADMIN, SUPER_ADMIN}`,
  nothing else. Seeded two cities + one session per role (`SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`) via
  `next dev` on `127.0.0.1:3990` (not the production port), `curl`-tested: no cookie → `401` (from
  `proxy.ts`, route never reached); `SUPER_ADMIN` and `ADMIN` → `200` with both cities correctly sorted
  and shaped; `FOREMAN` and `WORKER` → `403 FORBIDDEN` (neither role holds `city.read.all`); garbage
  cookie → `401`. Regression-checked `/api/health`, `/api/auth/session`, and the `/api/worker/*` proxy
  gate — all unaffected. Disposable container removed, temporary seed script deleted, nothing else
  committed from the test run.
- **Security incident during this task**: while preparing the real migration command, the agent ran
  `cat .env.titanor-time | grep -v PASSWORD` intending to filter secrets before displaying it, but the
  real password is embedded directly in the `DATABASE_URL` value (not under a key literally named
  `PASSWORD`), so the filter didn't catch it — the real `titanor_time_app` password appeared in tool
  output within this chat. Same root-cause class as the earlier `docker compose config` incident (§5,
  commit `7a854ac`'s task), but this time the password never left the owner's own infrastructure — only
  displayed within this chat, not transmitted externally or logged elsewhere the agent could confirm.
  Disclosed to the owner immediately (before proceeding with anything else); owner explicitly assessed
  the risk as insignificant (own server, chat-only exposure) and declined rotation — a deliberate,
  informed owner decision, not an agent judgment call. Password **not** rotated as part of this task.
- **Applied to real `titanor-time-db-1` — by the owner**, not the agent: the agent attempted both a
  direct `docker exec` (to consider self-remediating the incident above) and the established one-off
  `node:22`-container pattern (to apply the migration itself) — both denied by tool policy, consistent
  with every prior real-database interaction in this project's history (see the third-migration
  entry above). Owner ran, in their own terminal, the same one-off `node:22`-container pattern used for
  the first three migrations (`--network titanor-time_internal`, bind-mounted repo incl. `node_modules`,
  `--env-file .env.titanor-time`, no `npm install`): `prisma migrate deploy` — exact output (not
  paraphrased): "Applying migration `20260730221710_seed_city_read_all_permission`" →
  "All migrations have been successfully applied." Owner then ran `prisma migrate status` in the same
  wrapper immediately after — exact output: **"Database schema is up to date!"** This is the first time
  in this project that a successful `migrate status` against the real `titanor-time-db-1` has been
  directly confirmed (see the open tail noted in the third-migration entry above and in prior §11
  revisions) — closed by this task, not a separate one.
- **`app` rebuilt + redeployed** (`docker compose build app` + `up -d --no-deps app`, same pattern as
  every prior deploy): `db` `StartedAt` identical before/after (`2026-07-28T14:33:34Z`, not recreated);
  `app` recreated, `healthy`. Verified against `titanor-time-db-1` without a real session cookie (same
  constraint as every prior auth deploy): `GET /api/admin/cities` without a cookie → `401` (from
  `proxy.ts`); with a garbage cookie → `401`; `GET /api/health`/`GET /api/ready` (`database: connected`)
  → unaffected; `GET /api/auth/session` without a cookie → still its own `401`. Regression: `POST
  /api/auth/login` without CSRF → still `403`. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after, not touched;
  `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `POST /api/admin/cities` (`city.create` — needs `AuditEvent` + idempotency
  schema, both requiring their own design checkpoint), any other `/api/admin/*`/`/api/worker/*` route,
  `AuditEvent` model, the last-active-`SUPER_ADMIN` protection invariant, `session.revoke_all.own`
  enforcement on `POST /api/auth/logout-all`, and a real-cookie end-to-end test of `city.read.all`
  against `titanor-time-db-1` (same open item as prior auth work, §9).

**`session.revoke_all.own` enforced on `POST /api/auth/logout-all`** (T5.6 third sub-step — owner
explicitly chose this as the next self-contained step, distinct from `AuditEvent` design, per "one task
closed before the next starts"; `prisma/migrations/20260730224645_seed_session_revoke_all_own_permission/migration.sql`,
`titanor-time-app/app/api/auth/logout-all/route.ts`, this commit):
- Причина: this gap has existed since `logout-all` was first built (commit `690686d`) — the contract
  permission was never actually checked, only "authenticated". Safe in the meantime (revoke query
  hard-scoped to caller's own `userId`), but not contract-compliant. Chosen over continuing the
  admin-first scenario because it needs neither a new endpoint nor `AuditEvent`/idempotency schema —
  fully closeable in one task with what already exists (`hasPermission()`, commit `8fb72c2`).
- **Fifth migration** — pure data (`INSERT`), no DDL: adds `session.revoke_all.own` and grants it via
  `RolePermission` to **all four roles** (`SUPER_ADMIN`, `ADMIN`, `FOREMAN`, `WORKER`) — per
  `02_ROLE_PERMISSION_MATRIX.md` §2.1, this permission's holders are "все аутентифицированные" (all
  authenticated), unlike the admin-only `city.read.all` seeded previously. Not a hierarchy shortcut —
  each of the four roles gets its own explicit `RolePermission` row, same pattern as before.
- `logout-all/route.ts`: adds `hasPermission(authenticated.user.roles, 'session.revoke_all.own')` right
  after the existing session check, `403 FORBIDDEN` on failure; removes the now-stale comment that
  explained why the check was missing.
- **Tested on disposable PostgreSQL 16**: all five migrations applied from scratch, idempotent repeat
  confirmed. Direct query confirmed seeded `RolePermission` rows: exactly `session.revoke_all.own` ×
  all 4 roles. Seeded **two** sessions each for one user per role, plus one user with **zero** roles
  (deliberately, to prove the check is real and not a no-op) — all via `curl` against `next dev` on
  `127.0.0.1:3991`: `SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER` → `204`, and a direct query confirmed
  **both** of that user's sessions revoked; the roleless user → `403 FORBIDDEN`, and a direct query
  confirmed **neither** of their sessions was touched (`revokedAt` still `NULL` for both) — the request
  was rejected before the revoke query ever ran. Regression-checked `POST /api/auth/logout` (single) and
  `GET /api/health`. Disposable container removed, temporary seed script deleted, nothing else committed
  from the test run.
- **Applied to real `titanor-time-db-1` by the owner** (agent still blocked by tool policy, as every
  time before) via the same one-off `node:22`-container pattern: exact output — "Applying migration
  `20260730224645_seed_session_revoke_all_own_permission`" → "All migrations have been successfully
  applied." This time the agent did **not** attempt to `cat`/`grep` `.env.titanor-time` itself before
  handing the command to the owner, to avoid repeating the incident from the prior task (§10).
- **`app` rebuilt + redeployed** (`docker compose build app` + `up -d --no-deps app`): `db` `StartedAt`
  identical before/after (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Verified
  against `titanor-time-db-1`: `POST /api/auth/logout-all` without CSRF → still `403`; with CSRF but no
  cookie → still `401` (permission check is unreachable before authentication, as designed).
  Regression: `GET /api/health`/`GET /api/ready` (`database: connected`), `GET /api/admin/cities`
  without a cookie (`401`, unaffected), `POST /api/auth/login` without CSRF (`403`) — all unchanged.
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` — identical `StartedAt`/
  `RestartCount=0` before and after, not touched; `titanorgroup.fi`/`collabstudio.run` — `200` before
  and after.
- **Not in this task**: `AuditEvent` design (still the owner's explicit next decision to make, §11),
  `POST /api/admin/cities`, any other admin/worker endpoint, and a real-cookie end-to-end test of
  `logout-all` against `titanor-time-db-1` (same open item as prior auth work, §9).

**`AuditEvent` — T5.6 audit-trail foundation, design shown and explicitly amended by owner** (per
`AGENT_RULES.md` §11's design-checkpoint requirement — sixth migration
`prisma/migrations/20260730232202_add_audit_event/migration.sql`, `prisma/schema.prisma`, this
commit):
- Source design: `03_DATA_MODEL_ERD.md` §4.8 (`id`, `actorUserId FK`, `eventType varchar`,
  `entityType`, `entityId`, `beforeValue jsonb`, `afterValue jsonb` — без GPS/паролей/токенов,
  `reason`, `requestId uuid`, `createdAt`) — not invented by the agent, only translated into a concrete
  Prisma model + migration. Agent's initial proposal (`actorUserId`/`entityId` `NOT NULL`) was shown to
  the owner and **explicitly corrected**:
  - `actorUserId` → **nullable**. Owner's reasoning: the contract requires `LOGIN_FAILED` for an
    unrecognized identifier, which has no resolvable `User` — and no substitute ("system" account etc.)
    may be used there, since that would falsify the audit record.
  - `entityId` → **nullable**, same reasoning — e.g. `entityType='AUTHENTICATION'`, `entityId=NULL` for
    that same failed-login case, which has no single domain entity.
  - `requestId` → stays `NOT NULL`, but the owner explicitly deferred actually writing to this table
    until a separate task adds per-request `X-Request-Id` generation on **every** response (today only
    `jsonError()` generates one — successful responses like login/session/cities `200`s carry none).
  - Indexes are the owner's exact spec, not the agent's original single-column proposal:
    `(actorUserId, createdAt DESC)`, `(eventType, createdAt DESC)`, `(entityType, entityId, createdAt
    DESC)`, and `(createdAt DESC, id DESC)` — the last specifically for stable cursor pagination across
    rows sharing the same `createdAt`.
- **Sixth migration**, structural part offline-generated (`prisma migrate diff
  --from-schema-datamodel <pre-change snapshot> --to-schema-datamodel prisma/schema.prisma --script`,
  same process as every prior schema migration — no hand-authored DDL), plus one raw-SQL section:
  `trg_audit_event_immutable`/`fn_audit_event_immutable` — `BEFORE UPDATE OR DELETE FOR EACH ROW`,
  unconditionally `RAISE EXCEPTION 'AUDIT_EVENT_IMMUTABLE' USING ERRCODE = 'P0001'`, same
  frozen-identifier/P0001 convention as every business-rule trigger in the first migration. Owner
  specifically asked for this as a **physical** guarantee, not reliance on "no write API exists" alone
  (`audit.read`, `02_ROLE_PERMISSION_MATRIX.md` §2.10, is the only permission ever touching this table —
  even that is read-only).
- **Explicit scope boundary, owner's own sequencing** — this task is Prisma model + migration + indexes
  + trigger, nothing else: **not** in this task — per-request `X-Request-Id`/request-context
  propagation (separate future task, prerequisite for the next one), and a shared `createAuditEvent()`
  helper that would actually write rows inside the same transaction as a business action (separate
  future task, after request-context). No route or service writes to `AuditEvent` yet.
- **Tested on disposable PostgreSQL 16**: all six migrations applied from scratch, idempotent repeat
  confirmed. Catalog audit (`\d "AuditEvent"` + direct `pg_constraint` query): exact column
  set/nullability/types matching the design above, all four indexes present with correct `DESC`
  ordering, FK `AuditEvent_actorUserId_fkey → User` with `ON DELETE RESTRICT ON UPDATE CASCADE`,
  trigger registered as `BEFORE DELETE OR UPDATE`. Behavioral tests — single transaction, final
  `ROLLBACK`, nothing committed: insert with a real actor — `OK`; insert with `actorUserId=NULL` +
  `entityId=NULL` (the `LOGIN_FAILED` case) — `OK`; `UPDATE` — rejected, exact `SQLSTATE P0001` /
  message `AUDIT_EVENT_IMMUTABLE`; `DELETE` — same; deleting the referenced `User` row — rejected by
  the FK `RESTRICT` constraint itself (`update or delete on table "User" violates foreign key
  constraint`). Final `SELECT` confirmed both rows present and unmodified (`reason` still `NULL`),
  proving the rejected `UPDATE` had zero effect. `npx tsc --noEmit`/`npm run build` clean (root and
  `titanor-time-app`) with the regenerated Prisma Client — no existing route touched or behaviorally
  changed. Disposable container removed, temporary SQL test file deleted, nothing else committed from
  the test run.
- **Applied to real `titanor-time-db-1` by the owner** (agent still blocked by tool policy, same as
  every prior real-database interaction): same one-off `node:22`-container pattern — exact output:
  "Applying migration `20260730232202_add_audit_event`" → "All migrations have been successfully
  applied."
- **`app` rebuilt + redeployed** (`docker compose build app` + `up -d --no-deps app`): `db` `StartedAt`
  identical before/after (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Full
  regression against `titanor-time-db-1` (this migration should change **zero** existing behavior — no
  route touches `AuditEvent`): `GET /api/health` → `200`; `GET /api/ready` → `200, database: connected`;
  `GET /api/admin/cities` without a cookie → `401`; `GET /api/auth/session` without a cookie → `401`;
  `POST /api/auth/login` without CSRF → `403`; `POST /api/auth/logout-all` without CSRF → `403`, with
  CSRF but no cookie → `401` — all unchanged. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after, not touched;
  `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `X-Request-Id`/request-context on every response, `createAuditEvent()`, any
  code that actually writes an `AuditEvent` row, `POST /api/admin/cities` (`city.create` — now unblocked
  on the `AuditEvent` side, still needs an idempotency-record schema, its own design checkpoint), the
  last-active-`SUPER_ADMIN` protection invariant, and `role.assign`/any role-management endpoint.

**`X-Request-Id` on every response** (T5.6 fifth sub-step, owner-confirmed as the next task after
`AuditEvent` — `titanor-time-app/lib/api-error.ts`, all seven existing route files, this commit):
- Причина: `AuditEvent.requestId` (commit `fbeec60`) is `NOT NULL`, but before this task only
  `jsonError()` generated an id — every success response (`login`/`session`/`cities` `200`s,
  `logout`/`logout-all` `204`s, `health`/`ready` `200`s) carried none. Explicit prerequisite the owner
  called out before `createAuditEvent()` (§11), not started opportunistically.
- `lib/api-error.ts`: `jsonError()` now takes an optional third `requestId` parameter (defaults to a
  fresh `randomUUID()` if omitted — any call site that forgets to pass one still works, no silent
  breakage). Added `successHeaders(requestId)` — `{ 'Cache-Control': 'no-store', 'X-Request-Id':
  requestId }` — to avoid repeating that exact two-header object literally across 7 route files.
- Every route (`health`, `ready`, `session`, `login`, `logout`, `logout-all`, `cities`) now generates
  exactly one `requestId = randomUUID()` at the top of its handler and threads it through **every**
  response path of that same request — every `jsonError()` call and the success response — so a single
  request's success and error paths always agree on one id. `proxy.ts`'s own `jsonError()` call (no
  per-route id to share, since it runs ahead of any specific route) keeps using the default
  auto-generated fallback — deliberately not changed, no code depends on matching a proxy-level
  rejection's id to anything else.
- **Tested on disposable PostgreSQL 16**: seeded one city + one `ADMIN` session, `curl`-tested via `next
  dev` on `127.0.0.1:3992` (not the production port). Confirmed `X-Request-Id` present on: `GET
  /api/health` (success, no auth); `GET /api/ready` (success); `GET /api/auth/session` without a cookie
  (`401`) and with a valid one (`200`); `POST /api/auth/login` without CSRF (`403`); `POST
  /api/auth/logout-all` without CSRF (`403`); `GET /api/admin/cities` with a valid cookie (`200`) and
  without one (`401`, from `proxy.ts`'s own fallback). For both error cases explicitly checked, the
  header value exactly matched the `requestId` embedded in the JSON error body. `npx tsc --noEmit`/`npm
  run build` clean (root and `titanor-time-app`). Disposable container removed, temporary seed script
  deleted, nothing else committed from the test run.
- **Deployed to real `app`** (`docker compose build app` + `up -d --no-deps app` — no schema change, no
  migration, so no owner action needed this time): `db` `StartedAt` identical before/after
  (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Verified against
  `titanor-time-db-1`: `GET /api/health`/`GET /api/ready` carry `X-Request-Id`; `GET /api/auth/session`
  without a cookie and `POST /api/auth/login` without CSRF both carry `X-Request-Id` matching their
  error body's `requestId`; `GET /api/admin/cities` without a cookie and `POST /api/auth/logout-all`
  without CSRF both carry `X-Request-Id`. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after, not touched;
  `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `createAuditEvent()`, any code that actually writes an `AuditEvent` row, `POST
  /api/admin/cities`, any other admin/worker endpoint, the idempotency-record schema, the
  last-active-`SUPER_ADMIN` protection invariant, and `role.assign`/any role-management endpoint.

**`createAuditEvent()` shared helper** (T5.6 sixth sub-step, owner-confirmed to proceed once both
prerequisites closed — `titanor-time-app/lib/audit.ts`, this commit):
- Причина: both things the owner named as blocking this — `AuditEvent` schema (commit `fbeec60`) and
  `X-Request-Id` on every response (commit `bf75962`) — were done; nothing technical remained except
  writing the helper itself. Same "build ahead of the first real consumer" pattern already used for
  `hasPermission()` (commit `8fb72c2`) — no route calls this yet.
- `createAuditEvent(tx: Prisma.TransactionClient, input: AuditEventInput): Promise<void>` — takes the
  caller's own transaction client, not the top-level `prisma` singleton, and writes exactly one
  `AuditEvent` row through it. This is what makes `03_DATA_MODEL_ERD.md` §3's rule ("Действие +
  `AuditEvent` — одна транзакция") structural rather than a convention callers have to remember: since
  `tx` must already come from an open `$transaction()`, the audit row can only ever commit or roll back
  together with whatever business write it documents. Doc comment also restates the §4.8 constraint
  that `beforeValue`/`afterValue` must never carry GPS/password/token values — the function itself does
  not scrub them, that's on each caller.
- **Two implementation snags found by the type checker/build, not manually** — both fixed before
  testing:
  - Prisma's generated input type for a nullable `Json` column doesn't accept a plain TypeScript `null`
    (only `InputJsonValue | NullableJsonNullValueInput | undefined`) — passing bare `null` would need
    `Prisma.JsonNull` (stores the JSON literal `null`) vs. the actually-intended `Prisma.DbNull` (stores
    real SQL `NULL`). Fixed by mapping an explicit `null` input to `Prisma.DbNull`.
  - `titanor-time-app/node_modules`' local physical copy of the generated Prisma Client (kept for local
    type-checking only — separate from what Docker regenerates independently during its own image
    build, same setup used after every prior schema change) was stale from before the `AuditEvent`
    migration, causing a real `Property 'auditEvent' does not exist on type 'TransactionClient'` build
    error. Regenerated at the repo root and re-copied — same procedure as after the second migration.
- **Tested on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume, all six
  migrations applied): one throwaway script, three scenarios, 12 assertions, all passed —
  - Committed transaction: a `City` row and an `AuditEvent` row created together via the same `tx`,
    both persisted after commit; `actorUserId` and `afterValue` (a small JSON object) stored correctly.
  - **Rolled-back transaction — the actual point of this helper**: `City` created, `createAuditEvent()`
    called, then the callback throws (simulating a business-logic failure *after* the audit write).
    Caught the rejection outside, then confirmed via direct query that **neither** the `City` **nor**
    the `AuditEvent` row exists — proving real atomicity, not just documented intent.
  - `LOGIN_FAILED`-style call with `actorUserId=null`/`entityId=null` in its own committed
    transaction — persisted correctly; omitted `beforeValue`/`afterValue` confirmed stored as real SQL
    `NULL` (not the JSON literal `null`) via a follow-up query.
  - `npx tsc --noEmit`/`npm run build` clean (root and `titanor-time-app`) after the Prisma Client
    refresh. Disposable container removed, temporary test script deleted, nothing else committed from
    the test run.
- **Not deployed** — no route calls this yet, so rebuilding/redeploying real `app` would be a no-op
  change to the running image; same reasoning as `hasPermission()`'s commit.
- **Not in this task**: any code that actually calls `createAuditEvent()` from a real route, `POST
  /api/admin/cities` or any other admin/worker endpoint, the idempotency-record schema, the
  last-active-`SUPER_ADMIN` protection invariant, and `role.assign`/any role-management endpoint.

**Owner priority pivot: `POST /api/auth/login` wired to `createAuditEvent()` (checkpoint 1 of 2, commit
`80c201d`)** — owner explicitly deferred `IdempotencyKey`/`POST /api/admin/cities` in favor of the
first visible, real, working user path. `login` chosen as first audit-writer specifically because it's
already contract-required (`04_...` §1: `Audit: LOGIN_SUCCEEDED / LOGIN_FAILED`), needs no
`Idempotency-Key`, and leads directly to a working login page (checkpoint 2):
- `LOGIN_SUCCEEDED` added inside the pre-existing success `$transaction()`, same `tx` as the
  `UserSession` write — not a second transaction after the session is issued. `actorUserId`/`entityId`
  = the authenticated user's id, `entityType='AUTHENTICATION'`, `requestId` = the handler's existing
  request-scoped id.
- `LOGIN_FAILED` added via a new `recordLoginFailed(requestId)` helper, shared by both
  `INVALID_CREDENTIALS` paths (unknown identifier, wrong password) — `actorUserId=null`,
  `entityId=null`, no identifier/email/username/password/hash/cookie/token/IP/user-agent ever passed
  in, so the audit trail can't be used to distinguish "no such account" from "wrong password" any more
  than the already-shared `401` response can. `PENDING_ACTIVATION`/`DEACTIVATED`/`CSRF`/`VALIDATION`/
  `RATE_LIMITED` paths untouched — contract names only these two events for this endpoint.
- Tested on disposable PostgreSQL 16: successful login → exactly one `UserSession` + one
  `LOGIN_SUCCEEDED` `AuditEvent`, `requestId` matching the response's `X-Request-Id` header exactly;
  wrong password / unknown identifier → identical `401 INVALID_CREDENTIALS`, each producing one
  `LOGIN_FAILED` with `actorUserId`/`entityId` both `NULL` and `beforeValue`/`afterValue`/`reason` all
  `NULL` (nothing could have leaked into them — the schema has no field for those values at all);
  dedicated atomicity test replicating login's exact transaction shape (`UserSession.create` +
  `createAuditEvent` via the same `tx`, then a deliberate throw) confirmed neither row exists after
  rollback; regression-confirmed `PENDING_ACTIVATION`/`DEACTIVATED`/`CSRF_REJECTED`/`RATE_LIMITED`
  (6th attempt) all unchanged. `npx tsc --noEmit`/`npm run build` clean, `prisma validate` clean (no
  schema change). Not deployed as part of this commit — bundled into the checkpoint-2 deploy below.

**First real `/login` page, scaffold removed (checkpoint 2 of 2, commit `5bb5cb2`)** — connects to the
now audit-wired `POST /api/auth/login`, no mock API, no fake auth:
- `app/login/page.tsx` (client component): single `identifier` field + `password`, real `fetch` with
  the required `X-Requested-With: titanor-time` header and same-origin credentials. Loading state
  disables both fields + the submit button and swaps its label (no double-submit). `INVALID_CREDENTIALS`
  shows one identical message regardless of cause (`01_SCREEN_MAP.md` §1 enumeration-safety
  requirement); `ACCOUNT_PENDING_ACTIVATION`/`ACCOUNT_DEACTIVATED`/`RATE_LIMITED` each get their own
  distinct message. Network/fetch failures are caught inline — never an uncaught rejection/blank
  screen. Password only ever lives in React state long enough to submit — never logged, never in
  `localStorage`, never in a URL.
- `app/login/i18n.ts`: small self-contained FI/EN/RU dictionary, no i18n library — chosen locale
  persists to both `localStorage` (`titanor-time-locale`) and cookie `NEXT_LOCALE`, matching the screen
  map's spec; `document.lang` updates too.
- Post-login redirect (owner's explicit mapping for this checkpoint, not `01_SCREEN_MAP.md`'s
  `/admin`/etc — none of these destinations exist as real pages yet, and per instruction no placeholder
  was faked in to hide that): `SUPER_ADMIN`/`ADMIN` → `/admin/setup`, `FOREMAN` → `/foreman`, `WORKER`
  → `/worker`. No matching role → inline "no role assigned" message, no dead-end redirect.
- `app/globals.css` (new): dark theme reusing the exact color tokens and input/button/focus-state
  patterns already established in the root `titangroup` site's own `globals.css` (particularly its
  existing `.admin-login-form` rules) — matched by value, not imported (separate deployable app/Docker
  service). No new UI library. `public/titanor-logo.png`: physical copy of the existing brand asset
  (root `public/assets/brand/titanor-group.png`, already used in the main site's header), unmodified.
- `app/page.tsx`: root now `redirect('/login')` (server component, `next/navigation`) — the "scaffold
  only" placeholder text is gone; no duplicate form on both `/` and `/login`.
- **Tested in a real browser**, not just `tsc`/`build`: Playwright + the system's already-cached
  Chromium build, invoked via `npx` from the scratchpad directory (a throwaway `npm install
  playwright --no-save` there, never touching `titanor-time-app/package.json` — not a project
  dependency) — against `next dev` on disposable PostgreSQL 16 (all six migrations, seeded
  `SUPER_ADMIN`/`FOREMAN`/`WORKER`/`PENDING_ACTIVATION`/`DEACTIVATED` users with real Argon2id
  passwords). 19 assertions, all passed: root redirects to `/login`; default locale Finnish, `EN`/`RU`
  switch correctly and persist to `localStorage` + `NEXT_LOCALE` cookie; empty submit blocked by native
  `required` validation; wrong password and unknown identifier produce the byte-identical
  `INVALID_CREDENTIALS` message; form re-enables after a failed attempt; `PENDING_ACTIVATION`/
  `DEACTIVATED` show their own distinct messages; a real successful `SUPER_ADMIN` login sets a real
  `HttpOnly` `tt_session` cookie and navigates toward `/admin/setup` (`404` there is expected — that
  page doesn't exist yet); `390px` mobile viewport fits the card without overflow; labels correctly
  associated via `htmlFor`, `Tab` moves `identifier` → `password`. Desktop/mobile screenshots visually
  reviewed. `npx tsc --noEmit`/`npm run build` clean (root and `titanor-time-app`; `/login` and `/` both
  compile, `/` static per Next's own build output).
- **Security/ops incident during this task's cleanup, disclosed immediately, no data loss**: while
  killing stray local `next dev` test servers on the host between test runs, the agent repeatedly
  matched and killed the **real `titanor-time-app-1` container's own process** instead — its
  `node server.js` process is visible on the host (no `PidMode: host` is set, but Docker does not hide
  container processes from the host process list either) as `next-server (v16.2.12)`, indistinguishable
  by name from the agent's own local test instances, and the agent had been killing by name-pattern
  match without cross-checking `docker inspect titanor-time-app-1 --format '{{.State.Pid}}'` first. A
  second contributing factor: the agent had been assuming system local time was `Europe/Helsinki`
  (matching the project's own timestamps) when correlating "recent" PIDs, but the host's actual local
  timezone is `Europe/Berlin` (CEST, +02:00) — a mismatch that made the real container process's start
  time look more "recent/suspicious" than it should have. Net effect: 4 unwanted restarts of the real
  `app` container between roughly 02:24–02:37 CEST, self-healed each time via its existing
  `restart: unless-stopped` policy (visible in `docker logs` as repeated clean `✓ Ready in 0ms`, no
  crash/error output). **No data loss** — `app` is fully stateless, all real state lives in `db`, which
  showed `RestartCount=0` throughout and was never touched; CollabStudio and `titanorgroup.fi` were
  unaffected (`200` before/during/after). Caught and disclosed to the owner *before* the checkpoint-2
  deploy step below, not after. Process fix going forward: never `kill -9` anything matching a
  container's process name on this host without first confirming the PID against `docker inspect`;
  don't assume this host's local `date`/`ps` timestamps are in `Europe/Helsinki` — they're
  `Europe/Berlin`.
- **Deployed to real `app`** (`docker compose -f compose.titanor-time.yaml up -d --build app`, exactly
  as instructed): `db` `StartedAt` identical before/after (`2026-07-28T14:33:34Z`, `RestartCount=0`
  throughout, never recreated); `app` recreated fresh, `healthy`, `RestartCount=0` on the new instance.
  Verified against `titanor-time-db-1`: `GET /api/health` → `200`; `GET /api/ready` → `200, database:
  connected`; `GET /login` → `200` (static, prerendered); `GET /` → `307` to `/login`; logo asset →
  `200`. Regression: `POST /api/auth/login` without CSRF → still `403`; `GET /api/admin/cities`/`GET
  /api/auth/session` without a cookie → still `401`. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after this deploy step,
  not touched; `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `/admin/setup`, admin shell, `POST /api/admin/cities`/`IdempotencyKey`, any new
  backend endpoint, schema changes, migrations — all explicitly deferred per owner instruction.

**`/admin/setup` — first protected admin screen, real checklist, no mock statistics (two checkpoints +
one same-day fix, commits `90d2e55`/`1cba420`/`fa7720e`)**:
- Причина: owner-named next step после login. Per `01_SCREEN_MAP.md` §2 и `04_ADMIN_FIRST_API_CONTRACTS.md`
  §10 — чек-лист первого вертикального сценария (7 булевых флагов: `hasCity`/`hasSite`/`hasWorkArea`/
  `hasTemplate`/`hasWorker`/`hasAssignment`/`hasOpenPeriod`), явно «не декоративный dashboard». Нужен ни
  новой схемы (все 7 таблиц существуют с первой migration), ни `AuditEvent` (read-only, `Аудит=нет` по
  матрице), ни `IdempotencyKey` (не мутирующий endpoint) — поэтому достижим без `POST /api/admin/cities`.
- **Checkpoint 1 (commit `90d2e55`)** — backend: седьмая migration (чистый `INSERT`) сеет
  `worker.read.all` → `ADMIN`/`SUPER_ADMIN` (тот же паттерн, что `city.read.all`); `lib/setup-status.ts`
  (`getSetupStatus()`) — единый источник для 7 флагов, переиспользуемый и роутом, и страницей (без
  HTTP self-fetch и без дублирования запросов); `GET /api/admin/setup-status`. Попутный рефактор:
  `resolveAuthenticatedSession()` теперь принимает `string | undefined` (токен) вместо `NextRequest` —
  Server Component (страница) не имеет `NextRequest`, только `next/headers` `cookies()`; обновлены все
  5 существующих вызовов (session/logout/logout-all/cities роуты + `proxy.ts`), поведение не изменилось.
  Добавлен `lib/server-session.ts` (`resolveServerSession()`) — тонкая обёртка для будущих защищённых
  страниц (`/foreman`, `/worker`).
- **Checkpoint 2 (commit `1cba420`)** — frontend: `app/admin/setup/page.tsx`, Server Component.
  Нет сессии → `redirect('/login')`; есть сессия, но нет роли `ADMIN`/`SUPER_ADMIN` → inline «Access
  denied» на этой же странице (не редирект — пользователь уже аутентифицирован, отправлять его обратно
  на форму логина было бы confusing; не отдельная `/403`-страница — не создана, вне scope). Чек-лист —
  ровно то, что вернул `getSetupStatus()`, без чисел; ссылки «Create» только на пункты, у которых
  screen map явно называет destination (`/admin/sites/new`, `/admin/templates/new`,
  `/admin/workers/new`, `/admin/assignments/new`, `/admin/periods`) — ни для City (informational), ни
  для Work area (создаётся в рамках объекта, отдельного route в доках нет) ссылка не придумана.
- **Тестировано в реальном браузере** (Playwright + системный Chromium, эфемерно через `npx`, не
  зависимость проекта) на одноразовом PostgreSQL 16 с частично заполненными данными (реальные `City`+
  `WorkSite`+`Employee` в базе — не all-true/all-false): реальный логин `SUPER_ADMIN` → реальная
  страница с реальными данными сессии (username+роль в подзаголовке); все 7 пунктов присутствуют;
  City/Site/Worker (засеяны) → `Done`; остальные 4 → `Not done` с `Create`-ссылкой (кроме Work area —
  без ссылки, как задумано); `FOREMAN` с валидной сессией, но не тем URL → inline «Access denied», без
  redirect-петли; без сессии совсем → редирект на `/login`. Скриншот проверен визуально.
- **Инцидент того же дня (commit `fa7720e`), обнаружен и исправлен агентом самостоятельно после
  первого деплоя checkpoint 2**: `curl` на `/admin/setup` без cookie возвращал `200` со stub-HTML
  (meta-refresh + RSC redirect marker) вместо честного `307` — из-за `loading.tsx`, включавшего
  streaming для этого route segment: `async`-компонент успевал начать отправку ответа (200, уже
  отправленные заголовки) до того, как `await resolveServerSession()` разрешался и `redirect()`
  вызывался, так что Next.js не мог изменить statuscode постфактум и подставлял client-side fallback.
  В реальном браузере это работало (JS подхватывал redirect, тест checkpoint 2 это не поймал), но было
  тише/слабее для любого non-JS клиента (curl, боты, health-check). Исправление — убрать `loading.tsx`
  (резолв сессии + 7 `count()`-запросов — суб-100мс, полноценный loading UI не требовался), это
  останавливает streaming для этого route и возвращает honest top-level `307`. Проверено на реальной
  standalone-сборке (`node .next/standalone/server.js`, тот же код-путь, что Docker) против
  одноразового PostgreSQL 16: без cookie → `307`+`Location: /login`; с валидной cookie `SUPER_ADMIN` →
  по-прежнему `200` с реальным чек-листом (аутентифицированный путь не задет фиксом).
- **Деплой** (два `docker compose build app` + `up -d --no-deps app` шага — второй после fix):
  `db` не пересоздавалась ни разу (`StartedAt` неизменен, `RestartCount=0`), `app` пересоздан дважды,
  healthy оба раза. Финально на `titanor-time-db-1`: `GET /admin/setup` без cookie → честный `307` на
  `/login`; `GET /api/admin/setup-status` без cookie → `401`; регрессия (`login` без CSRF → `403`,
  `cities` без cookie → `401`) не нарушена. CollabStudio/`titanorgroup.fi` не задеты.
- **Not in this task**: `/admin/sites/new`, `/admin/templates/new`, `/admin/workers/new`,
  `/admin/assignments/new`, `/admin/periods` — целевые страницы не существуют, их `Create`-ссылки
  сейчас дают `404` (не скрыто, явно отмечено). Admin shell/nav — по-прежнему не построен.

**`IdempotencyKey` + первый мутирующий admin-first endpoint + первая проходимая destination чек-листа
(четыре коммита `ddf44a3`/`6a322bc`/`d1c6cc0`/`145bfec`)**:
- Причина: явное делегирование владельца — «делаем всё по roadmap ... чек-лист должен быть проходимым.
  Что важней ... то и делай». Разбор контрактов (`04_...` §2–3) показал: и `city.create`, и
  `site.create` требуют `Idempotency-Key` support, но `City` информационный/необязательный (сам
  чек-лист это отмечает), а `Site` — первый по-настоящему обязательный пункт (`01_SCREEN_MAP.md`:
  «`/admin/sites/new` ... DoD: создание работает без единого города в системе»). Значит
  `IdempotencyKey` — не откладываемая параллельная ветка, а прямая зависимость первого настоящего шага.
- **`IdempotencyKey` schema (commit `ddf44a3`, восьмая migration)** — дизайн из `03_DATA_MODEL_ERD.md`
  §4.1 показан владельцу и подтверждён без правок (в отличие от `AuditEvent`): `actorUserId` NOT NULL
  FK→User (здесь всегда есть аутентифицированный actor, в отличие от nullable в `AuditEvent`),
  `httpMethod`/`routeTemplate`/`idempotencyKey`(uuid)/`requestHash`(hex sha256)/
  `status enum(PROCESSING|COMPLETED)`/`encryptedResponseBody bytea?`/`statusCode int?`/`expiresAt`;
  unique `(actorUserId, httpMethod, routeTemplate, idempotencyKey)` — path-параметры сознательно
  исключены из ключа (участвуют только в `requestHash`). Владелец выбрал способ обеспечения
  AES-256-GCM ключа: агент даёт `openssl rand -base64 32`, владелец сам добавляет
  `IDEMPOTENCY_ENCRYPTION_KEY` в `.env.titanor-time` — агент этот файл не видит и не трогает.
  Протестировано `migrate deploy` + `migrate diff --exit-code` на одноразовом PostgreSQL 16 — ноль drift.
- **`lib/idempotency.ts` (commit `6a322bc`, без вызывающего кода)** — `beginIdempotentRequest()`/
  `completeIdempotentRequest()`: insert-then-catch-`P2002` (unique constraint БД, а не код,
  сериализует гонку), четыре ветки контракта (new/cached/reused-conflict/in-progress-conflict),
  AES-256-GCM через `IDEMPOTENCY_ENCRYPTION_KEY`. Вызывается только когда клиент реально прислал
  заголовок `Idempotency-Key` — по `04_...` §3 он «поддерживается», не «обязателен» для `site.create`
  (в отличие от `absence.approve`). 15 assertions на одноразовом PostgreSQL 16: точный повтор → кэш,
  тот же ключ/другое тело → `IDEMPOTENCY_KEY_REUSED`, ещё обрабатывается →
  `IDEMPOTENCY_KEY_IN_PROGRESS`, **настоящая гонка через `Promise.all`** (доказывает, что сериализует
  constraint БД, не порядок вызовов в коде), независимость между разными `actorUserId`, расшифровка
  чужим ключом падает (проверка GCM auth tag).
- **`POST /api/admin/sites` (commit `d1c6cc0`, девятая migration — seed `site.create` →
  `ADMIN`/`SUPER_ADMIN`)** — первый реальный мутирующий admin-first endpoint. CSRF → auth →
  permission → parse body → (если есть `Idempotency-Key`) begin/cache-branch → валидация (`name`
  обязателен, `cityId` опционален и должен существовать → `404 CITY_NOT_FOUND`, `address`/
  `description` опциональны) → `WorkSite.create` + `createAuditEvent(SITE_CREATED)` в одной
  транзакции → (если был ключ) complete. Валидационные и `CITY_NOT_FOUND`-ошибки тоже кэшируются
  идемпотентностью. Протестировано по реальному HTTP на одноразовом PostgreSQL 16: 401/403/CSRF-403/
  400/404/201 плюс полный жизненный цикл `Idempotency-Key` — кэшированный повтор подтверждён на уровне
  БД: ровно 1 `WorkSite` и ровно 1 `AuditEvent` на 2 реальных создания (не 3).
- **`/admin/sites/new` (commit `145bfec`)** — первая реально работающая destination чек-листа
  `/admin/setup`. Тот же Server Component auth/role-gate паттерн, что `/admin/setup` (без
  `loading.tsx`, урок §10). Клиентская форма: `name`/`cityId` (select, заполняется через уже
  существующий `GET /api/admin/cities`)/`address`/`description`; один `Idempotency-Key` на попытку
  отправки, переиспользуется только при повторе после сетевой ошибки (не после настоящего
  HTTP-ответа — тогда ключ сбрасывается, чтобы отредактированная форма не наткнулась на
  `IDEMPOTENCY_KEY_REUSED`). После успеха — редирект на `/admin/setup` (не на ещё не существующий
  `/admin/sites/[siteId]`, явно, а не скрыто заглушкой). Протестировано в реальном headless-браузере
  (Playwright, `node .next/standalone/server.js` — тот же код-путь, что Docker) на одноразовом
  PostgreSQL 16: полный флоу с выбором города, inline-ошибка валидации без навигации, `WORKER` —
  inline access denied без redirect-петли, без сессии — редирект на `/login`; данные созданного
  `WorkSite` сверены напрямую в БД.
- **Деплой и инцидент (не запрошенный владельцем, найден и раскрыт агентом сразу)**: владелец
  сгенерировал `IDEMPOTENCY_ENCRYPTION_KEY` (`openssl rand -base64 32`) и добавил в
  `.env.titanor-time` сам; применил обе migrations (8-ю, 9-ю) к `titanor-time-db-1` тем же способом,
  что раньше. Агент выполнил `docker compose -f compose.titanor-time.yaml up -d --build app` — **но
  пересоздался не только `app`, а и `db`**, хотя явно был указан только `app`: `db` тоже читает
  `.env.titanor-time` через `env_file`, и добавленная владельцем строка изменила вычисленный конфиг
  `db`-сервиса, из-за чего Compose пересоздал и его контейнер тоже. Проверено сразу (см. §10): том
  `titanor-time_db_data` — тот же самый (не новый volume); `docker logs` показал «database directory
  appears to contain a database; skipping initialization» и обычный `shutdown at ... / ready to accept
  connections» — не `initdb` с нуля; `prisma migrate deploy`, выполненный владельцем непосредственно
  перед этим шагом, уже подтвердил «9 migrations found», из которых применились только 2 новые — то
  есть прежняя история/данные были на месте до пересоздания. Данные не теряются при пересоздании
  контейнера, пока volume тот же (стандартное поведение Docker), но это всё равно нарушает правило
  «`db` не пересоздавать без подтверждения» — раскрыто владельцу немедленно. Владелец лично зашёл на
  сайт и подтвердил: вход работает, меню и данные видны как обычно. Структурная проверка агента:
  `/api/health` ok, `/api/ready` → `database: connected`, `/`/`/admin/setup`/`/admin/sites/new` без
  сессии → честный `307` на `/login`, `POST /api/admin/sites` без сессии → `401`; CollabStudio/
  `titanorgroup.fi` не задеты (`docker ps`, идентичные `StartedAt`/healthy).
- **Not in this task**: `POST /api/admin/cities` (`city.create`) по-прежнему не реализован — `City`
  информационный/необязательный, поэтому не требовался для «проходимости» чек-листа; `GET
  /api/admin/sites` (список)/`PATCH /api/admin/sites/:siteId`/`/admin/sites/[siteId]` — не
  реализованы, поэтому форма редиректит на `/admin/setup`, а не на карточку созданного объекта;
  `role.assign`/role-management — не начат; `/admin/templates/new`, `/admin/workers/new`,
  `/admin/assignments/new`, `/admin/periods` — остальные destinations чек-листа всё ещё не
  реализованы, их `Create`-ссылки по-прежнему дают `404`.

**`POST /api/admin/templates` + `/admin/templates/new` — второй мутирующий admin-first endpoint и
вторая проходимая destination чек-листа (коммиты `6bf5232`/`4962ac6`, одиннадцатая migration)**:
- Причина: продолжение той же задачи владельца («продолжаем!») тем же паттерном, что `Site` — по
  порядку сценария `04_...` (объект → рабочая область → шаблон → …) и по чек-листу `/admin/setup`
  следующий проходимый пункт — `Work schedule template` (у `Work area` по-прежнему нет отдельного
  route в доках, создаётся в рамках объекта). Никакой новой схемы не нужно —
  `WorkScheduleTemplate`/`Version`/`VersionDay` существуют с самой первой (frozen) migration, включая
  реальные CHECK-constraints CK-06 (`weekday` 0–6)/CK-07 (working/non-working day shape)/CK-08
  (`plannedBreakMinutes >= 0`) — нужен был только новый permission seed.
- **`POST /api/admin/templates` (commit `6bf5232`, одиннадцатая migration — seed `template.create` →
  `ADMIN`/`SUPER_ADMIN`)**: CSRF → auth → permission → parse body → (если есть `Idempotency-Key`)
  begin/cache-branch → валидация `days` (ровно 7 элементов, `weekday` 0–6 без повторов, для
  `isWorkingDay=true` обязательны `plannedStartTime`/`plannedEndTime` и `plannedBreakMinutes >= 0`,
  для `isWorkingDay=false` оба времени обязаны отсутствовать и `plannedBreakMinutes` обязан быть `0`)
  → `WorkScheduleTemplate.create` + `WorkScheduleTemplateVersion` (versionNumber=1) + 7
  `WorkScheduleTemplateVersionDay` + `createAuditEvent(TEMPLATE_CREATED)` в одной транзакции → (если
  был ключ) complete. Валидация приложения намеренно зеркалит уже существующие DB CHECK CK-06/07/08 —
  единственная цель зеркалирования: вернуть чистый `400 VALIDATION_ERROR` вместо сырого `23514`.
  Протестировано по реальному HTTP на одноразовом PostgreSQL 16: валидное создание (5 рабочих + 2
  выходных дня), неверное количество дней, дублирующийся `weekday`, все 4 нарушения shape (рабочий
  день без времени, выходной со временем, выходной с ненулевым перерывом, отрицательный перерыв),
  полный жизненный цикл `Idempotency-Key` (кэшированный повтор подтверждён на уровне БД — ровно 1
  `WorkScheduleTemplate` и ровно 1 `AuditEvent` на 2 реальных создания), 401/403/CSRF-403. Отдельно
  сверены в БД все 7 `WorkScheduleTemplateVersionDay` — времена корректно round-trip'ятся через
  `@db.Time(0)`.
- **`/admin/templates/new` (commit `4962ac6`)** — вторая реально работающая destination чек-листа. Тот
  же Server Component auth/role-gate паттерн (без `loading.tsx`). Форма: `name`/`description`
  (опционально) + 7 строк пн–вс, каждая с чекбоксом «рабочий день», по умолчанию пн–пт рабочие
  (09:00–17:00, перерыв 30 мин), сб–вс выходные — время/перерыв скрываются, когда день выходной, и
  появляются обратно при включении, без перезагрузки формы. Тот же `Idempotency-Key`-паттерн
  (переиспользуется только после сетевой ошибки), редирект на `/admin/setup` после успеха (страницы
  `/admin/templates/[templateId]` ещё нет). Протестировано в реальном headless-браузере (Playwright,
  standalone-сборка) на одноразовом PostgreSQL 16: дефолтная форма отправляется успешно, toggle
  чекбокса живо показывает/прячет поля времени, вторая заявка с изменённой формой тоже создаётся
  успешно, без сессии — редирект на `/login`.
- **Деплой**: применено владельцем к `titanor-time-db-1` тем же способом, что раньше (без нового
  секрета — `IDEMPOTENCY_ENCRYPTION_KEY` уже добавлен в прошлый раз). `docker compose up -d --build
  app` на этот раз пересоздал **только** `app` (`db` `StartedAt` не изменился) — подтверждает, что
  прошлый инцидент (см. §10) был вызван именно изменением `env_file`, а не общим паттерном поведения
  Compose. Структурная проверка: `/api/health` ok, `/api/ready` → `connected`,
  `/admin/templates/new` без сессии → `307`, `POST /api/admin/templates` без сессии → `401`,
  регрессия (`sites`/`setup`/`login`) чистая, CollabStudio/`titanorgroup.fi` не задеты.
- **Not in this task**: `GET /api/admin/templates` (список)/`PATCH /api/admin/templates/:templateId`/
  `/admin/templates/[templateId]` — не реализованы; `POST /api/admin/cities`, `/admin/workers/new`,
  `/admin/assignments/new`, `/admin/periods` — не реализованы; `role.assign`/role-management — не начат.

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

- Password delivery как общий процесс для будущих (не первого) аккаунтов (доставка пароля/кода
  активации при создании новых пользователей через admin API — для первого `SUPER_ADMIN` уже закрыто:
  владелец ввёл собственный пароль напрямую в TTY, см. §5).
- MFA production gate (`REQUIRE_MFA_FOR_ADMIN=true`).
- Полный real-cookie end-to-end тест `GET /api/auth/session`/`logout`/`logout-all`/`proxy.ts`/`GET
  /api/admin/cities` против `titanor-time-db-1` (с реальным паролем владельца) — сделана только
  структурная проверка без cookie (см. §5, commits `383c7a2`/`a220d39`/`bf298d8`/`4f3e5a1`); не
  блокирует, следующий раз, когда владелец логинится, можно попутно проверить.
- Permission/role enforcement на `/api/admin/*`+`/api/worker/*` — `proxy.ts` (commit `a220d39`) гейтит
  только «аутентифицирован», не конкретное разрешение. `GET /api/admin/cities` (commit `bf298d8`),
  `POST /api/auth/logout-all` (commit `4f3e5a1`) и `GET /api/admin/setup-status` (commit `90d2e55`) —
  пока единственные роуты, реально подключившие `hasPermission()`; остальные будущие
  `/api/admin`/`/api/worker` роуты по-прежнему без permission-проверки, потому что не существуют.
- Реальный seed остального `Permission`/`RolePermission` из `02_ROLE_PERMISSION_MATRIX.md` —
  засеяны только `city.read.all` (commit `bf298d8`), `session.revoke_all.own` (commit `4f3e5a1`) и
  `worker.read.all` (commit `90d2e55`); ~50+ остальных строк сознательно не заполнены разом, сеются по
  одному endpoint'у за раз (см. обоснование в комментарии второй migration).
- `createAuditEvent()` (`lib/audit.ts`, commit `f67159f`) вызывается из `POST /api/auth/login`
  (`80c201d`), `POST /api/admin/sites` (`d1c6cc0`) и `POST /api/admin/templates` (`6bf5232`). Остальные
  будущие mutating-эндпоинты (в т.ч. `POST /api/admin/cities`) его ещё не вызывают.
- `IdempotencyKey` (`03_DATA_MODEL_ERD.md` §4.1) — **реализована** (schema `ddf44a3`, helper
  `6a322bc`, см. §5); подключена к `POST /api/admin/sites` (`d1c6cc0`) и `POST /api/admin/templates`
  (`6bf5232`). Любой другой будущий мутирующий admin/worker endpoint, где контракт помечает
  `Idempotency-Key`, должен подключить её так же.
- `POST /api/admin/cities` (`city.create`) — не начат; `City` информационный/необязательный флаг
  чек-листа, поэтому не был нужен ни для первой, ни для второй проходимой destination. `GET
  /api/admin/sites`/`/api/admin/templates` (списки), `PATCH /api/admin/sites/:siteId`/
  `/api/admin/templates/:templateId`, `/admin/sites/[siteId]`/`/admin/templates/[templateId]` — не
  начаты; весь остальной admin/worker API кроме уже реализованных — тоже не начат.
- Инвариант «последний активный `SUPER_ADMIN` не удаляется/не блокируется/не понижается» — не
  реализован нигде (некуда: нет ни одного role-management endpoint).
- Admin-first API (`04_ADMIN_FIRST_API_CONTRACTS.md`) — начат (`GET /api/admin/cities` `bf298d8`,
  `POST /api/admin/sites` `d1c6cc0`, `POST /api/admin/templates` `6bf5232`), остальное не начато.
- `/admin/setup` реализован (см. §5, commits `90d2e55`/`1cba420`/`fa7720e`); `/foreman`, `/worker` —
  целевые страницы после логина для остальных ролей всё ещё не реализованы, вход туда даёт `404`.
- `/admin/sites/new` (`145bfec`) и `/admin/templates/new` (`4962ac6`) реализованы (см. §5).
  `/admin/workers/new`, `/admin/assignments/new`, `/admin/periods` — остальные destinations с
  чек-листа `/admin/setup`, ни одна не реализована, `Create`-ссылки дают `404`.
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

### Operational incidents

- **Агент случайно перезапускал реальный `titanor-time-app-1` 4 раза во время локальной очистки
  тестовых процессов — RESOLVED, без потери данных.** Во время runtime-тестирования checkpoint 2 (commit
  `5bb5cb2`) агент неоднократно чистил зависшие локальные `next dev`-серверы командой вида `ps aux |
  grep "next-server" | grep -v grep` + `kill -9 <pid>` по имени процесса, не сверяя PID с `docker
  inspect titanor-time-app-1 --format '{{.State.Pid}}'` перед убийством. Реальный процесс контейнера
  (`node server.js`) виден в хостовом `ps aux` как `next-server (v16.2.12)` — неотличимо по имени от
  локальных тестовых инстансов. Отдельно агент ошибочно полагал системную таймзону этой машины
  `Europe/Helsinki` (по аналогии с таймстампами проекта), тогда как реальная — `Europe/Berlin` (CEST,
  +02:00); это исказило суждение о том, какой PID «недавний и явно мой тестовый».
  - **Обнаружено и раскрыто владельцу самим агентом**, до выполнения запрошенного финального шага
    (`docker compose up -d --build app`) — не после, не по запросу владельца.
  - **Факт**: 4 рестарта контейнера `app` между ~02:24 и ~02:37 CEST (по `docker logs --timestamps` —
    чистые повторные `✓ Ready in 0ms`, без crash/error вывода — процесс завершался, `restart:
    unless-stopped` поднимал заново). `db` — `RestartCount=0` весь период, не тронута ни разу (все
    реальные данные живут там, `app` полностью stateless). CollabStudio/`titanorgroup.fi` — не задеты,
    `200` до/во время/после.
  - **Исправление процесса**: больше не `kill -9` ничего, подходящего по имени процесса контейнера, без
    предварительной сверки PID через `docker inspect`; не полагаться на предположение таймзоны хоста —
    проверять `date`/`timedatectl` напрямую. Соблюдено в следующей же задаче (`/admin/setup`) — очистка
    тестовых dev-серверов делалась по точному PID, найденному через `ss -tlnp` по порту, со сверкой
    против `docker inspect titanor-time-app-1` перед каждым `kill`.

- **`/admin/setup` тихо отдавал `200` вместо `307` неаутентифицированным non-JS клиентам —
  RESOLVED, найдено и исправлено агентом самостоятельно (commit `fa7720e`), без отдельного инцидента
  для владельца.** Причина — `loading.tsx` включал streaming для route segment; `async` Server
  Component с `await` перед `redirect()` не успевал вызвать redirect до того, как Next.js уже начинал
  отправлять `200`-ответ (`loading.tsx`-заглушку), из-за чего наружу уходил client-side fallback
  (meta-refresh + RSC redirect marker) вместо честного top-level HTTP `307`. В реальном браузере
  (включая Playwright-тест checkpoint 2) это работало корректно — JS подхватывал redirect — поэтому
  тест checkpoint 2 не поймал проблему; обнаружено только при структурной curl-проверке после первого
  деплоя. Исправление — убрать `loading.tsx` (резолв сессии + 7 `count()` — суб-100мс, полноценный
  loading UI не был нужен), что останавливает streaming и возвращает честный `307`. Подтверждено на
  реальной standalone-сборке против одноразового PostgreSQL 16 до повторного деплоя. **Урок для будущих
  защищённых Server Component страниц** (`/foreman`, `/worker` и т.д.): `async`-компонент с
  `redirect()` после `await` + соседний `loading.tsx` = client-side-only redirect для non-JS клиентов;
  либо не добавлять `loading.tsx`, если асинхронная работа перед `redirect()` действительно быстрая
  (сотни миллисекунд и меньше), либо явно проверять `curl` (не только реальный браузер) на предмет
  top-level статус-кода после любого такого изменения.

- **`docker compose up -d --build app` пересоздал также `db`, хотя был указан только `app` — RESOLVED,
  без потери данных, найдено и раскрыто агентом самостоятельно сразу после деплоя, до подтверждения
  задачи закрытой.** Причина: `db`-сервис тоже подключает `.env.titanor-time` через `env_file` в
  `compose.titanor-time.yaml`; когда владелец добавил туда новую строку `IDEMPOTENCY_ENCRYPTION_KEY`
  (нужна только `app`), это изменило вычисленный Compose-конфиг `db` тоже, и Compose решил, что `db`
  требует пересоздания контейнера — несмотря на то, что в команде был явно указан только сервис `app`.
  - **Проверено немедленно**: `docker inspect titanor-time-db-1` — примонтирован тот же named volume
    `titanor-time_db_data` (не новый); `docker logs titanor-time-db-1` — «Database directory appears to
    contain a database; Skipping initialization» + обычный `shutdown at ... / ready to accept
    connections», не `initdb` с нуля; `prisma migrate deploy`, который владелец выполнил
    непосредственно перед этим шагом, уже подтвердил «9 migrations found», из которых применились
    только 2 новые — то есть вся прежняя история миграций и данные были на месте до пересоздания
    контейнера. Пересоздание контейнера при том же volume не теряет данные (стандартное поведение
    Docker Compose) — но само событие всё равно противоречит правилу «`db` не пересоздавать без
    подтверждения владельца», поэтому раскрыто сразу, а не тихо пропущено.
  - **Подтверждено владельцем лично**: зашёл на реальный сайт, вход и меню/данные выглядят как обычно.
  - **Процесс на будущее**: если в `.env.titanor-time` меняется переменная, нужная только одному
    сервису, а `env_file` в compose общий для нескольких сервисов — Compose всё равно может счесть
    другие сервисы «изменившимися» и пересоздать их тоже, даже если в команде указан только один
    сервис. Явно предупреждать владельца об этом риске *до* следующего такого деплоя, а не только после.

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
- ~~Известен ли первый `SUPER_ADMIN` и способ передачи первого пароля~~ — **закрыто commit `836ef49`**:
  первый `SUPER_ADMIN` (`andrei.sakki`) создан в постоянной базе, пароль введён владельцем лично через
  интерактивный TTY bootstrap CLI, нигде не передавался и не проходил через чат (см. §5).
- ~~Ротировать ли `titanor_time_app` пароль после того, как он попал в вывод инструмента агента
  (`grep -v PASSWORD` не поймал значение внутри `DATABASE_URL`)~~ — **закрыто этой задачей**: владелец
  проинформирован сразу же, явно оценил риск как незначительный (свой сервер, экспозиция только внутри
  чата, не передавалась и не логировалась внешне) и отказался от ротации. Решение владельца, не решение
  агента — см. §5.

## 11. Следующий рекомендуемый шаг

Первый production `SUPER_ADMIN` (`andrei.sakki`) создан в постоянной `titanor-time-db-1` (см. §5, §2).
`UserSession` применена к реальной базе (commit `7795d3e`). Root tsconfig исправлен (commit `3c39d84`).
`POST /api/auth/login` (T5.5 core, commit `ecb37b2`) задеплоен на реальный `app` и подтверждён —
владелец сбросил забытый пароль через новый `reset-password` CLI (commit `be598f8`) и реально вошёл:
`200`, корректные `id`/`username`/`roles: ["SUPER_ADMIN"]` (см. §5, commit `e42025d`). `db` ни разу не
пересоздавался за все эти шаги.

`GET /api/auth/session` + `POST /api/auth/logout`/`logout-all` реализованы (commit `690686d`) и
задеплоены на реальный `app` (commit `383c7a2`). Route-protection `proxy.ts` для `/api/admin/*`+
`/api/worker/*` реализован, протестирован на standalone `server.js` + одноразовом PostgreSQL 16, и
задеплоен на реальный `app` (commit `a220d39`): `db` ни разу не пересоздавался за оба деплоя, `app`
пересоздан и `healthy` оба раза, login-регрессия проверена. `hasPermission()` — role-guard checking
primitive (T5.6 первый под-шаг, commit `0214f80`) — реализован и протестирован на одноразовом
PostgreSQL 16; без схемы, без seed, без роутов на момент своего commit.

Владелец подтвердил продолжение T5.6 с первого реального admin endpoint. `GET /api/admin/cities`
(T5.6 второй под-шаг, commit `bf298d8`) реализован, протестирован на одноразовом PostgreSQL 16,
четвёртая migration (seed `city.read.all` → `ADMIN`/`SUPER_ADMIN`) применена владельцем к
`titanor-time-db-1`, `app` пересобран и передеплоен, структурно проверен. Попутно закрыт долгий
«открытый хвост»: `prisma migrate status` против реальной `titanor-time-db-1` впервые явно подтверждён
владельцем — «Database schema is up to date!».

**Инцидент (не блокирует, зафиксирован для истории, commit `bf298d8`):** агент вывел реальный пароль
`titanor_time_app` (внутри `DATABASE_URL`) в chat при подготовке команды миграции — `grep -v PASSWORD`
не поймал его, так как пароль встроен в URL, а не под отдельным ключом `PASSWORD`. Владелец
проинформирован сразу же, оценил риск как незначительный (свой сервер, экспозиция только в чате) и
явно отказался от ротации — см. §5/§10. Не повторено в следующей задаче ниже — агент больше не
`cat`/`grep`'ает `.env.titanor-time` сам, просто передаёт готовую команду владельцу.

Владелец явно попросил работать строго по одной задаче за раз, не переходя к следующей, пока текущая
не закрыта — агент выбрал `session.revoke_all.own` следующим шагом именно потому, что он закрывается
полностью сам по себе (без нового design-checkpoint), в отличие от `AuditEvent`. **`session.revoke_all.own`
теперь реально проверяется на `POST /api/auth/logout-all`** (T5.6 третий под-шаг, commit `4f3e5a1`):
пятая migration (seed → все 4 роли) применена владельцем к `titanor-time-db-1`, `app` пересобран и
передеплоен, структурно проверен.

**`AuditEvent` спроектирован, показан владельцу, явно исправлен владельцем (nullable `actorUserId`/
`entityId`, индексы под cursor-пагинацию) и реализован** (T5.6 четвёртый под-шаг, commit `fbeec60`):
шестая migration (структура + `trg_audit_event_immutable`) протестирована на одноразовом PostgreSQL 16
(catalog + позитивные/негативные поведенческие тесты триггера и FK RESTRICT), применена владельцем к
`titanor-time-db-1`, `app` пересобран и передеплоен, полная регрессия чистая. Владелец явно разграничил
эту задачу от следующих двух — **request-context/`X-Request-Id` на каждом ответе** и
**`createAuditEvent()`** — как отдельных задач.

**`X-Request-Id` теперь генерируется на каждом ответе** (T5.6 пятый под-шаг, commit `bf75962`): все семь
существующих роутов (`health`, `ready`, `session`, `login`, `logout`, `logout-all`, `cities`) — не
только `jsonError()`, как раньше. Протестировано на одноразовом PostgreSQL 16 (success/error пары,
заголовок = `requestId` в теле ошибки), задеплоено на реальный `app` (без миграции — чистый код),
структурно проверено, полная регрессия чистая. Это закрывает prerequisite, который сам владелец назвал
условием для `createAuditEvent()`.

**`createAuditEvent()` реализован** (T5.6 шестой под-шаг, commit `f67159f`): общий helper пишет строку
`AuditEvent` через переданный вызывающим `tx` (Prisma transaction client), а не через синглтон `prisma`
— атомарность с бизнес-действием обеспечена конструктивно, не соглашением. Rollback-тест на одноразовом
PostgreSQL 16 доказал это напрямую: после симулированного сбоя внутри транзакции не остаётся ни строки
бизнес-таблицы, ни строки `AuditEvent`. Не задеплоено (нет вызывающего кода) и не подключено ни к одному
роуту — по тому же принципу, что `hasPermission()`: строится раньше первого реального потребителя.

**Владелец сменил приоритет**: `IdempotencyKey`/`POST /api/admin/cities` отложены; вместо них —
**первый видимый и реально работающий пользовательский путь**, двумя изолированными checkpoint'ами,
каждый своим коммитом:
1. **Checkpoint 1** (commit `80c201d`): `createAuditEvent()` подключён к `POST /api/auth/login` —
   `LOGIN_SUCCEEDED` внутри уже существующей success-транзакции (тот же `tx`, что `UserSession`),
   `LOGIN_FAILED` для обоих `INVALID_CREDENTIALS`-путей с `actorUserId`/`entityId = null`, без единого
   секретного/персонального значения. Протестировано на одноразовом PostgreSQL 16, включая
   dedicated-тест атомарности именно в форме login-транзакции.
2. **Checkpoint 2** (commit `5bb5cb2`): реальная страница `/login`, заменяет scaffold-заглушку `/`.
   Один `identifier`+`password`, реальный `fetch` в `POST /api/auth/login` с CSRF-заголовком,
   loading-состояние, enumeration-safe `INVALID_CREDENTIALS`, отдельные сообщения для
   `PENDING_ACTIVATION`/`DEACTIVATED`/`RATE_LIMITED`, FI/EN/RU с persist в `localStorage`+
   `NEXT_LOCALE`, существующий брендинг (логотип+палитра главного сайта, без новых UI-зависимостей).
   Redirect после входа: `SUPER_ADMIN`/`ADMIN` → `/admin/setup`, `FOREMAN` → `/foreman`, `WORKER` →
   `/worker` — ни одна из целевых страниц ещё не реализована, это явно зафиксировано, а не скрыто
   заглушкой. Протестировано в реальном headless-браузере (Playwright, эфемерно через `npx`, не
   зависимость проекта) — 19 assertions, все прошли.

**Инцидент во время тестирования checkpoint 2 (RESOLVED, без потери данных, зафиксирован в §10):**
агент по ошибке несколько раз перезапустил реальный `app`-контейнер при чистке локальных тестовых
процессов (совпадение имени процесса + неверное предположение о таймзоне хоста). `db` не пострадала,
раскрыто владельцу до выполнения финального деплоя.

Оба коммита задеплоены на реальный `app` одним шагом (`docker compose up -d --build app`, как просил
владелец): `db` не пересоздавалась, `app` пересоздан и healthy, `/login`/`/`/`/api/health`/`/api/ready`
проверены напрямую на `titanor-time-db-1`, регрессия чистая, CollabStudio/`titanorgroup.fi` не задеты.

**`/admin/setup` реализован** — первая защищённая страница с реальными данными, без mock-статистики,
двумя checkpoint'ами + один same-day fix (commits `90d2e55`/`1cba420`/`fa7720e`, см. §5 для деталей):
седьмая migration (seed `worker.read.all`), `GET /api/admin/setup-status`, рефактор
`resolveAuthenticatedSession()` под Server Component (`lib/server-session.ts`), сама страница-чек-лист,
и исправление найденного агентом бага (тихий `200`+client-redirect вместо честного `307` для
неаутентифицированных non-JS клиентов — см. §10). Применено владельцем к `titanor-time-db-1`,
задеплоено на реальный `app` дважды (второй раз — с fix), полная регрессия чистая.

Владелец разрешил агенту самому определить и выполнить следующий шаг («что важней в данный момент и
правильней — то и делай»), при условии строгого следования roadmap и требования сделать чек-лист
реально проходимым. Разбор контрактов показал, что `IdempotencyKey` — не отдельная отложенная ветка, а
прямая зависимость первого настоящего (не-опционального) шага чек-листа (`Site`, не `City`) — поэтому
обе цели сошлись на одной задаче: **`IdempotencyKey` schema + `lib/idempotency.ts` +
`POST /api/admin/sites` + `/admin/sites/new` реализованы, протестированы и задеплоены** (четыре
коммита `ddf44a3`/`6a322bc`/`d1c6cc0`/`145bfec`, десятая и девятая migrations, см. §5 для полного
разбора). Чек-лист `/admin/setup` теперь имеет первую по-настоящему проходимую destination. Побочно
найден и раскрыт владельцу инцидент с непреднамеренным пересозданием `db`-контейнера при деплое (см.
§10, без потери данных, подтверждено владельцем лично).

Владелец продолжил делегировать выбор следующего шага («продолжаем!»). Тем же паттерном (permission
seed → endpoint с `IdempotencyKey`+`createAuditEvent()` → страница → Playwright-проверка) реализован
**второй** мутирующий admin-first endpoint: **`POST /api/admin/templates` + `/admin/templates/new`**
(commits `6bf5232`/`4962ac6`, одиннадцатая migration — seed `template.create`). Новой схемы не
понадобилось — `WorkScheduleTemplate`/`Version`/`VersionDay` и их CHECK-constraints (CK-06/07/08) уже
были в frozen initial migration; endpoint зеркалит их в application-валидации ради чистого `400`
вместо сырого `23514`. Задеплоено на реальный `app`; на этот раз `db` не пересоздавалась (`env_file`
не менялся) — подтверждает, что прошлый инцидент был вызван именно изменением `env_file`, а не общим
поведением. Чек-лист `/admin/setup` теперь имеет две проходимые destinations из пяти.

**Владелец сменил режим работы**: агент больше не выбирает следующий шаг сам («что важней — то и
делай» отменено). Дальше строго `PROJECT_ROADMAP.md` ЭТАП 6 по порядку, T6.1→T6.9, не чек-лист
`/admin/setup` и не собственный приоритет агента.

**T6.1 «Расширить User» — проверен, закрыт без изменений кода**: `User`
(`id`/`username`/`email`/`passwordHash`/`status`/`locale`/`twoFactorEnabled`/`twoFactorSecret`/
`employeeId`/`lastLoginAt`/`createdAt`/`updatedAt`) и `Employee`
(`id`/`employeeNumber`/`firstName`/`lastName`/`phone`/`version`/`createdAt`/`updatedAt`) в
`prisma/schema.prisma` уже содержат ровно поля, утверждённые в `03_DATA_MODEL_ERD.md` §4.1/§4.2 —
ни одного отсутствующего, ни одного лишнего (обе модели — часть frozen initial migration, commit
`9b2cbab`). Добавлять что-либо сверх ERD было бы нарушением §8 `AGENT_RULES.md`.

**T6.2 «Список работников, read-only» реализован**: `GET /api/admin/workers` (`lib/workers.ts`,
`app/api/admin/workers/route.ts`) + `/admin/workers` (`app/admin/workers/page.tsx`), точный контракт
`04_ADMIN_FIRST_API_CONTRACTS.md` §5 (`items`+пагинация `page`/`pageSize`/`totalItems`/`totalPages`,
`currentAssignments` — только `SiteAssignment`, чей `[validFrom, validTo]` покрывает сегодняшний
календарный день в `Europe/Helsinki`, не host-local/UTC). Новой migration не понадобилось —
`worker.read.all` уже засеян седьмой migration (`20260731210728`, коммит `90d2e55`) под `/admin/setup`.
Commit `45aece3`.
- Протестировано на одноразовом PostgreSQL 16 (все 10 migrations с нуля): unit-уровень (`listWorkers()`
  напрямую) — сортировка `lastName,firstName`, `active` из `Employment.active`, пагинация
  (`pageSize=2` → 2 страницы), граничный случай `validTo = сегодня` (assignment должен остаться
  текущим — Postgres date/timestamp cast был реальным риском, проверен явно) — все прошли; HTTP-уровень
  (реальный `next dev` + вручную созданная `UserSession`) — `401` без cookie, `403` для роли `WORKER`
  без `worker.read.all`, `200` для `ADMIN` с точной формой ответа, `/admin/workers` без cookie —
  настоящий `307` на `/login` (не client-side redirect — тот баг уже исправлен commit `fa7720e`).
  Одноразовый контейнер и весь тестовый код удалены после проверки.
- Задеплоено на реальный `app` (`docker compose up -d --build --no-deps app`) — на этот раз `db` не
  пересоздавалась (только `app`, `--no-deps`); `/api/health`/`/api/ready` регрессия чистая,
  `/api/admin/workers` без cookie → `401`, `/admin/workers` без cookie → `307`. Реальная
  `titanor_time` база: `Employee`/`WorkSite` = 0 строк (владелец ещё не создавал ни одного работника
  через `/admin/workers/new`, той страницы ещё нет — T6.3), поэтому реальная страница сейчас показывает
  пустой список («No workers yet.») — это ожидаемо, не проверено логином живого `SUPER_ADMIN`
  намеренно (не было причины создавать тестовую сессию/данные в реальной базе для строки с 0 записей).

**T6.3 «Создание работника» реализован**: `POST /api/admin/workers`
(`app/api/admin/workers/route.ts`) + `/admin/workers/new`
(`app/admin/workers/new/{page.tsx,NewWorkerForm.tsx}`) — точный контракт
`04_ADMIN_FIRST_API_CONTRACTS.md` §5: одна транзакция создаёт `Employee`+`User(PENDING_ACTIVATION,
locale=FI)`+`Employment(active=true, startDate=сегодня)`, `ActivationToken` не создаётся (см.
`01_SCREEN_MAP.md`). Двенадцатая migration засеяла `worker.create` (`ADMIN`/`SUPER_ADMIN`,
`02_ROLE_PERMISSION_MATRIX.md` §2.2). `employeeNumber` можно передать или оставить пустым —
генерируется как следующее целое после текущего числового максимума (не зафиксировано ни одним
документом точнее, чем «можно сгенерировать», `01_...`); он же становится `User.username`
(единственное согласованное толкование примеров `"1042"`, повторяющихся и в `GET
/api/admin/workers`, и в `POST /auth/login` контракта). `Idempotency-Key` обязателен для этого
endpoint (в отличие от `POST /api/admin/sites`, где он опционален) — контракт прямо говорит
«обязателен». Commit `95e2f74`.
- Race-safety генерации `employeeNumber` — не advisory lock (как у единственного `SUPER_ADMIN` в
  `bootstrap-super-admin.ts`), а просто DB `UNIQUE`-ограничение: коллизия ловится как `P2002` и
  превращается в штатный `409 DUPLICATE_EMPLOYEE_NUMBER` — осознанно более лёгкое решение, т.к. цена
  ошибки здесь — retryable конфликт, а не потеря инварианта «ровно один активный SUPER_ADMIN».
- Протестировано на одноразовом PostgreSQL 16 (все 11 migrations с нуля): `401`/`403`/
  `CSRF_REJECTED`/отсутствие `Idempotency-Key` (`400`)/`VALIDATION_ERROR` (пустой `firstName`) — все
  корректны; успешное создание с сгенерированным (`5001` после существующего `5000`) и явным
  (`1042`) `employeeNumber`; `409 DUPLICATE_EMPLOYEE_NUMBER` при повторе занятого номера; **точный
  повтор** (тот же `Idempotency-Key`+тело) вернул закешированный `201` с тем же `employee.id` — прямой
  SQL-подсчёт подтвердил отсутствие дубликата (`Employee`/`User`/`Employment`/`AuditEvent` — по 1 новой
  строке на реальное создание, не 2); тот же `Idempotency-Key` с другим телом → `409
  IDEMPOTENCY_KEY_REUSED`; `GET /api/admin/workers` сразу отразил созданных работников с верной формой
  (`active`, пустой `currentAssignments[]` — назначений ещё нет). Одноразовый контейнер и весь
  тестовый код удалены после проверки.
- **Migration применена владельцем** к `titanor-time-db-1` (агент по-прежнему заблокирован tool
  policy на прямые изменения реальной базы — тот же одноразовый `node:22`-container паттерн,
  `--network titanor-time_internal`, bind-mount репозитория, `--env-file .env.titanor-time`, без `npm
  install`, что и во всех предыдущих migrations этого проекта): «Applying migration
  `20260801123904_seed_worker_create_permission`» → «All migrations have been successfully applied.»
  Подтверждено агентом read-only запросом: `worker.create` есть в `Permission`, `_prisma_migrations` =
  11 записей.
- **Задеплоено на реальный `app`** (`docker compose up -d --build --no-deps app`) — `db` не
  пересоздавалась; `/api/health`/`/api/ready` регрессия чистая; `/api/admin/workers` (`POST`, без
  cookie) → `401`; `/admin/workers/new` без cookie → настоящий `307` на `/login`; реальная `Employee`/
  `AuditEvent(WORKER_CREATED)` — по-прежнему 0 строк (тестовых данных в реальную базу не вносилось).

**T6.4 «Редактирование и отключение» реализован**: `GET`/`PATCH /api/admin/workers/:employeeId`
(`app/api/admin/workers/[employeeId]/route.ts`) + `POST .../deactivate`
(`app/api/admin/workers/[employeeId]/deactivate/route.ts`) + `/admin/workers/[employeeId]`
(`page.tsx`+`WorkerActions.tsx`, плюс ссылка на карточку из `/admin/workers`). Тринадцатая migration
засеяла `worker.update`/`worker.deactivate` (`ADMIN`/`SUPER_ADMIN`). Commit `64cc569`.
- `GET` возвращает `Employee`+`Employment`+`currentAssignments[]`+вычисляемый `activationStatus`
  (`ActivationToken` в схеме ещё нет — будущая задача `worker.activation.generate`; статус мимикрирует
  под условие его будущей выдачи из `03_DATA_MODEL_ERD.md` §4.1). `PATCH` редактирует только
  `firstName`/`lastName`/`phone` — **`employeeNumber` осознанно не редактируется** (это `User.username`
  1:1 с T6.3, а список ошибок контракта для этого endpoint не включает конфликт employeeNumber).
  Optimistic locking через `version`, атомарный compare-and-swap (`Employee.updateMany`), апдейт+audit
  в одной транзакции.
- `deactivate` реализует правило `03_...` §4.2 целиком: `Employment.active=false`+`endDate`+`reason`
  всегда; `User.status=DEACTIVATED`+отзыв всех `UserSession`, если у работника нет ожидающего
  (`expected=true`) `PayrollPeriodParticipant` в `OPEN`-периоде без `FINAL_APPROVED` табеля (в том числе
  если табеля вовсе ещё нет — трактуется как «незавершено»); иначе `User.status=OFFBOARDING`, сессии не
  трогаются. Сегодня в реальной базе периоды/участники ещё никем не создаются (`/admin/periods` не
  реализован) — поэтому ветка `OFFBOARDING` пока недостижима в реальных данных, только на тестовых
  фикстурах; это ожидаемо, не баг.
- **Найдено и исправлено в ходе тестирования**: `activationStatus` изначально не учитывал
  `Employment.active` — деактивированный работник с ещё не закрытым (`validTo=null`) старым
  `SiteAssignment` показывал `READY_FOR_ACTIVATION`, хотя увольнение не отзывает существующие
  назначения (только блокирует новые, `03_...` §4.2). Добавлена проверка `employmentActive` —
  подтверждено на одноразовой базе: тот же работник после деактивации стал `SETUP_INCOMPLETE`, второй
  (всё ещё активный) работник с идентичными assignment/participant остался `READY_FOR_ACTIVATION`.
- Протестировано на одноразовом PostgreSQL 16 (все 13 migrations с нуля): три fixture-работника
  покрыли все три `activationStatus`; `GET` — `404`/`403`/`401`; `PATCH` — успех+инкремент `version`,
  `409 VERSION_CONFLICT` на устаревшей версии, `404`, `400` на отсутствующих/невалидных полях,
  `403`/CSRF; `deactivate` — обе ветки `userStatus` против реальных `PayrollPeriodParticipant`/
  `Timesheet` фикстур, `409 ALREADY_DEACTIVATED` на повторе, валидация `endDate` (формат + раньше
  `startDate`), отзыв сессии подтверждён только на ветке `DEACTIVATED`, `AuditEvent`
  (`WORKER_UPDATED`/`WORKER_DEACTIVATED`) подтверждены прямым SQL. Migration применена владельцем (та
  же одноразовая `node:22`-container команда), задеплоено на реальный `app`, регрессия чистая, реальная
  `Employee`/`AuditEvent` — по-прежнему 0 строк.

**`PROJECT_ROADMAP.md` ЭТАП 6 («Работники, объекты и назначения») полностью закрыт** — T6.1–T6.9
все реализованы.

**ЭТАП 7 («Учёт часов») начат** — владелец подтвердил переход после явного разбора объёма: `04_...`
§7-9 + `03_DATA_MODEL_ERD.md` §4.5-4.7 показывают, что `PROJECT_ROADMAP.md` T7.1–T7.10 (плоский
«TimeEntry») полностью перекрыт архитектурой `Timesheet`→`TimesheetDraft`→`TimesheetVersion`→
`TimesheetReviewScope`→`TimesheetReviewProposal` — та же ситуация, что была с ЭТАП 4. Реальная работа
идёт по разделам `docs/titanor-time/`, не по T7.x буквально. Предложенная владельцу и подтверждённая
разбивка: 1) открытие периода, 2) кабинет работника read-контекст, 3) draft чтение+правка дня, 4)
отправка (`submit`, потребует отдельный design-checkpoint для ещё не существующих
`TimesheetReviewScope`/`Proposal`), 5) прорабская очередь/approve/return, 6) коррекции и
`period.lock`/`export`.

**Первая под-задача («Открытие расчётного периода») реализована и задеплоена** (commit `399336f`):
`lib/periods.ts` + `POST/GET /api/admin/periods`, `GET .../current`, `GET .../:periodId`. Схему менять
не пришлось — `PayrollPeriod`/`Timesheet`/`TimesheetDraft*` уже существовали в frozen initial
migration; добавлены только две seed-migrations (`period.create`/`period.read.all` → `ADMIN`/
`SUPER_ADMIN`).
- `POST` реализует шаг 1 «Жизненного цикла draft» (`03_...` §4.6) целиком: под `SELECT Employee ...
  FOR UPDATE` (по возрастанию `id`, raw SQL — Prisma не даёт `.forUpdate()`) для каждого сотрудника с
  `SiteAssignment`, пересекающим даты периода, — тройка `PayrollPeriodParticipant`+
  `Timesheet(DRAFT)`+`TimesheetDraft`, `TimesheetDraftDay` на каждый календарный день периода
  (оверлей `Absence(APPROVED)` применён до дефолта `WORK`, тот же механизм, что `absence.approve`),
  `TimesheetDraftPlannedShift` на каждый день, реально покрытый назначением, время резолвится из
  `WorkScheduleTemplateVersionDay` с корректной конвертацией Europe/Helsinki→UTC (DST учтён —
  найденный и явно применённый паттерн: смещение вычисляется через `Intl.DateTimeFormat` на момент
  конкретной даты, не константа).
- Протестировано на одноразовом PostgreSQL 16: каскад для сотрудника с шаблоном (верные будни/DST
  времена 08:00→05:00 UTC летом, выходные — `null`/`0`), сотрудника без шаблона (пустые планы, но
  строки созданы), сотрудника с `Absence` (оверлей ровно на нужных датах), сотрудников без
  пересекающегося назначения — не попали в участники; `409 PERIOD_OVERLAP` (реальный EXCLUDE
  `ex_payroll_period_date_overlap`), `400`/`403 CSRF`/`401`/`403 FORBIDDEN` (роль `WORKER`),
  Idempotency-Key replay без дублирования каскада, все GET-эндпоинты, `hasOpenPeriod` в
  `/admin/setup-status` встал в `true` (закрыт последний пункт исходного admin-first чек-листа).
  `tsc --noEmit` чист.
- Migrations применены владельцем к `titanor-time-db-1`, `app` пересобран (`docker compose up -d
  --build --no-deps app`) и передеплоен, `healthy`, `/api/ready` подтверждает `database: connected`.

Не начинать реальный admin/worker API или UI раньше отдельного подтверждения владельца (исключения —
`GET /api/admin/cities`, `session.revoke_all.own`, `/login`, `/admin/setup`, `POST /api/admin/sites`,
`/admin/sites/new`, `POST /api/admin/templates`, `/admin/templates/new`, `GET/PATCH
/api/admin/workers[/:employeeId]`, `POST /api/admin/workers[/:employeeId/deactivate]`,
`/admin/workers[/new|/[employeeId]]`, `GET /api/admin/sites`, `GET/PATCH /api/admin/sites/:siteId`,
`/admin/sites`, `/admin/sites/[siteId]`, `GET/POST /api/admin/sites/:siteId/work-areas`,
`PATCH .../work-areas/:workAreaId`, `POST /api/admin/assignments/validate-overlap`,
`POST /api/admin/assignments`, `/admin/assignments/new`, `GET /api/admin/assignments`,
`/admin/assignments`, `PATCH /api/admin/assignments/:assignmentId`,
`POST /api/admin/assignments/:assignmentId/split`, `.../promote`, `.../end`,
`POST/GET /api/admin/foreman-assignments`, `POST .../end`, `POST/GET /api/admin/periods`,
`GET /api/admin/periods/current`, `GET /api/admin/periods/:periodId`, `GET /api/worker/context`,
`GET /api/worker/assignments/current`, `GET /api/worker/periods/current`,
`GET /api/worker/periods/actionable`, `GET /api/worker/timesheets/:timesheetId`, `.../draft`,
`.../current-version`, `PATCH .../days/:date` — уже подтверждены и сделаны).
Не запускать `app` в production и не менять CollabStudio без отдельного checkpoint владельца.

**ЭТАП 7 под-задача 2 («Кабинет работника, read-контекст») реализована и задеплоена** (commit
`f002439`): `lib/worker-context.ts` + четыре `GET`-эндпоинта — первый живой код под `/api/worker/*`
(`proxy.ts` уже гейтил этот путь аутентификацией с самого начала, но ни одного роута там не было).
Каждый резолвит `employeeId` из сессии (`AuthenticatedSession.user.employeeId`, новое поле в
`lib/auth.ts`), никогда из запроса; `403 NO_EMPLOYEE_PROFILE`, если у `User` сессии нет привязанного
`Employee` — точное требование §9 верхнего уровня, не только у `/context`.
- Протестировано на одноразовом PostgreSQL 16: работник с двумя текущими назначениями (primary+
  secondary, с шаблоном/областью и без) — верный порядок и поля; работник без `employeeId` —
  `403 NO_EMPLOYEE_PROFILE` на всех четырёх эндпоинтах; роль `ADMIN` без `WORKER` — `403 FORBIDDEN`
  (права `worker.read.own`/`assignment.read.own`/`period.read.own` держит только `WORKER`, не
  `ADMIN`/`SUPER_ADMIN` — впервые в проекте permission-seed идёт не на админские роли); без сессии —
  `401`. `periods/current`/`periods/actionable` проверены на реальном `PayrollPeriodParticipant`+
  `Timesheet(DRAFT)` фикстуре, покрывающей «сегодня». `tsc --noEmit` чист.
- Три migrations (`worker.read.own`/`assignment.read.own`/`period.read.own` → `WORKER`) применены
  владельцем к `titanor-time-db-1`, `app` пересобран и передеплоен (`docker compose` вывел шумный, но
  не блокирующий `Conflict` на переименовании контейнера при recreate — реальный контейнер при этом
  успешно создан на новом образе и подтверждён `healthy`+`database: connected`, `/api/worker/context`
  без cookie корректно вернул `401`, не `404`).

**Под-задача 3 разбита на 3a (read) и 3b (`PATCH`) — 3a реализована и задеплоена** (commit `baa84da`):
`lib/worker-timesheets.ts` + `GET /api/worker/timesheets/:timesheetId`, `.../draft`,
`.../current-version` (`04_...` §9).
- Владение проверяется явно: чужой `timesheetId` → `403 FORBIDDEN`, не `404` (§9: не путать «чужое» с
  «не существует»); неизвестный `timesheetId` → `404 TIMESHEET_NOT_FOUND`.
- `.../draft` — только `Timesheet.status IN (DRAFT, RETURNED)`, иначе `409 DRAFT_NOT_EDITABLE`
  (используется `.../current-version`).
- `.../current-version` — работает в любом статусе, но сегодня всегда вернёт `404`, если версии
  никогда не было (`timesheet.submit` ещё не построен — это подзадача 4, не баг). `reviewScopes`
  всегда `[]` по той же причине, что `TimesheetReviewScope` — не подзадача сейчас, а подзадача 5:
  модели ещё не существует, значит и ни один scope не может существовать.
- Протестировано на одноразовом PostgreSQL 16: happy path `.../draft` (день+сегмент+перерыв верно
  смаплены из реальных фикстур); happy path `.../current-version` — версия/день/сегмент/перерыв/
  plannedShift вручную вставлены как фикстура (симулирует то, что `submit` будет делать позже, раз
  самого `submit` ещё нет) — верно прочитаны; `409 DRAFT_NOT_EDITABLE` на `SUBMITTED`; кросс-worker
  доступ → `403 FORBIDDEN`; `401` без сессии. `tsc --noEmit` чист.
- Migration (`timesheet.read.own` → `WORKER`) применена владельцем, `app` пересобран и передеплоен,
  `healthy`.

**Найден и исправлен пробел перед стартом 3b, задеплоен**: `createAssignment()` (T6.8) при
пересечении с уже `OPEN`-периодом апсертил только тройку `PayrollPeriodParticipant`+
`Timesheet(DRAFT)`+`TimesheetDraft`, но не создавал ни одной `TimesheetDraftDay` — сотрудник, впервые
назначенный на объект после открытия периода (обычный сценарий), получал пустой draft-контейнер без
единой строки дня, и `PATCH .../days/:date` не нашёл бы, что редактировать. Исправлено (commit
`706eb75`): `createAssignment()` теперь бэкфиллит `TimesheetDraftDay` (оверлей `Absence(APPROVED)`,
как у `period.create`) + `TimesheetDraftPlannedShift` для этого одного нового назначения на
пересечении `[period.startDate..endDate] ∩ [validFrom..validTo]`, переиспользуя (не дублируя)
date/DST-хелперы `lib/periods.ts` (теперь экспортированы). Без миграции — чистый код.
- Протестировано на одноразовом PostgreSQL 16: назначение, созданное против уже `OPEN` периода,
  бэкфиллит верные 5 дней с DST-корректными планами; второе пересекающееся назначение того же
  сотрудника (другой объект) добавляет свои planned-shift строки без дублирования дней (dedup по
  `(draftId, date)` сработал); регрессия `GET /api/admin/assignments` чистая.
- Задеплоено на реальный `app` (`docker compose up -d --build --no-deps app`), `healthy`,
  `/api/ready` подтверждает `database: connected`.

**Под-задача 3b реализована и задеплоена** (commit `a912239`): `patchWorkerTimesheetDay()` в
`lib/worker-timesheets.ts` + `PATCH /api/worker/timesheets/:timesheetId/days/:date`.
- Итоговое состояние `(dayType, confirmedZero, hasSegments)` проверяется по таблице `03_...`§4.6
  **до** любой записи в БД → `409 DAY_TYPE_CONFLICT`/`DAY_STATE_CONFLICT`. Персональный non-WORK
  `dayType` требует `Absence(APPROVED)`, покрывающего дату → `403 DAY_TYPE_REQUIRES_ABSENCE`;
  `PUBLIC_HOLIDAY` не имеет соответствия в `AbsenceType` вовсе — отклоняется тем же путём без
  отдельного кейса. `segments`, при передаче, — полный финальный список (не delta по объекту);
  `sourceAssignmentId` резолвится сервером, никогда от клиента, `404 SITE_NOT_ASSIGNED` иначе.
- **Порядок записи важен для BEFORE ROW триггеров** (TRG-05/06): всегда удалить старые сегменты →
  обновить день → вставить новые — ноль сегментов валиден против любой комбинации
  `dayType`×`confirmedZero`, поэтому такой порядок не может сработать ни на одном триггере ни в
  одном направлении перехода (доказано перебором всех переходов при проектировании).
  Пересечение новых сегментов/перерывов и containment перерывов (§5) — сервисная
  pre-валидация до транзакции; EX-04 (`ex_timesheet_draft_segment_time_overlap`) —
  defense-in-depth backstop.
- `TimesheetDraft.contentRevision` увеличивается на каждый успешный вызов безусловно (даже
  `note`-only правку) — контракт требует этого явно.
- `affectedSitePairs`→пересчёт `TimesheetReviewProposal.status` — не реализовано, модель не
  существует (подзадача 5); `resolvedProposals` всегда `[]` — факт, не заглушка.
- Протестировано на одноразовом PostgreSQL 16 (~15 запросов): полная замена сегментов
  (добавление/удаление по объекту), `note`-only без изменения сегментов; все перечисленные выше
  коды ошибок, включая обе оси таблицы состояний и happy path с реальным `Absence`; перерыв вне
  сегмента/перекрывающиеся перерывы/отсутствующий `endAt` → `400`; кросс-worker → `403 FORBIDDEN`
  (не `404`); `SUBMITTED`-табель → `409 DRAFT_NOT_EDITABLE`; дата вне периода → `400`; CSRF/сессия
  → `403`/`401`. `contentRevision` совпал ровно с числом успешных вызовов (5 из ~15) — неудачные
  запросы не тронули ни день, ни ревизию. `tsc --noEmit` чист.
- Migration (`timesheet.draft.edit.own` → `WORKER`) применена владельцем, `app` пересобран и
  передеплоен, `healthy`.

**Схема `TimesheetReviewScope` спроектирована, подтверждена, реализована** (commit `a9c1838`):
новая таблица + 3 enum'а (`TimesheetReviewScopeType`, `...Purpose`, `...Status`). Осознанно **без**
`TimesheetReviewProposal` — та создаётся исключительно в транзакции `scope.return`
(`03_...`§4.6), которой пока не существует (подзадача 5); первый сабмит (единственный достижимый
сегодня путь, `DRAFT→SUBMITTED`) не создаёт и не резолвит ни одного предложения, поэтому у
`Proposal` нет потребителя прямо сейчас — тот же принцип, что уже применялся для `reviewScopes:[]`/
`resolvedProposals:[]`.
- **Найден и исправлен реальный баг** при тестировании CHECK-constraint на одноразовом
  PostgreSQL 16: `"scopePurpose" IN ('DATA','EMPTY_FALLBACK')` возвращает `NULL` (не `FALSE`), если
  сам `scopePurpose` — `NULL`, а Postgres CHECK пропускает `NULL`-результат (отклоняет только явный
  `FALSE`) — `NON_SITE`-строка с `scopePurpose=NULL` проходила бы constraint молча. Добавлен явный
  `"scopePurpose" IS NOT NULL` guard. Сам буквальный текст предиката в `03_...`§4.6 несёт тот же
  латентный дефект — в реальном SQL этой миграции его нет.
- Протестировано на одноразовом PostgreSQL 16: обе ветки CHECK (включая NULL-кейс выше), обе
  partial unique (одна `SITE`-запись на объект на версию, максимум одна `NON_SITE` на версию,
  несколько `SITE` разных объектов в одной версии — разрешено). Prisma Client пересобран и
  скопирован в `titanor-time-app`. `tsc --noEmit` чист. Заодно закоммичен `migration_lock.toml` —
  существовал на диске с самого начала проекта, но никогда не был в git.
- **Не применено к реальной БД** — ждёт владельца.

**Следующий шаг**: применить миграцию `20260804160000_add_timesheet_review_scope` к
`titanor-time-db-1`, затем — реализация самого `timesheet.submit` (замораживает draft в
`TimesheetVersion`+`TimesheetDay`+`WorkSegment`+`BreakSegment`+`TimesheetPlannedShift`, вычисляет
`TimesheetReviewScope` по трём случаям `SITE`/`NON_SITE(DATA)`/`NON_SITE(EMPTY_FALLBACK)` с
carry-forward — на первом сабмите вырождается в «всё новое → `PENDING`», очищает draft-таблицы,
аудит `TIMESHEET_SUBMITTED`). Не начинать реализацию `submit` без отдельного подтверждения
владельца после того, как схема будет на реальной базе.

## 12. Правило обновления

1. Каждая следующая задача сначала читает этот файл.
2. После успешного commit агент обновляет статус отдельной минимальной задачей либо включает
   обновление в task scope, если это заранее разрешено владельцем.
3. Запись содержит commit hash, изменённые файлы и фактические проверки.
4. Планируемая работа не записывается как выполненная.
5. Чат не является единственным хранилищем отчёта — этот файл им является.
