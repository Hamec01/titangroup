# R15-D7 Deploy D — rollback runbook (двухфазный rollout D1 → D2, v4)

**Ключевое правило:** после установки EXCLUDE-constraint
`ex_site_assignment_one_primary_per_period` (фаза D2) **запрещено** откатываться на Deploy A
(`d7a-37dddb1`). Его старый lifecycle-код несовместим с constraint операционно:

- `PATCH /api/admin/assignments/:id {isPrimary:true}` делает прямой `updateMany` без демоушена;
- `createAssignment` / старый `/change` / `/split` не демоутят прежний **пересекающийся** primary;
- любая из этих операций при существующем live-primary с пересекающимся периодом → `23P01` →
  **HTTP 500**.

`schema:ahead` на `/api/ready` у `d7a` доказывает только, что приложение **стартует** на схеме
99+1, но **не** что его операции безопасны. Поэтому:

| Момент | Rollback ведёт на |
|---|---|
| после D1 (constraint ещё нет) | **Deploy A** (`d7a-37dddb1`) — безопасно |
| после D2 (constraint установлен) | **сохранённый D1-контейнер** (`titanor-time-prod-app-pre-<d7d3-sha>`, образ `d7d1-b9cb5e7`) — **не** Deploy A |

Образы: **`d7d1-b9cb5e7`** (D1, схема 99, без constraint) · **`d7d3-5690632`** (D2/финал, inventory 100).

---

## Фаза D1 — только код (схема остаётся 99)

**Deploy:**
```
# 1. backup (read-only)
TT_ENV=production … bash ops/titanor-time/backup-titanor-time.sh pre-deploy   # verify on+off-box SHA256SUMS

# 2. web-only swap  d7a-37dddb1  ->  d7d1-b9cb5e7
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-pre-b9cb5e7
docker run -d --name titanor-time-prod-app --network titanor-time-prod-net --restart unless-stopped \
  -p 127.0.0.1:3199:3000 -v /home/deploy/app-data/titanor-time-prod/uploads:/app/uploads \
  --env-file /home/deploy/app-data/titanor-time-prod/app.env \
  --health-cmd 'node -e "fetch(\"http://127.0.0.1:3000/api/ready\").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"' \
  --health-interval 15s --health-timeout 5s --health-retries 4 --health-start-period 40s \
  titanor-time-app:d7d1-b9cb5e7

# 3. verify
curl -s http://127.0.0.1:3199/api/ready              # expect schema:current 99/99
curl -s --resolve app.titanorgroup.fi:443:127.0.0.1 https://app.titanorgroup.fi/api/ready
# read-only smoke: /admin/assignments (кнопка «Сделать основным»), карточка работника
```

**Rollback D1 (constraint НЕ установлен):**
```
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-d1-failed
docker rename titanor-time-prod-app-pre-b9cb5e7 titanor-time-prod-app
docker start titanor-time-prod-app
curl -s http://127.0.0.1:3199/api/ready              # d7a: schema:current 99/99
```
Схему трогать не нужно — Migration 2 ещё не применялась. Оба образа (`d7a`, `d7d1`) работают на
схеме 99.

---

## Фаза D2 — ограничение базы (fix данных + Migration 2)

Выполняется, когда D1 стабилен. **D1-контейнер продолжает обслуживать всю фазу.**
```
# 1. свежий verified backup on-box + off-box
TT_ENV=production … bash ops/titanor-time/backup-titanor-time.sh pre-migration
cd <backup-dir> && sha256sum --quiet -c SHA256SUMS
cd <off-box-mirror> && sha256sum --quiet -c SHA256SUMS

# 2. ручной fix двойных основных — ОДНА транзакция, явный ACTIVE SUPER_ADMIN actor
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -v actor=<ACTIVE-SUPER_ADMIN-uuid> \
     -f ops/titanor-time/r15-d7/fix-double-primary.sql
# ожидаемый вывод: BEGIN … UPDATE 1 … UPDATE 1 … INSERT 0 2 … INSERT 0 2 … 4-строчная таблица … COMMIT
# (actor по умолчанию НЕТ; отсутствие → "invalid input syntax for type uuid: MISSING";
#  не-SUPER_ADMIN → "... is not an ACTIVE SUPER_ADMIN — ABORT"; оба — до любого UPDATE)

# 3. Migration 2 — через throwaway-контейнер из d7d3-5690632 (в нём лежит миграция), на prod-сети
docker run --rm --network titanor-time-prod-net \
  --env-file /home/deploy/app-data/titanor-time-prod/app.env \
  -w /app --entrypoint node titanor-time-app:d7d3-5690632 \
  .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
docker exec titanor-time-prod-db psql -U titanor_time_prod -d titanor_time -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname='ex_site_assignment_one_primary_per_period'"   # -> 1

# 4. verify — D1-контейнер продолжает работать (теперь schema:ahead)
curl -s http://127.0.0.1:3199/api/ready              # d7d1: status ready, schema ahead, aheadBy 1
# read-only smoke операций: карточки Nazar + Mykhailo (по одному основному), «Сделать основным»

# 5. (опционально) финальный swap на образ с inventory schema 100
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-pre-5690632        # <-- ЭТО D1-контейнер
docker run -d --name titanor-time-prod-app … titanor-time-app:d7d3-5690632   # (те же флаги, что в D1)
curl -s http://127.0.0.1:3199/api/ready              # d7d3: schema:current 100/100
```

**Rollback после D2 (constraint УСТАНОВЛЕН):**
```
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-d2-failed
docker rename titanor-time-prod-app-pre-5690632 titanor-time-prod-app        # <-- D1-контейнер, образ d7d1-b9cb5e7
docker start titanor-time-prod-app
curl -s http://127.0.0.1:3199/api/ready              # d7d1: ready, schema ahead — операции constraint-совместимы
```
**НЕ откатывать на `d7a-37dddb1`.** **НЕ откатывать схему** (EXCLUDE-constraint additive, безвреден
для D1-кода, который сам держит инвариант; для полного отката схемы —
`ALTER TABLE "SiteAssignment" DROP CONSTRAINT "ex_site_assignment_one_primary_per_period"` или
restore `pre-migration` backup, только крайняя мера, теряет записи после бэкапа).

Данные `fix-double-primary.sql` (демоушен `3d95975f` + `cbf688b7`) откату не подлежат — это целевое
состояние, согласованное владельцем.

scheduler / Caddy / DNS / публичный сайт — не трогаются ни в одной фазе.

---

## Сохранять до конца R15

- контейнеры `titanor-time-prod-app-pre-b9cb5e7` (образ `d7a-37dddb1`) и
  `titanor-time-prod-app-pre-5690632` (образ `d7d1-b9cb5e7`);
- образы `d7a-37dddb1`, `d7d1-b9cb5e7`, `d7d3-5690632`;
- backup'ы `pre-deploy` (D1) и `pre-migration` (D2), on-box + off-box.
