# R10 — migration report (release candidate)

- **Основание:** production release roadmap R10 (release candidate + full pilot acceptance),
  ТЗ §20 Шаг 9 «применить все final migrations», §22 «все final migrations применены / failed
  отсутствуют».
- **Дата:** 2026-08-30.
- **Кандидат:** ветка `feature/titanor-time-foundation` @ `c0a4547`, код приложения идентичен
  задеплоенному образу `titanor-time-app:t97-pilot-edd950c` (`sha256:0282e68f…`); с `edd950c`
  менялись только `docs/` и `ops/titanor-time/deploy-pilot-edd950c.sh`.
- **Миграций:** **98** (`prisma/migrations/`, последняя `20260830160000_add_gps_archive_day`).

## 1. Fresh DB — `migrate deploy` с нуля

Пустая disposable PostgreSQL 16, образ кандидата (`.prisma-tools/…/prisma migrate deploy`):

| проверка | результат |
|---|---|
| run 1: `migrate deploy` с нуля | **All migrations have been successfully applied** (98) |
| run 2: `migrate deploy` повторно (идемпотентность) | **No pending migrations to apply** |
| `migrate status` | **Database schema is up to date!** |
| `_prisma_migrations` applied | **98** |
| `_prisma_migrations` failed / rolled-back | **0** |
| public tables | **74** |

Полный лог: `docs/titanor-time/baseline-r10/migration-fresh-db.txt`.

## 2. Restored pilot copy

`ops/titanor-time/restore-test-titanor-time.sh` против свежайшего pre-deploy backup
`pilot-20260830T215914Z-pre-deploy` (пилот только читался; всё disposable):

| проверка | результат |
|---|---|
| backup `SHA256SUMS` verify | PASS |
| `gps-archive-manifest.json` валидный JSON | PASS |
| `pg_restore --exit-on-error` (в БД, владелец = **другая** роль) | PASS |
| migrations applied в восстановленной БД | **98** (== backup) |
| unfinished / rolled-back migrations | **0** |
| migration-history hash | **совпадает** с backup |
| public tables / routines / triggers / FKs | **74 / 222 / 40 / 178** |
| per-table row counts (все 74 таблицы) | **идентичны** backup |
| all-data детерминированный fingerprint | **совпадает** с backup точно |
| uploads archive | **3 файла** (== manifest) |
| **RESTORE TEST** | **13 passed, 0 failed** |

Полный лог: `docs/titanor-time/baseline-r10/restore-test.txt`.

Дополнительно (R09 disposable-verify, 2026-08-30): образ `edd950c` против **восстановленного
pilot pg_dump** → `migrate status` = «up to date» (98), `/api/ready` `schema:current` applied=98.

## 3. Пилот (live) на момент R10

`t97-pilot-db`: **98 applied / 0 failed**. `/api/ready` → `{"schema":"current","migrations":{"applied":98,"expected":98,"aheadBy":0}}`.
Строки (key tables): User 10 · Employee 6 · WorkSite 3 · ClockEvent 37 · Timesheet 18 ·
AttendanceException 33 · ClockEventLocation 31 · GpsArchiveDay 5.

## 4. Вывод

- **Все 98 миграций применяются чисто и с нуля, и на восстановленной копии пилота.**
- **Failed / rolled-back миграций нет** нигде.
- Схема кандидата **побайтно совпадает** с тем, что уже на пилоте (R09 деплой не менял БД).
- Down-миграций нет by design (Prisma migrate deploy) — откат = swap образа; аддитивные миграции
  толерируются старым образом (`/api/ready` `schema:ahead` → HTTP 200), см. R06-A.
- **Для production cutover (R14):** «применить только final pending migrations, если есть» —
  на момент R10 pending нет (пилот и кандидат оба на 98).
