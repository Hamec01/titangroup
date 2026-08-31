# R12 — production-like rehearsal и release evidence

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R12; ТЗ §19–§22.
- **Дата:** 2026-08-31.
- **Кандидат:** `titanor-time-app:r12-candidate-367420e`
  (digest `sha256:b5f80cbd1cff8c307581d283d54b7668987157d696943d48a3a51ff80915d883`, revision `367420e`).
- **Правило:** всё в полностью disposable-окружении. **Pilot, production, Caddy, DNS, публичный
  сайт — не тронуты.** Пилот прочитан только через backup (read-only `pg_dump`). Cutover не начат.
- **Вердикт (автоматизируемая часть):** **PASS — 10/0 в rehearsal + 14/0 в restore-smoke + 16/16 browser-lane**. Ручные/девайс-части ТЗ §19.6 + живой
  role-smoke реальными pilot-аккаунтами — owner action (§6), как и на R10.

---

## 1. Финальный snapshot пилота (read-only)

`ops/titanor-time/backup-titanor-time.sh manual` → `pilot-20260831T121948Z-manual/`
(сам dump — в scratchpad, вне git; manifest + structure — `docs/titanor-time/baseline-r12/`).
Read-only `pg_dump` через `docker exec` — пилот не изменён.

| | |
|---|---|
| db.dump | 492 469 байт, custom format, `pg_restore --list` парсится (726 TOC entries) |
| миграции | 98 applied, 0 unfinished, 0 rolled-back; `migration_history_sha256 b6073f8…` |
| структура | 74 таблицы · 222 routine · 40 триггеров · 178 FK |
| строки | `public_row_total = 1727` |
| uploads | `uploads.tar.gz` — 3 файла, 1023 байта |
| GPS-архив | `gps-archive-manifest.json` — 6 sealed reading-days verified; `sha256 2f56aa7…` (без координат) |
| all-data fingerprint | `all_data_sha256 907d3219…` |
| SHA256SUMS | все файлы, verify OK |

Пилот после снапшота: `/api/ready` `schema:current`, 98/98; 10 пользователей — без изменений.

## 2. Restore в disposable prod-like окружение + boot кандидата

`TT_SMOKE=1 restore-test-titanor-time.sh` — **14/0 PASS**
(`baseline-r12-prep/…` / scratchpad `r12/restore-smoke.log`):

- `pg_restore --no-owner --no-acl` в БД, владелец `tt_restore_owner` (**НЕ** исходный `t97_app`) — owner-independence доказана;
- миграции **98 == backup**, 0 unfinished, migration-history hash совпал;
- структура 74/222/40/178 == backup;
- **per-table row counts идентичны для всех 74 таблиц**;
- **all-data fingerprint совпал точно**;
- uploads: 3 файла == manifest;
- образ `r12-candidate-367420e` поднят против restored БД → **`/api/ready` = 200**.

## 3. Live-stack rehearsal (`ops/titanor-time/r12-rehearsal.sh`)

Владелец репетиции: db `titanor_time`, owner `titanor_time_prod` (имя будущего prod-владельца,
не пилотный `t97_app`). Evidence: `docs/titanor-time/baseline-r12/`.

| шаг | результат |
|---|---|
| restore snapshot `--no-owner --no-acl` (owner `titanor_time_prod`, ≠ `t97_app`) | ✅ PASS (owner `titanor_time_prod`) |
| очистить carried-over `SchedulerLease` (находка — см. runbook §4 шаг 11) | ✅ PASS (1 row → 0) |
| `prisma migrate status` против restored БД | ✅ up to date, no pending |
| web (release image) → `/api/ready` `schema:current`, 98/98 | ✅ `schema:current`, 98/98, aheadBy 0 |
| scheduler (release image) → ≥2 healthy тика, healthcheck exit 0, нет `OVERLAPPING` | ✅ healthcheck exit 0, `lastTickCompletedAt` реальный, нет OVERLAPPING |
| session/token revocation: wipe `UserSession` → stale cookie 401, `/login` 200 | ✅ 47 sessions → 0, stale cookie 401, `/login` 200 |
| re-backup из rehearsal-окружения + полный `restore-test` этого бэкапа | ✅ backup + full restore-test PASS |
| rollback drill (см. §5) | ✅ previous image boots, `schema:current` |

**Первый прогон нашёл шаг очистки `SchedulerLease`** (иначе scheduler `OVERLAPPING` ~90 мин) —
добавлен в скрипт и runbook; повторный прогон — чистый.

### Тайминги (`timings.txt`)

```
restore_db            11.7 s   (restore 500 KB dump; prod-БД пропорционально дольше)
web_ready              3.9 s   (release image -> /api/ready schema:current)
sched_2ticks         207.9 s   (первый tick ~3 мин — это интервал планировщика, не простой: web уже обслуживает)
rehearsal_backup+test 16.0 s   (backup из rehearsal + полный restore-test)
rb_stop_new            0.5 s
rb_restore_prev_dump  13.5 s
rb_boot_prev_image     3.2 s
```

## 4. Точный cutover runbook (R14) — на основе репетиции

Топология (зафиксирована в `R11_DOMAIN_CADDY_PLAN_RU.md` §6): новый стек **отдельно** от
`t97-pilot-*` и старого `titanor-time-*`. Имена `titanor-time-prod-{app,scheduler,db}`, сеть
`titanor-time-prod-net`, порт web `127.0.0.1:3199`, env
`/home/deploy/app-data/titanor-time-prod/app.env` (13 ключей по образцу pilot `app.env`;
`TITANOR_TRUSTED_PROXY_HOPS` — только при Варианте B, сейчас Вариант A → не задавать), образ
`titanor-time-app:r12-candidate-367420e`.

1. Объявить начало maintenance.
2. Caddy `app.titanorgroup.fi`: holding-503 остаётся (пользователи ничего нового не пишут).
3. Остановить старый production scheduler (`titanor-time-scheduler-1`) — `docker stop`.
4. Остановить/read-only старый production web (`titanor-time-app-1`) — `docker stop`.
5. **Финальный backup старой prod-БД + uploads** (`backup-titanor-time.sh` с
   `TT_DB_CONTAINER=titanor-time-db-1 TT_DB_USER=titanor_time_app TT_DB_NAME=titanor_time` — reason `pre-migration`). Проверить SHA256SUMS.
6. Короткий write-freeze пилота (остановить `t97-pilot-scheduler` + `t97-pilot-app`).
7. Финальный pilot dump + uploads archive + GPS manifest (`backup-titanor-time.sh manual`).
   Проверить SHA-256, sizes, migrations (98), row counts.
8. `createdb titanor_time` (owner `titanor_time_prod`), `pg_restore --no-owner --no-acl`.
9. Восстановить pilot uploads в `/home/deploy/app-data/titanor-time-prod/uploads`, сверить manifest.
10. Настроить `/home/deploy/app-data/titanor-time-prod/app.env` (crypto-ключи — те же, что у пилота;
    `DATABASE_URL` на новый prod-DB). Секреты в отчёты не копировать.
11. **Отозвать все старые sessions/tokens + очистить scheduler lease** (в restored БД):
    ```sql
    DELETE FROM "UserSession";
    DELETE FROM "SchedulerLease";   -- см. находку ниже
    ```
    (при желании — просроченные recovery/activation tokens). Проверено в §3.
    - **Находка репетиции:** snapshot несёт живой `SchedulerLease` (TTL 90 мин, без колонки
      `expiresAt` — истечение = `renewedAt + TTL`). Без очистки новый scheduler сидит
      `OVERLAPPING` до ~90 мин и не делает тиков. `DELETE FROM "SchedulerLease"` безопасен —
      новый scheduler берёт свежий lease сразу.
12. `prisma migrate deploy` (ожидается: миграций нет, схема current).
13. `docker run` web из `r12-candidate-367420e` (порт 3199) → `/api/ready` `schema:current` 98/98.
14. `docker run` scheduler из того же образа → дождаться ≥2 успешных тиков, healthcheck OK.
15. Сверить row counts + migration status с финальным manifest.
16. Smoke: SUPER_ADMIN / ADMIN / WORKER / FOREMAN вход (реальные аккаунты — owner), clock/GPS/
    offline, reports/PDF/CSV, uploads.
17. Caddy: `app.titanorgroup.fi` — заменить `handle`/`handle_errors`/`root` на
    `reverse_proxy 127.0.0.1:3199` (`ops/titanor-time/r11/…` подготовлено), `caddy validate` +
    reload.
18. Опубликовать Employee-login ссылку на `titanorgroup.fi` (код готовится в R11 §5).
19. Завершить maintenance, зафиксировать время открытия.

Старая production-БД после cutover **не удаляется**.

## 5. Downtime plan + rollback evidence

**Ожидаемый downtime** (из таймингов §3, disposable-хост; на prod-хосте ± тот же порядок):
**~1–2 минуты реального простоя приложения** + ~2–3 минуты на финальный backup старой prod-БД
(шаг 5, приложение уже в maintenance). Механика swap: dump (~сек для 500 KB; для реальной prod-БД
масштабируется) → restore ~12 с → migrate ~5 с (pending нет) → web ready ~4 с → сверка. Scheduler
берёт lease сразу; первый auto-submit tick ~3 мин — на доступность входа/клока не влияет.
**Планируемое maintenance-окно: 10 минут** (с запасом на сверку и решение).

Окно = шаги 6–15 runbook: write-freeze пилота → финальный dump → restore → migrate → boot web +
scheduler → сверка. Остальные шаги (Caddy switch, ссылка) — уже с работающим приложением.

**Rollback (немедленный, если restore/checksum/counts не сошлись, readiness не проходит,
scheduler без тиков, ключевые роли не входят, clock/uploads системно сломаны, потеря данных,
TLS ведёт не туда):**

1. `docker stop titanor-time-prod-scheduler titanor-time-prod-app` — `docker stop` ~0.5 s.
2. Восстановить старую prod-БД из backup шага 5 в исходный контейнер/новый — `pg_restore --no-owner --no-acl` ~13 s (500 KB dump; prod-БД пропорционально больше).
3. `docker start` старого web + scheduler (образ `t97-pilot-edd950c` / прежний prod) —
   `/api/ready` `schema:current` — boot предыдущего образа + `/api/ready` ~3 s.
4. Caddy `app.titanorgroup.fi` вернуть на holding-503 (или не переключать вовсе, если cutover
   прервался до шага 17).

Репетиция rollback (§3, шаг 8): stop нового стека → restore «предыдущего» dump во 2-ю БД → boot
предыдущего образа против неё → `/api/ready` `schema:current` — **✅ previous image boots, `schema:current`**, суммарно
~17 s механики (stop 0.5 + restore 13.5 + boot 3.2).

## 6. Owner actions до R13/R14

1. **Живой role-smoke на пилоте** реальными аккаунтами: SUPER_ADMIN / ADMIN / WORKER / FOREMAN,
   вход username и email, базовые сценарии (~15 мин) — как на R10 §6.
2. **Device acceptance** (ТЗ §19.6): iPhone/Safari + Android/Chrome + desktop, PWA install, GPS,
   offline/cold-restart — единственная часть, которую нельзя автоматизировать.
3. **Gates перед R14** (handoff §2): FI-строка Employee login, правила `ufw`, порт 3199.
4. **`docker builder prune`** — хост `/` 83 %, cutover-restore нужен запас; можно после того,
   как владелец готов (backup cache не уникален).
5. Подтвердить pilot acceptance + R13 evidence package + maintenance window + cutover (ТЗ §22,
   roadmap R13).

## 7. Release manifest (R12)

| | |
|---|---|
| git branch / HEAD | `feature/titanor-time-foundation` / `367420e` (product = `ef5548b`); отчётные docs-коммиты сверху |
| product commit | `ef5548b` (offline-shell locale fix) поверх browser-lane модернизации |
| candidate image | `titanor-time-app:r12-candidate-367420e` |
| image digest | `sha256:b5f80cbd1cff8c307581d283d54b7668987157d696943d48a3a51ff80915d883` |
| revision label | `367420e` · created `2026-08-31T11:45:24Z` · 792 MB |
| миграции | 98, схема current (fresh + restored pilot) |
| snapshot пилота | `pilot-20260831T121948Z-manual` — 1727 rows, fingerprint `907d3219…` |
| browser-lane | 16/16 зелёные (`R12_PREP_BROWSER_LANE_RU.md`) |
| deps | `npm audit --omit=dev` 0 (R05) — не менялось |
| артефакты R12 | этот файл; `ops/titanor-time/r12-rehearsal.sh`; логи `docs/titanor-time/baseline-r12/` |
| находка рехёрсала | cutover-runbook шаг 11 расширен: `DELETE FROM "SchedulerLease"` после restore |

## 8. PASS-критерии R12 (roadmap)

- [x] финальный snapshot: dump + uploads + GPS manifest + checksums;
- [x] restore в disposable prod-like, `--no-owner --no-acl`, non-source owner;
- [x] только ожидаемые pending migrations (их нет — схема current);
- [x] exact release image web + scheduler;
- [x] schema-aware readiness;
- [x] session/token revocation проверена;
- [~] полная acceptance matrix — авто-часть (browser-lane 16/16 + restore/reconcile); ручной
  role-smoke + device matrix → owner (§6);
- [x] ещё один backup/restore уже из rehearsal environment;
- [x] rollback отработан, тайминги измерены;
- [x] disposable resources удалены, evidence сохранён.

**PASS автоматизируемой части. Ручные acceptance-части — owner action, как на R10.**
