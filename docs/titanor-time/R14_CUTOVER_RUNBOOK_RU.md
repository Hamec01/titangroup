# R14 — production cutover: исполнительный runbook + preflight

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R14; ТЗ §19–§22; `R12_REHEARSAL_RU.md` §4–5
  (репетиция). Этот файл **заменяет** `R12_REHEARSAL_RU.md` §4 как актуальный runbook.
- **Дата подготовки:** 2026-08-31.
- **Образ релиза:** `titanor-time-app:r14-release-1416503`
  (`sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb`).
- **Rollback-образ:** `titanor-time-app:t97-pilot-edd950c` (`sha256:0282e68f…`, rev `edd950c`) — на месте.

> ## ✅ R14 CUTOVER PASS
> **Статус 2026-08-31:** runbook выполнен. Новый production-стек healthy, Caddy переключён на
> `127.0.0.1:3199`, публичный `/api/ready` 200 `schema:current` 98/98, public-site login links
> задеплоены. Старый production и pilot app/scheduler сохранены остановленными для rollback.
> Фактические доказательства, таймлайн и backup paths: `R14_CUTOVER_REPORT_RU.md`.

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

**Автоматизировано:** `bash ops/titanor-time/r14/preflight-r14.sh` — 32 read-only проверки, без
sudo, ничего не меняет. Последний прогон 2026-08-31 18:23 EEST: **32 PASS / 0 FAIL / 3 TODO**
(TODO = prod `app.env` ещё не создан; git-sync — закрыт коммитом `184263e`). Прогонять перед
каждым окном.

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

### 2.3 Заготовки — ГОТОВЫ (2026-08-31, коммиты `184263e` + `af829fe`)

- [x] **Caddy reverse-proxy блок** — `ops/titanor-time/r14/caddy-app-block-r14.txt`
      (`reverse_proxy 127.0.0.1:3199` + минимальные заголовки как в pilot-блоке). `caddy validate`
      обеих сторон (switch и `--rollback`) в scratchpad — **Valid configuration**.
- [x] **`titanor-time-prod-*` стек** — не отдельный compose, а `ops/titanor-time/r14/cutover-r14.sh`
      (`docker run` web `127.0.0.1:3199:3000` + scheduler, сеть `titanor-time-prod-net`, том
      `titanor-time-prod-db-data`, env-file prod). Механика restore/boot/reconcile/rollback —
      та, что дала 10/10 в `r12-rehearsal.sh`.
- [x] **`ops/site/deploy-site-r14.sh`** — публикует `af829fe` (`/fi` `<html lang>` + Employee-login
      ссылка). `VERIFY_PORT=3198` (3199 занят prod). Smoke-first + auto-rollback.
- [x] **disposable `restore-test`** на свежем post-cleanup snapshot `pilot-20260831T152444Z-manual`
      с образом релиза — **14/14 PASS** (98 миграций, все 74 row counts, fingerprint, uploads 3,
      `/api/ready` 200).

**Осталось только от владельца:** создать `/home/deploy/app-data/titanor-time-prod/app.env`
(13 ключей, крипто-ключи скопировать из pilot `app.env`, `chmod 600`), назначить окно, дать
разрешение. Всё остальное готово.

---

## 3. ИСПОЛНЕНИЕ (только после обоих подтверждений §0)

**Три команды, в этом порядке** (точный список с sudo — §7):

1. `bash ops/titanor-time/r14/preflight-r14.sh` — финальный read-only gate (без sudo). Должно быть 0 FAIL.
2. `bash ops/titanor-time/r14/cutover-r14.sh --go` — runbook шаги 3–16 (без sudo, без Caddy, без DNS).
   Fail-closed: любая ошибка → авто-rollback (old prod + pilot обратно). Внутри — обязательный
   backup старой prod-БД (C4), `DELETE FROM "SchedulerLease"` (C3), bind только `127.0.0.1:3199` (C1).
3. **Владелец, sudo:** `sudo bash ops/titanor-time/r14/apply-caddy-r14.sh` — шаг 17 (switch Caddy).
4. (если решено) `bash ops/site/deploy-site-r14.sh` — шаг 18 (Employee-login ссылка + `/fi` lang).

Между шагом 2 и 3 — **owner smoke на `http://127.0.0.1:3199`** (SSH-туннель), пока `app.titanorgroup.fi`
ещё на 503. Если smoke плохой — `bash ops/titanor-time/r14/rollback-r14.sh`, Caddy не трогали.

Окно = внутренняя часть шага 2 (freeze пилота → boot нового prod, ~1–2 мин). Ниже — что делает
каждый шаг и как проверяется (скрипт делает это сам):

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
| 17 | **Caddy switch (C5) — владелец, sudo:** `sudo bash ops/titanor-time/r14/apply-caddy-r14.sh`. Скрипт: проверяет `127.0.0.1:3199/api/ready` 200 → baseline 5 vhost → бэкап Caddyfile → swap блок `app.titanorgroup.fi` на `reverse_proxy 127.0.0.1:3199` → `caddy validate` → `systemctl reload caddy` → verify + регрессия. Fail-closed. | `caddy validate` = Valid; `https://app.titanorgroup.fi/api/ready` 200 `schema:current`; `/login` 200; 5 vhost без изменений |
| 18 | (Если решено) `bash ops/site/deploy-site-r14.sh` — Employee-login ссылка + `/fi` `<html lang>` (`af829fe`). build → backup обоих volume on+off box → throwaway smoke `:3198` → swap с auto-rollback → re-check `titanor-time-prod-*` не задет. | `/en` и `/fi` показывают ссылку на `app.titanorgroup.fi`; `/fi` FI-контент; регрессия vhost чиста |
| 19 | Завершить maintenance. Зафиксировать время открытия и фактический downtime. Старую prod-БД/стек **не удалять** (rollback-таргет ≥ до конца R15). | — |

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

- **Во время шага 2 (`cutover-r14.sh`):** любая ошибка → **авто-rollback** внутри скрипта
  (stop/rm `titanor-time-prod-*` web+scheduler, `docker start` old prod db+web+scheduler,
  `docker start` пилот). Старую prod-БД скрипт только читал (`pg_dump`) — восстанавливать нечего.
- **Вручную** (после «успешного» cutover, до/после Caddy): `bash ops/titanor-time/r14/rollback-r14.sh`
  (то же самое; без sudo).
- **Если Caddy уже переключён (после шага 17):** дополнительно
  `sudo bash ops/titanor-time/r14/apply-caddy-r14.sh --rollback` — вернёт `app.titanorgroup.fi`
  на 503 holding (проверено offline, конфиг после отката байт-в-байт равен текущему live).

| # | что | время |
|---|---|---|
| 1 | `docker rm -f titanor-time-prod-app titanor-time-prod-scheduler` (prod-db + том оставить для разбора) | ~0.5 с |
| 2 | Caddy: если переключали — `sudo bash ops/titanor-time/r14/apply-caddy-r14.sh --rollback`. Не переключали — не трогаем (уже 503). | ~10 с |
| 3 | `docker start titanor-time-db-1` → `docker start titanor-time-app-1 titanor-time-scheduler-1` | ~5 с |
| 4 | `docker start t97-pilot-app t97-pilot-scheduler` → `/api/ready` 200 на `:3200` и `:3297` | ~10 с |
| 5 | Зафиксировать причину. `titanor-time-prod-db` + том `titanor-time-prod-db-data` не удалять до разбора. | — |

Репетиция rollback (`R12_REHEARSAL_RU.md` §3): stop нового стека → restore предыдущего dump →
boot `t97-pilot-edd950c` → `/api/ready` `schema:current` — **PASS**, ~17 с механики.

---

## 6. Точный список команд (для владельца)

Не-sudo команды может выполнить агент; **sudo — только владелец в своём терминале.**
`REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation`

### 7.1 До окна

| # | кто | команда |
|---|---|---|
| P1 | владелец, sudo | `sudo ufw status verbose` — read-only, убедиться внешний 3199 закрыт, **ничего не открывать** |
| P2 | владелец, sudo | `sudo caddy validate --config /etc/caddy/Caddyfile` → `Valid configuration` |
| P3 | владелец | создать `/home/deploy/app-data/titanor-time-prod/app.env` — 13 ключей (§1), крипто-ключи скопировать из `/home/deploy/app-data/t97-pilot/app.env`, `DATABASE_URL=postgresql://titanor_time_prod:<pw>@titanor-time-prod-db:5432/titanor_time`, `POSTGRES_USER=titanor_time_prod`, `POSTGRES_DB=titanor_time`, `PORT=3000`, `HOSTNAME=0.0.0.0`, `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`. Затем `chmod 600`. |
| P4 | агент/владелец | `bash $REPO/ops/titanor-time/r14/preflight-r14.sh` → **0 FAIL** |

### 7.2 В окне

| # | кто | команда | ожидание |
|---|---|---|---|
| 1 | агент/владелец | `bash $REPO/ops/titanor-time/r14/preflight-r14.sh` | 0 FAIL |
| 2 | агент/владелец | `bash $REPO/ops/titanor-time/r14/cutover-r14.sh --go` | `CUTOVER STEPS 3–16: OK` |
| 3 | владелец | SSH-туннель + smoke на `http://127.0.0.1:3199` (4 роли, clock/GPS/offline, отчёты, uploads) | всё работает |
| 4 | **владелец, sudo** | `sudo bash $REPO/ops/titanor-time/r14/apply-caddy-r14.sh` | `R14 Caddy switch OK` |
| 5 | агент/владелец | (если решено) `bash $REPO/ops/site/deploy-site-r14.sh` | `DEPLOY OK` |
| 6 | владелец | зафиксировать время открытия и фактический downtime | — |

### 7.3 Rollback (если что-то не так)

| ситуация | команда |
|---|---|
| ошибка внутри шага 2 | ничего — `cutover-r14.sh` откатывается сам |
| плохой smoke (шаг 3), Caddy ещё не трогали | `bash $REPO/ops/titanor-time/r14/rollback-r14.sh` |
| плохо после шага 4 (Caddy уже переключён) | `sudo bash $REPO/ops/titanor-time/r14/apply-caddy-r14.sh --rollback` **и** `bash $REPO/ops/titanor-time/r14/rollback-r14.sh` |
| плохой деплой сайта (шаг 5) | `deploy-site-r14.sh` откатывается сам; вручную: `docker rm -f titanorgroup-web-1 && docker rename titanorgroup-web-1-pre-r14 titanorgroup-web-1 && docker start titanorgroup-web-1` |

## 7. После cutover

- R15 — наблюдение (`PRODUCTION_RELEASE_ROADMAP_RU.md` R15).
- Старый стек `titanor-time-*-1` — оставить остановленным как быстрый rollback ≥ до конца R15.
  Пилот `t97-pilot-app`/`-scheduler` — тоже остаются остановленными (frozen); `t97-pilot-db`
  можно оставить up для сверки. Пилотный URL `t97-…nip.io` начнёт отдавать 502 — это ожидаемо,
  vhost можно убрать из Caddy позже отдельно.
- Убрать rollback-контейнеры сайта (`docker rm titanorgroup-web-1-pre-r14`) и `-pre-*` пилота —
  только когда владелец доволен, вручную.
- `docker builder prune` — только когда владелец готов (сейчас C6 запрещает).
- Вариант B (orange-cloud + `trusted_proxies_strict` + `TITANOR_TRUSTED_PROXY_HOPS=2`) — отдельно после R15.
- Обновить `IMPLEMENTATION_STATUS.md`, `NEXT_AGENT_HANDOFF_RU.md`, память; написать R14-отчёт
  (фактический downtime, версии/образы, health/ready, вход по ролям, scheduler, Caddy/TLS,
  публичный сайт, готовность rollback) — как просил владелец.
