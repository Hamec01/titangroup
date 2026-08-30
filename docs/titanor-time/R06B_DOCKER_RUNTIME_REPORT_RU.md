# R06-B — Docker / runtime optimization

- **Основание:** production release roadmap R06 (часть B), ТЗ §17. Закрывает блокер B12.
- **Дата:** 2026-08-30.
- **Не затронуто:** production (`titanor-time-app-1` / `titanor-time-scheduler-1` / `titanor-time-db-1`,
  image `daa2edbb`, `StartedAt 2026-08-21T19:40:56Z`, `RestartCount 0` — до и после идентично),
  live public site, Caddy, Cloudflare DNS. Pilot deploy **не выполнялся** — образ и скрипт
  подготовлены, остановка перед R07. Бизнес-логика, схема БД, permissions, UI не менялись.
- **Commit:** `256565a` (Dockerfile + бандлы + compose + lint gate). Git SHA кандидата: `256565a`.
- **Кандидат образа:** `titanor-time-app:t97-pilot-256565a`
  `sha256:5db16a265ffb1c8cd002450897c9cf36f56441f01f6b5ba2d9ebe55db57333ff` — **792 MB**
  (было 1.79 GB), unique layers **455 MB** (было 1.45 GB).

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

Всё на выброшенном PostgreSQL 16 + выброшенной сети. Production и pilot контейнеры/БД не
трогались.

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

CI (`.github/workflows/ci.yml`) на коммите `256565a`: **_будет заполнено после push_** —
джобы `titanor-time-quality` (npm ci + lockfile + typecheck + lint + build) и
`titanor-time-tests` / `titanor-time-migrations` покрывают всё вышеперечисленное.

## 6. Кандидат + deploy script (ТЗ §17, пункт 16)

- Образ: `titanor-time-app:t97-pilot-256565a` (digest в шапке).
- Скрипт: **`/home/deploy/app-data/t97-pilot/deploy-256565a.sh`**
  1. проверка наличия + labels кандидата;
  2. **production baseline guard** — фиксирует и в конце сверяет `titanor-time-app-1`
     image / StartedAt / RestartCount + `:latest` id; любое расхождение → `exit 2`;
  3. **обязательный pre-deploy backup** (`ops/titanor-time/backup-titanor-time.sh pre-deploy`);
  4. `migrate deploy` через запечённый `.prisma-tools` (ожидается no-op) + `migrate status` = 96 / up to date;
  5. пересоздание `t97-pilot-app` (тот же `node server.js`, `-p 127.0.0.1:3297:3000`,
     `-v …/uploads:/app/uploads`, `--health-cmd`) — rollback-контейнер `t97-pilot-app-pre-256565a`;
  6. пересоздание `t97-pilot-scheduler` с **graceful stop** и новой командой
     `node .runtime/attendance-auto-submit-scheduler.cjs` + `--health-cmd
     'node .runtime/attendance-scheduler-healthcheck.cjs'` — rollback-контейнер
     `t97-pilot-scheduler-pre-256565a`;
  7. verify: HTTP (`/api/ready` 200 `schema:current`, `/api/health` `/login` `/reset-password`,
     внешний `/login`), PDF-ассеты, scheduler heartbeat + healthcheck exit 0 + `ok` tick,
     SchedulerLease (один holder), container health, DB counters;
  8. повторная проверка production baseline;
  9. печать rollback-инструкции (назад к `t97-pilot-d15586c`; `-pre-256565a` контейнеры
     сохраняют старый образ и старые команды).
- **Скрипт агентом не запускается.** Старые образы и rollback-контейнеры не удаляются.

## 7. Точная команда владельцу

```bash
bash /home/deploy/app-data/t97-pilot/deploy-256565a.sh
```

Схема БД не меняется (96 → 96). Скрипт: guard + backup → `migrate deploy` (no-op) → swap
`t97-pilot-app` и `t97-pilot-scheduler` на `t97-pilot-256565a` → verify → сверка prod baseline
→ rollback-инструкция. Рекомендованная ручная проверка после деплоя: скачать один
Customer-hours / Custom-report PDF из пилота и открыть. Пришлите вывод — сверю.

## 8. Открытые пункты

- Полный smoke защищённого Vercel Preview публичного сайта — R10/R12 (не блокирует).
- Прод-БД 42 миграции (B07) — замена на pilot целиком в R14.
- `.next/standalone` `sharp`/`@img` 45 MB — сокращаемо только отключением оптимизации
  `next/image` (изменение поведения UI) → вне R06-B.
- Дальнейшее ужатие `.prisma-tools` (`effect` 34 MB) — только через отдельный migrator-образ;
  сознательно не сделано (один артефакт / один digest).
