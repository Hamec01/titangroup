# Meyer Turku Shipyard — галочка «часто нет GPS-сигнала» (подготовлено, НЕ применено)

- **Основание:** `fixroad.md` F03 / `R15_ATTENDANCE_EXCEPTIONS_REVIEW_RU.md` §4 п.1.
- **Указание владельца (2026-09-04):** «готовь настройку „часто нет GPS-сигнала" только для этого
  объекта, но не применяй без отдельного подтверждения».
- **Статус:** артефакт готов. **На production ничего не менялось.** Ждёт отдельного подтверждения.

---

## 1. Что это за настройка

Поле `WorkSite.gpsOftenUnavailable` (уже в схеме с T14, 2026-08-29 — **миграция не нужна**).

Когда оно `true` для объекта, логика `lib/attendance-sync.ts` (`createGpsNotVerifiedException`):
**новое** исключение `GPS_NOT_VERIFIED`, у которого телефон **вообще не дал координату**
(чистый `TIMEOUT` или `POSITION_UNAVAILABLE`), на этом объекте создаётся **сразу закрытым**
(`RESOLVED`, `ACKNOWLEDGE_AS_VALID`, системный актор) вместо попадания в очередь `/admin/review`.
Пишется audit `ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID` (`auto: GPS_OFTEN_UNAVAILABLE_SITE`).

### Что НЕ меняется
- **Существующие** открытые исключения — остаются как есть (11 «GPS не подтверждён» по Meyer нужно
  всё равно принять администратором вручную, разово, по фильтру объекта).
- `LOW_ACCURACY` (координата есть, но грубая) — **не** авто-принимается.
- `OUTSIDE_GEOFENCE_CHECKIN/CHECKOUT` — координата хорошая, работник измеримо в другом месте —
  **не** затрагивается (случаи Ruslan #1003 ~1 км за геозоной при уходе остаются в очереди).
- Часы, расчёт, replay, geofence-версии, радиус — не трогаются.

Эффект — **только на будущие** отметки. Убирает бóльшую часть будущего шума «GPS не подтверждён»
с верфи (корпус судна / крытый цех — GPS там штатно не ловит).

---

## 2. Целевая строка (проверено read-only на prod 2026-09-04)

| поле | значение |
|---|---|
| `id` | `b38b9b64-cddc-472c-a617-9e89c2742e1e` |
| `name` | `Meyer Turku Shipyard` |
| `active` | `true`, `finishedAt` = NULL |
| `gpsOftenUnavailable` | **`false`** → станет `true` |
| `version` | **`3`** → станет `4` |

Два других объекта prod (**Pipe and Co** v2, **UKI** v2) — **не трогаются**. Проверка в скрипте
падает с ROLLBACK, если на prod окажется больше одного объекта с флагом.

---

## 3. Как применить (после подтверждения владельца) — два равнозначных пути

### Путь A — админ-UI (предпочтительно, если есть браузерная сессия админа)
1. Войти под `oleksandr` (SUPER_ADMIN) или `yurii` (ADMIN).
2. `Настройки → Объекты → Meyer Turku Shipyard → Редактировать`.
3. Поставить галочку **«Здесь часто нет сигнала GPS (офлайн-отметки без координат принимаются
   автоматически — для корпусов судов, крытых цехов)»**.
4. Сохранить. → `PATCH /api/admin/sites/b38b9b64-…` `{version:3, gpsOftenUnavailable:true}` →
   поле записано, `version` → 4, audit `SITE_UPDATED`. **Это обычное админ-действие, не деплой.**

### Путь B — psql (если браузерной сессии нет)
```
docker exec -i titanor-time-prod-db psql -U titanor_time_prod -d titanor_time \
  -v ON_ERROR_STOP=1 -v actor='ab393eb7-1db2-44fd-98b4-cde3593370f1' \
  < ops/titanor-time/r15-d7/meyer-gps-often-unavailable.sql
```
(`ab393eb7…` = `oleksandr`, ACTIVE SUPER_ADMIN. Или `77b75c72-4676-4f4e-bd38-4faeb3b413d2` =
`yurii`, ACTIVE ADMIN.) Одна транзакция: PRECHECK (актор активен и админ; строка = Meyer, флаг
`false`, version 3, не finished) → UPDATE + `SITE_UPDATED` audit (та же форма `afterValue`, что у
роута) → POSTCHECK (флаг `true`, version 4, ровно 1 свежий audit, ровно 1 объект с флагом на prod)
→ COMMIT. Любое несоответствие → RAISE EXCEPTION → ROLLBACK, ничего не записано.

Оба пути дают идентичный результат (поле + `version+1` + один `SITE_UPDATED` audit).

---

## 4. Проверка после применения (read-only)
```
SELECT name, "gpsOftenUnavailable", version FROM "WorkSite" ORDER BY name;
--  Meyer Turku Shipyard | t | 4
--  Pipe and Co          | f | 2
--  UKI                  | f | 2
```
Далее администратор разово принимает текущие 11 открытых «GPS не подтверждён» по Meyer
(фильтр по объекту в `/admin/review`) — новые уже не будут копиться.

---

## 5. Отдельно (НЕ в этой задаче)
- Радиус геозоны Meyer = **650 м** (версия 1). F03 п.2: Ruslan #1003 трижды ~1 км за краем при
  уходе с хорошим GPS — либо привычка отмечаться от проходной, либо геозона мала. Это **отдельное
  решение** (расширение геозоны новой версией + вопрос работнику), сюда не входит.
