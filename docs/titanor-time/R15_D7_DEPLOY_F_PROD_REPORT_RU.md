# R15-D7 Deploy F — production deploy report («Часы заказчику»)

> **СТАТУС (указание владельца, 2026-09-04):**
> Образ `titanor-time-app:d7f-d216482` **физически развёрнут** на production 2026-09-03 19:34Z
> (web-only swap, отдельно разрешённый владельцем — см. §1). **Но Deploy F и запись «Что нового»
> в `/guide` НЕ считаются production-live**, пока этот отчёт не проверен владельцем и не дан
> отдельный sign-off. **Production без явного разрешения владельца не обновлять. Новых тестовых
> данных на production не создавать.**
>
> Этот документ — тот самый «отдельный production deploy report». Он **на проверку**, не «готово».

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

## 6. Открытые пункты — до того, как Deploy F можно считать production-live

1. **Ревью этого отчёта владельцем** + отдельный sign-off (указание 2026-09-04).
2. **Не на prod (появится при СЛЕДУЮЩЕМ деплое приложения, до тех пор не считать live):**
   - запись «Что нового» `/guide` (`c76d439`);
   - **F03 — переключатель «часто нет GPS» переведён в пояснительный режим** (`2fa0d5d`,
     `R15_MEYER_GPS_FLAG_RU.md` / `R15_MEYER_GPS_AUTOACCEPT_PLAN_RU.md`), disposable-протестирован
     на `d7f-4f085fe` (db 64/64, unit 18/18, browser 8/8, `next build` clean). Без миграции.
   Следующий деплой = web-only swap `d7f-d216482` → `d7f-<HEAD-sha>`, тот же паттерн, без миграции.
3. **F02 (fixroad) — минимальная ручная device acceptance на реальном Android** — за владельцем
   (browser-эмуляция Codex уже PASS). Тестовых часов на prod не создавать.
4. **F04 (fixroad) — failed `titanorgroup-backup.service`** (публичный сайт, не Titanor Time) —
   root-оператор по `R15_F04_PUBLIC_SITE_BACKUP_RUNBOOK_RU.md`. Titanor Time backup + GPS archive работают.
5. **Открытые `GPS_NOT_VERIFIED` по Meyer Turku Shipyard** — администратор принимает разом по
   фильтру объекта (`R15_ATTENDANCE_EXCEPTIONS_REVIEW_RU.md`). Отдельно подготовлена (НЕ применена)
   галочка «часто нет GPS» для Meyer — `R15_MEYER_GPS_FLAG_RU.md`.
6. **Полный R15 owner sign-off** — не только технический D7 A→F (см. чек-лист `fixroad.md` §5).

Пока эти пункты открыты: **Deploy F = «развёрнут, не подписан». Production не обновлять без
разрешения владельца. Новых тестовых данных на production не создавать.**
