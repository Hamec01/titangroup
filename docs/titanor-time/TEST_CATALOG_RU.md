# Titanor Time — каталог тестов (R02)

Источник истины — `titanor-time-app/scripts/test-manifest.json` (машиночитаемый). Этот файл —
его человекочитаемое зеркало и объяснение lane'ов. `npm run test:check-manifest` (и CI) падают,
если на диске появился/исчез `scripts/_test-*.ts`, не отражённый в манифесте.

## Как запускать

```bash
cd titanor-time-app

npm run typecheck        # tsc --noEmit по tsconfig.json (код приложения + scripts/)
npm run lint             # prisma validate + schema-format + манифест + smoke на секреты
npm run test:check-manifest

npm run test:unit        # lane unit — без БД и сервера
npm run test:scheduler   # lane scheduler — нужна БД
npm run test:db          # lane db + scheduler — нужна БД
npm run test:browser     # lane browser — нужен TEST_BASE_URL, иначе SKIPPED
npm run test             # unit + db + scheduler (НЕ browser)
npm run test:catalog     # печать каталога по lane'ам
```

БД-lane'ам нужен `TT_TEST_DB_URL` — строка подключения к **одноразовому** PostgreSQL 16:

```bash
docker run -d --name tt-testdb -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55440:5432 postgres:16
export TT_TEST_DB_URL=postgresql://postgres:dev@127.0.0.1:55440/postgres
```

`run-tests.mjs` **отказывается** запускаться против URL, похожего на pilot/production (`pilot`,
`prod`, `t97`, `titanor-time-db`, порт `55497`). Для каждого теста он создаёт отдельную БД —
клон мигрированного шаблона — так тесты не видят строк друг друга и весь lane воспроизводится
с нуля. Ключи шифрования (`IDEMPOTENCY_ENCRYPTION_KEY` и т.д.) подставляются одноразовыми, если
не заданы.

## Lane'ы

| lane | нужна БД | нужен сервер | в CI-гейте | назначение |
|---|:--:|:--:|:--:|---|
| `unit` | нет | нет | да | чистые функции / замоканные глобалы |
| `db` | да (свежая на тест) | нет | да | прямой вызов route-handler'ов / lib; без HTTP-сервера |
| `scheduler` | да | нет | да | как `db`, но предмет теста — тик планировщика / horizon / auto-close |
| `browser` | да | да (`TEST_BASE_URL`) | **нет** — R12 | реальный standalone-сервер, обычно + Chromium (playwright) |
| `manual` | — | — | нет | вне автоматических гейтов; причина — в примечании теста |
| `helper` | — | — | — | модуль, импортируемый другими тестами; сам не запускается |

**Почему browser не в CI:** этим тестам нужен собранный standalone-сервер и браузер Chromium.
Они относятся к pilot acceptance (ТЗ §18.2 п.10, §19) и прогоняются на этапе R12. Три из них
(`_test-csv-export.ts`, `_test-period-time-report.ts`, `_test-report-rounding-consistency.ts`)
делают HTTP-запросы к серверу, но не поднимают Chromium.

## unit (11)

| файл | что |
|---|---|
| `_test-auto-unpaid-break.ts` | `computeDayWorkedMs` / `effectiveUnpaidBreakMinutes` |
| `_test-exception-list-query.ts` | `parseExceptionListQuery` |
| `_test-offline-idb-invariants.ts` | инварианты IndexedDB-outbox через `fake-indexeddb`; сам ре-спавнится по фазам |
| `_test-personal-data-encryption-unavailable-response.ts` | 503-хелпер при недоступном ключе шифрования |
| `_test-personal-identity-code.ts` | валидация henkilötunnus + модуль AES-256-GCM |
| `_test-presence-pacing.ts` | правило пейсинга `shouldCapturePresence` |
| `_test-qualification-expiry.ts` | `computeQualificationExpiryStatus` |
| `_test-retention-pacing.ts` | 24-часовой гейт `maybeRunRetentionCore` (scheduler-adjacent, без БД) |
| `_test-time-rounding.ts` | `roundReportedInstant` / `roundReportedInterval` |
| `_test-warm-cache.ts` | retry/concurrency `warmOfflineShellCache` через замоканные `fetch`/`caches` |
| `_test-worker-gps.ts` | выбор лучшего фикса окна в `captureGpsSnapshot` |

## scheduler (4)

| файл | что |
|---|---|
| `_test-abandoned-shift-auto-close.ts` | `runAbandonedShiftAutoCloseTick` + `resolveAutoCloseEndAt` |
| `_test-qualification-notifications.ts` | генерация уведомлений (истечение квалификаций) |
| `_test-qualification-notification-thresholds.ts` | пороги 60/14/7/expired; R02 — привязка к календарю Helsinki |
| `_test-timesheet-submission-schedules.ts` | `assignWorkerSubmissionSchedule` + horizon; R02 — auto-enroll первого назначения |

## db (46)

`_test-account-recovery`, `_test-activation`, `_test-admin-approve-timesheet`,
`_test-admin-direct-edit`, `_test-admin-mark-absence-day`, `_test-admin-pre-final-correction`,
`_test-attendance-presence`, `_test-bulk-ack-gps`, `_test-checkin-never-blocked` (R02 — фикс
невозможного сравнения `FAILED`), `_test-corrections`, `_test-csv-export-querycount`,
`_test-custom-report-canonical`, `_test-custom-report-pdf-csv`, `_test-customer-hours`,
`_test-export-batch-schema`, `_test-gps-accuracy-threshold`, `_test-gps-approximate-sync`,
`_test-gps-exception-detail`, `_test-gps-offline-resilience-schema`, `_test-map-gps`,
`_test-overview-querycount`, `_test-overview`, `_test-owner-today-dashboard` (R02 — инъекция
`asOf`), `_test-pilot-pair-orphan`, `_test-planned-break-paid-propagation`,
`_test-professions-api`, `_test-professions-dossier`, `_test-professions-schema`,
`_test-pwa-offline-fixture`, `_test-qualification-edit-verification-reset`,
`_test-qualification-matrix`, `_test-qualification-photo-hardening`,
`_test-qualification-photo-lifecycle`, `_test-site-gps-flag`, `_test-standalone-admin-activation`,
`_test-time-rounding-materializer`, `_test-timesheet-approval-notifications`, `_test-worked-days`,
`_test-worker-dossier-pdf`, `_test-worker-dossier-profile`, `_test-worker-notifications`,
`_test-worker-professions`, `_test-worker-reopen-edit-window`, `_test-workforce-matrix`.

## browser (12)

| файл | Chromium | что |
|---|:--:|---|
| `_test-foreman-admin-redirect.ts` | нет | редирект `/foreman` → `/admin` для ADMIN/SUPER_ADMIN |
| `_test-csv-export.ts` | нет | CSV-экспорт end-to-end (HTTP) |
| `_test-period-time-report.ts` | нет | отчёт по периоду (HTTP) |
| `_test-report-rounding-consistency.ts` | нет | согласованность округления между поверхностями (HTTP) |
| `_test-export-ui.ts` | да | админский UI экспорта |
| `_test-offline-cold-restart.ts` | да | PWA offline cold-restart |
| `_test-offline-views.ts` | да | offline-экраны работника |
| `_test-pwa-install.ts` | да | установка PWA |
| `_test-qualifications-browser-qa.ts` | да | админский UI квалификаций |
| `_test-t9-full-flow.ts` | да | полный цикл attendance→табель→approval |
| `_test-t9-restart-persistence.ts` | да | персистентность после рестарта |
| `_test-t9-role-matrix.ts` | да | матрица ролей/прав (UI + HTTP); R02 — проверки отказа стали независимыми от языка |
| `_test-t9-setup-lifecycle.ts` | да | жизненный цикл setup |
| `_test-t9-setup-ui.ts` | да | UI setup |
| `_test-worker-dossier-browser-qa.ts` | да | админский UI досье работника |

## helper (1)

| файл | что |
|---|---|
| `_test-t9-fixtures.ts` | `buildFixture` — общий строитель фикстур T9; импортируется browser-тестами t9-* и `_test-foreman-admin-redirect.ts`; сам не запускается |

## manual (0)

Пусто. Ни один тест не является деструктивным и не требует ручной подготовки сверх lane'а.
