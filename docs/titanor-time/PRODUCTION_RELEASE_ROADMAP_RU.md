# Titanor Time — roadmap подготовки и запуска production

- **Статус:** рабочий план выполнения
- **Дата фиксации:** 2026-08-29
- **Основание:** [PRODUCTION_RELEASE_TZ_FINAL_RU.md](./PRODUCTION_RELEASE_TZ_FINAL_RU.md)
- **Целевой адрес:** `https://app.titanorgroup.fi`
- **Источник production-кода и данных:** проверенное pilot-окружение
- **Текущий вердикт:** исправления можно начинать; production cutover пока запрещён

---

## 1. Назначение roadmap

Этот документ переводит финальное ТЗ в последовательность отдельных исполнимых задач. Он определяет:

- порядок работ от текущего состояния до production;
- зависимости между этапами;
- обязательные результаты и доказательства;
- критерии PASS/FAIL;
- контрольные точки владельца;
- порядок DNS, cutover, наблюдения и rollback;
- первое задание, которое можно передать агенту прямо сейчас.

Roadmap не заменяет финальное ТЗ. При расхождении требований приоритет имеет `PRODUCTION_RELEASE_TZ_FINAL_RU.md`.

---

## 2. Зафиксированный конечный результат

После завершения roadmap:

1. `app.titanorgroup.fi` открывает рабочий Titanor Time по HTTPS.
2. Production использует утверждённый release image и полную pilot-БД.
3. Перенесены pilot-пользователи, работники, объекты, назначения, часы, GPS, документы, настройки и audit history.
4. Старая production-БД сохранена отдельно, но не смешана с pilot-БД.
5. Старые sessions и временные recovery-токены отозваны.
6. ADMIN/SUPER_ADMIN и WORKER имеют завершённые профили.
7. Восстановление доступа выполняется администратором без SMTP.
8. FOREMAN продолжает работать в текущем role flow; отдельный профиль FOREMAN не создаётся.
9. Scheduler выполняет рабочие циклы и имеет достоверный healthcheck.
10. Backup восстанавливается в изолированное окружение.
11. Raw GPS хранится в рабочей БД 90 дней, а затем остаётся в зашифрованном долговременном архиве.
12. На публичном `titanorgroup.fi` есть вход для существующих пользователей; регистрации нет.
13. Будущие релизы проходят автоматические build, typecheck, migration, security и regression gates.

---

## 3. Неподвижные решения и границы scope

- Pilot-БД становится production-БД целиком.
- Старая production-БД не имеет приоритета и не объединяется с pilot.
- Данные pilot нельзя считать тестовыми и удалять без отдельного решения владельца.
- Production-домен — `app.titanorgroup.fi`.
- Titanor Time остаётся на русском и английском языках.
- Финский язык в Titanor Time сейчас не добавляется.
- SMTP, Zoho и email-доставка recovery-ссылок не используются.
- Email остаётся контактной информацией и дополнительным логином.
- Recovery-код или recovery-ссылку создаёт администратор и передаёт пользователю вне приложения.
- Новый профиль FOREMAN не входит в текущий scope.
- Регистрация новых пользователей с публичного сайта не добавляется.
- Raw GPS в рабочей БД хранится 90 дней.
- Долговременный GPS-архив хранится зашифрованным, а не открытым `.txt`.
- Массовые `audit fix --force`, непроверенные major-upgrade и смешивание всех правок в один deploy запрещены.

---

## 4. Правила выполнения

Каждый этап выполняется отдельной задачей и должен завершаться отдельным проверяемым результатом.

Для каждой задачи агент обязан:

1. Прочитать финальное ТЗ, этот roadmap, `AGENTS.md` и связанные документы.
2. До изменений зафиксировать Git SHA, состояние worktree и затрагиваемые сервисы.
3. Не перезаписывать и не включать в commit чужие незавершённые изменения.
4. Не печатать secrets, cookies, password hashes, recovery tokens и персональные GPS-данные.
5. Делать минимальный тематический commit без несвязанных правок.
6. Проверять изменение в clean/reproducible environment.
7. Разворачивать сначала только в pilot или disposable environment.
8. Оставлять отчёт с командами проверки, результатами, Git SHA и известными рисками.
9. При FAIL откатывать только собственное изменение и не продолжать следующий этап.
10. Не менять production, Caddy и DNS, если это прямо не разрешено соответствующим этапом.

Production cutover разрешается только после R12 и отдельного подтверждения владельца на R13.

---

## 5. Фактическая исходная точка

### 5.1. Что уже подтверждено аудитом

- Pilot работает на проверяемом image, Git/worktree был чистым.
- Titanor Time и публичный сайт собираются в clean environment.
- Pilot-БД содержит 93 применённые миграции из 93, failed migrations не обнаружены.
- В pilot есть рабочие пользователи, работники, объекты, назначения, табели, clock events, shifts, exceptions, sessions и audit events.
- Дубликаты username/email, orphan Employee, активные пользователи без пароля и открытые shifts не обнаружены.
- Pilot scheduler выполняет успешные ticks.
- Защищённые route-группы имеют auth/permission guards; mutating routes имеют CSRF-механизм.
- Pilot dump был восстановлен в disposable PostgreSQL; для переноса требуется `--no-owner --no-acl`.
- Критические DB regression tests в основном проходят.
- Desktop/tablet UI в основных сценариях работоспособен.

Все эти факты должны быть повторно проверены для финального release candidate; старый отчёт не заменяет release evidence.

### 5.2. Блокеры production

| ID | Блокер | Почему нельзя игнорировать | Закрывается |
|---|---|---|---|
| B01 | Нет доказанной автоматической backup-схемы на правильном storage | Нельзя безопасно заменить production-БД | R01 |
| ~~B02~~ | `/mnt/250gb` — s3fs на Contabo Object Storage. **ЗАКРЫТ 2026-08-30**: панель Contabo подтвердила бакет `US-central 3629`, 250 GB куплено, 3 MB занято. Off-box backup+restore проверены. Открытый вопрос GDPR (US-регион) — решение владельца до R14, не блокер | ✅ R01 |
| ~~B03~~ | Профили/recovery без SMTP. **ЗАКРЫТ 2026-08-30 (R03)**: admin-assisted одноразовый код `XXXX-XXXX-XXXX`, `/reset-password` (логин+код+пароль), SMTP-путь удалён целиком. | ✅ R03 |
| ~~B04~~ | change-password + session management. **ЗАКРЫТ 2026-08-30 (R03)**: `POST /api/auth/change-password`, `GET/DELETE /api/me/sessions`, панель сессий на профилях. | ✅ R03 |
| B05 | 8 high dependency findings. **Titanor Time ЗАКРЫТ 2026-08-30 (R05)** — `npm audit --omit=dev` = 0 (Next 16.3.3, Prisma 6.19.3, effect 3.21, deepmerge-ts 8 override). Публичный сайт (R04) — отдельно. | 🟡 R05 done / R04 pending |
| ~~B06~~ | Нет стабильных `test`/`typecheck`/`lint` gates; часть старых тестов противоречит контракту. **ЗАКРЫТ 2026-08-30 (R02)**: каталог из 75 тестов по lane'ам, per-test изоляция БД, 5 тестов исправлено, `typecheck`/`lint`/`test` команды, CI с required `ci-summary`. Локально: 0 type-ошибок, unit 11/11, db+scheduler 48/48, build ✓. Browser-lane (15) → R12 | ✅ R02 |
| B07 | Production scheduler unhealthy, а readiness не проверяет схему | HTTP 200 может скрывать несовместимую БД | R06 |
| B08 | In-memory rate limit, доверие первому `X-Forwarded-For`, слабые public admin/contact/upload controls | Обход ограничений и недостаточный security boundary | R07 |
| B09 | Нет долговременного зашифрованного GPS-архива до удаления raw records | Возможна необратимая потеря истории координат | R08 |
| B10 | Mobile overflow в ADMIN и части WORKER-экранов; неполные UX-потоки | Рабочие сценарии на телефоне неудобны или частично недоступны | R09 |
| B11 | Некоторые API возвращают 500 на malformed UUID | Ошибка клиента превращается в server error | R07/R09 |
| B12 | Docker image слишком велик, использует `npm install` и полный runtime `node_modules` | Невоспроизводимость и лишняя attack surface | R06 |
| B13 | `app.titanorgroup.fi`, Caddy host и public login link не готовы | Production нельзя открыть по утверждённому адресу | R11 |

Текущий статус запуска: **NO-GO**. Текущий статус начала исправлений: **GO**.

---

## 6. Общая последовательность

| Этап | Результат | Зависит от | Production impact | Статус |
|---|---|---|---|---|
| R00 | Release baseline и freeze | — | Нет | **DONE `96799ba`** — `RELEASE_BASELINE_2026-08-29_RU.md` |
| R01 | Backup/storage foundation | R00 | Нет | **DONE `96799ba` — PASS** (квота Contabo 250 GB подтверждена 2026-08-30; таймер устанавливает владелец, см. `BACKUP_RESTORE_RUNBOOK_RU.md` §6) |
| R02 | Надёжные test/CI gates | R00 | Нет | **DONE `e2ad7e1`+ — PASS** (отчёт `R02_TEST_CI_REPORT_RU.md`; каталог `TEST_CATALOG_RU.md`; browser-lane → R12) |
| R03 | Profiles и recovery без SMTP | R01, R02 | Нет | **DONE `22e8b12` — регрессия 62/62; pilot deploy pending (`deploy-22e8b12.sh`)** (отчёт `R03_ACCOUNT_RECOVERY_RU.md`) |
| R04 | Security upgrade публичного сайта | R02 | Нет | **Следующий** — блокер: root `node_modules` в worktree принадлежит root (нужен `sudo rm -rf` от владельца) |
| R05 | Security upgrade Titanor Time | R02 | Нет | **DONE `7bc6c77` — audit 8→0; регрессия 62/62** (отчёт `R05_DEPENDENCY_SECURITY_RU.md`; pilot image+deploy вместе с R03) |
| R06 | Scheduler/readiness/Docker/operations | R01, R02, R05 | Нет | Не начат |
| R07 | Security hardening приложений/API | R02, R04, R05 | Нет | Не начат |
| R08 | GPS archive и безопасный retention | R01, R02, R06 | Нет | Не начат |
| R09 | WORKER/FOREMAN/ADMIN UX | R03, R05, R07 | Нет | Не начат |
| R10 | Release candidate и полная pilot acceptance | R03–R09 | Нет | Не начат |
| R11 | Domain/Caddy/public login preparation | R04, R10 | Caddy staging; DNS только по команде | Не начат |
| R12 | Production-like rehearsal и release evidence | R10, R11 | Нет | Не начат |
| R13 | Owner production checkpoint | R12 | Решение владельца | Не начат |
| R14 | Production cutover | R13 | Да | Запрещён до подтверждения |
| R15 | Наблюдение, backup следующего дня, закрытие релиза | R14 | Да | Не начат |

Рабочая цепочка:

`R00 → R01 → R02 → R03/R04/R05 → R06/R07 → R08/R09 → R10 → R11 → R12 → R13 → R14 → R15`

R03, R04 и R05 можно разрабатывать независимо после R02, но в одном worktree безопаснее выполнять их последовательными commits/deploys.

---

## 7. Подробный roadmap

### R00. Release baseline и freeze

**Цель:** создать одну проверяемую исходную точку, относительно которой оцениваются все дальнейшие изменения.

**Работы:**

- зафиксировать repository, branch, Git SHA и clean/dirty status;
- зафиксировать pilot image tag/ID и команды запуска web/scheduler;
- снять migration status и полный список миграций;
- снять безопасные row counts ключевых таблиц;
- создать manifest uploads без публикации содержимого документов;
- повторно измерить root disk, Docker storage, backup path и `/mnt/250gb`;
- зафиксировать версии Node, npm, PostgreSQL, Docker и Compose;
- сохранить текущие dependency audit reports;
- перечислить действующие production/pilot domains, containers, volumes и mounts;
- установить feature freeze для несвязанных pilot-правок до release candidate.

**Артефакты:** baseline report, row-count manifest, upload manifest, dependency audit reports.

**PASS:** все значения привязаны ко времени, environment и Git SHA; production не изменён.

**FAIL:** неизвестно, какой код/image/DB фактически проверяется, или worktree содержит неидентифицированные изменения.

---

### R01. Backup и storage foundation

**Цель:** доказать восстановимость данных до любых production-операций.

**Работы:**

- определить реальный тип, ёмкость, quota и persistency `/mnt/250gb`;
- проверить владельца mount, права, запись/чтение, поведение после reconnect/reboot и свободное место;
- не считать имя mount доказательством 250 GB;
- выбрать основной backup target и резервный путь;
- реализовать атомарный backup pilot-БД в PostgreSQL custom format;
- архивировать uploads с сохранением структуры и permissions;
- создать manifest: environment, timestamp, Git SHA, image, migrations, row counts, sizes и SHA-256;
- исключить secrets и персональные координаты из логов/manifest;
- добавить lock от одновременного запуска и явный non-zero exit при ошибке;
- настроить безопасное уведомление о неуспешном backup без secrets в сообщении;
- выполнить restore с `--no-owner --no-acl` в disposable PostgreSQL;
- проверить миграции, row counts, роли, объекты, назначения, табели, clock data, audit и uploads;
- зафиксировать политику 7 daily / 4 weekly / 12 monthly плюс pre-deploy/pre-migration;
- настроить pilot schedule и безопасный сигнал об ошибке только после подтверждения storage;
- не удалять существующие backups в рамках первой настройки.

**Артефакты:** backup scripts/config, timer/service definition, backup manifest, checksums, restore report и runbook.

**PASS:** новый backup создан, checksum проверен, восстановление завершено, counts совпали, повторный запуск безопасен.

**FAIL:** storage/quota не подтверждены, backup хранится только внутри удаляемого container, restore не выполнен или counts расходятся.

**Точка владельца:** если `/mnt/250gb` не подтверждает требуемую ёмкость, агент останавливает постоянную настройку и выдаёт точную инструкцию: что исправить у storage-провайдера или какой mount предоставить. Production при этом не трогается.

---

### R02. Test contracts, команды и CI gates

**Цель:** сделать каждое последующее изменение доказуемо безопасным.

**Работы:**

- инвентаризировать все `_test-*.ts` и разделить на unit, DB, scheduler, browser и destructive/manual;
- добавить документированные `lint`, `typecheck`, `test`, `test:db`, `test:browser` и release-команды;
- исправить устаревший typecheck test с невозможным сравнением `FAILED`;
- исправить role-matrix assertion так, чтобы он проверял код/результат, а не конкретный язык текста;
- согласовать schedule test с действующим контрактом auto-enroll первого назначения;
- запретить DB/browser tests против production;
- добавить clean install, Prisma generate/validate, typecheck и builds обоих приложений;
- добавить fresh-DB migration test и restored-pilot migration test;
- добавить dependency audit report без автоматического force-fix;
- добавить secret scan и контроль lockfile;
- настроить CI с обязательным итоговым PASS/FAIL.

**Артефакты:** CI workflow, test catalog, release-test command, первый зелёный CI report.

**PASS:** один документированный pipeline воспроизводимо проходит в clean environment; skipped tests перечислены с причиной.

**FAIL:** зелёный build достигается исключением критических tests или игнорированием ошибок без решения.

---

### R03. Учётные записи, профили и recovery без SMTP

**Цель:** завершить безопасное управление аккаунтом для ADMIN/SUPER_ADMIN и WORKER.

**ADMIN/SUPER_ADMIN:**

- единый profile/account screen;
- username, roles, email, language, last login;
- email update только после подтверждения текущим паролем;
- обычная смена пароля по текущему паролю;
- список активных sessions с device/IP metadata в допустимом объёме;
- завершение выбранных других sessions и «выйти на всех устройствах»;
- audit всех чувствительных действий.

**WORKER:**

- account block с теми же email/password/session controls;
- сохранение worker-specific данных: фото, контакты, профессии, квалификации, документы и личная информация;
- необязательные profile fields не блокируют clock.

**Recovery без SMTP:**

- администратор создаёт одноразовый короткоживущий code/link;
- secret показывается администратору только один раз и не хранится открытым текстом;
- пользователь вводит login, code и новый пароль на `/reset-password`;
- успешный reset отзывает все прежние sessions/tokens;
- повторное использование, истечение срока и brute force блокируются;
- UI нигде не обещает отправку письма;
- существующий email-reset flow удаляется или полностью отключается без мёртвых routes/settings.

**Не входит:** профиль FOREMAN, SMTP, email verification и финский язык.

**PASS:** role/API/browser tests подтверждают happy path, wrong password, expired/reused code, rate limit, session revocation и audit.

---

### R04. Dependency security — публичный сайт

**Цель:** отдельно обновить public site без смешивания с Titanor Time.

**Работы:**

- обновить Next.js до согласованной исправленной stable patch;
- поднять PostCSS и Nanoid до исправленных версий;
- проверить Sharp и фактическое дерево транзитивных зависимостей;
- выполнить clean `npm ci`, audit, typecheck/build и preview;
- проверить EN/FI страницы, навигацию, contact form, admin login, content editing и uploads;
- не использовать `audit fix --force`;
- сохранить before/after audit report.

**PASS:** clean build и browser smoke проходят, новых high/critical findings нет либо каждый остаточный finding документирован с owner decision.

---

### R05. Dependency security — Titanor Time

**Цель:** отдельно обновить Time runtime с полной проверкой бизнес-сценариев.

**Работы:**

- обновить Next.js, PostCSS, Nanoid и Sharp до согласованных исправленных patch/minor versions;
- обновить Prisma 6.x отдельным patch до согласованной версии без major-upgrade;
- проверить `effect` и отдельно оценить остающийся `deepmerge-ts`;
- не смешивать Next/runtime update и Prisma update в один непроверяемый шаг;
- после каждого slice выполнять clean install, Prisma generate/validate, typecheck, build, DB tests и browser smoke;
- собрать immutable pilot image с Git SHA;
- выполнить pilot deploy и проверить web/scheduler.

**PASS:** lockfile воспроизводим, regression suite зелёный, pilot работает на exact image, audit report принят.

---

### R06. Scheduler, readiness, Docker и operations

**Цель:** исключить ситуацию, когда container выглядит живым при несовместимой схеме или сломанном scheduler.

**Работы:**

- расширить `/api/ready`: DB connection, schema/migration version, failed migrations и ключевые tables;
- не раскрывать database URL, SQL, credentials или персональные данные;
- различать scheduler states: process down, DB down, stale/missing heartbeat, tick failure и schema mismatch;
- проверить attendance auto-submit, periods, abandoned shifts, GPS retention, graceful shutdown и restart recovery;
- исключить overlapping ticks;
- использовать один immutable image для web и scheduler с разными commands;
- перейти на `npm ci` и lockfile-only build;
- минимизировать runtime packages и не переносить весь dev `node_modules`;
- запускать процессы от non-root;
- добавить реальные Docker healthchecks для pilot/production definitions;
- фиксировать image size и состав runtime в отчёте;
- создать scheduler operations runbook.

**PASS:** restored pilot clone и pilot проходят readiness/health/tick/restart tests; ложный HTTP 200 при старой схеме невозможен.

---

### R07. Security hardening и API robustness

**Titanor Time:**

- централизовать повторяющиеся auth/permission проверки без изменения role matrix;
- сохранить CSRF для всех mutations;
- принимать proxy headers только через доверенный Caddy boundary;
- перестать доверять первому произвольному `X-Forwarded-For`;
- сделать rate-limit пригодным для restart и будущего multi-instance режима;
- валидировать UUID/input до Prisma и возвращать безопасный 4xx, а не P2023/500;
- убрать лишний `x-powered-by`, добавить production security headers и noindex/robots policy;
- добавить безопасные global error/not-found states;
- исключить sensitive values из logs.

**Публичный сайт:**

- rate-limit admin login и contact form;
- timing-safe credential handling;
- CSRF-защита admin logout/mutations;
- secure cookie policy и безопасный login audit;
- timeouts и sanitized errors для contact delivery;
- magic-byte validation, size limits, re-encoding изображений, `nosniff`, безопасный `Content-Disposition`, permission checks и path traversal protection для uploads.

**PASS:** negative/security regression tests проходят; malformed input не вызывает 500; rate-limit нельзя обойти подменой первого forwarded IP.

---

### R08. GPS archive и retention

**Цель:** raw GPS старше 90 дней удаляется из рабочей БД только после доказанного архивирования.

**Работы:**

- сформировать ежедневный append-only export новых GPS records;
- включить ClockEventLocation и ShiftPresenceSample с нужным business context;
- использовать структурированный JSONL/CSV внутри зашифрованного и сжатого архива;
- создавать manifest, record counts, диапазон дат и SHA-256;
- хранить ключ отдельно от архива и не печатать его в logs;
- обеспечить idempotency и защиту от пропусков/дубликатов;
- удалять records старше 90 дней только после archive PASS и verify;
- при ошибке архива retention должен остановиться, а данные — остаться в БД;
- включить GPS archive manifest в общий backup bundle;
- обновить privacy/retention documentation и owner-facing policy.

**PASS:** архив расшифровывается в disposable проверке, counts совпадают, failure simulation сохраняет исходные DB records.

---

### R09. UX WORKER, FOREMAN, ADMIN/SUPER_ADMIN

**Общие требования:** mobile-first, RU/EN, отсутствие horizontal overflow, понятные состояния loading/empty/error/success, защита от повторного действия.

**WORKER:**

- одно главное clock-действие;
- активный объект и время старта;
- online/offline/sync state и pending operations;
- безопасный manual retry;
- человеческие GPS messages;
- незаполненные дни, неподанные периоды и ясные timesheet statuses;
- заметное действие для returned timesheet;
- исправить overflow на profile/history/install;
- разделить большой clock UI без изменения поведения.

**FOREMAN:**

- mobile/tablet navigation;
- единый task list с приоритетом незакрытых shifts, GPS issues, неподанных timesheets и exceptions;
- быстрые переходы к работнику/timesheet/exception;
- search и URL filters по site/period/status;
- понятные причины запрета вместо permission codes;
- confirmation для bulk actions и защита от double submit;
- отдельный profile не добавлять.

**ADMIN/SUPER_ADMIN:**

- redirect после login на `/admin`, а setup оставить отдельным разделом;
- единый task center;
- search/pagination/filter системных пользователей;
- единая worker card: профиль, профессии, квалификации, документы, назначения, часы, история и recovery;
- исправить mobile navigation/overflow;
- удалить устаревшие UI labels/links;
- безопасно разделить самые крупные modules без изменения business logic.

**PASS:** browser acceptance на desktop, tablet, iPhone-like и Android-like viewport; keyboard navigation и основные accessibility checks; owner acceptance.

---

### R10. Release candidate и полная pilot acceptance

**Цель:** заморозить один exact candidate, который больше не меняется до rehearsal.

**Работы:**

- создать release branch/tag и immutable image с Git SHA;
- применить candidate к pilot;
- выполнить clean CI/release pipeline;
- пройти auth/recovery/session matrix;
- пройти WORKER clock/GPS/offline/timesheet flow;
- пройти FOREMAN review/scope/exception flow;
- пройти ADMIN users/employees/sites/assignments/reports/PDF/CSV flow;
- проверить Scheduler, readiness, backup/restore и GPS archive;
- выполнить browser/device matrix;
- проверить migration from fresh DB и restored pilot copy;
- обновить guide, screen map, ERD и implementation status;
- открыть только release-blocking fixes; каждое исправление создаёт новый candidate и повторяет затронутые tests.

**Артефакты:** pilot acceptance report, release manifest, migration report, dependency report и owner checklist.

**PASS:** нет открытых P0/P1 defects, все обязательные проверки зелёные, candidate неизменяем.

---

### R11. Domain, Caddy и public login preparation

**Цель:** подготовить инфраструктуру домена, не публикуя неготовое приложение.

**Сначала делает агент:**

- готовит Caddy host для `app.titanorgroup.fi`;
- настраивает TLS, redirect HTTP→HTTPS, proxy headers и security headers;
- проверяет firewall/ports и production upstream;
- подготавливает maintenance response до cutover;
- добавляет на public site EN/FI ссылку Employee login на `https://app.titanorgroup.fi`;
- проверяет отсутствие регистрации;
- пишет точную Cloudflare instruction с record type/name/value/proxy/TTL;
- до подтверждения владельца не переключает live DNS.

**Затем делает владелец:**

- по готовой инструкции создаёт DNS record в Cloudflare либо предоставляет агенту доступ;
- подтверждает, что запись создана;
- не меняет другие DNS records.

**После DNS снова делает агент:**

- проверяет propagation, сертификат, HTTPS, redirects и headers;
- оставляет maintenance/access control до R14;
- проверяет public login link.

**PASS:** домен технически готов, но рабочий production ещё не открыт пользователям.

---

### R12. Production-like rehearsal и release evidence

**Цель:** полностью повторить cutover без изменения live production.

**Работы:**

- объявить pilot freeze на время финального snapshot;
- сделать DB dump, uploads archive, GPS archive manifest и checksums;
- восстановить snapshot в disposable production-like environment;
- использовать `--no-owner --no-acl` и целевого production DB owner;
- применить только ожидаемые pending migrations;
- запустить exact release image для web и scheduler;
- настроить копии production env/mounts без копирования secrets в отчёты;
- отозвать sessions/tokens в rehearsal и проверить последствия;
- пройти полную acceptance matrix;
- выполнить ещё один backup/restore уже из rehearsal environment;
- отработать rollback и измерить реальный порядок/время операций;
- удалить disposable resources после сохранения evidence.

**Артефакты:** signed PASS/FAIL report, точный cutover runbook, downtime plan, rollback evidence, release manifest.

**PASS:** rehearsal завершён без ручных импровизаций и неизвестных шагов.

---

### R13. Контрольная точка владельца

Агент передаёт владельцу одним пакетом:

- Git SHA и release tag;
- image tag/ID и image size;
- migration count/status;
- baseline и final row-count manifests;
- backup paths, sizes и checksums;
- restore/rehearsal evidence;
- test/acceptance/dependency reports;
- точное maintenance window;
- ожидаемый downtime;
- DNS status;
- пошаговый cutover и rollback;
- список остаточных рисков;
- что именно пользователь увидит после первого входа.

Владелец отдельно подтверждает:

1. Pilot acceptance.
2. Maintenance window.
3. Production cutover.

Молчание или общее «продолжай» без готового evidence package не считается подтверждением разрушительной замены БД.

---

### R14. Production cutover

**Предусловия:** R12 PASS, R13 подтверждён, backups и rollback доступны, DNS/Caddy подготовлены.

**Порядок:**

1. Объявить начало maintenance.
2. Показать maintenance response и запретить новые записи.
3. Остановить старый production scheduler.
4. Остановить старое production web-приложение или перевести его в read-only/maintenance.
5. Создать и проверить финальный backup старой production-БД и её uploads.
6. Включить короткий write freeze pilot.
7. Создать финальный pilot DB dump, uploads archive и GPS manifest.
8. Проверить SHA-256, sizes, migrations и row counts.
9. Восстановить pilot-БД в production с правильным owner и `--no-owner --no-acl`.
10. Восстановить pilot uploads и проверить manifest.
11. Настроить production secrets, encryption keys, volumes и mounts.
12. Отозвать все старые sessions и временные recovery/activation tokens согласно release plan.
13. Применить только ожидаемые final migrations.
14. Запустить exact release image web.
15. Проверить schema-aware readiness.
16. Запустить scheduler из того же image.
17. Дождаться нескольких успешных ticks/heartbeat.
18. Сверить production row counts и migration status с final manifest.
19. Выполнить smoke tests SUPER_ADMIN, ADMIN, WORKER и FOREMAN.
20. Проверить clock/GPS/offline, recovery, reports/PDF/CSV и uploads.
21. Открыть `app.titanorgroup.fi`.
22. Активировать/проверить Employee login на public site.
23. Завершить maintenance и зафиксировать время открытия.

**Немедленный rollback запускается, если:**

- restore/checksum/counts не совпали;
- schema readiness не проходит;
- scheduler не даёт устойчивых успешных ticks;
- ключевые роли не могут войти;
- clock, permissions или uploads системно сломаны;
- обнаружена потеря/расшифровка данных;
- TLS/domain ведёт не в ожидаемое окружение.

Старая production-БД после cutover не удаляется.

---

### R15. Наблюдение и закрытие релиза

**Первые 2 часа:**

- непрерывно контролировать app errors, readiness, scheduler heartbeat/ticks, login/recovery и disk usage;
- проверить первые реальные role flows;
- не смешивать release incidents с новыми feature requests.

**Первые 24 часа:**

- проверить clock/GPS/offline sync и timesheet processing;
- проверить uploads, reports и audit events;
- дождаться и проверить автоматический backup;
- выполнить выборочную restore-проверку или полный scheduled restore-test;
- проверить GPS archive/retention status;
- проверить место на storage.

**Через 72 часа и после согласованного периода стабильности:**

- сформировать production cutover report;
- закрыть или вынести остаточные defects;
- обновить runbooks и implementation status;
- получить owner sign-off;
- отдельно решить срок хранения старого production backup;
- удалить старые данные только отдельной задачей и только после явного разрешения.

---

## 8. Release gates

Ни один gate не закрывается словами «вроде работает».

| Gate | Обязательное доказательство |
|---|---|
| G1 Data safety | backup + checksum + успешный restore + совпавшие counts |
| G2 Code quality | clean install + typecheck + builds + test catalog |
| G3 Security | audit reports + negative tests + accepted residual risks |
| G4 Accounts | profiles/recovery/session browser и API tests |
| G5 Operations | schema readiness + scheduler tick/restart evidence |
| G6 Data lifecycle | GPS archive verify + safe retention failure test |
| G7 UX | device/role acceptance report без блокирующих defects |
| G8 Release | immutable image, migration report и full pilot PASS |
| G9 Rehearsal | восстановленная pilot-копия и отработанный rollback |
| G10 Owner | явное подтверждение maintenance и cutover |
| G11 Production | smoke tests, counts, scheduler и backup следующего дня |

---

## 9. Что потребуется от владельца и когда

### Сейчас

Ничего менять в Cloudflare не нужно. Сначала агент выполняет R00–R10 и готовит Caddy/DNS instruction на R11.

### После R01

Только если storage не подтверждён:

- исправить quota/volume у провайдера;
- предоставить корректный mount или доступ к выбранному backup storage;
- подтвердить допустимый срок хранения и стоимость, если storage внешний.

### На R11

- добавить одну DNS-запись Cloudflare по точной инструкции агента или дать агенту scoped access;
- не менять nameservers и остальные records.

### На R13

- принять pilot;
- выбрать maintenance window;
- явно разрешить production cutover.

### После запуска

- проверить рабочие сценарии своими ADMIN/SUPER_ADMIN учётными записями;
- подтвердить стабильность и только потом разрешать удаление старых backups.

---

## 10. Рекомендуемый порядок выдачи задач агентам

Каждая строка — отдельное задание и отдельный commit/deploy/report.

1. R00+R01: baseline, storage, backup и restore foundation.
2. R02: нормализация тестов, команд и CI.
3. R03-A: recovery без SMTP и security contract.
4. R03-B: ADMIN/SUPER_ADMIN и WORKER profiles/session management.
5. R04: public-site dependency security.
6. R05-A: Titanor Time Next/PostCSS/Nanoid/Sharp update.
7. R05-B: Prisma 6.x patch и deepmerge compatibility report.
8. R06-A: schema readiness и scheduler diagnostics.
9. R06-B: Docker reproducibility/runtime minimization/healthchecks.
10. R07-A: proxy-aware rate limit и API input validation.
11. R07-B: public admin/contact/upload hardening.
12. R08: GPS encrypted archive и safe retention.
13. R09-A: WORKER mobile/clock/profile UX.
14. R09-B: FOREMAN task list/navigation/filter UX.
15. R09-C: ADMIN task center/users/worker-card/mobile UX.
16. R10: release candidate, documentation и full pilot acceptance.
17. R11: Caddy preparation, DNS instruction и public login link.
18. R12: production-like rehearsal и rollback drill.
19. R13: owner checkpoint.
20. R14: production cutover.
21. R15: 24/72-hour observation и release closeout.

---

## 11. Первое задание агенту

Ниже приведён готовый текст задания. Его можно передать агенту без изменений.

> **Задача R00+R01 — Titanor Time release baseline, backup/storage foundation и restore-test**
>
> Работай в репозитории `titanor-time-foundation`. Сначала полностью прочитай всю документацию в `docs/titanor-time`; особое внимание удели:
>
> - `docs/titanor-time/PRODUCTION_RELEASE_TZ_FINAL_RU.md`;
> - `docs/titanor-time/PRODUCTION_RELEASE_ROADMAP_RU.md`;
> - `docs/titanor-time/T9_BACKUP_RESTORE_TEST_PLAN.md`;
> - существующие backup/restore документы и scripts.
>
> Также найди и полностью прочитай `AGENTS.md` и все применимые вложенные инструкции, если такие файлы существуют.
>
> Цель задачи: до любых production-изменений создать доказанную backup/restore foundation для Titanor Time и оформить release baseline.
>
> Обязательные ограничения:
>
> 1. Не изменяй production-БД, production containers, production scheduler, Caddy и Cloudflare DNS.
> 2. Не удаляй существующие backups, volumes, images или пользовательские данные.
> 3. Не выполняй dependency upgrades, profile/recovery/UI changes — это отдельные этапы.
> 4. Не печатай и не коммить secrets, database URLs, cookies, password hashes, raw tokens, документы работников или GPS coordinates.
> 5. Если worktree содержит чужие изменения, не трогай их; остановись и точно перечисли конфликтующие файлы.
>
> Сначала выполни read-only baseline:
>
> - Git branch/SHA/status;
> - pilot image tag/ID, web/scheduler container configuration;
> - migration status/count;
> - безопасные row counts ключевых pilot-таблиц;
> - uploads manifest: количество, общий размер и checksum/relative paths без раскрытия содержимого;
> - Node/npm/PostgreSQL/Docker/Compose versions;
> - размеры root disk, Docker storage, текущего backup path и `/mnt/250gb`.
>
> Отдельно исследуй `/mnt/250gb`. Нужно доказать фактический storage type, capacity/quota, free space, mount source, persistence, ownership/permissions, write/read ability и поведение при недоступности. Сейчас он наблюдался как S3/FUSE mount примерно на 4 GB, поэтому не считай его 250 GB только по имени. Не выполняй destructive speed test и не заполняй диск.
>
> Затем реализуй или приведи к production-ready виду backup foundation с учётом существующих conventions проекта:
>
> - PostgreSQL custom-format dump;
> - uploads archive;
> - atomic temp→final publication;
> - lock от overlapping jobs;
> - permissions не шире необходимого;
> - manifest с environment, UTC timestamp, Git SHA, image, migration list/count, row counts, sizes и SHA-256;
> - configuration manifest без secrets;
> - явный non-zero exit и безопасный error message при сбое;
> - безопасное уведомление о неуспешном backup без secrets;
> - rotation policy 7 daily / 4 weekly / 12 monthly и отдельные pre-deploy/pre-migration backups;
> - никакого удаления существующих backups в этой задаче.
>
> Выполни реальный pilot backup и restore-test в disposable PostgreSQL. При restore учти перенос между owners: используй безопасный эквивалент `pg_restore --no-owner --no-acl` и назначь целевого test owner. Проверь migration status, контрольные row counts, пользователей/роли, работников, объекты, назначения, timesheets, clock events/shifts, audit events и uploads. Если безопасно возможно, запусти краткую app/scheduler smoke-проверку восстановленной копии. После проверки удали только созданные тобой disposable resources.
>
> Permanent timer разрешено включить только для pilot и только если backup target действительно проверен. Если `/mnt/250gb` или другой target не подтверждён, не маскируй проблему локальным решением и не включай ложную автоматизацию. Вместо этого остановись на безопасном локальном test backup и дай владельцу точную инструкцию, что требуется исправить или предоставить.
>
> Обязательные результаты задачи:
>
> - отдельный baseline report;
> - backup/restore scripts и versioned service/timer definitions, если они нужны;
> - `BACKUP_RESTORE_RUNBOOK_RU.md` или аккуратное обновление существующего runbook;
> - backup manifest и SHA-256 evidence без secrets;
> - restore-test report с source/target, durations, counts и PASS/FAIL;
> - список файлов/конфигураций, созданных или изменённых;
> - команды проверки;
> - Git SHA/commit и точный итог: `PASS`, `BLOCKED BY STORAGE` или `FAIL`.
>
> Критерий PASS: backup создан, checksum совпадает, архив uploads читается, disposable restore завершён, миграции и counts совпадают, повторный запуск безопасен, production не изменён. Не переходи к профилям, зависимостям или production cutover в рамках этой задачи.

---

## 12. Следующее действие после первого задания

- При `PASS` выдать агенту R02: test contracts и CI gates.
- При `BLOCKED BY STORAGE` выполнить только указанное владельцу действие со storage и повторить R01.
- При `FAIL` не продолжать release roadmap, пока backup/restore не станет воспроизводимым.
