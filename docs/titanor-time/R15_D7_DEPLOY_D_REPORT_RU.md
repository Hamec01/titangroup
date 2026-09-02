# R15-D7 — Deploy D («Одно основное назначение»): отчёт (v2, после STOP-GATE)

**Статус:** подготовлено и проверено в disposable-среде. **Production не изменялся.** Ждёт
отдельного разрешения владельца.

История: v1 (`bdf8608`) прошёл typecheck/lint/build, но независимый аудит владельца нашёл
сценарные проблемы (STOP-GATE). Исправлены все 7 пунктов (`ba82158` → `092511b` → `74ac011`).
Кандидат-образ **`titanor-time-app:d7d3-092511b`** (схема ожидает **100**).

Порядок обязателен: **сначала ручной fix данных, затем Миграция 2**.

---

## 1. Решения владельца (2026-09-02)

| Работник | № | Основное (оставить) | Снять `isPrimary` (только флаг) |
|---|---|---|---|
| Nazar Druz | 1002 | `c6825d98-…` — Meyer Turku — **Aros Marine** | `3d95975f-…` — Meyer Turku — (без заказчика) |
| Mykhailo Sadovnikov | 1004 | `bc174aef-…` — Meyer Turku — **Aros Marine** | `cbf688b7-…` — Meyer Turku — (без заказчика) |

У `3d95975f` и `cbf688b7`: **только `isPrimary=false` (+ `version+1`)**. Не удалять, не завершать,
не переносить часы, не менять историю. (`cbf688b7` имеет 10 `WorkSegment` / 5 `ClockShift` —
остаются на нём.)

---

## 2. STOP-GATE — 7 обязательных исправлений

### 1. `PATCH /api/admin/assignments/:id { isPrimary:true }` больше не обходит сервис
Раньше — прямой `updateMany` без advisory-lock и без демоушена → после индекса `23505/500`.
Кнопка `AssignmentPrimaryToggle` шлёт именно этот PATCH.
Теперь: при `isPrimary:true` роут вызывает `promoteToPrimary` (advisory-lock + демоушен всех
прежних live-primary + `AssignmentTransition` + audit, одна транзакция), с проверкой `version`
(`409 VERSION_CONFLICT`), недоступно на снятом/завершённом (`409 ASSIGNMENT_NOT_ACTIVE`), нельзя
вместе с `endedReason` (`400`). `isPrimary:false` / `endedReason` — прежний optimistic-путь
(индекс-безопасно: строка только уходит из предиката). Компонент кнопки обрабатывает
`LIVE_PRIMARY_CONFLICT` / `ASSIGNMENT_NOT_ACTIVE`.

### 2. `POST /api/admin/assignments/:id/split` → `410 Gone`
Делал `siteAssignment.create` вне сервиса (без lock, без демоушена) → split основного = 2 ряда
под индексом → `23505/500`. UI-вызовов нет, был untested/incomplete. Замена — `/change`.
Контракты обновлены (`04_ADMIN_FIRST_API_CONTRACTS.md`).

### 3. Демоушен покрывает будущий `clockInDisabledAt`
Предикат демоушена расширен с `isPrimary AND clockInDisabledAt IS NULL` до
**`isPrimary AND (clockInDisabledAt IS NULL OR clockInDisabledAt > now())`** (`livePrimaryDemoteWhere`).
Назначение, снятие/перевод которого запланированы на будущий момент, **прямо сейчас ещё
operationally live** — теперь тоже демоутится. После любой операции среди реально live
назначений ≤1 primary (не только ≤1 в индекс-предикате). Применено в `createAssignmentInTx` и
`promoteToPrimary`.

### 4. `resolvePrimarySiteId` (worker-timesheets.ts) — clockInDisabledAt-aware + детерминизм
Было: `findFirst` без `clockInDisabledAt` и без `orderBy`. Стало:
`{ isPrimary: true, …liveAssignmentWhere(now, today) }` + `orderBy: [{ validFrom: 'desc' }, { id: 'asc' }]`.
Немедленный перевод в тот же день → `contextSiteId` табеля указывает на **новое** действующее
основное; снятое/отключённое основное с «висящим» флагом исключается.

### 5. Автодемоушен пишет ID в `AssignmentTransition` + `AuditEvent`
`createAssignmentInTx` возвращает `demotedPrimaryIds`. `createAssignment` и `changeWorkplace`
пишут по одному `AssignmentTransition` на каждое авто-снятое прежнее основное и кладут `id`
в audit создания/изменения. Никаких скрытых изменений истории.

### 6. `fix-double-primary.sql` — без скрытого actor
Убран дефолт. Требуется `-v actor=<uuid>` (голый UUID). Транзакция до любого `UPDATE`:
(0a) `SELECT :'actor'::uuid` — падает на `MISSING`/мусоре; (0b) `\gset` + `\if` — проверка
`ACTIVE` + активная `SUPER_ADMIN`-роль, иначе `RAISE EXCEPTION`. Плюс preflight/post guard'ы.

### 7. Полный ре-скан писателей `SiteAssignment`
`create` / `changeWorkplace` / `removeFromSite` / `promoteToPrimary` / PATCH / §3.12-шаг Check Out
— все через **один** advisory-lock (`lib/assignment-lock.ts`) + сервис. §3.12-шаг теперь берёт
lock (только на редком пути «сняли во время смены») и перечитывает под ним. `/split` удалён.
`attendance-clock.ts:1246` (продление `validTo`) — не трогает `isPrimary` и не создаёт replacement,
под lock. Прочие места — только чтение.

---

## 3. Миграция 2 — `20260902180000_add_one_live_primary_index`
```sql
CREATE UNIQUE INDEX "ux_site_assignment_one_live_primary"
  ON "SiteAssignment" ("employeeId")
  WHERE "isPrimary" = true AND "clockInDisabledAt" IS NULL;
```
DB-backstop за сервисом. Снятое / removeFromSite'нутое / прошлое / не-основное-будущее — вне
предиката. PRECONDITION: сначала ручной fix.

---

## 4. `ops/titanor-time/r15-d7/fix-double-primary.sql`
Одна атомарная транзакция: uuid+SUPER_ADMIN guard → 2 `pg_advisory_xact_lock` (ключ сервиса,
порядок по employeeId) → preflight-guard → 2× `UPDATE isPrimary=false, version+1` (с `AND
isPrimary=true`, идемпотентно) → post-guard (≤1 в индекс-предикате на работника) → 2×
`AssignmentTransition` (`kind=CHANGE`, from=снятое, to=оставленное) → 2× `AuditEvent`
(`ASSIGNMENT_PROMOTED`, `demotedAssignmentIds`) → показ 4 строк → `COMMIT`.

---

## 5. Disposable-проверка (образ `d7d3-092511b`)

### 5.1 Полный browser lane (`run-browser-acceptance.sh`, шаблон = все 100 миграций, индекс есть)
| Тест | Результат |
|---|---|
| `_test-t9-assignment-lifecycle` (L1–L16) | **68 / 68** |
| `_test-t9-setup-lifecycle` (вкл. CH11 «Сделать основным») | **113 / 113** |
| `_test-t9-full-flow` | **84 / 84** |
| `_test-t9-setup-ui` | **26 / 26** |
| `_test-t9-role-matrix` | **33 / 33** |

### 5.2 restore свежего production backup + `migrate deploy` ×2
Backup `production-20260902T184804Z-manual` (схема 99, 2129 строк). `d7d-verify.sh`:

**PHASE 1 — `migrate deploy` БЕЗ fix → ожидаемый провал**
`P3018 / 23505 could not create unique index … Key ("employeeId")=(1f8b5243-…) is duplicated`;
миграция unfinished, индекс не создан. Подтверждает порядок «fix → миграция».

**PHASE 2 — fix-double-primary.sql, затем `migrate deploy` ×2 → успех**
- `-v actor` **не передан** → `ERROR: invalid input syntax for type uuid: "MISSING"`, rc 3.
- actor = **ADMIN** (не SUPER_ADMIN) → `ERROR: … is not an ACTIVE SUPER_ADMIN — ABORT`, rc 3.
- actor = **реальный ACTIVE SUPER_ADMIN** (`cba8d0ff` pilot-owner) → `COMMIT`, rc 0.

  | id | isPrimary | version |
  |---|---|---|
  | `c6825d98` | **t** | 1 (не тронут) |
  | `3d95975f` | **f** | 6 (было 5) |
  | `bc174aef` | **t** | 1 (не тронут) |
  | `cbf688b7` | **f** | 2 (было 1) |

  - `AssignmentTransition` = **2** · `AuditEvent ASSIGNMENT_PROMOTED` = **2**
  - работников с >1 в индекс-предикате = **0**
  - **`cbf688b7`: `WorkSegment`=10, `ClockShift`=5 — не изменились**
  - `3d95975f`: `validTo`=2026-09-02, `endedReason`='1111' — **не изменились**
- `migrate deploy` pass 1 → индекс создан; pass 2 → `No pending migrations`.
- Итог: **100 миграций, 0 bad**; индекс:
  `… ("employeeId") WHERE (("isPrimary" = true) AND ("clockInDisabledAt" IS NULL))`; 0 нарушений.

### 5.3 unit lane
17 / 17.

### 5.4 restart-persistence
prepare 5/5 · `docker restart` · verify 18/18 — `clockInDisabledAt`, `AssignmentTransition`,
`isPrimary`-флаги и FINAL_APPROVED табель переживают рестарт.

---

## 6. Тесты (disposable-код)

`_test-t9-assignment-lifecycle.ts` L1–L16 (было L1–L8):
- L9 create-2nd-primary демоутит первое · L10 индекс отклоняет raw 2-е live-primary; `/change`
  primary не падает · **L11** PATCH `isPrimary:true` через сервис + `version` (409) + `+endedReason`
  (400) · **L12** `/split` → 410 · **L13** два админа `/promote` одновременно → 1 live primary ·
  **L14** будущий `clockInDisabledAt` тоже демоутится · **L15** `resolvePrimarySiteId` берёт новое
  основное после перевода в тот же день + submit табеля · **L16** §3.12 продление `validTo` на
  ночной смене.
- `_test-t9-setup-lifecycle.ts` **CH11** — реальная кнопка «Сделать основным» на `/admin/assignments`:
  клик → старое демоутится, новое primary, 1 live primary, `AssignmentTransition` + `ASSIGNMENT_PROMOTED`.

---

## 7. План production Deploy D (после разрешения владельца)

1. `backup-titanor-time.sh pre-migration` (verified on+off-box).
2. **`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v actor=<ACTIVE-SUPER_ADMIN-uuid> -f ops/titanor-time/r15-d7/fix-double-primary.sql`**
   прямо в prod DB. Проверить вывод: 4 строки, isPrimary как в §5.2.
3. `docker exec`-throwaway из `d7d3-<sha>` → `prisma migrate deploy` (Миграция 2, `CREATE INDEX`,
   миллисекунды; старый образ `d7a-37dddb1` обслуживает: `schema:ahead`).
4. Verify: 100 миграций 0 bad, индекс есть, 0 нарушений предиката, `/api/ready` старого 200.
5. Web-only swap `d7a-37dddb1` → `d7d3-<sha>` (~10–15 c 503). scheduler не трогать.
6. Verify `/api/ready` 200 `schema:current 100/100` локально и через Caddy; карточки Nazar +
   Mykhailo (read-only) — по одному основному; `/admin/assignments` «Сделать основным» — read-only смоук.
7. Rollback: откат образа на `titanor-time-prod-app-pre-<sha>` (`d7a-37dddb1`). Схему **не**
   откатывать (`d7a` работает при `schema:ahead`; индекс безвреден для старого кода). Данные fix'а —
   целевое состояние, откату не подлежат.

Caddy/DNS/scheduler/публичный сайт — без изменений. Пароли/аккаунты — без изменений.
