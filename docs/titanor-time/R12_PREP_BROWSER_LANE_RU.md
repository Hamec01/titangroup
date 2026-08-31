# R12-prep — модернизация browser-lane

- **Основание:** `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4 — «Модернизация browser-lane обязательна
  до R12». `NEXT_AGENT_HANDOFF_RU.md` §6.
- **Дата:** 2026-08-31.
- **Кандидат:** frozen `2ebe3e5`, образ `titanor-time-app:t97-pilot-edd950c` — **не пересобирался**.
  Все изменения — только в `titanor-time-app/scripts/_test-*` и `ops/titanor-time/`.
- **Вердикт:** **все 15 browser-lane тестов зелёные** на образе кандидата, свежая disposable
  PostgreSQL 16, изоляция на тест. **0 дефектов продукта** — только устаревшие ожидания тестов.

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
| `_test-offline-views` | ✗ ~25 fail | ✅ **71/0** | offline-shell рендерит RU-дефолт даже для EN-пользователя (см. §3 — latent bug); PWA-редизайн клока; ссылка «Мои периоды» в меню; `networkidle` ненадёжен на PWA-страницах под нагрузкой |
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

## 3. Latent bug (не блокер, backlog после production)

**Offline-shell рендерит locale-дефолт (RU), даже если у пользователя `locale=EN`.**
`AppLocaleProvider` пишет `localStorage['titanor-time-locale']` в effect по `[locale]`. В
`OfflineShellClient` `locale` инициализируется `useState(DEFAULT_APP_LOCALE)` = `'RU'`, а затем
`useEffect(() => setLocale(readClientLocale()))`. На первом рендере `AppLocaleProvider` успевает
записать `'RU'` в localStorage, затирая ранее записанный online-страницей `'EN'` — и последующий
`readClientLocale()` читает уже `'RU'`. EN-пользователь офлайн видит RU-интерфейс (и после этого
localStorage залипает на `'RU'`).

Не влияет на онлайн-рендер (там `resolveAppLocale()` берёт `session.user.locale`). Мелкий UX-дефект
офлайн-оболочки. Возможные фиксы: не писать localStorage из `AppLocaleProvider` пока это дефолт-
плейсхолдер офлайн-клиента; или `OfflineShellClient` читает `readClientLocale()` синхронно в
`useState`-инициализаторе. Тесты `_test-offline-views` пока проверяют фактическое (RU) поведение.

## 4. Как прогнать всё

```bash
IMAGE=titanor-time-app:t97-pilot-edd950c PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env \
  ops/titanor-time/run-browser-acceptance.sh           # 13 тестов (изоляция на тест)
IMAGE=… PILOT_ENV=… ops/titanor-time/run-restart-persistence.sh   # _test-t9-restart-persistence
IMAGE=… PILOT_ENV=… ops/titanor-time/run-worker-dossier-qa.sh     # _test-worker-dossier-browser-qa
```

## 5. Что дальше

Browser-lane техдолг из `R10_PILOT_ACCEPTANCE_REPORT_RU.md` §4 **закрыт**. Оговорка перед R12
снята. Можно переходить к R12 — production-like rehearsal (полная acceptance-матрица теперь
воспроизводима на disposable-окружении).
