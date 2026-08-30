# R06-A — schema-aware readiness и scheduler diagnostics

- **Основание:** production release roadmap R06 (часть A), ТЗ §11. Продвигает блокер B07.
- **Дата:** 2026-08-30.
- **Не затронуто:** production (`titanor-time-app-1` / `titanor-time-scheduler-1` / `titanor-time-db-1`),
  live public site, Caddy, Cloudflare DNS, старый production scheduler. R06-B (Docker-оптимизация) и
  R07 не начаты. Pilot deploy **не выполнялся** — образ и скрипт подготовлены, остановка перед R06-B.
- **Commits:** `8414d5f` (schema-aware `/api/ready`), `b9ce061` (scheduler diagnostics), + этот отчёт.
  Git SHA кандидата: `d15586c`. Образ `titanor-time-app:t97-pilot-d15586c`.

---

## 1. Baseline (зафиксирован до работ)

| | Production | Pilot |
|---|---|---|
| app image | `titanor-time-app:latest` = `sha256:daa2edbb…` | `t97-pilot-1e4dc92` |
| scheduler image | то же | то же |
| DB миграции (finished) | **42** (`20260805171000_seed_worker_activation_permission`) | **95** (`20260830100000_…`) |
| DB unfinished/rolled-back | 0 | 0 |
| `/api/ready` (старый) | **200 `ready`** ← ложно | 200 `ready` |
| `/api/health` | 200 | 200 |
| scheduler Docker health | `unhealthy` | нет healthcheck (manual `docker run`) |
| scheduler tick'и | **все падают** (`SCHEDULER_TICK_TOP_LEVEL_ERROR`, `PERIOD_GENERATION_TOP_LEVEL_ERROR`) | `ok` (`scanned:8, failed:0`), heartbeat свежий |

**Прод — это живой B07:** код `daa2edbb` собран под схему ~85+ миграций, БД на 42 → каждый tick
падает, но старый `/api/ready` отдаёт `200`. Именно это R06-A закрывает на уровне проверок.

## 2. `/api/ready` — schema-aware (`8414d5f`)

`200` только когда образ реально может работать с подключённой БД:

1. БД доступна (`SELECT 1`);
2. нет незавершённых / откаченных миграций;
3. **каждая** миграция, которую ждёт образ, применена — строгая проверка **множества имён**
   каталогов (`lib/generated/migration-inventory.ts`, генератор + CI-drift-gate), **не** «count == N»;
4. все ключевые таблицы на месте.

Любая несовместимость → **503** с фиксированным `reason`: `DB_UNAVAILABLE`,
`MIGRATIONS_TABLE_MISSING`, `MIGRATIONS_FAILED`, `SCHEMA_BEHIND`, `KEY_TABLE_MISSING`.
`schema: "ahead"` (в БД лишние аддитивные миграции — mid-rollout) остаётся `200`.

**Sanitization:** тело содержит только `status`/`reason` (enum), имена миграций и таблиц (уже
публичны в репо), счётчики. Никогда — пойманную ошибку, SQL, connection string, credentials,
строки. Проверено тестом (`assertSanitized`: whitelist ключей + regex-запрет
`stack|postgres://|SELECT|password|host:port|PrismaClient`).

## 3. Scheduler diagnostics (`b9ce061`)

### 3.1. Классификация ошибок tick'а
`lib/db-error-classification.ts` → `db_unavailable` | `schema_incompatible` | `other`
(Prisma `P1000/1001/1002/1008/1017` → unavailable; `P2021/2022/2023` + фразы
`relation/column/type "…" does not exist` → schema; остальное → other). Никогда не эхо ошибки.
`runOneTickCore` возвращает класс; scheduler пишет его в heartbeat.

### 3.2. Обогащённый heartbeat (format 2)
`pid`, `processStartedAt`, `lastTickAt`, `lastTickCompletedAt` (совместимость),
`lastOutcome`, `lastErrorCode`, `consecutiveFailures`, `lastOverlapAt`. Старый format-1
читается degraded (не слепнет на 1 интервал при rolling deploy).

### 3.3. Матрица состояний (healthcheck)

| STATE | healthy | триггер |
|---|:--:|---|
| `HEALTHY` | ✅ | свежий `ok` tick |
| `STARTING` | ✅ | процесс < 90 c, tick'а ещё нет |
| `HEARTBEAT_MISSING` | ❌ | нет файла, grace истёк |
| `HEARTBEAT_STALE` | ❌ | `ok` tick, но > 3× интервала (мин 120 c) |
| `PROCESS_STOPPED` | ❌ | pid из heartbeat не жив (`process.kill(pid,0)`) |
| `DB_UNAVAILABLE` | ❌ | `lastOutcome = db_unavailable` |
| `SCHEMA_INCOMPATIBLE` | ❌ | `lastOutcome = schema_incompatible` |
| `TICK_FAILING` | ❌ | `lastOutcome = tick_error` и `consecutiveFailures ≥ 3` |
| `OVERLAPPING` | ❌ | недавний `lastOverlapAt`, без успешного tick'а после |

Healthcheck по-прежнему **без подключения к БД**, exit 0/1, печатает STATE.

### 3.4. Overlapping ticks
`SchedulerLease` (миграция `20260830120000`) — leased single-writer lock (не session advisory —
Prisma pooling). Второй scheduler-контейнер получает `held_by_another` → пишет `lastOverlapAt` и
**пропускает** работу итерации (никаких двойных tick'ов). Graceful shutdown делает `releaseLease`.
TTL 90 мин (> max интервала 3600 c) — медленный-но-здоровый tick не теряет свой lease.

### 3.5. Startup schema check
Scheduler на старте зовёт `checkSchemaReadiness()`; несовместимость сразу пишется в heartbeat
(`SCHEDULER_STARTUP_<reason>`) — быстрый сигнал, не ждём падения первого tick'а. Не фатально.

## 4. Проверка операций scheduler (пункт 5)

| операция | покрытие |
|---|---|
| attendance auto-submit | `_test-scheduler-diagnostics` (runOneTickCore ok/other/schema) + существующий `_test-timesheet-submission-schedules` + прод-baseline (pilot tick `ok`) |
| period generation | `_test-timesheet-submission-schedules` (`ensureSubmissionScheduleHorizon`) |
| abandoned-shift auto-close | `_test-abandoned-shift-auto-close` (scheduler lane) |
| GPS retention | `_test-retention-pacing` (24 ч пейсинг от завершения) |
| heartbeat | `_test-scheduler-diagnostics` (format-2 round-trip + legacy read) |
| graceful shutdown | код: SIGTERM/SIGINT → доработка итерации + `releaseLease` + `$disconnect` + exit 0 (deploy script: `docker stop -t 30`, graceful до SIGKILL) |
| restart recovery | lease TTL + `lastSuccessAt`/`lastRetentionSuccessAt` — process-local, пересоздаются при старте; первая итерация сразу делает tick + retention |
| отсутствие overlapping ticks | `_test-scheduler-lease` (13 проверок) + `OVERLAPPING` state |

## 5. Test matrix

| тест | lane | проверок | сценарии |
|---|---|--:|---|
| `_test-ready-schema.ts` | db | 24 | current / ahead / behind / migration-failed / missing-key-table / missing-`_prisma_migrations` / restore + **sanitization** |
| `_test-scheduler-health.ts` | unit | 24 | все 9 состояний + `classifyDbError` (Prisma codes + message-matching) |
| `_test-scheduler-lease.ts` | db | 13 | acquire / renew (acquiredAt preserved) / held_by_another / expiry-takeover / release / wrong-holder-release-noop |
| `_test-scheduler-diagnostics.ts` | scheduler | 9 | runOneTickCore ok / other / **real schema drift** (dropped table) / heartbeat round-trip / legacy read |

Все несовместимые сценарии — только на disposable PostgreSQL (per-test клон, `run-tests.mjs`) или
restored pilot copy. Production не трогается (пункт 7).

**Полный прогон (clean env):** unit **12/12** · db **54/54** · scheduler **5/5** · `typecheck` 0 ·
`lint` ok · миграция 96 применяется с нуля чисто · CI — _<статус по коммиту>_.

## 6. Кандидат образа + deploy script (пункты 9–11)

- Образ: `titanor-time-app:t97-pilot-d15586c` — 1.79 ГБ.
- Скрипт `/home/deploy/app-data/t97-pilot/deploy-d15586c.sh`:
  1. **обязательный pre-deploy backup** (`ops/titanor-time/backup-titanor-time.sh pre-deploy`);
  2. **production baseline guard** — фиксирует и в конце сверяет `titanor-time-app-1` image /
     StartedAt / RestartCount + `:latest` id; любое расхождение = ошибка;
  3. `prisma migrate deploy` (95 → 96, `20260830120000_add_scheduler_lease`, аддитивная — restored-pilot тест PASS) +
     `migrate status` = «up to date»;
  4. пересоздание `t97-pilot-app` и `t97-pilot-scheduler` на новом образе **с `--health-cmd`**
     (app → `node -e fetch(/api/ready)==200`; scheduler → `attendance-scheduler-healthcheck.ts`) — образ на `node:bookworm-slim`, без curl;
  5. verify: `/api/ready` = 200 `schema:current`, `/api/health` = 200, `/login` `/reset-password` = 200;
     scheduler heartbeat свежий + healthcheck exit 0; один успешный tick в логах; **negative check** —
     временно нет (не мутируем pilot БД); rollback-инструкция (переименованные `-pre-<sha>`).
- **Скрипт не запускается агентом.** Точная команда владельцу — в конце отчёта.

## 7. Production не изменён (доказательство)

Baseline `titanor-time-app-1`: image `daa2edbb`, `StartedAt 2026-08-21T19:40:56Z`, `RestartCount 0`
— до и после работ R06-A идентичны (никаких `docker`-операций против prod-контейнеров; все тесты —
disposable PostgreSQL). `compose.titanor-time.yaml` не менялся. `:latest` не пересобирался.

## 8. Открытые пункты (в R06-B / R14)

- Real Docker healthcheck для **app** в `compose.titanor-time.yaml` (сейчас только scheduler).
- Один immutable image + `npm ci` lockfile-only + минимизация runtime `node_modules` + non-root —
  **R06-B**.
- B07 (прод БД 42 миграции) закрывается заменой БД на pilot целиком — **R14**.
- Negative `/api/ready` проверка на pilot — только на restored-копии в R12/R14 (pilot БД не мутируем).
