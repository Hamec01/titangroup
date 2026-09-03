# R15-D7 — Deploy D («Одно основное назначение»): отчёт (v4 — исправленная модель primary)

**Статус:** ✅ **D1 + D2 РАЗВЁРНУТЫ НА PRODUCTION** (D1 2026-09-02 22:14 UTC, простой ≈ 3.9 c;
D2 2026-09-03 03:44–03:52 UTC, `fix-double-primary.sql` + Migration 2 + swap, простой ≈ 3.6 c).
Схема production — **100/100**, constraint `ex_site_assignment_one_primary_per_period` validated.
Итог D1 — §9, итог D2 — §10.

История STOP-GATE'ов:
- **v1** (`bdf8608`) — аудит нашёл 7 сценарных проблем.
- **v2** (`302d9ff`) — 7 исправлений + disposable-проверка.
- **v3** (`e4210c4`) — двухфазный rollout D1 → D2 (rollback после D2 → сохранённый D1-контейнер, не Deploy A).
- **v4** (сейчас) — **исправлена модель инварианта**. Была ошибка: `ux_site_assignment_one_live_primary`
  (partial unique index на `("employeeId") WHERE isPrimary AND clockInDisabledAt IS NULL`) означал
  «≤1 primary среди всех текущих и будущих» и **ломал основной сценарий запланированного перевода**:
  не давал одновременно иметь текущее primary A `[.., transferDate−1]` и запланированное будущее
  primary B `[transferDate, ..]`. Теперь инвариант — **«≤1 живого primary на один и тот же
  ПЕРИОД»**, enforced GiST EXCLUDE-constraint по пересечению дат.

Ветка `feature/titanor-time-foundation`.
Коммиты: **D1 `b9cb5e7`** (код, схема 99) · **D2 `5690632`** (Migration 2, inventory 100).
Образы: **`d7d1-b9cb5e7`** · **`d7d3-5690632`**.

---

## 1. Исправленная модель (STOP-GATE #3)

### Инвариант
**≤1 «живого» (`clockInDisabledAt IS NULL`) назначения с `isPrimary=true` на один и тот же ПЕРИОД**
одного работника. НЕ «≤1 среди текущих и будущих».

«Кто основной сейчас» = единственное живое primary, чей диапазон дат **покрывает `today`**.
`resolvePrimarySiteId`, приложение работника и гейт Check In (`liveAssignmentWhere`) резолвят по
датам, **не** по глобальному флагу. В `transferDate` управление переходит к B автоматически —
**без cron, без действий начальника**.

### Enforcement
1. **Сервис** под per-employee advisory-lock демоутит прежние primary, **период которых
   пересекается** с новым (`isPrimary AND clockInDisabledAt IS NULL AND daterange && daterange`),
   в той же транзакции. Непересекающийся будущий/прошлый primary **не трогается**. По одному
   `AssignmentTransition` на снятое.
2. **Backstop — GiST EXCLUDE-constraint** `ex_site_assignment_one_primary_per_period` (Migration 2,
   D2), зеркалит EX-02:
   ```sql
   EXCLUDE USING gist (
     "employeeId" WITH =,
     daterange("validFrom", COALESCE("validTo" + 1, 'infinity'::date), '[)') WITH &&
   ) WHERE ("isPrimary" = true AND "clockInDisabledAt" IS NULL);
   ```
   SQLSTATE `23P01` → `409 PRIMARY_PERIOD_CONFLICT` (гонка мимо lock).

### changeWorkplace
| | старое A | новое B |
|---|---|---|
| **будущий** перевод (`effectiveFrom > today`) | `validTo = effectiveFrom−1`, **сохраняет `isPrimary`**, без `clockInDisabledAt` | `validFrom = effectiveFrom`, `isPrimary` — периоды не пересекаются, оба primary |
| **немедленный** перевод (`effectiveFrom ≤ today`) | `isPrimary=false` + `clockInDisabledAt = now` сразу; `validTo = today`, если в этот день уже есть отработанные/запланированные часы на A (§P5), иначе `today−1` | `validFrom = effectiveFrom`, `isPrimary` |

### §P4 — запланированный перевод нельзя молча отменить
Если новое `isPrimary=true` (create / promote / PATCH / немедленный change) пересекается с уже
запланированным будущим primary (`validFrom > today`) → `409 SCHEDULED_PRIMARY_CONFLICT` (тело:
`scheduledAssignmentId`, `scheduledValidFrom`). Начальник повторяет с `primaryConflictResolution`:
- `KEEP_SCHEDULED` — новое действие делается **не-primary**, план сохраняется;
- `REPLACE_SCHEDULED` — план **остаётся назначением** (даты целы), но теряет primary; замена
  фиксируется отдельным `AssignmentTransition` (`reasonText: «… superseded …»`) +
  `AuditEvent.afterValue.demotedScheduledPrimaryAssignmentIds`.

---

## 2. Почему двухфазный rollout (без изменений с v3)

После установки constraint старый образ **`d7a-37dddb1` несовместим операционно**: его
`PATCH {isPrimary:true}` / `createAssignment` / старый `/change` / `/split` не демоутят
пересекающийся primary → `23P01` → **HTTP 500**. `schema:ahead` доказывает только, что приложение
**стартует**.

| Момент отката | Rollback ведёт на |
|---|---|
| после **D1** (constraint ещё нет) | Deploy A (`d7a-37dddb1`) — безопасно |
| после **D2** (constraint установлен) | **сохранённый D1-контейнер** (`d7d1-b9cb5e7`) — **не** Deploy A |

Полный runbook: **`R15_D7_DEPLOY_D_ROLLBACK_RUNBOOK_RU.md`**.

---

## 3. Решения владельца (2026-09-02) — ручной шаг перед Migration 2

| Работник | № | Основное (оставить) | Снять `isPrimary` (только флаг) |
|---|---|---|---|
| Nazar Druz | 1002 | `c6825d98-…` — Meyer Turku — **Aros Marine** | `3d95975f-…` — Meyer Turku — (без заказчика) |
| Mykhailo Sadovnikov | 1004 | `bc174aef-…` — Meyer Turku — **Aros Marine** | `cbf688b7-…` — Meyer Turku — (без заказчика) |

`3d95975f` и `cbf688b7`: **только `isPrimary=false` (+ `version+1`)**. Не удалять, не завершать,
не переносить часы (`cbf688b7` держит 10 `WorkSegment` / 5 `ClockShift`), не менять историю.
У обоих работников два primary СЕЙЧАС **пересекаются по датам** — constraint не провалидируется
без этого шага. `ops/titanor-time/r15-d7/fix-double-primary.sql` — одна транзакция под advisory-lock,
явный `-v actor=<ACTIVE-SUPER_ADMIN-uuid>` (проверяется до `UPDATE`), preflight + post-guard
(0 пересекающихся primary-пар глобально).

---

## 4. Обязательные тесты владельца P1–P6

`titanor-time-app/scripts/_test-t9-assignment-lifecycle.ts` (browser lane, реальный HTTP,
disposable PG16, DB-ассерты, ноль моков). Прогон на образах **`d7d1-b9cb5e7`** И **`d7d3-5690632`**.
**Итог: 48/48 P-проверок, 118/118 всего теста — на обоих образах.**

| # | Сценарий | Результат |
|---|---|---|
| **P1** | Future transfer: A primary сегодня, B primary через неделю. До даты `resolvePrimarySiteId` = A; Check In работника открывает смену **на A** (привязана к назначению A); Check In на B назначения не резолвит (B не live). Оба хранятся `isPrimary=true`, `clockInDisabledAt=NULL`, периоды `[.., +6d]` / `[+7d, ..]` не пересекаются. | **PASS** (P1a–P1h, 8/8) |
| **P2** | Effective day: состояние будущего перевода в его дату (A `[.., yst]`, B `[today, ..]`, оба `isPrimary`, `clockInDisabledAt=NULL` — ничего не демоутилось, cron не бегал). `resolvePrimarySiteId` = B; «текущие назначения» (тот же гейт, что видит работник) показывают B, не A; Check In на B резолвит B, на A — назначение не резолвится. | **PASS** (P2a–P2f, 6/6) |
| **P3** | Non-overlap invariant: сервис демоутит **пересекающийся** primary → 1 живой primary; будущий перевод оставляет **оба** (2 живых, непересекающихся), без `PRIMARY_PERIOD_CONFLICT`. DB backstop (L10a/L10b): raw INSERT пересекающегося → `23P01` при установленном constraint; непересекающийся (`[..2025]`+`[2026..]`) — принят. | **PASS** (P3a–P3d + L10a–L10d, 8/8) |
| **P4** | Scheduled-change conflict: create другого primary при запланированном переводе → `409 SCHEDULED_PRIMARY_CONFLICT`, тело называет `scheduledAssignmentId` + `scheduledValidFrom`, план не тронут. `KEEP_SCHEDULED` → 201, новое назначение **не-primary**, план остаётся primary. `REPLACE_SCHEDULED` → 201 primary; запланированное назначение **существует, даты целы**, теряет только primary; `AssignmentTransition` (reasonText «… superseded …») + audit `demotedScheduledPrimaryAssignmentIds`. `promote` — тот же 409. | **PASS** (P4a–P4j, 10/10) |
| **P5** | Same-day completed hours: работник закрыл интервал сегодня на A (материализован фрагмент); начальник переводит сегодня на B. Перевод → **200, НЕ 409**; A → `validTo = today`, `isPrimary=false`, `clockInDisabledAt` задан; фрагмент **остаётся привязан к A** (история не переписана); в табеле дня planned shift **и A, и B**; `resolvePrimarySiteId` → B; следующий Check In → B. | **PASS** (P5a–P5i, 9/9) |
| **P6** | Open shift: `KEEP_ON_OLD` → `effectiveFrom` сдвинут на завтра, A остаётся primary + live (`validTo=today`, `clockInDisabledAt=NULL`), open shift остаётся на A, Check Out на A **не блокируется**. `MOVE_TO_NEW` → open shift перепривязан к B, весь shift уходит на B (фрагменты на B, **0 на старом A**), Check Out **не блокируется**. | **PASS** (P6a–P6j, 10/10) |

Полный построчный вывод — §7.

---

## 5. Disposable-проверка

### 5.1 Полный browser lane — оба образа
| Тест | `d7d1-b9cb5e7` (схема 99, без constraint) | `d7d3-5690632` (схема 100, constraint) |
|---|---|---|
| `_test-t9-assignment-lifecycle` (L1–L16 + P1–P6) | **118 / 118** | **118 / 118** |
| `_test-t9-setup-lifecycle` (вкл. CH11 кнопка) | **113 / 113** | **113 / 113** |
| `_test-t9-full-flow` | **84 / 84** | **84 / 84** |
| `_test-t9-setup-ui` | **26 / 26** | **26 / 26** |
| `_test-t9-role-matrix` | **33 / 33** | **33 / 33** |

`L10a` ветвится по наличию constraint: D1 — «raw INSERT пересекающегося primary не отклоняется
на уровне БД, сервис держит инвариант»; D2 — «constraint отклоняет `23P01`». `L10b` — непересекающийся
raw INSERT принят на обоих. **unit lane 17 / 17.** **restart-persistence:** seed `_test-t9-full-flow`
84/84 → `PHASE=prepare` 5/5 → `docker restart` только app → `PHASE=verify` 18/18 (byte-identical hash
+ живая авторизованная ADMIN-запись после рестарта).

### 5.2 Двухфазный rollout на restore-копии (`ops/titanor-time/r15-d7/verify-rollout-on-restore.sh`)

Backup: **`production-20260902T211841Z-pre-migration`** (99 миграций, 2135 строк, on-box + off-box verified).
На restore-копии: `_prisma_migrations`=99, overlapping-primary pairs = **4** (Nazar #1002 + Mykhailo #1004).

| Фаза | Результат |
|---|---|
| **A.** `d7a` на схеме 99 | `/api/ready` 200 `current 99/99` |
| **B.** swap → `d7d1` на схеме 99 | `/api/ready` 200 `current 99/99`. Операции: create 2-й пересекающийся primary → **1 live primary** (a1 авто-демотировано); PATCH `isPrimary:true` → **200, 1 live primary**; `/promote` → **200**; immediate `/change` на свободный сайт → **200**; **future `/change` на отдельном работнике → 200, 2 live primary (текущий `[.. +6d]` + запланированный `[+7d ..]`, непересекающиеся)**. Whole-DB overlapping pairs = 4 — предсуществующие Nazar+Mykhailo, D1 их не трогает. |
| **B-rollback.** `d7d1` → `d7a` на схеме 99 | `/api/ready` 200 `current 99/99` — **rollback D1→A безопасен** |
| **C.** `fix-double-primary.sql` + `migrate deploy` (Migration 2), `d7d1` продолжает работать | fix → `COMMIT`; миграция применена, **constraint установлен, 100 миграций, 0 bad**; `d7d1` (работает) → `/api/ready` 200 **`schema: ahead, aheadBy 1`**; операции `d7d1` **с constraint**: create 2-й primary=201 / PATCH=200 / promote=200 — **ни одного 500**; **0 overlapping pairs** (fix очистил Nazar+Mykhailo) |
| **D. ДОКАЗАТЕЛЬСТВО.** `d7a` (старый код) на схеме 100 | `/api/ready` 200 `ahead` (стартует), **но** `POST /api/admin/assignments` (2-й пересекающийся primary) → **HTTP 500**, лог: `PrismaClientUnknownRequestError … code: "23P01", message: "conflicting key value violates exclusion constraint \"ex_site_assignment_one_primary_per_period\""`. **Rollback на `d7a` после D2 нельзя.** |
| **E.** финальный swap → `d7d3` | `/api/ready` 200 **`current 100/100`** |

### 5.3 `verify-migration-on-restore.sh` — Migration 2 на restore-копии
- **PHASE 1** (`migrate deploy` **без** fix): **FAIL как и ожидалось** — `Error: P3018` / `Database
  error code: 23P01`: `could not create exclusion constraint "ex_site_assignment_one_primary_per_period"`,
  `DETAIL: Key (…, [2026-08-26,infinity)) conflicts with Key (…, [2026-09-02,infinity))` для
  Mykhailo `8bb03525` (и аналогично Nazar). Миграция `20260902180000_add_primary_period_exclusion` —
  `finished=f, rolledback=f`; constraint не создан. exit 1.
- **PHASE 2** (fix + `migrate deploy` ×2): overlapping pairs 4 → после fix **0**; `migrate deploy`
  pass 1 применил Migration 2, pass 2 — `No pending migrations to apply.`; **constraint установлен**
  (`EXCLUDE USING gist ("employeeId" WITH =, daterange(…, '[)') WITH &&) WHERE ((isPrimary = true) AND (clockInDisabledAt IS NULL))`);
  100 миграций, 0 bad.

### 5.4 `fix-double-primary.sql` на restore-копии
- `-v actor` **не передан** → `ERROR: invalid input syntax for type uuid: "MISSING"`, exit 3.
- actor = **ADMIN** → `ERROR: … is not an ACTIVE SUPER_ADMIN — ABORT`, exit 3.
- actor = **ACTIVE SUPER_ADMIN** → `COMMIT`:

  | id | worker | isPrimary | version |
  |---|---|---|---|
  | `c6825d98` | #1002 Nazar | **t** | 1 (не тронут) |
  | `3d95975f` | #1002 Nazar | **f** | 6 (было 5) |
  | `bc174aef` | #1004 Mykhailo | **t** | 1 (не тронут) |
  | `cbf688b7` | #1004 Mykhailo | **f** | 2 (было 1) |

  `AssignmentTransition` = **2** · `AuditEvent ASSIGNMENT_PROMOTED` = **2** · overlapping pairs = **0** ·
  `cbf688b7` `WorkSegment`=10 / `ClockShift`=5 — **не изменились** · `3d95975f` `validTo`/`endedReason`
  — **не изменились** (`2026-09-02` / `1111`).

  > На текущем production `3d95975f` уже закрыт (`validTo = 2026-09-02`, `endedReason = "1111"`) —
  > его завершили через UI после Deploy A. `fix-double-primary.sql` это НЕ переписывает: он трогает
  > только `isPrimary`. Его `isPrimary=true` + `clockInDisabledAt IS NULL` всё ещё попадали в предикат
  > constraint и пересекались с `c6825d98` на `2026-09-02` → почему Migration 2 без fix падает.

---

## 6. План production — двухфазный

### D1 (только код, схема 99)
1. `backup-titanor-time.sh pre-deploy` (verify on+off-box).
2. Web-only swap `d7a-37dddb1` → `d7d1-b9cb5e7` (~10–15 c). scheduler не трогать.
3. Verify `/api/ready` 200 `current 99/99` локально и через Caddy; read-only смоук
   `/admin/assignments` «Сделать основным» + карточка работника.
4. **Rollback D1** → `d7a-37dddb1` (constraint нет — безопасно).
5. Наблюдение (по решению владельца).

### D2 (fix данных + Migration 2) — после стабильного D1
1. **Свежий** `backup-titanor-time.sh pre-migration` (verify on+off-box).
2. `psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -v actor=<ACTIVE-SUPER_ADMIN-uuid> -f ops/titanor-time/r15-d7/fix-double-primary.sql`
   — проверить вывод (4 строки, isPrimary как в §5.4).
3. `docker run --rm --network titanor-time-prod-net … --entrypoint node titanor-time-app:d7d3-5690632 .prisma-tools/.../prisma migrate deploy` — Migration 2 (`ALTER TABLE … ADD CONSTRAINT`, миллисекунды на текущем объёме). **`d7d1`-контейнер продолжает обслуживать.**
4. Verify: constraint есть, 100 миграций 0 bad, `d7d1` `/api/ready` 200 `schema: ahead`.
5. **(опционально)** swap `d7d1` → `d7d3-5690632` для `/api/ready` `current 100/100`. Переименованный
   `d7d1`-контейнер = `titanor-time-prod-app-pre-5690632`.
6. **Rollback после D2** → `d7d1`-контейнер. **НЕ на `d7a`. Схему не откатывать.**

Caddy/DNS/scheduler/публичный сайт — без изменений. Пароли/аккаунты — без изменений.
Actor для fix = `pilot-owner` `cba8d0ff-0fd2-45bc-b83c-1d19ceee2bee` (подтверждён ACTIVE
SUPER_ADMIN) — если владелец не назовёт другого.

---

## 7. Полный вывод P1–P6

Прогон `_test-t9-assignment-lifecycle.ts` на `d7d3-5690632` (идентично на `d7d1-b9cb5e7`):

```
──────── P1–P6 (STOP-GATE #3 mandatory owner scenarios) ────────
  PASS  P1a: schedule the transfer to start in a week → 200
  PASS  P1b: A stays primary, validTo = the day before the transfer, clockInDisabledAt NULL
  PASS  P1c: B is a future primary (validFrom = transfer date, isPrimary, not live yet)
  PASS  P1d: BOTH stored primary — disjoint periods, DB constraint satisfied
  PASS  P1e: resolvePrimarySiteId returns A (its range covers today, B's does not)
  PASS  P1f: admin "current assignments" shows A, not B
  PASS  P1g: worker Check In today attributes to A (open shift bound to assignment A)
  PASS  P1h: Check In on B today resolves NO assignment (B not live until the transfer date)
  PASS  P2a: on the handover day BOTH rows are still stored primary (disjoint) — nothing demoted
  PASS  P2b: clockInDisabledAt is NULL on both — no cron / no manual switch happened
  PASS  P2c: resolvePrimarySiteId now returns B (its range covers today; A's ended yesterday)
  PASS  P2d: admin "current assignments" now shows B, not A (the worker app uses the same gate)
  PASS  P2e: Check In on the NEW site B attributes to B
  PASS  P2f: Check In on the OLD site A resolves NO assignment (its window ended yesterday)
  PASS  P3a: service — overlapping primary created → prior auto-demoted, exactly 1 live primary
  PASS  P3b: service — future transfer keeps BOTH primaries (disjoint), no PRIMARY_PERIOD_CONFLICT
  PASS  P3c: DB backstop — see L10a (raw overlapping INSERT → 23P01 when the constraint is installed)
  PASS  P3d: DB backstop — see L10b (raw DISJOINT INSERT accepted by the constraint)
  PASS  P4a: creating another primary while a transfer is scheduled → 409 SCHEDULED_PRIMARY_CONFLICT
  PASS  P4b: the 409 body names the scheduled assignment + its start date
  PASS  P4c: the scheduled transfer is untouched (still exists, still primary, dates intact)
  PASS  P4d: KEEP_SCHEDULED → 201, new assignment created NON-primary, transfer kept
  PASS  P4e: KEEP_SCHEDULED left B primary
  PASS  P4f: REPLACE_SCHEDULED → 201, new assignment IS primary
  PASS  P4g: the scheduled assignment still EXISTS with its dates — only its primary status is dropped
  PASS  P4h: the replacement is RECORDED as an AssignmentTransition (not silent)
  PASS  P4i: the create audit lists the replaced transfer under demotedScheduledPrimaryAssignmentIds
  PASS  P4j: promote while a transfer is scheduled → 409 SCHEDULED_PRIMARY_CONFLICT
  PASS  P5/P6 setup: an OPEN period covering today was created
  PASS  P5a: worker checked in on A earlier today
  PASS  P5b: worker checked out — a completed interval now exists on A today
  PASS  P5c: the completed interval is materialised on A for today
  PASS  P5d: immediate transfer with completed hours today → 200 (NOT 409)
  PASS  P5e: A keeps TODAY (validTo = today) so the interval is not stranded; demoted + clockInDisabledAt set
  PASS  P5f: the completed interval is STILL bound to A (history not rewritten)
  PASS  P5g: today's timesheet has BOTH places (a planned shift for A and for B)
  PASS  P5h: resolvePrimarySiteId now returns B
  PASS  P5i: the next Check In goes to B
  PASS  P6a: worker is on an open shift on A
  PASS  P6b: KEEP_ON_OLD → 200, transfer effective date bumped to tomorrow
  PASS  P6c: A keeps primary + is live today (validTo = today, clockInDisabledAt NULL)
  PASS  P6d: the open shift still belongs to A
  PASS  P6e: Check Out on A is NOT blocked — the shift closes
  PASS  P6f: second worker on an open shift on A
  PASS  P6g: MOVE_TO_NEW → 200, immediate transfer
  PASS  P6h: the open shift is re-pointed to B
  PASS  P6i: Check Out is NOT blocked — the shift closes
  PASS  P6j: the whole shift landed on B (fragments bound to B, none to the old A)
──────── 48/48 P-checks passed ────────
{"pass":118,"fail":0}
```

---

## 8. Файлы

**Код (D1, `b9cb5e7`):** `lib/assignment-lock.ts`, `lib/assignments.ts`,
`lib/assignment-lifecycle-service.ts`, `lib/api-error.ts`,
`app/api/admin/assignments/route.ts`, `.../[assignmentId]/{route,promote,change,split}.ts`,
`app/admin/assignments/AssignmentPrimaryToggle.tsx`; тест
`scripts/_test-t9-assignment-lifecycle.ts` (L1–L16 + P1–P6).
**Миграция (D2, `5690632`):** `prisma/migrations/20260902180000_add_primary_period_exclusion/`.
**Ops:** `ops/titanor-time/r15-d7/{fix-double-primary.sql,verify-migration-on-restore.sh,verify-rollout-on-restore.sh}`.
**Доки:** `04_ADMIN_FIRST_API_CONTRACTS.md`, `05_RAW_SQL_REGISTER.md` (EX-08),
`R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md` (§3.6), этот отчёт, `R15_D7_DEPLOY_D_ROLLBACK_RUNBOOK_RU.md`.

---

## 9. D1 — выполнено на production (2026-09-02 22:14 UTC, разрешение владельца)

| | |
|---|---|
| **Простой** | **≈ 3.9 c** (один web-only swap; `docker stop` завершился < 1 c, новый контейнер `/api/ready` 200 на 2-й секунде) |
| **Новый production image** | `titanor-time-app:d7d1-b9cb5e7` (контейнер `titanor-time-prod-app`, `127.0.0.1:3199→3000`, healthy) |
| **Схема БД** | **99, без изменений** — последняя миграция `20260902160000_add_assignment_lifecycle`. Migration 2 **не** применялась. `ex_site_assignment_one_primary_per_period` **отсутствует** (`pg_constraint` = 0). `fix-double-primary.sql` в production **не** запускался. |
| **scheduler / Caddy / DNS / пароли** | не трогались. `titanor-time-prod-scheduler` (`r14-release-1416503`) — Up 2 дня, тики `runnerOutcome:"ok"`, `failed:0`. |
| **Backup** | `production-20260902T221341Z-pre-deploy` (99 миграций, 2131 строк) — SHA256SUMS проверены on-box **и** off-box. |

**Smoke (read-only, сессии admin/worker выпущены и удалены после проверки):**
- `/api/ready` = 200 `schema:current 99/99` — локально **и** через Caddy (`https://app.titanorgroup.fi`).
- 7 страниц админки + `/worker` → 200 (`/admin`, `/admin/workers`, `/admin/sites`, `/admin/assignments`, `/admin/reports`, `/admin/periods`, `/worker`).
- `GET /api/admin/assignments` → 200 (список рендерится).
- Карточки обоих двойных-primary работников — **Nazar #1002** и **Mykhailo #1004** — `GET /api/admin/workers/:id` → 200.
- `GET /api/worker/context` (сессия Mykhailo) → 200.
- **Оба двойных-primary работника резолвятся в ОДНО живое основное по датам:** Nazar → `c6825d98` (Aros Marine), Mykhailo → `bc174aef` (Aros Marine) — `currentAssignments` карточки = ровно 1 запись, ни один работник не показывает >1 текущего назначения. (`cbf688b7` Mykhailo уже получил `clockInDisabledAt` через UI на prod ранее; `3d95975f` Nazar закрыт `validTo=2026-09-02`.)
- Логи `titanor-time-prod-app` с момента старта: **0** строк `error/exception/unhandled/23P01`.

**Write-path smoke на живой prod НЕ выполнялся** (правило после инцидента 2026-09-02: проверка write-эндпоинтов на prod — только read-only). Путь `create` / `change` / `promote` / будущий перевод **без HTTP 500** доказан на восстановленной копии production (§5.2 B — тот же образ `d7d1-b9cb5e7`, та же схема 99, реальные prod-данные). Если нужен write-smoke на живом prod — по отдельному запросу (оставит тестового работника + append-only Transition-строки).

### Точная команда rollback D1 (Migration 2 не применялась → откат на Deploy A безопасен)
```
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-d1-failed
docker rename titanor-time-prod-app-pre-b9cb5e7 titanor-time-prod-app
docker start titanor-time-prod-app
curl -s http://127.0.0.1:3199/api/ready        # ожидается d7a: schema:current 99/99
```
Схему трогать не нужно. `titanor-time-prod-app-pre-b9cb5e7` (образ `d7a-37dddb1`, Exited) — готовый rollback-контейнер, сохраняется до конца R15.
**(После D2 этот путь БОЛЬШЕ НЕ действителен — см. §10.)**

---

## 10. D2 — выполнено на production (2026-09-03, разрешение владельца)

Строго по двухфазному runbook. **Простой ≈ 3.6 c** (только финальный swap).

### Шаг 1 — свежий verified backup
`production-20260903T034904Z-pre-migration` — 99 миграций, 2160 строк. SHA256SUMS проверены **on-box и off-box**.

### Шаг 2 — `fix-double-primary.sql` (actor = `pilot-owner` `cba8d0ff…`, ACTIVE SUPER_ADMIN)
`BEGIN → SELECT :'actor'::uuid → 2× pg_advisory_xact_lock → preflight DO → UPDATE 1 ×2 → post-guard DO → INSERT 0 2 (Transition) → INSERT 0 2 (Audit) → 4-row result → COMMIT` (exit 0).

| id | worker | было | стало |
|---|---|---|---|
| `c6825d98` | #1002 Nazar | primary v1 | **primary v1 (не тронут)** |
| `3d95975f` | #1002 Nazar | primary v5 | **isPrimary=false v6** |
| `bc174aef` | #1004 Mykhailo | primary v1 | **primary v1 (не тронут)** |
| `cbf688b7` | #1004 Mykhailo | primary v2 | **isPrimary=false v3** |

- **`validFrom` / `validTo` / `clockInDisabledAt` / `endedReason` — не изменены** (`3d95975f` validTo `2026-09-02` endedReason `1111`; `cbf688b7` validTo `2026-09-03` clockInDisabledAt `2026-09-02 21:33` endedReason `1`).
- **Часы не изменены:** `cbf688b7` — 10 `WorkSegment` / 5 `ClockShift` (было 10 / 5).
- `AssignmentTransition` 1 → **3** (+2, kind=CHANGE, actor=pilot-owner, from демотированное → to оставленное).
- `AuditEvent ASSIGNMENT_PROMOTED` 0 → **2**.
- **overlapping_primary_pairs = 0** · workers с >1 live primary = **0**.

### Шаг 3 — Migration 2 через отдельный контейнер `d7d3-5690632` (D1 продолжал обслуживать)
- pass 1: `Applying migration 20260902180000_add_primary_period_exclusion` → `All migrations have been successfully applied.` (exit 0).
- pass 2: `No pending migrations to apply.` (**no-op**, exit 0).
- Схема: **100 applied · 0 unfinished/rolled-back**.
- `ex_site_assignment_one_primary_per_period` создан: `EXCLUDE USING gist ("employeeId" WITH =, daterange("validFrom", COALESCE(("validTo"+1),'infinity'::date),'[)') WITH &&) WHERE ((("isPrimary"=true) AND ("clockInDisabledAt" IS NULL)))`, `convalidated = true`.

### Шаг 4 — D1 (`d7d1-b9cb5e7`) на схеме 100
- контейнер `Up 6 hours (healthy)`;
- `/api/ready` = 200 `status:ready`, **`schema:ahead`, `aheadBy:1`** (D1 корректно допускает ahead);
- `/admin/workers`, `/admin/assignments`, `/admin/sites` → 200; карточки Nazar + Mykhailo → 200; `/api/worker/context` + `/worker` → 200;
- Mykhailo резолвится в `bc174aef` (Aros Marine);
- app-лог: **0** `error/23P01/500`; scheduler `runnerOutcome:"ok"`.

### Шаг 5 — web-only swap
`d7d1-b9cb5e7` → `d7d3-5690632`. `SWAP 2026-09-03T03:52:10Z → READY 200 03:52:13Z`, **простой ≈ 3.6 c**.
D1-контейнер переименован в **`titanor-time-prod-app-pre-5690632`** (rollback-цель).

### Шаг 6 — после swap
| | |
|---|---|
| `/api/ready` локально + через Caddy | **200 `schema:current 100/100` `aheadBy:0`** |
| контейнер | `titanor-time-app:d7d3-5690632`, healthy |
| `/login` | 200 · `POST /api/auth/login` (неверные creds) → 401 (роут жив) |
| `/admin` `/admin/workers` `/admin/sites` `/admin/assignments` `/admin/reports` `/admin/periods` | все 200 |
| карточки Nazar #1002 / Mykhailo #1004 | 200 · Mykhailo `currentAssignments` = ровно 1 (`Aros Marine`, primary) |
| `/api/worker/context` + `/worker` (сессия Mykhailo) | 200 |
| app-лог | **0** `error/exception/23P01/500` |
| scheduler / Caddy / DNS / пароли / публичный сайт | не трогались · `titanor-time-prod-scheduler` (`r14-release-1416503`) Up 2 дня, `outcome:"ok"`, `failed:0` |

Post-D2 backup схемы 100: `production-20260903T035327Z-manual` (100 миграций, 742 TOC, on+off-box).
Смоук-сессии (admin + worker) выпускались через прямой INSERT и **удалены** после каждой проверки. Write-smoke на живом prod не выполнялся.

### Точная команда rollback ПОСЛЕ D2 — только на сохранённый D1-контейнер
**НЕ откатывать на Deploy A `d7a-37dddb1`.** **Схему НЕ откатывать** (constraint additive, D1-код держит инвариант сам).
```
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app titanor-time-prod-app-d2-failed
docker rename titanor-time-prod-app-pre-5690632 titanor-time-prod-app      # <-- D1-контейнер, образ d7d1-b9cb5e7
docker start titanor-time-prod-app
curl -s http://127.0.0.1:3199/api/ready        # ожидается d7d1: status ready, schema ahead, aheadBy 1
```
`titanor-time-prod-app-pre-5690632` (образ `d7d1-b9cb5e7`, Exited) — rollback-контейнер D2, сохраняется до конца R15.
Полный откат схемы (крайняя мера): `ALTER TABLE "SiteAssignment" DROP CONSTRAINT "ex_site_assignment_one_primary_per_period"` либо restore `production-20260903T034904Z-pre-migration`.

**Данные `fix-double-primary.sql` откату не подлежат** (целевое состояние, согласованное владельцем).
