# R04 — dependency security (публичный сайт `titanorgroup.fi`)

- **Основание:** production release roadmap R04, ТЗ §12.1. Закрывает блокер B05 (для публичного сайта).
- **Дата:** 2026-08-30.
- **Git SHA:** _<заполняется при коммите>_ на ветке `feature/titanor-time-foundation`.
- **Live-сайт `titanorgroup.fi` (контейнер `titanorgroup-web-1`), Titanor Time production, Caddy и
  DNS НЕ менялись.** Проверка выполнена в отдельном preview-процессе (`node .next/standalone/server.js`,
  порт 3902), контейнер не пересоздавался.

---

## 1. Before / After

`npm audit --omit=dev` в корне репозитория (публичный сайт):

| | R00 baseline | После R04 |
|---|---|---|
| high | **8** | **0** |
| critical / moderate / low | 0 | 0 |

JSON: `docs/titanor-time/baseline-2026-08-29/audit-public-site-before-R04.json` →
`audit-public-site-after-R04.json`. Полный `npm audit` (включая dev) — тоже **0**.

## 2. Что изменилось (одно тематическое изменение)

`package.json` (корень), затем `npm install` → `package-lock.json`:

| Пакет | Было | Стало | Как |
|---|---|---|---|
| `next` | `^16.2.6` (16.2.6) | **`16.3.3`** (pinned) | прямой dep |
| `postcss` | 8.4.31 | **8.5.23** | транзитивно через `next` |
| `nanoid` | 3.3.12 | **3.3.18** | транзитивно через `next` |
| `sharp` | 0.34.5 | **0.35.4** | транзитивно через `next` |
| `@prisma/client` | 6.19.0 | **удалён** | не использовался (см. §3) |
| `prisma` | 6.19.0 (dev) | **удалён** | не использовался |

`npm install`: `removed 35 packages` (весь Prisma-подграф: `@prisma/config`, `deepmerge-ts`,
`effect`, `c12`, …), `added 2`. `next-env.d.ts` вынесен в `.gitignore`.

`nodemailer@^9.0.3` (contact form) и `@types/nodemailer` оставлены без изменений — не в списке
уязвимостей.

## 3. Почему удалён Prisma

Исчерпывающий grep по всему дереву публичного сайта (`app/`, `lib/`, `next.config.mjs`,
корневой `Dockerfile`) — **ни одного** `import '@prisma/client'` / `PrismaClient` / ссылки на
`prisma/schema.prisma`. Публичный сайт вообще не использует БД:
- контент админки — `lib/service-content-store` (файловое хранилище);
- изображения/вакансии — файловая система (`UPLOAD_DIR`);
- контакт-форма — `nodemailer` (SMTP).

`@prisma/client` + `prisma` были мёртвыми зависимостями и давали 4 из 8 findings
(`effect`, `deepmerge-ts`, `@prisma/config`, `prisma`). Общий `prisma/schema.prisma` в корне
репозитория принадлежит Titanor Time и запускается его собственным `prisma`-бинарником —
удаление корневых Prisma-пакетов его не затрагивает.

## 4. Устранённые уязвимости

- **next**: SSRF в Server Actions / rewrites, DoS (Server Actions, Image Optimization SVG),
  cache confusion тела ответа, middleware bypass, раскрытие internal Server Function endpoints.
- **postcss**: XSS через неэкранированный `</style>`, path traversal через `sourceMappingURL`.
- **nanoid**: бесконечный цикл при нулевом/отрицательном `size`.
- **sharp**: наследованные CVE libvips (CVE-2026-33327/33328/35590/35591) — 0.34.5 → 0.35.4.
- **effect / deepmerge-ts / @prisma/config / prisma**: удалены вместе с неиспользуемым Prisma.

## 5. Проверки

| Гейт | Результат |
|---|---|
| clean `npm ci` (после `sudo rm -rf node_modules`) | ✓ 68 packages |
| `npm audit --omit=dev` | **0** (было 8 high) |
| `npx tsc --noEmit` | 0 ошибок |
| `npm run build` | ✓ Compiled successfully, **19/19** static pages |
| preview EN: `/en` `/en/services` `/en/career` `/en/contact` | 200 |
| preview FI: `/fi` `/fi/services` `/fi/career` `/fi/contact` | 200 |
| `/robots.txt` `/sitemap.xml` `/api/health` | 200 |
| `/ship-admin-portal` (страница входа) | 200 |
| `/api/admin/service-content` без сессии | 401 (guard работает) |
| `/uploads/<нет файла>` | 404 · `/api/service-images` 200 |
| навигация и FI-контент preview vs live `titanorgroup.fi` | **идентичны** (Etusivu/Palvelut/Yhteystiedot/Ura, тексты) |
| contact-form / admin-login POST | 500 в preview из-за отсутствия `SMTP_HOST` / `ADMIN_PASSWORD` в локальном окружении — **не регрессия R04** (эти env есть в live-контейнере; маршруты R04 не трогал) |

### Предсуществующее наблюдение (вне scope R04)

`/fi` отдаёт `<html lang="en">` (жёстко в `app/layout.tsx:28`; App Router не даёт дочернему
`[lang]/layout.tsx` переопределить корневой `<html>`). **Live-сайт ведёт себя так же** — это не
регрессия R04. Кандидат в отдельную i18n-задачу.

## 6. Деплой публичного сайта

Не входит в R04 (ТЗ: «live public site … не менять»). Публичный сайт деплоится отдельно
(`compose.yaml` / `Dockerfile` в корне, контейнер `titanorgroup-web-1`) — по решению владельца,
после того как CI на ветке зелёный. Rollback — обычный `docker compose` откат образа.

## 7. CI

Изменение попадает под существующий job `public-site-quality` в `.github/workflows/ci.yml`
(`npm ci` → lockfile-in-sync → `tsc --noEmit` → `npm run build`). CI result по коммиту R04 —
_<ссылка/статус при пуше>_.
