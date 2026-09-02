# R15-D7 — Единый жизненный цикл назначения (design)

Статус: **черновик на согласование. Кода нет, миграции нет, деплоя нет.**
Ветка: `feature/titanor-time-foundation`, фактический HEAD `764ad17` (владелец писал от `a8ec720` —
с тех пор задеплоены D6 «Заказчик» `496aa3c` и D6b страница заказчика `5381b9f`; обе — только
UI/чтение, лицензионную логику назначений не трогали).
Прод сейчас: `titanor-time-app:customer-page-5381b9f`, schema 98/98, scheduler и DB healthy.

Опирается на: `04_ADMIN_FIRST_API_CONTRACTS.md` §6, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §9.1/§9.2/§9.4/§11,
`03_DATA_MODEL_ERD.md` §4.4, `05_RAW_SQL_REGISTER.md` (EX-02, TRG-11), `AGENT_RULES.md` §11/§15.

---

## 1. Найденные противоречия текущей реализации

### C1. Одна дата `validTo` тянет три несовместимые роли
`SiteAssignment.validTo` (`@db.Date`) сейчас одновременно:
- **исторический payroll-рубеж** — до какой даты по назначению могут быть часы (материализатор
  `resolveActiveAssignment` привязывает фрагменты к датам `[validFrom, validTo]`);
- **гейт нового Check In** — `resolveActiveSiteAssignment` (`lib/attendance-clock.ts`) резолвит
  `sourceAssignmentId` по `validTo >= date`;
- **признак «текущего» для админ-экранов**.

### C2. Гейт «текущего» разный в разных частях приложения
| потребитель | файл | фильтр `validTo` |
|---|---|---|
| карточка работника + `/admin/workers` | `lib/workers.ts` `currentAssignmentWhere` | **`> today`** (правка D5, 2026-09-02) |
| приложение работника, список объектов | `lib/worker-context.ts` `listWorkerCurrentAssignments` | `>= today` |
| резолв Check In | `lib/attendance-clock.ts` `resolveActiveSiteAssignment` | `>= today` |
| офлайн-синхронизация | `lib/attendance-sync.ts` | `>= today` |
| страница объекта «Активные назначения» | `lib/sites.ts` `getSiteDetail` | `>= today` |
| экран «Сегодня» | `lib/attendance-overview.ts` | `>= today` |
| матрица квалификаций | `lib/qualification-matrix.ts` | `>= today` |
| scope прораба | контракт §16 | `>= today` |
| матrializer, отчёт по объекту | `lib/attendance-materializer.ts`, `lib/site-time-report.ts` | по датам периода — **корректно, оставить** |

**Следствие (то, о чём написал владелец):** админ «снял» работника «сегодня» → назначение
исчезает из карточки, но **приложение работника, резолв Check In, прораб и «Сегодня» продолжают
считать его действующим сегодня**. `gt`/`gte` — не решение.

### C3. Три разных механизма «работник уходит с назначения»
- `/end` (D5): `validTo = today` + удаление `TimesheetDraftPlannedShift` с `date > today`;
- `/change` (D4): старое закрывается `validTo = effectiveFrom − 1`, новое материализуется;
- `/split` (контракт, **не покрыт тестами, не используется UI**): `validTo = effectiveFrom − 1`
  **без** обработки плановых смен → падает в TRG-11 (`ASSIGNMENT_DEPENDENTS_CONFLICT`, HTTP 500).

Каждый endpoint повторяет правила у себя. Общего lifecycle-сервиса нет.

### C4. Нет инварианта «одно основное действующее назначение»
- `ChangeAssignmentAction.tsx` инициализирует `isPrimary=false` и **всегда** шлёт `isPrimary` в
  теле `/change` → «сменить заказчика» молча снимает признак «основное»;
- `createAssignment` / `/change` принимают `isPrimary` как есть;
- только `/promote` демоутит остальных; больше никто.
- **Факт на проде (read-only):** Nazar Druz (#1002) — **два** назначения `isPrimary=true`
  (`3d95975f` Meyer без заказчика; `c6825d98` Meyer — Aros Marine). Ruslan Druz (#1003) — одно.

### C5. История переходов только в `AuditEvent` JSON
UI выводит «Прошлые назначения» и (будущую) пометку в табеле из `AuditEvent` (`ASSIGNMENT_CHANGED`
/ `ASSIGNMENT_ENDED` / `ASSIGNMENT_CHANGE_REVERTED`). Структурной бизнес-записи нет — хрупко.

### C6. Формулировка «с завтра» ломается на ночной смене
`/change` `KEEP_ON_OLD` сдвигает `effectiveFrom` на завтра. Смена, начатая в 22:00 и идущая до
06:00, «дорабатывается сегодня» неоднозначна.

### C7. Завершение объекта = только `WorkSite.active=false`
Нет preflight, нет операционного закрытия назначений, нет состояний «завершается / завершён»,
нет серверного запрета создавать назначение на завершённый объект (D5 отфильтровал только пикер
`?active=true`). Аналогично «отключить заказчика».

### C8. Деактивация работника — гейт нового Check In не подтверждён
`auth.ts` рвёт сессию при `User.status='DEACTIVATED'` немедленно; `OFFBOARDING` — намеренно нет.
Проверяет ли путь Check In `Employment.active` — **нужно проверить в коде на этапе A** (пункт J).

---

## 2. Целевая модель (A)

### 2.1 Разделяем «operational» и «payroll/historical»

**Оставляем без изменений семантику:**
- `SiteAssignment.validFrom` / `validTo` (`@db.Date`) — **payroll-рубеж**. Материализатор, отчёты,
  `TimesheetDraftPlannedShift`, TRG-11 — как есть.

**Добавляем operational-лезвие:**
- `SiteAssignment.clockInDisabledAt` `TIMESTAMPTZ(6)` **nullable**. Точный момент, **после которого
  по этому назначению нельзя начать новую смену**. `NULL` = назначение операционно живо.
  Момент в будущем = запланированное снятие/перевод, до этого момента назначение ещё доступно.

### 2.2 Единственное определение «действующего назначения»

Одна функция `isAssignmentLiveNow(a, now)` в одном модуле (`lib/assignment-lifecycle.ts`), которую
**обязаны** использовать все потребители из таблицы C2 (кроме материализатора и отчётов):

```
live = a.validFrom <= todayHelsinki
       AND (a.validTo IS NULL OR a.validTo >= todayHelsinki)
       AND (a.clockInDisabledAt IS NULL OR a.clockInDisabledAt > now)
```

- «Можно начать новую смену» (приложение работника, `resolveActiveSiteAssignment`,
  `listWorkerCurrentAssignments`) = `live`.
- «Место работы сейчас» (карточка работника, `/admin/workers`, страница объекта, «Сегодня»,
  матрица, прораб) = `live` **или** (`clockInDisabledAt <= now` **и** есть открытая смена по
  этому назначению → строка со статусом «смена ещё идёт»).
- «Запланированные изменения» = назначение с `validFrom > today` **или** `clockInDisabledAt` в
  будущем.
- «Прошлые назначения» = `clockInDisabledAt <= now` и открытой смены нет, либо `validTo < today`.
- **Check Out — всегда разрешён.** Уже гарантировано `T7A_1` §9.2 (закрытие по снимку
  `EmployeeOpenShift`, назначение не проверяется). Не меняем.

Никаких `gt`/`gte` по датам для операционных решений — только `clockInDisabledAt` (точный момент).

### 2.3 Состояния назначения (для UI, вычисляемые, не колонка)

| статус | условие | что можно |
|---|---|---|
| **Сейчас** (`ACTIVE`) | `live`, открытой смены нет | новая смена; изменить; снять; запланировать |
| **Идёт смена** (`SHIFT_OPEN`) | есть `EmployeeOpenShift` по этому назначению | Check Out; снять «после Check Out»; перенести смену |
| **Запланировано** (`SCHEDULED`) | `validFrom > today` или `clockInDisabledAt` в будущем и ещё не наступил | отменить план (если нет зависимых часов) |
| **Завершено** (`ENDED`) | `clockInDisabledAt <= now`, открытой смены нет | только чтение |
| **Требует внимания** (`NEEDS_ATTENTION`) | `STALE_ASSIGNMENT` / незакрытая открытая смена по завершённому назначению / конфликт основного | разрешить в табеле / выбрать основное |

### 2.4 Единый lifecycle-сервис

`lib/assignment-lifecycle.ts` — единственный писатель `SiteAssignment` + `AssignmentTransition` для
операций жизненного цикла. UI и роуты не повторяют правила.

```
assignSite(input)           // создать назначение (обёртка над createAssignmentInTx)
changeWorkplace(input)      // объект / заказчик / график / основное, «когда применить»
removeFromSite(input)       // снять: сейчас | после Check Out | другой срок
finishSite(input)           // завершить объект (preflight → операционное закрытие всех)
disableCustomer(input)      // отключить заказчика (с явным решением по работникам)
reopenSite(id) / enableCustomer(id)
groupChangeWorkplace(input) // M — тот же сервис, groupId
```

Каждая операция:
1. `pg_advisory_xact_lock(hashtext(employeeId))` (или по `siteId` для finishSite);
2. проверки (см. L);
3. мутация `SiteAssignment` (`clockInDisabledAt` и/или новая строка через `createAssignmentInTx`);
4. перенос/удаление черновых плановых смен (правила D5/D4);
5. `EmployeeOpenShift` re-point при «перенести смену»;
6. `INSERT AssignmentTransition` + `createAuditEvent` — **одна транзакция**;
7. возврат человекочитаемого резюме (для «резюме перед подтверждением» — считается отдельным
   read-only preview-эндпоинтом до подтверждения).

---

## 3. Операции — точная семантика

### 3.1 Немедленное снятие «Снять с объекта» → «Сейчас» (E)
- `clockInDisabledAt = now()`;
- `validTo = todayHelsinki`, **но** если есть открытая смена — `validTo =
  max(todayHelsinki, датаОкончанияОткрытойСмены)` (материализатор должен покрыть фрагменты);
- `DELETE TimesheetDraftPlannedShift WHERE sourceAssignmentId = a AND date > validTo`;
- committed `WorkSegment` / `TimesheetPlannedShift` / `TimesheetDraftSegment` /
  `ClockShiftFragment` c `date > validTo` → **409 `ASSIGNMENT_HAS_RECORDED_TIME`**, ничего не
  меняем, ссылка «Открыть табель»;
- `AssignmentTransition(kind=REMOVE, openShiftHandling=NONE)`;
- результат: назначение мгновенно уходит из «Место работы сейчас» и из вариантов Check In у
  **всех** потребителей (единый гейт §2.2), переходит в «Прошлые назначения».

### 3.2 Снятие при открытой смене (D)
Формулировки — **без «сегодня/завтра»**:
1. **«Снять после текущего Check Out»** — `clockInDisabledAt = now()`; открытая смена не трогается;
   Check Out доступен; после Check Out назначение окончательно в истории. Новый Check In на этом
   объекте уже нельзя (DOUBLE_CHECK_IN + гейт).
2. При переводе (есть новый объект) дополнительно: **«Перенести текущую смену на новое место»** —
   `EmployeeOpenShift.{siteId, workAreaId, sourceAssignmentId} := новое`; таймер не рвётся; вся
   открытая смена относится к новому объекту/заказчику; исходный Check In остаётся в журнале как
   факт; `AssignmentTransition(openShiftHandling=MOVED_TO_NEW)`; в табеле — заметная пометка.
- Принудительного Check Out нет. `FORCE_CLOSE_OPEN_SHIFT` (§9.9) — отдельное явное действие, не
  добавляем сюда.

### 3.3 Будущий перевод «Запланировано» (A)
- новое `SiteAssignment` с `validFrom = effectiveDate`, `clockInDisabledAt = NULL`;
- старое: `clockInDisabledAt = effectiveInstant` (00:00 Helsinki даты вступления, либо момент
  окончания открытой смены — по выбору «когда применить»);
- до наступления `effectiveInstant` старое остаётся check-in-able и «основным»;
- в момент `effectiveInstant` (проверяется по `now()` в едином гейте — **никакого scheduler-джоба
  не требуется**, гейт вычисляется на каждый запрос) старое перестаёт быть live, новое становится;
- «отменить запланированное изменение» — только если по новому назначению ещё нет
  `TimesheetDraftSegment` / `ClockShiftFragment` / committed-строк: удалить новое, снять
  `clockInDisabledAt` со старого, `AssignmentTransition(kind=CHANGE, ... , reverted)`.

### 3.4 Исправление ошибочно созданного сегодня назначения (C)
Если назначение создано сегодня и по нему нет: `ClockEvent`, `EmployeeOpenShift`,
`TimesheetDraftSegment`, `ClockShiftFragment`, submitted/FINAL_APPROVED табеля — **изменить одной
операцией** (обновить `siteId`/`workAreaId`/`templateVersionId`/`isPrimary` **в той же строке**,
пере-материализовать плановые смены). Сообщения «удалите и создайте заново» больше нет.
Это единственный случай in-place правки `siteId`/`workAreaId` — иначе всегда новая строка.

### 3.5 «Изменить место работы» (C) — одна форма
Поля: Объект · Заказчик · График · Основное место · «Когда применить» (сейчас / после текущего
Check Out — только при открытой смене / завтра / выбрать дату). Текущие значения предвыбраны.
**Смена одного поля не трогает остальные** (чинит C4: `isPrimary` по умолчанию = текущий,
`templateVersionId` по умолчанию = текущий). Перед подтверждением — резюме:
```
Nazar Druz:
Meyer Turku Shipyard — без заказчика
→ Meyer Turku Shipyard — Aros Marine
Сейчас, график не изменится.
```
Есть фактические часы → история не переписывается: `changeWorkplace` создаёт структурный переход
(старое `clockInDisabledAt`, новое `validFrom`), пометка в табеле.

### 3.6 Основное назначение (F)
Инвариант: **≤1 назначение с `isPrimary=true` среди live (`clockInDisabledAt IS NULL`)** на
работника в любой момент.
- enforcement: (1) сервис под advisory-lock демоутит прежнее live-primary в той же транзакции;
  (2) backstop — partial unique index
  `ux_site_assignment_one_live_primary ON "SiteAssignment"("employeeId") WHERE "isPrimary" AND "clockInDisabledAt" IS NULL`
  (добавляется **отдельной миграцией** после ручного исправления Nazar — см. §5);
- будущий primary-перевод: новое `isPrimary=true, clockInDisabledAt=NULL`; старое primary →
  `clockInDisabledAt = effectiveInstant` (перестаёт считаться live для индекса, конфликта нет);
  на период «зазора» проверка «кто основной для Check In» = «единственное live-primary» → новое;
- конкурентные запросы: advisory-lock + `version` → 409 `VERSION_CONFLICT` + refresh карточки.

**Nazar Druz:** нужен выбор владельца — какое из двух назначений основное (`3d95975f` Meyer без
заказчика **или** `c6825d98` Meyer — Aros Marine). Автоматически не решаем. План: под advisory-lock
`isPrimary=false` у не-выбранного, `AssignmentTransition(kind=CHANGE, reason='fix double primary')`,
затем миграция с индексом. Read-only проверено — оба назначения без `validTo`, оба live.

### 3.7 Приложение работника (G)
- один live-объект → выбран автоматически; несколько → live-primary автоматически, остальные в
  списке;
- снятый объект исчезает после следующей онлайн-синхронизации (единый гейт §2.2);
- открытая смена → экран показывает текущую смену + Check Out, даже если назначение уже
  `clockInDisabledAt <= now`;
- смена заказчика на том же объекте → действий от работника не требуется;
- смена объекта → применяется автоматически, короткое уведомление
  «Начальник изменил место работы: Meyer Turku Shipyard — Aros Marine»;
- нет назначения → «Начальник пока не назначил вам объект»; ручной выбор — вторичное действие.

**Offline:**
- pending-события не удаляются;
- stale-snapshot объект недоступен после успешной синхронизации;
- офлайн Check In до получения изменения не теряется — при синхронизации `resolveActiveSiteAssignment`
  по `effectiveAt` может дать `NULL` → `AttendanceException(STALE_ASSIGNMENT)` (`T7A_1` §9.1), часы
  сохраняются, начальнику видна пометка «требует проверки»;
- stale/offline событие **не перепривязывается молча** — только через `CONFIRM_SOURCE_ASSIGNMENT`
  (§9.7, ADMIN).

### 3.8 Завершение объекта (H)
Preflight (read-only) перед подтверждением:
```
На объекте:
12 назначенных работников · 2 работают сейчас · 3 будущих назначения · 4 заказчика
```
Единственный доступный вариант: **«Завершить после текущих смен»** (+ «Отмена»).
- новые Check In / назначения на объект — сразу запрещены (сервер, L);
- всем live-назначениям объекта — `clockInDisabledAt = now()`; открытым сменам — дать закрыться;
- будущие пустые планы удаляются; committed-часы сохраняются;
- заказчики объекта скрываются из обычных списков;
- статус: **«Завершается — N работников ещё работают»** → (когда открытых смен 0) **«Завершён»**;
- GPS-геозона и история сохраняются.

Хранение статуса: `WorkSite.active=false` **плюс** `WorkSite.finishedAt TIMESTAMPTZ(6)` nullable
(additive). «Завершается» vs «Завершён» = наличие открытых смен по объекту (вычисляемо).
`WorkSite.active` остаётся как «в списках/пикерах» (совместимость с D5).

**«Восстановить объект»:** `active=true`, `finishedAt=NULL`; **назначения не воскресают**; явно:
«Объект восстановлен. Работников нужно назначить заново».

### 3.9 Отключение заказчика (I)
Нельзя `active=false` при live-назначениях. Preflight: сколько назначено / кто сейчас / сколько
будущих. Явный выбор:
1. перевести работников на другого заказчика этого объекта (groupChange);
2. оставить на объекте без заказчика (`changeWorkplace` `workAreaId=NULL` каждому);
3. снять работников (`removeFromSite` каждому);
4. отмена.
Молчаливого `active=false` с live-назначениями нет. Восстановление заказчика назначения не
воскрешает.

### 3.10 Архив/восстановление работника (J)
- деактивация: сразу запрет нового Check In (проверить/добавить `Employment.active` в путь
  Check In — C8), открытую смену дать закрыть, доступ к закрытию табеля по OFFBOARDING сохранить,
  сохранённая сессия нового Check In не даёт (сессия рвётся при `DEACTIVATED`);
- восстановление: показать сохранённые прошлые назначения, спросить «вернуть прежнее место или
  оставить без объекта»; молча старое назначение не возвращать.

### 3.11 Влияние (сводка)
| подсистема | эффект |
|---|---|
| **Табель** | часы остаются у исторического заказчика; смена после админ-перехода идёт туда, куда подтвердил админ; пометка «место работы изменено, HH:MM, кто» — видна ADMIN и уполномоченному прораба, часы не меняет |
| **GPS** | геозона на `WorkSite`, при смене заказчика не меняется; при смене объекта Check In/Out проверяется по геозоне нового объекта с даты вступления |
| **Прораб** | видит объект по варианту перехода: «после Check Out» → старый до закрытия; «перенести смену» → сразу новый |
| **Отчёты** | исторические CSV/PDF не меняются; D3 (§N) — по заказчику |

---

## 4. Структурная история переходов (K)

`AssignmentTransition` (новая таблица, append-only, immutability-триггер):

| поле | тип | прим. |
|---|---|---|
| `id` | uuid PK | |
| `employeeId` | uuid FK Employee `onDelete: Restrict` | |
| `kind` | enum `AssignmentTransitionKind` | `CHANGE` \| `REMOVE` \| `SITE_FINISH` \| `CUSTOMER_DISABLE` \| `GROUP_CHANGE` |
| `fromAssignmentId` | uuid? FK SiteAssignment | |
| `toAssignmentId` | uuid? FK SiteAssignment | |
| `actedAt` | timestamptz(6) | точный момент действия админа |
| `effectiveFrom` | date | дата вступления |
| `openShiftHandling` | enum? | `AFTER_CHECK_OUT` \| `MOVED_TO_NEW` \| `NONE` |
| `actorUserId` | uuid FK User `onDelete: Restrict` | |
| `groupId` | uuid? | партия (M); одиночная операция — `NULL` |
| `reasonCode` | enum | `PROJECT_DONE` \| `TRANSFER` \| `ASSIGNED_BY_MISTAKE` \| `OTHER` |
| `reasonText` | text? | только при `OTHER` |
| `createdAt` | timestamptz(6) default now() | |

Индексы: `(employeeId, actedAt DESC)`, `(groupId)`, `(fromAssignmentId)`, `(toAssignmentId)`.
`AuditEvent` пишется **дополнительно** (не вместо).

Пометка в табеле (`getTimesheetCard`): по `AssignmentTransition` для работника с
`actedAt` или `effectiveFrom` в датах периода:
```
02.09.2026, 11:47: место работы изменено
Meyer Turku Shipyard → Meyer Turku Shipyard — Aros Marine
Изменил: Andrei
```

---

## 5. Схема миграции (additive, старые данные читаются)

### Миграция 1 — `add_assignment_lifecycle` (Deploy A)
```sql
-- 1. operational-лезвие
ALTER TABLE "SiteAssignment" ADD COLUMN "clockInDisabledAt" TIMESTAMPTZ(6);

-- backfill: уже исторически завершённые (validTo в прошлом Helsinki) — операционно закрыты
UPDATE "SiteAssignment"
SET "clockInDisabledAt" = ("validTo" + 1)::timestamp AT TIME ZONE 'Europe/Helsinki'
WHERE "validTo" IS NOT NULL
  AND "validTo" < (now() AT TIME ZONE 'Europe/Helsinki')::date
  AND "clockInDisabledAt" IS NULL;
-- назначения с validTo в будущем / NULL остаются clockInDisabledAt = NULL (операционно живы)

-- 2. статус объекта
ALTER TABLE "WorkSite" ADD COLUMN "finishedAt" TIMESTAMPTZ(6);
UPDATE "WorkSite" SET "finishedAt" = now() WHERE "active" = false AND "finishedAt" IS NULL;

-- 3. история переходов
CREATE TYPE "AssignmentTransitionKind" AS ENUM ('CHANGE','REMOVE','SITE_FINISH','CUSTOMER_DISABLE','GROUP_CHANGE');
CREATE TYPE "AssignmentTransitionOpenShift" AS ENUM ('AFTER_CHECK_OUT','MOVED_TO_NEW','NONE');
CREATE TYPE "AssignmentTransitionReason" AS ENUM ('PROJECT_DONE','TRANSFER','ASSIGNED_BY_MISTAKE','OTHER');
CREATE TABLE "AssignmentTransition" ( ...поля §4... );
-- FK, индексы, immutability-триггер fn_assignment_transition_immutable() (BEFORE UPDATE OR DELETE)
```
- **Не** трогает `validFrom`/`validTo` существующих строк.
- **Не** добавляет partial unique index на primary (ждёт исправления Nazar).
- `migrate deploy` дважды → второй проход no-op (стандартная проверка).

### Ручной шаг между Deploy A и D (owner-approved, read-only preflight + одна транзакция)
Владелец выбирает основное назначение Nazar Druz. Затем:
```sql
UPDATE "SiteAssignment" SET "isPrimary" = false, "version" = "version" + 1
WHERE id = '<не выбранное>' AND "employeeId" = '1f8b5243-...';
INSERT INTO "AssignmentTransition" (...kind=CHANGE, reasonCode=OTHER, reasonText='fix double primary'...);
```

### Миграция 2 — `add_one_live_primary_index` (Deploy D, после ручного шага)
```sql
CREATE UNIQUE INDEX "ux_site_assignment_one_live_primary"
  ON "SiteAssignment" ("employeeId")
  WHERE "isPrimary" = true AND "clockInDisabledAt" IS NULL;
```

---

## 6. Список файлов

### Новое
- `lib/assignment-lifecycle.ts` — единый сервис + `isAssignmentLiveNow` + `assignmentState`.
- `lib/assignment-transitions.ts` — запись/чтение `AssignmentTransition`.
- `app/api/admin/assignments/[assignmentId]/change/route.ts` — переписать на сервис (уже есть).
- `app/api/admin/assignments/[assignmentId]/remove/route.ts` — новый (замена смысла `/end`).
- `app/api/admin/assignments/change-preview/route.ts` — read-only резюме до подтверждения.
- `app/api/admin/sites/[siteId]/finish/route.ts` + `.../finish-preview` — завершение объекта.
- `app/api/admin/sites/[siteId]/work-areas/[workAreaId]/disable-preview` — preflight заказчика.
- `app/api/admin/assignments/group-change/route.ts` — M.
- `prisma/migrations/*_add_assignment_lifecycle/` и `*_add_one_live_primary_index/`.
- Компоненты карточки работника: `WorkplaceNowSection.tsx`, `ChangeWorkplaceForm.tsx` (замена
  `ChangeAssignmentAction`), `RemoveFromSiteAction.tsx` (замена `EndAssignmentAction` на карточке),
  `ScheduledChangesSection.tsx`, `PastAssignmentsSection.tsx`.
- Компоненты объекта/заказчика: `FinishSiteAction.tsx`, `DisableCustomerFlow.tsx`.
- Тесты: `_test-t9-assignment-lifecycle.ts` (матрица §7), плюс правки WA/CH блоков.

### Правки (единый гейт §2.2)
- `lib/workers.ts` (`currentAssignmentWhere` → `isAssignmentLiveNow`), `lib/worker-context.ts`,
  `lib/attendance-clock.ts` (`resolveActiveSiteAssignment`), `lib/attendance-sync.ts`,
  `lib/sites.ts` (`getSiteDetail`), `lib/attendance-overview.ts`, `lib/qualification-matrix.ts`,
  `lib/work-areas.ts` (`getWorkAreaDetail`).
- `lib/assignments.ts` (`createAssignment`/`createAssignmentInTx` — учитывать `finishedAt`,
  `clockInDisabledAt`), `app/api/admin/assignments/route.ts`, `.../[assignmentId]/route.ts`,
  `.../split/route.ts` (или пометить deprecated и убрать), `.../promote/route.ts`,
  `.../end/route.ts` (deprecate → `/remove`).
- `lib/admin-timesheets.ts` (`getTimesheetCard` — пометка перехода).
- Worker: `WorkerClockPanel.tsx`, `app/worker/*`, `lib/i18n/worker.ts` (уведомление о смене).
- `app/admin/workers/[employeeId]/page.tsx`, `app/admin/sites/[siteId]/page.tsx`,
  `app/admin/sites/[siteId]/SiteLifecycleAction.tsx`, `WorkAreaSection.tsx`.
- Права: `02_ROLE_PERMISSION_MATRIX.md` + seed — `assignment.remove` (= `assignment.end`),
  `site.finish` (= `site.update`), FOREMAN новых прав не получает.
- Контракты/доки: `04_ADMIN_FIRST_API_CONTRACTS.md` §6, `03_DATA_MODEL_ERD.md` §4.4,
  `05_RAW_SQL_REGISTER.md`, `/guide`, `FAQ_ADMIN_GUIDE_RU.md`, «Что нового».

---

## 7. Тестовая матрица (disposable PG16, обязательна до деплоя)

| # | сценарий | ожидание |
|---|---|---|
| 1 | Снять сейчас, открытой смены нет | `clockInDisabledAt=now`; исчез из Check In у всех потребителей; в «Прошлых» |
| 2 | Снять сейчас, открыта дневная смена | Check Out работает; после — в «Прошлых»; новый Check In нельзя |
| 3 | Снять, ночная смена через полночь | фрагменты обоих суток материализуются; `validTo` покрывает |
| 4 | После снятия — Check In на старый объект | резолв даёт «нет объекта» → отказ на выбор + при sync `STALE_ASSIGNMENT` |
| 5 | Check Out открытой смены после снятия | всегда 200 |
| 6 | Изменить только заказчика | график и `isPrimary` не изменились; действий работника нет |
| 7 | Перевести на другой объект, смены нет | старое `clockInDisabledAt=now`, новое live, планы перенесены |
| 8 | Перевод при открытой смене — оба варианта | `AFTER_CHECK_OUT` / `MOVED_TO_NEW`; таймер не рвётся |
| 9 | Назначение создано сегодня ошибочно, часов нет | in-place правка, 200, без «удалите и создайте» |
| 10 | Есть отмеченные часы | 409 `ASSIGNMENT_HAS_RECORDED_TIME` **или** структурный переход + пометка; история цела |
| 11 | Сданный / FINAL_APPROVED табель | не переписывается, 409 |
| 12 | Будущий перевод виден в карточке | блок «Запланированные изменения» |
| 13 | Будущий перевод вступает по Europe/Helsinki | в `effectiveInstant` старое не live, новое live |
| 14 | Офлайн Check In со старым snapshot | не теряется, `STALE_ASSIGNMENT`, не перепривязан молча |
| 15 | Завершить объект без работников | сразу «Завершён» |
| 16 | Завершить объект с назначенными | все `clockInDisabledAt=now`, planы удалены, «Завершён» |
| 17 | Завершить объект с открытыми сменами | «Завершается» → после Check Out «Завершён»; смены не оборваны |
| 18 | Восстановить объект | назначения не воскресли; явное сообщение |
| 19 | Отключить заказчика с работниками | без явного решения — отказ; 4 варианта работают |
| 20 | Ровно одно основное | partial unique index + сервис; попытка второго → демоут прежнего |
| 21 | Двойной клик / retry | Idempotency-Key/frozen-attempt → один переход |
| 22 | Два админа одновременно на одного работника | advisory-lock → один успех, второй 409 + refresh |
| 23 | GPS геозона при смене заказчика | не меняется |
| 24 | Прораб видит объект по варианту перехода | `AFTER_CHECK_OUT` → старый до закрытия; `MOVED_TO_NEW` → новый |
| 25 | Старые отчёты / CSV | без изменений |
| 26 | Групповой перевод: все успешно | одна транзакция, один `groupId` |
| 27 | Групповой перевод: один с конфликтом | UI заранее показал пропуск, либо вся партия откат |
| 28 | Mobile 390×844: клавиатура, focus, aria-live, без overflow | ок |
| 29 | RU / EN | все строки |
| 30 | Restart / cold restart persistence | `clockInDisabledAt`, `AssignmentTransition` переживают |

Плюс регресс: `_test-t9-setup-lifecycle` (WA/CH), `_test-t9-full-flow`, `_test-t9-role-matrix`,
`_test-t9-setup-ui`, `_test-worker-clock-panel`, `_test-t9-restart-persistence`,
`_test-pilot-pair-orphan`, offline-тесты.

---

## 8. Разбиение на безопасные деплои

| deploy | содержание | миграция | риск |
|---|---|---|---|
| **A. Фундамент** | Миграция 1; `lib/assignment-lifecycle.ts` + единый гейт §2.2 во всех потребителях; `/change`, `/end→/remove`, `/promote` через сервис; `AssignmentTransition` пишется; C8 проверка `Employment.active` в Check In. **UI прежний**, работает поверх сервиса. | да (additive) | **средний** — трогает clock-путь; полная матрица + backup-restore обязательны |
| **B. Карточка работника** | «Место работы сейчас», «Изменить место работы» (одна форма + резюме), «Снять с объекта» (пресеты причин), «Запланированные изменения», «Прошлые назначения»; open-shift модалка переформулирована; уведомление работнику; пометка перехода в табеле. | нет | низкий (UI + чтение) |
| **C. Объект / заказчик** | preflight + `finishSite` («Завершается/Завершён») + `reopenSite`; `disableCustomer` с явным решением; серверные запреты L (закрытый объект / отключённый заказчик). | нет (колонка `finishedAt` уже в Миграции 1) | низкий |
| **D. Основное назначение** | ручной fix Nazar (owner picks) → Миграция 2 (partial unique index); `/change` и `assignSite` больше не могут создать второе live-primary. | да (index) | низкий (после fix данных) |
| **E. Групповой перевод** | `groupChange` через тот же сервис; preflight-разбивка (готовы / работают / сданные часы / уже запланирован); `groupId`. | нет | низкий |
| **F. D3 — отчёт «Часы заказчику»** | объект / заказчик / несколько / без заказчика; PDF+CSV; исторические часы у прежнего заказчика. | нет | низкий |

Порядок обязателен: A → B → C → D → E → F. Групповой перевод (E) и D3 (F) — **только** после A–D.

Каждый деплой: disposable PG16 → migrate deploy ×2 → restore production backup в disposable →
полный browser lane → кандидат на отдельном порту → **verified on-box + off-box backup** →
**отдельное подтверждение владельца перед миграцией и деплоем** → web-only swap → rollback-образ
сохранён. Никаких write-smoke в настоящую prod БД (правило после инцидента 2026-09-02).

---

## 9. Открытые вопросы для владельца

1. **Nazar Druz — какое назначение основное:** `3d95975f` (Meyer Turku Shipyard, без заказчика)
   или `c6825d98` (Meyer Turku Shipyard — Aros Marine)?
2. **§3.5 «есть фактические часы» при смене:** предпочтителен (а) жёсткий 409 «поправьте табель»
   или (б) автоматический структурный переход с пометкой (история не переписывается, но операция
   проходит)?
3. **§3.1 `validTo` при немедленном снятии:** ставить `validTo = today` (payroll-рубеж = сегодня)
   — согласны? Влияет на то, за какие даты по назначению вообще могут появиться часы.
4. **Ночная смена (§3.2):** «Снять после текущего Check Out» — единственный вариант при открытой
   смене, «снять прямо посреди смены» не предлагаем. Ок?
5. **Разбиение на 6 деплоев** вместо «foundation / карточка / объект-заказчик / группа / D3» —
   D добавлен отдельно из-за индекса основного. Приемлемо?
