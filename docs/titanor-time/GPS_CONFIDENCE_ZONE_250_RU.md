# GPS: зона уверенности и допустимая погрешность 250 м

**Ветка:** `fix/gps-confidence-zone-250` · **база:** `feature/titanor-time-foundation` @ `2ef21b1`
**Статус:** разработка + проверка на disposable-БД завершены. **Production не менялся.** Развёртывание — только по отдельному подтверждению владельца.

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

Клиент (`evaluateZoneProximity`): порог `75`; `INSIDE`, если `distance <= radius + accuracy`, иначе `OUTSIDE`.

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
  ещё будет `LOW_ACCURACY` — до отдельного rollout-действия (раздел 8). `effGate = min(policy, 250)`:
  значение выше 250 никогда не расширяет авто-подтверждение, значение 75 соблюдается как есть.

Клиент (`evaluateZoneProximity`) — точное зеркало серверной геометрии, порог 250, четыре состояния
`INSIDE / OUTSIDE / NEAR_BOUNDARY / LOW_ACCURACY`. Это только подсказка на экране; сервер всё
пересчитывает.

---

## 4. Изменённые файлы

### Сервер (решение)
| Файл | Что |
|---|---|
| `titanor-time-app/lib/attendance-clock.ts` | `MAX_AUTO_VERIFY_ACCURACY_METERS = 250`; `GpsEvaluation.boundaryUncertain`; переписан `evaluateGpsReading` (зона уверенности, `min(policy,250)`); `exceptionDetailForGps` добавляет `boundaryUncertain` в detail |
| `titanor-time-app/lib/attendance-exceptions.ts` | `boundaryUncertain` в allowlist detail-ключей; `summary` для граничного `GPS_NOT_VERIFIED` |
| `titanor-time-app/lib/attendance-exceptions-ui.ts` | подпись ключа `boundaryUncertain` (EN/RU) |
| `titanor-time-app/lib/attendance-sync.ts` | не менялся — `evaluateGpsReading` вызывается как раньше в 3 местах (preflight + два `insertAndApplyCheckOut`) |
| `titanor-time-app/lib/attendance-presence.ts` | не менялся — `insideGeofence` для пограничной пробы присутствия теперь `null` вместо `true` (проба — только доказательство, ничего не решает; более честно) |

### Клиент (подсказка + UX)
| Файл | Что |
|---|---|
| `titanor-time-app/lib/worker-gps.ts` | `MAX_AUTO_VERIFY_ACCURACY_METERS = 250`; `evaluateZoneProximity` → 4 состояния, порог 250; `hasConfidentInsideFix()`; `captureGpsSnapshot({ zone })` — ранний выход, если точка гарантированно внутри; `pushFix` хранит last-good до 250 м |
| `titanor-time-app/app/worker/clock-panel/format.ts` | `ZoneStatus` += `NEAR_BOUNDARY` |
| `titanor-time-app/app/worker/clock-panel/WorkerStatusCard.tsx` | цвет индикатора для `NEAR_BOUNDARY` (янтарный) |
| `titanor-time-app/app/worker/WorkerClockPanel.tsx` | сводка зоны += `NEAR_BOUNDARY`; шкала точности 3-уровневая (хорошая ≤75 / приемлемая ≤250 / слабая >250); `runGpsCapture(zone)` не ждёт 25 с, если работник уже на объекте |
| `titanor-time-app/lib/i18n/worker.ts` | `statusZoneNearBoundary`, `gpsAccuracyModerate`, тексты «отметка будет проверена» (EN + RU) |
| `titanor-time-app/components/attendance-policy/PolicyForm.tsx` | пояснение в «Правилах учёта»: модель «весь круг внутри/снаружи», рекомендуемое 250, потолок 250, «75 соблюдается, пока стоит» (EN/RU) |

### Тесты
| Файл | Лейн | Что |
|---|---|---|
| `titanor-time-app/scripts/_test-gps-confidence-zone.ts` | unit | чистая классификация (случаи 1–8), потолок 250 поверх policy, форма detail |
| `titanor-time-app/scripts/_test-gps-confidence-zone-sync.ts` | db | online (route `performCheckIn`) == offline (`/sync`); идемпотентный ре-sync без дублей |
| `titanor-time-app/scripts/_test-worker-gps.ts` | unit | +8 проверок: `evaluateZoneProximity` 4 состояния, `hasConfidentInsideFix`, ранний выход `captureGpsSnapshot` |
| `titanor-time-app/scripts/test-manifest.json` | — | 2 новые записи (109 всего) |

**Миграций нет.** Схема без изменений (`@default(75)` не трогали). `CompanyAttendancePolicy.maxGpsAccuracyMeters`
уже допускает 250 (CHECK 10..5000, миграция `20260828050000`).

---

## 5. Обязательные тесты (ТЗ) — сопоставление

| № | Условие | Ожидание | Где | Итог |
|---|---|---|---|---|
| 1 | d=550, r=900, acc=128.9 | `VERIFIED_INSIDE`, исключения нет | `_test-gps-confidence-zone.ts` #1; `-sync.ts` INSIDE | PASS |
| 2 | d=730, r=650, acc=3.2 | `VERIFIED_OUTSIDE`, нарушение видно | `_test-gps-confidence-zone.ts` #2 | PASS |
| 3 | d=820, r=900, acc=128.9 | `NOT_VERIFIED`, ручная проверка | `_test-gps-confidence-zone.ts` #3; `-sync.ts` NEAR_BOUNDARY | PASS |
| 4 | d=100, r=900, acc=251 | `LOW_ACCURACY`, ручная проверка | `_test-gps-confidence-zone.ts` #4 | PASS |
| 5 | d + acc = r | `VERIFIED_INSIDE` | `_test-gps-confidence-zone.ts` #5 | PASS |
| 6 | d − acc > r | `VERIFIED_OUTSIDE` | `_test-gps-confidence-zone.ts` #6 | PASS |
| 7 | approximate/cached внутри | не подтверждать авто | `_test-gps-confidence-zone.ts` #7; `_test-gps-approximate-sync.ts` | PASS |
| 8 | нет координаты | причины и очередь сохранены | `_test-gps-confidence-zone.ts` #8 | PASS |
| 9 | online == offline sync | одинаковый результат | `_test-gps-confidence-zone-sync.ts` | PASS |
| 10 | повторная синхронизация | нет дубля ClockEvent/Exception | `_test-gps-confidence-zone-sync.ts` | PASS |

---

## 6. Результаты регрессии (disposable-БД)

_Заполняется по завершении прогонов._

- typecheck: **PASS**
- lint: _—_
- `next build`: _—_
- unit: **19/19 PASS** (в т.ч. новый `_test-gps-confidence-zone.ts` 22/22, `_test-worker-gps.ts` 41/41, `_test-worker-clock-panel.ts` 55/55)
- db: _—_
- scheduler: _—_
- browser manifest: _—_
- offline / PWA / restart-persistence: _—_
- существующие GPS/geofence: `_test-gps-accuracy-threshold`, `_test-gps-exception-detail`, `_test-gps-approximate-sync`, `_test-checkin-never-blocked`, `_test-attendance-presence`, `_test-bulk-ack-gps` — _—_
- ADMIN/SUPER_ADMIN проверка политики: `_test-*policy*` — _—_
- мобильные скриншоты Android / iPhone — _—_

---

## 7. Подтверждения (ТЗ)

- **Настоящий `OUTSIDE_GEOFENCE` сохранён.** Предикат `VERIFIED_OUTSIDE` (`distance − accuracy >
  radius`) тождественен прежнему. `OUTSIDE_GEOFENCE_CHECKIN` / `OUTSIDE_GEOFENCE_CHECKOUT` и их
  обработка не тронуты (`_test-checkin-never-blocked.ts`, `_test-gps-confidence-zone-sync.ts` OUTSIDE).
- **Ретроактивных изменений нет.** Меняется только классификация **новых** событий. Ни один старый
  `ClockEvent`, `AttendanceException`, `ClockShift`, час, табель или назначение не читается и не
  пишется. Исключение со скриншота не трогается — код нигде не закрывает существующие исключения.
- **Схема БД без изменений**, миграций нет, `prisma migrate status` на шаблоне чистый.

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

- **Commit SHA:** _<заполнить после коммита>_
- **Candidate image:** _<titanor-time-app:gps-conf-… — собрать при отдельном разрешении>_
- **Тип:** web-only swap, **без миграции** (схема 102 неизменна).
- **Rollback:** вернуть предыдущий образ (`titanor-time-app:redesign-4c282ba`) тем же web-swap;
  схему не трогать; настройку `maxGpsAccuracyMeters` откатывать отдельно (раздел 8.6), если её уже
  меняли. Контейнер `titanor-time-prod-app-pre-4c282ba` — как есть.

**Развёртывание — только после отдельного письменного подтверждения владельца.**
