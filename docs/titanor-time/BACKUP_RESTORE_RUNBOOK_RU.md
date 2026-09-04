# Titanor Time — Backup / Restore runbook (R01)

> **Обновление 2026-09-04.** Production backup — **работает и автоматизирован**. Таймеры
> `titanor-time-backup@production.timer` + `titanor-time-gps-archive@production.timer` enabled+active
> (env в `/etc/titanor-time/`, root:root 0600). Автопрогоны идут ежедневно, on-box + off-box
> `SHA256SUMS` OK. Текущий prod-образ в манифестах бэкапа — `titanor-time-app:d7f-d216482`, схема
> **100/100**. Deploy-интеграция (§7): `pre-deploy` / `pre-migration` бэкапы делаются перед каждым
> web-swap; последний — `production-20260903T175352Z-pre-deploy` (Deploy F, restore-test 13/13).
> **`@pilot` таймеры отключены.** Параметры для production-прогона:
> `TT_ENV=production TT_DB_CONTAINER=titanor-time-prod-db TT_DB_USER=titanor_time_prod TT_DB_NAME=titanor_time`
> `TT_UPLOADS_DIR=/home/deploy/app-data/titanor-time-prod/uploads TT_APP_CONTAINER=titanor-time-prod-app`
> `TT_BACKUP_ROOT=/home/deploy/backups/titanor-time-production`
> `TT_MIRROR_ROOT=/mnt/250gb/titanor-time-foundation/backups/production`.
> ⚠️ **Не путать** с `titanorgroup-backup.service` (backup ПУБЛИЧНОГО САЙТА, отдельный root-скрипт
> `/usr/local/sbin/backup-titanorgroup.sh`) — он в состоянии failed с ~2026-09-01, это НЕ Titanor
> Time и требует root-оператора (`fixroad.md` F04).

- **Основание:** roadmap R01, TZ §10.
- **Дата:** 2026-08-29. Первый проверенный backup + restore-test.
- **Скрипты:** `ops/titanor-time/backup-titanor-time.sh`, `ops/titanor-time/restore-test-titanor-time.sh`.
- **Юниты systemd:** `ops/titanor-time/systemd/`.
- **Вердикт задачи:** **PASS**. Квота Contabo подтверждена владельцем 2026-08-30 (бакет
  `Object Storage US-central 3629`, 250 GB куплено, 3.03 MB занято, region US-central). Блокер
  B02 закрыт. Открытый вопрос GDPR (US-регион для PII/GPS-бэкапов) — решение владельца до R14,
  механически не блокирует (см. `RELEASE_BASELINE_2026-08-29_RU.md` §6).

Правила: скрипты **не печатают** секреты, `DATABASE_URL`, токены, GPS-координаты и содержимое
строк. Backup — только пилота (production backup — отдельный шаг R12/R14). Существующие backups
не удаляются.

---

## 1. Что такое один backup

`backup-titanor-time.sh <reason>` создаёт **один каталог**
`<TT_BACKUP_ROOT>/<env>-<UTC>-<reason>/`:

| Файл | Что |
|---|---|
| `db.dump` | `pg_dump -F c` — полный custom-format архив (restore: `pg_restore --no-owner --no-acl`) |
| `db.toc.txt` | `pg_restore --list` архива — доказывает, что архив парсится **до** любого restore |
| `uploads.tar.gz` | tar каталога uploads (структура + права); при пустом uploads вместо него `uploads.empty` |
| `structure.txt` | счётчики: миграции / tables / routines / triggers / FK (без содержимого строк) |
| `row-counts.txt` | точный `count(*)` по каждой public-таблице (без содержимого) |
| `migration-history.sha256` | SHA-256 списка `migration_name + checksum` (без timestamps → стабилен при restore) |
| `data.sha256` | детерминированный SHA-256 **всех строк всех таблиц** (метод T9.6: `--data-only --inserts`, снять `\restrict`, `LC_ALL=C sort`, sha256) |
| `manifest.txt` | env, UTC, host, git SHA/branch, uncommitted-count, образ, размеры, TOC-entries, structure, оба хэша |
| `SHA256SUMS` | sha256 каждого файла выше |

Атомарность: всё пишется в `.stage-*` рядом, затем `mv` в финальное имя. Параллельный запуск
блокируется `flock` (`/tmp/titanor-time-backup-<env>.lock`, exit 3). Битая БД (unfinished/
rolled-back миграции) → backup **не создаётся** (exit 1).

**reason:** `scheduled` | `pre-deploy` | `pre-migration` | `manual`.

**Off-box копия:** если задан `TT_MIRROR_ROOT` (s3fs), каталог копируется туда и его `SHA256SUMS`
**перепроверяется с off-box копии**. Сбой копии — WARNING (не fatal): локальный backup цел.

## 2. Ротация

`scheduled`-backups: newest `TT_KEEP_DAILY` (7) + по одному на ISO-неделю до `TT_KEEP_WEEKLY` (4)
+ по одному на месяц до `TT_KEEP_MONTHLY` (12). `pre-deploy`/`pre-migration`/`manual` — по возрасту
(`TT_KEEP_EVENT_DAYS`, 30 дней). Скрипт трогает **только** каталоги вида
`<env>-*-{scheduled,pre-deploy,pre-migration,manual}` в `TT_BACKUP_ROOT`; off-box копию не чистит
никогда; старые `t97-pilot-*.dump` (ручные из ранних сессий) не совпадают с шаблоном и не трогаются.

## 3. Ручной backup пилота

```bash
cd /home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
TT_BACKUP_ROOT=/home/deploy/backups/titanor-time-pilot \
TT_MIRROR_ROOT=/mnt/250gb/titanor-time-foundation/backups/pilot \
bash ops/titanor-time/backup-titanor-time.sh manual
```

(остальные переменные по умолчанию уже нацелены на пилот — см. шапку скрипта.)

## 4. Restore-test

```bash
bash ops/titanor-time/restore-test-titanor-time.sh <каталог-бэкапа>
```

Делает (ничего не трогает в пилоте/проде):
1. копирует backup в локальный `/tmp` (Docker не умеет bind-mount с FUSE) и **перепроверяет
   `SHA256SUMS`** — это же доказывает, что off-box копия перенеслась целой;
2. поднимает одноразовый `postgres:16` (своя сеть + volume, имена `tt-restore-test-<UTC>-<pid>-*`);
3. `pg_restore --no-owner --no-acl --exit-on-error` в свежую БД с ролью-владельцем
   `tt_restore_owner` (**намеренно не** исходная роль — проверка owner-independence);
4. сверяет с записанным в бэкапе: миграции (кол-во, 0 битых, history-хэш), structure, per-table
   row counts (полный `diff`), `data.sha256`;
5. распаковывает `uploads.tar.gz`, сверяет число файлов с manifest;
6. **опционально** (`TT_SMOKE=1 TT_SMOKE_IMAGE=<образ> TT_SMOKE_ENVFILE=<env>`): поднимает
   release-образ против восстановленной БД, ждёт `/api/ready = 200`;
7. удаляет все одноразовые ресурсы по точному имени (trap на EXIT).

Пример с smoke:
```bash
TT_SMOKE=1 TT_SMOKE_IMAGE=titanor-time-app:t97-pilot-f486977 \
TT_SMOKE_ENVFILE=/home/deploy/app-data/t97-pilot/app.env \
bash ops/titanor-time/restore-test-titanor-time.sh /home/deploy/backups/titanor-time-pilot/<...>
```

## 5. Выполненное доказательство (2026-08-29)

**Backup** `pilot-20260829T212153Z-manual` (SHA `a02b616`, образ `t97-pilot-f486977`):
- `db.dump` 474 396 B, `pg_restore --list` → **710 TOC entries**;
- 93 миграции применены, 0 unfinished/rolled-back;
- 71 tables / 221 routines / 39 triggers / 177 FK; 1518 строк всего;
- `uploads.tar.gz` — 3 файла;
- off-box копия на s3fs: скопирована, `SHA256SUMS` перепроверен с Contabo — **OK**.

**Restore-test — оба источника PASS:**

| Проверка | Локальный backup | Off-box (s3fs) копия |
|---|:--:|:--:|
| `SHA256SUMS` verify (staged) | PASS | PASS |
| `pg_restore --no-owner --no-acl --exit-on-error` | PASS | PASS |
| миграции 93 == backup, 0 битых, history-хэш | PASS | PASS |
| structure 71/221/39/177 == backup | PASS | PASS |
| per-table row counts — все 71 таблицы идентичны | PASS | PASS |
| **all-data fingerprint == backup (точное совпадение всех строк)** | PASS | PASS |
| uploads: 3 файла == manifest | PASS | PASS |
| app smoke: release-образ против restored DB → `/api/ready=200` | PASS | — |

Все одноразовые контейнеры/сети/volumes удалены. Production: образ `daa2edbb`, `StartedAt`
`2026-08-21T19:40:56Z`, `RestartCount 0` — **не изменялись**.

## 6. Включение ежедневного таймера — требуется root (владелец)

Агент не имеет passwordless-sudo; юниты устанавливает владелец. Квота Contabo подтверждена
(250 GB / занято 3 MB), можно сразу с `TT_MIRROR_ROOT`.

```bash
# 1. config (НЕ содержит секретов — только имена/пути)
sudo install -d -m 0755 /etc/titanor-time
sudo install -m 0600 -o root -g root \
  /home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation/ops/titanor-time/systemd/backup-pilot.env.example \
  /etc/titanor-time/backup-pilot.env
#   (при необходимости отредактировать; чтобы отключить off-box копию — TT_MIRROR_ROOT=)

# 2. юниты
sudo install -m 0644 \
  /home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation/ops/titanor-time/systemd/titanor-time-backup@.service \
  /home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation/ops/titanor-time/systemd/titanor-time-backup@.timer \
  /home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation/ops/titanor-time/systemd/titanor-time-backup-failed@.service \
  /etc/systemd/system/
sudo systemctl daemon-reload

# 3. разовый прогон + включение таймера
sudo systemctl start titanor-time-backup@pilot.service
journalctl -u titanor-time-backup@pilot.service -n 30 --no-pager
sudo systemctl enable --now titanor-time-backup@pilot.timer
systemctl list-timers 'titanor-time-backup@*' --no-pager
```

Расписание: `04:10 UTC` ежедневно (после `titanorgroup-backup.timer` 03:30 local, чтобы не
конкурировать за s3fs). Сбой → `titanor-time-backup-failed@pilot.service` пишет
`/home/deploy/backups/titanor-time-pilot/BACKUP_FAILED.log` + строку в journal (`logger -t
titanor-time-backup`). Почта/SMTP не используется (решение владельца).

## 7. pre-deploy / pre-migration backup (интеграция с деплоем)

Скрипты деплоя пилота (`/home/deploy/app-data/t97-pilot/deploy-*.sh`) уже снимают dump
самостоятельно. Впредь их первый шаг заменяется на:
```bash
bash <repo>/ops/titanor-time/backup-titanor-time.sh pre-deploy
```
(и `pre-migration`, если миграции запускаются отдельно). Это даёт полный комплект (dump + uploads +
manifest + checksums), а не одинокий `.dump`.

## 8. Реальное восстановление (не тест) — эскиз для R14

Полная процедура cutover — roadmap R14 / TZ §20 шаг 11. Кратко:
```bash
# в целевую (пустую) БД, с правильным owner:
docker run --rm --network <net> -v /tmp/<staged-backup>:/b:ro -e PGPASSWORD=<...> postgres:16 \
  pg_restore --no-owner --no-acl --exit-on-error -h <db-host> -U <prod-role> -d <prod-db> /b/db.dump
# uploads:
tar -C <prod-uploads-dir> -xzf /tmp/<staged-backup>/uploads.tar.gz
# затем: сверить row-counts.txt и data.sha256, применить только ожидаемые pending migrations,
# запустить release-образ, проверить schema-aware readiness — см. R14.
```
Никогда не открывать приложение до сверки row counts, миграций, файлов и ролей (TZ §21).

## 9. Rollback backup-настройки

Ничего в production не менялось. Чтобы откатить саму backup-настройку:
```bash
sudo systemctl disable --now titanor-time-backup@pilot.timer
sudo rm /etc/systemd/system/titanor-time-backup@.{service,timer} \
        /etc/systemd/system/titanor-time-backup-failed@.service \
        /etc/titanor-time/backup-pilot.env
sudo systemctl daemon-reload
```
Созданные backup-каталоги удалять не нужно (и по правилам — нельзя без отдельного решения).
