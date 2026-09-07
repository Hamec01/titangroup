# Titanor Time — production-деплой нового дизайна админки + раздела «Отчёты»

**Дата/время swap:** 2026-09-07 14:22:25–14:22:29 UTC · **простой ≈ 3.7 с**
**Визуальная приёмка владельцем: 2026-09-07 — «визуально всё нормально». РЕЛИЗ ПРИНЯТ И ЗАКРЫТ (см. §14a).**
**Результат:** production LIVE на `titanor-time-app:redesign-4c282ba`, schema `current 102/102`. Все реальные данные (работники, пользователи, назначения, часы, табели, объекты, заказчики, пароли, роли, uploads, история) — без потерь и без подмены.

---

## 1. Final commit SHA

`4c282bafc9b35dbc050144cf4400a460dd1c106e` (`4c282ba`) — HEAD ветки `work/report-redesign`, запушен в `origin/work/report-redesign`.
База: `61050de` (`feature/titanor-time-foundation`, **не менялась**).

Коммиты поверх `834e620`:

| SHA | Заголовок | Автор |
|---|---|---|
| `c68ae80` | fix(reports): STOP-GATE fixes — data, exports, URL state, admin shell | (эта работа) |
| `f24f1f3` | test(reports): DB + browser lanes for the report command center | |
| `f6e2230` | docs(reports): production-readiness report + raw SQL register §17 | |
| `6d0973c` | test(reports): make the command-center browser test self-contained + robust | |
| `324090e` | fix(reports): localize report operation errors by code (§6/§9) | |
| `72470cb` | docs(reports): finalize production-readiness report | |
| `02a9bee` | feat(time): finish light admin workspace preview | (Codex-сессия) |
| `834796e` | feat(time): compact scrollable worker overview | (Codex-сессия) |
| `529930c` | feat(time): add modern admin colour palettes | (Codex-сессия) |
| `4c282ba` | fix(reports): restore pre-redesign saved links + add admin skip-to-content link | (эта работа, regression-фикс Этапа 2) |

## 2. Image tag

**`titanor-time-app:redesign-4c282ba`** — собран из `titanor-time-app/Dockerfile` (context = repo root),
`--build-arg GIT_SHA=4c282bafc9b35dbc050144cf4400a460dd1c106e`.
OCI-провенанс: `org.opencontainers.image.revision = 4c282bafc9b35dbc050144cf4400a460dd1c106e` (совпадает с HEAD).
Сборка: `npm ci` ✓ · `prisma generate` ✓ · `next build` ✓ (`Compiled successfully in 30.6s`) · `build-runtime-scripts.mjs` ✓ · `assemble-prisma-tools.mjs` ✓.

## 3. Backup names

| Каталог | Момент | Проверка |
|---|---|---|
| `production-20260907T121437Z-pre-deploy` | до миграции (12:14 UTC) | on-box + off-box `SHA256SUMS` 9/9 OK; restore-test 12/13 (см. §4) |
| `production-20260907T141401Z-pre-deploy` | после миграции (14:14 UTC, schema 102) | on-box + off-box `SHA256SUMS` **9/9 OK** (включая `data.sha256` — БД была тихой) |

Off-box: `/mnt/250gb/titanor-time-foundation/backups/production/…` — оба скопированы, `SHA256SUMS` перепроверены с off-box копии.

## 4. Результат restore-test

`ops/titanor-time/restore-test-titanor-time.sh production-20260907T121437Z-pre-deploy` → **12/13 PASS**.
Единственный FAIL — «all-data fingerprint» (restored digest ≠ manifest `data.sha256`). Полностью разобран:
- `db.dump` — консистентный транзакционный снимок; `pg_restore --exit-on-error` OK; миграции 100, 0 битых, migration-history hash совпал; per-table row counts идентичны для всех 75 таблиц; uploads 4 файла.
- Причина расхождения: backup-скрипт делает **два отдельных** `pg_dump` (для `db.dump` и для `data.sha256`) с интервалом в секунды. На живом prod между ними изменились только **`SchedulerLease`** (1 строка, timestamp продления lease) и **`UserSession.lastSeenAt`** (56 строк, heartbeat активных сессий) — обе НЕ бизнес-таблицы.
- **Прямое доказательство:** сравнение снимка backup с независимым `pg_dump` prod через 13 мин — **все 13 бизнес-таблиц байт-в-байт идентичны** (Employee 12, User 20, Employment 12, WorkSite 3, WorkArea 3, SiteAssignment 28, PayrollPeriod 4, Timesheet 39, WorkSegment 55, ClockShift 40, ClockEvent 85, AssignmentTransition 18, AuditEvent 662).

## 5. Миграции 100 → 102 + второй no-op

Применялись через **throwaway migrator-контейнер** (образ `redesign-4c282ba`, `--entrypoint node .prisma-tools/.../prisma migrate deploy`), **старый app не останавливался**.

```
14:12:02Z  migrate deploy #1:
           Applying migration `20260906193000_add_saved_report_files`
           Applying migration `20260906210000_harden_report_files`
           All migrations have been successfully applied.        (exit 0)
14:12:10Z  migrate deploy #2:  No pending migrations to apply.   (точный no-op)
```

`_prisma_migrations`: **102 finished, 0 failed/rolled-back**. Обе новые: `started_at`/`finished_at` 14:12:09, `rolled_back_at` NULL.
`20260906193000` — `CREATE TABLE "ReportFile"` + 2 индекса. `20260906210000` — только `ALTER TABLE "ReportFile" ADD CONSTRAINT` (FK-18/19, CK-52..58) + 1 индекс. **Ни одного `UPDATE`/`DELETE`/`TRUNCATE`, ни строчки DML по существующим таблицам** (проверено построчно в Этапе 1).

## 6. Доказательство неизменности существующих данных

**Digest всех таблиц до и после миграции** (на восстановленной копии, Этап 3.5):

```
diff (after − before):
  + ReportFile|0|d41d8cd98f00b204e9800998ecf8427e     (новая пустая таблица)
  _prisma_migrations|100 → 102
```

Все 74 остальные таблицы — **байт-в-байт идентичны**.

**На живом production после миграции + после swap + после smoke:**

| Таблица | Значение | Baseline |
|---|---|---|
| Employee | 12 | 12 |
| User | 20 | 20 |
| Employment | 12 | 12 |
| WorkSite | 3 | 3 |
| WorkArea | 3 | 3 |
| SiteAssignment | 28 | 28 |
| PayrollPeriod | 4 | 4 |
| Timesheet | 39 | 39 |
| TimesheetVersion | 17 | 17 |
| WorkSegment | 55 | 55 |
| ClockShift | 40 | 40 |
| ClockEvent | 85 | 85 |
| AssignmentTransition | 18 | 18 |
| ExportBatch / ExportItem | 0 / 0 | 0 / 0 |
| **ReportFile** | **0** | — |
| schema | 102 | — |

## 7. Доказательство отсутствия тестовых работников/объектов/табелей

- **0** событий `REPORT_FILE_*` в `AuditEvent` на prod.
- **0** строк в `ReportFile`.
- **0** строк `IdempotencyKey` с `routeTemplate = /api/admin/reports/export`.
- Ни один `docker exec … psql` не выполнял `INSERT`/`UPDATE`/`DELETE` по бизнес-таблицам prod. Все запросы к prod-БД — `SELECT` (read-only).
- Никакие пользователи/сессии на prod прямым SQL не создавались.
- **`AuditEvent` 662 → 664** за всё время работы. Дельта +2 = органическая активность prod: `LOGIN_SUCCEEDED` в 14:04:34 (реальный вход, за 8 мин до миграции) + `LOGIN_FAILED` в 14:22:58 (мой post-swap smoke неверных credentials → 401, мандат ТЗ; identifier `no-such-admin`, не реальный пользователь; это запись security-лога, не бизнес-данные). Записей `AuditEvent` с момента миграции (14:12) — ровно **1** (тот `LOGIN_FAILED`).

## 8. Полный результат регрессии

Все write-тесты — в disposable-контейнерах. Ничего не касалось production/pilot.

| Проверка | Результат |
|---|---|
| `npx tsc --noEmit` (tsconfig.json + tsconfig.build.json) | PASS |
| `npm run lint` | PASS |
| `next build` | PASS |
| unit lane | **18/18** |
| db lane | **61/61** |
| scheduler lane | **5/5** |
| browser manifest — `ops/titanor-time/run-browser-acceptance.sh` на образе `redesign-4c282ba`, per-test isolation | **20 pass / 0 fail / 2 skip-harness** |
| `run-restart-persistence.sh` (образ `redesign-4c282ba`) | **PASS** (seed 84/0 → prepare 5/0 → docker restart → verify 18/0) |
| `run-worker-dossier-qa.sh` (образ `redesign-4c282ba`) | **PASS** 31/0 |
| **Итого browser** | **22/22 на кандидатском образе** |
| candidate write-QA на копии реальных данных (schema 102) | create CSV+PDF → `ReportFile=2` → download 200 (`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`, баннер `WORKING REPORT — NOT AN OFFICIAL PAYROLL EXPORT`, **только английский**) → re-download 200 → delete ×2 200 → re-delete 404 → `ReportFile=0` → audit `REPORT_FILE_CREATED`=2 `REPORT_FILE_DELETED`=2. Бизнес-данные не изменились. |
| Этап 2 нашёл 2 реальные проблемы → исправлены в `4c282ba` | (1) `/admin/reports?employeeId=…&periodId=…` (ссылка до редизайна) вела на обзор → теперь `view` выводится из URL; (2) 2-й Tab попадал на `<button>` новой навигации → скрытая ссылка «Перейти к содержимому» (WCAG 2.4.1). Обе — не бизнес-логика. |

## 9. Результаты desktop/mobile и четырёх тем

Покрыты browser lane на кандидатском образе:
- `_test-reports-command-center.ts` — 47 проверок: все 4 вкладки, пикеры, конфликт worker/site невозможен, Back/Forward/reload/Reset, битый и «не тот» UUID, пагинация 20/стр., create→history→download→delete, **classic⇄modern**, RU/EN, mobile (нет горизонтального скролла, Escape закрывает меню), **контрастность WCAG** (функция `contrastRatio` в тесте), проверка всех 4 тем.
- `_test-t9-setup-ui.ts` — клавиатурная навигация (Tab/фокус) на `/admin/workers` и др.
- offline/PWA (`_test-offline-*`, `_test-pwa-install`) — все PASS.

Финальный визуальный обход в браузере (переключение тем в живом UI, mobile) — за владельцем (нужен логин администратора; я на prod авторизацию с реальным паролем не проводил).

## 10. Production smoke (после swap)

| Проверка | Результат |
|---|---|
| `/api/ready` локально (`127.0.0.1:3199`) | **200** · `status:ready database:connected schema:current 102/102 aheadBy:0` |
| `/api/ready` через Caddy (`https://app.titanorgroup.fi`) | **200** · `schema:current 102/102` |
| `/login` (через Caddy) | **200** |
| `/reset-password` | **200** |
| `/guide` | **200** |
| неверные credentials → `/api/auth/login` | **401** |
| `/admin`, `/admin/reports`, `/admin/reports/{periods,sites,custom,customer}`, `/admin/export`, `/admin/workers`, `/admin/assignments` | **307** (redirect на login без сессии — маршрутизация + middleware + session-check работают) |
| app-логи с момента swap | **ноль строк error/Prisma/SQL/500/exception/unhandled** |
| scheduler-логи с момента swap | чисто — `attendance_auto_submit_tick` `runnerOutcome:ok failed:0 scanned:33`, `abandoned_shift_auto_close outcome:ok` |
| **candidate uploads mount** (при :3198 smoke) | **read-only подтверждён** (`touch` → `Read-only file system`) |
| write-smoke на живом prod | **НЕ выполнялся** (тестовый PDF/CSV на prod не создавался) |

## 11. Фактическое время простоя

`docker stop` **14:22:25.297Z** → `/api/ready` = 200 **14:22:29.024Z** ≈ **3.7 секунды**.
(`stop` занял ~0.8 с; новый контейнер стал ready за ~2 с после старта.)

## 12. Состояние app и scheduler

| Контейнер | Образ | Статус |
|---|---|---|
| `titanor-time-prod-app` | **`titanor-time-app:redesign-4c282ba`** | running / **healthy** · `--restart unless-stopped` |
| `titanor-time-prod-scheduler` | `titanor-time-app:r14-release-1416503` | running / healthy · **НЕ ТРОНУТ** |
| `titanor-time-prod-db` | `postgres:16` | running / healthy · **НЕ ТРОНУТ** |

Web-only swap сохранил без изменений: сеть `titanor-time-prod-net`, порт `127.0.0.1:3199:3000`, env-file `/home/deploy/app-data/titanor-time-prod/app.env`, uploads volume `/home/deploy/app-data/titanor-time-prod/uploads:/app/uploads`, healthcheck (`node -e fetch(/api/ready)`, interval 15s / timeout 5s / start 40s / retries 4), restart policy `unless-stopped`.
Caddy, DNS, пароли, публичный сайт — не трогались.

## 13. Точное имя rollback-контейнера

**`titanor-time-prod-app-pre-4c282ba`** — образ **`titanor-time-app:d7f-fd8494c`**, статус `Exited (143)` (сохранён, не удалён).
Совместимость `d7f-fd8494c` со schema 102 **доказана заранее** (Этап 3.7 на восстановленной копии): `/api/ready` = 200 `status:ready schema:ahead aheadBy:2`; страницы 200/307/401; scheduler-tick чисто (`failed:0`); ноль ошибок в логах.

Все более старые `-pre-<sha>` контейнеры (21 шт., до `r14-release-1416503`) — сохранены.

## 14. Точная rollback-команда

**Только откат образа. Схему НЕ откатывать. `ReportFile` НЕ удалять. Backup поверх БД НЕ восстанавливать.
`docker rm -f` НЕ использовать — новый контейнер сохраняется под именем
`titanor-time-prod-app-redesign-failed` для диагностики.**

```bash
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-redesign-failed
docker rename titanor-time-prod-app-pre-4c282ba titanor-time-prod-app
docker start titanor-time-prod-app
curl -s http://127.0.0.1:3199/api/ready
```

**Ожидаемый результат после rollback:** `status:ready`, `schema:ahead`, `aheadBy:2`
(`d7f-fd8494c` на schema 102 — это норма, доказано в Этапе 3.7).

После отката schema остаётся 102, `ReportFile` пустая и невидима для кода `d7f-fd8494c`
(он её не запрашивает). Scheduler / Caddy / DNS не трогать. Контейнер
`titanor-time-prod-app-redesign-failed` не удалять до разбора причины.

## 14a. Визуальная приёмка владельцем — 2026-09-07 · РЕЛИЗ ЗАКРЫТ

- **2026-09-07: владелец выполнил визуальную проверку production и подтвердил — «визуально всё нормально». Релиз принят.**
- **Новый дизайн админки и раздел «Отчёты» — ПРИНЯТЫ в production.**
- Production image: **`titanor-time-app:redesign-4c282ba`** (deployed code `4c282bafc9b35dbc050144cf4400a460dd1c106e`).
- Schema: **`current 102/102`**.
- Реальные данные (работники, пользователи, назначения, часы, табели, объекты, заказчики, пароли, роли, uploads, история) — **не изменены** (см. §6, §7).
- Тестовые работники / объекты / табели / назначения / отчёты — **не создавались**.
- **Релиз нового дизайна и отчётов закрыт.** Release-ветка `feature/titanor-time-foundation`
  fast-forward'нута на `origin/work/report-redesign` (без merge-коммитов, без force-push) —
  теперь содержит deployed commit `4c282ba` + этот отчёт.

## 15. Оставшиеся ограничения и риски

- **restore-test 12/13** — «all-data fingerprint» на backup, снятом в рабочее время. Полностью разобран (§4), риска для данных/rollback нет. Для чистого 13/13 backup нужно снимать в тихое окно (вечер/ночь).
- Визуальный обход живого prod владельцем — **выполнен 2026-09-07, релиз принят** (§14a).
- Полный browser manifest прогонялся на **кандидатском образе на копии prod-данных**, не на живом prod (write-smoke на prod запрещён).
- **Docker cleanup НЕ выполнять** до отдельного sign-off. Сохранены: старый контейнер `titanor-time-prod-app-pre-4c282ba`, образ `d7f-fd8494c`, новый образ `redesign-4c282ba`, backups `20260907T121437Z` + `20260907T141401Z` (on-box + off-box), disposable restore-логи (`…/scratchpad/e3-*.log`, `digest-before/after.txt`, `candidate-build.log`), screenshots из preview-фазы. Disposable pg-контейнер `tt-testdb-rr` оставлен остановленным.

## 16. Явное подтверждение

- **Production получил только новый дизайн и исправленный раздел отчётов.**
- **Все реальные работники, пользователи, назначения, часы, табели, объекты, заказчики, пароли, роли, uploads и история — без потерь и без подмены** (§6, §7).
- Миграции — только 100 → 102, обе additive, ноль DML по существующим строкам.
- Тестовые записи на production **не создавались** (§7).
- Scheduler, Caddy, DNS, пароли, uploads-volume, публичный сайт — **не тронуты**.
- Rollback-цель `d7f-fd8494c` сохранена и **доказана работоспособной на schema 102**.
