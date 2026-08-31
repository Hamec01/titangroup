# R14 — production cutover: исполнительный runbook + preflight

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R14; ТЗ §19–§22; `R12_REHEARSAL_RU.md` §4–5
  (репетиция). Этот файл **заменяет** `R12_REHEARSAL_RU.md` §4 как актуальный runbook.
- **Дата подготовки:** 2026-08-31.
- **Образ релиза:** `titanor-time-app:r14-release-1416503`
  (`sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb`).
- **Rollback-образ:** `titanor-time-app:t97-pilot-edd950c` (`sha256:0282e68f…`, rev `edd950c`) — на месте.

> ## ⛔ CUTOVER НЕ НАЧАТ И НЕ РАЗРЕШЁН
> Нужны **два отдельных** подтверждения владельца (roadmap R13 п.2 и п.3):
> 1. конкретное **maintenance-окно** (дата + время, 10 минут);
> 2. **явное разрешение начать production cutover**.
> Pilot acceptance (п.1) уже получено — `R13_ACCEPTANCE_RU.md`.

---

## 0. Обязательные ограничения (владелец, 2026-08-31) — соблюдать на каждом шаге

| # | ограничение |
|---|---|
| C1 | production web bind — **только `127.0.0.1:3199`**. Внешний порт 3199 **не открывать** (ufw не трогать на запись). |
| C2 | **DNS не менять.** `app.titanorgroup.fi` → `84.247.130.242` (DNS only) уже настроен. |
| C3 | после restore, **до запуска scheduler**: `DELETE FROM "SchedulerLease";` |
| C4 | **сначала обязательный backup старой production БД + uploads** (шаг 5), проверить SHA256SUMS. |
| C5 | Caddy: **никаких** `caddy stop/start/run`, **никакого** bare `reload`. Только `caddy validate` / `caddy adapt`, или `caddy reload --address 127.0.0.1:2019` (через админ-API), или `sudo systemctl reload caddy`. |
| C6 | **`docker builder prune` не запускать.** |
| C7 | `app.titanorgroup.fi` держит **503 holding** до шага 15 (переключение — в самом конце окна, уже с рабочим приложением). |
| C8 | не менять production / pilot / Caddy / публичный сайт **до получения обоих подтверждений §0**. |
| C9 | не печатать secrets / cookies / recovery-коды / password hashes / GPS-ключ / координаты. |

---

## 1. Топология нового production-стека

| | |
|---|---|
| контейнеры | `titanor-time-prod-app`, `titanor-time-prod-scheduler`, `titanor-time-prod-db` |
| сеть | `titanor-time-prod-net` (отдельная от `t97-pilot-net` и старого `titanor-time_*`) |
| web bind | **`127.0.0.1:3199`** → контейнерный `:3000` |
| БД | Postgres 16, owner роли restored-объектов — `titanor_time_prod` (не пилотный `t97_app`) |
| env | `/home/deploy/app-data/titanor-time-prod/app.env` — **13 ключей по образцу pilot `app.env`** |
| uploads | `/home/deploy/app-data/titanor-time-prod/uploads` (bind → `/app/uploads`) |
| образ | `titanor-time-app:r14-release-1416503` |
| источник данных | **финальный snapshot пилота** (не старая prod-БД) |

**13 ключей `app.env`** (значения — крипто-ключи те же, что у пилота; `DATABASE_URL` — на новый prod-DB):
`DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`ACTIVATION_TOKEN_HMAC_KEY`, `GPS_ARCHIVE_ENCRYPTION_KEY`, `IDEMPOTENCY_ENCRYPTION_KEY`,
`PASSWORD_RESET_TOKEN_HMAC_KEY`, `PERSONAL_DATA_ENCRYPTION_KEY`,
`NODE_ENV`, `PORT`, `HOSTNAME`, `NEXT_TELEMETRY_DISABLED`.
`TITANOR_TRUSTED_PROXY_HOPS` — **не задавать** (это Вариант B; сейчас Вариант A grey-cloud).

---

## 2. PREFLIGHT (можно и нужно прогнать ДО окна; ничего не меняет)

### 2.1 Уже проверено 2026-08-31 (read-only)

| проверка | результат |
|---|---|
| ветка запушена | `origin/feature/titanor-time-foundation` = `c758caa`, 0 ahead/behind |
| образ релиза | `titanor-time-app:r14-release-1416503` → `sha256:864267bb…`, off-disk tar.gz + sha256 |
| rollback-образ | `titanor-time-app:t97-pilot-edd950c` присутствует (`sha256:0282e68f…`) |
| порт 3199 | **свободен** (не слушает никто); 3200 old-prod, 3297 pilot, 3100 web, 2019 Caddy admin — все на `127.0.0.1` |
| old prod стек | `titanor-time-app-1` (healthy, `:3200`), `titanor-time-db-1` (healthy, DB `titanor_time`, user `titanor_time_app`), `titanor-time-scheduler-1` (**unhealthy** — старый prod scheduler; R14 его заменяет, не блокер) |
| размеры БД | old prod `titanor_time` ≈ 12 MB, pilot `titanor_time_t97` ≈ 16 MB → dump/restore ≈ секунды |
| pilot | `/api/ready` 200 `schema:current` 98/98; app/scheduler/db healthy |
| диск `/` | 84 % (24 GB свободно) — для 16 MB restore хватает с запасом |
| RAM | ~3.3 GB available (+2.2 GB cache) — следить `free -h` во время окна |
| `app.titanorgroup.fi` | `503` holding, заголовки безопасности на месте, TLS OK |
| `titanorgroup.fi` | `307 → /en` (без изменений) |
| Caddy | `active`; бинарь v2.6.2 |
| языковая модель | `LANGUAGE_MODEL_RU.md` — приложение соответствует; правок кода приложения на R14 нет |

### 2.2 Требует владельца / sudo (сделать до окна)

- [ ] `sudo ufw status verbose` — **read-only**; убедиться, что внешний 3199 закрыт (ничего не открывать) — C1.
- [ ] `sudo caddy validate --config /etc/caddy/Caddyfile` — текущий конфиг валиден.
- [ ] `sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.backup-before-r14-<UTC>` — снять бэкап.
- [ ] подготовить содержимое `/home/deploy/app-data/titanor-time-prod/app.env` (13 ключей, §1) — файл создаётся на шаге 9, но значения крипто-ключей взять заранее из pilot `app.env` (в отчёты не копировать).
- [ ] решить `/fi` `<html lang>` (`LANGUAGE_MODEL_RU.md` §2.1): фиксить до R14 / вместе с R14 / после R14.
- [ ] `caddy fmt` косметика Caddyfile — опционально, отдельно.
- [ ] `git fetch` в worktree, убедиться, что HEAD ветки не ушёл вперёд другой сессией.

### 2.3 Заготовки, которые надо доделать до окна (код/скрипты, без деплоя)

- [ ] **Caddy reverse-proxy блок** для `app.titanorgroup.fi`: взять `ops/titanor-time/r11/caddy-app-block.txt`,
      убрать `root`, оба `header {}`, `handle {}`, `handle_errors {}`, добавить строку
      `reverse_proxy 127.0.0.1:3199` (+ оставить `encode`, `log`). Сохранить как
      `ops/titanor-time/r11/caddy-app-block-r14.txt`. Проверить `caddy adapt` в scratchpad
      (с `admin off` в тестовом конфиге — НЕ трогать live admin API; урок инцидента 2026-08-31).
- [ ] **compose/`docker run` для `titanor-time-prod-*`** — по образцу `compose.titanor-time.yaml`
      (порт `127.0.0.1:3199:3000`, сеть `titanor-time-prod-net`, env-file prod, bind uploads prod,
      scheduler = тот же образ, `command: ["node", ".runtime/attendance-auto-submit-scheduler.cjs"]`).
- [ ] **`ops/site/deploy-site-<sha>.sh`** для публикации Employee-login ссылки (образец
      `deploy-site-r07b.sh`) — если ссылку публикуем на R14.
- [ ] прогнать `restore-test-titanor-time.sh` на свежем pilot snapshot ещё раз (disposable) —
      финальная страховка перед окном.

---

## 3. ИСПОЛНЕНИЕ (только после обоих подтверждений §0)

Окно = шаги 6–13 (write-freeze пилота → boot нового prod). Шаги 1–5 — подготовка внутри
maintenance, приложение ещё старое/в holding. Шаги 14–16 — уже с рабочим приложением.

| # | шаг | проверка |
|---|---|---|
| 1 | Объявить начало maintenance. Зафиксировать время. | — |
| 2 | `app.titanorgroup.fi` остаётся **503 holding** (C7). Ничего в Caddy не трогаем. | `curl -I https://app.titanorgroup.fi` → 503 |
| 3 | `docker stop titanor-time-scheduler-1` (старый prod scheduler). | контейнер stopped |
| 4 | `docker stop titanor-time-app-1` (старый prod web). | `curl 127.0.0.1:3200` — отказ |
| 5 | **ОБЯЗАТЕЛЬНО (C4): финальный backup старой prod-БД + uploads.** `TT_ENV=old-prod TT_DB_CONTAINER=titanor-time-db-1 TT_DB_USER=titanor_time_app TT_DB_NAME=titanor_time TT_UPLOADS_DIR=/home/deploy/app-data/titanor-time/uploads TT_APP_CONTAINER=titanor-time-app-1 bash ops/titanor-time/backup-titanor-time.sh pre-migration` | `SHA256SUMS` verify OK; manifest: migrations, row counts |
| 6 | **Write-freeze пилота:** `docker stop t97-pilot-scheduler t97-pilot-app` (БД пилота оставляем). | pilot `:3297` — отказ |
| 7 | **Финальный snapshot пилота:** `bash ops/titanor-time/backup-titanor-time.sh manual` (дефолты = пилот). Сверить SHA-256, sizes, migrations=98, row counts. Запомнить каталог `pilot-<UTC>-manual`. | `SHA256SUMS` OK, 98 миграций |
| 8 | Создать сеть+БД: `docker network create titanor-time-prod-net`; поднять `titanor-time-prod-db` (postgres:16, том `titanor-time-prod-db-data`, env-file prod, только в prod-net); `createdb`/init роль `titanor_time_prod`. | `pg_isready` OK |
| 9 | Создать `/home/deploy/app-data/titanor-time-prod/{app.env,uploads/}`. `app.env` — 13 ключей (§1); `DATABASE_URL` → `titanor-time-prod-db`. **Секреты в отчёты не писать.** | `app.env` 13 ключей, `chmod 600` |
| 10 | `pg_restore --no-owner --no-acl` snapshot (шаг 7) в prod-БД под owner `titanor_time_prod`. Восстановить pilot uploads в `…/titanor-time-prod/uploads`, сверить с manifest. | restore без ошибок; uploads = manifest |
| 11 | **В restored БД (C3):** `DELETE FROM "UserSession";` затем `DELETE FROM "SchedulerLease";` (по желанию — просроченные recovery/activation токены). | обе таблицы: 0 строк |
| 12 | `prisma migrate deploy` против prod-БД (ожидается: pending нет, схема current). | `migrate status` up to date |
| 13 | `docker run` **web** из `titanor-time-app:r14-release-1416503`, порт **`127.0.0.1:3199:3000`** (C1), env-file prod, bind uploads, сеть prod-net. Дождаться `/api/ready`. | `curl 127.0.0.1:3199/api/ready` → 200, `schema:current`, applied=expected=98, aheadBy 0 |
| 14 | `docker run` **scheduler** из того же образа (`command` scheduler), env-file prod, только prod-net. Дождаться ≥2 успешных тика, `node .runtime/attendance-scheduler-healthcheck.cjs` exit 0, нет `OVERLAPPING`. | healthcheck exit 0; heartbeat `lastOutcome:ok`, `consecutiveFailures:0` |
| 15 | Сверить с финальным manifest (шаг 7): row counts по таблицам, migration status. | всё совпало |
| 16 | **Owner smoke на `127.0.0.1:3199`** (SSH-туннель): вход SUPER_ADMIN / ADMIN / WORKER / FOREMAN (реальные аккаунты), clock + GPS + offline, отчёты worker/site/period + PDF + CSV, uploads. | все роли входят; clock/reports/uploads работают |
| 17 | **Caddy switch (C5):** заменить блок `app.titanorgroup.fi` на reverse-proxy вариант (`caddy-app-block-r14.txt`). `sudo cp` бэкап Caddyfile → правка → `sudo caddy validate --config /etc/caddy/Caddyfile` → `sudo systemctl reload caddy` (или `caddy reload --address 127.0.0.1:2019`). | `caddy validate` = Valid; `systemctl is-active caddy` = active; `curl -I https://app.titanorgroup.fi` → 200, `/api/ready` 200 |
| 18 | (Если решено) Опубликовать Employee-login ссылку на `titanorgroup.fi`: `ops/site/deploy-site-<sha>.sh` (build → backup volume → throwaway smoke → swap с auto-rollback → re-check, что Titanor Time и другие vhost не задеты). | `titanorgroup.fi/en` и `/fi` показывают ссылку; регрессия vhost чиста |
| 19 | Завершить maintenance. Зафиксировать время открытия и фактический downtime. Старую prod-БД/стек **не удалять**. | — |

---

## 4. Downtime и maintenance-окно

- **Реальный простой приложения:** ~1–2 минуты (шаги 6→13: stop pilot → dump ~сек (16 MB) →
  restore ~10 с → migrate ~5 с (pending нет) → web ready ~4 с → сверка). Scheduler берёт lease
  сразу; первый auto-submit tick ~3 мин на доступность входа/клока не влияет.
- **Backup старой prod-БД** (шаг 5) ~1–2 мин — приложение уже в maintenance.
- **Планируемое окно: 10 минут** (запас на сверку и решение go/no-go).
- Шаги 17–18 (Caddy switch, ссылка) — уже с рабочим приложением, вне «жёсткого» простоя.

## 5. Rollback (немедленный)

**Триггеры:** restore/checksum/row-counts не сошлись; `/api/ready` не проходит; scheduler без
тиков или `OVERLAPPING`; ключевые роли не входят; clock/uploads системно сломаны; потеря данных;
TLS/Caddy ведёт не туда.

| # | шаг | время |
|---|---|---|
| 1 | `docker stop titanor-time-prod-scheduler titanor-time-prod-app` | ~0.5 с |
| 2 | Если Caddy уже переключён (шаг 17): вернуть блок `app.titanorgroup.fi` на **503 holding** (бэкап Caddyfile) → `caddy validate` → `systemctl reload caddy`. Если cutover прервался до шага 17 — Caddy не трогаем (уже 503). | ~10 с |
| 3 | Снять write-freeze со старого prod: `docker start titanor-time-db-1 titanor-time-app-1 titanor-time-scheduler-1`. (Старую prod-БД восстанавливать из backup шага 5 только если она была изменена — по плану R14 её не трогаем вообще.) | ~5 с |
| 4 | Снять write-freeze с пилота: `docker start t97-pilot-app t97-pilot-scheduler`. Проверить `/api/ready` 200. | ~10 с |
| 5 | Зафиксировать причину. Не удалять `titanor-time-prod-*` до разбора. | — |

Репетиция rollback (`R12_REHEARSAL_RU.md` §3): stop нового стека → restore предыдущего dump →
boot `t97-pilot-edd950c` → `/api/ready` `schema:current` — **PASS**, ~17 с механики.

## 6. После cutover

- R15 — наблюдение (`PRODUCTION_RELEASE_ROADMAP_RU.md` R15).
- Старый стек `titanor-time-*-1` — оставить остановленным как быстрый rollback ≥ до конца R15.
- `docker builder prune` — только когда владелец готов (сейчас C6 запрещает).
- Вариант B (orange-cloud + `trusted_proxies_strict` + `TITANOR_TRUSTED_PROXY_HOPS=2`) — отдельно после R15.
