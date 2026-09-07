# GPS: зона уверенности и допустимая погрешность 250 м

**Ветка:** `fix/gps-confidence-zone-250` (запушена) · **база:** `feature/titanor-time-foundation` @ `2ef21b1`
**Финальный SHA:** `ed36f73` · **Candidate:** `titanor-time-app:gps-conf-ed36f73`
**Статус:** разработка + disposable-регрессия + candidate-регрессия завершены. **Production не менялся, миграций нет, ретроактивных изменений нет.** Развёртывание — только по отдельному письменному GO владельца.

**История коммитов:** `6256424` (confidence-zone логика) → `3ce3d37` (UI/CSS/отчёт часть 1) → `ed36f73` (STOP-GATE №1 + №2) → docs-only коммит с результатами candidate-регрессии.

## 0. STOP-GATE №1 и №2 (по ТЗ-продолжению)

**STOP-GATE №1 — UI и API ограничивают порог до 250:**
- `PolicyForm`: `min=10`, `max=250`, `step=5`; подпись и пояснение (RU/EN) явно «10–250 м».
- `validatePolicyPatchInput` ([lib/attendance-policy.ts](../../titanor-time-app/lib/attendance-policy.ts)):
  бизнес-диапазон `10..250` (константы `MAX_GPS_ACCURACY_POLICY_MIN/MAX`); `251`, `5000`, `9`,
  дробное, строка, `null` → `400 VALIDATION_ERROR` с `fieldErrors.maxGpsAccuracyMeters`;
  сообщение содержит «250». Форма показывает локализованный текст «Введите целое число от 10 до 250 /
  Enter a whole number from 10 to 250».
- **DB CHECK `10..5000` не трогается** (обратная совместимость, старая миграция `20260828050000`).
  Новой миграции нет. Приложение применяет более строгий предел.
- UI больше не может сохранить значение выше 250, которое сервер молча урежет.

**STOP-GATE №2 — клиент и сервер используют один policy:**
- Worker context (`GET /api/worker/attendance/context`) теперь отдаёт `maxGpsAccuracyMeters` из
  актуальной `CompanyAttendancePolicy` (additive, обратно совместимо).
- Кэшируется на устройстве (`DeviceStateRecord.maxGpsAccuracyMeters?`, optional — старая запись
  читается как `undefined`).
- Клиентский effective gate = `effectiveGpsGate(context.maxGpsAccuracyMeters)` =
  `min(значение, 250)`, **fallback 75** если поля нет (старый/кэшированный context, первый offline
  старт).
- Effective gate проброшен в: `evaluateZoneProximity`, `captureGpsSnapshot`,
  `hasConfidentInsideFix`, зональный бейдж (`WorkerStatusCard`), шкалу точности, Check In / Check Out
  / Switch, offline/PWA, восстановление состояния после reload (эффект зоны в deps).
- Клиент **не** присылает серверу готовый результат проверки; сервер сам грузит актуальную геозону и
  policy и пересчитывает (`evaluateGpsReading(gps, loadCurrentGeofence(tx), loadMaxGpsAccuracyMeters(tx))`
  во всех путях). Клиентский бейдж — только подсказка.
- Offline: клиент показывает подсказку по последней сохранённой policy; сервер при `/sync`
  переклассифицирует событие по своей актуальной policy.

---

## 1. Проблема

Сервер сначала сравнивал `accuracyMeters` с порогом `CompanyAttendancePolicy.maxGpsAccuracyMeters`
(на production = **75 м**) и при превышении сразу создавал исключение `GPS_NOT_VERIFIED /
LOW_ACCURACY` — даже когда работник **гарантированно** внутри объекта.

Реальный случай со скриншота:

| Величина | Значение |
|---|---|
| расстояние до центра геозоны | 550 м |
| радиус геозоны | 900 м |
| точность GPS | ±128,9 м |
| дальний край круга погрешности | 550 + 128,9 = **678,9 м** |
| 678,9 < 900 | работник **точно** внутри |
| фактический результат старой системы | `LOW_ACCURACY`, исключение создано |

Плюс клиент (`lib/worker-gps.ts`) имел свой отдельный hard-coded порог **75 м**: он называл 128,9 м
«слабым сигналом», заставлял работника ждать до 25 секунд и показывал «Слишком неточно», хотя
геометрически всё было в порядке.

---

## 2. Точная старая логика (`evaluateGpsReading`, до изменения)

```
если координаты нет            -> NOT_VERIFIED (reason = причина клиента: TIMEOUT / …)
иначе если accuracy > gate     -> NOT_VERIFIED, reason LOW_ACCURACY        (gate = policy, деф. 75)
иначе если геозоны нет         -> NOT_VERIFIED, reason null
иначе:
    distance = haversine(точка, центр)
    inside = distance <= radius + accuracy          // центр может быть на accuracy ВНЕ забора
    -> inside ? VERIFIED_INSIDE : VERIFIED_OUTSIDE
```

Клиент (`evaluateZoneProximity`): hard-coded порог `75` (не из policy!); `INSIDE`, если
`distance <= radius + accuracy`, иначе `OUTSIDE`. Рассинхрон с сервером был возможен.

---

## 3. Точная новая логика (зона уверенности)

Единственный источник решения — сервер, функция `evaluateGpsReading`
([lib/attendance-clock.ts](../../titanor-time-app/lib/attendance-clock.ts)). Через неё проходят **все**
пути: Check In, Check Out, Switch, offline `/sync` и повторная идемпотентная синхронизация.

```
effGate = min(policy.maxGpsAccuracyMeters, 250)     // абсолютный потолок 250 поверх настройки компании

если координаты нет                     -> NOT_VERIFIED (reason = причина клиента)          [случай 5]
иначе если accuracy > effGate           -> NOT_VERIFIED, reason LOW_ACCURACY                [случай 4]
иначе если геозоны нет                  -> NOT_VERIFIED, reason null
иначе:
    distance = haversine(точка, центр)
    если distance + accuracy <= radius  -> VERIFIED_INSIDE            (весь круг внутри)     [случай 1]
    если distance - accuracy >  radius   -> VERIFIED_OUTSIDE           (весь круг снаружи)    [случай 2]
    иначе                                -> NOT_VERIFIED, reason LOW_ACCURACY,
                                            boundaryUncertain = true   (круг пересекает границу) [случай 3]
```

- **`VERIFIED_OUTSIDE` не изменился.** Предикат `distance - accuracy > radius` тождественен старому
  `!(distance <= radius + accuracy)` — обработка настоящего выхода за зону не ослаблена.
- **Ужесточён только `VERIFIED_INSIDE`.** Раньше подтверждалась любая точка с `distance <= radius +
  accuracy` (центр мог быть на целый радиус погрешности **снаружи** забора). Теперь эта полоса —
  зона `NOT_VERIFIED` / ручная проверка.
- **`boundaryUncertain: true`** попадает в `detail` исключения (allowlist + подпись в
  [attendance-exceptions-ui.ts](../../titanor-time-app/lib/attendance-exceptions-ui.ts):
  «Погрешность GPS пересекает границу объекта»); `summary` для такого `GPS_NOT_VERIFIED` —
  «GPS accuracy circle crosses the site boundary — manual check needed». `ClockEvent.gpsUnavailableReason`
  остаётся `LOW_ACCURACY` — **новой enum-значения и миграции не нужно**.
- **Cached / approximate / offline точка** приходит как `location: null` (поле `gpsApproximate`,
  см. `validateApproximateGpsPayload`), поэтому `evaluateGpsReading` её никогда не подтверждает —
  поведение сохранено (случай 6/7).
- **Настройка компании не игнорируется.** Пока на production стоит `75`, реальный кейс 128,9 м всё
  ещё будет `LOW_ACCURACY` **и на сервере, и на клиенте** — до отдельного rollout-действия (раздел
  8). `effGate = min(policy, 250)`: значение выше 250 никогда не расширяет авто-подтверждение (и
  теперь не сохраняется — STOP-GATE №1), значение 75 соблюдается как есть.
- **Клиент берёт policy с сервера** (worker context → `deviceState.maxGpsAccuracyMeters`), считает
  тот же `min(policy, 250)`, fallback 75. Зелёный статус «На объекте» не показывается, если сервер
  с той же policy вернул бы `NOT_VERIFIED` (STOP-GATE №2).

Клиент (`evaluateZoneProximity`) — точное зеркало серверной геометрии с **тем же effective gate**
(`effectiveGpsGate(context.maxGpsAccuracyMeters)` = `min(значение, 250)`, fallback 75), четыре
состояния `INSIDE / OUTSIDE / NEAR_BOUNDARY / LOW_ACCURACY`. Это только подсказка на экране; сервер
всё пересчитывает по своей актуальной policy.

Таблица соответствия клиент ↔ сервер (доказано `_test-gps-confidence-zone.ts` case 12 при policy 75 и 250):

| client (`evaluateZoneProximity`) | server (`evaluateGpsReading`) |
|---|---|
| `INSIDE` | `VERIFIED_INSIDE` (исключения нет) |
| `OUTSIDE` | `VERIFIED_OUTSIDE` (`OUTSIDE_GEOFENCE`) |
| `NEAR_BOUNDARY` | `NOT_VERIFIED` + `boundaryUncertain=true` |
| `LOW_ACCURACY` | `NOT_VERIFIED` / `LOW_ACCURACY` |

---

## 4. Изменённые файлы

### Сервер (решение)
| Файл | Что |
|---|---|
| `titanor-time-app/lib/attendance-clock.ts` | `MAX_AUTO_VERIFY_ACCURACY_METERS = 250`; `GpsEvaluation.boundaryUncertain`; переписан `evaluateGpsReading` (зона уверенности, `min(policy,250)`); `exceptionDetailForGps` добавляет `boundaryUncertain` в detail |
| `titanor-time-app/lib/attendance-exceptions.ts` | `boundaryUncertain` в allowlist detail-ключей; `summary` для граничного `GPS_NOT_VERIFIED` |
| `titanor-time-app/lib/attendance-exceptions-ui.ts` | подпись ключа `boundaryUncertain` (EN/RU) |
| `titanor-time-app/lib/attendance-policy.ts` | `MAX_GPS_ACCURACY_POLICY_MIN=10` / `MAX=250`; `validatePolicyPatchInput` — бизнес-диапазон `10..250` (STOP-GATE №1) |
| `titanor-time-app/lib/attendance-sync.ts` | `AttendanceContextView.maxGpsAccuracyMeters` + `buildAttendanceContext` грузит его из `CompanyAttendancePolicy` (STOP-GATE №2, additive). `evaluateGpsReading` в 3 местах — без изменений |
| `titanor-time-app/lib/offline-outbox/db.ts` | `DeviceStateRecord.maxGpsAccuracyMeters?` (optional, без bump `DB_VERSION`) |
| `titanor-time-app/lib/offline-outbox/device.ts` | `ContextResponseWire.maxGpsAccuracyMeters?`; `applyContextResponse` кэширует его на устройстве |
| `titanor-time-app/lib/attendance-presence.ts` | не менялся — `insideGeofence` для пограничной пробы присутствия теперь `null` вместо `true` (проба — только доказательство, ничего не решает; более честно) |

### Клиент (подсказка + UX)
| Файл | Что |
|---|---|
| `titanor-time-app/lib/worker-gps.ts` | `MAX_AUTO_VERIFY_ACCURACY_METERS=250`, `GPS_GATE_FALLBACK_METERS=75`, `effectiveGpsGate(policyValue)`; `evaluateZoneProximity(loc, geo, gateMeters=250)` → 4 состояния с effective gate; `hasConfidentInsideFix(zone, gateMeters)`; `captureGpsSnapshot({ zone, gateMeters })` — ранний выход при гарантированно-внутри; `pushFix` хранит last-good до 250 м |
| `titanor-time-app/app/worker/clock-panel/format.ts` | `ZoneStatus` += `NEAR_BOUNDARY` |
| `titanor-time-app/app/worker/clock-panel/WorkerStatusCard.tsx` | цвет индикатора для `NEAR_BOUNDARY` (янтарный) |
| `titanor-time-app/app/worker/WorkerClockPanel.tsx` | `effectiveGpsGateM = effectiveGpsGate(deviceState.maxGpsAccuracyMeters)` проброшен в зональный эффект (+ в deps), `runGpsCapture`, `captureGpsSnapshot`, `hasConfidentInsideFix`, `confirmOutsideZone`, шкалу точности (хорошая ≤75 / приемлемая ≤effGate / слабая >effGate); сводка зоны += `NEAR_BOUNDARY` |
| `titanor-time-app/lib/i18n/worker.ts` | `statusZoneNearBoundary` «Около границы — отметка будет проверена», `statusZoneLowAccuracy` «Слабый сигнал GPS — отметка будет проверена», `statusZoneOutside` «Вы вне объекта», `gpsAccuracyModerate` «±N м — приемлемая» (EN + RU по ТЗ) |
| `titanor-time-app/app/globals.css` | `.wk-status-grid p` — колонки `auto auto minmax(0,1fr)` + `strong { text-align:right; overflow-wrap:anywhere }`, чтобы предложение статуса зоны не наезжало на подпись «Зона» |
| `titanor-time-app/components/attendance-policy/PolicyForm.tsx` | `min/max/step = 10/250/5`; подпись «(метры, 10–250)»; локализованный `FieldError` для `maxGpsAccuracyMeters`; пояснение «весь круг внутри/снаружи», «10–250 м», «больше 250 ввести нельзя», «75 соблюдается, пока стоит» (EN/RU) |

### Тесты
| Файл | Лейн | Что |
|---|---|---|
| `titanor-time-app/scripts/_test-gps-confidence-zone.ts` | unit | чистая классификация (случаи 1–11); `effectiveGpsGate`; **case 12** — клиент ↔ сервер совпадают при policy 75 и 250 (ТЗ case 1/2/3/4/5/10) |
| `titanor-time-app/scripts/_test-gps-confidence-zone-sync.ts` | db | context отдаёт `maxGpsAccuracyMeters` (и следует за policy); online (`performCheckIn` route) == offline (`/sync`) для INSIDE/NEAR_BOUNDARY/OUTSIDE при policy 250; **case 2** — тот же кейс при policy 75 → NOT_VERIFIED обоими путями; идемпотентный ре-sync без дублей ClockEvent/AttendanceException |
| `titanor-time-app/scripts/_test-gps-accuracy-threshold.ts` | db | диапазон `10..250` (`10/75/150/250` ok; `251/5000/9/100.5/строка/null` → нет); **route-тест PATCH** — 400 не меняет строку и не пишет audit, успех пишет ровно 1 audit; **RBAC** — SUPER_ADMIN 200, WORKER 403, без сессии 401 (ТЗ case 13/14) |
| `titanor-time-app/scripts/_test-worker-gps.ts` | unit | `evaluateZoneProximity` с gate 75 и 250; `effectiveGpsGate`; `hasConfidentInsideFix`/`captureGpsSnapshot` ранний выход |
| `titanor-time-app/scripts/test-manifest.json` | — | 2 записи от первой части (`_test-gps-confidence-zone` + `-sync`), 109 всего |

**Миграций нет.** Схема без изменений (`@default(75)` не трогали). `CompanyAttendancePolicy.maxGpsAccuracyMeters`
уже допускает 250 в БД (CHECK `10..5000`, миграция `20260828050000`); приложение сузило до `10..250`.

---

## 5. Обязательные тесты (14 сценариев ТЗ) — сопоставление

| № | Условие | Ожидание | Где | Итог |
|---|---|---|---|---|
| 1 | policy 250, d=550, r=900, acc=128.9 | client `INSIDE`, server `VERIFIED_INSIDE`, исключения нет | `_test-gps-confidence-zone.ts` #1 + case 12; `-sync.ts` INSIDE | PASS |
| 2 | policy 75, та же точка | client `LOW_ACCURACY` (не зелёный), server `NOT_VERIFIED/LOW_ACCURACY` | `_test-gps-confidence-zone.ts` case 12; `-sync.ts` «case2 (policy 75)»; `_test-worker-gps.ts` | PASS |
| 3 | policy 250, d=730, r=650, acc=3.2 | client `OUTSIDE`, server `VERIFIED_OUTSIDE`, `OUTSIDE_GEOFENCE` сохраняется | `_test-gps-confidence-zone.ts` #2 + case 12 (и при policy 75) | PASS |
| 4 | policy 250, d=820, r=900, acc=128.9 | client `NEAR_BOUNDARY`, server `NOT_VERIFIED/LOW_ACCURACY`, `boundaryUncertain=true`, ровно 1 исключение | `_test-gps-confidence-zone.ts` #3 + case 12; `-sync.ts` NEAR_BOUNDARY | PASS |
| 5 | policy 250, d=100, r=900, acc=251 | client `LOW_ACCURACY`, server `NOT_VERIFIED/LOW_ACCURACY` | `_test-gps-confidence-zone.ts` #4 + case 12 | PASS |
| 6 | `d + accuracy = radius` | client `INSIDE`, server `VERIFIED_INSIDE` | `_test-gps-confidence-zone.ts` #5; `_test-worker-gps.ts` | PASS |
| 7 | `d − accuracy > radius` | client `OUTSIDE`, server `VERIFIED_OUTSIDE` | `_test-gps-confidence-zone.ts` #6; `_test-worker-gps.ts` | PASS |
| 8 | approximate/cached точка внутри | не подтверждать авто, штатное событие на ручную проверку | `_test-gps-confidence-zone.ts` #7; `_test-gps-approximate-sync.ts` | PASS |
| 9 | нет координаты | причины (`TIMEOUT`/…) сохраняются, никаких ложных `VERIFIED_INSIDE` | `_test-gps-confidence-zone.ts` #8 | PASS |
| 10 | policy отсутствует в cached context | fallback 75; client и server безопасны; для acc 128.9 зелёный не показывается | `_test-gps-confidence-zone.ts` case 12 (`effectiveGpsGate(undefined)`); `_test-worker-gps.ts` | PASS |
| 11 | online/offline parity (Check In/Out/Switch, `/sync`) | серверный результат совпадает | `_test-gps-confidence-zone-sync.ts`; `_test-pilot-pair-orphan.ts` | PASS |
| 12 | idempotency: повторный sync одного `clientEventId` | нет дубля `ClockEvent` / `AttendanceException` | `_test-gps-confidence-zone-sync.ts` | PASS |
| 13 | API policy validation | `10/75/250` → успех; `251/5000/9/дробное/строка/null` → 400; строка не меняется при ошибке; audit только при успехе | `_test-gps-accuracy-threshold.ts` #4 + #4a | PASS |
| 14 | права | SUPER_ADMIN может; WORKER не может (403); без сессии 401; role matrix не ослаблена¹ | `_test-gps-accuracy-threshold.ts` #4a | PASS |

¹ **Расхождение с ТЗ.** ТЗ case 14 ожидает, что **ADMIN не может** менять policy. Однако текущая
посеянная RBAC (`prisma/migrations/20260818020000_seed_attendance_policy_permissions`) даёт право
`attendance.policy.update` **и ADMIN, и SUPER_ADMIN**. Ограничить его до SUPER_ADMIN — это изменение
матрицы ролей (нужна отдельная миграция + отдельное решение владельца), выходит за рамки GPS-задачи
и запрещено ею («role matrix не ослаблять / не менять»). Тест проверяет реальное поведение:
SUPER_ADMIN ✅, WORKER ✅ 403, ADMIN — по текущей матрице (может), **матрица не изменена**. Нужно ли
сузить до SUPER_ADMIN — решает владелец отдельно.

---

## 6. Результаты регрессии (2026-09-07)

### 6.1 Лёгкие проверки (disposable-БД, ветка HEAD)

| Проверка | Итог |
|---|---|
| Prisma validate + migration inventory (в `npm run lint`) | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `next build` (standalone) | **PASS** — `.next/standalone` собран |
| unit lane (`run-tests.mjs unit`) | **19/19 PASS** — вкл. `_test-gps-confidence-zone.ts` **38/38**, `_test-worker-gps.ts` **52/52**, `_test-worker-clock-panel.ts` **55/55**, `_test-offline-idb-invariants.ts` (новое optional-поле deviceState) |
| db + scheduler lane (`run-tests.mjs db`, disposable PG16, шаблон 102, клон на тест) | **67/67 PASS · 0 fail** — вкл. `_test-gps-confidence-zone-sync.ts`, `_test-gps-accuracy-threshold.ts` (диапазон 10..250 + route PATCH + RBAC), `_test-gps-exception-detail`, `_test-gps-approximate-sync`, `_test-checkin-never-blocked`, `_test-pilot-pair-orphan`, `_test-attendance-presence`, `_test-bulk-ack-gps`, `_test-site-gps-flag`, `_test-map-gps`, `_test-abandoned-shift-auto-close` |

### 6.2 Полная регрессия на candidate `titanor-time-app:gps-conf-ed36f73` — **все PASS**

browser manifest **20/0/2skip** · restart-persistence **PASS** · worker-dossier QA **31/0** · candidate
smoke **PASS**. Детали и разбивка — **§10**.

### 6.3 Скриншоты — **24 файла, layout-проблем нет**

Android 393×851 + iPhone 390×844, RU + EN, 4 состояния worker + admin policy (+ 4 темы) + admin
exception. Автопроверки: нет горизонтального скролла, статус не перекрывает Check In/Out. Детали — **§11**.

---

## 7. Подтверждения (ТЗ)

- **Настоящий `OUTSIDE_GEOFENCE` сохранён.** Предикат `VERIFIED_OUTSIDE` (`distance − accuracy >
  radius`) тождественен прежнему. `OUTSIDE_GEOFENCE_CHECKIN` / `OUTSIDE_GEOFENCE_CHECKOUT` и их
  обработка не тронуты (`_test-checkin-never-blocked.ts`, `_test-gps-confidence-zone-sync.ts` OUTSIDE,
  `_test-gps-confidence-zone.ts` case 12 при policy 75 и 250).
- **Client/server parity при policy 75 и 250.** `_test-gps-confidence-zone.ts` case 12 прогоняет 7
  сценариев ТЗ через `evaluateZoneProximity` (клиент) и `evaluateGpsReading` (сервер) с одним
  `effectiveGpsGate` и проверяет совпадение классификации. Ключевой кейс: policy 75, точка 550 м /
  ±128,9 → **и клиент, и сервер → LOW_ACCURACY** (зелёный статус не показывается). policy 250 → оба →
  INSIDE. `_test-gps-confidence-zone-sync.ts` подтверждает это через реальные роуты (online +
  offline).
- **API-ограничение 10..250.** `_test-gps-accuracy-threshold.ts`: `validatePolicyPatchInput` и роут
  `PATCH /api/admin/attendance/policy` принимают `10/75/150/250`, отклоняют `251/5000/9/100.5/строка/
  null` c `400 VALIDATION_ERROR` + `fieldErrors.maxGpsAccuracyMeters` (сообщение содержит «250»).
  Отклонённый PATCH **не меняет строку** и **не пишет audit**; успешный — пишет ровно один
  `ATTENDANCE_POLICY_UPDATED`. UI: `min=10 max=250 step=5`, значение выше 250 ввести/сохранить нельзя.
- **Права.** `_test-gps-accuracy-threshold.ts` + browser `_test-t9-role-matrix` (33/0): SUPER_ADMIN
  меняет policy (200), WORKER → 403, без сессии → 401; матрица ролей не ослаблена. (ADMIN сохраняет
  своё существующее право `attendance.policy.update` — см. сноску к §5.)
- **Ретроактивных изменений нет.** Меняется только классификация **новых** событий. Ни один старый
  `ClockEvent`, `AttendanceException`, `ClockShift`, час, табель, назначение или геозона не читается и
  не пишется задним числом. Исключение со скриншота не трогается — код нигде не закрывает и не
  переклассифицирует существующие исключения. `_test-t9-full-flow` (84/0) подтверждает: расчёт
  часов/табеля не изменился.
- **Схема БД без изменений**, миграций нет; `prisma migrate deploy` на шаблоне применяет ровно 102,
  `/api/ready` candidate → `schema:current 102/102`.
- **Production не изменялся.** Все прогоны — disposable PG + контейнеры из candidate-образа;
  production URL и production `DATABASE_URL` в фикстурах не использовались; `titanor-time-prod-*` не
  перезапускались.

---

## 8. Production-настройка порога и безопасный rollout 75 → 250

**Текущее значение на production: `CompanyAttendancePolicy.maxGpsAccuracyMeters = 75`** (дефолт схемы,
singleton создан при первом деплое, не менялся).

Пока стоит 75, новая логика его **соблюдает**: `effGate = min(75, 250) = 75`, поэтому реальный кейс
128,9 м всё ещё уйдёт в `LOW_ACCURACY`. Полный эффект зоны уверенности наступает после смены на 250.

### Rollout (отдельное разрешённое действие, после приёмки кода)

1. **Не миграцией.** Значение меняется штатным admin-API — тем же, что и остальные поля политики.
2. **Свежий backup** production перед изменением: `ops/titanor-time/backup-titanor-time.sh gps-gate-250`
   (on-box + off-box, сверка `SHA256SUMS`).
3. **Изменение** — один из двух способов:
   - **UI:** `/admin/attendance/policy` → поле «Максимальная точность GPS для автоматической проверки
     геозоны» → `250` → «Сохранить». Идемпотентно (Idempotency-Key), одна singleton-строка `FOR UPDATE`.
   - **API:** `PATCH /api/admin/attendance/policy`, тело `{"maxGpsAccuracyMeters":250}`, заголовки
     `X-Requested-With: titanor-time` + `Idempotency-Key: <uuid>`, сессия ADMIN/SUPER_ADMIN с правом
     `attendance.policy.update` (или как в текущей раздаче прав).
4. **Аудит:** запись `ATTENDANCE_POLICY_UPDATED` с `beforeValue.maxGpsAccuracyMeters = 75` и
   `afterValue.maxGpsAccuracyMeters = 250` пишется автоматически в той же транзакции
   ([lib/attendance-policy.ts](../../titanor-time-app/lib/attendance-policy.ts) `updateCompanyAttendancePolicy`).
5. **Проверка после:** `GET /api/admin/attendance/policy` → `maxGpsAccuracyMeters: 250`; открыть 1–2
   свежих `GPS_NOT_VERIFIED` и убедиться, что новые отметки классифицируются как ожидается; логи app
   без ошибок.
6. **Откат настройки:** тем же PATCH вернуть `75` (снова с аудитом). Никаких данных это не трогает —
   меняется классификация только последующих событий.

### Что rollout НЕ делает

- Не пересчитывает и не трогает старые события/часы/исключения.
- Не отключает ручную проверку — граница и `accuracy > 250` по-прежнему уходят администратору.
- Не меняет обработку `OUTSIDE_GEOFENCE`.
- Не связан с признаком объекта `gpsOftenUnavailable` (отдельная тема, см.
  [R15_MEYER_GPS_AUTOACCEPT_PLAN_RU.md](R15_MEYER_GPS_AUTOACCEPT_PLAN_RU.md)).

---

## 9. Развёртывание кода

- **Ветка:** `fix/gps-confidence-zone-250` (запушена, `git push` без force) · **worktree:**
  `/home/deploy/projects/titanorgroup-worktrees/gps-confidence-zone`
- **Финальный commit SHA:** **`ed36f734707ac5ae36ef6304c031db0cf022172e`** (`ed36f73`).
  Коммиты: `6256424` (confidence-zone логика) → `3ce3d37` (UI/CSS/отчёт) → `ed36f73` (STOP-GATE №1 + №2).
  Отдельный docs-only коммит записывает результаты candidate-регрессии (не влияет на код образа).
- **Candidate image:** **`titanor-time-app:gps-conf-ed36f73`** (794 МБ).
  `org.opencontainers.image.revision` = `ed36f734707ac5ae36ef6304c031db0cf022172e` (полный SHA, сверено),
  `ref.name` = `fix/gps-confidence-zone-250`, `GIT_SHA` env = полный SHA.
- **Тип развёртывания:** web-only swap, **без миграции** (схема 102 неизменна, schema.prisma не тронут).
- **Порог `maxGpsAccuracyMeters`:** на production остаётся **75** до отдельного rollout-действия
  (раздел 8). Код при 75 ведёт себя честно и на сервере, и на клиенте (`min(75, 250) = 75`).

## 10. Полная регрессия на candidate `titanor-time-app:gps-conf-ed36f73`

Все прогоны — на disposable PG16 (схема 102) + контейнерах из candidate-образа. Production URL и
production DATABASE_URL не использовались. Последовательно, с проверкой RAM перед каждым шагом.

| Шаг | Итог |
|---|---|
| Docker-сборка образа | **OK** — `next build` compiled 31.6s, TypeScript 45s, без ошибок; RAM guard не срабатывал |
| Candidate read-only smoke (disposable PG 102) | **PASS** — `/api/ready` 200 `schema:current 102/102`; `/login` 200, `/worker`+`/admin` → 307, `/api/worker/attendance/context` без сессии → 401; логи app без error/exception/prisma/SQL |
| Полный browser manifest (`ops/titanor-time/run-browser-acceptance.sh`, per-test-изоляция, 22 теста) | **20 pass / 0 fail / 2 skip-harness** — skip'ы (`_test-t9-restart-persistence`, `_test-worker-dossier-browser-qa`) гоняются своими скриптами ниже |
| ↳ offline / PWA | **PASS** — `_test-offline-cold-restart` 6/0, `_test-offline-shell-locale` 12/0, `_test-offline-views` **71/0**, `_test-pwa-install` 59/0 |
| ↳ Check In/Out/Switch + assignment lifecycle | **PASS** — `_test-t9-full-flow` **84/0** (полный e2e через UI), `_test-t9-assignment-lifecycle` 118/0, `_test-t9-group-transfer` 16/0, `_test-t9-site-lifecycle` 38/0 |
| ↳ ADMIN/SUPER_ADMIN role matrix | **PASS** — `_test-t9-role-matrix` **33/0** (не ослаблена), `_test-t9-setup-ui` 26/0, `_test-t9-setup-lifecycle` 113/0 |
| ↳ дизайн/отчёты | **PASS** — `_test-reports-command-center` 47/0, `_test-export-ui` 87/0, `_test-t9-worker-card-b` 34/0, `_test-customer-report-scope-ui`, `_test-qualifications-browser-qa` |
| `ops/titanor-time/run-restart-persistence.sh` | **PASS** — seed `_test-t9-full-flow` 84/0 → PHASE=prepare 5/0 → `docker restart tt-rp-app` (БД+том живут) → PHASE=verify **18/0** (byte-identical snapshot + стек принимает аутентифицированную ADMIN-запись) |
| `ops/titanor-time/run-worker-dossier-qa.sh` | **PASS** — seed (`_qa-seed-worker-dossier`) ok → `_test-worker-dossier-browser-qa` **31/0** |
| console errors / HTTP 500 / Prisma / SQL / дубли событий / изменения логики табелей | нет — browser-lane тесты содержат console-assertions; ни одного FAIL; `_test-t9-full-flow` проверяет расчёт часов/табеля |

**RAM во время build/test:** пик расхода на `next build` внутри Docker; минимум `available` за все прогоны ≈ **2.5 ГиБ** (порог STOP — 2 ГиБ, не достигнут); RAM-guard (alert < 400 МБ `free`) не срабатывал. `run-browser-acceptance` (~30 мин) держал `available` ≈ 3.1–3.6 ГиБ.

## 11. Скриншоты (candidate `gps-conf-ed36f73`, схема 102, policy 250)

Standalone/контейнер candidate-образа на disposable PG. 24 файла в `scratchpad/shots2/`:
**Android 393×851 + iPhone 390×844 · RU + EN · 4 состояния worker + admin policy + admin exception + 4 темы.**
Автопроверки: **горизонтального скролла нет; статус-карта не перекрывает Check In/Out** (все 20 worker-кадров).

| Кадр | Что видно |
|---|---|
| `worker-{RU,EN}-{android,iphone}-inside` | точка 550 м / ±129: зона **«На объекте» / «On site»** (зелёный), точность «±129 м — приемлемая / usable». Раньше — «слабый сигнал» + 25 с + `LOW_ACCURACY` |
| `…-near-boundary` | 820 м / ±129: зона **«Около границы — отметка будет проверена» / «Near the boundary — the event will be reviewed»** (янтарный) |
| `…-low-accuracy` | ±320 (> 250): зона **«Слабый сигнал GPS — отметка будет проверена» / «Weak GPS signal — the event will be reviewed»**, точность «слабый сигнал, отметку проверит администратор», кнопка «Уточнить / Improve» |
| `…-outside` | 1400 м / ±12: зона **«Вы вне объекта» / «You are outside the site»** (красный) |
| `admin-{RU,EN}-policy` + `admin-policy-{classic-light,modern-titan-dark,modern-graphite,modern-ocean}` | поле «…(метры, 10–250)» = 250, пояснение про «весь круг внутри/снаружи», «10–250 м», «больше 250 ввести нельзя»; читаемо во всех 4 темах, оба дизайна |
| `admin-{RU,EN}-exception-boundary` | «GPS не подтверждён / GPS not verified», summary *«GPS accuracy circle crosses the site boundary — manual check needed»*, деталь **«Погрешность GPS пересекает границу объекта: Да / GPS accuracy crosses the site boundary: Yes»**, кнопки «Подтвердить как верное / Acknowledge as valid» — ручная проверка сохранена; мини-карта: круг погрешности на границе геозоны |

## 12. Rollback

- **Rollback кода:** вернуть предыдущий образ `titanor-time-app:redesign-4c282ba` тем же web-swap
  (`docker stop -t 30 titanor-time-prod-app` → `docker rename … titanor-time-prod-app-gps-conf-failed`
  → `docker rename titanor-time-prod-app-pre-<sha> titanor-time-prod-app` → `docker start` →
  `curl :3199/api/ready`); **не** `docker rm -f`; схему **не** откатывать; контейнер
  `titanor-time-prod-app-pre-4c282ba` — не трогать.
- **Rollback настройки policy 250 → 75** (отдельно, если её уже меняли):
  `PATCH /api/admin/attendance/policy {"maxGpsAccuracyMeters":75}` (тот же путь, что и rollout) →
  аудит `ATTENDANCE_POLICY_UPDATED` (before 250 / after 75). Данные не трогает — меняется
  классификация только последующих событий. Старые события/часы/исключения не пересчитываются.

**Развёртывание — только после отдельного письменного GO владельца.** После полной проверки — остановка.
