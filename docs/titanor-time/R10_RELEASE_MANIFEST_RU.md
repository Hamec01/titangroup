# R10 — release manifest (frozen candidate)

- **Основание:** production release roadmap R10, ТЗ §20 Шаг 0 (freeze) + Шаг 10 (production checkpoint).
- **Дата заморозки:** 2026-08-31.
- **Назначение:** зафиксировать один точный кандидат, который не меняется до финальной репетиции
  (R12) и production checkpoint (R13). Любое исправление после этой даты создаёт **новый** кандидат
  и повторяет затронутые проверки (ТЗ §20 Шаг 9).

## 1. Код

| | |
|---|---|
| repo | `feature/titanor-time-foundation` (GitHub `Hamec01/titangroup`) |
| candidate commit | **`2ebe3e5`** (`test(time): R10 — refresh stale expectations in 3 browser report/export tests`) |
| runtime-эквивалент | код приложения и все миграции **идентичны** `edd950c` (R09), который задеплоен на пилот. С `edd950c`: только `docs/`, `ops/titanor-time/*`, `scripts/_test-*` (обновление устаревших ожиданий — §R10_PILOT_ACCEPTANCE §4). `git diff edd950c..2ebe3e5 -- titanor-time-app/app titanor-time-app/lib titanor-time-app/components prisma` = **пусто** |
| миграций | **98**, последняя `20260830160000_add_gps_archive_day` |

## 2. Образ

| | |
|---|---|
| tag | `titanor-time-app:t97-pilot-edd950c` |
| image ID | `sha256:0282e68ffbfcb682d59ff6a366aeb7ef13209c1ed8063949dead1492959ef023` |
| OCI revision label | `edd950c` |
| created | 2026-08-30T21:27:08Z |
| size | ~184 MiB (192 914 621 B) |
| собран из | repo root, `docker build -f titanor-time-app/Dockerfile --provenance=false --sbom=false --build-arg GIT_SHA=edd950c …` |
| production `:latest` | `sha256:daa2edbb…` — **не тронут** |

Для нового кандидата (если после R10 будет P0/P1-фикс в рантайме) — пересобрать с новым
`GIT_SHA`, обновить этот манифест, повторить §R10 §1/§2.

## 3. Пилот (текущий стенд)

| | |
|---|---|
| контейнеры | `t97-pilot-app` + `t97-pilot-scheduler` на `titanor-time-app:t97-pilot-edd950c`, оба `healthy`, restarts 0 |
| БД | `t97-pilot-db` (`titanor_time_t97`), **98 applied / 0 failed** |
| `/api/ready` | `{"status":"ready","schema":"current","migrations":{"applied":98,"expected":98,"aheadBy":0}}` |
| scheduler | heartbeat `lastOutcome:ok consecutiveFailures:0`, lease renewed, ~1 тик/мин |
| row counts (key) | User 10 · Employee 6 · WorkSite 3 · ClockEvent 37 · Timesheet 18 · AttendanceException 33 · ClockEventLocation 31 · GpsArchiveDay 5 |
| порт | `127.0.0.1:3297` · внешний `https://t97-dd686bc3d4.84.247.130.242.nip.io` (Caddy, informational) |
| env | `/home/deploy/app-data/t97-pilot/app.env` (5 crypto-ключей: IDEMPOTENCY / ACTIVATION_TOKEN_HMAC / PERSONAL_DATA / PASSWORD_RESET_TOKEN_HMAC / GPS_ARCHIVE) |
| rollback-контейнеры | `t97-pilot-{app,scheduler}-pre-edd950c` (R09), `-pre-6a47ed3` (R08) — сохранены |

## 4. Backup (доказательство восстановимости)

Свежайший pre-deploy backup: **`pilot-20260830T215914Z-pre-deploy`**

| | on-box | off-box |
|---|---|---|
| путь | `/home/deploy/backups/titanor-time-pilot/pilot-20260830T215914Z-pre-deploy` | `/mnt/250gb/titanor-time-foundation/backups/pilot/pilot-20260830T215914Z-pre-deploy` |
| содержимое | `db.dump` (custom, 484 572 B, 726 TOC, 1566 rows, 98 migr) · `uploads.tar.gz` (3 файла) · `structure.txt` · `row-counts.txt` · `data.sha256` · `migration-history.sha256` · `gps-archive-manifest.json` · `manifest.txt` · `SHA256SUMS` |

`SHA256SUMS` (on-box == off-box, re-verified):
```
7256cb52a616ed29014ea1c6f9971746882f49e228d74f83ed1cfe679ee3ae15  db.dump
4affc388657cd39eef61c5f7810bf5d4411b8ffe125ced6c138f5cc252e9aec5  data.sha256
0c45bcd9d075bccb466f330882399be90250b394b35fe20b5616978f60f48989  migration-history.sha256
338122c8de94ffc27550dd7b5411de2a015874e94577dd8a3aae942ddc3e2d00  row-counts.txt
2159f289479be56c4176f39f0e994f4266f6c6c78cc6a7587022865cbd53bdd7  structure.txt
8e5af00c740687161b19e845134541f95c3c9af42332d47c6903ee8790fd3320  gps-archive-manifest.json
d9744dadd80795a7fd138035bf2c058a1e902407105534eb9881a0077d0a2332  manifest.txt
ef961f93746e82a49044c69dbf9a6c7e34e2f410b738b726788e4af045b22c6f  uploads.tar.gz
e761b2528fbb2aeb0cae173359a1f4fefb151e4bb2abc3a10964c988e857449b  db.toc.txt
```

**Restore-test PASS 13/13** (`baseline-r10/restore-test.txt`): восстановление в disposable PG16,
владелец = другая роль, all-data детерминированный fingerprint **точно совпадает** с backup;
74 таблицы / 222 routines / 40 triggers / 178 FK; per-table row counts идентичны; uploads 3/3.
Автоматика: `titanor-time-backup@pilot.timer` + `titanor-time-gps-archive@pilot.timer` (systemd,
без SMTP).

## 5. Зависимости (ТЗ §22 «runtime security findings устранены/приняты»)

| | версия | `npm audit --omit=dev` |
|---|---|---|
| Titanor Time | next **16.3.3** · @prisma/client **6.19.3** · prisma **6.19.3** · react **^19.2.0** | **0 vulnerabilities** |
| публичный сайт | next **16.3.3** · без prisma (удалён в R04) | **0 vulnerabilities** |

Отчёты: `R05_DEPENDENCY_SECURITY_RU.md` (Titanor Time 8 high → 0), `R04_DEPENDENCY_SECURITY_PUBLIC_SITE_RU.md`.
Playwright + Chromium — **dev-only**, в образ не попадают (runner-стадия R06-B выбрасывает dev
node_modules).

## 6. Известные остаточные риски (ТЗ §20 Шаг 10)

| риск | статус |
|---|---|
| **Browser-lane техдолг** — 9 UI-тестов с ожиданиями до 2026-08-20 (i18n / PWA-редизайн / онбординг / T10-D / T13 / R07-A / R09.2) | **не блокер** — 0 дефектов продукта, всё перекрыто db/unit + ручной приёмкой; модернизировать **до R12**. `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4 |
| **R07-A.1** — `guardApiRequest` ещё не раскатан на ~130 route.ts (только на 4 auth-routes + все, что трогали R07–R10) | принят как backlog; CSRF на всех mutating routes — 100 % (R07-A); новые/трогаемые routes обязаны использовать guard |
| **FOREMAN UX** — adaptive nav, bulk-подтверждение, приоритезация task-list | backlog (владелец исключил из R09); не влияет на cutover |
| **Worker GPS notice + PII-политика** | текст утверждает ответственное лицо Titanor; не юридический блокер (внутреннее приложение) |
| **`/mnt/250gb` = US-central регион** (Contabo) | трансграничная передача PII/GPS backup — владелец решает accept vs EU-bucket до R14; механически меняется только `TT_MIRROR_ROOT` |
| **Диск хоста `/` 81 %**, Docker build cache 65 GB | owner action: `docker builder prune` (~43 GB, безопасно) |
| **`/fi` отдаёт `<html lang="en">`** (публичный сайт) | отдельная i18n-задача, не Titanor Time |
| Down-миграций нет (Prisma design) | откат = swap образа; аддитивные миграции толерируются (`/api/ready` `schema:ahead` → 200) |

## 7. Rollback plan (пилот)

Каждый `ops/titanor-time/deploy-pilot-<sha>.sh` содержит авто-rollback при провале verify + ручную
инструкцию. Для текущего кандидата (`edd950c`) назад к R08 (`6a47ed3`), схема не меняется:
```
docker rm -f t97-pilot-app t97-pilot-scheduler
docker rename t97-pilot-app-pre-edd950c t97-pilot-app
docker rename t97-pilot-scheduler-pre-edd950c t97-pilot-scheduler
docker start t97-pilot-app t97-pilot-scheduler
```
Production rollback (R14) — отдельный runbook (`BACKUP_RESTORE_RUNBOOK_RU.md` §restore + ТЗ §21).

## 8. Downtime plan (для R13/R14, не R10)

Cutover-окно (ТЗ §20 Шаг 11): maintenance → стоп старого prod scheduler → freeze записи →
финальный prod backup + checksum → короткий freeze pilot → финальный pilot dump + uploads →
checksum/manifest → restore в prod → secrets/mounts → invalidate sessions → final pending
migrations (на R10 pending = 0) → release image → readiness → scheduler → smoke → `app.titanorgroup.fi`.
Ориентировочно 30–60 мин; точная оценка — R12.
