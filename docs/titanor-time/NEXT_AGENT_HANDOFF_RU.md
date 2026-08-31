# Titanor Time — handoff для следующего агента

- **Дата фиксации:** 2026-08-31 (обновлено: R12 rehearsal PASS)
- **Ветка:** `feature/titanor-time-foundation`
- **Главные документы:** `PRODUCTION_RELEASE_TZ_FINAL_RU.md`, `PRODUCTION_RELEASE_ROADMAP_RU.md`, `IMPLEMENTATION_STATUS.md`
- **Текущий этап:** R11 PASS · R12-prep DONE · R12 rehearsal PASS · **R13 prep DONE** (`R13_PREP_RU.md`) — решения владельца зафиксированы, на пилоте созданы тест-аккаунты `r13-{super,admin,worker,foreman}` (пароли переданы владельцу приватно, не в Git), owner-checklist A–E + evidence package готовы, docker cleanup-план (не выполнен). Кандидат `titanor-time-app:r12-candidate-367420e` (digest `sha256:b5f80cbd…`). **Ждёт owner-часть R13:** ручная acceptance по checklist + 3 подтверждения (pilot acceptance / maintenance window / cutover). **R14/cutover не начинать.**
- **R10 manual acceptance:** CONFIRMED владельцем 2026-08-31 (реальные устройства + role-smoke, 0 P0/P1, FOREMAN skipped/not in scope)
- **Инцидент 2026-08-31:** агент вызвал `caddy stop` в тесте → боевой Caddy лежал ~46 мин. Разбор + правило: `R11_INCIDENT_2026-08-31_caddy_outage.md`, `feedback_never_run_caddy_daemon_commands` (память). На этом хосте: только `caddy validate`/`adapt`, никаких `caddy stop/start/run`/bare `reload`.
- **Production cutover:** запрещён до R12 PASS и отдельного подтверждения владельца на R13

Этот файл — короткая точка входа для нового агента/нового ПК. Перед любой работой сначала прочитать:

1. `docs/titanor-time/PRODUCTION_RELEASE_TZ_FINAL_RU.md`
2. `docs/titanor-time/PRODUCTION_RELEASE_ROADMAP_RU.md`
3. `docs/titanor-time/IMPLEMENTATION_STATUS.md`
4. этот файл

## 1. Где мы сейчас

R00–R09 завершены и задеплоены/проверены в нужных окружениях. R10 завершён как release candidate acceptance: **PASS с оговоркой**. R10 не требовал нового pilot-deploy, потому что рантайм кандидата совпадает с уже задеплоенным R09-образом.

Пилот сейчас считается основным источником будущего production:

- `t97-pilot-app` и `t97-pilot-scheduler` на `titanor-time-app:t97-pilot-edd950c`;
- DB пилота: 98 миграций, `/api/ready` возвращает `schema:current`;
- scheduler здоровый, lease обновляется, фоновые операции идут;
- GPS archive R08 включён: `titanor-time-gps-archive@pilot.timer` enabled, первый прогон 5/5 VERIFIED;
- R09 UX для ADMIN/WORKER задеплоен, БД в R09 не менялась;
- публичный сайт `titanorgroup.fi` задеплоен с R04+R07-B на `titanorgroup-web:site-3321c09`, contact delivery вручную подтверждён владельцем;
- текущий production Titanor Time не менялся и остаётся старым окружением до R14.

Production-перенос ещё не начат. Цель R14 — сделать pilot-БД и pilot-файлы production-базой/данными. Старая production-БД считается неважной, но всё равно должна быть сохранена backup'ом перед заменой.

## 2. Что нельзя делать без отдельного разрешения

- Не начинать R14/cutover.
- **Не менять Caddy, DNS, live production, pilot-БД, публичный сайт** — после R11 владелец
  заморозил их до отдельного разрешения (2026-08-31).
- **`docker builder prune` пока не запускать** (владелец, 2026-08-31). Read-only `docker builder du`
  + безопасный план очистки без удаления используемых образов — `R13_PREP_RU.md` §5.
- Не запускать rollback и не удалять rollback-контейнеры без отдельной причины.
- Не печатать secrets, cookies, recovery-коды, password hashes, GPS archive key или персональные координаты в чат/логи/markdown.
- **На этом хосте: только `caddy validate` / `caddy adapt`. Никаких `caddy stop/start/run` и
  `caddy reload` без `--address 127.0.0.1:2019`** (инцидент 2026-08-31, 46 мин простоя всех сайтов).
- Не делать blind codemod по `guardApiRequest`.
- Не расширять scope на FOREMAN UX: заказчик это не обсуждал, владелец исключил FOREMAN UI из R09.
- Не делать глубокую единую карточку работника до production: в R09 выбран только порядок и навигация.

### Gates перед R14 — зафиксированы владельцем 2026-08-31 (все РЕШЕНЫ)

1. **FI-строка Employee login:** `login` FI = **«Työntekijän kirjautuminen»**, EN = «Employee login».
   Код — `app/components/site-header.tsx` + `app/i18n.ts` (R11 §5); деплой на R14.
2. **Firewall:** `ufw` — только **read-only проверить**; **внешний порт 3199 открывать НЕЛЬЗЯ.**
   Production web bind — **только `127.0.0.1:3199`** (за Caddy).
3. **Порт production:** **`127.0.0.1:3199`** (только loopback), стек `titanor-time-prod-*`.
4. **Scheduler после restore:** ОБЯЗАТЕЛЬНО `DELETE FROM "SchedulerLease"` до запуска scheduler
   (иначе OVERLAPPING ~90 мин; runbook `R12_REHEARSAL_RU.md` шаг 11).

## 3. Что уже сделано по этапам

- **R00:** release baseline/freeze.
- **R01:** backup/storage foundation, off-box mirror на `/mnt/250gb`, restore доказан.
- **R02:** test/CI gates, каталог тестов, branch protection.
- **R03:** профили ADMIN/SUPER_ADMIN и WORKER account/recovery без SMTP, deployed на pilot.
- **R04:** dependency/security upgrade публичного сайта, Vercel Preview regression исправлен.
- **R05:** Titanor Time dependency security, audit 0, deployed на pilot.
- **R06-A/B:** readiness, scheduler health, Docker/runtime optimization, stale-lease incident разобран и deploy scripts усилены.
- **R07-A:** Titanor Time security hardening, DB-backed rate limit, trusted proxy IP parsing, malformed UUID hardening, deployed на pilot.
- **R07-B:** public site hardening, admin/contact/uploads/security headers, deployed на live `titanorgroup.fi`.
- **R08:** encrypted GPS archive + archive-gated retention, deployed на pilot, timer enabled.
- **R09:** UX для ADMIN/WORKER, users search/filter/pagination, human access denied notices, document attention, overflow sweep, worker clock panel split, worker card nav, deployed на pilot.
- **R10:** release candidate + pilot acceptance evidence, PASS с оговоркой; pilot deploy не нужен.

## 4. Открытые owner actions на R11

R10 manual acceptance — **CONFIRMED 2026-08-31** (device + role-smoke PASS, FOREMAN skipped/not in scope, 0 P0/P1). R11 разблокирован и начат.

Осталось от владельца на R11 (см. `R11_DOMAIN_CADDY_PLAN_RU.md` §9):

- ответить на 6 вопросов §9 плана — главный: **Cloudflare grey-cloud (Вариант A, рекомендуется) или orange-cloud (Вариант B)**;
- создать DNS-запись `app.titanorgroup.fi` в Cloudflare по инструкции плана (`A` → `84.247.130.242`, **DNS only**, TTL Auto) — агент DNS сам не меняет;
- правка `/etc/caddy/Caddyfile` требует root (у `deploy` sudo с паролем) — владелец делает сам или выдаёт доступ;
- `docker builder prune` на хосте (диск `/` 81 %), когда готов.

Backlog: модернизация browser-lane — **DONE** (`R12_PREP_BROWSER_LANE_RU.md`).

## 5. R11 — PASS (2026-08-31)

`R11_DOMAIN_CADDY_PLAN_RU.md` (план/аудит) + `R11_DOMAIN_CADDY_REPORT_RU.md` (отчёт).

**Сделано:** Вариант A (grey-cloud). Владелец создал `A app.titanorgroup.fi → 84.247.130.242`
(DNS only). Блок `app.titanorgroup.fi` в `/etc/caddy/Caddyfile` (см. `ops/titanor-time/r11/`):
TLS Let's Encrypt, `http→https` 308, **503 holding** (RU+EN, `/var/www/titanor-time-holding/`),
заголовки безопасности (продублированы в `handle_errors` — 503 идёт мимо site-level `header`),
`Server`/`X-Powered-By` убраны. Регрессия 5 vhost — чисто. Приложение **не открыто** до R14.

**Отложено на R14:** Employee-login ссылка на `titanorgroup.fi` (EN/FI, решение владельца);
Caddy holding → `reverse_proxy 127.0.0.1:3199`; перенос pilot БД/uploads.

**Открыто (не блокер):** FI-строка входа, правила `ufw`, порт 3199, `caddy fmt` (косметика).
Browser-lane — DONE (§6).

Исходный scope R11 из roadmap (для справки):

- проверить текущий Caddy config и маршруты;
- подготовить host для `app.titanorgroup.fi`;
- учесть Cloudflare proxy/orange-cloud модель;
- настроить trusted proxy chain:
  - Caddy доверяет Cloudflare CIDR через `trusted_proxies_strict`;
  - Titanor Time в production получает `TITANOR_TRUSTED_PROXY_HOPS=2`;
  - pilot/default остаётся `1`, если не меняется схема прокси;
- добавить/проверить вход на публичном сайте в Titanor Time для существующих пользователей, без регистрации;
- дать владельцу точные DNS-инструкции для Cloudflare;
- оставить access/maintenance control до R14, если нужно;
- не переносить production-БД и не менять live Titanor Time data.

R11 должен завершиться отчётом и инструкцией владельцу, что именно добавить в Cloudflare DNS. Если агент имеет доступ и владелец явно разрешил DNS-запись, можно подготовить изменение, но production cutover всё равно не начинать.

## 6. Оговорка до R12 — ЗАКРЫТА + новый кандидат (2026-08-31)

R10 §4 (техдолг browser-lane) закрыт: `R12_PREP_BROWSER_LANE_RU.md`. Модернизация нашла один
языковой дефект offline PWA-оболочки (RU для EN/FI-пользователя) — **исправлен** `ef5548b`
(минимальный product-коммит: `AppLocaleProvider` проп `persist`, offline shell `persist={false}`).

**Новый R12-кандидат:** git HEAD `367420e` (product-код = `ef5548b`, выше — только тесты/manifest),
образ `titanor-time-app:r12-candidate-367420e`, digest в `R12_PREP_BROWSER_LANE_RU.md`. Все 16
browser-lane тестов зелёные на этом кандидате. Прогон: `ops/titanor-time/run-browser-acceptance.sh`
+ `run-restart-persistence.sh` + `run-worker-dossier-qa.sh`. Логи: `baseline-r12-prep/`.

**R12 проверяет именно `r12-candidate-367420e`** (не R10-образ `t97-pilot-edd950c`).

## 7. Backlog, не блокирующий production

- FOREMAN UX целиком: вынесено после production, потому что заказчик это пока не обговаривал.
- Полный rollout `guardApiRequest` на ~130 маршрутов: делать только ревьюируемыми партиями, не blind codemod.
- Глубокая unified employee card: сейчас только навигация между существующими страницами.
- R09.9 split крупных admin-модулей.
- R08.1 читаемый TXT/CSV экспорт GPS-архива по запросу.
- Public site contact cards: `mailto:` ссылки корректны, но у владельца Chrome/Windows не открыл compose из-за локального mailto-handler. Позже добавить "Copy email" и/или переход к встроенной форме.
- `/fi` на публичном сайте всё ещё может отдавать `<html lang="en">`; это отдельный i18n backlog.

## 8. Состояние безопасности и данных

- SMTP recovery для Titanor Time не используется.
- Recovery выполняется администратором через одноразовый код/ссылку внутри приложения.
- Email — контактная информация и дополнительный логин.
- GPS raw хранится в БД 90 дней.
- Долговременный GPS-архив хранится зашифрованным, не открытым `.txt`.
- Текст уведомления работников и политика персональных данных не блокируют технический релиз, но должны быть утверждены владельцем бизнеса или ответственным лицом Titanor.

## 9. Быстрый старт для следующего агента

Перед началом:

```bash
cd /home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
git status --short --branch
git log --oneline -5
```

Если worktree грязный — сначала понять, чьи изменения. Не включать чужие изменения в commit.

Если владелец ещё не подтвердил R10 manual acceptance — не начинать R11, а помочь ему пройти checklist.

Если acceptance подтверждён — начинать R11 с read-only аудита Caddy/DNS/public-site link и подготовить безопасный plan/runbook. Production cutover не выполнять.

