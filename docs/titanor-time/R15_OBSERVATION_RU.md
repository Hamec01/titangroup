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
| **дождаться и проверить автоматический backup** | ⚠️→✅ (частично): систем-таймеры были только `@pilot`. Env для `@production` — `ops/titanor-time/systemd/{backup,gps-archive}-production.env.example` (`0032c22`). Ручной прогон как `deploy`: `production-20260901T065748Z-scheduled` (503 744 б, 1789 rows, 98 миграций, on+off-box `SHA256SUMS` OK). **Таймер `@production` ещё не enabled — нужен sudo владельца (§ ниже).** |
| restore-проверка из production backup | ✅ `restore-test` этого бэкапа: **14/14** (74 таблицы, fingerprint, uploads 3, `/api/ready` 200) |
| GPS archive / retention на проде | ✅ ручной прогон `gps-archive` exit 0 (`sealableDays:0` — раньше 90 дней нечего запечатывать); таймер `@production` — sudo владельца |
| место на storage | ✅ диск / 85%; build cache 71 GB (prune отложен до sign-off) |

## Фаза 3 — 72 ч + период стабильности (не начата)

- [ ] финализировать `R14_CUTOVER_REPORT_RU.md`
- [ ] закрыть / вынести дефекты, найденные за наблюдение
- [ ] обновить runbooks / `IMPLEMENTATION_STATUS` / `NEXT_AGENT_HANDOFF_RU`
- [ ] **owner sign-off** — закрытие релиза
- [ ] решить срок хранения старого production backup
- [ ] удаление старых данных — **отдельная задача, отдельное разрешение**

## После sign-off (не раньше)

- снос пилота и старого prod: контейнеры + БД + volume'ы + ~19 GB старых образов
  `t97-pilot-*`; `docker builder prune` (~50 GB); затем `docker volume prune`
- отключить `titanor-time-backup@pilot.timer` и `titanor-time-gps-archive@pilot.timer`

---

## Действие владельца сейчас — включить `@production` таймеры (sudo)

`REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation`

```bash
# 1. установить env-файлы (root:root, 0600)
sudo install -m 0600 -o root -g root \
  "$REPO/ops/titanor-time/systemd/backup-production.env.example" \
  /etc/titanor-time/backup-production.env
sudo install -m 0600 -o root -g root \
  "$REPO/ops/titanor-time/systemd/gps-archive-production.env.example" \
  /etc/titanor-time/gps-archive-production.env

# 2. включить таймеры (шаблоны titanor-time-{backup,gps-archive}@.timer уже в системе)
sudo systemctl enable --now titanor-time-backup@production.timer
sudo systemctl enable --now titanor-time-gps-archive@production.timer

# 3. проверить
systemctl list-timers 'titanor-time-*@production*'
#   backup:      *-*-* 04:10:00 UTC
#   gps-archive: *-*-* 05:10:00 UTC

# 4. (опционально, чтобы не было ложных FAILED-алертов от замороженного пилота)
sudo systemctl disable --now titanor-time-backup@pilot.timer titanor-time-gps-archive@pilot.timer
```

Ручной прогон уже доказал весь путь (dump + off-box mirror + checksums + restore-test 14/14),
так что после `enable --now` первый автоматический прогон в 04:10 UTC должен просто повториться.
