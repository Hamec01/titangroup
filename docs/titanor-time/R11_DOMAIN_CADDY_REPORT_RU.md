# R11 — домен, Caddy и public login: отчёт

- **Основание:** production release roadmap R11; план/runbook `R11_DOMAIN_CADDY_PLAN_RU.md`.
- **Дата:** 2026-08-31.
- **Вариант:** A (grey-cloud / Cloudflare DNS-only) — решение владельца. Orange-cloud (Вариант B)
  отложен на после R15.
- **Вердикт:** **PASS.** `app.titanorgroup.fi` технически готов (валидный TLS, редиректы,
  заголовки), приложение пользователям **не открыто** — отдаёт 503 holding до R14. Production
  БД / live Titanor Time / MX не тронуты. DNS изменена только добавлением одной `A`-записи
  (владельцем).
- **Инцидент:** во время подготовки агент вызвал `caddy stop` в тесте → боевой Caddy лежал
  ~46 мин (08:41–09:27 CEST). Восстановлено, разобрано: `R11_INCIDENT_2026-08-31_caddy_outage.md`.

---

## 1. Что сделано

| roadmap R11 | статус |
|---|---|
| Caddy host для `app.titanorgroup.fi` | ✅ блок добавлен в `/etc/caddy/Caddyfile` |
| TLS | ✅ Let's Encrypt, CN `app.titanorgroup.fi`, `notAfter Nov 29 2026`, авто-renew Caddy |
| redirect HTTP→HTTPS | ✅ `308 → https://app.titanorgroup.fi/` |
| proxy headers | n/a на этом этапе (нет upstream — holding); `TITANOR_TRUSTED_PROXY_HOPS` остаётся 1 |
| security headers | ✅ `HSTS`, `X-Robots-Tag noindex`, `nosniff`, `X-Frame DENY`, `Referrer-Policy`, `Cache-Control no-store`; `Server` и `X-Powered-By` убраны |
| firewall/ports | ✅ `:80`/`:443` открыты и проверены; полный дамп `ufw` — owner action (§4) |
| maintenance response до cutover | ✅ 503 + брендированная holding-страница (RU+EN), `/var/www/titanor-time-holding/index.html` |
| public site EN/FI Employee login | ⏳ **отложено на R14** (решение владельца) — код/строки/deploy готовятся отдельно |
| отсутствие регистрации | ✅ подтверждено аудитом (нет routes регистрации) |
| Cloudflare instruction | ✅ выдана; владелец создал `A app → 84.247.130.242` (DNS only) |
| agent не переключает live DNS | ✅ запись создал владелец |
| propagation / cert / HTTPS / redirects / headers | ✅ проверено (§2) |
| maintenance/access control до R14 | ✅ holding остаётся до R14 |
| production БД / live Titanor Time data | ✅ не тронуты |

## 2. Проверки (2026-08-31, с хоста)

### `app.titanorgroup.fi`
```
HTTP/2 503
strict-transport-security: max-age=63072000
x-robots-tag: noindex, nofollow
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
cache-control: no-store
content-length: 1576            (holding-страница, <title>Titanor Time</title>, «Идёт подготовка»)
(нет Server, нет X-Powered-By)
```
- `http://app.titanorgroup.fi` → `308` → `https://app.titanorgroup.fi/`
- TLS: `issuer=Let's Encrypt`, `subject=CN app.titanorgroup.fi`, `notBefore Aug 31`, `notAfter Nov 29 2026`
- DNS: `dig +short app.titanorgroup.fi A` → `84.247.130.242` (grey-cloud, без `cf-ray`)

### Регрессия — существующие vhost, без изменений
| vhost | код |
|---|---|
| `https://titanorgroup.fi` | 307 (норм. редирект на `/en`) |
| `https://www.titanorgroup.fi` | 301 |
| `https://collabstudio.run` | 200 |
| `https://t97-…nip.io/login` | 200 |
| `https://t97-…nip.io/api/ready` | 200 `schema:current` 98/98 |
| `https://84-247-130-242.sslip.io` | 200 |

Caddy `active`, `:80`/`:443`/`127.0.0.1:2019` слушают.

## 3. Изменения конфигурации

- `/etc/caddy/Caddyfile` — добавлен блок `app.titanorgroup.fi` (см.
  `ops/titanor-time/r11/caddy-app-block.txt`). Backups:
  `Caddyfile.backup-before-r11-20260831T072400Z` (от упавшего запуска скрипта),
  `Caddyfile.backup-before-r11-20260831T073655Z` (перед ручным применением).
- `/var/www/titanor-time-holding/index.html` — holding-страница.
- Заголовки продублированы внутри `handle_errors`: первый (скриптовый) заход показал, что
  ответ 503 идёт отдельным error-маршрутом мимо site-level `header` — HSTS/X-Robots/-Server
  не попадали. Исправлено, перепроверено.
- Мелочь (не блокер): `caddy validate` предупреждает `Caddyfile input is not formatted`
  (двойная пустая строка перед новым блоком). `sudo caddy fmt --overwrite /etc/caddy/Caddyfile`
  + reload — когда будет удобно; конфиг валиден и так.

## 4. Открыто (не блокирует R11, нужно к R12/R14)

1. **FI-строка Employee login** для сайта (R14): «Kirjaudu sisään» или «Työntekijän kirjautuminen».
2. **`ufw`**: подтвердить правила (22/80/443); ограничивать ли внешние `8000`/`8080` (ardor staging).
3. **Порт production `3199`** (plan §6) — подтвердить.
4. **`docker builder prune`** — диск `/` 81 %.
5. **Модернизация browser-lane** — обязательна до R12 (`R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4).
6. `caddy fmt` косметика (см. §3).

## 5. Что дальше

- **R12:** production-like rehearsal (disposable env) — сначала browser-lane.
- **R14:** production-стек `titanor-time-prod-*` (порт 3199) на frozen-кандидате → в Caddy заменить
  `handle`/`handle_errors`/`root` на `reverse_proxy 127.0.0.1:3199` → опубликовать Employee-login
  ссылку на `titanorgroup.fi` → перенос pilot БД/uploads (backup старой prod-БД обязателен).
- **После R15 (опц.):** Вариант B orange-cloud (plan §4).
