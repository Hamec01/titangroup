# R15-D7 — Deploy D («Одно основное назначение»): отчёт перед production

**Статус:** подготовлено и проверено в disposable-среде. **Production не изменялся.** Ждёт
отдельного разрешения владельца (владелец: «после отчёта отдельно дам разрешение на Deploy D»).

Порядок обязателен: **сначала ручной fix данных, затем Миграция 2**. Порядок A→B→C→D соблюдён
(Deploy A уже на проде, B и C — нет; но Deploy D по решению владельца делается ДО новой карточки
работника, чтобы устранить конфликт основных назначений).

Ветка `feature/titanor-time-foundation`, коммит `bdf8608`. Кандидат-образ
`titanor-time-app:d7d-bdf8608` (схема ожидает **100**).

---

## 1. Решения владельца (2026-09-02)

| Работник | № | Основное (оставить) | Снять `isPrimary` (только флаг) |
|---|---|---|---|
| Nazar Druz | 1002 | `c6825d98-f7e2-47ae-bdd3-c721bf3ce242` — Meyer Turku — **Aros Marine** | `3d95975f-b4c4-491a-8e10-38f3e88edcd8` — Meyer Turku — (без заказчика) |
| Mykhailo Sadovnikov | 1004 | `bc174aef-2766-4877-ac43-415ef12433d5` — Meyer Turku — **Aros Marine** | `cbf688b7-fe67-46b2-aad3-967c37103c07` — Meyer Turku — (без заказчика) |

**У `3d95975f` и `cbf688b7`: только `isPrimary=false` (+ `version+1`).** Не удалять, не завершать,
не переносить часы, не менять историю.

---

## 2. Read-only preflight на production (2026-09-02 ~17:54 UTC)

Helsinki-дата `2026-09-02`. Точные текущие значения 4 назначений:

| id | работник | Объект — Заказчик | isPrimary | validFrom | validTo | clockInDisabledAt | version |
|---|---|---|---|---|---|---|---|
| `c6825d98` | Nazar Druz #1002 | Meyer — Aros Marine | **t** | 2026-09-02 | — | — | 1 |
| `3d95975f` | Nazar Druz #1002 | Meyer — (без заказчика) | t | 2026-08-26 | 2026-09-02 | — | 5 |
| `bc174aef` | Mykhailo Sadovnikov #1004 | Meyer — Aros Marine | **t** | 2026-09-02 | — | — | 1 |
| `cbf688b7` | Mykhailo Sadovnikov #1004 | Meyer — (без заказчика) | t | 2026-08-26 | — | — | 1 |

- employeeId Nazar = `1f8b5243-cec5-4c06-8ea3-a5e664865ad8`, Mykhailo = `8bb03525-8fe6-4b53-92e7-dc94c38f6a99`.
- **Индекс-предикат** (`isPrimary AND clockInDisabledAt IS NULL`), сгруппированный по работнику,
  >1 → **ровно эти двое** (`{3d95975f, c6825d98}` и `{cbf688b7, bc174aef}`). Все остальные 9
  работников — ровно 1 основное. Ruslan Druz #1003: 2 назначения, 1 основное — норма.
- **Часы, привязанные к снимаемым:**
  - `3d95975f`: 0 `WorkSegment` / 0 `ClockShift` / 0 `ClockShiftFragment` / 0 `TimesheetDraftSegment`;
    только авто-плановые `TimesheetPlannedShift`=5, `TimesheetDraftPlannedShift`=3 (не часы).
  - **`cbf688b7`: 10 `WorkSegment`, 5 `ClockShift`, 5 `ClockShiftFragment`, 9 `ClockEvent`,
    1 `TimesheetDraftSegment`** — реальные отработанные часы. Именно поэтому снимаем **только**
    `isPrimary`, часы остаются на нём; назначение остаётся открытым (`validTo` NULL).
- `AssignmentTransition` — 0 строк. Открытых смен у обоих работников — нет.
- Активные админы: `oleksandr` (SUPER_ADMIN, создал все 4 назначения), `pilot-owner` (SUPER_ADMIN),
  `yurii` (ADMIN). **Actor для `AssignmentTransition`/audit = `pilot-owner`
  (`cba8d0ff-0fd2-45bc-b83c-1d19ceee2bee`)** — можно переопределить `-v actor=...`.

---

## 3. Одна атомарная транзакция — `ops/titanor-time/r15-d7/fix-double-primary.sql`

`BEGIN` → 2 `pg_advisory_xact_lock` (тот же ключ, что у lifecycle-сервиса,
`titanor_time:assignment_lifecycle:<employeeId>`, порядок по employeeId asc) →
**preflight-guard** (abort, если не ровно 2 primary-снимаемых и не ровно 2 live-основных
оставляемых) → 2× `UPDATE … SET "isPrimary"=false, "version"="version"+1, "updatedAt"=now()`
(с `AND "isPrimary"=true` — идемпотентно) → **post-guard** (abort, если у кого-то осталось >1 в
индекс-предикате) → 2× `INSERT AssignmentTransition` (`kind=CHANGE`, from=снятое, to=оставленное,
`openShiftHandling=NONE`, `reasonCode=OTHER`, поясняющий `reasonText`) → 2× `INSERT AuditEvent`
(`ASSIGNMENT_PROMOTED`, `afterValue` с `demotedAssignmentIds`) → `SELECT` результата → `COMMIT`.

Immutability-триггеры `AssignmentTransition` / `AuditEvent` разрешают `INSERT` — конфликта нет.

---

## 4. Миграция 2 — `20260902180000_add_one_live_primary_index`

```sql
CREATE UNIQUE INDEX "ux_site_assignment_one_live_primary"
  ON "SiteAssignment" ("employeeId")
  WHERE "isPrimary" = true AND "clockInDisabledAt" IS NULL;
```
Partial: **снятое** (`isPrimary=false`), **завершённое/снятое с объекта**
(`clockInDisabledAt` задан — removeFromSite, немедленный changeWorkplace, backfill Миграции 1),
**прошлое** и **не-основное будущее** — вне предиката. Индекс запрещает только **второе
одновременное основное, на которое ещё можно сделать Check In**. Таблица ~14 строк — обычный
`CREATE INDEX`, миллисекунды.

---

## 5. Код (сверх 5 шагов владельца — нужен, иначе индекс ломает штатные операции)

Без этого индекс дал бы 500 на легитимных действиях (добавление второго основного, будущий
перевод основного). Design §8 Deploy D: «`/change` и `assignSite` больше не могут создать второе
live-primary».

- **`lib/assignment-lock.ts` (новый)** — общий per-employee advisory-lock + предикат индекса +
  `isLivePrimaryConflict()`. Standalone (без циклов импорта).
- **`createAssignmentInTx`** — если новая строка `isPrimary`, в той же транзакции демоутит все
  другие строки предиката для этого работника (`isPrimary=false`, `version+1`). Это и есть
  «сервис демоутит прежнее live-primary» (§3.6). Покрывает и `POST /api/admin/assignments`, и
  `/change`.
- **`createAssignment`** — берёт advisory-lock; на (теперь недостижимом) 23505 возвращает
  `LIVE_PRIMARY_CONFLICT` вместо 500.
- **`promoteToPrimary`** — демоут по предикату индекса (без фильтра по датам), ловит 23505.
- **`changeWorkplace`** + 3 роута (`/api/admin/assignments`, `/change`, `/promote`) —
  `LIVE_PRIMARY_CONFLICT` → чистый 409.

**Косметика будущего перевода основного:** при `changeWorkplace` с датой в будущем старое
назначение демоутится сразу (уходит из предиката) — сегодня у работника «нет звезды основного»
до наступления даты. Приемлемо; новая карточка (Deploy B) покажет «Запланированное изменение» явно.

---

## 6. Disposable-проверка на восстановленном production-backup

Backup `production-20260902T175548Z-manual` (схема 99, 2129 строк). Образ `d7d-bdf8608`.

### PHASE 1 — `migrate deploy` БЕЗ ручного fix → **ожидаемый провал**
```
Applying migration `20260902180000_add_one_live_primary_index`
Error: P3018 … Database error code: 23505
could not create unique index "ux_site_assignment_one_live_primary"
DETAIL: Key ("employeeId")=(1f8b5243-…) is duplicated.
```
Миграция помечается unfinished, индекс не создан. **Подтверждает: fix обязателен ПЕРЕД Миграцией 2.**

### PHASE 2 — fix-double-primary.sql, затем `migrate deploy` ×2 → **успех**
- fix: `BEGIN` → locks → guard → `UPDATE 1` `UPDATE 1` → guard → `INSERT 0 2` (transition) →
  `INSERT 0 2` (audit) → `COMMIT`, exit 0.
- После fix (реальные данные):

  | id | isPrimary | version |
  |---|---|---|
  | `c6825d98` | **t** | 1 (не тронут) |
  | `3d95975f` | **f** | 6 (было 5) |
  | `bc174aef` | **t** | 1 (не тронут) |
  | `cbf688b7` | **f** | 2 (было 1) |

  - `AssignmentTransition` = 2 · `AuditEvent ASSIGNMENT_PROMOTED` = 2
  - работников с >1 в индекс-предикате = **0**
  - **`cbf688b7`: `WorkSegment`=10, `ClockShift`=5 — не изменились**
  - `3d95975f`: `validTo`=2026-09-02, `endedReason`='1111' — **не изменились**
- `migrate deploy` pass 1 → применена; pass 2 → `No pending migrations` (no-op).
- Итог: **100 миграций, 0 bad**, индекс существует:
  `CREATE UNIQUE INDEX … ("employeeId") WHERE (("isPrimary" = true) AND ("clockInDisabledAt" IS NULL))`,
  0 нарушений предиката.

### Полный browser-lane (образ `d7d-bdf8608`, `run-browser-acceptance.sh` — шаблон со всеми 100 миграциями, индекс присутствует)
_(результаты — §7)_

---

## 7. Тесты
<!-- filled after the browser-lane run -->

---

## 8. План production Deploy D (после разрешения владельца)

1. `backup-titanor-time.sh pre-migration` (verified on+off-box).
2. **`psql … -f ops/titanor-time/r15-d7/fix-double-primary.sql`** прямо в prod DB (одна
   транзакция, guard'ы внутри; при drift — abort без изменений). Проверить вывод: 4 строки,
   isPrimary как в §6.
3. `docker exec`-throwaway из `d7d-<sha>` → **`prisma migrate deploy`** (применит Миграцию 2 —
   `CREATE INDEX`, миллисекунды; старый образ `d7a-37dddb1` продолжает обслуживать: `schema:ahead`).
4. Verify: 100 миграций 0 bad, индекс есть, 0 нарушений предиката, `/api/ready` старого образа 200.
5. Web-only swap `d7a-37dddb1` → `d7d-<sha>` (~10–15 c 503, как Deploy A). scheduler не трогать.
6. Verify `/api/ready` 200 `schema:current 100/100` локально и через Caddy; карточки Nazar и
   Mykhailo (read-only) — по одному основному.
7. Rollback: откат образа на `titanor-time-prod-app-pre-<sha>` (`d7a-37dddb1`). Схему **не**
   откатывать — `d7a` работает при `schema:ahead`; индекс сам по себе безвреден для старого кода.
   Данные fix'а (демоут) откату не подлежат и не требуют — это и есть целевое состояние.

Caddy/DNS/scheduler/публичный сайт — без изменений. Пароли/аккаунты — без изменений.
