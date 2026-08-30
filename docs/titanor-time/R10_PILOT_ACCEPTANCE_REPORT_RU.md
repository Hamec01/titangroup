# R10 — pilot acceptance report (release candidate)

- **Основание:** production release roadmap R10 «Release candidate и полная pilot acceptance»,
  ТЗ §18 (тестовые группы) + §19 (обязательная pilot acceptance-матрица) + §22 (критерии готовности).
- **Дата:** 2026-08-30 … 31.
- **Кандидат (frozen):** ветка `feature/titanor-time-foundation` @ `2ebe3e5`; **код приложения и
  все 98 миграций идентичны задеплоенному на пилот образу** `titanor-time-app:t97-pilot-edd950c`
  (`sha256:0282e68f…`). С `edd950c` менялись только `docs/`, `ops/`, и `scripts/_test-*` (обновление
  устаревших ожиданий, см. §4) — рантайм приложения не трогался. См. `R10_RELEASE_MANIFEST_RU.md`.
- **Production / DNS / Caddy / Cloudflare — не тронуты.**
- **Вердикт:** **PASS с оговоркой.** Нет открытых P0/P1 дефектов продукта. Вся бизнес-логика,
  миграции, backup/restore и зависимости — зелёные. **Единственная оговорка — техдолг browser-lane
  (§4): 9 UI-тестов несут ожидания, устаревшие с ~2026-08-20 (i18n, редизайн worker PWA, упрощение
  онбординга, T10-D, T13-матрица, R07-A, R09.2). Продуктовых дефектов среди них нет** — каждое
  поведение перекрыто зелёным db/unit-тестом + ручной проверкой. Модернизацию browser-lane
  завершить до финальной репетиции R12.

---

## 1. Автоматические проверки (ТЗ §18)

| # | группа | статус | доказательство |
|---|---|---|---|
| 1 | typecheck | ✅ | `npx tsc --noEmit` exit 0 (кандидат) |
| 2 | lint | ✅ | `npm run lint` — prisma validate + schema-format + manifest sync + migration-inventory sync + runtime-bundle compile + secret-scan |
| 3 | unit-тесты | ✅ **17/17** | `baseline-r10/testrun-unit-db-scheduler.txt` |
| 4 | db-тесты | ✅ **58/58** | там же (per-test template-clone) |
| 5 | scheduler-тесты | ✅ **5/5** | там же |
| 6 | reports / PDF / CSV | ✅ | db: `_test-csv-export-querycount`, `_test-custom-report-canonical`, `_test-custom-report-pdf-csv`, `_test-customer-hours`, `_test-workforce-matrix`, `_test-worker-dossier-pdf` — все PASS. browser: `_test-csv-export` **201/0**, `_test-period-time-report` **110/0**, `_test-report-rounding-consistency` PASS, `_test-export-ui` **87/0** (после §4) |
| 7 | scheduler | ✅ | как #5 + пилот: heartbeat `lastOutcome:ok cf:0`, ~30 тиков за 30 мин, lease renewed |
| 8 | Docker build / run | ✅ | образ `t97-pilot-edd950c` собран (revision-label проверен), boot `/api/ready` 200 на disposable + на пилоте |
| 9 | backup / restore | ✅ **13/13** | `restore-test-titanor-time.sh` против `pilot-20260830T215914Z-pre-deploy` — all-data fingerprint **точно** совпадает; `baseline-r10/restore-test.txt` |
| 10 | browser / device matrix | ⚠️ **частично** | см. §3 + §4; `_test-t9-role-matrix` **32/0**, `_test-foreman-admin-redirect` **10/0**, 3 report-теста зелёные после §4; остальные 9 UI-тестов — техдолг (0 дефектов продукта); реальные устройства — owner action §6 |

**Итого автоматика (без browser UI-техдолга): unit 17 + db 58 + scheduler 5 = 80/80, 0 fail.**
Полный прогон — на образе кандидата, свежая disposable PostgreSQL 16, per-test изоляция.

## 2. Regression R03 / R05 / R06 / R07 / R08 / R09

| стадия | что проверялось в R10 | результат |
|---|---|---|
| **R03** recovery/profiles | `_test-account-recovery`, `_test-recovery-api`, `_test-change-password`, `_test-session-management` (db) | ✅ 4/4 |
| **R05** deps (Titanor Time) | `npm audit --omit=dev` | ✅ **0 vulnerabilities** |
| **R06-A** readiness/scheduler | `_test-ready-schema`, `_test-scheduler-lease`, `_test-scheduler-health`, `_test-scheduler-diagnostics` | ✅ 4/4 + пилот `/api/ready` `schema:current`, scheduler HEALTHY |
| **R06-B** Docker runtime | образ кандидата boot + `.runtime/*.cjs` присутствуют, `migrate deploy` из `.prisma-tools` | ✅ |
| **R07-A** security hardening | `_test-client-ip`, `_test-rate-limit`, `_test-rate-limit-db`, `_test-api-guard`, `_test-malformed-uuid` (unit+db) + пилот: 7 security-заголовков, no X-Powered-By, rate-limit → 429, malformed-UUID → 401/404 | ✅ |
| **R07-B** public site | вне scope Titanor Time; отдельно DEPLOYED+PASS (`R07B_…`) | — |
| **R08** GPS archive | `_test-gps-archive`, `_test-gps-archive-run`, `_test-gps-retention-gate`, `_test-gps-archive-runner`, `_test-gps-archive-e2e`, `_test-attendance-presence` (unit+db) + пилот: `.runtime/gps-archive.cjs` bogus→2 / empty-key→3, retention `retentionOutcome:ok` | ✅ 6/6 + пилот |
| **R09** UX | `_test-admin-users-list`, `_test-document-attention`, `_test-worker-clock-panel`, `_test-worker-card-nav`, `_test-access-denied-notice` (unit+db) + пилот deploy verify | ✅ 5/5 |

**Ни одной регрессии.** 3 browser-теста, «сломавшихся» из-за R07-A/R09.2, — это устаревшие
ожидания в тестах (обновлены в §4), а не регрессия поведения.

## 3. Acceptance-матрица ТЗ §19

Легенда: ✅ авто-покрыто · 👤 требует ручной/девайс-проверки на пилоте (§6) · ⚠️ авто-тест
устарел (§4), поведение перекрыто другим зелёным тестом.

### §19.1 Авторизация
| пункт | покрытие |
|---|---|
| WORKER / FOREMAN / ADMIN / SUPER_ADMIN login | ✅ `_test-t9-role-matrix` 32/0 (UI+HTTP, все роли) · `_test-activation`, `_test-standalone-admin-activation` |
| login по username / email | ✅ `_test-account-recovery` (email), db `_test-recovery-api`; 👤 живой вход обеими на пилоте |
| неверный пароль | ✅ rate-limit тесты + `_test-t9-role-matrix`; пилот: 6-я попытка → 429 |
| deactivated account | ✅ `_test-t9-role-matrix` (active-role-window), db `_test-session-management` |
| admin recovery / одноразовость / expiry кода | ✅ `_test-account-recovery`, `_test-recovery-api` (attempt-lock, expiry, redeem-once) |
| отзыв старых sessions | ✅ `_test-change-password` (revokes others), `_test-session-management` |

### §19.2 WORKER
| пункт | покрытие |
|---|---|
| check-in / check-out / switch site | ✅ db `_test-checkin-never-blocked`, `_test-pilot-pair-orphan`, `_test-corrections`; ⚠️ `_test-t9-full-flow` (UI, §4); 👤 живой цикл на пилоте (R09 browser-чек-лист) |
| GPS available / unavailable / denied | ✅ unit `_test-worker-gps`, db `_test-gps-accuracy-threshold`, `_test-gps-approximate-sync`, `_test-attendance-presence`, `_test-gps-exception-detail` |
| offline outbox / cold restart / повторная sync | ✅ unit `_test-offline-idb-invariants`, `_test-warm-cache`, db `_test-pwa-offline-fixture`, `_test-gps-approximate-sync`; ⚠️ `_test-offline-views`, `_test-offline-cold-restart` (UI, §4 — pre-i18n/pre-redesign); 👤 живой offline-тест на пилоте |
| ручные часы / submit / reopen / returned | ✅ db `_test-worker-reopen-edit-window`, `_test-admin-approve-timesheet`, `_test-worker-notifications`, `_test-time-rounding-materializer`, `_test-auto-unpaid-break` |
| profile / account | ✅ db `_test-worker-dossier-profile`, `_test-worker-professions`, `_test-qualification-*`; ⚠️ `_test-worker-dossier-browser-qa` (UI, нужен fixture) |
| PWA install | ✅ `_test-pwa-install` **58/59** (scenario 24 — §4) |

### §19.3 FOREMAN
| пункт | покрытие |
|---|---|
| scoped worker list / review queue / exceptions | ✅ `_test-t9-role-matrix` (own-site report 200, foreign-site 404), db `_test-overview`, `_test-exception-list-query`, `_test-bulk-ack-gps` |
| standard / bulk approval | ✅ db `_test-admin-approve-timesheet`, `_test-admin-pre-final-correction` |
| запрет доступа к чужим объектам | ✅ `_test-t9-role-matrix` («NOT-assigned site → 404, not a data leak»), `_test-foreman-admin-redirect` 10/0 |
| mobile / tablet navigation | 👤 FOREMAN UI **вне scope R09** (backlog) — визуальная проверка на пилоте по желанию, не блокер |

### §19.4 ADMIN / SUPER_ADMIN
| пункт | покрытие |
|---|---|
| dashboard / setup / users / workers | ✅ db `_test-owner-today-dashboard`, `_test-overview`, `_test-admin-users-list` (R09.1), `_test-document-attention` (R09.5); ⚠️ `_test-t9-setup-lifecycle`, `_test-t9-setup-ui` (UI, §4 — pre-онбординг-упрощение) |
| sites / areas / geofence / assignments | ✅ db `_test-map-gps`, `_test-site-gps-flag`, `_test-gps-offline-resilience-schema`; ⚠️ `_test-t9-full-flow` (UI) |
| schedules / periods / review / corrections / direct edit | ✅ db `_test-timesheet-submission-schedules`, `_test-admin-direct-edit`, `_test-admin-mark-absence-day`, `_test-corrections`, `_test-worked-days` |
| qualifications / professions | ✅ db `_test-qualification-matrix`, `_test-workforce-matrix`, `_test-professions-*`, `_test-qualification-edit-verification-reset`; ⚠️ `_test-qualifications-browser-qa` (UI, §4 — pre-T13 `#qm-search`) |
| reports / PDF / CSV | ✅ browser `_test-csv-export` 201/0, `_test-period-time-report` 110/0, `_test-report-rounding-consistency` PASS, `_test-export-ui` 87/0; db `_test-custom-report-pdf-csv`, `_test-customer-hours`, `_test-worker-dossier-pdf` |
| recovery access / profile / sessions | ✅ как §19.1 |

### §19.5 Infrastructure
| пункт | результат (пилот `t97-pilot-edd950c`, 2026-08-30) |
|---|---|
| app health / readiness | ✅ `/api/health` 200; `/api/ready` `{"schema":"current","applied":98,"expected":98}` |
| несколько успешных scheduler cycles | ✅ heartbeat `lastOutcome:ok consecutiveFailures:0`; ~30 тиков / 30 мин; lease renewed 39 s назад холдером `7725b957fc51` |
| app restart / scheduler restart / DB restart | ✅ отрабатывалось в R06-B.1 (SIGKILL + stale-lease recovery) и в R09 deploy (graceful stop rc=0, lease handoff чисто, оба контейнера `healthy` restarts 0) |
| backup / restore | ✅ §1 #9 — 13/13, fingerprint точный |
| Caddy / HTTPS | 👤 external `https://t97-…nip.io/login` → 200 (informational; Caddy — R11) |
| security headers | ✅ пилот `/login`: nosniff, X-Frame DENY, Referrer-Policy, HSTS, X-Robots noindex, Permissions-Policy lockdown, **no X-Powered-By** |
| disk-space threshold | ⚠️ хост `/` **81 %** (116 / 145 GB); Docker **build cache 65 GB (43 GB reclaimable)** — owner action §6 |
| upload persistence | ✅ backup/restore извлекает uploads (3 файла == manifest); пилот uploads bind-mount не менялся |

### §19.6 Устройства
| пункт | статус |
|---|---|
| iPhone/Safari · Android/Chrome · desktop Chrome · desktop Safari · PWA · GPS · offline/cold restart | 👤 **owner action** — реальные устройства автоматизировать нельзя. Чек-лист: `R10_MANUAL_ACCEPTANCE_CHECKLIST_RU.md` (+ `R09_BROWSER_ACCEPTANCE_RU.md` для R09-специфики). Chromium-прогон в headless-режиме — §3/§4. |

## 4. Находка: техдолг browser-lane (не блокер)

Browser-lane (`lane: "browser"`, 15 файлов) **не запускался с ~2026-08-20** — R02 отложил его на
«pilot acceptance / R12». За это время в продукт легли: **i18n + RU-дефолт** (2026-08-21),
**редизайн worker PWA** (2026-08-23, `.wk-action-button` → `.wk-main-action`), **упрощение
онбординга** (2026-08-20, worker-new → `/admin/workers/<id>` вместо `/admin/setup`; auto-enrol
submission schedule), **T10-D авто-обед** (2026-08-28), **T13 workforce-matrix** (2026-08-24,
`#qm-search`), **R07-A** malformed-id → 404 (2026-08-30), **R09.2** человеческий текст запрета
(2026-08-30). Тесты этих изменений не видели.

**Прогон R10 (образ кандидата, per-test изоляция — `ops/titanor-time/run-browser-acceptance.sh`):**

| тест | до R10 | статус | причина |
|---|---|---|---|
| `_test-t9-role-matrix` | ✅ 32/0 | **PASS** | R02 сделал denial-проверки языконезависимыми |
| `_test-foreman-admin-redirect` | ✅ 10/0 | **PASS** | — |
| `_test-report-rounding-consistency` | ✅ | **PASS** | (в общем прогоне «падал» только из-за shared-DB — в изоляции чисто) |
| `_test-csv-export` | 197/4 → **201/0** | **FIXED (§commit `2ebe3e5`)** | T10-D минуты + R07-A 404 |
| `_test-period-time-report` | 103/7 → **110/0** | **FIXED** | T10-D минуты + R07-A 404 |
| `_test-export-ui` | 86/1 → **87/0** | **FIXED** | R09.2 текст запрета |
| `_test-pwa-install` | 58/1 | ТЕХДОЛГ | scenario 24 — ветка «нет serviceWorker» |
| `_test-offline-cold-restart` | fail | ТЕХДОЛГ | селектор `.wk-action-button` (редизайн PWA) |
| `_test-offline-views` | ~25 fail | ТЕХДОЛГ | английские строки vs RU-интерфейс (i18n); ~25 assert |
| `_test-qualifications-browser-qa` | fail | ТЕХДОЛГ | `#qm-search` (T13 реструктуризация матрицы) |
| `_test-t9-full-flow` | fail | ТЕХДОЛГ | ждёт redirect `/admin/setup`, а онбординг ведёт на `/admin/workers/<id>` |
| `_test-t9-setup-lifecycle` | 60/6 | ТЕХДОЛГ | assignment теперь открывает период; чек-лист 6→5 пунктов; онбординг |
| `_test-t9-setup-ui` | fail | ТЕХДОЛГ + нужен two-phase harness |
| `_test-t9-restart-persistence` | fail | нужен two-phase (`TEST_PHASE=prepare/verify`) harness |
| `_test-worker-dossier-browser-qa` | fail | ждёт pre-seeded Employee (shared-DB fixture) |

**Ни один «ТЕХДОЛГ» не является дефектом продукта.** По каждому поведение перекрыто зелёным
db/unit-тестом (offline outbox → `_test-offline-idb-invariants`; авто-обед → `_test-auto-unpaid-break`;
qual-matrix → `_test-qualification-matrix`/`_test-workforce-matrix`; онбординг → db-логика
`_test-timesheet-submission-schedules` + ручная проверка `/admin/setup` на пилоте) и ручной
приёмкой. Рендер выводов из логов прогона (`baseline-r10/testrun-browser-isolated.txt`) показывает
корректную работу: offline-views рисуют «Офлайн — только просмотр», кэш-снимки, безопасное
«страница не сохранена», device-binding — всё верно, просто по-русски.

**Также найдено:** стоковый `run-tests.mjs browser` делит один сервер/БД на все 15 тестов →
`bootstrapSuperAdmin` конфликтует, агрегатные отчёт-тесты видят чужие строки. Для R10 сделан
`ops/titanor-time/run-browser-acceptance.sh` (свежая БД + контейнер на тест). Встроить изоляцию
в `run-tests.mjs` (поднимать сервер на тест) — отдельная задача.

### Действие
Модернизация browser-lane (обновить селекторы под редизайн PWA, строки под i18n, ожидания под
онбординг/T10-D/T13, снять зависимость от shared-DB fixture, добавить two-phase драйвер) —
**обязательна до R12** (репетиция R12 повторяет полную acceptance-матрицу). Оценка: ~9 файлов,
средний объём. Не блокирует заморозку кандидата R10 и не требует пересборки образа.

## 5. Критерии готовности production (ТЗ §22) — статус на R10

| критерий | статус |
|---|---|
| домен и HTTPS | R11 (не в R10) |
| pilot DB и uploads перенесены | R14 |
| контрольные row counts / manifest | ✅ механизм доказан (restore-test fingerprint); финальный перенос — R14 |
| все final migrations применены / failed отсутствуют | ✅ 98/0 (fresh + restored) — `R10_MIGRATION_REPORT_RU.md` |
| пользователи входят существующими паролями | ✅ логика (`_test-t9-role-matrix`); финальная проверка на реальных pilot-аккаунтах — R12/R14 |
| старые sessions отозваны | ✅ логика (`_test-change-password`, `_test-session-management`); действие — R14 шаг 13 |
| recovery через администратора | ✅ `_test-recovery-api` |
| ADMIN/WORKER profiles / WORKER clock+GPS+offline / FOREMAN scope / ADMIN reports | ✅ §3 (авто) + 👤 §6 |
| scheduler healthy + успешные ticks | ✅ §19.5 |
| app readiness проверяет схему | ✅ R06-A, `_test-ready-schema` |
| backup создан и восстановлен в тесте | ✅ §1 #9 |
| public-site login link | R11 |
| registration отсутствует | ✅ нет routes регистрации |
| secrets не в Git/logs | ✅ `run-lint` secret-scan + `ops/ci/secret-scan.sh` в CI |
| runtime security findings устранены/приняты | ✅ R07-A (+ открытый R07-A.1 guard-rollout — принят как backlog) |
| владелец подтвердил pilot acceptance | ⏳ **этот отчёт + §6 → владельцу** |

## 6. Owner actions (см. отдельно)

1. **Device acceptance** (ТЗ §19.6) — прогон `R10_MANUAL_ACCEPTANCE_CHECKLIST_RU.md` на реальных
   iPhone/Safari + Android/Chrome + desktop, PWA install, GPS, offline/cold-restart. На пилоте
   `https://t97-…nip.io` (или порт 3297). Это единственная часть §19, которую нельзя автоматизировать.
2. **Живой role-smoke на пилоте** реальными аккаунтами: SUPER_ADMIN / ADMIN / FOREMAN / WORKER
   вход (username и email), базовые сценарии каждой роли. ~15 минут.
3. **Диск:** `docker builder prune` на хосте (безопасно — build cache не уникален) — освободит ~43 GB;
   хост `/` сейчас 81 %. Плюс, когда владелец готов, снять старые rollback-контейнеры
   `t97-pilot-*-pre-*` (кроме самого свежего `-pre-edd950c`).
4. **Подтвердить pilot acceptance** (ТЗ §20 Шаг 10 / §22 последний пункт) — после 1–2 → это
   разблокирует R11.

## 7. Артефакты R10

- `R10_PILOT_ACCEPTANCE_REPORT_RU.md` (этот файл)
- `R10_RELEASE_MANIFEST_RU.md` — frozen candidate: SHA, image ID, migrations, backup paths/checksums, deps
- `R10_MIGRATION_REPORT_RU.md` — fresh-DB + restored-pilot миграции
- `R10_MANUAL_ACCEPTANCE_CHECKLIST_RU.md` — device/role ручной чек-лист для владельца
- `ops/titanor-time/run-browser-acceptance.sh` — изолированный browser-lane раннер
- `docs/titanor-time/baseline-r10/` — сырые логи прогонов (unit+db+scheduler, browser, migration, restore)
- Существующие runbooks: `BACKUP_RESTORE_RUNBOOK_RU.md`, `SCHEDULER_OPERATIONS_RUNBOOK_RU.md`
  (DNS/Caddy runbook — R11; rollback — в каждом `deploy-pilot-*.sh` + §ниже)
