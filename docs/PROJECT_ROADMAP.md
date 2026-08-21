# TITANOR GROUP — КАРТА ПРОЕКТА ДЛЯ АГЕНТА

**Правило:** следующая задача начинается только после проверки предыдущей.

```text
одна задача → один результат → одна проверка → один коммит
```

# 0. ОБЩАЯ КАРТА

```text
1. Аудит
2. Перенос сайта на VPS
3. Улучшение админки
4. Проектирование Titanor Time без кода
5. База и авторизация
6. Работники, объекты и назначения
7. Ввод и проверка часов
8. Отчёты и PWA
9. Внутренний тест
10. Недельная обкатка
11. Исправления и финальный выпуск
```

# ЭТАП 1. АУДИТ

## T1.1 — Прочитать документы

```text
PROJECT_VISION.md
AGENT_RULES.md
PROJECT_ROADMAP.md
TITANORGROUP_VPS_MIGRATION_AGENT_TZ.md
```

Ничего не менять.

## T1.2 — Проверить Git

```bash
git status --short
git remote -v
git branch --show-current
git rev-parse HEAD
```

Критерий: чистое дерево, правильный remote, SHA записан.

## T1.3 — Создать ветку

```text
migration/vps-self-hosted
```

Не менять `main` напрямую.

## T1.4 — Аудит кода

Найти:

- Supabase;
- Cloudinary;
- admin auth;
- API routes;
- форму;
- локализацию;
- data fallback;
- Docker-файлы.

Ничего не менять.

## T1.5 — Аудит VPS

Проверить:

- Docker и Compose;
- Caddy;
- порт 3100;
- CollabStudio;
- память и диск;
- текущий Caddyfile.

# ЭТАП 2. ПЕРЕНОС САЙТА НА VPS

Ориентировочно 2–3 дня.

## T2.1 — Экспорт Supabase

Экспортировать `service_images` и `service_content`.

Критерии:

- сохранены `publicId`;
- JSON валиден;
- есть SHA256;
- Supabase не изменён.

## T2.2 — Общий JSON store

Сделать атомарную запись JSON.

Критерии:

- временный файл;
- rename;
- каталог создаётся;
- параллельные записи не портят данные.

## T2.3 — Тексты в локальный JSON

Менять только хранение текстов.

## T2.4 — Метаданные изображений в локальный JSON

Критерии:

- URL и `publicId` сохранены;
- Cloudinary upload/delete работают.

## T2.5 — Удалить runtime Supabase

Только после T2.3 и T2.4.

## T2.6 — Next.js standalone

Добавить `output: 'standalone'` и проверить `.next/standalone/server.js`.

## T2.7 — Health endpoint

```text
GET /api/health
```

## T2.8 — Dockerfile

- multi-stage;
- Node 22;
- non-root;
- standalone.

## T2.9 — Compose

- project `titanorgroup`;
- `127.0.0.1:3100:3000`;
- отдельный env;
- отдельный volume;
- healthcheck.

## T2.10 — Seed data

Seed не перезаписывает существующие runtime-файлы.

## T2.11 — Форма через Zoho

### T2.11A — API

- валидация;
- SMTP;
- honeypot;
- rate limit;
- безопасные ошибки.

### T2.11B — UI

- без reload;
- success/error;
- EN/FI;
- текст не пропадает при ошибке.

## T2.12 — Локальные проверки

```bash
npm ci
npx tsc --noEmit
npm run build
docker compose config
docker compose build
```

## T2.13 — Первый запуск

Только после checkpoint.

Критерии:

- контейнер healthy;
- localhost:3100 отвечает;
- данные читаются;
- CollabStudio healthy.

## T2.14 — Preview

```text
preview.titanorgroup.fi
```

Нужен доступ к Cloudflare. Production DNS пока не менять.

## T2.15 — QA миграции

Проверить:

- EN/FI;
- изображения;
- admin;
- сохранение после restart;
- Cloudinary;
- Zoho;
- mobile;
- security headers;
- backup.

## T2.16 — Production cutover

Только после `GO`.

Менять только:

```text
A @
CNAME www
```

Почтовые записи не трогать.

## T2.17 — Период отката

7–14 дней не удалять Vercel и Supabase.

# ЭТАП 3. УЛУЧШЕНИЕ АДМИНКИ

## T3.1 — Аудит админки

Описать страницы, API, auth, cookie и проблемы. Ничего не менять.

## T3.2 — Каркас разделов

```text
Dashboard
Site content
Service images
Users
Worksites
Time entries
Reports
Settings
```

Только навигационный каркас.

## T3.3 — Login и session

- Secure;
- HttpOnly;
- SameSite;
- expiry;
- logout;
- rate limit;
- единый server-side guard.

## T3.4 — Dashboard

Показать основные показатели. До появления данных разрешены только явно отмеченные заглушки.

## T3.5 — Проверить функции сайта

Тексты, EN/FI, изображения и Cloudinary должны продолжать работать.

# ЭТАП 4. ПРОЕКТИРОВАНИЕ TITANOR TIME БЕЗ КОДА

На этом этапе код запрещён.

## T4.1 — Утвердить роли

```text
WORKER
FOREMAN
ADMIN
```

Создать таблицу разрешений.

## T4.2 — Утвердить процесс часов

Решить:

- кто создаёт объект;
- кто назначает работника;
- можно ли вводить прошлые даты;
- когда запись блокируется;
- может ли прораб менять часы;
- кто исправляет APPROVED;
- максимальные часы за день;
- можно ли работать на двух объектах в день.

## T4.3 — Утвердить модель данных

```text
User
Session
Worksite
Assignment
TimeEntry
AuditLog
```

Подготовить ER-схему и правила удаления.

## T4.4 — Утвердить страницы

Работник:

```text
/time
/time/add
/time/history
/profile
```

Прораб:

```text
/foreman
/foreman/review
/foreman/worksites
/foreman/workers
```

Начальник:

```text
/admin/users
/admin/worksites
/admin/assignments
/admin/time
/admin/reports
```

## T4.5 — Утвердить MVP

Финальный список:

```text
входит
не входит
будет позже
```

# ЭТАП 5. БАЗА И АВТОРИЗАЦИЯ

## T5.1 — Отдельный PostgreSQL

- отдельный контейнер;
- отдельный volume;
- наружу не публикуется;
- CollabStudio не используется.

## T5.2 — ORM и schema

Предпочтительно Prisma, если не принято другое решение.

Сначала только `User` и `Session`.

## T5.3 — Первая migration

Проверить чистую базу и rollback-план.

## T5.4 — Первый admin

Создать безопасным seed/CLI. Не хранить пароль в коде.

## T5.5 — Login

- server-side password check;
- secure session;
- inactive user blocked;
- rate limit.

## T5.6 — Role guard

Проверить worker, foreman и admin на UI и API.

# ЭТАП 6. РАБОТНИКИ, ОБЪЕКТЫ И НАЗНАЧЕНИЯ

## T6.1 — Расширить User

Только утверждённые поля.

## T6.2 — Список работников

Сначала read-only.

## T6.3 — Создание работника

Публичной регистрации нет.

## T6.4 — Редактирование и отключение

Предпочтительно `active=false`, а не удаление.

## T6.5 — Worksite schema

После утверждения полей.

## T6.6 — CRUD объектов

Отдельные задачи:

- список;
- создание;
- редактирование;
- закрытие.

## T6.7 — Assignment schema

```text
worker
worksite
date range
assigned by
```

## T6.8 — Назначение работника

Работник видит только назначенные активные объекты.

## T6.9 — Назначение прораба

Прораб видит только связанные объекты и команды.

# ЭТАП 7. УЧЁТ ЧАСОВ

## T7.1 — TimeEntry schema

- worker;
- worksite;
- date;
- hours;
- comment;
- status;
- reviewer;
- review time;
- rejection reason;
- timestamps.

## T7.2 — Серверная валидация

Проверить отрицательные/слишком большие часы, неверную дату, чужой объект и закрытый объект.

## T7.3 — Форма работника

- мобильная;
- крупные элементы;
- минимум действий;
- объект;
- дата;
- часы;
- комментарий;
- draft/submit.

## T7.4 — История работника

Только свои записи. Фильтры по неделе, месяцу и статусу.

## T7.5 — Отправка

После `SUBMITTED` обычное редактирование блокируется.

## T7.6 — Очередь прораба

Показывать работника, объект, дату, часы, комментарий и статус.

## T7.7 — Подтверждение

Фиксировать reviewer, timestamp и audit log.

## T7.8 — Возврат

Причина обязательна.

## T7.9 — Исправление APPROVED

Спроектировать отдельно. Обычный update запрещён.

## T7.10 — Закрытие периода

После закрытия обычные изменения запрещены.

# ЭТАП 7A. ATTENDANCE CLOCK, GPS И OFFLINE-FIRST

Новый обязательный клиентский сценарий. Выполняется после закрытия activation/onboarding и
контрольного E2E текущего табеля, но **до отчётов, PWA-пилота и недельной обкатки**. Это отдельный
проект, который осознанно расширяет прежнее ограничение T8.8 для событий Check In/Check Out.

## T7A.1 — Design checkpoint — **ЗАВЕРШЕНО, утверждено владельцем 2026-08-12**

Полный самодостаточный документ:
[`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md`](./titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md)
(revision 3.2.5, утверждена владельцем). Сущности, поля, связи, ограничения, индексы, retention и
правила удаления для геозон, открытой смены, неизменяемых clock-событий, offline outbox/idempotency,
связи с `TimesheetDraftSegment`, источника отправки (`MANUAL`/`AUTO`), исключений автоотправки и
company-level расписания cutoff/reminder — утверждены целиком, включая полные SQL-инварианты,
crash/retry/concurrency сценарии и тесты №1–128. Открытый интервал не добавлен непосредственно в
`TimesheetDraftSegment` (существующая модель по-прежнему требует одновременно `startAt` и `endAt`) —
offline-факт живёт в отдельных новых T7A-таблицах.

**Owner decisions при утверждении**: raw GPS retention — 90 дней как provisional development default,
значение изменяемо без переделки модели; legal/privacy review и формулировка согласия работника
обязательны до production-пилота (T7A.10), но **не блокируют** schema foundation/T7A.2; отдельная
сложная страница для conflict/sequence-аномалий в первом пилоте не нужна — минимальный список/секция
войдёт в операционный обзор T7A.9, `FOREMAN` raw payload не получает.

Prisma-схема, migration, API и UI по этому checkpoint **ещё не созданы** — утверждение архитектуры
есть decision checkpoint, не начало реализации.

**Утверждённый порядок дальнейшей реализации** (каждый — отдельный slice/коммит, не одна задача):

```text
schema foundation → locking fixes → geofence admin → online clock backend →
worker mobile UI → materialization → offline sync → exception review →
auto-submit → full E2E
```

Соответствие подзадачам ниже: schema foundation/locking fixes — новый первый шаг перед T7A.2 (см.
`docs/titanor-time/IMPLEMENTATION_STATUS.md`); geofence admin = T7A.2; online clock backend = T7A.4/
T7A.6 (backend); worker mobile UI = T7A.3; materialization = T7A.4 (materializer); offline sync =
T7A.5; exception review = T7A.6 (resolution)/T7A.9; auto-submit = T7A.7; full E2E = T7A.10.

## T7A.2 — Геозона объекта

- администратор задаёт координаты и допустимый радиус объекта;
- конфигурация версионируется для проверки offline-события по доступному телефону снимку;
- GPS запрашивается только при Check In и Check Out — постоянного отслеживания нет;
- координаты не попадают в обычные application/audit logs.

## T7A.3 — Основной экран работника

- `/worker` становится простой mobile-first домашней страницей, а подробный кабинет и табель
  открываются через меню;
- в шапке: меню, дата/день/время, имя работника, текущий объект и понятный GPS/sync-status;
- большая заметная кнопка `Check In`, когда открытой смены нет; во время смены — таймер и большая
  кнопка `Check Out`; это единственное доминирующее действие на экране;
- при одном подходящем назначении объект выбирается автоматически, при нескольких работник выбирает;
- ниже — компактные `Today`/`This week`: интервалы, объекты, перерывы, итог часов и срок отправки;
- состояния `working`, `saved offline / waiting for sync`, `GPS not verified`, `no assignment` и
  `missing checkout` всегда видимы и не маскируются общим сообщением;
- меню содержит `Today`, `My week`, `All hours`, `Corrections`, `Profile`, `Help`, `Logout`;
- существующие ручной ввод, выбор объекта/рабочей области, история, draft и submit остаются доступны
  в кабинете, но не перегружают ежедневную домашнюю страницу;
- кнопок `Start break`/`End break` в первом срезе нет: перерыв добавляется вручную в существующем
  редакторе дня; после Check Out показывается ссылка `Add break`.

## T7A.4 — Неизменяемое исходное время

- Check In/Check Out сохраняются append-only и никогда не переписываются ручной правкой;
- завершённая clock-смена материализуется в редактируемый `TimesheetDraftSegment`;
- добавление перерыва отображается в истории, но не требует причины;
- изменение начала, окончания, объекта или рабочей области требует причины;
- `Switch site` во время смены атомарно означает `Check Out` старого объекта и `Check In` нового;
  один день может содержать несколько законченных интервалов на разных объектах;
- прораб своего объекта и ADMIN/SUPER_ADMIN видят исходное время, заявленное время после правки,
  разницу, автора, timestamp и причину;
- clock-события сами не отправляют и не утверждают табель; обычный ручной submit и отдельная
  плановая автоотправка ниже создают immutable version, после чего действует единый
  review/final-approve/return flow.

## T7A.5 — Offline outbox и синхронизация

- актуальные назначения и геозоны кешируются до потери сети;
- Check In/Check Out сначала атомарно сохраняется в IndexedDB с client-generated UUID;
- UI сразу показывает `Saved on device — waiting for sync`;
- серверная batch-синхронизация идемпотентна: повтор одного UUID не создаёт дубль;
- запись удаляется из outbox только после server acknowledgement;
- retry выполняется при `online`, запуске/возврате приложения, вручную и через Background Sync там,
  где он поддерживается; Background Sync не является единственным механизмом;
- конфликт между устройствами, пересечение или устаревшее назначение не теряет событие, а переводит
  его в `NEEDS_REVIEW` с понятным результатом для пользователя.

## T7A.6 — GPS unavailable / outside geofence

- вне геозоны обычный Check In блокируется;
- если GPS permission denied, `TIMEOUT`, `POSITION_UNAVAILABLE` или точность недостаточна, время всё
  равно разрешено запустить/остановить, но событие получает `GPS_NOT_VERIFIED`;
- `GPS_NOT_VERIFIED` требует явной проверки прорабом; ADMIN/SUPER_ADMIN видит его всегда;
- offline не отменяет GPS-проверку: телефон использует кешированную геозону, а сервер повторяет
  проверку при синхронизации;
- PWA-геозона снижает злоупотребления, но не является криптографическим доказательством присутствия;
  QR/NFC/BLE или native device attestation — отдельное возможное усиление.

## T7A.7 — Ручная и плановая автоотправка недели

- работник может проверить и отправить табель вручную каждый день либо в конце периода;
- компания задаёт cutoff и напоминания в своей timezone (исходный default — `Europe/Helsinki`);
- если к cutoff работник не отправил табель, scheduler создаёт ту же immutable версию и помечает
  источник как `AUTO`; уже существующую отправленную версию он не изменяет и не дублирует;
- автоотправка **никогда** не означает approval: версия идёт прорабу по объектам и затем
  администратору по обычному маршруту;
- открытая смена, missing checkout, неразрешённый GPS/sync conflict или неполные данные не получают
  выдуманное время окончания: версия помечается `AUTO_SUBMITTED_WITH_EXCEPTIONS`, исключения
  требуют решения и блокируют final approval;
- поздняя offline-синхронизация или исправление после отправки создаёт следующую версию с diff,
  не переписывая исходную автоотправленную копию;
- scheduler идемпотентен по company+period+timesheet+cutoff и безопасен при повторном запуске.

## T7A.8 — Кабинет, исправления и неизменяемый оригинал

- до отправки работник свободно уточняет интервалы, перерывы, причины отлучек и несколько объектов;
- после отправки показанная прорабу/администратору версия остаётся неизменяемым оригиналом;
- до начала review разрешён явный `Withdraw` в новый draft; после возврата — исправление и
  повторная отправка; после final approval — только формальный correction request;
- каждое исправление показывает before/after, причину, автора, timestamp и ссылку на предыдущую
  версию; final-approved версия остаётся официальной основой до утверждения correction version;
- работник видит, кому и когда версия отправлена, текущий статус каждого site-scope и что требуется
  от него сейчас.

## T7A.9 — Операционный обзор прораба и администратора

- прораб получает только site-scopes своих объектов и видит manual/auto source, GPS/sync/
  missing-checkout exceptions и recorded-vs-reported diff;
- администратор видит полную картину по всем работникам: кто работает сейчас, кто закончил, у кого
  missing checkout/GPS/sync issue, что ещё draft, отправлено вручную/автоматически, ждёт прораба,
  возвращено, готово к final approval или находится в correction;
- admin UI показывает маршрут версии: когда и кому она отправлена, какие site-scopes подтверждены,
  какие ещё ожидают и почему final approval заблокирован;
- массовое подтверждение недоступно для auto-submitted версий с исключениями.

## T7A.10 — Проверка и готовность к пилоту — **ЗАВЕРШЕНО 2026-08-19 (T7A.10C.2)**

Полная 34-пунктовая E2E-матрица, restart-семантика (app/scheduler/db) и backup/restore подтверждены
живыми прогонами против production-сборки в disposable окружении — см. addendum T7A.10C.2 в
[`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md`](./titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md)
и `docs/titanor-time/IMPLEMENTATION_STATUS.md`. Ни одного продуктового дефекта не найдено. Реальные
физические устройства (iPhone/Android) — внешний acceptance gate, ручной чеклист, не пройдены
автоматизированной проверкой.

- online и offline Check In → Check Out;
- повторная доставка без дублей и перезапуск PWA между событиями;
- iPhone/Safari и Android;
- GPS inside/outside/unavailable/low accuracy;
- две вкладки и два устройства;
- переход через полночь и границу периода;
- `Switch site` и два объекта в один день;
- ручная правка с видимым clock-vs-reported diff;
- ручной submit, повторный идемпотентный запуск scheduler и auto-submit в `Europe/Helsinki`;
- auto-submit с открытой сменой/несинхронизированным событием без выдуманного Check Out;
- late sync → новая версия/diff без изменения уже отправленного оригинала;
- role isolation для WORKER/FOREMAN/ADMIN/SUPER_ADMIN;
- данные переживают restart, backup и restore.

# ЭТАП 8. ОТЧЁТЫ И PWA

## T8.1 — Отчёт по работнику 🟢 реализовано `[2026-08-19]`

Период, объект, статус, сумма часов. `GET /api/admin/reports/workers/:employeeId?periodId=`,
`/admin/reports` UI. Reusable `lib/reporting/worked-time.ts` — общее ядро формулы, которое T8.2/
T8.3/T8.4 обязаны переиспользовать. Полный контракт —
`docs/titanor-time/T8_REPORTS_DESIGN.md`.

## T8.2 — Отчёт по объекту 🟢 реализовано `[2026-08-19]`

Работники, даты, часы, общий итог.

**T8.2A (backend) 🟢** — `GET /api/admin/reports/sites/:siteId?periodId=`
(ADMIN/SUPER_ADMIN, любой объект) и `GET /api/foreman/reports/sites/:siteId?periodId=` (FOREMAN,
только текущие собственные объекты), один общий `lib/site-time-report.ts`. Новые permissions
`site.read.assigned`/`period.read.assigned` (FOREMAN only, additive DML migration
`20260819000000`). Полный контракт — `docs/titanor-time/T8_REPORTS_DESIGN.md` Addendum "T8.2A".

**T8.2B (UI) 🟢** — `/admin/reports/sites`, `/foreman/reports/sites`,
`components/reports/SiteTimeReportView.tsx` (единый компонент для обеих ролей). Backend T8.2A не
менялся. Cross-links: `/admin/reports` (вкладка "By worker"/"By site"), `/admin/sites/[siteId]`,
`/admin/periods/[periodId]`, `/foreman` (новая ссылка "Site reports"). Полный контракт —
`docs/titanor-time/T8_REPORTS_DESIGN.md` Addendum "T8.2B".

## T8.3 — Отчёт по периоду 🟢 реализовано `[2026-08-19]`

Без расчёта зарплаты в MVP.

**T8.3A (backend) 🟢** — `GET /api/admin/reports/periods/:periodId?page=`
(ADMIN/SUPER_ADMIN only), company/site-агрегат: работники, объекты, статусы табелей, дни, рабочее
время, итоги. Ноль employee rows (detail уже в T8.1/T8.2), ноль зарплаты/ставок, ноль новых
permissions/migrations. Новый общий `lib/reporting/canonical-source.ts`, на который переключены
T8.1/T8.2 без изменения их DTO. Полный контракт — `docs/titanor-time/T8_REPORTS_DESIGN.md`
Addendum "T8.3A".

**T8.3B (UI) 🟢** — `/admin/reports/periods`, `components/reports/PeriodTimeReportView.tsx`.
Backend T8.3A не менялся. Новый общий `components/reports/AdminReportTabs.tsx` — T8.1/T8.2 admin
UI переключены на него без изменения поведения. Cross-link: `/admin/periods/[periodId]` («View
full period report»). Полный контракт — `docs/titanor-time/T8_REPORTS_DESIGN.md` Addendum "T8.3B".

## T8.4 — CSV

Сначала простой CSV. PDF позже.

**T8.4A (schema foundation) 🟢 реализовано `[2026-08-19]`** — только модель `ExportBatch`/
`ExportItem` (immutable, `FULL`/`CORRECTION`) + 3 permissions (`period.export`, `export.create`,
`export.read`, только ADMIN/SUPER_ADMIN). Ноль CSV-генерации, ноль export/download API, ноль admin
UI, ноль PDF, ноль payroll/TES-категорий (rates/overtime/night/sunday/holiday/travel) — CSV_V1 это
отчёт по рабочему времени, canonical bucket `(employeeId, siteId, date)`, тот же что T8.1–T8.3.
Полный контракт — `docs/titanor-time/T8_REPORTS_DESIGN.md` Addendum "T8.4A",
`05_RAW_SQL_REGISTER.md` §12.

**T8.4B (CSV generation/API/download) 🟢 реализовано `[2026-08-19]`** — deterministic CSV_V1
generation, FULL export для `LOCKED` period, CORRECTION export (full replacement snapshot) для
`EXPORTED` period с pending corrections, `CorrectionRequest.coveredByExportBatchId` (новая additive
миграция `20260819180000`), 4 endpoint'а (`POST /api/admin/periods/:periodId/export`,
`GET /api/admin/export-batches`, `GET /api/admin/export-batches/:batchId`,
`GET /api/admin/export-batches/:batchId/download`). Ноль admin UI (T8.4C), ноль PDF, ноль
payroll/TES. Полный контракт — `docs/titanor-time/T8_REPORTS_DESIGN.md` Addendum "T8.4B",
`05_RAW_SQL_REGISTER.md` §13.

**T8.4C (admin UI) 🟢 реализовано `[2026-08-20]`** — `/admin/export` (история + панель создания)
и `/admin/export/:batchId` (детали), поверх уже полностью реализованного и не изменённого T8.4B
backend (ноль diff в `lib/csv-export.ts` и всех 4 route.ts). FULL/CORRECTION создание через UI с
frozen-idempotency-attempt UX (тот же паттерн, что T7A.10B), replacement-snapshot presentation для
CORRECTION batches, byte-for-byte верифицированное скачивание. 46/46 browser-сценария (87/87
проверок, Chromium, production standalone build). Полный контракт —
`docs/titanor-time/T8_REPORTS_DESIGN.md` Addendum "T8.4C".

**T8.4 полностью завершён** (T8.4A + T8.4B + T8.4C). PDF и payroll/TES-категории отложены на
отдельно согласованный этап. Следующий рекомендуемый шаг — T8.5-T8.8 (PWA gap audit).

## T8.5 — PWA manifest 🟢 реализовано `[2026-08-20]` (закрыто доказательствами, не переписано)

`public/manifest.webmanifest` (реализован ещё в T7A.10C.1) реально проверен, не только по наличию
файла: HTTP 200, корректный MIME, валидный JSON, `name`/`short_name`/`description`/`start_url`/
`scope`/`display: standalone`/`theme_color`/`background_color` — все поля присутствуют, icon-записи
не дают 404, `start_url` внутри `scope`, manifest link есть на `/worker/**` и отсутствует на
`/admin`/`/foreman`/`/login`. Файл byte-identical — переписывать было не за что. Design/доказательства
— `docs/titanor-time/T8_PWA_DESIGN.md` §A.

## T8.6 — Иконки 🟢 реализовано `[2026-08-20]` (закрыто доказательствами + один новый derivative)

`icon-192.png`/`icon-512.png` (T7A.10C.1) реально декодируются как PNG, реальные размеры совпадают
с заявленными, не пустые/прозрачные, ссылки в manifest не дают 404 — byte-identical, логотип не
менялся. Добавлен один новый файл — `public/icons/apple-touch-icon.png` (180×180), pixel-derived
downsample существующего icon-512.png (`node:zlib`, без новой зависимости, тот же принцип, что и
оригинальные иконки) — закрывает реальный, ранее не закрытый iOS-gap (не было ни
`apple-touch-icon`, ни `apple-mobile-web-app-capable` нигде в коде). Maskable-вариант не добавлен —
не доказанный installability gap, только косметика Android adaptive icon. Design/доказательства —
`docs/titanor-time/T8_PWA_DESIGN.md` §B.

## T8.7 — Установка 🟢 реализовано `[2026-08-20]`

Новая страница `/worker/install` (тот же session/role gate, что `/worker`), заметная ссылка
«Install app →» с `/worker` (скрыта на offline shell). 7-состояний install state machine
(`CHECKING`/`INSTALLABLE`/`INSTALLED`/`IOS_SAFARI`/`IOS_OTHER_BROWSER`/
`ANDROID_OR_DESKTOP_WITHOUT_PROMPT`/`UNSUPPORTED_OR_UNKNOWN`), Server/Client boundary без
hydration mismatch, синхронный ref-guard против double-prompt, `appinstalled`/standalone
display-mode для честного installed-статуса. Ноль новых runtime-зависимостей, `public/sw.js` не
менялся, offline outbox/FIFO не менялся (подтверждено `git diff` — только один новый файл в
`lib/offline-outbox/`). 59/59 browser-проверок (`scripts/_test-pwa-install.ts`, Chromium,
production standalone build). Физические iPhone/Android — внешний gate (T9.7), не проверялись.
Design — `docs/titanor-time/T8_PWA_DESIGN.md` §C.

## T8.8 — Offline 🟢 реализовано `[2026-08-20]`

Account-bound read-only offline просмотр для 6 экранов `/worker/**` (periods list, history,
period detail, hours list, day detail, submit summary) поверх существующего полного offline
Check In/Check Out/Switch Site (ЭТАП 7A, не изменён). IndexedDB `titanor-time-outbox` v1→v2
(аддитивно — новый store `workerReadSnapshots`, три существующих store не тронуты). Личные
снапшоты только в IndexedDB как allowlisted DTO (без PII-полей: без токена/куки, без сырых
GPS-координат, без payloadHash/requestId/deviceSequence); Cache Storage остаётся PII-free (только
`/worker-offline` shell + статика), как и раньше. Показ снапшота требует одновременного совпадения
6 сигналов account-binding (последний авторизованный пользователь браузера, подтверждённый
bootstrap'ом ownerUserId, ownerUserId самого снапшота, текущий deviceInstallationId,
deviceInstallationId снапшота, устройство не paused/revoked) — при смене аккаунта на одном
устройстве чужие данные никогда не показываются, pending outbox не удаляется автоматически.
`public/sw.js` расширен under network-first fallback на известные `/worker/**` UI-маршруты
(scope остаётся `/worker`, `/admin`/`/foreman`/`/login`/`/api/**` не перехватываются), cache
version v1→v2. Новый `WorkerLink` — offline-aware client navigation (forced document navigation
только когда `navigator.onLine === false`, обычный `next/link` иначе). 72 сценария из
99 browser/Node-проверок (`scripts/_test-offline-idb-invariants.ts` 23/23,
`scripts/_test-offline-cold-restart.ts` 5/5, `scripts/_test-offline-views.ts` 71/71), плюс
регрессия PWA install 59/59 и warm-cache/cold-restart/offline-outbox без изменений в
FIFO/deviceSequence/materializer. Физическая установка на телефон — внешний gate T9.7, не
проверялась. Design — `docs/titanor-time/T8_PWA_DESIGN.md` §F.

**Этим коммитом ЭТАП 8 (T8.1–T8.8) полностью завершён.**

# ЭТАП 9. ВНУТРЕННИЙ ТЕСТ

## T9.1 — Тестовые пользователи 🟢 реализовано `[2026-08-20]`

SUPER_ADMIN (bootstrap, единственный принятый способ на сегодня — тот же, что и для самого первого
владельца), ADMIN, standalone FOREMAN, WORKER A, WORKER B, dual-role FOREMAN+WORKER — все через
реальные API/UI (создание+активация), не прямой INSERT. Design/fixture-контракт —
`docs/titanor-time/T9_INTERNAL_TEST_PLAN.md` §5.

## T9.2 — Тестовые объекты 🟢 реализовано `[2026-08-20]`

Site Alpha, Site Beta, Site Gamma (третий — намеренно НЕ назначен прорабу, для isolation-проверки),
по одной work area на Alpha/Beta, геозона на обоих, один schedule template, один OPEN payroll
period, Worker A → Alpha (primary), Worker B → Beta (primary), foreman → Alpha+Beta.

## T9.3 — Проверка прав 🟢 реализовано `[2026-08-20]`

Постоянный role/permission checklist (`scripts/_test-t9-role-matrix.ts`, 32/32) — SUPER_ADMIN/ADMIN
операционный паритет, FOREMAN/WORKER scope-изоляция (в т.ч. чужой Site Gamma), dual-role
self-review-exclusion без неявного расширения прав, 401/403/CSRF/permission-revocation-на-следующем-
запросе/malformed-UUID-без-oracle/GET-без-AuditEvent/deny-до-body-validation — все подтверждены
живыми HTTP-запросами против реального Chromium + production standalone build.

**Найдены и исправлены 4 функциональных дефекта Setup/lifecycle** (владелец сообщил о трёх, четвёртый
— тот же класс, найден проактивно): у `/admin/workers` и `/admin/sites` не было ссылки на `.../new`
(после первого работника/объекта создать второй можно было только вручную набрав URL); у
`SiteAssignment`/`ForemanAssignment` полностью реализованный backend `.../end` не вызывался нигде в
UI (единственный реальный способ убрать работника из активного списка объекта, раз
`worker.deactivate` намеренно не трогает назначения). Попутно найдены и исправлены 9 route'ов
(`workers`, `assignments`×4, `sites/work-areas`×2, `periods`×2, `foreman-assignments`), где
malformed UUID в пути падал в Prisma и возвращал `500` вместо документированного `404` — тот же
паттерн уже был у соседних route этих же семейств, просто не везде применён последовательно.
Полный список, root cause и фикс каждого — `docs/titanor-time/T9_INTERNAL_TEST_PLAN.md` §3/§4,
`docs/titanor-time/IMPLEMENTATION_STATUS.md`.

**Не реализовано намеренно** (уже задокументированный, не новый gap): деактивация/role.assign
системных пользователей (`User.status`/`role.assign` для ADMIN/SUPER_ADMIN/standalone FOREMAN) — ни
backend, ни UI не существуют в текущем срезе (`04_ADMIN_FIRST_API_CONTRACTS.md` §14 сам говорит
«не входят, зарезервированы»); City не имеет lifecycle-действия вовсе. Оба — не блокеры для этой
задачи, не реализовывались без доказанного blocker.

Тесты — `scripts/_test-t9-fixtures.ts` (shared fixture), `scripts/_test-t9-setup-lifecycle.ts`
(50/50 — Setup checklist + Worker A/B CRUD/lifecycle + остальные Setup-разделы),
`scripts/_test-t9-role-matrix.ts` (32/32), `scripts/_test-t9-setup-ui.ts` (15/15 — mobile 390×844
worker/foreman, desktop 1280×800 admin). 97/97 проверок, реальный Chromium, production standalone
build, disposable PostgreSQL 16.

## T9.4 — Полный сценарий

```text
admin создаёт объект
→ назначает worker (FOREMAN необязателен)
→ worker отправляет часы
→ admin возвращает табель на исправление
→ worker исправляет
→ admin подтверждает review-scope
→ admin финально утверждает
→ admin видит согласованные отчёты
```

**`[2026-08-20] 🟢 завершено.`** Сквозной production-standalone сценарий прошёл **84/84** на
чистой disposable PostgreSQL 16. На основном объекте намеренно не было ни одного
`ForemanAssignment`: один ADMIN вернул V1, подтвердил исправленную V2 и финально утвердил табель;
не назначенный FOREMAN не увидел табель. Технический enum `FOREMAN_APPROVED` сохраняется ради
совместимости схемы и означает «все review-scope подтверждены / готово к финальному утверждению»,
а не обязательное действие FOREMAN. Роль FOREMAN в продукте — необязательный уполномоченный
проверяющий объекта; будущая проверка по внешней ссылке без аккаунта остаётся отдельным backlog.

По ходу сценария найдены и исправлены два product defect: worker UI не передавал
`originClockShiftFragmentId` и не позволял указать обязательную причину изменения GPS-origin
интервала; шесть экранов табеля считали gross time вместо canonical worked time с вычетом unpaid
break. Полный протокол: `docs/titanor-time/T9_FULL_FLOW_TEST_PLAN.md`.

## T9.5 — Restart

Проверить сохранность пользователей, объектов, часов и контента.

**`[2026-08-20] 🟢 завершено.`** На текущем commit/schema (62 migrations) подняты отдельные
production image + PostgreSQL volume + app + scheduler. Полный T9.4 seed прошёл 84/84, затем app,
scheduler и db независимо перезапущены через `docker restart`. Для каждого доказаны новый
PID/StartedAt при том же container ID; DB сохранила тот же volume; app и scheduler не
перезапускались вместе с DB и самостоятельно переподключились. Детерминированный hash всех
business-данных совпал до/после каждого restart; исключены только намеренно изменяемые liveness
строки `UserSession`/`WorkerDeviceInstallation`. Реальный Chromium и API после каждого рубежа
подтвердили ADMIN/WORKER sessions, объект, часы, immutable V1/V2, final approval и отчёт 420 min.
После DB restart выполнена реальная ADMIN-запись, пережившая ещё один app restart. Подробности:
`docs/titanor-time/T9_RESTART_TEST_PLAN.md`.

## T9.6 — Backup и restore

Не только создать backup, но и восстановить в тестовое место.

**`[2026-08-20] 🟢 завершено.`** Заполненная после T9.5 база сохранена через `pg_dump -F c`
(archive mode `0600`, SHA-256, 597 TOC entries) и восстановлена в совершенно отдельный PostgreSQL
16 container/volume без запуска миграций поверх. Source↔target parity: 62 migrations, 56 tables,
219 functions, 37 triggers, 150 FK, migration checksum history, row count каждого table и
order-independent hash всех данных — точное совпадение. Свежие app+scheduler запущены только
против restored DB; restored sessions, объект, часы, immutable V1/V2, FINAL_APPROVED и 420-minute
reports подтверждены Chromium/API 20/20. Restored DB приняла новую ADMIN-запись, пережившую app
restart; повторный verifier 20/20. Подробности: `docs/titanor-time/T9_BACKUP_RESTORE_TEST_PLAN.md`.

## T9.7 — Устройства

Android, iPhone/Safari, desktop, PWA install.

**`[2026-08-20] 🟡 начато.`** Подготовлен владелец-ориентированный physical-device acceptance:
ADMIN создаёт отдельного pilot-работника и выдаёт activation link; WORKER на реальном телефоне
активируется, устанавливает PWA, проходит online GPS, настоящий offline cold restart, sync,
редактирование/отправку timetable; затем ADMIN без FOREMAN выполняет review/final approval и
проверяет отчёт. Автоматические эмуляторные доказательства не засчитываются вместо телефона.
Для ручного прогона поднят отдельный временный HTTPS pilot URL с isolated DB: loopback preview
`:3244` не используется телефоном. Чек-лист и форма результата:
`docs/titanor-time/T9_DEVICE_ACCEPTANCE_PLAN_RU.md`.

**`[2026-08-20] Первый iPhone feedback.`** Реальная activation/login/worker clock граница пройдена.
Зафиксированы и взяты в исправление четыре UX-пробела: создание City отсутствовало вопреки API-
контракту; optional City/WorkArea выглядели как `NOT DONE`; payroll period не объяснялся; из
History/Enter hours не было постоянного возврата на worker home. Полный worker-dashboard по
владельческому эскизу и map-assisted geofence входят в ближайший post-acceptance UX slice. Ограничение
iOS остаётся платформенным: Safari Share → Add to Home Screen нельзя заменить программным one-click.
Второй worker onboarding уточнил канонический процесс владельца: Worker → немедленная ссылка/QR
активации → Site/WorkArea/шаблон прямо в карточке Worker. Activation не зависит от assignment или
period; без Site worker входит и получает честное пустое состояние, а Check In ждёт назначения.
Assignment-транзакция автоматически переиспользует пересекающийся OPEN period.
Следующий подтверждённый owner-UX slice: полная локализация интерфейса RU/EN/FI (русский как
рабочий язык пилота), контекстные `?`-подсказки для терминов и действий, а также iOS-инструкция
установки. QR/веб-приложение не может принудительно выбрать Safari вместо назначенного iOS
браузера: при необходимости UI должен определить платформу и показать Safari → Share → Add to
Home Screen, не обещая недоступную автоматизацию системного диалога.

**`[2026-08-21] Live ADMIN feedback.`** `WORKING_NOW` сделан явно зелёным; карточка открытой смены
показывает растущую длительность (локальный минутный display timer) и раз в 30 минут перечитывает
серверное состояние, пока вкладка видима. Периодические записи в БД намеренно не создаются:
источник истины — durable Check In/Check Out. Следующий отдельный архитектурный срез — индивидуальная
частота сдачи табеля (неделя/две недели), автоматическая генерация периодов и безопасное изменение
legacy OPEN-периода; это не смешивается с шаблоном рабочих часов.
Найден и исправлен отдельный display-only timezone defect: production host показывал сохранённый
UTC instant в UTC (`07:52`) вместо `Europe/Helsinki` (`10:52`). Хранимые события не менялись.

# ЭТАП 10. НЕДЕЛЬНАЯ ОБКАТКА

## T10.1 — Ограниченный запуск

Один начальник, один прораб, несколько работников, один-два объекта.

## T10.2 — Сбор ошибок

Для каждой проблемы записывать:

```text
что сделал
что ожидал
что произошло
устройство
браузер
время
скриншот
```

## T10.3 — Не смешивать баги и новые функции

Баг исправляется отдельно. Новая идея идёт в backlog.

## T10.4 — Повторный тест

После исправления проверить исходную ошибку и соседние функции.

# ЭТАП 11. ФИНАЛЬНЫЙ ВЫПУСК

## T11.1 — Freeze

Не добавлять новые функции. Только исправления. Зафиксировать SHA и backup.

## T11.2 — Финальный checklist

- сайт;
- EN/FI;
- admin;
- login;
- roles;
- workers;
- worksites;
- assignments;
- time entry;
- approval/rejection;
- reports;
- CSV;
- PWA;
- Zoho;
- Cloudinary;
- backup;
- CollabStudio.

## T11.3 — Merge в main

Только после проверок.

## T11.4 — Deploy

Использовать документированный процесс.

## T11.5 — Наблюдение

Проверять health, logs, disk, memory, backup, реальные часы и CollabStudio.

# ШАБЛОН ЗАДАЧИ ДЛЯ АГЕНТА

```text
ЗАДАЧА:
[один конкретный результат]

КОНТЕКСТ:
[только нужная информация]

РАЗРЕШЕНО:
[точные файлы или область]

ЗАПРЕЩЕНО:
[что нельзя трогать]

КРИТЕРИИ ГОТОВНОСТИ:
[проверяемый результат]

ПРОВЕРКИ:
[точные команды]

ПОСЛЕ ВЫПОЛНЕНИЯ:
Ответить коротко:
- изменённые файлы;
- результат проверок;
- что не выполнено.
Не вставлять полный diff.
Не начинать следующий шаг.
```

# ШАБЛОН ПРОВЕРКИ ВЛАДЕЛЬЦЕМ

```bash
git status --short
git diff --name-only
git diff --stat
git diff
npx tsc --noEmit
npm run build
```

После принятия:

```bash
git add <точные файлы>
git commit -m "type(scope): description"
```

# ГОТОВНОСТЬ ВСЕГО ПРОЕКТА

Проект завершён, когда:

- сайт работает на VPS;
- Vercel и Supabase не нужны для runtime;
- CollabStudio работает без изменений;
- админка управляет сайтом и рабочими сущностями;
- работники устанавливают Titanor Time;
- работник быстро вводит часы;
- прораб проверяет свою команду;
- начальник видит всю компанию;
- роли проверяются на сервере;
- подтверждённые часы защищены;
- audit log работает;
- отчёты работают;
- backup и restore проверены;
- приложение прошло внутренний тест;
- приложение прошло обкатку;
- критические баги исправлены;
- production можно откатить.
