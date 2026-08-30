# R06-B — Docker / runtime optimization

- **Основание:** production release roadmap R06 (часть B), ТЗ §17. Закрывает блокер B12.
- **Дата:** 2026-08-30.
- **Не затронуто:** production (`titanor-time-app-1` / `titanor-time-scheduler-1` / `titanor-time-db-1`,
  image `daa2edbb`, `StartedAt 2026-08-21T19:40:56Z`, `RestartCount 0` — до и после идентично),
  live public site, Caddy, Cloudflare DNS. Бизнес-логика, схема БД, permissions, UI не менялись.
- **Commit:** `256565a` (Dockerfile + бандлы + compose + lint gate). Git SHA кандидата: `256565a`.
- **Кандидат образа:** `titanor-time-app:t97-pilot-256565a`
  `sha256:5db16a265ffb1c8cd002450897c9cf36f56441f01f6b5ba2d9ebe55db57333ff` — **792 MB**
  (было 1.79 GB), unique layers **455 MB** (было 1.45 GB).
- **Статус деплоя:** владелец запустил `deploy-256565a.sh` 2026-08-30 ~12:52. Swap прошёл, но
  scheduler завис в `OVERLAPPING` (см. **§R06-B.1** ниже — orphaned `SchedulerLease` от старого
  `npx tsx` scheduler'а, убитого SIGKILL). Исправлено точечно + deploy-скрипт усилен. **Пилот
  сейчас на `t97-pilot-256565a`, оба контейнера `healthy`, scheduler `HEALTHY`.**

---

## 1. Baseline (образ `t97-pilot-d15586c`, зафиксирован до работ)

| | значение |
|---|---|
| image id | `sha256:f34b7684a82d…` |
| размер / unique | **1.79 GB** / 1.45 GB (shared base 336.8 MB) |
| deps stage | `npm install` (без строгого lockfile) |
| runner `node_modules` | **полный dev `node_modules` (~884 MB)** — `typescript`, `tsx`, `playwright`, `esbuild`, `@types/*`, `fake-indexeddb`, `prisma` CLI + весь query/schema-engine набор |
| web command | `node server.js` |
| scheduler command | `sh -c 'npx tsx scripts/attendance-auto-submit-scheduler.ts'` (нужен `tsx` в runtime) |
| scheduler healthcheck | `npx tsx scripts/attendance-scheduler-healthcheck.ts` |
| migrate deploy | `node_modules/.bin/prisma migrate deploy` (из dev `node_modules`) |
| OCI labels | **нет** |
| UID/GID | `node` 1000:1000, `USER node` — уже non-root |
| uploads | Dockerfile создавал `/app/public/uploads`, а pilot/compose bind — `/app/uploads` (рассинхрон) |
| `docker history` крупные слои | dev `node_modules` COPY **927 MB**, `.next/standalone` 183 MB, node base 154 MB, debian base 85 MB |

---

## 2. Что сделано

### 2.1. Один образ, три способа запуска — но одна и та же неизменяемая ФС

| роль | команда | нужен `tsx`/`npx`/сеть? |
|---|---|---|
| web | `node server.js` (CMD образа) | нет |
| scheduler | `node .runtime/attendance-auto-submit-scheduler.cjs` | нет |
| healthcheck | `node .runtime/attendance-scheduler-healthcheck.cjs` | нет |
| migrate | `node .prisma-tools/node_modules/prisma/build/index.js migrate deploy` | нет |
| emergency | `node .runtime/bootstrap-super-admin.cjs` / `.runtime/reset-password.cjs` / `.runtime/attendance-auto-submit-tick.cjs` | нет |

Web и scheduler — **один digest**, отличаются только `command`.

### 2.2. Web runtime — Next.js standalone

Runner больше **не копирует** dev `node_modules`. Web-сервер работает из `.next/standalone`
(собственный trace-набор `node_modules`: next runtime, react/react-dom, `@prisma/client` +
сгенерированный клиент + нативный query-engine через `outputFileTracingIncludes`, `argon2`,
`sharp`, `pdfkit`+`fontkit` инлайнятся в server-чанки вместе с виртуальной ФС для `*.afm`).

### 2.3. Scheduler и operational CLI — прекомпилированные CJS-бандлы

`scripts/build-runtime-scripts.mjs` (esbuild, запускается один раз в builder-стадии после
`next build`) собирает 5 входных TS-скриптов в самодостаточные `.runtime/*.cjs`:

| бандл | размер | что внутри |
|---|--:|---|
| `attendance-auto-submit-scheduler.cjs` | 88 kB | весь граф `../lib/**` scheduler'а inline |
| `attendance-auto-submit-tick.cjs` | 24 kB | one-shot tick |
| `bootstrap-super-admin.cjs` | 9 kB | аварийное создание SUPER_ADMIN |
| `reset-password.cjs` | 7 kB | аварийный сброс пароля |
| `attendance-scheduler-healthcheck.cjs` | 5 kB | R06-A state machine, без БД |

External (единственное, что остаётся реальными файлами на диске): `@prisma/client`,
`argon2`, `sharp` (нативные / генерируемые) + `node:*`. Бандлер падает, если что-то ещё
уходит в external — это ловит регрессию «в граф scheduler'а затащили browser/Next-модуль».
Тот же чек добавлен в `npm run lint` (шаг «runtime script bundles compile»).

`scripts/` (со всеми `_test-*.ts`), сырые `lib/`, `tsconfig.json` в runner **не копируются**.

### 2.4. `prisma migrate deploy` — минимальное CLI-замыкание

`scripts/assemble-prisma-tools.mjs` (builder-стадия) обходит `dependencies` пакета `prisma` от
lockfile-точной установки `npm ci` и складывает замыкание в `.prisma-tools/node_modules/`
(33 пакета), удаляя лишние engine-бинарники не под текущую платформу (bookworm = OpenSSL 3.x;
в сборке отсеклись 2 файла `*openssl-1.1.x*`). `prisma/` (схема + 96 migration SQL) **запечена**
в образ. Отдельный migrator-образ **отклонён** ради одного артефакта / одного digest и
простейшего release + recovery flow (ТЗ §17 «web и scheduler — один immutable image»; отдельный
tooling-слой ТЗ допускает, но здесь он не нужен).

Точный release-flow миграций (в deploy-скрипте, шаг 3):

```bash
docker run --rm --network t97-pilot-net --env-file <env> -w /app --entrypoint node \
  titanor-time-app:t97-pilot-256565a \
  .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
# затем migrate status -> «96 migrations found» + «Database schema is up to date!»
```

### 2.5. `npm ci` строго из lockfile

deps-стадия: `COPY package.json package-lock.json ./` (без `*`-glob — lockfile обязателен) →
`RUN npm ci` (падает при рассинхроне `package.json` ↔ lockfile).

### 2.6. OCI labels + digest (ТЗ §17 «Git SHA, не только latest»)

`ARG GIT_SHA / GIT_REF / BUILD_TIME` → `LABEL org.opencontainers.image.{revision,ref.name,created,
title,description,source}` + `ENV GIT_SHA`. Проверено на кандидате:
`revision=256565a`, `created=2026-08-30T12:15:04Z`. Digest записан выше.

### 2.7. uploads

Runner создаёт и `chown node:node` **`/app/uploads`** (реальная точка bind-mount pilot и
compose — `path.join(process.cwd(), 'uploads', 'employees')` в `lib/employee-files.ts`).
Рассинхрон с `/app/public/uploads` устранён.

### 2.8. compose.titanor-time.yaml — healthchecks

- **app healthcheck УЖЕ был** (добавлен в эпоху T7A: `node -e fetch('/api/ready') && ok`) —
  R06-B его не дублирует. Расхождение с R06A-отчётом §8 («healthcheck только у scheduler»)
  снято: отчёт был неточен, healthcheck app присутствует и корректен (`/api/ready` → 200/503).
- **scheduler healthcheck + command** переведены на прекомпилированный бандл
  (`node .runtime/…cjs`), `start_period` 30s → 90s (совпадает с `startupGraceSeconds` R06-A,
  чтобы `STARTING` не считался unhealthy в grace-окне).
- Комментарии к сервису `scheduler` обновлены (lease вместо «вторая реплика безопасна по
  T7A.10A»).

> compose-файл и образ консистентны **внутри коммита `256565a`**: `command` ссылается на
> `.runtime/*.cjs`, которые есть только в новом образе. Менять их надо вместе (production —
> при cutover R14; pilot — deploy-скриптом ниже). `:latest` не пересобирался.

---

## 3. `docker history` кандидата и объяснение крупных слоёв (ТЗ §17, пункт 15)

| слой | размер | объяснение |
|---|--:|---|
| debian bookworm base | 85.3 MB | rootfs ОС — **shared** со всеми `node:22-bookworm-slim` на хосте |
| node 22.23.2 | 154 MB | Node.js + npm — **shared** |
| yarn | 7.3 MB | идёт в base image — shared |
| openssl (apt) | 7.4 MB | version-detection Prisma engine (иначе шумный warning) |
| **`.next/standalone`** | **183 MB** | web-сервер + trace-`node_modules`: `sharp`/`@img` ~45 MB (нативный libvips для `next/image`), `next` runtime ~18 MB, `@prisma/client` + генер. клиент + нативный query-engine ~17 MB, react/react-dom, `pdfkit`+`fontkit` (в чанках), qrcode |
| **`.prisma-tools`** | **156 MB** | CLI-замыкание для `migrate deploy/status/resolve`: `prisma` 67 MB (bundled CLI + engine), `@prisma/engines` schema-engine ~19 MB, **`effect` 34 MB** (жёсткая транзитивная зависимость `@prisma/config`, грузится eager), остальные 31 пакет ~35 MB |
| `.next/static` | 2.9 MB | клиентские ассеты |
| `assets` | 1.6 MB | DejaVu Sans TTF (Regular+Bold) + brand PNG — грузятся по пути в момент запроса |
| `prisma` | 1.1 MB | schema + 96 migration SQL |
| `.runtime` | 0.19 MB | 5 CJS-бандлов |
| `public`, uploads mkdir | 0.13 MB | статика + точка mount |

**Два крупнейших не-base слоя:**
1. `.next/standalone` 183 MB — несокращаемо без потери функций; крупнейший кусок `sharp`/`@img`
   45 MB нужен `next/image` (менять = менять поведение UI → вне R06-B).
2. `.prisma-tools` 156 MB — цена in-image `prisma migrate deploy` + аварийного `migrate resolve`.
   `effect` 34 MB — жёсткая зависимость `@prisma/config`, которую CLI требует eager (проверено:
   удаление `@prisma/config`/`effect` ломает `migrate deploy`). Не режется без хаков.

Итог: **1.79 GB → 792 MB (−56%)**, unique **1.45 GB → 455 MB (−69%)**.

---

## 4. Verification — одноразовый стек (ТЗ §17, пункт 13)

Всё на выброшенном PostgreSQL 16 + выброшенной сети (до деплоя). Production и pilot контейнеры/БД
на этом этапе не трогались. Реальный pilot-деплой + его исправление — § R06-B.1.

| проверка | результат |
|---|---|
| `npm ci` из lockfile | ✅ (deps-стадия сборки) |
| `prisma migrate deploy` с нуля | ✅ 96 миграций применено |
| идемпотентный повтор + `migrate status` | ✅ «No pending migrations» · «Database schema is up to date!» · applied = 96 |
| «restored pilot» статус (96 → 96) | ✅ `migrate deploy` = no-op, `migrate status` = up to date (R06-B миграций не добавляет) |
| web `/api/ready` | ✅ 200 `{status:ready, schema:current, migrations:{applied:96,expected:96,aheadBy:0}}` |
| web `/api/health` `/login` `/reset-password` | ✅ 200 / 200 / 200 |
| Docker healthcheck (app) | ✅ `healthy` |
| scheduler heartbeat | ✅ format 2, `lastOutcome:ok`, свежий |
| scheduler tick (все 5 задач) | ✅ `attendance_auto_submit` / `abandoned_shift` / `location_retention` / `period_generation` — все `outcome:ok` |
| scheduler startup schema check | ✅ `schema_check outcome:ok schema:current` |
| SchedulerLease (single-writer) | ✅ строка есть, acquired + renewed |
| scheduler healthcheck | ✅ `scheduler-health: HEALTHY` exit 0 |
| graceful stop (`docker stop -t 30`) | ✅ SIGTERM → доработал итерацию → `releaseLease` (0 строк) → `attendance_scheduler_stopped` → exit 0 |
| restart recovery | ✅ снова `HEALTHY`, tick'и продолжились |
| web graceful restart | ✅ `healthy`, `/api/ready` 200 |
| uploads read/write как uid/gid 1000 через bind-mount | ✅ контейнер (`node` 1000:1000) пишет `uploads/employees/…`, хост (`deploy`, uid 1000) читает |
| PDF/report assets | ✅ `DejaVuSans.ttf` / `DejaVuSans-Bold.ttf` / `titanor-group.png` присутствуют, читаемы |
| **PDF export end-to-end** (авторизованный HTTP, SUPER_ADMIN сессия) | ✅ **customer-hours** 200 `%PDF-1.3` 91 KB (`%%EOF`, **встроенный DejaVu FontFile2**, brand PNG XObject); **custom-report summary/detailed** 200 `%PDF`; **workforce-matrix** 200 `%PDF` |
| emergency CLI (`bootstrap-super-admin.cjs` / `reset-password.cjs`) | ✅ бандл грузится, парсит аргументы, включает TTY-guard (интерактивный ввод пароля требует настоящий TTY — по дизайну; в headless-харнессе не прогонялся до конца, но граф `lib/prisma`+`@prisma/client`+`argon2` общий с полностью проверенным scheduler'ом) |
| dev/test пакеты в runner | ✅ **нет** `typescript` / `tsx` / `playwright*` / `esbuild` / `@esbuild` / `fake-indexeddb` / `@types/*` (ни в `node_modules`, ни в `.prisma-tools`) |
| secrets / `.env*` / `.git` в образе | ✅ нет |

## 5. Regression / CI (ТЗ §17, пункт 14)

| gate | результат |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | 0 ошибок |
| `npm run lint` (+ новый шаг «runtime script bundles compile») | все проверки прошли |
| `npm run test:unit` | **12 / 12** |
| `npm run test:db` | **54 / 54** (вкл. `_test-worker-dossier-pdf`, `_test-custom-report-pdf-csv`, `_test-customer-hours`, `_test-workforce-matrix`) |
| `npm run test:scheduler` | **5 / 5** (вкл. `_test-scheduler-diagnostics`) |
| `npm run test:check-manifest` | OK — 82 записи |
| `npm run build` (в Docker builder) | ✅ Next 16.3.3, 19/19 страниц |

CI (`.github/workflows/ci.yml`, run `33311501796` на `d810a9d`): **6/6 job success** —
`security` · `public-site-quality` · `titanor-time-quality` (npm ci + lockfile + typecheck +
lint + build) · `titanor-time-tests` (unit + db + scheduler) · `titanor-time-migrations`
(migrate deploy с нуля) · `ci-summary` (required).

## 6. Кандидат + deploy script (ТЗ §17, пункт 16)

- Образ: `titanor-time-app:t97-pilot-256565a` (digest в шапке).
- Скрипт: **`/home/deploy/app-data/t97-pilot/deploy-256565a.sh`** (канонический источник в репо —
  `ops/titanor-time/deploy-pilot-256565a.sh`, копии байт-в-байт). Усилен после инцидента R06-B.1
  (§ ниже). Кратко:
  0. **flock + state guard** — второй запуск = no-op (если оба контейнера уже на образе) или
     жёсткий отказ (если остались `-pre-256565a` rollback-контейнеры от прошлой попытки; их
     скрипт **никогда не удаляет**) или отказ при half-swapped состоянии;
  1. кандидат присутствует и `revision`-label == `256565a`;
  2. preflight (env, `DATABASE_URL`, R03-secret, сеть, БД healthy, app отвечает на `:3297`);
  3. **production baseline guard** — фиксирует и в конце сверяет `titanor-time-app-1`
     image/StartedAt/RestartCount + `titanor-time-scheduler-1` StartedAt + `:latest` id;
     расхождение → `exit 2`;
  4. **обязательный pre-deploy backup** (fail-closed: проверяется наличие `SHA256SUMS`);
  5. `migrate deploy` через запечённый `.prisma-tools` + `migrate status` **assert** «up to date»
     + `psql` **assert** applied == 96, failed == 0;
  6. **swap с автоматическим rollback** при любой ошибке: пересоздание `t97-pilot-app`
     (`--init`, `node server.js`) и `t97-pilot-scheduler` (`--init`,
     `node .runtime/attendance-auto-submit-scheduler.cjs`); **обработка stale-lease** — если после
     graceful-stop старого scheduler'а `SchedulerLease` держит именно его hostname, а контейнер
     доказанно мёртв (`Running=false`, `Pid=0`, ни один живой контейнер не носит этот hostname) →
     точечный `DELETE ... WHERE name='attendance-scheduler' AND holderId='<точное значение>'`;
  7. **fail-closed verify** (любой сбой → rollback → `exit 1`): app Docker health `healthy`;
     `/api/ready` == 200 **и тело** `status=ready` + `schema=current` + `applied=expected=96`;
     `/api/health` == 200; `/login` `/reset-password` не 5xx; PDF-ассеты в образе; scheduler —
     lease захвачен **и активно renew'ится новым** holder'ом, heartbeat `lastOutcome=ok` +
     `consecutiveFailures=0`, healthcheck **реальный exit 0** (без `; echo`), Docker health
     `healthy`, все 4 фоновые операции в логах с момента старта, нет `SCHEDULER_LEASE_HELD_BY_ANOTHER`;
  8. повторная проверка production baseline.
- **Скрипт агентом повторно не запускается.** Старые образы и rollback-контейнеры не удаляются.

## 7. Точная команда владельцу

Пилот уже на `t97-pilot-256565a` (владелец запустил скрипт, инцидент R06-B.1 устранён вручную).
Повторно запускать `deploy-256565a.sh` **не нужно** — усиленный скрипт при повторе откажет
(остались `-pre-256565a` rollback-контейнеры). Когда решите, что откат больше не нужен:

```bash
docker rm -f t97-pilot-app-pre-256565a t97-pilot-scheduler-pre-256565a
```

(до тех пор они — точка отката на `t97-pilot-d15586c`). Рекомендованная проверка: скачать один
Customer-hours / Custom-report PDF из пилота и открыть.

## R06-B.1 — инцидент при первом деплое и его устранение

**Что произошло.** Владелец запустил `deploy-256565a.sh` (первая версия). Swap `t97-pilot-app`
прошёл штатно (`healthy`, `/api/ready` 200 `schema:current` 96/96). Новый scheduler-контейнер
`dc350bb4522a` поднялся, но каждый tick писал `SCHEDULER_LEASE_HELD_BY_ANOTHER` → состояние
`OVERLAPPING`, healthcheck exit 1, `unhealthy`, фоновые операции не выполнялись.

**Корневая причина.** Старый scheduler (`t97-pilot-d15586c`) запускался как
`sh -c 'npx tsx scripts/attendance-auto-submit-scheduler.ts'` **без `--init`**. При `docker stop`
SIGTERM уходит в PID 1 = `npx`, который **не пробрасывает сигнал** дочернему `node` → через 30 с
SIGKILL (`exit 137`) → обработчик `SIGTERM` в коде scheduler'а (доработать итерацию →
`releaseLease` → `$disconnect` → exit 0) **не сработал** → строка `SchedulerLease`
(`holderId=a445c42af404:31:d57e3c03`, `renewedAt=12:51:56`) осталась «живой». Новый scheduler
видит `renewedAt` моложе TTL (90 мин) → корректно уступает (`held_by_another`) и ушёл бы в
`OVERLAPPING` **на весь час** до истечения TTL. Это ровно тот класс хрупкости, который R06-B
устраняет для будущих деплоев (новый scheduler = `node` как PID 1 + `--init`, SIGTERM
обрабатывается — проверено: `docker stop -t 30` → exit 0, lease released), но **переход** со
старого `npx tsx`-scheduler'а этим не защищён.

**Устранение (точечное, read-only проверка → один targeted DELETE).**
1. Доказано read-only: `holderId` начинается с `a445c42af404` = hostname контейнера
   `t97-pilot-scheduler-pre-256565a` (`Id a445c42af4049aa9…`), который `exited`, `ExitCode 137`,
   `Running=false`, `Pid=0`; ни один другой контейнер не носит этот hostname; в
   `pg_stat_activity` нет соединений от старого scheduler'а (только app-pool `172.22.0.3` и
   новый scheduler `172.22.0.4`).
2. `DELETE FROM "SchedulerLease" WHERE "name"='attendance-scheduler' AND "holderId"='a445c42af404:31:d57e3c03' RETURNING …` → `DELETE 1` (та же targeted-форма, что и `releaseLease` в `lib/scheduler-lease.ts:55`).
3. Следующий tick нового scheduler'а (`INSERT … ON CONFLICT`) — строки нет → `acquired`.

**Итог (подтверждено, стабильно > 15 мин).** Lease держит и **renew'ит каждые 60 с**
`dc350bb4522a:1:e4dae363` (новый scheduler); `heartbeat.lastOutcome=ok`,
`consecutiveFailures=0`; healthcheck `HEALTHY` exit 0; контейнер `healthy`; 4+ подряд `ok`
tick'а; все фоновые операции (`attendance_auto_submit_tick`, `abandoned_shift_auto_close`,
`attendance_location_retention`, `timesheet_period_generation`) выполнились;
`t97-pilot-app` `healthy`, `/api/ready` 200 ready 96/96; production baseline не изменён
(`daa2edbb`, `StartedAt 2026-08-21`, restarts 0). Rollback-контейнеры `-pre-256565a` сохранены.

**Усиление deploy-скрипта** — см. § 6 (пункты 0, 5, 6, 7). Ключевое: детект+точечная чистка
stale-lease при переходе, fail-closed проверки, проверка тела `/api/ready`, реальный exit
healthcheck, Docker health обоих контейнеров, свежесть heartbeat/lease, flock + re-run guard,
автоматический rollback после неудачного swap, `--init` для обоих контейнеров.

## 8. Открытые пункты

- Полный smoke защищённого Vercel Preview публичного сайта — R10/R12 (не блокирует).
- Прод-БД 42 миграции (B07) — замена на pilot целиком в R14. При R14-cutover прод-scheduler'а
  (`sh -c npx tsx`, старый образ) действует та же stale-lease логика — R14-runbook должен её
  учесть (либо остановить старый scheduler заранее и дождаться `releaseLease`, либо targeted
  DELETE по доказанно мёртвому holder'у).
- `.next/standalone` `sharp`/`@img` 45 MB — сокращаемо только отключением оптимизации
  `next/image` (изменение поведения UI) → вне R06-B.
- Дальнейшее ужатие `.prisma-tools` (`effect` 34 MB) — только через отдельный migrator-образ;
  сознательно не сделано (один артефакт / один digest).
