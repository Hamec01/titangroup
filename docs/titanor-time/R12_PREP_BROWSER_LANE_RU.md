# R12-prep — модернизация browser-lane

- **Основание:** `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4 — «Модернизация browser-lane обязательна
  до R12». `NEXT_AGENT_HANDOFF_RU.md` §6.
- **Дата:** 2026-08-31.
- **Этап 1 (модернизация тестов):** на образе R10-кандидата `t97-pilot-edd950c` (frozen `2ebe3e5`,
  **не пересобирался**) — все 15 browser-lane тестов зелёные. Изменения только в
  `titanor-time-app/scripts/_test-*` и `ops/titanor-time/`. 0 дефектов продукта.
- **Этап 2 (фикс latent bug перед R12):** найденный в этапе 1 языковой дефект (§3) исправлен
  минимальным product-коммитом `ef5548b` → **новый R12-кандидат:**
  - git HEAD `367420e1be45d76cd4afd1a1597e03c49ad45b4f` (product-код = `ef5548b`; всё что выше —
    только `scripts/_test-*` + `test-manifest.json`, `git diff ef5548b..367420e` по продукту пустой)
  - образ `titanor-time-app:r12-candidate-367420e`, revision label `367420e`, created `2026-08-31T11:45:24Z`
  - digest `sha256:b5f80cbd1cff8c307581d283d54b7668987157d696943d48a3a51ff80915d883`
  - (R10-образ `t97-pilot-edd950c` / `2ebe3e5` больше НЕ кандидат — в нём языковой дефект)
- **Вердикт:** **все 16 browser-lane тестов зелёные на новом кандидате** (`_test-offline-shell-locale`
  добавлен), свежая disposable PostgreSQL 16, изоляция на тест. **0 дефектов продукта.**
  Языковой дефект устранён — R12 проверяет финального кандидата без известных дефектов.

### Прогоны-доказательства (`docs/titanor-time/baseline-r12-prep/`)

Полный прогон на **пересобранном финальном образе** `r12-candidate-367420e`
(`full-verification-r12-candidate-367420e.txt`):

| прогон | результат |
|---|---|
| `run-browser-acceptance.sh` (14 изолированных, свежая PG16 + контейнер на тест) | **14 pass / 0 fail** |
| `run-restart-persistence.sh` (two-phase + docker restart) | full-flow 84/0 · prepare 5/0 · verify 18/0 — **PASS** |
| `run-worker-dossier-qa.sh` (seed + browser) | seed ok · 31/0 — **PASS** |

Итого **16/16 browser-lane тестов зелёные** на финальном кандидате.

---

## 1. Итог

| тест | до | после | что менялось в продукте |
|---|---|---|---|
| `_test-t9-role-matrix` | ✅ 32/0 | ✅ 32/0 | — |
| `_test-foreman-admin-redirect` | ✅ 10/0 | ✅ 10/0 | — |
| `_test-report-rounding-consistency` | ✅ | ✅ | — |
| `_test-csv-export` | ✅ 201/0 (`2ebe3e5`) | ✅ | — |
| `_test-period-time-report` | ✅ 110/0 (`2ebe3e5`) | ✅ | — |
| `_test-export-ui` | ✅ 87/0 (`2ebe3e5`) | ✅ | — |
| `_test-offline-cold-restart` | ✗ | ✅ **6/0** | PWA-редизайн: `.wk-main-action` / `.wk-main-action-wrap.{in,out}`, статус-лист, sync в листе |
| `_test-pwa-install` | ✗ 58/1 | ✅ **59/0** | Chromium снял требование service-worker для установки → нейтральное сообщение вместо «нельзя установить» |
| `_test-qualifications-browser-qa` | ✗ | ✅ **26/0** | T13.5: `/admin/qualifications` → redirect `/admin/workforce`; `#qm-status` → `#wf-status`; 2-й `.notif-bell-button` (review queue) |
| `_test-t9-setup-lifecycle` | ✗ 60/6 | ✅ **66/0** | онбординг: assignment авто-открывает период; чек-лист 5 обязательных строк (без «открыть период») |
| `_test-t9-full-flow` | ✗ | ✅ **84/0** | `waitPath()` вместо `page.waitForURL()` (виснет на soft-nav); онбординг worker → `/admin/workers/<id>`; убран reason-gate у работника (T10/T12); `common.returnedForCorrectionTitle` = «Open for edits again»; T12 unified review; RU-дефолт для UI-созданных работников |
| `_test-offline-views` | ✗ ~25 fail | ✅ **71/0** | offline-shell рендерил RU-дефолт даже для EN-пользователя (§3 — теперь исправлено, тесты проверяют RU там, где locale реально RU); PWA-редизайн клока; ссылка «Мои периоды» в меню; `networkidle` ненадёжен под нагрузкой |
| `_test-offline-shell-locale` | — (новый) | ✅ **новый** | регрессия §3: RU/EN/FI cold restart не затирает сохранённый выбор |
| `_test-t9-setup-ui` | ✗ | ✅ **26/0** | `waitPath()`; City-строка чек-листа ведёт на `/admin/cities` (список), не `/admin/cities/new`; `.wk-clock-card` → `.wk-clock-home-card` |
| `_test-t9-restart-persistence` | ✗ (нужен two-phase) | ✅ **prepare 5/0 + verify 18/0** | статус-лейбл «Final approved» вместо enum; `.wk-main-action-wrap.out` вместо текста «Clocked out» |
| `_test-worker-dossier-browser-qa` | ✗ (нет seed) | ✅ **31/0** | seed-скрипта `_qa-seed-worker-dossier.ts` не существовало — написан; тест не менялся |

## 2. Новая инфраструктура

- **`ops/titanor-time/run-browser-acceptance.sh`** (существовал) — из `SKIP` убран `_test-t9-setup-ui.ts`
  (теперь идёт в общем изолированном прогоне). Остаются `SKIP-HARNESS`:
  `_test-t9-restart-persistence.ts`, `_test-worker-dossier-browser-qa.ts` — у них свои раннеры.
- **`ops/titanor-time/run-restart-persistence.sh`** (новый) — two-phase T9.5: disposable PG16 +
  app из release-образа → `_test-t9-full-flow.ts` (сеет фикстуру) → `PHASE=prepare` →
  `docker restart` только app-контейнера (БД + volume живут) → `PHASE=verify` (побайтный
  hash-снимок + реальная запись ADMIN после рестарта).
- **`ops/titanor-time/run-worker-dossier-qa.sh`** (новый) — disposable PG16 + app →
  `scripts/_qa-seed-worker-dossier.ts` → `_test-worker-dossier-browser-qa.ts`.
- **`scripts/_qa-seed-worker-dossier.ts`** (новый) — идемпотентный seed: `QA-0001`,
  `qa_admin`/`qa_worker` (`QaPassw0rd!23`), фото профиля, HETU `030785-2464`, contact/address,
  2 квалификации (admin-VERIFIED «Occupational Safety Card» с фото + SELF_REPORTED «Custom QA
  Certificate»). Тест-файл при этом не тронут.

### Переиспользуемая находка: `waitPath()` вместо `page.waitForURL()`

Next.js App Router soft-navigation (`router.push`) не рождает `load`-событие, и
`page.waitForURL()` в этой версии Playwright (1.62) виснет 15–60 c даже когда URL уже сменился.
Замена: `page.waitForFunction(() => new RegExp(src).test(location.pathname + location.search))`.
Помещён локальной хелпер-функцией в `_test-t9-full-flow.ts` и `_test-t9-setup-ui.ts`.

## 3. Языковой дефект offline-shell — НАЙДЕН и ИСПРАВЛЕН

**Было:** offline PWA-оболочка показывала locale-дефолт (RU), даже если у пользователя `locale=EN`.
`AppLocaleProvider` в effect по `[locale]` безусловно писал `localStorage['titanor-time-locale']`.
`OfflineShellClient` монтирует его с `useState(DEFAULT_APP_LOCALE)` = `'RU'` на один рендер, до
того как его собственный `useEffect(() => setLocale(readClientLocale()))` подставит реальное
значение. Этот первый рендер успевал записать `'RU'`, затирая ранее сохранённый online-страницей
`'EN'`/`'FI'` — и последующий `readClientLocale()` читал уже `'RU'` (после чего localStorage
залипал на `'RU'` и для последующих online-визитов на первом кадре).

**Фикс (`ef5548b`, минимальный product-коммит):**
- `AppLocaleProvider` получил проп `persist` (default `true`) — authenticated section layouts
  авторитетны (их `locale` = server-resolved `User.locale` на первом рендере).
- `OfflineShellClient` передаёт `persist={false}` — офлайн-оболочка только **читает** сохранённый
  выбор. `document.documentElement.lang` по-прежнему обновляется.
- Не тронуто: IndexedDB / outbox / cache / device-binding / защита чужого аккаунта.

**Проверка (`_test-offline-shell-locale`, добавлен в lane):** для RU / EN / legacy-FI(→RU) —
online-визит сохраняет resolved-locale, затем настоящий cold restart (перезапуск процесса +
`setOffline`) рендерит кэш-оболочку на нужном языке и **не трогает** сохранённый ключ. Плюс все
15 существующих browser-lane тестов зелёные на пересобранном кандидате.

## 4. Как прогнать всё

```bash
IMAGE=titanor-time-app:r12-candidate-367420e PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env \
  ops/titanor-time/run-browser-acceptance.sh           # 14 тестов (изоляция на тест)
IMAGE=… PILOT_ENV=… ops/titanor-time/run-restart-persistence.sh   # _test-t9-restart-persistence
IMAGE=… PILOT_ENV=… ops/titanor-time/run-worker-dossier-qa.sh     # _test-worker-dossier-browser-qa
```

## 5. Что дальше

Browser-lane техдолг из `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4 **закрыт**, языковой дефект
устранён, кандидат пересобран и перепроверен. Оговорка перед R12 снята. **R12 — production-like
rehearsal** проверяет уже финального кандидата `r12-candidate-367420e` без известных дефектов.
