# R15-D7 — Deploy E («Групповой перевод работников»): отчёт

**Статус:** разработка + disposable-тесты завершены. **Production не изменялся.** Ждёт отдельного
разрешения владельца. Deploy F не начат.

Ветка `feature/titanor-time-foundation`, коммит **`3b75c98`**. Образ `titanor-time-app:d7e-3b75c98`.
**Миграции нет.** Схема остаётся **100**.

---

## 1. Что вошло (по design §M / §8-E)

| Требование | Как сделано |
|---|---|
| Preflight-разбивка (готовы / уже запланирован / есть часы) | `GET /api/admin/assignments/group-change?sourceSiteId=…&sourceWorkAreaId=…&effectiveFrom=…&isPrimary=…` — по каждому живому назначению объекта (или одного заказчика) статус **`READY`** / **`HAS_HOURS_AFTER`** (есть записанные/сданные часы на дату перевода или позже) / **`ALREADY_SCHEDULED`** (назначение уже завершается раньше даты перевода — его уже кто-то запланировал — или пересекающийся запланированный будущий primary). |
| Одна транзакция, один `groupId` (тест 26) | `POST /api/admin/assignments/group-change` — все выбранные переводятся в **одной** транзакции; на каждого — `AssignmentTransition` (kind `GROUP_CHANGE`, общий `groupId`); на всю партию — **один** `AuditEvent` `ASSIGNMENT_GROUP_CHANGED`. Пер-работниковые advisory-lock'и берутся в порядке `employeeId` (без дедлока). |
| Конфликт у одного (тест 27) | UI заранее исключает не-`READY`. Если на исполнении кто-то всё же конфликтует → **вся партия откатывается**, 409 `BATCH_CONFLICT` с `employeeId` / `assignmentId` / `conflict` (какой именно конфликт). Ничего частично не применяется. |
| Только будущая дата | групповой перевод всегда планируется: `effectiveFrom` **> сегодня**, иначе 400 `EFFECTIVE_FROM_NOT_FUTURE`. Каждое старое назначение сохраняет `isPrimary` над своим прошлым периодом; новое — живое с `effectiveFrom` (календарный переход, без cron). |
| Серверные запреты L | целевой объект `finishedAt`/`active=false` → 409 `SITE_FINISHED`; целевой заказчик `active=false` → 409 `CUSTOMER_DISABLED` (проверка и в роуте, и внутри сервиса через `createAssignmentInTx`). |
| Права | `assignment.split` (как у `/change`). `FOREMAN` новых прав не получает. |
| UI | секция **«Групповой перевод»** на странице объекта (`/admin/sites/[siteId]`): источник (весь объект / один заказчик) → объект · заказчик · график · «основное» · дата → список работников (`READY` предвыбраны, остальные серые с причиной) → «Перевести N». Видна только для активного объекта с работниками. `DisableCustomerFlow` (Deploy C) теперь ссылается на неё. |

---

## 2. Изменённые / новые файлы

**Новое:**
- `app/api/admin/assignments/group-change/route.ts` — GET preflight + POST.
- `app/admin/sites/[siteId]/GroupTransferFlow.tsx`.
- `scripts/_test-t9-group-transfer.ts` — disposable-тест E1..E4.

**Правки:**
- `lib/assignment-lifecycle-service.ts` — **`changeWorkplace` разбита**: `changeWorkplaceInTx(tx, input, {kind, groupId, skipAudit})` — транзакционное ядро (для батча), `changeWorkplace` — тонкая обёртка `prisma.$transaction(tx => changeWorkplaceInTx(tx, input))` + `mapChangeWorkplaceError`. Новые `groupChangeWorkplacePreview` / `groupChangeWorkplace`.
- `lib/api-error.ts` — `employeeId` / `assignmentId` / `conflict` в `ApiErrorBody` (для `BATCH_CONFLICT`).
- `app/admin/sites/[siteId]/page.tsx` — секция `GroupTransferFlow`.
- `app/admin/work-areas/[workAreaId]/DisableCustomerFlow.tsx` — ссылка на групповой перевод.

**Поведение `changeWorkplace` не изменилось** — тот же результат, тот же error-mapping; проверено регрессией `_test-t9-assignment-lifecycle` (118/118) и `_test-t9-worker-card-b` (34/34).

---

## 3. Disposable-проверка (образ `d7e-3b75c98`, чистый PG16)

| Тест | Combined (`d7e-3b75c98`) | Baseline (Deploy C) |
|---|---|---|
| `_test-t9-group-transfer` (**новый**, E1–E4) | **16 / 16** | — |
| `_test-t9-site-lifecycle` | **38 / 38** | 38 / 38 |
| `_test-t9-assignment-lifecycle` | **118 / 118** | 118 / 118 |
| `_test-t9-setup-lifecycle` | **113 / 113** | 113 / 113 |
| `_test-t9-worker-card-b` | **34 / 34** | 34 / 34 |
| `_test-t9-full-flow` | **84 / 84** | 84 / 84 |
| `_test-t9-setup-ui` | **26 / 26** | 26 / 26 |
| `_test-t9-role-matrix` | **33 / 33** | 33 / 33 |
| unit lane | **18 / 18** | 18 / 18 |

**Все существующие цифры совпадают с baseline + 16 новых.** tsc + lint + `next build` — чисто.
Разбиение `changeWorkplace` на `changeWorkplaceInTx` регрессий не дало (assignment-lifecycle 118,
worker-card-b 34 без изменений).

### E1–E4 — что проверено
- **E1**: preflight считает 3 работников, 2 `READY` + 1 `ALREADY_SCHEDULED` (у него уже есть
  запланированный перевод), `readyCount=2`; `effectiveFrom=сегодня` → 400; источник, суженный до
  одного заказчика → только его 2 работника.
- **E2**: перевод 2 `READY` → 200; старые строки закрыты до `effectiveFrom`, **сохраняют
  `isPrimary`**, **без `clockInDisabledAt`** (будущий перевод); у каждого новое живое primary на
  целевом объекте+заказчике с `effectiveFrom`; 2 `GROUP_CHANGE` transition с общим `groupId`;
  **ровно один** `ASSIGNMENT_GROUP_CHANGED` audit; **до `effectiveFrom` «основной сейчас» = старый
  объект** (календарный переход).
- **E3**: партия `[w4, w5]`, у w5 конфликт (`ASSIGNMENT_OVERLAP` на целевом объекте) → 409
  `BATCH_CONFLICT`; **w4 НЕ переведён** (вся партия откатилась); transition'ов нет.
- **E4**: перевод на завершённый объект → 409 `SITE_FINISHED`; ничего не изменилось.

---

## 4. План production (после отдельного разрешения)

Web-only swap `d7c-ad780f8` → `d7e-<финальный SHA>`, **без миграции** (схема 100). Standard
verified backup + restore-test; кандидат `:3198` read-only smoke; rollback-контейнер
`titanor-time-prod-app-pre-<sha>` (образ `d7c-ad780f8`), откат = revert образа. scheduler / Caddy /
DNS / пароли / публичный сайт — не трогать. Ожидаемый простой ~3 c.

---

## 5. Что НЕ входит

- **Немедленный** групповой перевод (только будущая дата — открытые смены и §P5 не усложняют батч).
- Отчёт «Часы заказчику» (Deploy F) — последний этап R15-D7.
