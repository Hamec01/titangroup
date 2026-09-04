# R15-D7 Deploy F — production deploy report («Часы заказчику»)

> **СТАТУС (обновлено 2026-09-04, после §7):**
> **Текущий prod-образ — `titanor-time-app:d7f-fd8494c`** (2-й web-only swap, 2026-09-04 ~15:43 UTC,
> владелец отдельно разрешил — см. §7). Содержит: Deploy F («Часы заказчику», live с 2026-09-03) +
> запись «Что нового» `/guide` (`c76d439`) + F03 «часто нет GPS-сигнала» в пояснительном режиме
> (`2fa0d5d`+`e5b1a42`). Обе проверены live на `/guide`.
>
> **Полный R15 owner sign-off НЕ дан.** Остаются: реальная device-приёмка на Android (F02),
> восстановление backup публичного сайта (F04 — владелец выполняет root-диагностику сам),
> процесс разбора открытых исключений начальником. Meyer-галочку владелец включит сам через UI.
> **Production без явного разрешения владельца не обновлять. Новых тестовых данных на production
> не создавать.**

- **Дев/disposable-отчёт:** `R15_D7_DEPLOY_F_REPORT_RU.md` (что вошло, движок, тесты — §1–§3).
- **Этот отчёт:** только production-развёртывание 2026-09-03 и его открытые пункты.
- **Метод:** на production — только read-only проверки. Ни одного write. Тесты — на disposable.

---

## 1. Разрешение владельца (2026-09-03)

Цитата (из рабочей переписки):

> «Ок на `d7f-d216482`, делай swap. Больше коммитов не будет; деплой строго с `d216482`. Разрешаю
> только web-only `docker stop`/`rename`/`run` для `titanor-time-prod-app`, без миграций,
> scheduler/Caddy/DNS/БД не менять.»

Это разрешение **на сам swap**. Отдельный **sign-off, что Deploy F production-live** и что R15-D7
закрыт — по указанию 2026-09-04 даётся только после ревью этого отчёта.

---

## 2. Идентичность образа

| | |
|---|---|
| Тег | `titanor-time-app:d7f-d216482` |
| `org.opencontainers.image.revision` | `d216482` |
| Git-коммит образа | `d216482` (`fix(time): Deploy F swap/rollback — guard the readiness curl under set -e`) |
| Runtime в образе | код `d216482`; ops-коммиты `9e70e07` / `defa11f` / `6e6dc12` в standalone-бандл **не входят** |
| Отличие от протестированного дев-образа `d7f-18c2091` | снят лимит `take:200` в `resolveCustomerReadiness` (`fc60ac0`/`486c150`) + регрессионный тест; фикс `curl`-под-`set -e` в ops-скрипте (`d216482`) |
| Миграция | **нет** — `workAreaId` на сегментах с Миграции 1; схема остаётся **100** |
| **Запись «Что нового» `/guide` (`c76d439`)** | **НЕ в этом образе** — `c76d439` позже `d216482`. Появится на prod только при следующем деплое приложения. |

Disposable-перепроверка на `d216482` (production не тронут): db lane **64/64** (вкл. новый
readiness-тест), `_test-customer-report-scope-ui` **17/17**. Полный аудит-прогон на `d7f-d216482`
(fixroad F01): browser harness **19 pass / 0 fail / 2 SKIP-HARNESS**, оба dedicated-runner'а PASS,
unit **18/18**, scheduler **5/5**, typecheck / lint / `next build` clean.

---

## 3. Хронология развёртывания 2026-09-03

### 3.1 Подготовка (read-only)

| шаг | результат |
|---|---|
| Backup | `production-20260903T175352Z-pre-deploy` (on-box + off-box), `restore-test` **13/13**, 2399 строк, 100 миграций |
| Кандидат `d7f-d216482` на `127.0.0.1:3198` против **реальной prod-БД** | `/api/ready` 200 `current 100/100`, healthy, лог чистый; `/login` 200 · `/reset-password` 200 · `/admin/reports/customer` 307→login · `GET …/reports/customer/scope?action=search` (без сессии) 401 · неверные креды 401. **Только чтение.** |

### 3.2 Попытка 1 — НЕ удалась, авто-откат сработал

- **T0** `docker stop` 2026-09-03 **19:08:58.2Z** (образ `d7f-18c2091`).
- Причина сбоя: `deploy-f-swap.sh` после ревью получил `set -euo pipefail`; в цикле ожидания
  готовности `code=$(curl … /api/ready)` стал фатальным — новый контейнер ещё поднимался (~1–2 c),
  первый `curl` вышел с кодом 56 → `set -e` оборвал скрипт на 1-й итерации → сработал EXIT-trap
  авто-восстановления.
- Старый контейнер (`d7e-5cce319`) возвращён под именем `titanor-time-prod-app` в **19:09:09.7Z**.
- **Простой ≈ 11.5 c** (Caddy отдавал 503). Схему/БД/scheduler не трогали. `/api/ready` 200
  `current 100/100` локально и через Caddy сразу после отката.
- **Исправление:** `code=$(curl … || true)` в цикле обоих скриптов (`-w` всё равно пишет код);
  `set -e` для остальных шагов и trap сохранены. Коммит `d216482`, образ пересобран как
  `d7f-d216482`.

### 3.3 Попытка 2 — успешный web-only swap

| шаг | время (UTC) |
|---|---|
| `docker stop -t 30 titanor-time-prod-app` | **19:34:00.875Z** |
| контейнер остановлен | 19:34:01.492Z |
| `docker rename titanor-time-prod-app → titanor-time-prod-app-pre-d216482` | 19:34:01–02Z |
| `docker run` новый (идентичный конфиг: сеть `titanor-time-prod-net`, `-p 127.0.0.1:3199:3000`, uploads-bind, тот же `--env-file`, healthcheck 15s/5s/40s/×4, `--restart unless-stopped`) | 19:34:02.360Z |
| **`/api/ready` 200** | **19:34:04.128Z** |
| **Простой ≈ 2.6 c** | |
| `healthy` | через ~45 c |

### 3.4 Пост-swap проверки — только read-only (live prod, через Caddy)

- `/api/ready` → **200 `current 100/100`** (локально и через Caddy);
- `/login` 200, `/reset-password` 200, `/worker` 307, `/admin` 307, `/admin/reports/customer` 307,
  `/admin/reports/sites` 307;
- `GET /api/admin/reports/customer/scope?action=search` без сессии → **401** (роут на месте);
- неверные креды → `INVALID_CREDENTIALS` (чистый отказ, не 500);
- лог приложения после swap — **чистый** (только строки старта Next.js);
- scheduler (`r14-release-1416503`) — **не трогали**, тикает раз в минуту, `runnerOutcome: ok`,
  `failed: 0` (тик в 19:34:03Z во время свапа прошёл).
- **Никаких write на production не выполнялось.**

---

## 4. Что НЕ менялось

Схема (**100**), БД, scheduler, Caddy, DNS, пароли, публичный сайт, backup + gps-archive таймеры.

---

## 5. Rollback

| | |
|---|---|
| Rollback-контейнер | `titanor-time-prod-app-pre-d216482` (образ **`d7e-5cce319`**, Deploy E) — сохранён |
| Команда | `bash ops/titanor-time/r15-d7/deploy-f-rollback.sh` (revert образа ~3 c; в скрипте — abort по таймауту готовности + сохранение упавшего контейнера) |
| Схема при откате | **не откатывается** — миграции не было |
| Backup | `production-20260903T175352Z-pre-deploy` (on-box + off-box) |
| Держать до | owner sign-off всего R15-D7 |

---

## 6. Статус на момент первого swap (2026-09-03, историческое)

**Deploy F — технически live** (владелец подтвердил 2026-09-04). Образ `d7f-d216482` в работе,
`/api/ready` 200, схема 100, лог чистый, rollback-контейнер сохранён.

Не в работающем образе на тот момент: запись «Что нового» `/guide` (`c76d439`) и F03 — обе выпущены
следующим деплоем, см. §7.

---

## 7. Второй production deploy (F03 + «Что нового») — выполнено 2026-09-04

**Разрешение владельца:** «Выпустить F03 и «Что нового» через обычный web-only swap: финальная
сборка, backup, кандидат на 3198, read-only smoke, swap и проверка логов. Без миграции. […]
Сохранить предыдущий контейнер для быстрого rollback.»

### Что вошло
- **F03** — `WorkSite.gpsOftenUnavailable` переведён в пояснительный режим: флаг выключен → поведение
  не меняется; флаг включён → `GPS_NOT_VERIFIED` без координаты остаётся OPEN + спокойные пояснения
  администратору (только для настоящего отсутствия координаты, не для `LOW_ACCURACY`) и работнику;
  `OUTSIDE_GEOFENCE_*` не ослаблен; старые записи не трогаются (`2fa0d5d` + `e5b1a42`).
- Запись «Что нового» `/guide` — «2–3 сентября 2026» (`c76d439`).

### Итоговый релизный прогон (disposable, образ `d7f-fd8494c`, production не тронут)

| проверка | результат |
|---|---|
| `npm run typecheck` / `npm run lint` | clean / clean |
| Полный browser harness (`run-browser-acceptance.sh`, без аргументов, весь манифест) | **19 pass / 0 fail / 2 SKIP-HARNESS** |
| `run-worker-dossier-qa.sh` (dedicated) | **31 / 0** |
| `run-restart-persistence.sh` (dedicated) | prepare **5 / 0** + verify **18 / 0** |
| db lane | **64 / 0** |
| unit lane | **18 / 0** |
| `next build` | clean (подтверждено успешной сборкой образа) |

Полностью покрывает и превышает критерий владельца «зелёный release-run 19/0/2».

### Хронология

| шаг | детали |
|---|---|
| Образ | `titanor-time-app:d7f-fd8494c` (`org.opencontainers.image.revision=fd8494c`; HEAD в момент сборки) |
| Backup | `production-20260904T154045Z-pre-deploy` (on-box + off-box), 588 908 B dump, 742 TOC entries, 2489 строк, 100 миграций |
| `restore-test-titanor-time.sh` | **13 / 13 PASS** (миграции, structure, per-table row counts, all-data fingerprint, uploads — всё совпадает) |
| Кандидат `:3198` | `d7f-fd8494c` против реальной prod-БД (uploads смонтирован `:ro`): `/api/ready` 200 `current 100/100`; `/login` 200; `/reset-password` 200; `/admin/reports/customer` 307; `/worker` 307; `/guide` 200 (публичная страница — ожидаемо); `GET …/scope?action=search` без сессии → 401; неверные креды → `401 INVALID_CREDENTIALS` (чистый отказ). **Только read-only**, кандидат снесён после проверки. |
| **Web-only swap** | `bash ops/titanor-time/r15-d7/deploy-f03-swap.sh`. T0 `docker stop` **2026-09-04 15:43:23.826Z** → `docker rename → titanor-time-prod-app-pre-fd8494c` → `docker run` новый (идентичная конфигурация) 15:43:25.024Z → **`/api/ready` 200 в 15:43:26.595Z**. **Простой ≈ 2.8 c.** |
| Health | `healthy` в течение ~15 c |

### Пост-swap проверки — только read-only (live prod, через Caddy)
- `/api/ready` → **200 `current 100/100`**;
- `/login` 200, `/reset-password` 200, `/worker` 307, `/admin/reports/customer` 307, `/guide` 200 (публичная);
- неверные креды → `401 INVALID_CREDENTIALS` (чистый отказ, не 500);
- **на живом `/guide` подтверждён текст обеих новых записей**: «2–3 сентября 2026» и «часто нет GPS-сигнала»;
- лог приложения после swap — **чистый** (только строки старта Next.js);
- scheduler (`r14-release-1416503`) — **не трогали**, тикает каждую минуту непрерывно через момент
  свапа (15:41/15:42/15:43Z), `runnerOutcome: ok`, `failed: 0`;
- **Никаких write на production не выполнялось** (кроме отдельно разрешённого dismiss трёх
  исключений Andrei #1000 — не связано с этим swap, см. `R15_MEYER_GPS_FLAG_RU.md` §5).

### Что НЕ менялось
Схема (**100**), БД, scheduler, Caddy, DNS, пароли, публичный сайт, backup + gps-archive таймеры.
Meyer-галочка НЕ включена (владелец включит сам через UI).

### Rollback
| | |
|---|---|
| Rollback-контейнер | `titanor-time-prod-app-pre-fd8494c` (образ **`d7f-d216482`**) — сохранён |
| Команда | `bash ops/titanor-time/r15-d7/deploy-f03-rollback.sh` (revert образа ~3 c) |
| Схема при откате | **не откатывается** — миграции не было |
| Backup | `production-20260904T154045Z-pre-deploy` (on-box + off-box) |
| Держать до | owner sign-off всего R15 |

**Текущий prod-образ: `titanor-time-app:d7f-fd8494c`. Production без явного разрешения владельца
не обновлять. Новых тестовых данных на production не создавать.**
