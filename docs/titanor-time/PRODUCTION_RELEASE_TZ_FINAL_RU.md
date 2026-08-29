# Titanor Time — финальное ТЗ на подготовку и выпуск в production

- **Статус:** утверждённое ТЗ, готово к декомпозиции на отдельные задачи
- **Дата фиксации:** 2026-08-29
- **Целевой адрес:** `https://app.titanorgroup.fi`
- **Источник production-кода и данных:** проверенное pilot-окружение Titanor Time
- **Языки текущего этапа:** русский и английский

---

## 1. Назначение документа

Этот документ фиксирует окончательный объём работ по подготовке Titanor Time к production-запуску.

ТЗ охватывает:

- перенос pilot-кода и pilot-данных в production;
- профили администратора и работника;
- восстановление доступа без SMTP;
- production-домен и вход с публичного сайта Titanor Group;
- исправление scheduler и контроля миграций;
- безопасное обновление зависимостей;
- backup/restore;
- GPS-retention и долговременный архив координат;
- улучшения интерфейсов WORKER, FOREMAN, ADMIN и SUPER_ADMIN;
- безопасность, Docker, CI, тестирование, rollout и rollback.

Документ не разрешает выполнять production-изменения без контрольных точек, перечисленных ниже.

---

## 2. Главная цель

Подготовить Titanor Time к безопасному рабочему запуску, при котором:

1. Production использует весь утверждённый функционал pilot.
2. Production использует полную базу pilot, включая пользователей, работников, объекты и рабочие данные.
3. Старая production-БД не объединяется с pilot-БД.
4. Старая production-БД сохраняется только как аварийный backup.
5. Пользователи pilot продолжают использовать существующие логины и пароли.
6. Все старые pilot-сессии и временные токены перед открытием production аннулируются.
7. Scheduler выполняет рабочие циклы и имеет достоверный healthcheck.
8. Приложение доступно по `https://app.titanorgroup.fi`.
9. На `titanorgroup.fi` есть вход для существующих пользователей, без регистрации.
10. Перед каждым будущим релизом автоматически проверяются сборка, типы, миграции, безопасность и основные сценарии.

---

## 3. Зафиксированные решения владельца

### 3.1. Данные

- Pilot-БД становится production-БД.
- Переносятся все данные pilot, а не только структура и код.
- Старая production-БД бизнес-ценности не имеет и с pilot не объединяется.
- Перед заменой старая production-БД обязательно сохраняется полным backup.
- Данные pilot нельзя удалять как «тестовые» без отдельного письменного решения владельца.

### 3.2. Домен

- Production-домен: `app.titanorgroup.fi`.
- Регистрация пользователей не добавляется.
- На публичном сайте добавляется только вход для существующих пользователей.

### 3.3. Языки

- Titanor Time остаётся на RU/EN.
- Финский язык в текущий этап не входит.
- Публичный сайт сохраняет EN/FI.

### 3.4. Восстановление доступа

- Zoho и SMTP для восстановления пароля не используются.
- Восстановление запускает администратор внутри Titanor Time.
- Пользователь получает одноразовый recovery-код или recovery-ссылку через администратора.
- Email остаётся дополнительным логином и контактной информацией, но не каналом восстановления.

### 3.5. FOREMAN

- Новый профиль FOREMAN не входит в текущий этап.
- Улучшения рабочих экранов и навигации FOREMAN входят в этап.
- Профиль FOREMAN может быть реализован позднее как отдельная оплачиваемая задача.

### 3.6. GPS

- Сырые координаты остаются в операционной БД 90 дней.
- Дополнительно создаётся долговременный архив всех координат.
- По текущему решению владельца архив хранится бессрочно.
- Открытый незашифрованный `.txt` с координатами использовать запрещено.
- Читаемый TXT/CSV может формироваться только как контролируемый экспорт из защищённого архива.

### 3.7. Зависимости

- Уязвимые зависимости обновляются.
- Обновление не выполняется одним массовым `npm audit fix --force`.
- Публичный сайт и Titanor Time обновляются и проверяются отдельно.
- Поведение приложения и бизнес-правила должны сохраниться.

---

## 4. Исходное состояние на момент ТЗ

### 4.1. Pilot

В pilot находятся рабочие данные:

- 10 записей пользователей, включая 9 HUMAN и 1 SYSTEM;
- 6 работников;
- 3 объекта;
- 6 основных открытых назначений;
- 2 открытых периода;
- 12 табелей;
- 30 clock events;
- 14 clock shifts;
- 22 attendance exceptions;
- 192 audit events;
- данные профилей и квалификаций;
- действующие пользовательские сессии.

Pilot содержит 88 применённых миграций на момент аудита. Если до production появятся утверждённые новые миграции, финальное количество фиксируется в release manifest.

### 4.2. Старый production

Старый production использовался только для ранней технической проверки:

- администраторы и прорабы не проходили реальную административную обкатку;
- был выполнен один ранний worker-сценарий;
- отсутствуют clock events;
- база содержит старые технические аккаунты и только 42 миграции.

Старый production не является источником рабочих данных.

### 4.3. Scheduler

Production scheduler запущен, но каждый tick завершается ошибкой из-за несовместимости production-кода со старой схемой production-БД.

Перезапуск без замены/обновления БД проблему не решает.

---

## 5. Объём переносимых данных pilot

В production переносится полная согласованная бизнес-база pilot.

### 5.1. Обязательно переносится

- `User` и password hashes;
- роли, permissions и связи пользователей с ролями;
- `Employee` и профили работников;
- контактные и зашифрованные персональные данные;
- фотографии, договоры и qualification-файлы;
- города;
- объекты;
- рабочие зоны;
- geofence-настройки и их версии;
- назначения работников;
- назначения прорабов;
- рабочие шаблоны и их версии;
- submission schedules;
- payroll periods и participants;
- timesheets, версии, дни, сегменты и breaks;
- corrections и review scopes;
- clock events, shifts, fragments и adjustments;
- attendance exceptions и resolutions;
- GPS-данные;
- отчётные и export-метаданные;
- professions и qualifications;
- admin notifications;
- AuditLog/AuditEvent;
- системные policy-настройки.

### 5.2. Переносятся файлы

- фотографии работников;
- фотографии квалификаций;
- договоры;
- остальные файлы, на которые есть ссылки в pilot-БД.

Для каждого файла проверяются:

- существование;
- размер;
- checksum;
- соответствие записи в БД;
- отсутствие выхода пути за upload root.

### 5.3. Не продолжают действовать после переноса

- pilot user sessions;
- неиспользованные password reset tokens;
- временные recovery tokens;
- старые одноразовые activation tokens, кроме отдельно подтверждённых владельцем;
- зависшие idempotency attempts;
- временные scheduler heartbeat-файлы.

После cutover все HUMAN-пользователи входят заново существующим паролем. Пользователь, ожидающий первой активации, получает новый production activation-код.

### 5.4. Secret continuity

Секреты не переносятся внутри SQL dump и не попадают в Git.

Перед запуском проверяются:

- ключ расшифровки персональных данных;
- activation HMAC key;
- idempotency encryption key;
- новый recovery HMAC key;
- корректный `DATABASE_URL`;
- production URL;
- права на upload/storage директории.

Если pilot содержит данные, зашифрованные pilot-ключом, production должен получить тот же ключ защищённым способом либо данные должны быть контролируемо перешифрованы до cutover.

---

## 6. Профили и учётные записи

### 6.1. ADMIN и SUPER_ADMIN

Профиль должен содержать:

- логин;
- активные роли;
- email для входа и связи;
- изменение email с подтверждением текущим паролем;
- смену пароля по текущему паролю;
- дату последнего входа;
- список активных сессий;
- завершение других сессий;
- выбор RU/EN;
- ссылку на инструкцию.

### 6.2. WORKER

Профиль объединяет:

- данные учётной записи;
- email для входа и связи;
- смену пароля;
- активные сессии;
- фотографию;
- личную информацию;
- профессии;
- квалификации;
- документы;
- контактные данные.

Необязательные данные профиля не должны блокировать check-in, check-out или отправку часов.

### 6.3. Email

- Email нормализуется и уникален.
- Изменение требует текущий пароль.
- Email можно использовать вместо username при входе.
- Без почтового провайдера email не считается подтверждённым каналом восстановления.
- Интерфейс не должен обещать отправку письма.
- Текст «email для восстановления» заменяется на «email для входа и связи».

### 6.4. FOREMAN

- Новый `/foreman/profile` не реализуется.
- Восстановление доступа FOREMAN выполняет администратор тем же recovery-процессом.

---

## 7. Восстановление доступа без SMTP

### 7.1. Бизнес-сценарий

1. Пользователь обращается к администратору.
2. Администратор открывает карточку пользователя/работника.
3. Нажимает «Восстановить доступ».
4. Подтверждает действие.
5. Система создаёт одноразовый recovery-код или ссылку.
6. Предыдущие активные recovery-коды аннулируются.
7. Код показывается администратору только один раз.
8. Администратор передаёт код пользователю согласованным каналом.
9. Пользователь открывает `https://app.titanorgroup.fi/reset-password`.
10. Вводит логин, код и новый пароль.
11. После успеха код помечается использованным.
12. Все старые пользовательские сессии отзываются.
13. Событие фиксируется в audit.

### 7.2. Безопасность recovery

- Срок действия: 30–60 минут.
- Код одноразовый.
- В БД хранится только HMAC/hash.
- Новый запрос отзывает старый код.
- Ограничивается число попыток ввода.
- Ответы не раскрывают существование чужого аккаунта.
- Пароли и raw recovery-коды не логируются.
- Администратор никогда не видит новый пароль пользователя.
- Первая активация и восстановление активного аккаунта имеют разные названия, audit event types и проверки статуса.

### 7.3. Существующий email reset

Пока отсутствует согласованный внешний канал доставки:

- email-reset не показывается как рабочая функция;
- кнопки отправки письма скрываются или явно отключаются;
- production не должен возвращать пользователю обещание о письме, которое не может быть доставлено;
- подключение email-провайдера оформляется отдельной будущей задачей.

---

## 8. Production-домен и публичный вход

### 8.1. DNS

Создать запись:

| Параметр | Значение |
|---|---|
| Тип | `A` |
| Имя | `app` |
| Значение | IPv4 того же VPS, на котором работает `titanorgroup.fi` |
| TTL | `300` или `Auto` |

Перед добавлением проверяются конфликтующие `A`, `AAAA` и `CNAME`.

Если автоматическое изменение DNS недоступно, владелец получает точную пошаговую инструкцию для текущего DNS-провайдера.

### 8.2. Caddy

- Отдельный host `app.titanorgroup.fi`.
- Reverse proxy на локальный Titanor Time port.
- Автоматический HTTPS.
- HSTS.
- `X-Content-Type-Options: nosniff`.
- безопасная `Referrer-Policy`.
- запрет нежелательного frame embedding.
- удаление `Server` и `X-Powered-By`.
- отдельный access log без cookies, токенов и паролей.
- PostgreSQL не публикуется наружу.

### 8.3. Публичный сайт Titanor Group

Добавить ссылку в desktop и mobile navigation:

- EN: `Employee login`;
- FI: `Työntekijän kirjautuminen`.

Адрес: `https://app.titanorgroup.fi/login`.

Требования:

- регистрации нет;
- pilot URL не публикуется;
- основная contact CTA сохраняется;
- ссылка работает с мобильного и desktop;
- внутренние страницы Titanor Time закрыты от индексации поисковиками.

---

## 9. GPS-retention и долговременный архив

### 9.1. Операционное хранение

- Сырые координаты хранятся в production-БД 90 дней.
- Retention job удаляет записи старше 90 дней только после успешного архивирования.
- Итоговые clock/timesheet/audit-события сохраняются по своим правилам.

### 9.2. Долговременный архив

- Архив формируется ежедневно.
- Архив содержит все точные координаты за соответствующий день.
- Рекомендуемый формат: `JSONL` или `CSV`.
- Файл сжимается и шифруется.
- Для файла создаётся SHA-256 checksum.
- Создаётся manifest с диапазоном времени и количеством записей.
- Архив хранится на проверенном отдельном backup-хранилище.
- Архив не монтируется в web-контейнер.
- Прямой публичный HTTP-доступ запрещён.
- Доступ разрешён только явно уполномоченному оператору.

Рекомендуемая структура:

`gps-archive/YYYY/MM/YYYY-MM-DD.jsonl.gz.enc`

### 9.3. Поля архива

- event ID;
- employee ID;
- recorded/effective timestamp;
- latitude;
- longitude;
- accuracy;
- source;
- site ID;
- geofence verdict;
- clock event/shift reference;
- archived timestamp.

### 9.4. TXT/CSV-экспорт

- Читаемый TXT/CSV создаётся только по явному запросу.
- Экспорт выполняется из защищённого архива.
- Созданный читаемый файл имеет ограниченный срок жизни.
- Действие фиксируется в audit/операционном журнале.

### 9.5. Политика хранения

Операционная БД хранит raw GPS 90 дней, но полный зашифрованный архив по решению владельца хранится бессрочно. Следовательно, фактическая политика хранения точных координат является бессрочной и должна быть отражена в уведомлении работников и политике обработки персональных данных.

---

## 10. Backup и второй диск

### 10.1. Обязательная проверка storage

До использования второго диска проверить:

- реальный размер;
- свободное место;
- тип mount/filesystem;
- является ли mount физическим диском, сетевым хранилищем или S3/FUSE;
- сохранение mount после reboot;
- права пользователя backup;
- скорость записи и чтения;
- возможность восстановить PostgreSQL dump;
- поведение при временной недоступности.

Название пути не является доказательством доступных 250 GB. После выполненной Cloud очистки дисков проводится новый замер.

### 10.2. Backup-комплект

Каждый полный backup включает:

- PostgreSQL custom-format dump;
- uploads archive;
- GPS archive manifest;
- Git SHA;
- image ID/tag;
- список применённых миграций;
- checksums;
- дату, окружение и результат операции;
- конфигурационный manifest без секретов.

### 10.3. Ротация

- 7 ежедневных backup;
- 4 еженедельных;
- 12 ежемесячных;
- отдельный backup перед каждым deploy;
- отдельный backup перед миграциями;
- старый production backup хранится минимум до завершения периода стабильного наблюдения и отдельного разрешения на удаление.

### 10.4. Restore-test

Backup считается валидным только после восстановления в изолированное окружение и проверки:

- migration status;
- контрольных row counts;
- пользователей и ролей;
- объектов и назначений;
- табелей и clock events;
- audit events;
- файлов;
- зашифрованных полей;
- запуска приложения;
- запуска scheduler.

---

## 11. Исправление scheduler и readiness

### 11.1. Scheduler

После восстановления pilot-БД в production scheduler должен использовать тот же immutable image, что и web-приложение, но отдельную command.

Проверяются шаги:

- attendance auto-submit;
- period generation;
- abandoned shift auto-close;
- GPS retention;
- heartbeat;
- graceful shutdown;
- restart recovery;
- отсутствие overlapping ticks.

### 11.2. Healthcheck

Healthcheck scheduler должен различать:

- heartbeat отсутствует;
- heartbeat устарел;
- tick регулярно падает;
- БД недоступна;
- схема БД несовместима;
- scheduler process остановлен.

### 11.3. Readiness приложения

`/api/ready` должен проверять:

- соединение с БД;
- ожидаемую schema/migration version;
- отсутствие failed/unresolved migrations;
- наличие минимального набора ключевых таблиц.

Ответ не раскрывает database URL, SQL, credentials или персональные данные.

---

## 12. Безопасное обновление зависимостей

### 12.1. Общие правила

- Публичный сайт и Titanor Time обновляются отдельно.
- Одна проверяемая группа зависимостей на задачу.
- Только clean install из lockfile.
- Запрещён `npm audit fix --force`.
- Запрещён неогласованный major upgrade.
- Каждая группа проходит build, tests, Docker и pilot.
- При регрессии lockfile и image откатываются к зафиксированному состоянию.

### 12.2. Целевые минимумы текущего security-slice

- Next.js: стабильная исправленная версия, зафиксированная в задаче; ориентир аудита — `16.3.3`.
- PostCSS: не ниже `8.5.23`.
- Nanoid v3: не ниже `3.3.18`.
- Sharp: исправленная ветка `0.35.x`, не ниже проверенной `0.35.3`.
- Prisma и `@prisma/client`: синхронно `6.19.3` для текущего patch-upgrade.

Точные версии фиксируются в lockfile. Автоматическое повышение до более новой версии во время deploy запрещено.

### 12.3. Prisma/deepmerge

Если advisory `deepmerge-ts` остаётся после Prisma patch:

- определить runtime-достижимость;
- убрать Prisma CLI и остальные dev-зависимости из runtime image;
- не добавлять override без отдельной совместимой проверки;
- документировать остаточный build-time риск;
- не переходить на Prisma 7/8 в этом release.

### 12.4. Критерии принятия dependency upgrade

- TypeScript PASS;
- production build PASS;
- Prisma generate/validate PASS;
- неожиданный schema diff отсутствует;
- миграции применяются на disposable DB;
- Docker build PASS;
- API/role tests PASS;
- PDF/CSV bytes/semantics проверены;
- worker online/offline/GPS PASS;
- scheduler PASS;
- runtime high advisories устранены либо имеют утверждённое документированное исключение.

---

## 13. Улучшения WORKER

- Сохранить mobile-first и PWA.
- На главном экране показывать одно главное действие: начать или завершить смену.
- Явно показывать активный объект и время начала.
- Показывать online/offline/sync state.
- Показывать количество ожидающих offline-операций.
- Добавить безопасный ручной retry sync.
- Давать человеческое объяснение GPS-ошибок.
- Показывать незаполненные дни и неподанные периоды.
- Явно объяснять статусы табеля.
- Выделять возвращённый табель и требуемое действие.
- Не блокировать clock из-за необязательного профиля.
- Разделить крупный clock UI на поддерживаемые части без изменения поведения.

---

## 14. Улучшения FOREMAN

- Адаптивная навигация для телефона и планшета.
- Единый рабочий список задач.
- Приоритет критических случаев:
  - незакрытая смена;
  - GPS-проблема;
  - неподанный табель;
  - табель с исключениями.
- Быстрый переход к работнику, табелю и исключению.
- Поиск работников.
- Фильтры по объекту, периоду и статусу.
- Сохранение фильтров в URL.
- Понятные причины запрета действий вместо permission-кодов.
- Подтверждение bulk-действий.
- Защита от повторного нажатия.
- Ясный результат каждой операции.

Новый профиль FOREMAN не входит в этот scope.

---

## 15. Улучшения ADMIN и SUPER_ADMIN

- После login направлять администратора на `/admin`, а не на `/admin/setup`.
- `/admin/setup` оставить отдельным разделом.
- Сохранить единый центр задач:
  - ожидающие утверждения;
  - неподанные табели;
  - возвращённые табели;
  - attendance exceptions;
  - незакрытые смены;
  - просроченные документы.
- Добавить search и pagination системных пользователей.
- Фильтровать по username, email, роли и статусу.
- Объединить карточку работника:
  - профиль;
  - профессии;
  - квалификации;
  - документы;
  - назначения;
  - часы;
  - история;
  - восстановление доступа.
- Удалить устаревшие UI-тексты и ссылки.
- Разделить чрезмерно крупные модули без изменения бизнес-логики.

---

## 16. Дополнительное security hardening

### 16.1. Titanor Time

- Централизовать auth/permission checks.
- Сохранить CSRF-защиту mutating routes.
- Rate limit не должен зависеть от недоверенного первого `X-Forwarded-For`.
- Доверять proxy headers только от Caddy.
- Подготовить shared rate limiting перед масштабированием более одного app instance.
- Не логировать tokens, cookies, password hashes, GPS и персональные коды.
- Добавить безопасные диагностические error codes для scheduler.

### 16.2. Публичная админка Titanor Group

- Rate limit login.
- Timing-safe credential handling.
- CSRF-защита logout и мутаций.
- Безопасные cookies.
- Аудит успешных/неуспешных входов без пароля.
- Долгосрочно заменить общий пароль персональными аккаунтами.

### 16.3. Контактная форма

- Сохранить honeypot.
- Добавить rate limit.
- Добавить SMTP connection/send timeout.
- Не логировать SMTP credentials и полные transport errors.
- Сохранить безопасное HTML escaping.

### 16.4. Uploads

- Проверять magic bytes, а не только браузерный MIME.
- Разрешать только утверждённые форматы.
- Ограничивать размер до обработки.
- Фотографии перекодировать.
- Документы отдавать с `nosniff` и безопасным Content-Disposition.
- Проверять permission на каждое чтение.
- Исключить path traversal.

---

## 17. Docker и runtime

- Использовать `npm ci`.
- Собирать строго из lockfile.
- Не копировать полный dev `node_modules` в runtime.
- Оставлять только необходимые production/runtime packages.
- Компилировать или безопасно упаковать scheduler runtime.
- Web и scheduler используют один immutable image.
- Image помечается Git SHA, не только `latest`.
- Процессы работают от non-root.
- DB остаётся только во внутренней сети.
- Upload mount проверяется до запуска.
- Image size фиксируется в release report.

---

## 18. CI и автоматические проверки

### 18.1. Обязательные PR-проверки

1. Lockfile consistency.
2. Clean install.
3. Prisma generate.
4. Prisma validate.
5. TypeScript.
6. Build публичного сайта.
7. Build Titanor Time.
8. Быстрые unit/regression tests.
9. `npm audit` с отчётом.
10. Проверка отсутствия случайно добавленных secrets.

### 18.2. Release-проверки

1. Disposable PostgreSQL.
2. Полное применение migrations с нуля.
3. Применение migrations к восстановленной pilot-копии.
4. Role/API matrix.
5. Attendance/GPS/offline tests.
6. Reports/PDF/CSV tests.
7. Scheduler tests.
8. Docker build/run.
9. Backup/restore test.
10. Browser/device acceptance.

Существующие тестовые скрипты группируются и получают документированные команды запуска. Скрипты, требующие БД или браузера, не запускаются против production.

---

## 19. Обязательная pilot acceptance-матрица

### 19.1. Авторизация

- WORKER login;
- FOREMAN login;
- ADMIN login;
- SUPER_ADMIN login;
- login по username;
- login по email;
- неверный пароль;
- deactivated account;
- admin recovery;
- одноразовость recovery-кода;
- expiry recovery-кода;
- отзыв старых sessions.

### 19.2. WORKER

- check-in;
- check-out;
- switch site;
- GPS available/unavailable/denied;
- offline outbox;
- cold restart;
- повторная sync;
- ручные часы;
- submit/reopen/returned flow;
- profile/account;
- PWA install.

### 19.3. FOREMAN

- scoped worker list;
- review queue;
- exceptions;
- standard/bulk approval;
- запрет доступа к чужим объектам;
- mobile/tablet navigation.

### 19.4. ADMIN/SUPER_ADMIN

- dashboard;
- setup;
- users;
- workers;
- sites/areas/geofence;
- assignments;
- schedules/periods;
- review/corrections/direct edit;
- qualifications/professions;
- reports;
- PDF/CSV;
- recovery access;
- profile/sessions.

### 19.5. Infrastructure

- app health/readiness;
- несколько успешных scheduler cycles;
- app restart;
- scheduler restart;
- DB restart;
- backup;
- restore;
- Caddy/HTTPS;
- security headers;
- disk-space threshold;
- upload persistence.

### 19.6. Устройства

- iPhone/Safari;
- Android/Chrome;
- desktop Chrome;
- desktop Safari при наличии;
- PWA;
- GPS;
- offline/cold restart.

---

## 20. Пошаговый план реализации

Каждый шаг является отдельной задачей с отдельной проверкой и результатом.

### Шаг 0. Freeze и повторная инвентаризация

- Проверить Git/worktree.
- Зафиксировать pilot image, Git SHA и migration count.
- Повторно измерить диски после очистки Cloud.
- Проверить второй диск/mount.
- Зафиксировать row counts pilot.
- Зафиксировать upload manifest.

**Результат:** baseline report. Никаких production-изменений.

### Шаг 1. Backup foundation

- Настроить backup target.
- Создать test backup pilot.
- Выполнить restore-test.
- Настроить checksums и rotation.
- Настроить уведомление о неуспешном backup.

**Результат:** доказанный backup/restore до любых production-работ.

### Шаг 2. Recovery без SMTP и завершение профилей

- Реализовать admin-assisted recovery.
- Убрать обещание email-доставки.
- Добавить change password.
- Добавить session management.
- Завершить ADMIN/SUPER_ADMIN и WORKER profile UX.
- Проверить audit и security.

**Результат:** полный recovery/profile flow в pilot.

### Шаг 3. Dependency security — публичный сайт

- Отдельное обновление зависимостей публичного сайта.
- Clean build и preview.
- Проверка сайта, админки, uploads и contact form.

**Результат:** отдельный проверенный commit/image.

### Шаг 4. Dependency security — Titanor Time

- Отдельное обновление Next/PostCSS/Nanoid/Sharp.
- Отдельный Prisma patch.
- Полный regression suite.
- Docker/pilot verification.

**Результат:** immutable candidate image.

### Шаг 5. Scheduler/readiness/operations hardening

- Улучшить readiness.
- Улучшить scheduler diagnostics без утечки secrets.
- Проверить tick/heartbeat/restart.
- Добавить production runbook.

**Результат:** scheduler PASS на pilot-копии.

### Шаг 6. Security/CI/Docker hardening

- CI gates.
- Runtime dependency minimization.
- Proxy/rate-limit fixes.
- Upload validation.
- Public admin/contact hardening.

**Результат:** release candidate проходит автоматические проверки.

### Шаг 7. UX improvements

- WORKER improvements.
- FOREMAN improvements без нового профиля.
- ADMIN/SUPER_ADMIN improvements.
- Обновление RU/EN текстов.
- Обновление документации.

**Результат:** owner acceptance на pilot.

### Шаг 8. DNS/Caddy preparation

- Создать/проверить DNS.
- Подготовить Caddy host.
- Проверить TLS/security headers.
- До cutover не публиковать неготовое приложение.

**Результат:** домен технически готов, доступ контролируется.

### Шаг 9. Final pilot rehearsal

- Зафиксировать pilot freeze window.
- Сделать финальную копию pilot.
- Восстановить её в disposable production-like environment.
- Применить все final migrations.
- Запустить exact release image.
- Прогнать полную acceptance-матрицу.
- Выполнить backup/restore.

**Результат:** подписанный PASS/FAIL release report.

### Шаг 10. Production checkpoint

До продолжения владельцу предоставляются:

- Git SHA;
- image tag/ID;
- migration count;
- backup paths/checksums;
- restore evidence;
- test report;
- downtime plan;
- rollback plan;
- список известных остаточных рисков.

Без явного подтверждения production cutover не выполняется.

### Шаг 11. Production cutover

1. Включить maintenance.
2. Остановить старый production scheduler.
3. Остановить запись в старый production app.
4. Создать полный backup старого production.
5. Проверить backup/checksum.
6. Ввести короткий freeze записи в pilot.
7. Создать финальный pilot DB dump.
8. Создать финальный pilot uploads archive.
9. Проверить checksums и row-count manifest.
10. Восстановить pilot-БД в production.
11. Восстановить pilot uploads.
12. Настроить production secrets/mounts.
13. Аннулировать sessions и временные tokens.
14. Применить только final pending migrations, если они есть.
15. Запустить release app image.
16. Проверить readiness.
17. Запустить scheduler.
18. Дождаться нескольких успешных ticks.
19. Выполнить role smoke tests.
20. Открыть `app.titanorgroup.fi`.
21. Активировать ссылку на публичном сайте.

### Шаг 12. Наблюдение после запуска

- Усиленное наблюдение минимум 24 часа.
- Проверка scheduler на каждом цикле в стартовый период.
- Проверка disk/storage.
- Проверка ошибок login/recovery.
- Проверка GPS/offline.
- Проверка backup следующего дня.
- Фиксация инцидентов отдельно от новых feature requests.

---

## 21. Rollback

### Уровень 1. Image rollback

Если БД совместима, вернуть предыдущий проверенный pilot image и оставить восстановленную pilot-БД.

### Уровень 2. Restore финального pilot snapshot

Если migration/cutover повредил данные:

- включить maintenance;
- остановить app и scheduler;
- восстановить финальный pilot dump;
- восстановить pilot uploads;
- запустить совместимый проверенный image;
- повторить smoke tests.

### Уровень 3. Старый production

Старый production backup используется только как аварийная техническая копия. Он не является целевой рабочей базой и не должен автоматически подмешиваться к pilot-данным.

После restore запрещено открывать приложение, пока row counts, миграции, файлы и роли не проверены.

---

## 22. Критерии готовности production

Production считается готовым только если одновременно выполнено всё:

- домен и HTTPS работают;
- pilot DB и uploads перенесены полностью;
- контрольные row counts совпадают с manifest;
- все final migrations применены;
- failed migrations отсутствуют;
- пользователи входят существующими паролями;
- старые sessions отозваны;
- recovery через администратора работает;
- ADMIN/SUPER_ADMIN и WORKER profiles работают;
- WORKER clock/GPS/offline работает;
- FOREMAN scope/review работает;
- ADMIN reports/PDF/CSV работают;
- scheduler healthy и имеет успешные ticks;
- app readiness проверяет схему;
- backup создан и восстановлен в тесте;
- public-site login link работает;
- registration отсутствует;
- secrets не попали в Git/logs;
- runtime security findings устранены или формально приняты;
- владелец подтвердил pilot acceptance и production checkpoint.

---

## 23. Обязательные документы результата

После выполнения должны существовать:

- release manifest;
- migration report;
- pilot acceptance report;
- production cutover report;
- backup manifest и checksums;
- restore-test report;
- dependency audit report;
- rollback runbook;
- DNS/Caddy runbook;
- scheduler operations runbook;
- обновлённые screen map, ERD и implementation status;
- owner-facing краткая инструкция по входу и восстановлению доступа.

---

## 24. Правила выполнения

- Не смешивать все изменения в один commit/deploy.
- Не менять production до backup и restore rehearsal.
- Не удалять старую production-БД до отдельного разрешения.
- Не удалять pilot-пользователей или данные без решения владельца.
- Не печатать secrets.
- Не хранить raw tokens.
- Не делать массовый dependency force-fix.
- Не выполнять разрушительную очистку Docker/дисков без проверки точных targets.
- Не считать backup готовым без restore-test.
- Не считать container healthy только по факту запущенного процесса.
- После каждого этапа фиксировать доказательства PASS/FAIL.

---

## 25. Итоговая формулировка scope

Итоговый production Titanor Time — это не старая production-БД с добавленным новым кодом. Это проверенное pilot-состояние, перенесённое как единый набор:

- код;
- миграции;
- пользователи;
- работники;
- объекты;
- назначения;
- часы;
- GPS;
- профили;
- документы;
- настройки;
- audit history.

Старый production сохраняется отдельно только для аварийного восстановления и не объединяется с pilot.
