# Titanor Time — Release baseline (R00)

- **Задача:** roadmap R00 — одна проверяемая исходная точка перед подготовкой production.
- **Снято:** 2026-08-29, UTC, хост `vmi3407580`.
- **Git:** ветка `feature/titanor-time-foundation`, SHA `a02b616c8e32b093aa752cea8521535dd758561a`.
  На момент снятия в worktree было 2 неотслеживаемых файла — этот roadmap
  (`docs/titanor-time/PRODUCTION_RELEASE_ROADMAP_RU.md`) и новый ops-скрипт
  `ops/titanor-time/backup-titanor-time.sh`; оба закоммичены задачей R01 (см. её commit).
- **Production в этой задаче не изменялся** (проверено: образ, `StartedAt`, `RestartCount` до и
  после — идентичны, см. §7).

Все числа привязаны ко времени снятия и будут дрейфовать (пилот используется живыми людьми).
Release candidate снимает собственный manifest на своём SHA — этот отчёт его не заменяет.

---

## 1. Код и образы

| Что | Значение |
|---|---|
| Репозиторий | `titanor-time-foundation` (monorepo: корень = публичный сайт `titanorgroup.fi`; `titanor-time-app/` = Titanor Time; общая `prisma/schema.prisma`) |
| Ветка / SHA | `feature/titanor-time-foundation` / `a02b616` |
| Пилотный образ (работает сейчас) | `titanor-time-app:t97-pilot-f486977` = `sha256:deaadb7c2f9b…` |
| Production образ (работает сейчас) | `titanor-time-app:latest` = `sha256:daa2edbb177b…` |
| Prod app / scheduler command | `node server.js` / `npx tsx scripts/attendance-auto-submit-scheduler.ts` |

## 2. Контейнеры и топология

**Titanor Time production** (compose project `titanor-time`, файл `compose.titanor-time.yaml`):

| Контейнер | Образ | Статус | Порт / сеть | Volume / mount |
|---|---|---|---|---|
| `titanor-time-app-1` | `titanor-time-app:latest` | Up 8 days (healthy) | `127.0.0.1:3200` → `internal` + `lan` | uploads → `/home/deploy/app-data/titanor-time/uploads` |
| `titanor-time-scheduler-1` | `titanor-time-app:latest` | Up 8 days **(unhealthy)** | `internal` | — |
| `titanor-time-db-1` | `postgres:16` | Up 8 days (healthy) | `internal` | `titanor-time_db_data` |

> `titanor-time-scheduler-1` в состоянии **unhealthy** — известный блокер B07 (production-код
> несовместим со старой production-схемой). Закрывается на R06, к R00/R01 отношения не имеет.

**Пилот** (отдельный manual-стек, не compose):

| Контейнер | Образ | Порт / сеть | Volume / mount |
|---|---|---|---|
| `t97-pilot-app` | `t97-pilot-f486977` | `127.0.0.1:3297` → `t97-pilot-net` | `/home/deploy/app-data/t97-pilot/uploads` |
| `t97-pilot-scheduler` | `t97-pilot-f486977` | `t97-pilot-net` | — |
| `t97-pilot-db` | `postgres:16` | `t97-pilot-net` | `t97-pilot-db-data` |

Плюс 4 пары rollback-контейнеров `t97-pilot-{app,scheduler}-pre-*` (остановлены, сохранены).
Публичный адрес пилота: `t97-dd686bc3d4.84.247.130.242.nip.io` → Caddy → `127.0.0.1:3297`.

**Прочее на хосте (не трогать):** CollabStudio (`collab-studio-*`), публичный сайт
(`titanorgroup-web-1`), `titanor-time-preview-db` (осиротевший preview DB, приложения нет).

## 3. База пилота (`titanor_time_t97` в `t97-pilot-db`, user `t97_app`)

| Метрика | Значение |
|---|---|
| Миграции применены | **93** из 93 (repo `prisma/migrations` = 93) |
| Миграции unfinished / rolled-back | 0 / 0 |
| Public tables | 71 |
| Public routines | 221 |
| Non-internal triggers | 39 |
| Foreign keys | 177 |
| Всего строк во всех public-таблицах | 1518 |

Последние 8 миграций: …`20260829170000_add_gps_offline_resilience`,
`…180000_relax_approx_location_age_check`, `…190000_seed_worker_profession_manage_own`,
`…200000_add_worker_notifications`, `20260829210000_add_outside_geofence_checkin`.

**Ключевые row counts** (снимок; полный per-table список — в
`baseline-2026-08-29/` в составе первого R01-бэкапа, файл `row-counts.txt`):

| Таблица | Строк |
|---|---:|
| `User` | 10 |
| `Employee` | 6 |
| `WorkSite` | 3 |
| `SiteAssignment` | 6 |
| `ForemanAssignment` | 0 |
| `PayrollPeriod` | 2 |
| `Timesheet` | 12 |
| `TimesheetVersion` | 15 |
| `ClockEvent` | 37 |
| `ClockShift` | 19 |
| `ClockEventLocation` | 31 |
| `ShiftPresenceSample` | 4 |
| `AttendanceException` | 33 |
| `AuditEvent` | 211 |
| `UserSession` | 43 |
| `EmployeeQualification` | 1 |
| `EmployeeProfession` | 1 |
| `WorkerDeviceInstallation` | 6 |

## 4. Uploads

| | Файлов | Размер | Расположение |
|---|---:|---:|---|
| Пилот | 3 | 1023 B | `/home/deploy/app-data/t97-pilot/uploads` (реальный локальный каталог) |
| Production | 0 | — | `/home/deploy/app-data/titanor-time/uploads` → **симлинк** в `/mnt/250gb/titanor-time-foundation/uploads` (s3fs) |

Пилотные файлы: employee photo + 2 qualification photos для одного `Employee`. Полный manifest
(относительные пути + SHA-256) — в составе R01-бэкапа (`uploads.tar.gz` + `SHA256SUMS`).

## 5. Версии инструментов

| | Версия |
|---|---|
| Node | v22.23.1 |
| npm | 10.9.8 |
| PostgreSQL (в контейнерах) | 16.14 |
| Docker | 29.6.1 |
| Docker Compose | v5.2.0 |
| s3fs | V1.93 (GnuTLS) |
| `pg_dump`/`pg_restore` на хосте | отсутствуют — используются из `postgres:16` через `docker exec`/`docker run` |

## 6. Диски и storage

| | Значение |
|---|---|
| Root `/dev/sda1` (ext4) | 145 GB, занято 82 GB, свободно 63 GB (57%) |
| `/home/deploy/backups` | 71 MB |
| `/home/deploy/app-data` | 5.3 MB |
| Docker images | 21.3 GB (6.7 GB reclaimable) |
| Docker build cache | **36.6 GB** (21.1 GB reclaimable) — вне scope R00/R01, отметить для R06 |
| Docker volumes | 524 MB |

### `/mnt/250gb` — критично (блокер B02)

**Это НЕ физический диск на 250 GB.** Это **s3fs FUSE-mount на Contabo Object Storage**:

```
/etc/fstab:  s3fs#250gb /mnt/250gb fuse _netdev,allow_other,passwd_file=/home/deploy/.passwd-s3fs,
             url=https://usc1.contabostorage.com,use_path_request_style,uid=1000,gid=1000 0 0
mount:       s3fs on /mnt/250gb type fuse.s3fs (rw,nosuid,nodev,relatime,user_id=1000,group_id=1000)
df:          s3fs  4.0G  0  4.0G  0%  /mnt/250gb     <- "4.0G" фиктивный (артефакт s3fs), НЕ квота
```

Проверено этой задачей:
- **mount persistent** — в `/etc/fstab` с `_netdev`, переживёт reboot;
- **владелец / права** — `uid=1000 gid=1000` (deploy), запись/чтение работают;
- **write test** — 25 MiB записаны, `sync`, перечитаны свежим процессом → SHA-256 совпал; тест удалён;
- **уже используется**: `collab-studio/` (~2.5 MB), `titanor-time-foundation/{media,pilot-uploads,uploads}` (пустые), `test.txt` («Hello Contabo», проба mount от 2026-08-21);
- **production uploads Titanor Time уже живут здесь** (симлинк, §4);
- **ограничение Docker+FUSE**: бинд-mount пути с `/mnt/250gb` в контейнер **не работает**
  (`mkdir /mnt/250gb: file exists`) — restore из off-box копии всегда через локальный staging
  (учтено в `restore-test-titanor-time.sh`); тот же факт зафиксирован в комментарии
  `compose.titanor-time.yaml`.
- **реальная квота НЕ подтверждена**: `df` бесполезен, S3-инструментов (`aws`/`rclone`/`s3cmd`)
  на хосте нет, доступа к панели Contabo у агента нет. Имя бакета «250gb» намекает на план 250 GB,
  но по правилам roadmap это не доказательство.

**→ Точка владельца (R01):** подтвердить в панели Contabo Object Storage фактическую квоту бакета
`250gb`, текущую занятость и политику/стоимость хранения (roadmap §9 «После R01»). До подтверждения
постоянный ежедневный таймер не включается (см. R01 runbook, шаг «включение таймера»). Локальный
backup на `/dev/sda1` от квоты Contabo не зависит и уже проверен.

## 7. Production не изменён (доказательство)

| | До задачи | После задачи |
|---|---|---|
| `titanor-time-app-1` image | `sha256:daa2edbb177b…` | `sha256:daa2edbb177b…` |
| `titanor-time-app-1` StartedAt | `2026-08-21T19:40:56Z` | `2026-08-21T19:40:56Z` |
| `titanor-time-app-1` RestartCount | 0 | 0 |
| `titanor-time-app:latest` id | `sha256:daa2edbb177b…` | `sha256:daa2edbb177b…` |
| `titanor-time-db-1` | healthy, не трогался | healthy, не трогался |

Restore-тесты выполнялись только в одноразовых `postgres:16`-контейнерах на отдельной сети/volume,
удалённых по точному имени (см. R01 runbook).

## 8. Дерево зависимостей (блокер B05)

`npm audit --omit=dev` — **8 high** и в публичном сайте, и в Titanor Time. Полные JSON:
`docs/titanor-time/baseline-2026-08-29/audit-public-site.json` и `audit-titanor-time.json`.
Затронуто: `next`, `postcss`, `nanoid`, `sharp`, `prisma`/`@prisma/config`/`deepmerge-ts`/`effect`
(совпадает с целями TZ §12.2). Устранение — R04 (сайт) и R05 (Titanor Time), не эта задача.

---

## Итог R00

Исходная точка зафиксирована и привязана к SHA `a02b616`, времени и окружению. Production не
изменён. Единственный внешний вопрос — **фактическая квота Contabo-бакета `250gb`** (см. §6, точка
владельца). Всё остальное для начала работ известно.
