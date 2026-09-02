# R15-D7 — Deploy A («Фундамент»): отчёт перед production

**Статус:** реализация и disposable-тесты завершены. **Production не изменялся.** Ждёт отдельного
подтверждения владельца на (1) миграцию и (2) деплой.

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
