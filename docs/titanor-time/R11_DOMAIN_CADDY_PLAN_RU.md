# R11 — домен, Caddy и public login: read-only аудит + план/runbook

- **Основание:** production release roadmap R11 «Domain, Caddy и public login preparation»;
  `NEXT_AGENT_HANDOFF_RU.md` §5; ТЗ §22 (критерии готовности) — домен и HTTPS.
- **Дата аудита:** 2026-08-31.
- **Кандидат:** frozen `2ebe3e5`, образ `titanor-time-app:t97-pilot-edd950c` — не пересобирается.
- **Статус R10 manual acceptance:** **CONFIRMED владельцем 2026-08-31** — быстрая ручная проверка
  на реальных устройствах и основных ролях пройдена, открытых P0/P1 нет, `FOREMAN` отмечен
  skipped / not in scope. Это разблокировало R11.
- **Что сделано этим документом:** только read-only аудит, план и **готовые к применению
  артефакты** (`ops/titanor-time/r11/`). **Ни одного изменения инфраструктуры, Caddy, DNS,
  приложения или БД не внесено.** Production cutover (R14) не начат и остаётся запрещённым.

### Решения владельца (2026-08-31)

1. **Cloudflare: фазово — Вариант A (grey-cloud) сейчас, Вариант B (orange-cloud) отдельным
   усилением после R15.** → на запуск: `TITANOR_TRUSTED_PROXY_HOPS=1`, Caddy 2.6.2 не апгрейдится.
2. **Ссылку Employee login на публичном сайте публиковать на R14** (в maintenance-окне), не на R11.
   Код/строки/deploy-скрипт готовятся заранее (§5), но не деплоятся.

### Готовые артефакты (`ops/titanor-time/r11/`)

| файл | назначение |
|---|---|
| `caddy-app-block.txt` | точный Caddy-блок `app.titanorgroup.fi` → holding 503 (проверен `caddy adapt` на 2.6.2) |
| `holding/index.html` | самодостаточная holding-страница (RU + EN, dark, без внешних ресурсов) |
| `apply-caddy-r11.sh` | применение от root: DNS-check → holding → backup Caddyfile → append → validate → reload → verify (503/TLS/заголовки/редирект) → регресс 4 vhost; **auto-rollback** на любой ошибке; `--rollback` восстанавливает backup |

---

## 1. Read-only аудит текущего состояния

### 1.1 Caddy

| факт | значение |
|---|---|
| размещение | host-installed, systemd `caddy.service` (не Docker) |
| версия | **2.6.2** — пакет Ubuntu `2.6.2-6ubuntu0.24.04.3` из `noble-updates/universe` (не официальный apt-репозиторий Caddy; апгрейда в Ubuntu-репо нет) |
| конфиг | `/etc/caddy/Caddyfile` (владелец `root:root`, режим `644` — читаем всеми, **писать может только root**) |
| перезагрузка | unit **без `--resume`** → изменения через admin API перетираются при `systemctl restart`. Управлять **только файлом** + `caddy reload`. |
| admin API | `127.0.0.1:2019`, **без аутентификации** (любой локальный процесс может переконфигурировать Caddy — отдельная мелкая заметка по безопасности, не блокер R11) |
| `caddy validate` | Valid configuration |
| хосты сейчас | `collabstudio.run` (+`www` redir) → `127.0.0.1:3000`; `titanorgroup.fi` (+`www` redir) → `127.0.0.1:3100`; `84-247-130-242.sslip.io` → `127.0.0.1:8080` (ardor staging); `t97-dd686bc3d4.84.247.130.242.nip.io` → `127.0.0.1:3297` (pilot) |
| `Caddyfile.next` | устаревший черновик (до pilot/ardor) — **игнорировать** |

> **Важно для R11:** server-level `trusted_proxies` и `trusted_proxies_strict` появились в
> **Caddy 2.7**. В 2.6.2 их **нет**. Вариант с Cloudflare-проксированием (orange-cloud) требует
> апгрейда Caddy — см. §4.

### 1.2 DNS / Cloudflare

| факт | значение |
|---|---|
| NS `titanorgroup.fi` | Cloudflare (`keira.ns.cloudflare.com`, `josh.ns.cloudflare.com`) |
| `titanorgroup.fi` A | `84.247.130.242` — **напрямую публичный IP хоста** |
| `www.titanorgroup.fi` | CNAME → apex (A `84.247.130.242`) |
| проксирование CF | **ВЫКЛЮЧЕНО (grey-cloud / DNS-only)** — в ответах нет `cf-ray` и `server: cloudflare`, TLS терминирует сам Caddy |
| `app.titanorgroup.fi` | **записи нет** — чистый старт |
| почта | MX → Zoho (`mx.zoho.eu` / `mx2` / `mx3`), SPF `include:zohomail.eu`, verification-TXT Zoho + Google. **Не трогать.** |
| CF API доступ на хосте | не обнаружен → DNS-запись создаёт **владелец вручную** по инструкции |
| публичный IP хоста | `84.247.130.242` |

### 1.3 Firewall / порты

- `ufw` — **active / enabled**. Полные правила без root не читаются → подтвердить у владельца
  (ожидаемо: 22, 80, 443 разрешены; подтверждено рабочими SSH/HTTPS снаружи).
- Docker публикует наружу `0.0.0.0:8000` и `0.0.0.0:8080` (`ardor_*_staging`) — Docker обходит
  `ufw`. Вне scope R11, но показать владельцу.
- Все нужные контейнеры слушают только `127.0.0.1`: site `:3100`, pilot `:3297`,
  старый prod `:3200`. Правильно.

### 1.4 «Старое production» Titanor Time

- `titanor-time-app-1` (`titanor-time-app:latest`), compose-проект `titanor-time`
  (`compose.titanor-time.yaml`), порт `127.0.0.1:3200`, БД `titanor-time-db-1`.
- **В Caddy отсутствует — публичного домена нет. Titanor Time никогда не открывался публично.**
  R14 = первый публичный запуск.
- `titanor-time-scheduler-1` — `unhealthy` 9 дней. Это старое окружение; по roadmap его БД
  «неважна», трогаем только на R14 (backup перед заменой обязателен).

### 1.5 Приложение-кандидат — что нужно/не нужно для нового домена

| аспект | вывод |
|---|---|
| сессионная cookie `tt_session` | `httpOnly, secure, sameSite=lax, path=/`, **без `domain`** (host-only) → на `app.titanorgroup.fi` менять нечего; `secure` требует HTTPS (Caddy даёт) |
| CSRF | header-based (`X-Requested-With: titanor-time`), **без Origin/Host allowlist** → домен-специфичной настройки не требует |
| origin env | нет `APP_ORIGIN` / `NEXT_PUBLIC_*` origin-переменных — приложение работает от заголовков запроса |
| trusted proxy | `lib/client-ip.ts`, `TITANOR_TRUSTED_PROXY_HOPS` (default **1** = `browser→Caddy→app`). Для `browser→CF→Caddy→app` нужно **2** |
| регистрация | **отсутствует** — auth-роуты: `login`, `logout`, `logout-all`, `activate`, `activate-account`, `set-initial-password`, `set-account-password`, `change-password`, `password-reset`, `session` |
| security-заголовки | ставит **само приложение** (nosniff, X-Frame, HSTS, `X-Robots noindex` на `/login`, Permissions-Policy) — на новом домене будут автоматически |

### 1.6 Публичный сайт `titanorgroup.fi`

- Тот же репозиторий и ветка (`feature/titanor-time-foundation`), корень репо. Контейнер
  `titanorgroup-web-1` **отвязан от compose**; деплой — `ops/site/deploy-site-*.sh`
  (build `titanorgroup-web:site-<sha>` из HEAD + throwaway smoke + swap с auto-rollback).
  Текущий образ `site-3321c09`.
- i18n: `app/[lang]/`, `locales = ['fi','en']`, `defaultLocale = 'en'`.
- Навигация — `app/components/site-header.tsx`; строки — `app/i18n.ts`
  (`nav.{home,services,contact,career,cta}` для `en` и `fi`).
- **Футера нет** → ссылку Employee login добавлять в `SiteHeader` (desktop `nav-desktop`
  + `mobile-panel`).
- Известный i18n-баг (backlog, не блокер): `/fi` может отдавать `<html lang="en">`.

### 1.7 Ресурсы хоста

- Диск `/`: **81 %** (29 GB свободно). Docker build cache **65 GB (43 GB reclaimable)** →
  `docker builder prune` (owner action из `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §6).
- RAM: 7.8 GB, свободно ~226 MB, swap 3.9/4.0 GB — **очень тесно**. Тяжёлые операции по одной,
  следить за `free -h`. Апгрейд/reload Caddy — лёгкие.
- `sudo` для `deploy` — **с паролем** (нет `NOPASSWD`). Значит: редактирование
  `/etc/caddy/Caddyfile` и `systemctl` — только владельцем (или через выданный sudoers-пункт).
  `caddy reload --config /etc/caddy/Caddyfile` deploy-пользователь выполнить **может** (admin
  API открыт на localhost).

---

## 2. Ключевое решение: модель Cloudflare для `app.titanorgroup.fi`

| | **Вариант A — grey-cloud (DNS-only)** | **Вариант B — orange-cloud (проксирование CF)** |
|---|---|---|
| согласованность | как `titanorgroup.fi` и pilot сейчас | новая схема на хосте |
| Caddy | 2.6.2 **как есть** | **апгрейд до 2.10** (офиц. репозиторий) — затрагивает все 4 сайта на время reload |
| `TITANOR_TRUSTED_PROXY_HOPS` | **1** (default, env не трогаем) | **2** в prod env + `trusted_proxies_strict` + CF CIDR в Caddy |
| TLS | Caddy сам, Let's Encrypt | CF edge (Universal SSL) + CF Origin CA cert на Caddy, SSL mode **Full (strict)** |
| origin IP | виден (уже так для `titanorgroup.fi`) | скрыт |
| L3/L4 DDoS, WAF, CF rate-limit | нет (у приложения свой DB-rate-limit R07-A + заголовки) | да |
| firewall | 80/443 всем | желательно 80/443 только с CF-диапазонов (нужен root владельца) |
| риск для cutover-окна | минимальный | больше движущихся частей |
| время до запуска | быстро | +апгрейд Caddy +CF-настройки +проверка цепочки |

**Рекомендация — фазовый заход:**

1. **R11 сейчас, под запуск R14 — Вариант A (grey-cloud).** Минимум изменений инфраструктуры
   вокруг переноса данных, приложение уже несёт своё усиление, схема идентична принятому пилоту.
   Соответствует формулировке roadmap «pilot/default остаётся `1`, если не меняется схема прокси».
2. **Вариант B — отдельным усилением после R15**, когда production уже доказанно живой и нет
   риска в том же окне с переносом БД. Переключение — env `HOPS=2` + `trusted_proxies_strict` +
   CF proxy on; подготовлено в §4.

> Проектные документы (`lib/client-ip.ts`, `R07A_...`, `R07B_...`) описывают hops=2 как
> production-таргет — это остаётся верным как **конечная** цель; фазовость лишь разносит риск.

**Решение владельца (2026-08-31): Вариант A на запуск, B — после R15.**

---

## 3. План — Вариант A (grey-cloud) — ВЫБРАН

### 3.1 Блок Caddy

Точный блок — `ops/titanor-time/r11/caddy-app-block.txt` (проверен `caddy adapt` на 2.6.2).
holding-страница — `ops/titanor-time/r11/holding/index.html` (RU + EN, brandmark, dark, без
внешних ресурсов). Схема: `error … 503` + `handle_errors` рендерит `index.html` — статус
остаётся **503** (в Caddy 2.6.2 нет `file_server { status }` и heredoc; этот паттерн работает).

На R14: удалить `root` / `header Cache-Control` / `handle` / `handle_errors`, добавить
`reverse_proxy 127.0.0.1:3199`.

### 3.2 DNS-инструкция владельцу (Cloudflare dashboard → DNS → Records → Add record)

| поле | значение |
|---|---|
| **Type** | `A` |
| **Name** | `app` |
| **IPv4 address** | `84.247.130.242` |
| **Proxy status** | **DNS only** (серое облако — кликнуть оранжевую тучку, чтобы стала серой) |
| **TTL** | Auto |

**Не менять никакие другие записи** (apex `titanorgroup.fi`, `www`, MX, TXT остаются как есть).

### 3.3 Порядок выполнения

| # | кто | шаг |
|---|---|---|
| 1 | агент | ✅ артефакты `ops/titanor-time/r11/` готовы, план обновлён. **Не применено.** |
| 2 | **владелец** | создать A-запись `app` по §3.2 в Cloudflare, подтвердить в чат |
| 3 | **владелец** (sudo) | `sudo bash ops/titanor-time/r11/apply-caddy-r11.sh` — скрипт сам делает DNS-check, backup, append, validate, reload, verify (503/TLS/заголовки/http→https), регресс 4 vhost; **auto-rollback** на любой ошибке |
| 4 | агент | независимо перепроверить (`curl -sI` нового домена + 4 существующих), логи Caddy на `certificate obtained` |
| 5 | агент | отчёт `R11_DOMAIN_CADDY_REPORT_RU.md`, обновить `IMPLEMENTATION_STATUS.md` + handoff |

> Если у `deploy` появится sudoers-пункт на скрипт — шаг 3 может выполнить агент. Пока `sudo`
> с паролем → запускает владелец.

### 3.4 Rollback (полный)

`sudo bash ops/titanor-time/r11/apply-caddy-r11.sh --rollback` — восстанавливает самый свежий
`/etc/caddy/Caddyfile.backup-before-r11-*` и перезагружает Caddy. DNS-запись `app` можно
оставить (ведёт в никуда) либо владелец удалит её в Cloudflare.

### 3.5 `TITANOR_TRUSTED_PROXY_HOPS`

Оставить **1** (default) — в env не добавлять. Цепочка `browser → Caddy(127.0.0.1) → app`,
идентична пилоту. Меняется на 2 только при переходе на Вариант B.

---

## 4. План — Вариант B (orange-cloud) — подготовка, выполнять только по решению владельца

Дельта к Варианту A:

1. **Апгрейд Caddy 2.6.2 → 2.10.x**
   - подключить официальный репозиторий (cloudsmith `caddy/stable`), `apt update && apt install --only-upgrade caddy`;
   - `caddy validate` (синтаксис Caddyfile обратно совместим), `systemctl restart caddy`;
   - проверить все 4 сайта;
   - **rollback:** `apt install caddy=2.6.2-6ubuntu0.24.04.3` + hold, restart.
2. **Caddy — trusted proxies** (глобально или на роуте `app`):
   ```caddyfile
   {
   	servers {
   		trusted_proxies static <CF-IPv4-CIDR…> <CF-IPv6-CIDR…>
   		client_ip_headers X-Forwarded-For
   		trusted_proxies_strict
   	}
   }
   ```
   CF-диапазоны — из `https://www.cloudflare.com/ips-v4` и `.../ips-v6` (зафиксировать дату
   снимка; при желании позже — динамический модуль `caddy-cloudflare-ip`).
   `trusted_proxies_strict` заставляет Caddy принимать XFF **только** от CF и переписывать его
   иначе — это то, на что рассчитан `lib/client-ip.ts`.
3. **Cloudflare:**
   - запись `app` → **Proxied** (оранжевая тучка);
   - SSL/TLS mode → **Full (strict)**;
   - Origin Server → создать **Origin Certificate**, положить на хост, в блоке Caddy
     `tls /etc/caddy/app-origin.crt /etc/caddy/app-origin.key` (или оставить ACME — CF пропускает
     `/.well-known/acme-challenge/`, но Origin CA надёжнее за прокси);
   - Caching → правило **Bypass cache** для `app.titanorgroup.fi/*` (приложение, не CDN-контент);
   - (опц.) WAF / rate-limit rules на `/api/auth/login`.
4. **Приложение prod env:** `TITANOR_TRUSTED_PROXY_HOPS=2`.
5. **Firewall (нужен root владельца):** разрешить `80,443` только с CF-диапазонов, остальным
   deny — defense-in-depth против обхода прокси на origin IP.
6. **Проверка цепочки:** запрос через `https://app.titanorgroup.fi` → в логе приложения
   `resolveClientIp` даёт реальный клиентский IP (не CF edge), `chainTooShort:false`; прямой
   запрос на origin IP с поддельным XFF → IP не подделывается (`trusted_proxies_strict`).
7. **Rollback Варианта B:** CF proxy → DNS only; env `HOPS` вернуть на 1/убрать; блок
   `trusted_proxies` убрать; (Caddy можно оставить 2.10 — апгрейд безопасен сам по себе).

---

## 5. Public-site: ссылка Employee login (EN/FI)

### 5.1 Изменения кода (репо-корень, ветка `feature/titanor-time-foundation`)

- `app/i18n.ts` — в `nav` добавить `login`:
  - EN: `login: 'Employee login'`
  - FI: `login: 'Kirjaudu sisään'` **или** `'Työntekijän kirjautuminen'` (§9 вопрос 4)
- `app/components/site-header.tsx`:
  - расширить `SiteHeaderProps.labels` полем `login: string`;
  - в `nav-desktop` и в `mobile-panel` добавить `<a>` (не `next/link` — внешний абсолютный URL):
    ```tsx
    <a className="header-cta" href="https://app.titanorgroup.fi" rel="noopener">
      {labels.login}
    </a>
    ```
    (стиль — как `header-cta` или отдельный класс; разместить рядом с языковым переключателем
    либо перед `cta`).
- 4 страницы, вызывающие `<SiteHeader labels={content.nav} …>` уже прокидывают весь `nav` —
  новое поле подтянется автоматически: `app/[lang]/page.tsx`, `services/page.tsx`,
  `contact/page.tsx`, `career/page.tsx`. Проверить типы.
- Регистрации нет — просто ссылка на вход.

### 5.2 Деплой сайта

- Новый `ops/site/deploy-site-<sha>.sh` по образцу `ops/site/deploy-site-r07b.sh`
  (build `titanorgroup-web:site-<sha>` из HEAD, backup обоих volume, throwaway smoke на
  spare-порту, swap `titanorgroup-web-1` с auto-rollback, re-check Titanor Time не затронут).

### 5.3 Когда публиковать

**Решение владельца (2026-08-31): на R14**, в maintenance-окне, когда `app.titanorgroup.fi`
уже работает. На R11 код/строки/deploy-скрипт готовятся, но не деплоятся.

---

## 6. Production upstream — фиксация для R14 (сейчас не выполнять)

- Новый стек **отдельно** от `t97-pilot-*` и от старого `titanor-time-*`.
- Предлагаемые имена: `titanor-time-prod-{app,scheduler,db}`, сеть `titanor-time-prod-net`.
- Порт приложения: **`127.0.0.1:3199`** (свободен; `3200` — старый prod, `3297` — pilot).
- env: `/home/deploy/app-data/titanor-time-prod/app.env` — по образцу pilot `app.env`
  (13 ключей: `DATABASE_URL`, `POSTGRES_*`, 5 crypto-ключей, `NODE_ENV`, `PORT`, `HOSTNAME`,
  `NEXT_TELEMETRY_DISABLED`) + `TITANOR_TRUSTED_PROXY_HOPS=2` **только если Вариант B**.
- Образ: frozen-кандидат из `2ebe3e5` (release-tag присвоить на R12).
- Caddy `app.titanorgroup.fi`: `handle { respond … 503 }` → `reverse_proxy 127.0.0.1:3199`.
- Всё это — R12 rehearsal / R14 cutover.

---

## 7. R11 PASS-критерии

- [ ] `app.titanorgroup.fi` резолвится на `84.247.130.242`, валидный TLS-сертификат, `http→https` (308).
- [ ] Отдаёт holding/maintenance (503, `x-robots-tag: noindex`) — приложение пользователям **не** открыто.
- [ ] Заголовки безопасности присутствуют; `X-Powered-By` / `Server` убраны.
- [ ] `titanorgroup.fi`, `www`, `collabstudio.run`, pilot `t97-…nip.io`, ardor `sslip.io` — без регрессий.
- [ ] Изменения в БД / live Titanor Time / MX — **нет**. DNS изменена только добавлением `app` A-записи.
- [ ] Employee-login ссылка — код/строки/deploy-скрипт подготовлены (§5), деплой отложен на R14.
- [ ] `R11_DOMAIN_CADDY_REPORT_RU.md` + этот runbook + `IMPLEMENTATION_STATUS.md` + handoff обновлены.
- [ ] Backup `/etc/caddy/Caddyfile` сохранён до изменения.

---

## 8. Что остаётся на потом

- **R12:** production-like rehearsal (disposable env) + **обязательная модернизация browser-lane
  до R12** (`R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4 — ~9 UI-тестов).
- **R13:** owner evidence package + 3 подтверждения.
- **R14:** поднять production-стек (§6), переключить Caddy holding → `reverse_proxy`, опубликовать
  ссылку на сайте, перенести pilot БД/uploads (backup старой prod-БД обязателен).
- **После R15 (опц.):** Вариант B — orange-cloud (§4), если владелец хочет CF-защиту.
- **Owner backlog:** `docker builder prune` (диск 81 %); снять старые `t97-pilot-*-pre-*`
  контейнеры (кроме `-pre-edd950c`).

---

## 9. Вопросы владельцу

**Решено 2026-08-31:**
1. ~~Cloudflare~~ → **Вариант A (grey-cloud) на запуск, B после R15.**
2. ~~Ссылка Employee login~~ → **на R14.**
3. ~~Holding-страница~~ → **брендированный HTML** `ops/titanor-time/r11/holding/index.html` (RU+EN).

**Ещё открыто (не блокирует применение §3):**
4. **FI-строка входа** (нужна к R14): «Kirjaudu sisään» или «Työntekijän kirjautuminen»?
5. **Firewall:** подтвердить правила `ufw` (22/80/443); ограничивать ли внешние `8000`/`8080` (ardor staging)?
6. **Доступ:** оставить запуск `apply-caddy-r11.sh` за владельцем, или выдать `deploy` sudoers-пункт на этот скрипт?
7. **Порт production `3199`** (§6) — устраивает или заменить?
