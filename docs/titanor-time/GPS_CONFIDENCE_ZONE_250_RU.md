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
| `titanor-time-app/lib/i18n/worker.ts` | `statusZoneNearBoundary` («Около границы — на проверке»), `gpsAccuracyModerate` («±N м — приемлемая»), `gpsAccuracyPoor`/`statusZoneLowAccuracy` → «…проверит администратор / на проверке» (EN + RU) |
| `titanor-time-app/app/globals.css` | `.wk-status-grid p` — колонки `auto auto minmax(0,1fr)` + `strong { text-align:right; overflow-wrap:anywhere }`, чтобы длинная строка зоны не наезжала на подпись «Зона» |
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

## 6. Результаты регрессии (disposable-БД, 2026-09-07)

| Проверка | Итог |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run lint` (prisma validate / format / manifest / migration-inventory / bundles / secret-scan) | **PASS** |
| `next build` (standalone) | **PASS** — компилируется, `.next/standalone` собран |
| unit lane | **19/19 PASS** — вкл. новый `_test-gps-confidence-zone.ts` 22/22, `_test-worker-gps.ts` 41/41, `_test-worker-clock-panel.ts` 55/55 |
| db + scheduler lane | **67/67 PASS** (`node scripts/run-tests.mjs db`, disposable PG16, шаблон мигрирован до 102, каждому тесту свой клон) |
| ↳ новый `_test-gps-confidence-zone-sync.ts` | **PASS** — online (`performCheckIn` route) == offline (`/sync`) для INSIDE/NEAR_BOUNDARY/OUTSIDE; идемпотентный ре-sync без дублей ClockEvent/AttendanceException |
| ↳ существующие GPS/geofence | **PASS** — `_test-gps-accuracy-threshold`, `_test-gps-exception-detail`, `_test-gps-approximate-sync`, `_test-checkin-never-blocked`, `_test-attendance-presence`, `_test-bulk-ack-gps`, `_test-site-gps-flag`, `_test-map-gps`, `_test-gps-offline-resilience-schema` |
| ↳ Check In/Out/Switch | **PASS** — `_test-pilot-pair-orphan` (offline pair/orphan), `_test-checkin-never-blocked` (T17 outside-geofence), `_test-abandoned-shift-auto-close` |
| ↳ scheduler | **PASS** — `_test-scheduler-lease`, `_test-scheduler-diagnostics`, `_test-scheduler-health` (unit) |
| ↳ ADMIN/SUPER_ADMIN политика | **PASS** — `_test-gps-confidence-zone-sync` меняет `maxGpsAccuracyMeters` через `updateCompanyAttendancePolicy` (SUPER_ADMIN), аудит `ATTENDANCE_POLICY_UPDATED`; `_test-gps-accuracy-threshold` (диапазон + DB CHECK + аудит) |
| мобильные скриншоты Android (393×851) + iPhone (390×844) | **сделаны** — worker clock (INSIDE / NEAR_BOUNDARY / weak), admin policy, admin exception detail — см. §6a |
| полный browser manifest (Chromium) · offline/PWA · restart-persistence | **не запускался в этой сессии** — см. §6b |

### 6a. Скриншоты (превью на копии данных, схема 102, `maxGpsAccuracyMeters = 250`)

Поднят standalone-сервер на disposable-БД (`gcz_preview` на throwaway PG16, 102 миграции), засеян
1 SUPER_ADMIN + 1 WORKER + объект с геозоной 900 м + пограничное исключение (d≈819 м, acc 128,9).

- **`worker-android-inside` / `worker-iphone-inside`** — точка 550 м / ±129 м: зона **«На объекте»**
  (зелёный), точность **«±129 м — приемлемая»**. Раньше это была «слабый сигнал» + ждать 25 с +
  исключение `LOW_ACCURACY`.
- **`worker-android-near-boundary` / `worker-iphone-near-boundary`** — точка 820 м / ±129 м: зона
  **«Около границы — на проверке»** (янтарный), точность «±129 м — приемлемая».
- **`worker-android-weak` / `worker-iphone-weak`** — ±320 м: зона **«Слабый сигнал GPS — на
  проверке»**, точность «±320 м — слабый сигнал, отметку проверит администратор», кнопка «Уточнить».
- **`admin-policy`** — поле «Максимальная точность GPS для автоматической проверки геозоны» = 250 +
  новое пояснение про «весь круг внутри/снаружи».
- **`admin-exception-boundary`** — заголовок «GPS не подтверждён», summary *«GPS accuracy circle
  crosses the site boundary — manual check needed»*, в «Дополнительных сведениях» — **«Погрешность
  GPS пересекает границу объекта: Да»**, кнопки «Подтвердить как верное» / «Снять сигнал» (ручная
  проверка сохранена). Мини-карта: круг погрешности пересекает границу геозоны.

### 6b. Что осталось до deploy

**Полный контейнерный browser-acceptance (`ops/titanor-time/run-browser-acceptance.sh`,
per-test-изоляция) + `run-restart-persistence.sh` в этой сессии не запускались** — они требуют
собранного release-образа Docker, а сборка образа (`npm ci` + `next build` в контейнере) на этом
хосте при живом production и ~0.9 ГБ свободной RAM — неоправданный риск (см. память
`feedback_shared_host_memory_pressure`). Это тот же порядок, что и при релизе дизайна: браузерный
lane гоняется против **candidate-образа**, который собирается отдельным разрешённым шагом.

Риск там низкий: изменения не трогают offline-outbox, service worker, `sync-runner`, IndexedDB-схему
и материализацию — только чистую классификацию GPS и клиентские подсказки. Плечо Check In/Out/Switch
+ online/offline-паритет уже покрыто db-lane (`_test-pilot-pair-orphan`, `_test-checkin-never-blocked`,
`_test-gps-confidence-zone-sync`).

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

- **Ветка:** `fix/gps-confidence-zone-250` · **worktree:** `/home/deploy/projects/titanorgroup-worktrees/gps-confidence-zone`
- **Commit SHA:** `6256424` (`feat(gps): confidence-zone geofence check…`) + докстроки/скриншот-фиксы следующим коммитом.
- **Candidate image:** ещё не собран. Собрать `titanor-time-app:gps-conf-<sha>` из этой ветки
  **отдельным разрешённым шагом** (сборка образа = риск для RAM живого хоста), затем прогнать против
  него полный browser-lane + restart-persistence (§6b).
- **Тип развёртывания:** web-only swap, **без миграции** (схема 102 неизменна, schema.prisma не тронут).
- **Порог `maxGpsAccuracyMeters`:** на production остаётся **75** до отдельного rollout-действия
  (раздел 8). Код при 75 ведёт себя честно (`min(75, 250) = 75`).
- **Rollback кода:** вернуть предыдущий образ (`titanor-time-app:redesign-4c282ba`) тем же web-swap
  (`docker stop -t 30` + `rename`, не `rm -f`); схему не откатывать; контейнер
  `titanor-time-prod-app-pre-4c282ba` — как есть. Если порог уже меняли на 250 — откатывать его
  отдельно PATCH-запросом (раздел 8.6); это не трогает данные.

**Развёртывание — только после отдельного письменного подтверждения владельца.** После разработки
и disposable-проверки — остановка.
