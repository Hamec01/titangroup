# R15-D7 — Deploy B («Новая карточка работника»): отчёт

**Статус:** разработка + disposable-тесты завершены. **Production не изменялся.** Ждёт отдельного
разрешения владельца. Deploy C / E / F не начаты.

Ветка `feature/titanor-time-foundation`, коммит **`be7d929`**. Разрешение владельца на разработку — 2026-09-03. Образ `titanor-time-app:d7b-be7d929`.

---

## 1. Что вошло (по списку владельца)

| Требование | Как сделано |
|---|---|
| Новая понятная карточка работника | `/admin/workers/[employeeId]` перестроена: блоки «Место работы сейчас» / «Запланированные изменения» / «Прошлые назначения» + прежние (статус, допуски, быстрые действия, цикл табеля). |
| Единый блок «Место работы сейчас» | `WorkplaceNowSection` — одна строка на живое назначение: объект → заказчик, «основное место», статус (**Работает здесь сейчас / Идёт смена / Запланировано / Завершено**), график, и **ровно две кнопки**: «Изменить место работы», «Снять с объекта». |
| Одна форма «Изменить место работы» | `ChangeWorkplaceForm` — **одна** форма: Объект · Заказчик · Рабочий график · «Это основное место работы» · «С какого дня?». Каждое поле предвыбрано текущим значением — смена одного поля не трогает остальные (чинит C4). |
| Выбор объекта, заказчика, шаблона и даты начала | всё в одной форме; списки объектов/заказчиков/шаблонов подгружаются при открытии; заказчик зависит от выбранного объекта. |
| Быстрые варианты: сегодня / завтра / выбранная дата | радио-выбор «Сегодня · Завтра · Выбрать дату» (+ поле даты только для третьего варианта). |
| Корректная обработка открытой смены | форма получает `OPEN_SHIFT_CHOICE_REQUIRED` → показывает выбор: **«Доработать сегодня на текущем объекте — перевод с завтра»** (`KEEP_ON_OLD`) или **«Перенести и сегодняшнюю смену — весь день на новый объект»** (`MOVE_TO_NEW`). Check Out никогда не блокируется. |
| «Снять с объекта» | `RemoveFromSiteAction` — «Последний день: Сегодня / Выбрать дату» + **пресеты причины**: Проект завершён · Перевод на другой объект · Назначен по ошибке · Другая причина (→ поле текста). Если работник на смене — явно сказано, что смена не прервётся. |
| «Запланированные изменения» | `ScheduledChangesSection` — назначения с `validFrom > today` (или будущим `clockInDisabledAt`): «С <дата> → Объект — Заказчик», кто и когда запланировал. Работник перейдёт **автоматически по дате, без cron**. |
| «Прошлые назначения» | `PastAssignmentsSection` — свёрнутый `<details>`: даты, причина (из `AssignmentTransition`), кто изменил. |
| Понятная отметка перехода в табеле | `getTimesheetCard` + карточка табеля: если в периоде есть `AssignmentTransition` — строка «<дата, время>: место работы изменено / A → B / с <дата> · изменил: <имя>» + «Эта пометка не меняет часы — она объясняет день». |
| Предупреждение при замене уже запланированного перевода | форма **до подтверждения** (в сводке `change-preview`) пишет: «Внимание: у работника уже запланирован перевод на «X» с <дата>…». При подтверждении → выбор **«Оставить запланированный перевод»** (новое действие делается не-primary) / **«Заменить запланированный перевод»** (план остаётся назначением, теряет primary, фиксируется `AssignmentTransition` + audit). §P4. |
| Все тексты обычным языком RU/EN | вся копия — через `localeText(locale, en, ru)`, короткие человеческие фразы. |

### Резюме перед подтверждением (§3.5)
Новый **read-only** эндпоинт `POST /api/admin/assignments/change-preview` (право `assignment.split`,
ничего не мутирует). Возвращает: `from` / `to` (объект, заказчик, график, основное), `effectiveFrom`,
`isImmediate`, `scheduleChanges`, `primaryChanges`, `openShiftChoiceRequired`,
`scheduledPrimaryConflict` (§P4), `siteFinished` / `customerDisabled`, `hasSubmittedTimeAfter` /
`hasRecordedTimeAfter`. Форма показывает: «A → B · Действует с <дата/сегодня> · график
(не) изменится · [это станет основным] · [предупреждения]».

---

## 2. Что НЕ трогалось / чего нет в Deploy B

- **Backend lifecycle-сервиса** (`removeFromSite` / `changeWorkplace` / `promoteToPrimary`,
  `AssignmentTransition`, advisory-lock, EXCLUDE-constraint) — уже в проде (Deploy A + D). Deploy B —
  это UI + read-only preview + структурные причины + пометка в табеле.
- **Завершение объекта (C), отключение заказчика (I), групповой перевод (E), отчёт «Часы
  заказчику» (F)** — не начаты.
- **Standalone «Отменить запланированное изменение»** — не в этом деплое. Чтобы изменить/отменить
  запланированный перевод, начальник открывает «Изменить место работы» у текущего назначения (форма
  предупредит и предложит оставить/заменить, §P4). Блок «Запланированные изменения» это явно поясняет.
- Legacy-роут `/api/admin/assignments/:id/end` — расширен additive: принимает `reasonCode` +
  `reasonText` (пресеты); прежний `reason` (свободный текст) продолжает работать байт-в-байт.
- Права: FOREMAN новых прав не получает. Всё через `assignment.split` / `assignment.end`.

---

## 3. Изменённые / новые файлы

**Новое:**
- `lib/assignment-card.ts` — сборка данных карточки (current / scheduled / past / transitions).
- `app/api/admin/assignments/change-preview/route.ts` — read-only сводка.
- `app/admin/workers/[employeeId]/ChangeWorkplaceForm.tsx` — единая форма.
- `app/admin/workers/[employeeId]/RemoveFromSiteAction.tsx` — снятие + пресеты причины.
- `app/admin/workers/[employeeId]/WorkplaceSections.tsx` — 3 блока карточки (server components).
- `scripts/_test-t9-worker-card-b.ts` — disposable browser-тест (Chromium), P1–P6 через UI.

**Правки:**
- `app/admin/workers/[employeeId]/page.tsx` — перевод карточки на новые блоки; удалён
  `ChangeAssignmentAction` (заменён), `EndAssignmentAction` на карточке (заменён `RemoveFromSiteAction`).
- `lib/admin-timesheets.ts` — `getTimesheetCard` возвращает `transitionMarkers`.
- `app/admin/timesheets/[timesheetId]/page.tsx` — рендер пометки перехода.
- `lib/assignment-transitions.ts` — `reasonFromPreset` + `isAssignmentTransitionReason` + `ASSIGNMENT_TRANSITION_REASONS`.
- `lib/assignment-lifecycle-service.ts` — `removeFromSite` принимает `reasonCode?` (пресет > свободный текст).
- `app/api/admin/assignments/[assignmentId]/end/route.ts` — additive: `reasonCode` / `reasonText`.
- `scripts/_test-t9-setup-lifecycle.ts` — WA3 / WA4 / CH10 переписаны под новую карточку.
- `app/admin/assignments/ChangeAssignmentAction.tsx` — **удалён** (не использовался после перевода карточки).

---

## 4. Обязательные сценарии P1–P6 — через ИНТЕРФЕЙС

`scripts/_test-t9-worker-card-b.ts` (реальный Chromium, disposable PG16, DB-ассерты). **22/22
P-проверок, 34/34 всего теста.**

| # | Сценарий (через форму карточки) | Результат |
|---|---|---|
| **P1** | Открыть «Изменить место работы» → объект B, «Выбрать дату» +7д. Сводка: «Действует с <+7д>, не сегодня». Подтвердить. Карточка: A в «Место работы сейчас», B в «Запланированные изменения» с датой. DB: A + B оба хранятся primary (периоды не пересекаются), «основной сейчас» = A. | **PASS** (P1a–P1d) |
| **P2** | Состояние дня перехода (A закрыт вчера, B live с сегодня, оба primary, `clockInDisabledAt=NULL` — cron не бегал). Карточка: B — «Место работы сейчас»; A — «Прошлые назначения»; оба хранятся primary. | **PASS** (P2a–P2c) |
| **P3** | Через форму: будущий перевод → 2 хранятся primary, 1 live. Немедленный перевод на 3-й объект → «основной сейчас» резолвится в C, одно live primary. | **PASS** (P3a–P3b) |
| **P4** | A primary + запланированный перевод A→B primary + C (второе текущее, не-primary). В форме на C поставить «Это основное место работы» → **сводка предупреждает** «уже запланирован перевод на B». Подтвердить → выбор **Оставить / Заменить**. «Оставить» → план B цел (primary, дата та же). «Заменить» → B остаётся назначением, теряет primary, `AssignmentTransition` «… superseded …». | **PASS** (P4a–P4d) |
| **P5** | Работник закрыл интервал сегодня на A. В форме объект B, «Сегодня», подтвердить → **ошибки нет**, перевод прошёл. A сохраняет `validTo=today`, интервал остаётся на A, «основной сейчас» = B. | **PASS** (P5a–P5c) |
| **P6** | Работник на открытой смене. В форме объект B, «Сегодня» → сводка говорит «идёт смена» → подтвердить → выбор. **«Доработать сегодня»** → A остаётся live, смена на A, перевод сдвинут на завтра, Check Out на A не блокируется. **«Перенести смену»** → open shift на B, весь shift на B, Check Out на B не блокируется. | **PASS** (P6a–P6f) |

Полный вывод — §7.

---

## 5. Disposable-проверка (образ `d7b-be7d929`, чистый PG16)

| Тест | Результат |
|---|---|
| `_test-t9-worker-card-b` (**новый**, B1–B4 + P1–P6 через UI) | **34 / 34** (P-проверок **22 / 22**) |
| `_test-t9-setup-lifecycle` (WA3/WA4/CH10 переписаны под новую карточку) | **113 / 113** |
| `_test-t9-assignment-lifecycle` (L1–L16 + P1–P6 API, Deploy D) | **118 / 118** |
| `_test-t9-full-flow` | **84 / 84** |
| `_test-t9-setup-ui` | **26 / 26** |
| `_test-t9-role-matrix` | **33 / 33** |
| unit lane | **17 / 17** |

---

## 6. План production (после отдельного разрешения)

Web-only swap `d7d3-5690632` → `d7b-be7d929` (**без миграции**, схема остаётся 100). Standard
verified backup перед swap; rollback-контейнер `titanor-time-prod-app-pre-be7d929` (образ
`d7d3-5690632`). scheduler / Caddy / DNS / пароли / публичный сайт — не трогать. Ожидаемый простой
~4 c (один swap).

---

## 7. Полный вывод P1–P6 (через UI)

Прогон `_test-t9-worker-card-b.ts` (Chromium, реальная форма карточки):

```
──────── P1–P6 through the worker-card UI ────────
  PASS  P1a: the summary says it starts on the future date, not today
  PASS  P1b: "Workplace now" shows site A
  PASS  P1c: "Scheduled changes" block appears and names site B + the date
  PASS  P1d: DB — A + B both stored primary (disjoint periods); the primary NOW is A
  PASS  P2a: on the handover day the card shows site B as the workplace now (by date, no cron)
  PASS  P2b: site A has moved to "Past assignments"
  PASS  P2c: both rows are still stored primary and clockInDisabledAt is NULL on both (nothing demoted)
  PASS  P3a: future transfer keeps BOTH primaries (disjoint) — 2 stored, 1 live
  PASS  P3b: after an immediate same-period change the primary NOW resolves to C (one live primary)
  PASS  P4a: the preview WARNS that a transfer is already scheduled to B
  PASS  P4b: confirming shows the keep / replace choice
  PASS  P4c: "Keep" left the scheduled transfer to B intact (still primary, date unchanged)
  PASS  P4d: "Replace" kept the assignment to B but dropped its primary + recorded a transition
  PASS  P5a: the worker has a completed interval on A today
  PASS  P5b: the transfer went through — no error shown in the form
  PASS  P5c: A keeps today, the interval stays on A, next workplace is B
  PASS  P6a: the preview tells the admin the worker is on an open shift
  PASS  P6b: confirming shows the "finish today on the old site / move the shift" choice
  PASS  P6c: KEEP_ON_OLD — A stays live today, the open shift stays on A, transfer bumped to tomorrow
  PASS  P6d: Check Out on A is not blocked
  PASS  P6e: MOVE_TO_NEW — the open shift is re-pointed to B
  PASS  P6f: Check Out on B is not blocked; the whole shift landed on B
──────── 22/22 P-checks passed ────────
{"pass":34,"fail":0}
```
