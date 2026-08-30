# R07-B — Public site security hardening (`titanorgroup.fi`)

- **Основание:** production release roadmap R07 (часть «публичный сайт»), ТЗ §16.2–16.4. Закрывает
  «слабые public admin/contact/upload controls» из блокера **B08**.
- **Дата:** 2026-08-30.
- **Не затронуто:** Titanor Time, его БД и scheduler; production Titanor Time; Caddy; Cloudflare
  DNS. Публичный сайт БД не имеет — миграций нет. Бизнес-логика и вёрстка страниц не менялись.
- **Статус:** **код DONE, все проверки зелёные (7 файлов, 133 assert), CI зелёный.**
  Deploy-скрипт `ops/site/deploy-site-r07b.sh` написан (Slice 7). На live-сайт **не развёрнут** —
  запускает владелец. Живой контейнер `titanorgroup-web-1` не тронут.
- **Решения владельца (fork):** rate-limit — in-memory fixed-window; login-audit — персистентный
  append-only файл; фото — `sharp` strip metadata + нормализация, формат сохраняем (GIF → отказ);
  деплой — код + fail-closed скрипт для live-сайта, immutable-swap (как пилот), smoke-тест на
  временном контейнере ПЕРЕД подменой live, contact — только проверка env (письмо владелец шлёт
  вручную).
- **Commits:** `f8dd3f5` (примитивы + харнесс) · `02a9c9b` (admin auth) · `6644254` (CSRF на
  admin-mutations) · `5e0d7f3` (contact) · `5a29496` (uploads) · `6ba93c4` (заголовки + robots) ·
  Slice 7 (Dockerfile OCI labels + `ops/site/deploy-site-r07b.sh`).

---

## Итог по ТЗ

### §16.2 — Admin (`/ship-admin-portal`)

| требование | статус |
|---|---|
| rate-limit на вход | ✅ `02a9c9b` — 10 попыток / 15 мин на доверенный client-IP, in-memory fixed-window; проверяется до парсинга тела |
| timing-safe сравнение пароля | ✅ `02a9c9b` — HMAC-SHA256 обеих сторон + `timingSafeEqual` (постоянная длина/время; `password === expected` убрано) |
| CSRF на logout и мутациях | ✅ `02a9c9b` + `6644254` — заголовок `X-Requested-With: titanor-admin` на `login`, `logout`, `POST/DELETE images`, `POST/DELETE vacancies`, `PUT service-content`; клиентские компоненты шлют его |
| secure-cookie флаги | ✅ `02a9c9b` — `HttpOnly` + `SameSite=Strict` + `Secure` (в production) + `Path=/`; отдельные `getAdminSessionClearOptions()` для выхода (`Max-Age=0`) |
| журнал входов | ✅ `02a9c9b` — `lib/admin-audit.ts`: JSON-строки `{ts,event,outcome,ip,ua}` в append-only файл (`ADMIN_AUDIT_LOG`, по умолчанию `/app/data/admin-login-audit.log`, mode 0600), best-effort, никогда не бросает; события `success` / `failure` / `rate_limited`; пароль/токен в файл не попадают |

### §16.3 — Contact form (`/api/contact`)

| требование | статус |
|---|---|
| rate-limit | ✅ `5e0d7f3` — 5 отправок / 15 мин на доверенный client-IP, до парсинга тела; поддельный левый `X-Forwarded-For` не открывает новый счётчик |
| SMTP timeouts | ✅ `5e0d7f3` — `connectionTimeout` 10s, `greetingTimeout` 10s, `socketTimeout` 20s на транспорте |
| очищенное логирование ошибок | ✅ `5e0d7f3` — только `[code] message(≤200)`; никогда не логируются тело формы (имя/email/сообщение — перс. данные) и сырой объект ошибки (SMTP-ошибки эхом отдают конверт) |
| honeypot + экранирование сохранены | ✅ поле `website` и `escapeHtml()` без изменений; тест подтверждает, что HTML в письме экранируется |
| malformed body не даёт 500 | ✅ парсинг JSON вынесен в свой `try` → 400 |

### §16.4 — Uploads (`/api/admin/images`, `/uploads/[...path]`)

| требование | статус |
|---|---|
| проверка magic-bytes | ✅ `5a29496` — `sniffImageFormat()` по сигнатуре; **Content-Type клиента не используется** |
| только одобренные форматы | ✅ JPEG / PNG / WebP; **GIF — явный отказ** с отдельным сообщением |
| размер до обработки | ✅ `file.size` проверяется до чтения тела, затем повторно по фактической длине буфера |
| ре-энкод фото | ✅ `sharp(failOn:'error')` `.rotate()` (запечь EXIF-ориентацию) + downscale только если ребро > 4096; выходной файл без EXIF/GPS/ICC/XMP и без «хвоста» за изображением; формат сохраняется |
| nosniff + Content-Disposition | ✅ `X-Content-Type-Options: nosniff` (был) + `Content-Disposition: inline; filename="…"` (нормализованное имя) |
| проверки прав | ✅ `POST/DELETE /api/admin/images` — `isAdminRequestAuthenticated` + CSRF; раздача `/uploads/**` публична намеренно (картинки сайта) |
| защита от path traversal | ✅ посегментный allowlist `[A-Za-z0-9._-]`, ровно 3 сегмента, корень `services/`, **плюс** проверка, что `resolve()` пути остаётся внутри upload-root; `readLocalServiceImage` и `deleteLocalServiceImage` на traversal возвращают null / no-op |

### PASS-критерий R07

> negative/security regression tests проходят; malformed input не даёт 500; rate-limit нельзя
> обойти подменой первого forwarded IP.

**Выполнен** — см. §3. Отдельно: `_test-contact.ts` содержит проверку «поддельный левый
`X-Forwarded-For` (`1.2.3.4, <реальный>`) → всё равно 429».

---

## 1. Общие примитивы (`f8dd3f5`)

- **`lib/client-ip.ts`** — тот же принцип, что в Titanor Time (`lib/client-ip.ts` R07-A): цепочка
  `X-Forwarded-For` разбирается **справа минус hops** (`xff[len - N]`), `N =
  PUBLIC_SITE_TRUSTED_PROXY_HOPS` (default 1 = Caddy). Левые значения — недоверенные. Некорректный
  адрес в доверенной позиции → `null` → фиксированный под-ключ `unknown` (никогда клиентское
  значение). `isIpAddress` через `node:net` `isIP()`.
- **`lib/rate-limit.ts`** — `Map<key, {count, resetAt}>`, фиксированное окно, вероятностная (2%)
  очистка просроченных. `checkRateLimit(key, limit, windowMs) → {allowed, count, resetAt}`.
  Рестарт контейнера обнуляет счётчики — приемлемо для одно-инстансного сайта с малым трафиком.
- **`lib/csrf.ts`** — `rejectIfCsrfMissing(request)` → 403, если нет `X-Requested-With:
  titanor-admin`. Заголовок, который кросс-сайтовый простой/форменный запрос выставить не может.
- **`lib/admin-audit.ts`** — append-only журнал (см. §16.2 выше).
- **Харнесс:** `scripts/run-tests.mjs` (`npm test`) — гоняет `scripts/_test-*.ts` через `tsx`,
  без БД и браузера. CI: джоба `public-site-quality` → шаг «Security regression tests (R07-B)».

## 2. Изменённые маршруты и компоненты

| файл | что |
|---|---|
| `lib/admin-auth.ts` | timing-safe пароль; `SameSite=Strict`; `getAdminSessionClearOptions()` |
| `app/api/admin/login/route.ts` | CSRF + rate-limit + audit + 400 на битое тело |
| `app/api/admin/logout/route.ts` | CSRF + чистка cookie |
| `app/api/admin/{images,vacancies,service-content}/route.ts` | CSRF после auth; парсинг тела в свой `try` → 400 вместо 500 |
| `app/api/contact/route.ts` | rate-limit + SMTP timeouts + очищенный лог + 400 на битое тело; `__setCreateTransportForTests` |
| `lib/local-image-storage.ts` | `sniffImageFormat`; size-before-read; sharp re-encode; resolve-containment; curated-сообщения; `filename` в ответе |
| `app/uploads/[...path]/route.ts` | `Content-Disposition: inline` |
| `app/components/{admin-login-form,admin-image-manager,contact-form}.tsx` | `X-Requested-With` на мутациях; 429-копирайт |
| `next.config.mjs` | `poweredByHeader:false` + `headers()` на `/:path*` |
| `app/robots.ts` | `Disallow` для `/ship-admin-portal`, `/api/`, `/uploads/` |
| `public/robots.txt`, `public/sitemap.xml` | **удалены** — статические файлы перекрывали динамические `app/robots.ts` / `app/sitemap.ts` (иначе правило `Disallow` было бы no-op). Динамические маршруты несут те же URL sitemap. |
| `package.json` | `sharp` → прямая зависимость (`0.35.4`, pinned) |

## 3. Проверки (`npm test`) — 7 файлов, 133 assert, все зелёные

| файл | assert | покрывает |
|---|---:|---|
| `_test-client-ip.ts` | 16 | rightmost-minus-hops, отказ поддельному левому XFF, env-hops, прямой запрос |
| `_test-rate-limit.ts` | 9 | лимит/сброс/изоляция ключей/истечение окна |
| `_test-admin-auth.ts` | 19 | timing-safe accept/reject/near-miss; CSRF 403 на login+logout; неверные creds 401 без cookie; верные 200 + `Strict`/`HttpOnly` cookie, который аутентифицирует; 11-я попытка → 429 + изоляция по IP; logout чистит cookie (`Max-Age=0`); в audit есть события + IP, нет пароля/токена |
| `_test-admin-mutations-csrf.ts` | 21 | 401 без auth, 403 без заголовка, 400 (не 500) на битое/неполное тело, 200 на first-party запрос; реальные хендлеры, изолированный `cwd`/`data` |
| `_test-contact.ts` | 25 | 4xx (не 500) на битое/неполное; honeypot всё ещё 200 без отправки; timeouts на транспорте; HTML экранирован; rate-limit + поддельный XFF; 500 + очищенный лог (нет пароля/PII) при сбое SMTP |
| `_test-uploads.ts` | 26 | sniff всех форматов; HTML под видом `image/png` → отказ; GIF → отказ; size-before-processing; EXIF снят при ре-энкоде; битый файл → отказ; traversal (read+delete+serve); nosniff + inline при раздаче |
| `_test-security-headers.ts` | 17 | все ключи/значения заголовков; нет `X-Robots-Tag` (сайт индексируется); robots `Disallow`; страж «нет статического `public/` файла, перекрывающего динамический SEO-маршрут» |

Плюс живая проверка на собранном standalone-сервере: 6 security-заголовков присутствуют,
`X-Powered-By` отсутствует, `/robots.txt` отдаёт `Disallow:` строки, `/sitemap.xml` работает,
`/uploads/../../etc/passwd` → 404.

## 4. Осознанно НЕ сделано

- **Content-Security-Policy** — требует аудита inline-скриптов/стилей Next; отдельный шаг.
- **X-Frame-Options** — `SAMEORIGIN` (не `DENY`), т.к. маркетинговый сайт теоретически может быть
  встроен на своих же страницах; кросс-origin фрейминг заблокирован.
- **HSTS `includeSubDomains`/`preload`** — не выставлены: неизвестно, все ли поддомены на HTTPS.
- **Перевод на общий (DB/Redis) rate-limit** — не нужно: сайт одно-инстансный. При масштабировании
  — вынести `lib/rate-limit.ts` на общее хранилище (как сделано в Titanor Time R07-A).
- Раздача `/uploads/**` намеренно остаётся публичной и `inline` (картинки сайта), не `attachment`.

## 5. Deploy-скрипт (Slice 7) — `ops/site/deploy-site-r07b.sh`, запускает владелец

Живой сайт: контейнер `titanorgroup-web-1` (сейчас docker-compose service, проект
`/home/deploy/projects/titanorgroup/compose.yaml`), порт `127.0.0.1:3100->3000`, тома
`titanorgroup_titanorgroup_data` (`/app/data` — сюда пишется журнал входов) и
`…_uploads` (`/app/public/uploads`), сеть `titanorgroup_default`, env
`/home/deploy/projects/titanorgroup/.env.production`. Публичный деплой отложен с R04 — образ
принесёт R04 (обновление зависимостей) + R07-B.

Скрипт (та же fail-closed / auto-rollback структура, что у пилота Titanor Time):

1. **Guard:** `flock`; отказ, если существует `titanorgroup-web-1-pre-r07b` (скрипт никогда не
   удаляет rollback-контейнер) или занят verify-порт. Хелпер `http_code()` fail-closed возвращает
   **ровно `000`** при отказе соединения (баг `curl … || echo 000` → `000000` → ложный abort на
   свободном порту — исправлено); `bash ops/site/deploy-site-r07b.sh --self-test` + `bash -n` в
   CI-джобе `public-site-quality`.
2. **Repo sanity:** `git rev-parse --is-inside-work-tree` ровно `true` (в linked worktree `.git` —
   файл, `[ -d .git ]` не годится); `git status --porcelain` пусто (учитывает и untracked — иначе
   `COPY . .` положит в образ то, чего нет в SHA); на `feature/titanor-time-foundation`, HEAD
   запушен. `--self-test` создаёт временный linked worktree и проверяет обе функции.
3. **Baseline Titanor Time:** снимок `titanor-time-app-1` + `t97-pilot-app` + `t97-pilot-scheduler`
   (image/started/restarts), перепроверяется в конце — при любом изменении `exit 2`.
4. **Immutable build:** `titanorgroup-web:site-<shortsha>` из `Dockerfile` с
   `--build-arg GIT_SHA/GIT_REF/BUILD_TIME`; ассерт `org.opencontainers.image.revision == <sha>`.
5. **Backup обоих томов** (`tar` через helper-контейнер) → `/home/deploy/backups/titanorgroup/
   pre-r07b-<ts>/` + off-box `/mnt/250gb/titanorgroup/backups/…` с `manifest.txt` + `SHA256SUMS`;
   fail-closed re-verify чек-сумм on-box и off-box.
6. **Smoke-тест на ЧЕРНОВОМ контейнере** `titanorgroup-web-verify` на `127.0.0.1:3199` (без томов,
   без restart-policy): health, `/en` `/fi` 200, 6 security-заголовков, нет `X-Powered-By`/
   `X-Robots-Tag`, `robots` c `Disallow: /ship-admin-portal`, `sitemap.xml`, admin-login 403 без
   заголовка + 401 на неверный пароль + **429 на 12-ю попытку** (`X-Forwarded-For: 192.0.2.247`),
   contact на битом теле → 4xx (не 5xx), traversal-пробы → нет 5xx, `SMTP_*` присутствуют в env.
   **Провал здесь → live не тронут, откатывать нечего.**
7. **Swap live** (авто-rollback с этого момента): `stop -t 30` → `rename … -pre-r07b` →
   `docker run` новый с теми же портом/томами/env/healthcheck/`--restart unless-stopped`.
8. **Verify live** (fail-closed → rollback): весь набор из п.6 + существующий upload всё ещё
   отдаётся (проверка монтирования тома) + `/app/data/admin-login-audit.log` непустой после проб.
9. **Titanor Time baseline** — идентичен.

**Contact:** скрипт проверяет только наличие `SMTP_HOST/USER/PASSWORD` + `CONTACT_TO_EMAIL` в env
и что `/api/contact` на битом теле отдаёт 400. **Фактическую доставку письма владелец проверяет
вручную** через форму после деплоя (реальные SMTP-creds, реальное письмо).

**Compose-детач:** после swap контейнер — hand-run. `docker compose up -d`/`down` в
`/home/deploy/projects/titanorgroup` после этого **запускать нельзя** (пересоздаст из старого
compose-билда). Ре-синк compose позже: тот checkout на feature-ветку, тот же `docker build`,
`image:` в compose на новый тег. Задокументировано в шапке скрипта.

**Rollback:** `docker rm -f titanorgroup-web-1 && docker rename titanorgroup-web-1-pre-r07b
titanorgroup-web-1 && docker start titanorgroup-web-1`. `-pre-r07b` удаляется только вручную.

## 6. Дальше

- Владелец запускает `ops/site/deploy-site-r07b.sh`. После PASS — обновить статус/roadmap и
  проверить форму вручную.
- Затем → **R08 (GPS archive)** — по решению владельца.
- Позже (i18n-этап): `/fi` отдаёт `<html lang="en">` — вне R07-B.
