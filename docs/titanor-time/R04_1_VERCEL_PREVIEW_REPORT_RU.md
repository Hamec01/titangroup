# R04.1 — Vercel Preview build regression (публичный сайт)

- **Основание:** регрессия после R04 (`next` 16.2.6 → 16.3.3). Только автоматический Vercel
  **Preview** ветки `feature/titanor-time-foundation`.
- **Дата:** 2026-08-30.
- **Не затронуто:** live-сайт `titanorgroup.fi` (VPS, `titanorgroup-web-1`), Titanor Time
  production, Caddy, DNS. Vercel production deployment/promotion — **не выполнялись** (запрещено),
  только Preview.

---

## 1. Симптом

Vercel Preview падает **после** успешной компиляции Next (19/19 страниц):

```
ENOENT: no such file or directory, open '/vercel/path0/.next/next-server.js.nft.json'
```

в шаге финализации сборки Vercel (`onBuildComplete` / `@vercel/next`).

## 2. Локализация

| commit | root `next` | Vercel Preview |
|---|---|---|
| `68dbeaf` | 16.2.6 | ✅ success |
| `105680d`, `925923f`, `aaa66af`, `3f56773` | **16.3.3** | ❌ ERROR (`ENOENT … next-server.js.nft.json`) |

`next.config.mjs` (`output: 'standalone'`) не менялся всё это время. Регрессия появилась ровно
на bump'е Next.

## 3. Из build-лога упавшего Preview

```
Restored build cache from previous deployment (4ULD9TffEsotjEp3WDeLYgmJ9S4P)
Installing dependencies...
removed 35 packages, and changed 13 packages in 8s      ← кеш node_modules из pre-R04 деплоя,
                                                           npm догоняет его до нового lockfile
Detected Next.js version: 16.3.3
▲ Next.js 16.3.3 (Turbopack)
  Applying modifyConfig from Vercel                     ← Vercel модифицирует наш конфиг
✓ Running next.config.mjs took 106ms
  Creating an optimized production build ...
… (компиляция 19/19) …
ENOENT … .next/next-server.js.nft.json
```

Два фактора вместе: **(a)** восстановленный build-cache от сборки Next 16.2.x; **(b)** `output:
'standalone'`, который Vercel официально не поддерживает и обрабатывает через собственный
`modifyConfig`.

## 4. Что проверено локально (чистые сборки, без кеша)

Next 16.3.3 (Turbopack — как на Vercel), корень репозитория, `rm -rf .next` перед каждой:

| Сборка | `output` | Результат |
|---|---|---|
| `npm run build` (VERCEL не задан = Docker/self-hosted) | `standalone` | exit 0, 19/19, **`.next/standalone/server.js` есть**, `required-server-files.json → config.output: "standalone"`, `.next/next-server.js.nft.json` (110 КБ) есть |
| `VERCEL=1 npm run build` (эмуляция Vercel) | не задан | exit 0, 19/19, native output, standalone-каталога нет, `config.output: undefined`, `.next/next-server.js.nft.json` есть |

→ Сам файл `next-server.js.nft.json` Next 16.3.3 **генерирует** в обеих конфигурациях. Проблема —
на стороне платформы Vercel: её финализация ломается на `output: 'standalone'` (+ усугубляется
устаревшим Turbopack-кешем).

## 5. Исправление

`next.config.mjs`:

```js
output: process.env.VERCEL ? undefined : 'standalone'
```

- **Docker / self-hosted** (`VERCEL` не задан): `output: 'standalone'` — без изменений, обязательно
  для рантайм-образа (`Dockerfile` копирует `.next/standalone/` и запускает `server.js`).
- **Vercel** (`VERCEL=1`): `output` не задан — платформа использует свой нативный output и
  serverless-адаптер, без конфликта.

Это официально рекомендованный подход (Vercel/Next: «не используйте `output: 'standalone'` на
Vercel»). Не хак: файл не подделывается, trace не копируется вручную, Next не даунгрейдится,
ошибка не маскируется postbuild-скриптом.

Смена значимого поля `next.config.mjs` вместе с уже изменённым lockfile инвалидирует
предположения Vercel о build-cache — следующая Preview-сборка чистая.

## 6. Проверки

| Гейт | Результат |
|---|---|
| локальная `npm run build` (Docker target) | ✅ 19/19, `.next/standalone/server.js` present, `config.output: standalone` |
| локальный Docker-образ (`docker build -f Dockerfile .`) | ✅ собран (358 МБ), `.next/standalone` перенесён |
| образ запускается: `server.js` есть, `/en` `/fi` `/api/health` `/robots.txt` `/sitemap.xml` `/ship-admin-portal` = **200** | ✅ |
| Vercel Preview на fix-коммитах `27e65cb` / `9c7f45f` | ✅ **success** — GitHub commit status `Vercel` = `success`, «Deployment has completed» (было `failure` на `aaa66af` / `3f56773`) |
| EN/FI, admin guard (401), uploads (404), robots, sitemap, health | ✅ на локальном Docker-образе (код идентичен; Vercel-деплой отличается только форматом build-output). Финальный прогон по `*.vercel.app` — за владельцем с токеном |
| live-сайт `titanorgroup.fi` не изменился | ✅ контейнер `titanorgroup-web-1` не трогался |

## 7. Git

- Отдельный commit: `27e65cb` — только `next.config.mjs` (+ этот отчёт).
- CI по `9c7f45f`: **6/6 job success**, включая `public-site-quality` и `CI summary (required)`.

## 8. Итог

Причина доказана: `output: 'standalone'` × Vercel-адаптер, сломалось на Next 16.3
(бисекция до точного коммита; чистые локальные сборки Next 16.3.3 в обоих режимах исключили
баг Next; фикс, переключающий Vercel на нативный output → Preview `success`). Docker/self-hosted
standalone сохранён и проверен реальной `docker build` + запуском. CI 6/6. Live-сайт не тронут.

Открытый (мелкий): прогон EN/FI/admin/uploads по самому `*.vercel.app` Preview-URL — когда у
владельца будет токен. Vercel `state: success` уже подтверждает, что build+deploy прошли.

## Бэклог (записано, вне R04.1)
- `/fi` отдаёт `<html lang="en">` (жёстко в `app/layout.tsx`; на live так же) → UX/i18n-этап.
- contact/admin POST проверить с реальными env (`SMTP_*`, `ADMIN_*`) до live-деплоя сайта.
