# R15-D7 — Deploy A («Фундамент»): отчёт перед production

**Статус:** ✅ **РАЗВЁРНУТО НА PRODUCTION 2026-09-02 ~17:29 UTC** (`titanor-time-app:d7a-37dddb1`,
миграция 99, простой ~9 c). Владелец подтвердил «делай по запланированному плану». Итог — §12.

Ветка `feature/titanor-time-foundation`, коммиты:
`c41938d` (design) → `27631d9` (§9) → `99ed01b` (A1 миграция) → `aacd5fe` (A2 единый гейт) →
`37dddb1` (A3+A4 сервис + clock-путь) → `7424ee2` (A5 тест).

Прод сейчас: `customer-page-5381b9f`. Кандидат-образ: `titanor-time-app:d7a-37dddb1`.

---

## 1. Что входит в Deploy A (по design §8)

| # | Содержание | Готово |
|---|---|---|
| A1 | Миграция `20260902160000_add_assignment_lifecycle` (additive) | ✅ |
| A2 | `lib/assignment-lifecycle.ts` — **единственное** определение «действующего назначения» (§2.2); переписаны все потребители | ✅ |
| A3 | `lib/assignment-lifecycle-service.ts` — единый писатель; `/change`, `/end`+`/remove`, `/promote` через сервис; `AssignmentTransition` пишется; C8 (`Employment.active` в Check In) | ✅ |
| A4 | Новый шаг в транзакции Check Out (§3.12) — продление `validTo` до даты завершения ночной смены | ✅ |
| A5 | Disposable-тест `_test-t9-assignment-lifecycle.ts` (матрица §7, Deploy-A-срез) | ✅ |
| — | **UI не меняется.** Карточка работника, страница объекта, приложение работника — прежние, работают поверх сервиса | ✅ |

---

## 2. Миграция 1 — `add_assignment_lifecycle` (additive, старые данные читаются)

**Структурная часть (Section A):**
- `SiteAssignment.clockInDisabledAt TIMESTAMPTZ(6)` NULL — точный момент операционного запрета Check In;
- `WorkSite.finishedAt TIMESTAMPTZ(6)` NULL — для Deploy C (в Deploy A только колонка, кода нет);
- 3 enum: `AssignmentTransitionKind` / `AssignmentTransitionOpenShift` / `AssignmentTransitionReason`;
- таблица `AssignmentTransition` (append-only) + 4 индекса + 4 FK (`onDelete: Restrict`);
- индекс `SiteAssignment_employeeId_clockInDisabledAt_idx`;
- **partial unique index на primary НЕ добавляется** — ждёт ручного исправления Nazar (Deploy D).

**Backfill (Section B, идемпотентный — guarded `IS NULL`):**
- `clockInDisabledAt` = `(validTo + 1) 00:00 Europe/Helsinki` для назначений с `validTo` в прошлом
  (историчеcки завершённые = операционно закрыты); `validTo` в будущем/NULL → остаётся NULL;
- `WorkSite.finishedAt = now()` для `active = false`.

**Иммутабельность:** триггер `fn_assignment_transition_immutable()` — `BEFORE UPDATE OR DELETE` на
`AssignmentTransition` → `RAISE EXCEPTION` (P0001).

**Что НЕ трогается:** `validFrom` / `validTo` существующих строк, любые часы, история, `AuditEvent`.

**Проверено на disposable PG16:**
- `migrate deploy` ×2 — второй проход no-op;
- backfill: `validTo` 2020 → `clockInDisabledAt = 2020-07-01 21:00+00`; `validTo` 2099 → NULL;
  `validTo = today` → NULL; `validTo` NULL → NULL; closed site → `finishedAt`;
- immutability-триггер отклоняет и UPDATE, и DELETE;
- та же миграция чисто применяется `migrate deploy` внутри сборки релиз-образа.

---

## 3. Единый гейт (A2) — «одно определение действующего назначения»

`lib/assignment-lifecycle.ts`:
```
live = validFrom <= todayHelsinki
       AND (validTo IS NULL OR validTo >= todayHelsinki)          -- календарь/табель
       AND (clockInDisabledAt IS NULL OR clockInDisabledAt > now) -- операционный Check-In гейт
```
`liveAssignmentWhere()` (Prisma-фрагмент) + `isAssignmentLiveNow()` (in-memory) — одна логика.

Переписаны **все** потребители «текущего назначения» (больше нет копий `validTo > / >= today`):
`workers.ts` (карточка + список), `worker-context.ts` (варианты Check In в приложении),
`attendance-clock.ts` `resolveActiveSiteAssignment` (резолвит по состоянию **на момент события**
`instant` — офлайн-safe), `attendance-sync.ts`, `sites.ts` (страница объекта), `attendance-overview.ts`
(«Сегодня»), `qualification-matrix.ts`, `work-areas.ts` (страница заказчика).

Материализатор и исторические отчёты **намеренно НЕ используют** этот гейт — атрибутируют по календарной дате.

---

## 4. Единый сервис (A3) — `lib/assignment-lifecycle-service.ts`

Единственный писатель `SiteAssignment` + `AssignmentTransition` для lifecycle-операций. Каждая
операция: `pg_advisory_xact_lock(hashtext('titanor_time:assignment_lifecycle:<employeeId>'))`
(**один общий ключ** для remove/change/promote — два админа на одного работника сериализуются) →
проверки → мутация → чистка черновых плановых смен → re-point `EmployeeOpenShift` (при переносе
смены) → `INSERT AssignmentTransition` → `createAuditEvent` — **одна транзакция**.

| Функция | Семантика | Роут |
|---|---|---|
| `removeFromSite` | §3.1/§3.2 — `validTo` = выбранная дата, `clockInDisabledAt = now()`, удалить будущие черновые плановые смены. Идемпотентна под локом (повторный клик не пишет второй переход). Отмеченные/сданные часы после даты → 409 (контракт прежний). | `/end` **и** `/remove` |
| `changeWorkplace` | §3.3/§3.5 — закрыть старое (`validTo = effectiveFrom−1`, + `clockInDisabledAt` при немедленном изменении), открыть материализованную замену, перенести смену при `MOVE_TO_NEW`. Будущее изменение: `clockInDisabledAt` не ставится — календарная граница уже передаёт корректно. | `/change` |
| `promoteToPrimary` | §3.6 — демоутит все другие **операционно-живые** primary (единый гейт) в той же транзакции. Снятое назначение — не демоутится и не может быть повышено (409). | `/promote` |

Роуты теперь делают только HTTP/auth/валидацию.

**`/remove`** — новый роут, в Deploy A **байт-в-байт** как `/end` (то же тело `{ validTo, reason? }`,
тот же вызов сервиса). Deploy B добавит пресеты причин и перенаправит UI карточки с `/end` на `/remove`.

---

## 5. C8 — деактивированный работник не начинает новую смену (A3)

**Дыра, которую закрываем:** `deactivate` при незавершённых расчётных данных ставит
`User.status = OFFBOARDING` (не `DEACTIVATED`) и **не рвёт сессию** — чтобы работник мог сдать
последний табель. Но путь Check In не проверял `Employment.active` → такой работник мог открыть
реальную смену.

**Фикс (`attendance-clock.ts` `checkInCore`, только путь новой смены):** если последнее
`Employment.active = false` — сырой `ClockEvent` **всё равно записывается** (`processingState =
NEEDS_REVIEW`, `sourceAssignmentId = null`, T7A_1 §9.1 «факт не теряется»), ставится
`AttendanceException(STALE_ASSIGNMENT, detail.reason = 'EMPLOYMENT_INACTIVE')`, аудит
`CLOCK_CHECK_IN_REJECTED_INACTIVE` — но **`EmployeeOpenShift` не создаётся**. Check Out открытой
смены не трогается (доступен всегда).

Крайний случай: деактивированный работник на «switch-site» — старая смена закрывается, новая не
открывается, ставится review-флаг. Приемлемо (он снят с работы); задокументировано.

---

## 6. A4 — новый шаг в транзакции Check Out (§3.12)

После `DELETE EmployeeOpenShift`, в **той же транзакции**: если назначение из снимка открытой смены
имеет `clockInDisabledAt <= now` (работника сняли во время смены) **и** смена закрылась на более
позднюю календарную дату (ночная смена через полночь) → `validTo` продлевается до локальной даты
Check Out (расширение диапазона безопасно под TRG-11), будущие черновые плановые смены удаляются.
Pre-check по EX-02 гарантирует, что Check Out **никогда не блокируется** (§9.2). Единственная
правка clock-пути в D7.

---

## 7. Disposable-тесты (PG16, образ `d7a-37dddb1`, `run-browser-acceptance.sh`)

| Тест | Было (A2 один) | Стало (A1+A2+A3+A4) |
|---|---|---|
| `_test-t9-assignment-lifecycle` (**новый**, 37 проверок) | — | **37 / 37** |
| `_test-t9-setup-lifecycle` | 105 / 108 | **108 / 108** |
| `_test-t9-full-flow` (полный clock→табель→approval) | 84 / 84 | **84 / 84** |
| `_test-t9-setup-ui` | 26 / 26 | **26 / 26** |
| `_test-t9-role-matrix` | 33 / 33 | **33 / 33** |
| `unit` lane (17 тестов, вкл. `_test-worker-clock-panel`) | — | **17 / 17** |
| `_test-t9-restart-persistence` (prepare + `docker restart` + verify) | — | **prepare 5/5 · verify 18/18** — `clockInDisabledAt`, `AssignmentTransition`, FINAL_APPROVED табель и 2 иммутабельные версии переживают рестарт |

3 падения A2-в-одиночку (WA6b/6c/11) — это проверки «снятие сегодня → сразу уходит из вида админа»
из `f2c5e57`; они зелёные снова, потому что `/end` теперь ставит `clockInDisabledAt`. **Никаких
неожиданных регрессий.**

Новый тест покрывает Deploy-A-срез матрицы §7: L1 немедленное снятие, L2 идемпотентность
(повторный клик), L3 роут `/remove`, L4 немедленный перевод, L5 будущий перевод (календарная
передача), L6 единственный live-primary + снятое не повышается (409), **L7 C8** (деактивированный:
Check In 201, но без открытой смены + NEEDS_REVIEW + STALE_ASSIGNMENT/EMPLOYMENT_INACTIVE),
L8 снятие во время открытой смены (смена не рвётся, Check Out закрывает).

---

## 8. Файлы

**Новое:** `lib/assignment-lifecycle-service.ts`, `lib/assignment-transitions.ts`,
`app/api/admin/assignments/[assignmentId]/remove/route.ts`,
`scripts/_test-t9-assignment-lifecycle.ts`,
`prisma/migrations/20260902160000_add_assignment_lifecycle/`.

**Правки:** `prisma/schema.prisma`, `lib/generated/migration-inventory.ts`,
`lib/assignment-lifecycle.ts` (создан в A2), `lib/{workers,worker-context,attendance-clock,attendance-sync,sites,attendance-overview,qualification-matrix,work-areas}.ts`,
`app/api/admin/assignments/[assignmentId]/{change,end,promote}/route.ts`,
`scripts/test-manifest.json`.

**Не тронуто:** scheduler, публичный сайт, Caddy/DNS, любые UI-компоненты, пароли/аккаунты.

---

## 9. Что НЕ входит в Deploy A (следующие этапы)

- **B:** новая карточка работника (одна форма «Изменить место работы» + резюме, «Снять» с
  пресетами причин, «Запланированные изменения» / «Прошлые назначения»), переформулировка
  open-shift модалки, уведомление работнику, пометка перехода в табеле; §3.4 in-place правка
  ошибочного назначения.
- **C:** `finishSite` / `reopenSite`, `disableCustomer`, серверные запреты L (закрытый объект /
  отключённый заказчик отклоняются даже прямым API).
- **D:** ручное исправление двойного primary у Nazar Druz (backup + read-only preflight + отдельное
  prod-разрешение) → Миграция 2 (partial unique index).
- **E:** групповой перевод. **F:** отчёт «Часы заказчику».

---

## 10. План production-деплоя (после подтверждения владельца)

1. **Подтверждение №1 — миграция.** Restore свежего production-бэкапа в disposable DB →
   `migrate deploy` ×2 (второй no-op) → полный browser lane на восстановленных данных.
2. Собрать/подтвердить образ `d7a-37dddb1`; кандидат на `127.0.0.1:3198` против prod-схемы
   (read-only smoke). **Никаких write-smoke в prod DB** (правило после инцидента 2026-09-02).
3. `backup-titanor-time.sh pre-deploy` (verified on-box + off-box SHA256SUMS).
4. **Подтверждение №2 — деплой.** `docker exec titanor-time-prod-app … migrate deploy` (миграция
   additive, применяется до swap) → web-only swap (`docker stop` / `rename …-pre-<sha>` /
   `docker run` новый, ~4 c; **scheduler не трогается**).
5. Проверка `/api/ready` (`schema:current`, 100/100), smoke карточки работника + `/end` + `/change`.
6. Сохранить `titanor-time-prod-app-pre-<sha>` + pre-deploy бэкап как rollback.

Caddy/DNS/scheduler/публичный сайт — без изменений.

---

## 11. Шаг 1 выполнен — verification на восстановленном production backup (2026-09-02)

**Production не изменялся.** Только read-only `pg_dump` + disposable-контейнеры.

### 11.1 Свежий backup
`production-20260902T162950Z-pre-migration` — 2128 строк, 98 миграций, dump 532 KB, off-box
mirror OK (`/mnt/250gb/...`), SHA256SUMS проверены.
- `restore-test-titanor-time.sh`: **13/14 PASS**. Единственный «FAIL» — smoke `/api/ready = 503
  SCHEMA_BEHIND`: **это правильно** — D7-образ отказывается обслуживать БД со схемой 98, пока не
  применена миграция 99 (readiness-гейт работает как задумано). Все проверки паритета
  (миграции, структура, построчные count'ы всех 74 таблиц, all-data SHA-256, uploads) — идентичны.

### 11.2 `migrate deploy` ×2 на реальных данных
| | до | после |
|---|---|---|
| миграции | 98 | **99** (unfinished/rolledback: 0) |
| таблицы | 74 | **75** (`AssignmentTransition`) |
| триггеры | 40 | **41** (`trg_assignment_transition_immutable`) |
| FK | 178 | **182** |

- pass 1: применена `20260902160000_add_assignment_lifecycle`, rc 0.
- pass 2: `No pending migrations to apply`, rc 0 — **точный no-op**.
- Кандидат-образ на восстановленной+мигрированной БД: `/api/ready` = **200**,
  `schema: current, migrations 99/99, aheadBy 0`.

### 11.3 Backfill на реальных данных
- **`SiteAssignment.clockInDisabledAt`**: 14 строк — 12 с `validTo IS NULL`, 2 с `validTo` в
  будущем/сегодня, **0 исторически завершённых** → backfill ничего не выставил (это норма: на
  проде пока нет назначений с `validTo` в прошлом). Оба инварианта = 0
  (нет «set, но всё ещё live»; нет «в прошлом, но не backfill'нуто»).
- **`WorkSite.finishedAt`**: 3 объекта, все активны, 0 завершённых → backfill ничего не выставил.
  `active AND finishedAt IS NOT NULL` = 0.
- `AssignmentTransition` — пустая (свежая таблица). `validTo < validFrom` — 0. Открытых смен — 0.

### 11.4 РАСХОЖДЕНИЕ на реальных данных — **два двойных основных назначения, не одно**

Design §3.6 / owner Q1 знал только про **Nazar Druz**. Скан реальных данных нашёл **второго**:

| Работник | Назначение | Объект — Заказчик | validFrom | validTo | isPrimary |
|---|---|---|---|---|---|
| **Nazar Druz #1002** | `3d95975f` | Meyer Turku — (без заказчика) | 2026-08-26 | **2026-09-02** | **true** |
| | `c6825d98` | Meyer Turku — **Aros Marine** | 2026-09-02 | (нет) | **true** |
| **Mykhailo Sadovnikov #1004** | `cbf688b7` | Meyer Turku — (без заказчика) | 2026-08-26 | **(нет)** | **true** |
| | `bc174aef` | Meyer Turku — **Aros Marine** | 2026-09-02 | (нет) | **true** |

- Nazar: старое `3d95975f` уже заканчивается **сегодня** (кто-то его закрыл после отката инцидента,
  но `isPrimary` не снял). Owner Q1 уже решил: основное = `c6825d98`, с `3d95975f` снять `isPrimary`.
- **Mykhailo #1004 — новый случай:** оба назначения **открытые** (validTo нет), пересекаются, оба
  `isPrimary`. Похоже, назначение на «Aros Marine» создали сегодня в 16:21 как `isPrimary=true`,
  не сняв/не завершив старое «без заказчика». **Нужно решение владельца** — какое основное
  (вероятно `bc174aef` — Meyer — Aros Marine, по аналогии с Nazar) и что делать со старым
  `cbf688b7` (снять `isPrimary` / завершить).
- **Не блокирует Deploy A** — partial unique index на primary добавляет только Deploy D. Но
  **Deploy D теперь = 2 ручных исправления, не одно**, и владельцу нужно выбрать основное для
  Mykhailo так же, как он выбрал для Nazar.
- Косметический эффект Deploy A: сегодня Nazar в карточке/списке админа покажет 2 текущих
  назначения (оба со «звездой» основного) вместо 1 — потому что новый гейт `validTo >= today`
  (календарная граница), а `3d95975f` ещё не имеет `clockInDisabledAt`. Само собой исчезнет
  завтра (`validTo < today`). На часы/клок работника не влияет. Mykhailo и сейчас, и после
  показывает 2 (оба открытые).

### 11.5 Кандидат-приложение на реальных данных
Кандидат-образ поднят против восстановленной+мигрированной БД (с реальными prod-ключами
шифрования, БД disposable). Сессия реального ACTIVE-админа. Все реальные страницы админки
отдают **200** на настоящих данных:
`/api/admin/workers` (11 работников, поле `currentAssignments` присутствует), реальная карточка
работника (39 KB), `/admin/workers`, `/admin/sites`, реальная страница объекта, реальная страница
заказчика, `/api/admin/assignments`. Ошибок в логе старта нет.

### 11.6 Ответы на вопросы владельца

**1. Все ли тесты зелёные?** Да.
- disposable (чистая схема): `_test-t9-assignment-lifecycle` 37/37, `_test-t9-setup-lifecycle`
  108/108, `_test-t9-full-flow` 84/84, `_test-t9-setup-ui` 26/26, `_test-t9-role-matrix` 33/33,
  unit 17/17, restart-persistence prepare 5/5 + verify 18/18.
- на реальных данных: restore-test паритет 13/13 (+1 «ожидаемый» 503 SCHEMA_BEHIND до миграции),
  `migrate deploy` ×2 чисто (pass2 no-op), `/api/ready` 200 schema current, все реальные страницы
  админки 200.
- Полный browser-lane T9 намеренно **не** гоняется дословно на восстановленных prod-данных:
  фикстуры этих тестов создают «первого» SUPER_ADMIN (`bootstrapSuperAdmin` бросает исключение,
  если активный супер-админ уже есть) и содержат проверки «пустой БД» — на населённой БД это
  артефакты данных, а не регрессии. Поэтому: browser-lane = чистая схема (зелёный), а на реальных
  данных — прямой прогон приложения против восстановленной БД (см. 11.5).

**2. Расхождения на реальных данных?** Одно (см. 11.4): **два** двойных основных назначения
(Nazar #1002 + Mykhailo #1004), а не одно. Deploy D должен исправить оба; для Mykhailo нужен
выбор владельца. Всё остальное — чисто (backfill 0 строк потому что нет исторических данных;
инварианты держатся; миграция additive применяется без ошибок).

**3. План rollback Deploy A.**
Миграция **additive** — новый nullable-столбец (metadata-only ALTER, без переписывания таблицы),
новая таблица, новые enum, backfill 0 строк. Ничего существующего не меняется и не удаляется.
- **Основной rollback = откат образа**, ~4 c: `docker stop titanor-time-prod-app` →
  `docker rename` назад → запустить `titanor-time-prod-app-pre-<sha>` (образ
  `customer-page-5381b9f`). **Схему откатывать НЕ нужно**: readiness-гейт старого образа имеет
  состояние `ahead` (`ok: true`) — старый код корректно работает с БД, где на 1 миграцию больше
  (лишний столбец/таблицу Prisma просто игнорирует). Проверено: `checkSchemaReadiness` →
  `state: 'ahead'`, `/api/ready` 200.
- Rollback-образ и `-pre-<sha>` контейнер сохраняются; сохраняются backup'ы
  `production-20260902T162950Z-pre-migration` (on+off-box) и `pre-deploy` перед swap.
- Полный откат схемы (не потребуется для additive) — только как крайняя мера: restore
  `pre-migration` backup (теряет записи после бэкапа). Держим как последний резерв.
- scheduler не трогается — откатывать нечего.

**4. Сколько займёт сам Deploy A.**
- `prisma migrate deploy` на проде: 2× `ADD COLUMN` (metadata-only, без table rewrite), 3× `CREATE
  TYPE`, 1× `CREATE TABLE` + 4 индекса + 4 FK, 2 backfill-`UPDATE` (на проде **0 строк** под
  условие), 1 функция + 1 триггер. На 2128 строках — **~1–2 секунды**. Старый образ продолжает
  обслуживать во время миграции (`ahead` = ok).
- Web-only swap: `docker stop -t 30` (in-flight завершаются за ~1–3 c) + `rename` + `docker run`
  новый + healthcheck. **~5–15 секунд 503** на `app.titanorgroup.fi` — один swap, как в D2–D6b.
- scheduler не трогается. Caddy/DNS не трогаются.
- **Итого видимой недоступности: ~10–15 секунд** (один swap); миграция недоступности почти не
  добавляет.

---

## 12. Production-деплой — ВЫПОЛНЕН 2026-09-02 (~17:26–17:29 UTC)

Владелец: «давай делай по запланированному плану, даю разрешение». Выполнено ровно по §10.
**Caddy/DNS/scheduler не трогались. Пароли/аккаунты не трогались. В логи/чат секреты не выводились.**

| шаг | факт |
|---|---|
| A. backup | `production-20260902T172647Z-pre-deploy` — 2128 строк, 98 миграций, dump 532 KB. on-box **и** off-box SHA256SUMS проверены (`sha256sum -c` OK). Плюс более ранний `production-20260902T162950Z-pre-migration`. |
| B. baseline | prod `/api/ready` 200 schema 98/98; DB: 98 миграций (0 bad), 74 таблицы, 40 триггеров, 178 FK, 14 SiteAssignment. Публичный сайт 200. |
| C. `migrate deploy` | throwaway-контейнер из `d7a-37dddb1` на `titanor-time-prod-net` → применена `20260902160000_add_assignment_lifecycle`. Старый образ продолжал обслуживать (`/api/ready` 200, `schema: ahead, aheadBy 1`). |
| D. verify migration | 99 миграций (0 bad), 75 таблиц, 41 триггер (`trg_assignment_transition_immutable`), 182 FK. **backfill: `clockInDisabledAt` — 0 строк, `finishedAt` — 0 строк** (нет исторических данных — как и предсказано). `AssignmentTransition` пуста. pass 2 = `No pending migrations`. Scheduler running+healthy, не тронут. |
| E. web-only swap | `docker stop -t 30` (T0 17:29:05.6) → `rename` → `titanor-time-prod-app-pre-37dddb1` → `docker run` новый `d7a-37dddb1` (T2 17:29:06.3, идентичная конфигурация: net `titanor-time-prod-net`, `-p 127.0.0.1:3199:3000`, uploads-bind, `--env-file`, тот же healthcheck, `--restart unless-stopped`). |
| F. verify | `/api/ready` = **200 `schema: current 99/99 aheadBy 0`** в 17:29:14.4 (**простой ≈ 8.8 с**). Локально и **через Caddy `https://app.titanorgroup.fi/api/ready` → 200**. `/login` 200, `/` 307, `/api/admin/workers` 401 (без авторизации — верно). Логи старта чисты (0 error-строк). Scheduler + публичный сайт не затронуты. |

**Rollback (если понадобится):** `docker stop titanor-time-prod-app && docker rename titanor-time-prod-app titanor-time-prod-app-d7-failed && docker rename titanor-time-prod-app-pre-37dddb1 titanor-time-prod-app && docker start titanor-time-prod-app` (~4 c). **Схему НЕ откатывать** — старый образ `customer-page-5381b9f` корректно работает с миграцией 99 (`schema: ahead`, проверено вживую до swap). Хранятся: контейнер `titanor-time-prod-app-pre-37dddb1`, образ `customer-page-5381b9f` (`sha256:798f31eb…`), backup'ы `pre-deploy` + `pre-migration` (on+off-box).

**Ветка:** HEAD `68b355c` (+ этот коммит). Развёрнутый код = `37dddb1` (A1+A2+A3+A4); `7424ee2`/`9bc8d7f`/`68b355c` — только тесты и документация, в образе не нужны.

### Осталось (не Deploy A)
- **Deploy D теперь = 2 ручных исправления** двойного основного назначения — Nazar Druz #1002
  (owner Q1: основное `c6825d98`) **и** Mykhailo Sadovnikov #1004 (owner: основное `bc174aef`),
  затем Миграция 2 (GiST EXCLUDE `ex_site_assignment_one_primary_per_period` — «≤1 live primary на
  пересекающийся период»). Двухфазный rollout D1/D2 — см. `R15_D7_DEPLOY_D_REPORT_RU.md`.
- Deploy B (карточка работника + пресеты причин + пометка перехода в табеле), C (завершение
  объекта/заказчика + серверные запреты L), E (групповой перевод), F (отчёт «Часы заказчику»).
- Косметика: сегодня Nazar покажет в карточке 2 текущих назначения (новый гейт `validTo >= today`);
  само исчезнет завтра.
