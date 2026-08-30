# Titanor Time — scheduler operations runbook (R06-A)

Долгоживущий процесс `scripts/attendance-auto-submit-scheduler.ts`. Один immutable образ, что и у
web, но отдельная command. Никаких HTTP-портов. R06-A добавил: schema-aware `/api/ready`,
обогащённый heartbeat + классификацию состояний, single-writer lease.

---

## 1. Что делает каждый tick

Один проход цикла (интервал `ATTENDANCE_SCHEDULER_INTERVAL_SECONDS`, дефолт 60, диапазон 30–3600):

1. **lease** — `acquireOrRenewLease` (`SchedulerLease`). Если держит другой живой процесс →
   `SCHEDULER_LEASE_HELD_BY_ANOTHER`, heartbeat пишет `lastOverlapAt`, весь остальной шаг
   **пропускается** (не двойной запуск).
2. **attendance auto-submit** — `runAttendanceAutoSubmitTick` (`runOneTickCore`). Ошибка
   классифицируется: `db_unavailable` / `schema_incompatible` / `tick_error`.
3. **abandoned-shift auto-close** — `runAbandonedShiftAutoCloseTick`, свой try/catch.
4. **GPS retention** — `runAttendanceLocationRetention`, пейсинг 24 ч от фактического завершения.
5. **period generation** — `ensureSubmissionScheduleHorizon`, пейсинг 6 ч.
6. `sleep(interval)` (abort-aware).

Startup: `checkSchemaReadiness()` — если БД несовместима, heartbeat сразу пишет
`schema_incompatible` / `db_unavailable` (не ждём падения первого tick'а). Не фатально — следующая
итерация подхватит починенную БД.

SIGTERM / SIGINT → graceful: дорабатывает текущую итерацию, `releaseLease`, `$disconnect`, exit 0.

## 2. Heartbeat

Файл `ATTENDANCE_SCHEDULER_HEARTBEAT_PATH` (дефолт `/tmp/attendance-scheduler-heartbeat.json`),
формат 2:

| поле | смысл |
|---|---|
| `format` | `2` |
| `pid` | pid процесса-писателя |
| `processStartedAt` | старт процесса (ISO) |
| `lastTickAt` | последняя попытка tick'а (успех или ошибка) |
| `lastTickCompletedAt` | последний **успешный** tick (совместимость со старым мониторингом) |
| `lastOutcome` | `ok` / `tick_error` / `db_unavailable` / `schema_incompatible` |
| `lastErrorCode` | стабильный код (никогда не сырой текст ошибки) |
| `consecutiveFailures` | подряд неуспешных tick'ов |
| `lastOverlapAt` | когда последний раз пропустили работу из-за чужого lease |

## 3. Healthcheck

`scripts/attendance-scheduler-healthcheck.ts` — без HTTP, **без подключения к БД** (неспособность
застрявшего цикла обновить heartbeat — это и есть сигнал). Печатает
`scheduler-health: <STATE> (last tick Ns)`, exit 0 (healthy) / 1 (unhealthy).

| STATE | exit | что значит | что делать |
|---|:--:|---|---|
| `HEALTHY` | 0 | свежий успешный tick | — |
| `STARTING` | 0 | процесс только стартовал (< 90 c), tick'а ещё не было | подождать |
| `HEARTBEAT_MISSING` | 1 | файла нет и grace истёк | процесс не пишет heartbeat — проверить логи, рестарт |
| `HEARTBEAT_STALE` | 1 | последний tick был `ok`, но слишком давно (> 3× интервала, мин 120 c) | процесс завис/умер — рестарт; проверить нагрузку БД |
| `PROCESS_STOPPED` | 1 | pid из heartbeat не жив | writer умер, контейнер не перезапустился — рестарт |
| `DB_UNAVAILABLE` | 1 | последний tick упал из-за недоступной БД | проверить `titanor-time-db` / сеть; heartbeat сам восстановится |
| `SCHEMA_INCOMPATIBLE` | 1 | БД есть, но схема не та, что ждёт образ | применить недостающие миграции (`prisma migrate deploy`) **той же версией образа**; либо это чужая/неполная БД |
| `TICK_FAILING` | 1 | tick'и идут, но подряд ≥ 3 ошибок (не БД/схема) | смотреть логи (`errorCode`), диагностировать бизнес-логику |
| `OVERLAPPING` | 1 | lease держит другой живой scheduler | **остановить лишний контейнер** (должен быть ровно один); проверить `SELECT * FROM "SchedulerLease"` |

## 4. Диагностика (безопасные команды)

```bash
# состояние
docker inspect <scheduler> --format '{{json .State.Health}}'
docker exec <scheduler> cat /tmp/attendance-scheduler-heartbeat.json
docker exec <scheduler> sh -c 'npx tsx scripts/attendance-scheduler-healthcheck.ts; echo exit=$?'

# структурированные логи (уже sanitized — только event/outcome/errorCode/счётчики, без PII/SQL)
docker logs --tail 50 <scheduler>

# readiness приложения (schema-aware)
curl -s <app>/api/ready | jq        # 200 ready | 503 not_ready + reason

# lease (на throwaway/restored копии, не на production напрямую)
psql -c 'SELECT name, "holderId", "acquiredAt", "renewedAt" FROM "SchedulerLease"'
```

Логи и ответы **не содержат** database URL, SQL, credentials, GPS-координаты, строки таблиц —
только фиксированные коды и счётчики.

## 5. Один immutable образ, две команды

- web: `node server.js` (entrypoint образа);
- scheduler: `sh -c 'npx tsx scripts/attendance-auto-submit-scheduler.ts'`.

Ровно **один** scheduler-контейнер на окружение. Два → второй уходит в `OVERLAPPING` и ничего не
делает (lease защищает от двойных tick'ов), но это ошибка конфигурации — убрать лишний.

## 6. `/api/ready` (schema-aware) — коды

| `reason` (503) | значит |
|---|---|
| `DB_UNAVAILABLE` | БД недоступна |
| `MIGRATIONS_TABLE_MISSING` | нет `_prisma_migrations` — это не мигрированная БД Titanor Time |
| `MIGRATIONS_FAILED` | есть незавершённые / откаченные миграции |
| `SCHEMA_BEHIND` | БД не хватает миграций, которые ждёт образ (`missingMigrations` в теле) |
| `KEY_TABLE_MISSING` | нет одной из ключевых таблиц (`missingTables` в теле) |

`200` + `schema: "current"` — точное совпадение; `200` + `schema: "ahead"` — в БД есть лишние
применённые миграции (mid-rollout, аддитивные — forward-compatible).

## 7. Известное на момент R06-A

- **Production** (`titanor-time-app:latest` = `daa2edbb`) сейчас на БД из **42 миграций** — код
  сильно опережает схему (блокер B07). Старый `/api/ready` отдавал ложный `200`; scheduler tick'и
  все падают, контейнер `unhealthy`. R06-A **не чинит** прод напрямую — исправляет проверки, чтобы
  после cutover (R14) несовместимость не могла спрятаться за HTTP 200. Реальный фикс прода — замена
  БД на pilot целиком (R14).
- Real Docker healthcheck для **app**-контейнера в `compose.titanor-time.yaml` пока не добавлен
  (только у scheduler). Кандидат образа R06-A + pilot deploy script добавляют `--health-cmd` обоим
  pilot-контейнерам; production compose не трогается в R06-A (R06-B / R14).
