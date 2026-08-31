# Titanor Time — handoff для следующего агента

- **Дата фиксации:** 2026-08-31
- **Ветка:** `feature/titanor-time-foundation`
- **Главные документы:** `PRODUCTION_RELEASE_TZ_FINAL_RU.md`, `PRODUCTION_RELEASE_ROADMAP_RU.md`, `IMPLEMENTATION_STATUS.md`
- **Текущий этап:** после R10, перед R11
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
- Не менять Cloudflare DNS без этапа R11 и явной команды владельца.
- Не менять Caddy/live production Titanor Time без соответствующего runbook и подтверждения.
- Не запускать rollback и не удалять rollback-контейнеры без отдельной причины.
- Не печатать secrets, cookies, recovery-коды, password hashes, GPS archive key или персональные координаты в чат/логи/markdown.
- Не делать blind codemod по `guardApiRequest`.
- Не расширять scope на FOREMAN UX: заказчик это не обсуждал, владелец исключил FOREMAN UI из R09.
- Не делать глубокую единую карточку работника до production: в R09 выбран только порядок и навигация.

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

## 4. Открытые owner actions перед R11

Владелец должен выполнить/подтвердить R10 manual acceptance:

- реальные устройства: iPhone/Safari, Android/Chrome, desktop;
- живой role-smoke на пилоте: `SUPER_ADMIN`, `ADMIN`, `WORKER`; `FOREMAN` можно отметить skipped/not in scope, если реального сценария сейчас нет;
- вход по username и email;
- основные worker/admin сценарии по `R10_MANUAL_ACCEPTANCE_CHECKLIST_RU.md`;
- `docker builder prune` на хосте для освобождения build cache, когда владелец готов.

Если ручная проверка найдёт P0/P1 дефект, R11 не начинать: дефект фиксируется отдельным hotfix-кандидатом с повторной проверкой.

Если ручная проверка PASS или только мелкие backlog-замечания, владелец пишет:

```text
R10 manual acceptance confirmed.
Можно начинать R11 домен/Caddy/DNS preparation.
Production cutover не начинать.
```

## 5. Следующий этап: R11

R11 — это подготовка `app.titanorgroup.fi`, Caddy и ссылки входа с публичного сайта. Это ещё не production cutover.

Ожидаемый scope R11:

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

## 6. Обязательная оговорка до R12

R10 нашёл техдолг browser-lane: часть UI-тестов устарела с августа из-за реальных изменений продукта. Это не признано дефектом продукта, но **модернизацию browser-lane нужно завершить до R12**, потому что R12 должен повторить production-like rehearsal и полную acceptance matrix.

Не смешивать это с R11, если R11 можно выполнить без изменения тестов. Если R12 начинается, сначала привести browser-lane в актуальное состояние или явно включить это в R12-prep.

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

