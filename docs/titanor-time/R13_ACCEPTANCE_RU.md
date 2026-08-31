# R13 — контрольная точка владельца: PILOT ACCEPTANCE ЗАКРЫТА

- **Дата:** 2026-08-31.
- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R13; ТЗ §20/§22.
- **Итог:** **Pilot / device acceptance ПОДТВЕРЖДЕНА владельцем. Открытых P0/P1 — 0.**
- **R14 / production cutover / maintenance window — НЕ начаты и НЕ подтверждены** (см. §6).

---

## 1. Подтверждение владельца (2026-08-31)

Владелец подтвердил приёмку пилота:

- iPhone: установка PWA, запуск с иконки, Check In / Check Out, GPS, работа приложения —
  **проверено, всё нормально**;
- ручная проверка на реальном устройстве и основных ролях — расхождений нет;
- **открытых дефектов P0/P1 — нет.**

Автоматизированная device/role acceptance (сессия Codex) — завершена и оформлена:
`R13_AUTOMATED_ACCEPTANCE_RU.md` (16/16 browser files, live role/mobile smoke на пилоте,
повтор R12 restore 14/14 + rehearsal 10/10 + rollback PASS).

**Вывод roadmap R13, подтверждение №1 (Pilot acceptance): ЗАКРЫТО.**

## 2. Что входило в приёмку

| часть | кем | результат |
|---|---|---|
| iPhone PWA: иконка, Check In/Out, GPS, общая работа | владелец, реальное устройство | ✅ норм |
| Живой role-smoke SUPER_ADMIN/ADMIN/WORKER/FOREMAN на пилоте | Codex, реальные `r13-*` | ✅ 4/4 login, landing по ролям, human-отказ без 500 |
| Admin-login landing: ADMIN/SUPER_ADMIN → `/admin` (Today), не `/admin/setup` | hotfix `1416503` + browser-регрессия | ✅ исправлено, `_test-t9-role-matrix.ts` |
| Mobile: phone 390×844 + tablet 800×1280, отсутствие page-level h-scroll | Codex | ✅ |
| PWA manifest / lifecycle / offline cold-restart / locale RU-EN | Codex | ✅ 59/59 + 6/6 + 12/12 |
| Полный attendance → timesheet → approval с GPS | Codex | ✅ 84/84 |
| Повтор R12 (restore-smoke / live rehearsal / rollback) на образе релиза | Codex | ✅ 14/14 + 10/10 + rollback |
| Инфраструктура: `/api/health` + `/api/ready` 98/98, scheduler ticks, restart | Codex + этот отчёт | ✅ |

**P0/P1: 0.** P2/backlog (не блокируют релиз): FOREMAN UX целиком вне scope R09;
`/fi` `<html lang>` на публичном сайте (`LANGUAGE_MODEL_RU.md` §2.1); mailto-handler на
Windows/Chrome у владельца.

## 3. Релизный образ — заморожен под неизменяемым тегом

Продукт-код правился в hotfix `1416503` → образ пересобран **один раз** Codex'ом
(`titanor-time-app:r13-hotfix-1416503`). Дальше — **без пересборки**:

| | |
|---|---|
| product commit | `1416503` `fix(time): land admins on operational overview after login` |
| git HEAD ветки | `c758caa` (выше `1416503` — только docs) |
| исходный тег | `titanor-time-app:r13-hotfix-1416503` |
| **неизменяемый релизный тег** | **`titanor-time-app:r14-release-1416503`** |
| **image ID (manifest digest)** | **`sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb`** |
| revision label | `1416503` · ref `feature/titanor-time-foundation` · created `2026-08-31T15:36:05+02:00` · 792 MB |
| off-disk копия | `/home/deploy/backups/titanor-time-prod-release/titanor-time-app-r14-release-1416503.tar.gz` (184 MB, `sha256 38d3214cda…`) — `docker load` round-trip → тот же digest |

**Доказательство неизменности:** `docker tag` + `docker save`/`load` не меняют образ.
`docker image inspect` до и после присвоения тега — `sha256:864267bb…` идентичен; оба тега
(`r13-hotfix-1416503` и `r14-release-1416503`) указывают на один ID; демон использует
containerd image store, поэтому `.Id` == manifest digest == `RepoDigests`.

```
$ docker image inspect titanor-time-app:r14-release-1416503 --format '{{.Id}}'
sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb
$ docker image inspect titanor-time-app:r13-hotfix-1416503  --format '{{.Id}}'
sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb
```

## 4. Одноразовые R13-аккаунты — обезврежены (2026-08-31)

Перед очисткой снят backup пилота `pilot-20260831T144658Z-manual` (read-only pg_dump,
1807 rows, 98 миграций, SHA256SUMS OK).

Read-only инвентаризация показала, что `r13-*` аккаунты касаются **только**: 14 `UserSession`,
4 `UserRole`, 1 `ForemanAssignment` (r13-foreman → Meyer Turku Shipyard), employee `R13-20a872`
с 1 `Employment` + 1 `SiteAssignment` + 4 `WorkerDeviceInstallation`, и **14 immutable
`AuditEvent` `LOGIN_SUCCEEDED`**. Ни clock-shift, ни timesheet, ни токенов, ни данных других
пользователей.

**Почему deactivate, а не hard-delete:** `AuditEvent.actorUserId` — `ON DELETE RESTRICT`, а
строки `AuditEvent` неизменяемы (триггер `trg_audit_event_immutable`: BEFORE DELETE OR UPDATE).
14 login-событий пилота держат `User`-строки. Удалить их можно было бы только отключив
audit-immutability триггер — это нарушение целостности аудита, делать нельзя. Поэтому
безопасный путь: **DEACTIVATED + снятие всех «test links»**, аудит-след пилота остаётся целым.

**Одна транзакция** (`BEGIN … COMMIT`, с guard-проверкой ровно 4 ожидаемых username и 1 employee,
и проверкой, что admin-покрытие не рушится):

| шаг | строк |
|---|---|
| `DELETE FROM "UserSession"` (r13) | 14 |
| `DELETE FROM "UserRole"` (r13) | 4 |
| `DELETE FROM "ForemanAssignment"` (foremanUserId r13) | 1 |
| `DELETE FROM "WorkerDeviceInstallation"` (employee R13-) | 4 |
| `DELETE FROM "SiteAssignment"` (employee R13-) | 1 |
| `DELETE FROM "Employment"` (employee R13-) | 1 |
| `UPDATE "User" SET status='DEACTIVATED', "passwordHash"=NULL, "employeeId"=NULL` (r13) | 4 |
| `DELETE FROM "Employee"` (`R13-%`) | 1 |

**Пост-состояние (проверено независимым запросом):**

- 4 `r13-*` → `DEACTIVATED`, `passwordHash` NULL, `employeeId` NULL — войти нельзя;
- 0 сессий, 0 ролей, 0 foreman-assignment, 0 employee `R13-%`, 0 orphan Employment/SiteAssignment/WDI;
- 14 `AuditEvent LOGIN_SUCCEEDED` — сохранены (immutable), теперь указывают на обезвреженные аккаунты;
- admin-покрытие цело: 2 SUPER_ADMIN + 1 ADMIN (не считая обезвреженных);
- пилот после очистки: `/api/ready` 200, `schema:current` 98/98, app/scheduler healthy.

Другие пользователи и реальные pilot-данные не тронуты. Пароли нигде не печатались.

## 5. Evidence package R13 — финальный

| пункт | значение |
|---|---|
| Git SHA / release | product `1416503`; ветка HEAD `c758caa` (docs); запушено в `origin/feature/titanor-time-foundation` |
| image tag / ID | `titanor-time-app:r14-release-1416503` · `sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb` (=`r13-hotfix-1416503`) |
| migration count / status | 98 applied, 0 unfinished/rolled-back; schema current (fresh + restored pilot) |
| baseline / final row-count manifests | `docs/titanor-time/baseline-r12/pilot-snapshot-manifest.txt`; финальный pilot manifest — на R14 шаг 7 |
| backup paths / sizes / checksums | пред-очистка `pilot-20260831T144658Z-manual` (dump 498 753 б, 1807 rows, SHA256SUMS OK); релизный образ — tar.gz + sha256 (§3); финальные prod+pilot backup — на R14 шаги 5 и 7 |
| restore / rehearsal evidence | `R13_AUTOMATED_ACCEPTANCE_RU.md` §6: restore-smoke 14/14 + live rehearsal 10/10 + rollback PASS на `r13-hotfix-1416503` |
| test / acceptance / dependency reports | `R13_AUTOMATED_ACCEPTANCE_RU.md` (16/16 browser files), этот отчёт §2, `R10_PILOT_ACCEPTANCE_REPORT_RU.md` (80/80 unit+db+sched, 0 CVE), `R12_REHEARSAL_RU.md` |
| языковая модель | `LANGUAGE_MODEL_RU.md` — приложение RU+EN (соответствует), сайт FI+EN без RU (соответствует, кроме `/fi` `<html lang>`) |
| точное maintenance window | **НЕ подтверждено владельцем** (roadmap R13 п.2) |
| ожидаемый downtime | ~1–2 мин реального простоя, окно 10 мин (`R14_CUTOVER_RUNBOOK_RU.md` §4) |
| DNS status | `app.titanorgroup.fi` → `84.247.130.242` (DNS only), TLS Let's Encrypt до 2026-11-29, 503 holding |
| пошаговый cutover / rollback | **`R14_CUTOVER_RUNBOOK_RU.md`** (заменяет `R12_REHEARSAL_RU.md` §4) |
| остаточные риски | old prod БД «неважна», но backup обязателен (R14 шаг 5); FOREMAN UI backlog; `/fi` `<html lang>`; orange-cloud (Вариант B) отложен до после R15 |
| что увидит пользователь после первого входа | существующий пароль работает; старые сессии отозваны → повторный вход; RU/EN по `User.locale`; экран учёта / `/admin` (Today) по роли |

## 6. Три подтверждения владельца (roadmap R13) — статус

| # | подтверждение | статус |
|---|---|---|
| 1 | **Pilot acceptance** | ✅ **ПОЛУЧЕНО 2026-08-31** (§1, 0 P0/P1) |
| 2 | **Maintenance window** — конкретные дата/время (10 мин) | ⏳ **не получено** |
| 3 | **Production cutover** — явное разрешение начать R14 | ⏳ **не получено** |

Молчание или общее «продолжай» подтверждением №2 и №3 **не считается**
(разрушительная замена production-БД).
