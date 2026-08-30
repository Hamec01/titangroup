# R08 — GPS encrypted archive + safe retention (Titanor Time)

- **Основание:** production release roadmap R08, ТЗ §9 (+ §10.2 backup bundle). Закрывает блокер
  **B09** (нет долговременного зашифрованного архива координат до удаления raw).
- **Дата:** 2026-08-30.
- **Не затронуто:** production Titanor Time, публичный сайт, Caddy, DNS, Cloudflare. Одна аддитивная
  миграция (**98** — `GpsArchiveDay`). Бизнес-логику клок-ина/табелей не трогали.
- **Статус:** **DEPLOYED + PASS 2026-08-30.** Пилот `t97-pilot-app` + `t97-pilot-scheduler` на
  `titanor-time-app:t97-pilot-6a47ed3`, DB **98/98**, оба `healthy`, restarts 0, `/api/ready`
  `schema:current`. Первый ручной прогон архива (владелец): **5 sealable дней (2026-08-24…28)
  written → 5/5 off-box → 5 VERIFIED, 0 FAILED**; файлы в
  `/mnt/250gb/titanor-time-foundation/gps-archive-store/gps-archive/2026/08/`. Scheduler retention:
  `retentionOutcome:ok retentionDeleted:0` (raw GPS >90 дн на пилоте нет). systemd
  `titanor-time-gps-archive@pilot.timer` — `enabled`. Rollback-контейнеры `-pre-6a47ed3` сохранены
  (по указанию владельца). Production не тронут. См. §5b.
- **Проверки кода:** 5 новых test-файлов (~100 assert) + переработаны `_test-attendance-presence` /
  `_test-retention-pacing`; CI зелёный.
- **Решения владельца (fork):** host-скрипт + staging (как R01 backup); отдельный
  `GPS_ARCHIVE_ENCRYPTION_KEY` (не `PERSONAL_DATA_ENCRYPTION_KEY`); seal margin 2 дня; поздний
  offline-sync за sealed-день → amendment-файл, не переписываем основной.
- **Commits:** `9bcf16f` (миграция 98) · `19544cc` (`lib/gps-archive`) · `f071482`
  (`lib/gps-archive-run`) · `5feba91` (retention gate) · `07cb4ed` (runner + `.runtime/gps-archive.cjs`)
  · `7253bf9` (host-скрипт + systemd) · `64070fc` (backup bundle) · `506321e` (e2e).

---

## Итог по ТЗ §9

| требование | статус |
|---|---|
| ежедневный append-only export новых GPS records | ✅ systemd-таймер `titanor-time-gps-archive@` (05:10 UTC); каждый запуск дописывает новые sealed-дни, никогда не переписывает существующий `.enc` |
| ClockEventLocation + ShiftPresenceSample с business context | ✅ `collectGpsDay` join'ит `ClockEvent` — operationType, effectiveAt, siteId, assumedSiteId, geofenceVersionId, gpsVerification, gpsUnavailableReason, isApproximate + age-поля, capturedOffline, channel; presence — openShiftId, insideGeofence |
| структурированный JSONL внутри зашифрованного + сжатого архива | ✅ `packArchive` = gzip(9) → AES-256-GCM; blob `TGPSA|ver|iv(12)|ct|tag(16)`; путь `gps-archive/YYYY/MM/YYYY-MM-DD[.rNN].jsonl.gz.enc` |
| manifest, record counts, диапазон дат, SHA-256 | ✅ `<day>.jsonl.gz.enc.manifest.json` — schemaVersion, format, recordCount + разбивка, coveredThroughCreatedAt, plaintextSha256 + байты, ciphertextSha256 + байты, relativePath, builtAt. Плюс backup-bundle `gps-archive-manifest.json` (все дни) |
| ключ отдельно от архива, не в логах | ✅ `GPS_ARCHIVE_ENCRYPTION_KEY` только в `app.env` (host, gitignored); архив на `/mnt/250gb`. Runner/скрипт/ledger никогда не пишут ключ или координаты в логи/БД/отчёты |
| idempotency + защита от пропусков/дубликатов | ✅ ledger `GpsArchiveDay(archiveDate, revision)`; `coveredThroughCreatedAt` watermark по server-insert времени; повторный запуск переписывает только не-VERIFIED ревизию, VERIFIED неизменяемы (trigger) |
| удалять raw >90 дней только после archive PASS + verify | ✅ `runAttendanceLocationRetention` удаляет строку, только если её UTC reading-день полностью VERIFIED и нет строки за день позже watermark. Плюс DB-trigger `trg_clock_event_location_retention_delete_guard` (90-дневный пол) не изменён |
| при ошибке архива retention останавливается, данные остаются | ✅ WRITTEN/FAILED/нет архива/pending amendment → день держится. Нет/битый `GPS_ARCHIVE_ENCRYPTION_KEY` → retention не удаляет НИЧЕГО (`gateSkippedReason: 'skipped_no_archive_key'`) |
| GPS archive manifest в общий backup bundle | ✅ `backup-titanor-time.sh` → `gps-archive-manifest.json` (guarded `to_regclass`), в `SHA256SUMS`; `restore-test` проверяет валидный JSON |
| обновить privacy/retention documentation + owner-facing policy | 🟡 §«Политика хранения» ниже + `06_DATABASE_INFRASTRUCTURE.md` §12 обновлены. **Текст уведомления работников + политика обработки перс. данных утверждает ответственное лицо Titanor** (внутреннее приложение фирмы, не блокер; см. Owner action items) |

**PASS-критерий R08** (архив расшифровывается в disposable проверке, counts совпадают, failure
simulation сохраняет исходные DB records) — **выполнен**: `_test-gps-archive-e2e.ts` делает полный
цикл и достаёт точные координаты удалённых строк из off-box `.enc`; `_test-gps-retention-gate.ts`
+ `_test-gps-archive-runner.ts` покрывают failure-симуляции.

---

## 1. Модель данных (миграция 98 — `9bcf16f`)

`GpsArchiveDay` — операционный ledger, один ряд на sealed UTC reading-день (bucket по
`ClockEvent.effectiveAt` / `ShiftPresenceSample.capturedAt`). `revision` 0 — основной файл; поздний
offline-sync за уже sealed-день → revision 1,2,… (amendment, основной файл не трогаем).
`coveredThroughCreatedAt` = максимальное server-insert время, попавшее в эту ревизию — по нему
следующий запуск понимает, что за день ещё не заархивировано.

- `status` `WRITTEN` → `VERIFIED` (не регрессирует) / `FAILED` (errorCode; raw за день остаётся).
- CHECK: неотрицательные counts/revision; не-FAILED ряд обязан нести оба SHA-256 + байты + путь +
  `writtenAt`; `verifiedAt` присутствует ⟺ status VERIFIED.
- Trigger `trg_gps_archive_day_verified_immutable`: VERIFIED-ряд нельзя ни удалить, ни перевести в
  другой статус.

**Bucket по reading-дню, а не по server-insert-дню:** архив «за 15-е» физически содержит все
показания за 15-е (аудитор берёт один файл). Offline-sync за 15-е, пришедший 20-го, попадает в
amendment `2026-01-15.r01…`. `createdAt` — только archive-safe курсор внутри дня, не bucket-ключ.

## 2. Компоненты

| файл | роль |
|---|---|
| `lib/gps-archive.ts` | чистое ядро: key loader (fail-closed `isGpsArchiveKeyConfigured`), детерминированный sorted-key JSONL, `packArchive`/`unpackArchive` (gzip+GCM, tamper/wrong-key → throw), `buildDayManifest` (counts+hashes, никогда координат), `archiveRelativePath` |
| `lib/gps-archive-run.ts` | DB: `listSealableDays` (new/retry/amendment/inside-margin/done), `collectGpsDay` (createdAt-границы, детерминированный порядок), ledger helpers |
| `lib/gps-archive-runner.ts` | `runGpsArchiveWrite` (collect→pack→staging→self-verify→WRITTEN, пишет `_pending-offbox.json`), `runGpsArchivePromote` (по `_offbox-verified.json` host'а: off-box sha == ledger, staging sha == ledger, decrypt, plaintext sha, counts → VERIFIED, иначе FAILED) |
| `scripts/run-gps-archive.ts` → `.runtime/gps-archive.cjs` | тонкий CLI `write` / `promote`; exit 3 fail-closed / 2 bad-mode / 1 partial; только structured JSON-строки |
| `lib/attendance-location-retention.ts` | archive-gated DELETE + `unarchivedOldDayCount` диагностика + `gateSkippedReason` |
| `ops/titanor-time/gps-archive-titanor-time.sh` | host-оркестратор: flock, fail-closed (ключ в env-файле + `/mnt/250gb` mounted), write-container → sync off-box + SHA-256 verify → promote-container → prune staging |
| `ops/titanor-time/systemd/titanor-time-gps-archive@.{service,timer}` + `-failed@.service` + `gps-archive-pilot.env.example` | ежедневный запуск (05:10 UTC), маркер-файл при сбое (без SMTP), параметризовано pilot/prod |
| `ops/titanor-time/backup-titanor-time.sh` / `restore-test-…sh` | `gps-archive-manifest.json` в bundle + проверка |

## 3. Поток (host-скрипт)

```
1. WRITE    docker run --rm --network <net> --env-file app.env
              -e GPS_ARCHIVE_STAGING_DIR=/staging -v <host-staging>:/staging
              node .runtime/gps-archive.cjs write
            → <staging>/gps-archive/YYYY/MM/<day>[.rNN].jsonl.gz.enc + .manifest.json
            → GpsArchiveDay = WRITTEN;  <staging>/gps-archive/_pending-offbox.json
2. SYNC     host: для каждого pending-дня cp staging→/mnt/250gb, sha256sum off-box == recorded?
            → <staging>/gps-archive/_offbox-verified.json (только совпавшие)
3. PROMOTE  docker run … node .runtime/gps-archive.cjs promote
            → для каждого confirmed-дня: off-box sha == ledger, staging sha == ledger, decrypt,
              plaintext sha == ledger, clock/presence counts == ledger → GpsArchiveDay = VERIFIED
4. PRUNE    staging .enc старше TT_GPS_KEEP_STAGING_DAYS (21) и присутствует off-box → удалить
```

Retention (в scheduler'е, отдельный шаг цикла, R06-A pacing 24h) читает тот же ledger и удаляет
raw только за полностью-VERIFIED дни.

## 4. Проверки

| файл | lane | assert | что |
|---|---|---:|---|
| `_test-gps-archive.ts` | unit | 32 | key fail-closed, детерминизм JSONL, pack/unpack round-trip, tamper/wrong-key/bad-magic, manifest без координат |
| `_test-gps-archive-run.ts` | db | 20 | listSealableDays (new/retry/amendment/inside-margin/done), collectGpsDay границы + late-offline, ledger helpers |
| `_test-gps-retention-gate.ts` | db | 17 | delete только за VERIFIED+covered; WRITTEN/FAILED/amendment держит; нет ключа → 0; 90-дневный пол + DB-trigger; keyless→restore |
| `_test-gps-archive-runner.ts` | db | 19 | write+ledger+self-verify, `.enc` расшифровывается в точности в строки БД, promote gated на off-box список, tamper/wrong-sha → FAILED, no key → refuse |
| `_test-gps-archive-e2e.ts` | db | 13 | полный цикл + восстановление точных координат удалённых строк из off-box `.enc` + failure-симуляция сохраняет raw |

Плюс: `_test-attendance-presence` (23/23) переработан под gate; `_test-retention-pacing` (5/5)
совместим. `.runtime/gps-archive.cjs` собирается (lint), exit 2/3 пути проверены вручную.

## 5. Политика хранения (для privacy-документа)

- **Операционная БД:** точные координаты (`ClockEventLocation`, `ShiftPresenceSample`) хранятся
  **90 дней** с момента записи на сервер, затем удаляются retention-джобой — **только после**
  подтверждённого архивирования соответствующего дня.
- **Долговременный архив:** ежедневный, **зашифрованный (AES-256-GCM) и сжатый**, хранится на
  отдельном проверенном off-box хранилище (`/mnt/250gb`, Contabo Object Storage; **US-central** —
  открытый GDPR-вопрос трансграничной передачи, решается владельцем до R14). Архив **не монтируется
  в web-контейнер**, прямого HTTP-доступа нет, ключ хранится отдельно.
- **Срок архива:** по решению владельца — **бессрочно**. Следовательно фактический срок хранения
  точных координат — **бессрочный**, и это должно быть отражено в уведомлении работников и в
  политике обработки персональных данных (ТЗ §9.5).
- **Читаемый экспорт (TXT/CSV):** создаётся только по явному запросу уполномоченного оператора из
  защищённого архива, с ограниченным сроком жизни и записью в audit — **отдельная задача (R08.1 /
  admin-инструмент), в этот заход не входит.**

## 5a. Disposable-verify на restored pilot dump — PASS 17/0 (2026-08-30)

Образ `titanor-time-app:t97-pilot-6a47ed3` (792 MB, revision `6a47ed3`). Скрипт
`ops/titanor-time/deploy-pilot-6a47ed3.sh` (+ байт-копия `/home/deploy/app-data/t97-pilot/
deploy-6a47ed3.sh`). Проверка на `pg_dump` пилота, восстановленном в disposable PG16 (пилот
только читался):

1. restored DB на 97 миграций → `migrate deploy` 97→98, 0 failed; `GpsArchiveDay` + trigger.
2. `/api/ready` = 200 `schema:current` applied=98.
3. seeded 3 старых (>90 дн) `ClockEventLocation` на reading-день −100 дн, известные координаты.
4. `.runtime/gps-archive.cjs write` → 6 sealable дней (5 реальных пилотных + seeded), все WRITTEN,
   self-verify прошёл.
5. host-sim off-box sync (6/6 по SHA-256) → `promote` → 6 VERIFIED.
6. расшифровка off-box `.enc` за seeded-день → ровно 3 записи, координаты
   `61.490001/61.490002/61.490003` совпадают.
7. scheduler retention (ключ есть) → `retentionOutcome:ok retentionDeleted:3` — удалены ровно 3
   seeded (архивированных, >90 дн) строки, 31 недавняя пилотная строка не тронута.
8. keyless прогон → `retentionOutcome:skipped_no_archive_key retentionDeleted:0`, ничего не удалено.
9. rollback-образ `t97-pilot-8724480` против схемы 98 → `/api/ready` 200 `schema:ahead` (толерантен).

## 5b. Пилот-деплой — 2026-08-30, PASS

`bash /home/deploy/app-data/t97-pilot/deploy-6a47ed3.sh` (владелец):
- backup on-box + off-box (с `gps-archive-manifest.json`), `migrate deploy` 97→98 (0 failed,
  `GpsArchiveDay` + trigger + пусто);
- swap app+scheduler на `t97-pilot-6a47ed3`; scheduler-pre exited 0 (graceful — без stale lease);
- verify: `/api/ready` 98/98 `schema:current`; `.runtime/gps-archive.cjs` в образе, `bogus`→exit 2,
  empty-key `write`→exit 3; retention-шаг `retentionOutcome:ok`; R07-A регрессия (заголовки,
  DB-rate-limit, malformed-UUID) — ок; production baseline не изменён.
- rollback-контейнеры `t97-pilot-{app,scheduler}-pre-6a47ed3` (на `t97-pilot-8724480`) — **сохранены**.

Первый ручной прогон архива + `systemctl enable --now titanor-time-gps-archive@pilot.timer`
(владелец): 5 sealable дней → written → off-box sync 5/5 (SHA-256) → promote → **5 VERIFIED,
0 FAILED**. `GpsArchiveDay`: 2026-08-24(2/0) · 08-25(2/0) · 08-26(6/0) · 08-27(8/0) · 08-28(6/2)
[clock/presence]. Таймер `enabled`, следующий запуск ~05:10 UTC.

## 6. Owner action items — статус

1. **Ключ:** ✅ `GPS_ARCHIVE_ENCRYPTION_KEY` добавлен в `/home/deploy/app-data/t97-pilot/app.env`
   владельцем 2026-08-30 (43-символьный base64 → 32 байта; проверено). Не коммитить, не класть в
   backup/отчёт.
2. **Развернуть образ с миграцией 98:** ✅ образ `titanor-time-app:t97-pilot-6a47ed3` собран,
   disposable-verify PASS (§5a). Запустить: `bash /home/deploy/app-data/t97-pilot/deploy-6a47ed3.sh`
   (fail-closed, авто-rollback, prod baseline guard; агент не запускает). Скрипт проверяет наличие
   ключа, миграцию 98, `GpsArchiveDay` + trigger, `.runtime/gps-archive.cjs` в образе + fail-closed,
   retention-шаг `retentionOutcome:ok`, регрессию R07-A.
3. **Установить systemd** (root): ✅ выполнено владельцем 2026-08-30 —
   `titanor-time-gps-archive@pilot.timer` `enabled`, первый ручной прогон PASS (5/5 VERIFIED).
4. **Disposable-verify на pilot dump** (агент): ✅ PASS 17/0 — §5a.
5. **Написать и показать работникам** текст об удержании координат (90 дней БД + бессрочный
   зашифрованный архив) — уведомление + политика перс. данных. 🟡 **открыто (не блокер): внутреннее
   приложение фирмы, текст утверждает владелец бизнеса / ответственное лицо Titanor.**

## 7. Осознанно не сделано / follow-up

- **R08.1** — admin-инструмент «читаемый TXT/CSV экспорт из архива по запросу» (ТЗ §9.4): magic-byte
  список полей, ограниченный TTL файла, audit-запись. Отдельная задача.
- Retention-джоба логирует `retentionOutcome` / `retentionDeleted` / `retentionPresenceDeleted` —
  `unarchivedOldDayCount` пока только в возвращаемом объекте, не в heartbeat/health. Вынести в
  scheduler health как отдельный сигнал — можно при R09.
- US-регион off-box: GDPR-решение владельца (accept vs EU-bucket) — до R14, меняется только путь.

## 8. Дальше

- **R08 закрыт (DEPLOYED + PASS).** B09 закрыт. Rollback-контейнеры `-pre-6a47ed3` сохранены до
  разрешения владельца на удаление.
- Открыто (вне R08, не блокер): текст уведомления работников + политика перс. данных — внутреннее
  приложение фирмы, утверждает владелец бизнеса / ответственное лицо Titanor; R08.1
  (читаемый TXT/CSV экспорт из архива по запросу, ТЗ §9.4); `unarchivedOldDayCount` в scheduler
  health — при R09.
- Следующий этап — по указанию владельца: **R09 (UX WORKER/FOREMAN/ADMIN)** + свёртка R07-A.1
  (guard rollout ~130 маршрутов), либо R10 по roadmap.
