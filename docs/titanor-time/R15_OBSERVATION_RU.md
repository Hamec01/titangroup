# R15 — наблюдение и закрытие релиза

- **Основание:** `PRODUCTION_RELEASE_ROADMAP_RU.md` R15.
- **Cutover:** 2026-08-31 ~15:48 UTC (18:48 EEST) — `R14_CUTOVER_REPORT_RU.md`.
- **72 ч истекают:** 2026-09-03 ~15:48 UTC. Плюс согласованный с владельцем период стабильности.
- **Статус:** идёт. Прод здоров, инцидентов нет. Sign-off НЕ получен.

---

## Фаза 1 — первые 2 часа ✅

| пункт | статус |
|---|---|
| app errors / readiness / scheduler heartbeat / login / disk | ✅ чисто; restarts 0; scheduler `lastOutcome:ok`, overlap null |
| первые реальные role flows | ✅ owner smoke на cutover |
| не смешивать release incidents с feature requests | — (после R14 были отдельные UI-деплои: `customer-scope-c6f9cb4`, `customer-worker-scope-e9e7c62` — не инциденты) |

## Фаза 2 — первые 24 часа (идёт)

| пункт | статус |
|---|---|
| clock / GPS / offline sync / обработка табеля на проде | ⏳ нужна проверка реальным worker |
| uploads / отчёты (экран + PDF + CSV) / audit events | ⏳ |
| **дождаться и проверить автоматический backup** | ✅ Env-файлы установлены в `/etc/titanor-time/` (root:root 0600), таймер **`titanor-time-backup@production.timer` enabled+active** 2026-09-01 09:02 (04:10 UTC ежедневно); `@pilot` таймеры disabled. Ручной прогон как `deploy`: `production-20260901T065748Z-scheduled` (503 744 б, 1789 rows, 98 миграций, on+off-box `SHA256SUMS` OK). Первый автоматический — 2026-09-02 04:10 UTC, проверить. |
| restore-проверка из production backup | ✅ `restore-test` этого бэкапа: **14/14** (74 таблицы, fingerprint, uploads 3, `/api/ready` 200) |
| GPS archive / retention на проде | ✅ `titanor-time-gps-archive@production.timer` enabled+active (05:10 UTC); ручной прогон `gps-archive` exit 0 (`sealableDays:0` — раньше 90 дней нечего запечатывать) |
| место на storage | ✅ диск / 85%; build cache 71 GB (prune отложен до sign-off) |

## Фаза 3 — 72 ч + период стабильности (не начата)

- [ ] финализировать `R14_CUTOVER_REPORT_RU.md`
- [ ] закрыть / вынести дефекты, найденные за наблюдение
- [ ] обновить runbooks / `IMPLEMENTATION_STATUS` / `NEXT_AGENT_HANDOFF_RU`
- [ ] **owner sign-off** — закрытие релиза
- [ ] решить срок хранения старого production backup
- [ ] удаление старых данных — **отдельная задача, отдельное разрешение**

## Уборка

- **2026-09-01 — сделано (владелец разрешил):** удалены 22 контейнера `t97-pilot-{app,scheduler}-pre-*`
  + 11 старых образов `t97-pilot-*` (кроме `edd950c`). Освобождено ~9 GB, диск / 86%→79%.
  Оставлены: образ `t97-pilot-edd950c` (rollback-ref), `t97-pilot-db` (справка «что перенесли», ещё
  пару дней), `t97-pilot-{app,scheduler}` (остановлены). `@pilot` таймеры отключены.
- **После sign-off:** остановить/удалить `t97-pilot-db` + том `t97-pilot-db-data`; `docker builder
  prune` (~50 GB build cache); `docker volume prune`. Старый prod (`titanor-time-*-1`) — зона
  ответственности начальника, не трогаем.

---

## Артефакты для владельца

- **Скриншоты всех экранов** (57 PNG, `pilot-owner` SUPER_ADMIN): `/home/deploy/screenshots/titanor-time-prod-2026-09-01/` + `_index.md`.
  WORKER-экраны не сняты (нужен вход рабочего аккаунта).
- **Иллюстрированное руководство** (10 разделов, 32 экрана): артефакт
  `https://claude.ai/code/artifact/019e3f38-fd3b-421a-b0f8-01496758b8c1` ·
  автономная копия `/home/deploy/screenshots/titanor-time-guide.html` ·
  исходник + build-скрипт рядом. Дополняет встроенную `/guide`.

## Лог R15

| дата (UTC) | событие |
|---|---|
| 2026-08-31 15:48 | cutover, prod live |
| 2026-08-31 20:49 / 21:52 | post-R14 UI-деплои (`customer-scope-c6f9cb4`, `customer-worker-scope-e9e7c62`) — `*-pre-deploy` backup каждый |
| 2026-09-01 06:57 | первый ручной `production-...-scheduled` backup + off-box + restore-test 14/14 + gps-archive exit 0 |
| 2026-09-01 09:02 | `@production` backup+gps таймеры enabled (04:10 / 05:10 UTC daily); `@pilot` disabled; env в `/etc/titanor-time/` |
| 2026-09-01 09:15 | пилотная deploy-history подчищена (~9 GB, диск 86→79%) |
| 2026-09-01 ~09:14 (EEST) | скриншоты всех экранов сняты |
| 2026-09-02 ~09:40 (EEST) | иллюстрированное руководство собрано |
| 2026-09-02 04:10 | ⏳ первый автоматический production backup — проверить |
| 2026-09-03 15:48 | ⏳ 72 ч; собрать report → owner sign-off |
