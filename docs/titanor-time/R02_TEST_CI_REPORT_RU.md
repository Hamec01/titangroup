# Titanor Time — R02: test contracts, команды и CI gates

- **Основание:** production release roadmap R02 (`PRODUCTION_RELEASE_ROADMAP_RU.md` §R02), ТЗ §18.
- **Дата:** 2026-08-29 … 2026-08-30.
- **Цель:** сделать каждое последующее изменение доказуемо безопасным — один воспроизводимый
  pipeline в чистом окружении.
- **Production не затронут:** менялись только `titanor-time-app/scripts/*`, `test-manifest.json`,
  один optional-параметр в `lib/attendance-overview.ts`, форматирование `schema.prisma`, `.gitignore`,
  `.github/workflows/ci.yml`, `ops/ci/`, docs. Ни БД, ни контейнеры, ни scheduler, ни Caddy, ни DNS.

---

## 1. Каталог тестов

`titanor-time-app/scripts/test-manifest.json` — машиночитаемый источник истины: каждый из 75
`scripts/_test-*.ts` отнесён ровно к одному lane. `npm run test:check-manifest` (и CI) падают на
любом расхождении с диском. Человекочитаемое зеркало — `docs/titanor-time/TEST_CATALOG_RU.md`.

| lane | тестов | в CI | описание |
|---|--:|:--:|---|
| `unit` | 11 | да | чистые функции / замоканные глобалы, без БД |
| `db` | 44 | да | прямой вызов route-handler'ов / lib; свежая БД на каждый тест |
| `scheduler` | 4 | да | как `db`, предмет — тик планировщика / horizon / auto-close |
| `browser` | 15 | **нет — R12** | нужен standalone-сервер (`TEST_BASE_URL`), обычно + Chromium |
| `manual` | 0 | — | — |
| `helper` | 1 | — | `_test-t9-fixtures.ts`, импортируется, сам не запускается |

## 2. Команды (документированные)

`titanor-time-app/package.json`:

| команда | что делает |
|---|---|
| `npm run typecheck` | `tsc --noEmit` по `tsconfig.json` — код приложения **и** `scripts/` |
| `npm run lint` | `prisma validate` + schema-format-clean + манифест в синхроне + smoke на секреты |
| `npm run test:unit` | lane `unit` |
| `npm run test:scheduler` | lane `scheduler` (нужна БД) |
| `npm run test:db` | lane `db` + `scheduler` (нужна БД) |
| `npm run test:browser` | lane `browser` — SKIPPED без `TEST_BASE_URL`, не падает |
| `npm run test` | `unit` + `db` + `scheduler` |
| `npm run test:catalog` / `test:check-manifest` | печать каталога / проверка дрейфа |

`build` собирает production standalone (`tsconfig.build.json`, `scripts/` исключён — они не
поставляются). Публичный сайт: `npm run build` + `npx tsc --noEmit` в корне.

## 3. Изоляция БД-тестов

`scripts/run-tests.mjs` для `db`/`scheduler`:

1. требует `TT_TEST_DB_URL` — одноразовый PostgreSQL 16; **отказывается** от URL, похожего на
   pilot/production (`pilot`, `prod`, `t97`, `titanor-time-db`, порт `55497`);
2. создаёт БД-шаблон, применяет к ней **все миграции с нуля** (`prisma migrate deploy`);
3. на каждый тест: `CREATE DATABASE … TEMPLATE <шаблон>` → запуск теста с изолированным
   `DATABASE_URL` и одноразовыми ключами шифрования → `DROP DATABASE`;
4. таймаут на тест (`TT_TEST_TIMEOUT_MS`, 240 с); чистит все свои БД на выходе.

Это устранило исторический класс дефектов «тесты видят строки друг друга» (накопление
`PayrollPeriod` → `PERIOD_OVERLAP` и т.п. в общей `t13-disposable-db`).

## 4. Исправленные тесты (контракт / детерминизм)

| тест | было | стало | коммит |
|---|---|---|---|
| `_test-checkin-never-blocked.ts` | `materializationState !== 'FAILED'` — значения `FAILED` в enum нет; единственная ошибка `tsc` (`TS2367`) | энрол работника в период + проверка реального контракта T17: смена вне геозоны **материализуется в часы** | `05cc4f5` |
| `_test-t9-role-matrix.ts` | искал англ. строку `Access denied` в HTML/DOM — падал при RU-локали | HTTP 200 (не redirect) + `<p class="login-error" role="alert">` + отсутствие `admin-nav`; API — по `error.code` | `5171c76` |
| `_test-timesheet-submission-schedules.ts` | утверждал, что первое назначение **не** энролит работника | действующий контракт: первое назначение авто-энролит на company-default (Weekly); счётчики overview 4→5, аудита 5→6 | `5f17310` |
| `_test-qualification-notification-thresholds.ts` | «дни до истечения» считались в UTC — матрица порогов ломалась при запуске в 21:00–24:00 UTC | привязка к календарю Europe/Helsinki (та же основа, что в коде) | `b13d9bd` |
| `_test-owner-today-dashboard.ts` | фикстуры «сегодня» на фиксированных часах Helsinki — в будущем при запуске вечером UTC | `buildOperationalOverview(…, asOf?)` (optional, default `new Date()`, 2 prod-вызова не тронуты); тест передаёт фиксированный `asOf` | `b13d9bd` |

Плюс `chore` `9648c78` — `prisma format` (только выравнивание; `git diff --ignore-all-space` пуст).

## 5. Реклассификация

`_test-csv-export.ts`, `_test-period-time-report.ts`, `_test-report-rounding-consistency.ts` делали
HTTP-запросы к работающему серверу (`fetch` к `TEST_BASE_URL`), но лежали как `db` → `ECONNREFUSED`.
Перенесены в `browser` (HTTP-only, без Chromium). `_test-foreman-admin-redirect.ts` аналогично —
`buildFixture` требует сервер.

## 6. CI

`.github/workflows/ci.yml` — на каждый push/PR. Пять параллельных job + `ci-summary` (единственный
required-check, падает если упал любой):

| job | шаги |
|---|---|
| `titanor-time-quality` | `npm ci` → lockfile в синхроне → `prisma generate` + `validate` → `typecheck` → `lint` → манифест → `build` |
| `titanor-time-tests` | postgres:16 service → `npm ci` → `prisma generate` → `test:unit` → `test:db` (свежий клон на тест) |
| `titanor-time-migrations` | postgres:16 service → `prisma migrate deploy` с нуля → `migrate status` = «up to date» |
| `public-site-quality` | `npm ci` → lockfile → `prisma generate` → `tsc --noEmit` → `build` |
| `security` | `ops/ci/secret-scan.sh` (blocking) → lockfile'ы tracked → `npm audit` обоих (отчёт-артефакт, без auto-fix) |

`ops/ci/secret-scan.sh` — без внешних инструментов: grep по `git ls-files` (private keys, cloud
keys, JWT, service-URL с паролем на не-localhost хосте, хардкод наших ключей шифрования).
729 tracked-файлов — чисто.

**Не в CI (документировано, не «тихо пропущено»):**
- lane `browser` (15) — нужен собранный сервер + Chromium; прогон на R12 (ТЗ §18.2 п.10, §19);
- restored-pilot migration test — нужен pilot-бэкап; прогон через
  `ops/titanor-time/restore-test-titanor-time.sh` на репетиции R14;
- полноценный ESLint — Next 16 удалил `next lint`, в репо нет конфигурации; отдельная задача
  (кандидат в R07). `lint` покрывает практические регрессии схемы/типов/секретов.

## 7. Локальный прогон на чистом окружении (доказательство)

Одноразовый `postgres:16` (`127.0.0.1:55440`), `titanor-time-app`:

| гейт | результат |
|---|---|
| `npm run typecheck` | **0 ошибок** (была 1 — `TS2367`) |
| `npm run lint` | **все проверки пройдены** |
| `npm run test:check-manifest` | OK — 75 записей, все 75 файлов учтены |
| `npm run test:unit` | **11 / 11** |
| `npm run test:scheduler` | **4 / 4** |
| `npm run test:db` (db + scheduler) | **48 / 48** |
| `npm run build` (titanor-time-app) | **✓ Compiled successfully** (32 s), 11/11 static pages, 0 type-ошибок |
| `npm run test:browser` | 15 тестов — SKIPPED (нет `TEST_BASE_URL`); прогон R12 |

Публичный сайт: локальный worktree имеет root-owned частичный `node_modules` (не
`deploy`-записываемый) → `typecheck`/`build` публичного сайта проверяются только в CI (чистый
`npm ci`).

## 8. Вердикт

- **PASS-критерий roadmap:** «один документированный pipeline воспроизводимо проходит в clean
  environment; skipped tests перечислены с причиной» — выполнено (§6, §7).
- Зелёный статус достигнут **исправлением** тестов под действующий контракт и **изоляцией** БД,
  а не исключением проверок. Пропуски (browser, restored-pilot, ESLint) перечислены с причиной и
  привязкой к будущему этапу.

## 9. Открытые пункты (переданы дальше)

1. Прогнать lane `browser` (15) на R12 — нужен `next build` + `server.js` + `npx playwright install chromium`.
2. `restore-test-titanor-time.sh` migration-часть — в репетицию R14.
3. Полноценный ESLint flat-config — R07.
4. `lib/employee-files.ts` пишет в `process.cwd()/uploads` без env-override — вынести путь в
   конфиг на R06 (Docker/operations).
5. `npm audit`: 8 high в обоих приложениях (baseline R00 §8) — устранение в R04 (сайт) / R05 (Time).
