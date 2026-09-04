# Titanor Time — финальный аудит и FIX ROAD

- **Срез аудита:** 2026-09-03 21:54 UTC.
- **Git:** `feature/titanor-time-foundation` @ `6e6dc12`, до создания этого документа рабочее дерево было чистым, `origin` совпадал.
- **Production web:** `titanor-time-app:d7f-d216482`, контейнер healthy, restart count 0.
- **Production scheduler:** `titanor-time-app:r14-release-1416503`, healthy, успешный тик раз в минуту, `failed: 0`.
- **Схема:** `current`, 100/100 migrations, failed migrations 0.
- **Метод:** последние отчёты Deploy A→F считаются финальным фактом. Старые документы использованы только для поиска забытых обещаний и противоречий. Production проверялся только read-only; тесты выполнялись на disposable PostgreSQL/контейнерах.

## 1. Вердикт специалиста

**P0-дефектов, требующих немедленно откатывать production, не найдено.** Приложение отвечает,
основные данные записываются, scheduler работает, schema/backup/GPS archive находятся в рабочем
состоянии. Deploy F и весь R15-D7 A→F действительно live.

Но **полный R15 owner sign-off и безусловную передачу заказчику пока давать рано**. До этого нужно
закрыть пять P1-gate:

1. исправить три устаревшие browser-фикстуры и получить один полный зелёный release-run;
2. пройти WORKER-путь на реальных iPhone/Safari и Android/Chrome в production;
3. разобрать очередь открытых attendance exceptions и назначить ответственного/SLA;
4. устранить failed backup публичного сайта либо явно вывести его из объёма передачи;
5. привести финальные документы и runbooks к единому фактическому состоянию.

Моё мнение по спорным пунктам D3/D4:

- **D4 2/2 уже сделан.** Табель показывает время перехода, старое/новое место, автора и пояснение,
  что пометка не меняет часы. Это покрыто `_test-t9-worker-card-b` 34/34. Повторно реализовывать D4
  нельзя.
- **D3 по последнему согласованному дизайну закрыт Deploy F** как `/admin/reports/customer`.
  Отдельного измерения «заказчик» в `/admin/reports/sites` сейчас действительно нет, но это уже не
  незакрытый Deploy F. По продуктовой логике новый customer report достаточен для выдачи часов
  заказчику. Расширять site report стоит только если заказчик подтвердит, что ему нужен именно
  site-first расчётный лист с разрезом по заказчикам. В таком случае создать новый ID, например
  **R15-F1**, а не повторно открывать D3.

## 2. Что фактически проверено

### 2.1 Production read-only

| Проверка | Результат |
|---|---|
| `/api/ready` локально и через Caddy | 200, schema `current` 100/100 |
| `/login`, `/reset-password` | 200 |
| `/worker`, `/admin`, оба отчёта без сессии | 307 → `/login` |
| TLS | Let's Encrypt, CN `app.titanorgroup.fi`, действует до 2026-11-29 |
| Security headers | HSTS, nosniff, SAMEORIGIN, Referrer-Policy, Permissions-Policy; `X-Powered-By` не выдаётся |
| web log | ошибок/exception/unhandled/23P01 после deploy не найдено |
| scheduler | последовательные `runnerOutcome: ok`, `failed: 0` |
| Titanor Time scheduled backup | 2026-09-03 PASS, on-box + off-box, 2168 rows, 100 migrations |
| GPS archive | 2026-09-03 PASS, архив дня записан, off-box подтверждён, promoted VERIFIED |
| Диск `/` | 77%, свободно около 35 GiB |

Агрегаты production за 7 дней, без чтения персональных данных:

- 19 Check In и 18 Check Out;
- 15 GPS presence samples;
- 13 новых WORKER-версий табелей;
- 6 табелей `FINAL_APPROVED`, 22 `DRAFT`;
- 12 clock events `VERIFIED_INSIDE`, 9 `VERIFIED_OUTSIDE`, 16 `NOT_VERIFIED`;
- 20 открытых attendance exceptions, из них 16 старше 72 часов.

Это подтверждает, что реальный рабочий контур используется. Одновременно агрегаты не заменяют
ручную проверку поведения PWA на конкретных телефонах.

### 2.2 Код и disposable-тесты

| Проверка | Результат |
|---|---|
| `npm test` | **82/82 PASS**: 18 unit + 59 DB + 5 scheduler |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS: Prisma/schema/test manifest/migration inventory/runtime bundles/secret scan |
| `npm run build` | PASS, Next.js 16.3.3 production build |
| `npm audit --omit=dev` | 0 известных vulnerability |
| `npm audit` полный | 0 известных vulnerability |
| полный browser manifest | **16 PASS / 3 FAIL / 2 dedicated-runner** |
| restart persistence | PASS: seed 84/84, prepare 5/5, verify 18/18 |
| worker dossier browser QA | PASS 31/31; runner запускается только через `bash`, execute bit отсутствует |

Три browser FAIL происходят **до проверки продукта**, на создании некорректной фикстуры:

- `_test-csv-export.ts`;
- `_test-period-time-report.ts`;
- `_test-report-rounding-consistency.ts`.

Все три пытаются создать для одного работника два перекрывающихся назначения с
`isPrimary=true`. Migration 100 правильно отклоняет их constraint
`ex_site_assignment_one_primary_per_period` с SQLSTATE `23P01`. Это дефект тестового контура, не
свидетельство ошибки production API. Однако пока он не исправлен, утверждать «полный test catalog
зелёный» нельзя. Финальный отчёт Deploy F показывал выбранные 9 browser-тестов, а не весь manifest.

## 3. Findings и приоритеты

### P1 — закрыть до передачи заказчику

#### F01. Нет одного полностью зелёного release-gate

**Факт:** полный browser manifest = 16 PASS / 3 fixture FAIL / 2 специальных сценария. Специальные
сценарии отдельно прошли, но три старые фикстуры не совместимы с Migration 100.

**Задание:**

1. Исправить только fixture setup в трёх тестах: либо одно назначение на нужный период, либо два
   непересекающихся primary, либо второе `isPrimary=false` — в соответствии со смыслом сценария.
2. Не отключать constraint и не ловить/маскировать `23P01`.
3. Добавить в единый release-командный путь:
   - 82 unit/DB/scheduler;
   - 19 browser entries общего harness;
   - оставшиеся 2 browser entries через их dedicated runners;
   - typecheck, lint, build.
4. `run-worker-dossier-qa.sh` сделать executable в Git или во всех инструкциях вызывать явно через
   `bash`; предпочтительно исправить mode на `100755`.

**Приёмка:** 19/19 поддерживаемых общим browser harness тестов PASS, 2/2 штатно SKIP-HARNESS и
оба отдельно PASS; никакого отключения Migration 100; итоговая команда имеет ненулевой exit при
любом падении.

#### F02. Не закрыта реальная device acceptance

Автотесты хорошо покрывают IndexedDB, offline shell, replay, GPS contracts и PWA, но не доказывают
поведение разрешений ОС, cold start и восстановление сети на реальном iOS/Android.

**Задание владельцу/приёмщику:** на действительном рабочем аккаунте и реальной смене выполнить:

1. iPhone/Safari: install PWA, Check In с GPS, Check Out, закрыть/открыть PWA.
2. Android/Chrome: тот же путь.
3. На одном устройстве: airplane mode → действие в очередь → полное закрытие PWA → запуск offline
   → возврат сети → автоматический sync без дубля.
4. Проверить ручной ввод незаполненного дня, отправку табеля, возврат администратором, исправление и
   final approval.
5. Сверить результат в admin timeline, timesheet и customer report.

Не создавать фиктивные production-часы ради smoke. Либо использовать реальную смену, либо заранее
согласованный тестовый аккаунт/период с документированным способом нейтрализации данных.

**Приёмка:** короткий протокол с устройством/ОС/временем, PASS/FAIL каждого шага, ссылками на
соответствующие сущности без паролей/GPS-координат/PII в документе.

#### F03. Открытая очередь attendance exceptions не управляется

**Факт:** 20 OPEN, из них 16 старше 72 часов. Типы включают GPS not verified, outside geofence,
orphan checkout, missing checkout и auto-close. Это может быть нормальная бизнес-очередь, но при
передаче она выглядит как необработанные спорные часы.

**Задание:**

- ADMIN просматривает каждое исключение и применяет допустимое действие;
- отдельно проверить, почему исключения старше 72 часов не были разобраны;
- назначить ежедневного ответственного и SLA, например OPEN не старше следующего рабочего дня;
- добавить на owner dashboard возраст старейшего OPEN или уведомление об exceptions старше SLA.

**Приёмка:** нет необъяснённых OPEN старше принятого SLA; каждое оставшееся исключение имеет
владельца/причину; инструкция входит в ежедневный runbook.

#### F04. Failed backup публичного сайта

**Факт:** `titanorgroup-backup.service` находится в состоянии failed с 2026-09-03 03:31 CEST;
последний найденный полный артефакт публичного сайта датирован 2026-08-31. Titanor Time backup и GPS
archive при этом работают и успешно копируются off-box. Причину failed unit текущий пользователь
не может прочитать: root journal/script требуют sudo-пароль.

**Задание root-оператору:** прочитать journal, устранить причину, вручную запустить unit, проверить
checksum и восстановление в disposable-каталог/контейнер. Не считать проблему Titanor Time DB —
это соседний backup публичного сайта.

**Приёмка:** `systemctl is-failed titanorgroup-backup.service` не возвращает failed; свежий on-box и
off-box backup; restore-проверка PASS; следующий timer-run также PASS. Если публичный сайт не входит
в передачу, это должно быть явно записано и назначено другому владельцу, а не оставлено молча.

#### F05. Финальные документы противоречат production

**Факт:** `R15_OBSERVATION_RU.md` всё ещё говорит, что D7 B→F, D4 2/2 и Фаза 3 не завершены;
`R14_CUTOVER_REPORT_RU.md` оставляет только «начать R15»; `IMPLEMENTATION_STATUS.md` и handoff не
содержат финальную картину 3 сентября. Это уже привело к риску повторно поручить закрытую работу.

**Задание:**

- обновить `R15_OBSERVATION_RU.md` по Deploy A→F и результатам этого аудита;
- финализировать `R14_CUTOVER_REPORT_RU.md` ссылкой на R15 и фактические 72h результаты;
- добавить компактную финальную запись в `IMPLEMENTATION_STATUS.md`, не переписывая историю;
- обновить `NEXT_AGENT_HANDOFF_RU.md`, backup/restore и production runbooks;
- зафиксировать единственную терминологию: D3 = Deploy F customer report; потенциальный site-first
  customer split = R15-F1, только после owner decision;
- вынести персональные имена/ручные production-исправления из основного оперативного handoff туда,
  где доступ ограничен.

**Приёмка:** любой новый оператор по четырём документам однозначно видит текущий image, schema,
rollback, открытые P1, ответственных и запрет cleanup; нет одновременно статусов DONE/BACKLOG для
одной задачи.

### P2 — желательно до финальной версии либо явно принять как residual risk

#### F06. Решение по site report × customer

Текущий `lib/site-time-report.ts` и `/admin/reports/sites` фильтруют сегменты только по `siteId` и
агрегируют вместе часы разных `workAreaId`. Новый `/admin/reports/customer` корректно фильтрует по
историческому `workAreaId`, строит секции по заказчику и экспортирует PDF/CSV.

**Рекомендация:** не дублировать функциональность автоматически. Провести 15-минутную демонстрацию
нового customer report заказчику и задать один вопрос: нужен ли второй, site-first документ, где
внутри объекта часы разделены по заказчикам?

Если ответ **нет** — закрыть старую формулировку как superseded Deploy F. Если **да** — R15-F1:

- `workAreaId`/«Без заказчика» в DTO, SQL scope и URL-фильтрах site report;
- бакет `(employeeId, siteId, workAreaId, date)`, округление один раз;
- историческая принадлежность только по сегменту;
- ADMIN и FOREMAN scope без утечки чужих объектов;
- сценарий «один объект, два заказчика, один работник переходит между ними»;
- экран/PDF/CSV totals совпадают до минуты;
- без новой миграции, если анализ схемы не покажет обратного.

#### F07. `capturedOffline` вводит администратора в заблуждение

Worker UI теперь всегда сначала пишет Check In/Out/Switch в IndexedDB outbox и отправляет через
`/attendance/sync`, даже когда сеть доступна. Поэтому все 37 production ClockEvent за 7 дней имеют
`channel=OFFLINE_SYNC` и `capturedOffline=true`, а UI показывает «зафиксировано оффлайн».

Это не ломает расчёт часов, replay или GPS. Но флаг больше не доказывает отсутствие сети в момент
действия.

**Задание:** принять одно из двух решений:

- минимальное: переименовать UI в «отправлено через очередь устройства» и обновить документацию;
- полноценное: хранить отдельный факт `networkAvailableAtCapture`/`wasOfflineAtCapture`, не меняя
  смысл transport channel. Для этого нужен отдельный дизайн совместимости и, вероятно, additive
  migration.

Не переиспользовать молча текущий boolean с новым смыслом: старые записи станут неоднозначными.

#### F08. Deploy-скрипты проверяются только синтаксически

Первая попытка Deploy F дала около 11.5 секунд 503 из-за взаимодействия `set -e` и `curl` внутри
цикла ожидания. Текущий скрипт исправлен, `bash -n` PASS и второй swap прошёл, но постоянного
автотеста state machine/rollback нет.

**Задание:** добавить shell-test с подменёнными `docker`/`curl` для сценариев: ready сразу, несколько
неуспешных poll затем ready, timeout, failed run, trap rollback, занятое rollback-name, неверный
исходный image. Добавить ShellCheck в CI либо контейнеризированный pinned аналог.

#### F09. Нет централизованного operational alerting

Scheduler логируется хорошо, но failed systemd unit обнаружился только ручным аудитом. Disk уже
77%, а очистка правильно заморожена до sign-off.

**Задание:** минимальные алерты на:

- `/api/ready != 200`;
- container unhealthy/restart count > 0;
- scheduler `runnerOutcome != ok` или `failed > 0`/просроченный heartbeat;
- любой `titanor-time-*`/`titanorgroup-backup` failed unit;
- отсутствие свежего on-box/off-box backup;
- disk >80% warning, >90% critical;
- OPEN attendance exception старше SLA.

#### F10. Security hardening backlog

Из 153 API route-файлов только 3 используют общий `guardApiRequest`; остальные в основном имеют
ручные auth/permission/CSRF guards. Эвристический и ручной разбор найденных исключений не обнаружил
открытого mutating endpoint: это maintainability/risk, не доказанная уязвимость.

**Задание:** продолжить R07-A.1 on-touch, без blind codemod; для каждого маршрута negative tests
401/403/CSRF/malformed UUID. Отдельно решить CSP после аудита inline Next scripts/styles. Сейчас CSP
осознанно не заявлен и не является причиной откладывать handoff при принятом residual risk.

#### F11. Зафиксировать список осознанно исключённых функций

В старых design-документах описаны, но в финальный продукт намеренно не вошли как обязательные:

- `TimesheetReviewProposal` / foreman propose-correction;
- отдельная foreman history на `ApprovalAction`;
- читаемый TXT/CSV экспорт из зашифрованного GPS archive (R08.1);
- полный CSP;
- физическое удаление работников/истории.

Перед передачей заказчик должен получить короткий список «есть / нет / как обходится». Это лучше,
чем оставить design-текст, который выглядит как обещание уже поставленной функции.

### P3 — после sign-off

- определить срок хранения старых production/pilot backup и rollback-контейнеров;
- составить точный allowlist для удаления и dry-run объёма;
- удалять данные/volumes/images/build cache только отдельной задачей и после явного разрешения;
- обновить TLS calendar reminder до 2026-11-29 (автопродление Caddy отдельно проверить);
- пересмотреть старые compatibility helpers/legacy routes, но не удалять их в стабилизационном
  окне без потребителя и regression proof.

## 4. Рекомендуемый порядок работ

### Пакет A — Release gate, без production

1. F01: исправить три fixture и execute bit runner.
2. Полный disposable run.
3. Сформировать машинно-читаемый summary с SHA/image tag.

**Стоп-условие:** любой fail — production не менять, owner sign-off не выдавать.

### Пакет B — Operations

1. F04: восстановить backup публичного сайта.
2. F03: разобрать очередь exceptions и определить SLA.
3. F09: поставить минимальные проверки/алерты.
4. Подтвердить очередной автоматический Titanor Time backup + GPS archive.

### Пакет C — Реальная приёмка

1. F02 на iPhone и Android.
2. ADMIN сверяет результат и customer report.
3. Записывается только итог и безопасные идентификаторы, без секретов/координат.

### Пакет D — Документы и owner sign-off

1. F05 и F11.
2. Owner решает F06.
3. Зафиксировать residual risks F07/F08/F10, если они не исправлены до передачи.
4. Подписать R15 owner sign-off.

### Пакет E — Cleanup, только после sign-off

Отдельное разрешение, новый backup/restore-check, dry-run, затем строго ограниченное удаление.

## 5. Финальный чек-лист «можно отдавать заказчику»

- [ ] Production image/tag/digest и Git SHA зафиксированы.
- [ ] Schema current, app+scheduler healthy, restart count 0.
- [ ] Unit/DB/scheduler/typecheck/lint/build зелёные.
- [ ] Полный browser manifest + оба dedicated runner зелёные.
- [ ] iPhone/Safari и Android/Chrome WORKER acceptance подписан.
- [ ] Clock → GPS → offline replay → timesheet → approval → customer report проверены сквозным путём.
- [ ] Нет необъяснённых attendance exceptions старше SLA.
- [ ] Titanor Time backup + off-box + restore PASS.
- [ ] Public-site backup PASS либо публичный сайт явно не входит в передачу.
- [ ] Мониторинг и контакт ответственного описаны.
- [ ] D3/D4 и список исключённых функций не имеют противоречивых статусов.
- [ ] Rollback-команда и точный rollback-контейнер проверены документально.
- [ ] Срок хранения backup/rollback согласован; cleanup ещё не выполнялся.
- [ ] Owner подписал именно весь R15, а не только технический D7 A→F.

После выполнения этих пунктов мой рекомендуемый вердикт меняется с **«production технически
здоров, handoff условный»** на **«готов к передаче заказчику»**.
