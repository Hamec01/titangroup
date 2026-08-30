# Titanor Time — R05: dependency security (Titanor Time runtime)

- **Основание:** production release roadmap R05, ТЗ §12.2. Закрывает блокер B05 (для Titanor Time).
- **Дата:** 2026-08-30.
- **Production / Caddy / DNS не затронуты.** Публичный сайт — отдельный этап R04.

---

## 1. Before / After

`npm audit --omit=dev` в `titanor-time-app/`:

| | R00 baseline | После R05 |
|---|---|---|
| high | **8** | **0** |
| critical / moderate / low | 0 | 0 |

JSON: `docs/titanor-time/baseline-2026-08-29/audit-titanor-time.json` (before) →
`audit-titanor-time-after-R05.json` (after). Полный `npm audit` (включая dev) — тоже **0**.

## 2. Что изменилось

| Пакет | Было | Стало | Как | Slice / commit |
|---|---|---|---|---|
| `next` | 16.2.12 | **16.3.3** (pinned) | прямой dep | A · `37d5ca8` |
| `postcss` | 8.4.31 | **8.5.23** | транзитивно через `next` | A |
| `nanoid` | 3.3.16 | **3.3.18** | транзитивно через `next` | A |
| `sharp` (bundled) | `next/node_modules/sharp@0.34.5` | удалён; один `sharp@0.35.3` | дедупликация после bump `next` | A |
| `@prisma/client` | 6.19.0 | **6.19.3** | прямой dep, patch | B · `7bc6c77` |
| `prisma` (CLI) | 6.19.0 | **6.19.3** | dev dep, patch | B |
| `effect` | 3.18.4 | **3.21.0** | через `@prisma/config@6.19.3` | B |
| `deepmerge-ts` | 7.1.5 | **8.0.2** | `overrides` (см. §4) | B |

Никаких major-upgrade. Next — minor в пределах 16.x. Prisma — patch. Порядок слоёв: сначала
Next/runtime (A), отдельно Prisma (B) — «не смешивать в один непроверяемый шаг» (ТЗ §12.2).

## 3. Устранённые уязвимости

- **next** (GHSA): SSRF в Server Actions / rewrites, DoS (Server Actions, Image Optimization SVG),
  cache confusion тела ответа, middleware/proxy bypass (App Router + Turbopack + single locale),
  unauthenticated раскрытие internal Server Function endpoints, unbounded Server Action payload.
- **postcss**: XSS через неэкранированный `</style>`, path traversal / чтение произвольного
  `.map` через `sourceMappingURL` (несколько advisories, включая неполные фиксы).
- **nanoid**: бесконечный цикл при нулевом/отрицательном `size`.
- **effect**: потеря/загрязнение `AsyncLocalStorage`-контекста внутри Effect-fiber'ов под
  конкурентной RPC-нагрузкой.
- **deepmerge-ts**: stack exhaustion при слиянии рекурсивных графов объектов.

## 4. `deepmerge-ts` через `overrides` — оценка (ТЗ §12.2 «отдельно оценить»)

`@prisma/config@6.19.3` всё ещё пинит `deepmerge-ts@7.1.5`. Мы форсируем `^8.0.2` через
`overrides` в `titanor-time-app/package.json`.

- **Практический риск исходной уязвимости ≈ 0**: `deepmerge-ts` в Prisma используется только для
  слияния небольшого статического конфиг-файла (`prisma.config.*` / env), а не
  атакующе-контролируемого рекурсивного графа. Это build/CLI-время, не runtime-путь приложения.
- **Совместимость 7→8 проверена**: `prisma generate` (v6.19.3), `prisma validate`,
  `prisma migrate deploy` (95 миграций, «up to date»), полный regression 62/62 — всё зелёное с
  `deepmerge-ts@8.0.2`.
- Override снимается, как только выйдет `@prisma/config`, зависящий от `deepmerge-ts@^8`.

## 5. `sharp`

`sharp@0.35.3` (прямой pinned dep) — **не в диапазоне** advisory `sharp <0.35.0`; `npm audit`
его не отмечает. `0.35.4` доступен (несрочный patch libvips) — отложен, чтобы не расширять
поверхность изменения без необходимости. Дублирующий `sharp@0.34.5` из старого дерева `next`
удалён вместе с bump'ом Next.

## 6. Проверки

| Гейт | Результат |
|---|---|
| `npm audit --omit=dev` | **0** (было 8 high) |
| `npm install` — lockfile воспроизводим | ✓ (`overrides` учтён) |
| `prisma generate` (v6.19.3) + `validate` + `migrate deploy` (95) | ✓ с `deepmerge-ts@8` |
| `npm run typecheck` | 0 ошибок |
| `npm run lint` | ✓ |
| `npm run build` | ✓ Compiled successfully, 11/11 static pages |
| `npm run test:unit` + `test:db` | **62/62**, 0 регрессий |
| browser smoke | R12 (lane «browser», ТЗ §18.2 п.10) |

## 7. Pilot image + deploy

R03 задеплоен владельцем 2026-08-30 (`deploy-22e8b12.sh`) — пилот на `t97-pilot-22e8b12`,
БД 95 миграций, `PASSWORD_RESET_TOKEN_HMAC_KEY` в `app.env`.

R05 — **чистый свап образа**, без миграций:
- образ `titanor-time-app:t97-pilot-1e4dc92` (id `c6313e04`, 1.79 GB — меньше R03's 1.89 GB
  за счёт лёгкого дерева Next 16.3.3 + удалённого nodemailer);
- скрипт `/home/deploy/app-data/t97-pilot/deploy-1e4dc92.sh`: pre-deploy backup → `migrate deploy`
  (идемпотентный no-op) + `migrate status` = «up to date» → пересоздание app+scheduler на новом
  образе → verify (`/api/ready` `/reset-password` `/worker` = 200, scheduler tick, prod baseline).

**Проверено до деплоя:** восстановление pre-deploy-бэкапа → `migrate deploy` образом R05 доводит
93→95 чисто; `migrate status` против клона на 95 = «up to date»; boot образа R05 против клона —
`/api/ready` `/login` `/reset-password` `/worker` = 200, `/api/auth/change-password` = 401
без сессии, логи чистые. prod (`daa2edbb`, restarts 0) не тронут.
