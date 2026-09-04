# R14 — production cutover report

- **Дата:** 2026-08-31.
- **Окно владельца:** 18:47–19:50 EEST (владелец явно разрешил начать раньше первоначальных 18:50).
- **Вердикт:** **PASS**. `https://app.titanorgroup.fi` открыт на новом production-стеке.
- **Runbook:** `R14_CUTOVER_RUNBOOK_RU.md`.

## 1. Развёрнутые артефакты

| компонент | результат |
|---|---|
| Titanor Time | `titanor-time-app:r14-release-1416503`, image ID `sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb` |
| web / scheduler / DB | `titanor-time-prod-app`, `titanor-time-prod-scheduler`, `titanor-time-prod-db` — `healthy`, RestartCount 0 |
| bind | только `127.0.0.1:3199`; UFW снаружи разрешает только 22/80/443 |
| схема | `/api/ready`: `schema:current`, migrations 98/98, `aheadBy=0` |
| публичный сайт | `titanorgroup-web:site-ba04adf`, image ID `sha256:e58e484c5bf14481d6a6fa429020959801e71c765bf1aaeeba6307866ef12694` |

## 2. Данные и rollback

- Перед изменениями создан и проверен backup старого production:
  `/home/deploy/backups/titanor-time-old-prod/old-prod-20260831T154745Z-pre-migration`.
- После write-freeze создан финальный snapshot пилота:
  `/home/deploy/backups/titanor-time-pilot/pilot-20260831T154751Z-manual` — 98 миграций,
  1782 public rows, 3 uploads, SHA256SUMS OK.
- Restore выполнен с `--no-owner --no-acl`; 98 миграций, 0 failed. Три uploads совпали с manifest.
- В новой БД до запуска scheduler удалены 53 `UserSession` и carried-over `SchedulerLease` (0 → 0).
- Старый production web/scheduler и pilot web/scheduler остановлены, но не удалены. Старые DB,
  rollback-образы и Caddy backup сохранены.
- Caddy backup: `/etc/caddy/Caddyfile.backup-before-r14-20260831T155306Z`.
- Public-site backup сохранён on-box и off-box:
  `/home/deploy/backups/titanorgroup/pre-r14-20260831T155601Z` и
  `/mnt/250gb/titanorgroup/backups/pre-r14-20260831T155601Z`.

## 3. Таймлайн

| EEST | событие |
|---|---|
| 18:47:42 | старт `cutover-r14.sh --go` |
| ~18:47:51 | pilot write-freeze и финальный snapshot |
| ~18:48:14 | новый production web ready; затем scheduler lease/tick healthy |
| ~18:53:06 | Caddy переключён с holding 503 на `reverse_proxy 127.0.0.1:3199` |
| 18:56–18:57 | public-site smoke-first deploy и финальная проверка |

Перенос данных и boot приложения после freeze заняли менее минуты. Публичный домен до Caddy-switch
оставался на holding-странице; после switch `/login` сразу отвечал 200.

## 4. Проверки после переключения

- `https://app.titanorgroup.fi/` → 307 на `/login`; `/login` 200; `/api/health` 200;
  `/api/ready` 200 `schema:current` 98/98.
- HTTP → HTTPS: 308. TLS: Let's Encrypt, CN `app.titanorgroup.fi`, до 2026-11-29.
- HSTS, nosniff, SAMEORIGIN, Referrer-Policy, X-Robots присутствуют; `X-Powered-By` отсутствует.
- Scheduler healthcheck: `HEALTHY`, свежие успешные тики.
- Headless Chromium: мобильный login-shell 200, защищённые `/admin`, `/foreman`, `/worker`
  без сессии возвращают на login, console errors 0.
- Полный role/device acceptance не повторялся с временными `r13-*`, поскольку они намеренно
  деактивированы до snapshot; он уже закрыт на том же release image в `R13_ACCEPTANCE_RU.md`.
- `titanorgroup.fi`: `/en` и `/fi` 200, Employee login / Työntekijän kirjautuminen присутствуют;
  contact/traversal/security smoke PASS. Titanor Time baseline после deploy сайта не изменился.
- Остальные действующие vhost: 307 / 301 / 200 / 200. Замороженный pilot URL ожидаемо 502.

## 5. Находка во время окна

Первая попытка `apply-caddy-r14.sh` безопасно остановилась **до записи Caddyfile**: скрипт считал
ожидаемый 502 замороженного pilot-vhost регрессией. Исправление `ba04adf` вынесло pilot в отдельную
проверку: действующие vhost остаются fail-closed, pilot обязан быть 502 до и после switch.
`bash -n`, `git diff --check` и live baseline прошли; повторная sudo-команда завершилась PASS.

## 6. Открыто после R14

- Начать R15: наблюдение, scheduler/ready/logs, следующий backup и restore verification.
- Не удалять старые production/pilot/site rollback-контейнеры и backup до завершения R15.
- `/fi` исправляет `<html lang>` на клиенте после hydration; исходный SSR HTML пока остаётся
  `lang="en"`. Это не блокирует Titanor Time, но полноценный server-side `lang="fi"` остаётся backlog.
- `docker builder prune` по-прежнему не выполнять без отдельного решения владельца.

## 7. Ход R15 (обновление 2026-09-04)

R15 идёт — подробности в **`R15_OBSERVATION_RU.md`** и финальном аудите **`fixroad.md`**.

- **Фаза 1** (2 ч) — ✅. **Фаза 2** (24 ч) — почти закрыта: Titanor Time backup + off-box +
  restore-test PASS, GPS archive PASS; открыто — F02 (device acceptance) и F04 (failed backup
  публичного сайта, сам сайт работает).
- **72 ч** истекли 2026-09-03 15:48 UTC; идёт период стабильности.
- **Дефекты наблюдения D1a/D1b/D2/D4/D5/D6 + R15-D7 A→F — все задеплоены** к 2026-09-03. Текущий
  prod-образ `titanor-time-app:d7f-d216482`, схема **100/100**. Все деплои — web-only swap, только
  A и D2 несли миграцию (98→99→100). **Технический owner sign-off по R15-D7 A→F получен 2026-09-03.**
- **Полный R15 owner sign-off НЕ получен.** Открыто 5 P1-gate (`fixroad.md`): F01 (сделано
  2026-09-04), F02 (владелец), F03 (разбор готов), F04 (root-оператор), F05 (документы).
- Фактические результаты первых 72 ч по production (агрегаты, без PII): 19 Check In / 18 Check Out,
  13 новых версий табелей, 6 `FINAL_APPROVED`, автоматический backup + off-box + GPS archive работают.

