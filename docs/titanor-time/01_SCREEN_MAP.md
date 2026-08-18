# Titanor Time — карта экранов

Версия: **5.5.0** (2026-08-06). Статус: **proposed architecture**. Источник истины для route-имён
(используются в `02_ROLE_PERMISSION_MATRIX.md` и `04_ADMIN_FIRST_API_CONTRACTS.md`). Документ
самодостаточен — каждый экран описан полностью.

Легенда приоритета: 🟢 = входит в первый вертикальный сценарий; ⚪ = спроектировано сейчас, строится
позже.

Домен: `app.titanorgroup.fi` (preview: `app-preview.titanorgroup.fi`). Все `/admin/*` — desktop-first
(min-width 1024px оптимизирован, работает от 768px), `/worker/*` — mobile-first (375px базовый,
touch target ≥ 48px), `/foreman/*` — desktop-first с поддержкой планшета в поле.

**Дуал-роль**: пользователь может одновременно иметь `FOREMAN` и `WORKER` (см.
`02_ROLE_PERMISSION_MATRIX.md`, §1) — прораб, который сам работает руками. Для такого пользователя
`/foreman/*` и `/worker/*` оба доступны; после логина он попадает на `/foreman`, а `/worker`
доступен из общей навигации для собственных Check In/Out и часов. Сервер не
даёт такому пользователю утвердить/вернуть/подтвердить собственный табель
(`403 SELF_APPROVAL_FORBIDDEN`) ни через `/foreman/*`, ни через административный fallback.

## 1. Общие экраны

#### `/login` 🟢
- Роли: все (неаутентифицированный)
- Приоритет: desktop + mobile, одинаковый layout
- Назначение: вход по `identifier` (username или email в одно поле) + паролю
- Данные: нет (форма)
- Действия: submit; переключатель языка (FI/EN/RU, без отдельного route — persist в `localStorage` +
  cookie `NEXT_LOCALE` до входа)
- Состояния: loading (submit disabled + spinner); error (`INVALID_CREDENTIALS` — одинаковое
  сообщение для «нет юзера» и «неверный пароль», защита от enumeration); нет empty/offline
- Откуда: прямой заход, редирект с любого защищённого route без сессии, logout
- Куда: зависит от ролей пользователя (`GET /api/auth/session` возвращает массив `roles`): есть
  `ADMIN`/`SUPER_ADMIN` → `/admin`; иначе есть `FOREMAN` → `/foreman`; только `WORKER` →
  `/worker` (домашний mobile-first clock; внутри показан текущий actionable период либо понятный
  empty state)
- API: `POST /api/auth/login`
- DoD: rate limit после 5 попыток/15мин на аккаунт + 50/15мин на IP; `INVALID_CREDENTIALS` не
  раскрывает, что именно неверно

#### `/activate` 🟢
- Роли: неаутентифицированный
- Приоритет: mobile-first
- Назначение: ручной ввод 10-символьного кода с бумаги, когда QR/ссылка недоступны
- Действия: нормализовать пробелы/дефисы/регистр → `/activate/[token]`
- Состояния: validation error для неверной длины/алфавита
- Откуда: `/login` либо прямая инструкция администратора
- Куда: `/activate/[token]`
- DoD: формат `XXXX-XXXX-XX` и негруппированный код приводят к одному token

#### `/activate/[token]` 🟢
- Роли: неаутентифицированный, только с валидным `ActivationToken`
- Приоритет: mobile-first (работники активируют с телефона)
- Назначение: подтвердить личность по коду активации перед установкой пароля
- Данные: имя работника (для подтверждения «это вы?»)
- Действия: continue → `/set-password`
- Состояния: loading; error (`TOKEN_EXPIRED`, `TOKEN_USED`, `TOKEN_INVALID` — три разных сообщения)
- Откуда: ссылка/код, который выдал `ADMIN` вне системы (бумага с QR)
- Куда: `/set-password`
- API: `GET /api/auth/activate?token=...`
- DoD: просроченный/использованный токен даёт понятную ошибку и не пускает дальше

#### `/set-password` 🟢
- Роли: неаутентифицированный, только с валидным `ActivationToken`
- Приоритет: mobile-first
- Назначение: установить первый пароль
- Данные: требования к паролю
- Действия: submit пароля дважды
- Состояния: loading; error (валидация пароля, `TOKEN_EXPIRED` если истёк между экранами)
- Откуда: `/activate/[token]`
- Куда: автологин → `/worker`; на самом экране показывается `username`/employee
  number с кнопкой копирования
- API: `POST /api/auth/set-initial-password`
- DoD: пароль установлен, токен переходит в `USED`, повторное использование токена невозможно

#### `/reset-password/request` ⚪
- Роли: все (неаутентифицированный)
- Приоритет: desktop + mobile
- Назначение: запросить восстановление доступа
- Действия: submit `identifier` (username или email)
- Состояния: loading; успех показывает одинаковое сообщение независимо от существования аккаунта
- Откуда: `/login`
- Куда: сообщение «если аккаунт существует, письмо/код отправлены»
- API: `POST /api/auth/password-reset/request`
- DoD: не раскрывает существование аккаунта; rate limited

#### `/reset-password/[token]` ⚪
- Роли: неаутентифицированный, валидный `PasswordResetToken`
- Приоритет: mobile-first
- Назначение: установить новый пароль (та же форма, что `/set-password`)
- Откуда: ссылка из `/reset-password/request`
- Куда: `/login`
- API: `POST /api/auth/password-reset/confirm`
- DoD: старый пароль перестаёт работать сразу после смены

#### `/profile` ⚪
- Роли: все аутентифицированные
- Приоритет: desktop + mobile
- Назначение: смена языка, смена пароля, просмотр своих данных (только для чтения)
- Данные: `User`/`Employee` (для `WORKER`) текущего пользователя
- Действия: сменить язык, сменить пароль, перейти к `/sessions`
- Состояния: loading; error при сохранении
- Откуда: header/nav на любом защищённом экране
- Куда: `/sessions`
- API: `GET /api/me`, `PATCH /api/me/locale`, `POST /api/me/change-password`
- DoD: смена языка применяется без перезагрузки всего приложения

#### `/sessions` ⚪
- Роли: все аутентифицированные
- Приоритет: desktop + mobile
- Назначение: список активных сессий, возможность отозвать
- Данные: `UserSession[]` текущего пользователя
- Действия: `session.revoke.own` на конкретной сессии, `session.revoke_all.own`
- Состояния: loading; empty (только текущая сессия); error
- Откуда: `/profile`
- API: `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, `POST /api/me/sessions/revoke-all`
- DoD: отзыв чужой сессии невозможен даже прямым запросом

#### `/403`, `/404`, `/500`, `/offline` 🟢
- Роли: все
- Приоритет: desktop + mobile
- Назначение: понятная ошибка вместо белого экрана
- Данные: `requestId` на `/500`
- Действия: вернуться на домашний экран своей роли, logout (на `/403`)
- Состояния: сами являются error-состояниями; `/offline` — глобальный баннер + fallback route
- Откуда: любой защищённый route при отказе авторизации/сети/сервера
- Куда: `/login` или домашний экран роли
- DoD: `403` ≠ `404` (роль видит «нет доступа», не «страница не существует»)

## 2. Администратор (`/admin/*`, desktop-first)

#### `/admin/setup` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: чек-лист первого вертикального сценария (город/объект → рабочая область → шаблон →
  работник → назначение → период), **не декоративный dashboard**
- Данные: статус каждого шага — есть ли хотя бы один `City`/`WorkSite`/`WorkArea`/
  `WorkScheduleTemplate`/`Employee`/`SiteAssignment`/открытый `PayrollPeriod`; `hasCity` —
  информационный, не блокирует
- Действия: переход к созданию недостающей сущности
- Состояния: loading; каждый шаг — «сделано»/«не сделано», без вымышленных чисел
- Откуда: первый вход `ADMIN`, когда чек-лист не завершён; далее из nav
- Куда: `/admin/sites/new`, `/admin/templates/new` (не done) / `/admin/templates` (done),
  `/admin/workers/new`, `/admin/assignments/new`, `/admin/periods`
- API: `GET /api/admin/setup-status`
- DoD: точно отражает БД, не кэширует «выполнено» после деактивации сущности

#### `/admin` (operational overview) 🟢 **`[2026-08-18] T7A.9B реализовано`**
- Роли: `ADMIN`, `SUPER_ADMIN` (`timesheet.read.all`+`attendance.exception.read.all`+
  `attendance.conflict.read` одновременно, permission-check не role-check)
- Приоритет: desktop
- Назначение: полный операционный обзор — больше не безусловный `redirect('/admin/setup')`. Кто
  работает сейчас/закончил/missing checkout/GPS/sync issue, что draft/отправлено вручную-
  автоматически/ждёт прораба/возвращено/готово к final approval/в correction, плюс recorded-vs-
  reported diff и компактная conflicts-секция (ADMIN-only)
- Данные: `OverviewResult` целиком — `summary`(15 карточек)/`items`(worker rows)/`conflicts`/
  `period`/`asOf`, без клиентского пересчёта — все числа уже посчитаны backend
- Действия: 13 operational-state summary-карточек — каждая ссылка/кнопка фильтра (`state` в URL,
  `aria-current` на активной), фильтры period/site/state/pageSize (URL query string), явный
  Refresh, ссылки на `/admin/workers/:id`/`/admin/timesheets/:id`/`/admin/periods/:id`/
  `/admin/attendance/exceptions?status=OPEN&employeeId=`/`/admin/corrections`
- Состояния: loading (`app/admin/loading.tsx`, skeleton той же формы); normal; no active period
  (честный баннер, clock-state всё равно показан); no workers; фильтр вернул ноль строк (отдельная
  формулировка); invalid filters (inline banner, не 500); period not found; access denied; error
  (`app/admin/error.tsx`, без stack trace); pagination
- Откуда: логин `ADMIN`/`SUPER_ADMIN`, nav (`Overview`, первый пункт)
- Куда: `/admin/workers/:id`, `/admin/timesheets/:id`, `/admin/periods/:id`,
  `/admin/attendance/exceptions`, `/admin/corrections`, `/admin/periods`, `/admin/setup`
- API: не самостоятельный fetch — Server Component напрямую вызывает `getAdminOperationalOverview`
  (`lib/attendance-overview.ts`), тот же server-only wrapper, что и `GET /api/admin/overview`
  (`04_ADMIN_FIRST_API_CONTRACTS.md` §9.1e) — контракт API не менялся
- DoD: не показывает цифру, не посчитанную напрямую из БД в момент запроса (уже гарантировано на
  уровне backend); ноль запрещённых полей (GPS/payload/hash/device/requestId) в DOM; bounded query
  count не изменился (n=50/200 → 24 запроса, как в T7A.9A)

#### `/admin/workers` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop (таблица), читаемо на планшете
- Назначение: список работников с поиском/фильтром/пагинацией
- Данные: `Employee` + `Employment.active` + `currentAssignments[]` (массив); `username` (Login
  username — отдельная колонка, независим от `employeeNumber`, см. `03_DATA_MODEL_ERD.md` §4.1);
  индикатор отсутствия `isPrimary` среди активных назначений
- Действия: поиск по имени/employee number, фильтр по активности/объекту, сортировка, → создать,
  → карточка
- Состояния: loading (skeleton rows); empty (CTA «создать первого»); error
- Откуда: nav, `/admin/setup`
- Куда: `/admin/workers/new`, `/admin/workers/[employeeId]`
- API: `GET /api/admin/workers`
- DoD: работник с двумя активными назначениями показывает оба

#### `/admin/workers/new` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: регистрация работника — создаёт только `Employee`+`User(PENDING_ACTIVATION)`+
  `Employment`. **Не создаёт `ActivationToken` и не показывает код**
- Данные: форма (имя, фамилия, телефон, employee number — можно сгенерировать)
- Действия: submit
- Состояния: loading; error (валидация, дубликат employee number); нет empty
- Откуда: `/admin/workers`, `/admin/setup`
- Куда: `/admin/workers/[employeeId]` (профиль без кода — следующий шаг: назначить на объект)
- API: `POST /api/admin/workers`
- DoD: после создания работник виден в списке без какого-либо кода активации на экране; логин
  (`username`), сгенерированный из имени/фамилии (`lastName`+первая буква `firstName`,
  `lib/worker-usernames.ts`), отдельно от employee number — виден в карточке работника

#### `/admin/workers/[employeeId]` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: карточка работника — профиль, текущие назначения, история табелей, действия
- Данные: `Employee` (метка «Employee number»), `username` (метка «Login username», отдельно от
  employee number), `Employment`, `currentAssignments[]` (массив), последние `Timesheet`,
  `activationStatus`
- Действия: редактировать; деактивировать (с причиной — переводит в `OFFBOARDING` или
  `DEACTIVATED` по правилу отработанных периодов); назначить на объект
  (→ `/admin/assignments/new?employeeId=`); выдать код активации (доступно только при
  `readyForActivation`, иначе кнопка неактивна с подсказкой «сначала назначьте объект и откройте
  период»); **«Generate friendly login»** — показывается, только если текущий `username` не
  дружелюбный (числовой либо не соответствует текущему имени); перед сменой у уже активного
  работника — подтверждение («The worker must use the new username for future logins. Their
  password and current sessions will remain valid.»); не переиздаёт код активации; логин не
  меняется автоматически ни правкой имени, ни миграцией
- Состояния: loading; error (404, если employeeId не существует); нет отдельного empty
- Откуда: `/admin/workers`
- Куда: `/admin/assignments/new`, `/admin/timesheets/[timesheetId]`
- API: `GET/PATCH /api/admin/workers/:employeeId`, `GET .../setup-preview`, `POST .../deactivate`,
  `POST .../activation`, `POST .../regenerate-username`
- DoD: код активации показывается ровно один раз, сразу после вызова; не хранится и не показывается
  повторно; карточка активации (печать/QR) также показывает `username` рядом с кодом

#### `/admin/absences` ⚪ (later phase — permission-контракт полный, route/API — следующая фаза)
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: очередь `Absence(status=PENDING)`, создание отсутствия задним числом/по документу
- Данные: `Absence[]` + `Employee` (`absence.read.all`)
- Действия: одобрить (`absence.approve` — атомарная транзакция: `Absence → APPROVED` фиксируется
  всегда, безопасные дни получают overlay, конфликтные — в `overlayConflicts` ответа; **экран всегда
  получает `200`**, не `409`, — конфликты показываются как часть успешного результата, не как отказ
  операции), отклонить (`absence.reject`), создать сразу `APPROVED` (`absence.create.all`)
- Состояния: success с частичными конфликтами (`overlayConflicts[]` непуст) — UI явно показывает:
  «Отсутствие одобрено. N дней получили автоматическую отметку, M дней требуют ручного решения» со
  списком конфликтных дат и причин (`DRAFT_HAS_SEGMENTS`/`CONFIRMED_ZERO`/`EXPLICIT_DAY_TYPE`/
  `SUBMITTED_VERSION`); error — `409 ABSENCE_NOT_PENDING` только при `Absence.status=REJECTED`.
  Повторное нажатие «одобрить» над уже `APPROVED` записью **всегда `200`** (сохранённый результат
  первого одобрения, не ошибка)
- API: не спроектирован для UI в `04_...`; контракт эндпоинта одобрения зафиксирован в `04_...`, §13

#### `/admin/sites` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: список объектов
- Данные: `WorkSite` + `City` + счётчик активных `SiteAssignment`
- Действия: поиск, фильтр по городу/активности, → создать, → карточка
- Состояния: loading; empty (CTA «создать первый объект»); error
- Откуда: nav, `/admin/setup`
- Куда: `/admin/sites/new`, `/admin/sites/[siteId]`
- API: `GET /api/admin/sites`
- DoD: список работает и без единого созданного города (`cityId` nullable)

#### `/admin/sites/new` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: форма создания объекта
- Данные: форма (название, город — опционально, адрес, описание)
- Действия: submit
- Состояния: loading; error (`CITY_NOT_FOUND`, `VALIDATION_ERROR`)
- Откуда: `/admin/sites`, `/admin/setup`
- Куда: `/admin/sites/[siteId]` только что созданного объекта
- API: `POST /api/admin/sites`
- DoD: создание работает без единого города в системе

#### `/admin/sites/[siteId]` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: карточка объекта — данные, рабочие области, назначенные работники/прорабы, геозона
- Данные: `WorkSite`, `WorkArea[]`, `SiteAssignment[]`, `ForemanAssignment[]`, список кандидатов на
  роль прораба (`listAssignableForemen()`), текущая версия геозоны + история версий
  (`getGeofenceHistory()`, `GeofenceSection` — **[2026-08-13] реализовано (T7A.2)**)
- Действия: редактировать, закрыть объект, добавить рабочую область; назначить прораба через
  `<select>` (username/имя+`employeeNumber`, **без** UUID в видимом тексте) — только `User` с
  текущей активной ролью `FOREMAN` (`validFrom <= now AND (validTo IS NULL OR validTo > now)`) и
  `status IN (PENDING_ACTIVATION, ACTIVE)`; `PENDING_ACTIVATION` разрешён с явной подсказкой, что
  войти прораб сможет только после активации своего аккаунта; задать/пересоздать геозону
  (latitude/longitude/radiusMeters) — каждое сохранение создаёт новую immutable версию, старые
  версии не изменяются (**[2026-08-13] реализовано (T7A.2)**, требует `attendance.geofence.update`)
- Состояния: loading; empty на вкладке «рабочие области»; empty selector («No eligible foremen
  yet.» + ссылка на `/admin/users/new`, submit назначения недоступен); geofence not configured
  (`current = null`); error; ошибки валидации геозоны — по полям (`fieldErrors`)
- Откуда: `/admin/sites`
- Куда: `/admin/sites/[siteId]/work-areas`, `/admin/assignments/new?siteId=`, `/admin/users/new`
  (из empty selector)
- API: `GET/PATCH /api/admin/sites/:siteId`, `POST /api/admin/foreman-assignments`,
  `GET/POST /api/admin/sites/:siteId/geofence-versions` (**[2026-08-13] реализовано (T7A.2)**,
  `attendance.geofence.read`/`attendance.geofence.update`)
- DoD: закрытие объекта не удаляет существующие назначения; selector — только UX-фильтр, сервер
  повторно проверяет статус и текущую роль `FOREMAN` независимо от того, что показал selector
  (`409 FOREMAN_NOT_ELIGIBLE` для `OFFBOARDING`/`DEACTIVATED`, `409 USER_NOT_FOREMAN` для
  отсутствующей/будущей/завершённой роли); новая версия геозоны никогда не переписывает старую,
  `WorkSite.currentGeofenceVersionId` переключается атомарно вместе с созданием версии

#### `/admin/sites/[siteId]/work-areas` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: рабочие области конкретного объекта
- Данные: `WorkArea[]` объекта
- Действия: создать, редактировать, деактивировать
- Состояния: loading; empty (CTA создать); error
- Откуда: `/admin/sites/[siteId]`
- API: `GET/POST /api/admin/sites/:siteId/work-areas`, `PATCH .../work-areas/:workAreaId`
- DoD: имя рабочей области уникально в рамках объекта (проверка на сервере)

#### `/admin/assignments` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: список всех назначений работник↔объект
- Данные: `SiteAssignment` + `Employee` + `WorkSite` + `WorkArea` + `WorkScheduleTemplate`
- Действия: фильтр по объекту/работнику/активности, → создать, → завершить назначение
- Состояния: loading; empty; error
- Откуда: nav, карточка объекта/работника
- Куда: `/admin/assignments/new`
- API: `GET /api/admin/assignments`
- DoD: неактивные назначения видны в фильтре «история», не смешаны с активными

#### `/admin/assignments/new` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: назначить работника на объект/область/шаблон. Несколько активных назначений
  одновременно — легитимный сценарий (работа на двух объектах в разные часы одного дня)
- Данные: выбор `Employee`, `WorkSite`, `WorkArea` (опц.), `WorkScheduleTemplate` (опц., только
  `active=true`, label = имя + версия, без UUID в подписи; ровно один активный шаблон —
  автовыбор; явный вариант «No schedule template» с поясняющим текстом про schedule exception),
  `validFrom`, `isPrimary` (по умолчанию `true`, если первое назначение работника на
  пересекающийся диапазон дат)
- Действия: submit; предпросмотр конфликта перед submit
- Состояния: loading; error (`ASSIGNMENT_OVERLAP` — только для дубликата на тот же объект+область;
  `TEMPLATE_NOT_FOUND`)
- Откуда: `/admin/assignments`, `/admin/workers/[employeeId]`, `/admin/sites/[siteId]`
- Куда: `/admin/assignments`
- API: `POST /api/admin/assignments/validate-overlap`, `POST /api/admin/assignments`
- DoD: назначение на второй объект в тот же диапазон дат проходит без ошибки

#### `/admin/assignments/[assignmentId]/split` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: сменить объект/область/шаблон у уже начавшегося назначения без потери исторического
  смысла прошлых дней — заменяет прямое редактирование
- Данные: текущее назначение (read-only часть), форма нового объекта/области/шаблона +
  `effectiveFrom`
- Действия: submit → атомарно закрывает старое (`validTo=effectiveFrom-1`), создаёт новое
- Состояния: loading; error (`ASSIGNMENT_OVERLAP`, `VALIDATION_ERROR`)
- Откуда: карточка назначения / `/admin/assignments`
- Куда: `/admin/assignments`
- API: `POST /api/admin/assignments/:assignmentId/split`
- DoD: обе строки видны в истории назначений; прошлые дни продолжают ссылаться на старую версию
  шаблона

#### `/admin/templates` 🟢 реализовано
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: список рабочих шаблонов (активные и неактивные)
- Данные: `WorkScheduleTemplate` — имя, `description`, `active`, текущая версия, количество рабочих
  дней текущей версии
- Действия: → создать, → карточка
- Состояния: loading (Server Component — рендерится после резолва данных); empty («No templates
  yet.», ссылка создать); error (недостаточно прав — «Access denied»)
- Откуда: nav, `/admin/setup` (Done → сюда, не на `.../new`)
- Куда: `/admin/templates/new`, `/admin/templates/[templateId]`
- API: `GET /api/admin/templates`

#### `/admin/templates/new` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: создание шаблона — 7 строк (пн–вс), рабочий/нерабочий день, время начала/конца,
  плановый перерыв
- Данные: форма `days[7]`
- Действия: submit
- Состояния: loading; error (валидация времени, неполные 7 дней)
- Откуда: `/admin/templates`, `/admin/setup`
- Куда: `/admin/templates/[templateId]`
- API: `POST /api/admin/templates`

#### `/admin/templates/[templateId]` 🟢 реализовано (read-only карточка + редактирование)
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: read-only карточка текущей версии (7 строк дней) + секция «Edit schedule» —
  редактирование создаёт новую immutable версию, **никогда не переписывает текущую**; UI выглядит
  как редактирование «одного шаблона», версионирование спрятано за API. Read-only карточка
  рендерится Server Component'ом и всегда доступна независимо от JS/состояния формы редактирования
  — секция редактирования не подменяет и не скрывает её.
- Данные: `days[7]` текущей версии, `name`/`description`/`active`/`currentVersionNumber`
- Действия: «Edit schedule» → предзаполненная форма (те же 7 строк, что `NewTemplateForm`,
  переиспользуемый `TemplateDaysEditor`) → submit отправляет `expectedVersionNumber` текущей
  версии → создаёт версию N+1 → показывает новый номер версии. Поле `active` **read-only** в этом
  срезе (deactivate/reactivate — нет утверждённого контракта, не реализовано)
- Состояния: loading; empty/error (`404 TEMPLATE_NOT_FOUND`, в т.ч. malformed UUID — без `500`);
  `409 VERSION_CONFLICT` — понятное сообщение + кнопка «Reload» (не автоматический refresh —
  черновик правок пользователя не должен тихо потеряться); inline field-level ошибки валидации;
  double-submit блокируется (`loading`-guard); 375px — без page-level horizontal overflow
  (`.worker-table-scroll` на read-only таблице; сама форма редактирования — обычная колонка полей)
- Откуда: `/admin/templates`
- API: `GET /api/admin/templates/:templateId`, `PATCH /api/admin/templates/:templateId`
- DoD: сохранение не переписывает данные уже прошедших периодов — старые назначения продолжают
  ссылаться на прежнюю версию шаблона (snapshot semantics, §4.5); переход уже начавшегося
  назначения на новую версию — через `assignment.split`, не через эту форму

#### `/admin/periods` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: список расчётных периодов, открытие нового
- Данные: `PayrollPeriod[]` со статусами
- Действия: → открыть новый период, → карточка периода
- Состояния: loading; empty (CTA открыть первый период); error (пересечение дат)
- Откуда: nav, `/admin/setup`
- Куда: `/admin/periods/[periodId]`
- API: `GET/POST /api/admin/periods`
- DoD: нельзя открыть период, пересекающийся по датам с существующим

#### `/admin/periods/[periodId]` 🟢 (просмотр открытого периода; закрытие/экспорт — фаза позже)
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: карточка периода — статус, список табелей, действие закрытия
- Данные: `PayrollPeriod`, агрегат `Timesheet.status` по всем работникам периода
- Действия: закрыть период (`period.lock`), экспортировать (после `LOCKED`)
- Состояния: loading; error (`period.lock` с неутверждёнными табелями → список блокеров)
- Откуда: `/admin/periods`
- Куда: `/admin/timesheets?periodId=`, `/admin/export`
- API: `GET /api/admin/periods/:periodId`, `POST /api/admin/periods/:periodId/lock`
- DoD: попытка закрыть период с неутверждёнными табелями показывает точный список, что мешает

#### `/admin/review-fallback` ⚪

Административный аналог `/foreman/review` — реальный экран, обслуживает два случая: единственный
прораб объекта сам держит роль `WORKER` (не может проверить себя), и `NON_SITE`-scope
(отпуска/больничные/подтверждение пустого табеля — `FOREMAN` их не видит вовсе).

- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: очередь `TimesheetReviewScope(status=PENDING)`, доступных через `timesheet.
  scope_review.all`
- Данные: `TimesheetReviewScope[]` (`scopeType`, `scopePurpose`) + `Employee`/`WorkSite` (или
  `contextSiteId` для `NON_SITE`) + `hasException`
- Действия: фильтр по `scopeType`/`scopePurpose`/объекту/работнику, → карточка scope
- Состояния: loading; empty (обычный случай, если у всех объектов есть независимый прораб); error
- Откуда: nav
- Куда: `/admin/review-fallback/[reviewScopeId]`
- API: `GET /api/admin/review-scopes?status=PENDING`
- DoD: работник, совпадающий по `employeeId` с текущим `ADMIN`, никогда не появляется в списке для
  этого `ADMIN`

#### `/admin/review-fallback/[reviewScopeId]` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: карточка scope. Для `SITE`: дни/интервалы этого объекта, сравнение с плановым
  снимком. Для `NON_SITE(scopePurpose=DATA)`: дни отсутствия с типом (виден администратору, не
  прорабу) и причиной. Для `NON_SITE(scopePurpose=EMPTY_FALLBACK)`: **не показывается как
  «отсутствие»** — экран явно подписан «подтверждение пустого табеля» (весь табель не содержит ни
  рабочих часов, ни отсутствий — работник ничего не заполнил, требуется явное подтверждение, что это
  действительно так)
- Данные: `TimesheetReviewScope`+текущая `TimesheetVersion` (только относящиеся к этому scope дни)+
  `TimesheetReviewProposal[]` (только для `SITE`)
- Действия: подтвердить (кнопка неактивна, если `Timesheet.status != SUBMITTED` — подсказка «табель
  уже возвращён по другому объекту, обновите список»), вернуть (с причиной, опционально с
  предложениями — только для `SITE`; доступно и при `Timesheet.status = RETURNED`, см. ниже)
- Состояния: loading; error (`409 STALE_REVIEW_SCOPE` — версия уже переотправлена **или**
  `Timesheet.status != SUBMITTED` при попытке подтвердить; `403 SELF_APPROVAL_FORBIDDEN`)
- Откуда: `/admin/review-fallback`
- Куда: `/admin/review-fallback`
- API: `GET/POST /api/admin/review-scopes/:reviewScopeId`, `.../approve`, `.../return`
- DoD: подтверждение последнего `PENDING`-scope версии переводит `Timesheet.status` в
  `FOREMAN_APPROVED`; возврат одного `NON_SITE`/`SITE`-scope не блокируется тем, что другой scope той
  же версии уже вернули долями секунды раньше

#### `/admin/timesheets` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: полный операционный обзор всех работников и список табелей с фильтром по
  периоду/объекту/статусу
- Данные: `Timesheet` + `TimesheetVersion` (текущая) + `Employee`; после ЭТАП 7A — агрегаты
  `working now`, `finished`, `missing checkout`, `GPS/sync issue`, `draft`, `manual/auto submitted`,
  `awaiting foreman`, `returned`, `ready for final approval`, `correction`
- Действия: фильтр, сортировка, → карточка
- Состояния: loading; empty; error
- Откуда: nav, `/admin/periods/[periodId]`
- Куда: `/admin/timesheets/[timesheetId]`
- API: `GET /api/admin/timesheets`

#### `/admin/timesheets/[timesheetId]` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: карточка табеля — дни, интервалы, перерывы, история версий и решений
- Данные: текущая `TimesheetVersion` + `TimesheetDay`/`WorkSegment`/`BreakSegment`/
  `TimesheetPlannedShift` + `ApprovalAction[]`; после ЭТАП 7A — исходные Check In/Check Out,
  геостатус каждой точки, sync-state и clock-vs-reported diff с автором/timestamp/причиной правки
- Действия: перейти к сравнению версий, финально утвердить, вернуть с причиной
- Состояния: loading; error
- Откуда: `/admin/timesheets`
- Куда: `/admin/timesheets/[timesheetId]/versions`, `/admin/timesheets/[timesheetId]/approve`
- API: `GET /api/admin/timesheets/:timesheetId`

#### `/admin/timesheets/[timesheetId]/versions` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: сравнение версий табеля бок о бок — что изменилось между последовательными
  `TimesheetVersion`. Все версии — `source=WORKER` (отправки/переотправки) или `source=CORRECTION`
  (корректировки); прораб и администратор не авторы версий — прораб только предлагает через
  `TimesheetReviewProposal`, администратор на `final_approve` не меняет данные
- Данные: `TimesheetVersion[]` + diff по `TimesheetDay`/`WorkSegment`/плановому снимку +
  приложенные `TimesheetReviewProposal[]` для контекста
- Действия: нет мутирующих — только просмотр
- Состояния: loading; error
- Откуда: `/admin/timesheets/[timesheetId]`
- API: `GET /api/admin/timesheets/:timesheetId/versions`
- DoD: diff корректно показывает добавленные/удалённые/изменённые интервалы; после ЭТАП 7A рядом с
  каждой версией видны `MANUAL`/`AUTO`, cutoff, кому и когда она отправлена, site-scope статусы и
  исключения, блокирующие final approval

#### `/admin/timesheets/[timesheetId]/approve` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: финальное утверждение — только просмотр и подтверждение `FOREMAN_APPROVED`-версии,
  без редактирования. Если администратор не согласен с уже согласованными прорабом данными —
  возвращает весь табель целиком, не правит на месте
- Данные: текущая `FOREMAN_APPROVED`-версия, read-only
- Действия: `timesheet.final_approve` (чистый переход статуса) или `timesheet.return` (весь табель,
  требует причину)
- Состояния: loading; error (`INVALID_STATE_TRANSITION`, если табель не в `FOREMAN_APPROVED`)
- Откуда: `/admin/timesheets/[timesheetId]`
- Куда: `/admin/timesheets`
- API: `POST .../final-approve`, `POST .../return`
- DoD: на экране физически нет поля правки часов; сервер отклоняет любые данные об изменении часов
  в теле `final-approve`

#### `/admin/export` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: создать/скачать `ExportBatch` для `LOCKED`/`EXPORTED` периода
- Данные: `PayrollPeriod[]` со статусом `LOCKED`/`EXPORTED`, `ExportBatch[]`
- Действия: `export.create`, скачать существующий batch
- Состояния: loading; empty (нет `LOCKED` периодов); error
- Откуда: nav, `/admin/periods/[periodId]`
- API: `GET /api/admin/export-batches`, `POST /api/admin/periods/:periodId/export`
- DoD: повторный экспорт создаёт новый `ExportBatch`, не перезаписывает предыдущий; для уже
  `EXPORTED` периода с накопленными корректировками создаёт корректирующий batch

#### `/admin/audit` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: просмотр `AuditEvent` с фильтром по типу/actor/сущности
- Данные: `AuditEvent[]`
- Действия: фильтр, поиск по `entityId`
- Состояния: loading; empty; error
- Откуда: nav, `/admin`
- API: `GET /api/admin/audit`
- DoD: фильтрация по датам работает с UTC-хранением, отображение — в `Europe/Helsinki`

#### `/admin/attendance/exceptions` 🟢 **`[2026-08-18] T7A.8C.1 реализовано (list foundation)`**
- Роли: `ADMIN`, `SUPER_ADMIN` (`attendance.exception.read.all`, permission-check, не role-check)
- Приоритет: desktop
- Назначение: очередь `AttendanceException` — отдельная от `/admin/review-scopes` (тот аналог
  `TimesheetReviewScope`); GPS/geofence/switch-site/overlap и т.п. аномалии самого clock-события
  (`T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §11)
- Данные: `ExceptionListItem[]` через уже реализованный `listAttendanceExceptions` —
  человекочитаемый тип/summary/статус/работник/объект/occurredAt/online-offline/GPS
  verification (без координат)/payroll period, без scope-ограничения
- Действия: фильтр `status`(default `OPEN`)/`type`/`from`/`to` (query string, форма сохраняет
  состояние при submit и pagination); → карточка. `siteId`/`employeeId`/`payrollPeriodId` —
  поддержанные API-фильтры без picker UI в этом слайсе, работают через прямой URL
- Состояния: loading (`loading.tsx`); empty; invalid filter (`fieldErrors` inline, не падение);
  access denied; обычный список; pagination (`totalItems`/`totalPages`)
- Откуда: `/admin`-навигация (пункт «Attendance exceptions»)
- Куда: `/admin/attendance/exceptions/[exceptionId]`
- API: `GET /api/admin/attendance/exceptions` (T7A.8A, без изменений)
- DoD: 390×844 — без horizontal overflow, строки схлопываются в карточки; keyboard — Tab доходит
  до строки, виден focus; ноль запрещённых полей (координаты/device/payloadHash) в DOM/ответах

#### `/admin/attendance/exceptions/[exceptionId]` 🟢 **`[2026-08-18] T7A.8C.1+T7A.8C.2 реализовано`**
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: карточка исключения — только уже разрешённый `ExceptionDetail` DTO, ничего не
  дозапрашивает. **`[2026-08-18]`** Для `OPEN` — read-only заметка-заглушка заменена реальными
  формами всех шести resolution-действий (`ExceptionActionPanel`, T7A.8C.2), отфильтрованными
  read-only `lib/attendance-exception-resolution-context.ts` по роли/scope; для terminal-статуса —
  без изменений (`resolvedBy`/note)
- Данные: `ExceptionDetail` — type/status/summary/employee/site/occurredAt/createdAt/payroll
  period/`timesheet` (со ссылкой на `/admin/timesheets/:id`, если привязан)/clock event
  metadata/`clockShift`/`relatedClockShift`/fragments/materialization state/allowlisted
  `detail`/`resolvedAt`/`resolvedBy`/`resolutionNote` для terminal-статуса; плюс (только `OPEN`)
  `ResolutionContext` — допустимые действия/кандидаты для `PAIR`/`CONFIRM`/целевой open shift для
  `FORCE_CLOSE`/редактируемые фрагменты для `REASON_EDIT`
- Действия: **`[2026-08-18]`** `DISMISS`/`ACKNOWLEDGE_AS_VALID`/`PAIR_ORPHAN_EVENTS`/
  `CONFIRM_SOURCE_ASSIGNMENT`/`FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT` — каждая через `POST` на уже
  существующие `.../resolve`/`.../edit` (T7A.8B, без изменений контракта), двухшаговое
  подтверждение вместо `window.confirm`, `router.refresh()`-реконсиляция при устаревшем состоянии
- Состояния: loading; безопасный «not found» (malformed/missing/out-of-scope id — один и тот же
  экран, без UUID-oracle); **`[2026-08-18]`** submitting/error/reconciled для каждой формы действия
- Откуда: `/admin/attendance/exceptions`
- API: `GET /api/admin/attendance/exceptions/:exceptionId` (T7A.8A, без изменений)
- DoD: `latitude`/`longitude`/`ClockEventLocation`/`payloadHash`/`requestId`-как-бизнес-
  данные/`deviceInstallationId`/`deviceSequence`/`sanitizedConflictingPayload`/raw `detail`
  структурно не могут попасть на экран — их нет в самом типе DTO

#### `/admin/attendance/policy` 🟢 **`[2026-08-18] T7A.10B реализовано`**
- Роли: `ADMIN`, `SUPER_ADMIN` (`attendance.policy.read` для просмотра, `attendance.policy.update`
  для редактирования — независимые permission-checks, не role-check; viewer с одним только read
  видит те же данные в read-only режиме, без формы)
- Приоритет: desktop, но без horizontal overflow на 390×844
- Назначение: единственная страница редактирования `CompanyAttendancePolicy` — Server Component
  читает `lib/attendance-policy.ts` напрямую (без HTTP self-fetch), клиентская форма сохраняет
  через уже существующий `PATCH /api/admin/attendance/policy` (T7A.10A, контракт не менялся)
- Данные: `cutoffDaysAfterPeriodEnd`, `cutoffTime` (с секундами), `systemReopenDebounceMinutes`,
  `maxShiftDurationHours` — редактируемые; `timezone` (всегда `Europe/Helsinki`, read-only текст,
  без input/select), `updatedAt` (Helsinki time) — только просмотр; `updatedByUserId` из ответа API
  никогда не рендерится в DOM
- Действия: partial PATCH — минимум одно реально изменённое поле; один "attempt" (UUID
  Idempotency-Key + замороженный payload) на клик Save — сетевой сбой сохраняет тот же attempt для
  Retry (byte-identical повтор), любой определённый ответ сервера (успех/validation/permission/
  idempotency-конфликт) завершает attempt, следующее изменение поля создаёт новый key
- Состояния: loading (`loading.tsx`); access denied (нет `attendance.policy.read`); normal
  (read-only, если нет `.update`); saving; saved; validation error (fieldErrors у каждого поля);
  network result unknown + Retry; permission revoked (403 на Save) — понятная ошибка
- Откуда: `/admin`-навигация (пункт «Attendance policy»)
- Куда: —
- API: `GET/PATCH /api/admin/attendance/policy` (T7A.10A, без изменений контракта)
- DoD: keyboard — Tab доходит до каждого поля и до Save, виден focus; `noValidate` на форме — нативная
  валидация не блокирует показ серверных fieldErrors; aria-live region без повторного спама; ноль
  UUID-строк в видимом тексте страницы; ноль console/hydration errors

#### `/admin/users` 🟢 (частично — см. ⚪ ниже)
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: системные пользователи (не работники) — `ADMIN`/`SUPER_ADMIN`/`FOREMAN` учётки, роли
- Данные: `GET /api/admin/users` — username/email/status/активные roles/связанный `Employee`
- Действия: создать standalone `FOREMAN` или дуал-роль на существующем работнике (`/admin/users/new`);
  выпустить/reissue одноразовый код активации (QR, copy, print) для standalone `FOREMAN`
  в `PENDING_ACTIVATION`
- ⚪ (не реализовано, отдельные задачи): создать `ADMIN`/`SUPER_ADMIN` (только `SUPER_ADMIN`),
  `role.assign` (только `SUPER_ADMIN`), деактивировать
- Состояния: loading; empty; error; raw-код показывается только один раз (React state текущей
  страницы, не сохраняется), исчезает после перехода/refresh
- Откуда: nav
- API: `GET/POST /api/admin/users`, `POST /api/admin/users/:userId/activation`
- DoD: `ADMIN` не может назначить роль `ADMIN`/`SUPER_ADMIN` даже прямым запросом к API (пока
  сам этот путь не реализован — нет способа его вызвать ни через UI, ни через покрытый API)

#### `/admin/users/new` 🟢
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: два режима создания — `STANDALONE` (username/email?/locale) и `EXISTING_EMPLOYEE`
  (select работника по имени+номеру, без отображения UUID)
- Данные: список работников для select (имя, `employeeNumber`, статус их `User`)
- Действия: submit; после успешного `STANDALONE` — автоматический выпуск кода активации с тем же
  UI (QR/copy/print), что и ручной issue/reissue из списка; если выпуск не удался — явное сообщение
  «аккаунт создан, код не выпущен», без общей ошибки создания
- Состояния: loading; error (`VALIDATION_ERROR`, `DUPLICATE_USERNAME`, `DUPLICATE_EMAIL`,
  `EMPLOYEE_NOT_FOUND`, `EMPLOYEE_USER_MISSING`, `USER_NOT_ELIGIBLE`, `USER_ALREADY_FOREMAN`)
- Откуда: `/admin/users`
- API: `POST /api/admin/users`, `POST /api/admin/users/:userId/activation`
- DoD: дуал-роль объясняет разницу `ACTIVE` (существующий пароль) vs `PENDING_ACTIVATION`
  (обычная worker activation) — отдельный system-код не нужен ни в одном из случаев

#### `/activate-account` 🟢
- Роли: неаутентифицированный
- Приоритет: mobile-first
- Назначение: ручной ввод 10-символьного кода standalone `FOREMAN` с бумаги — аналог `/activate`,
  но ведёт на `/activate-account/[token]` (`UserActivationToken`, не `ActivationToken`)
- Действия: нормализовать пробелы/дефисы/регистр → `/activate-account/[token]`; Back to login
- Состояния: validation error для неверной длины/алфавита
- Откуда: код/QR, который выдал `ADMIN` вне системы
- Куда: `/activate-account/[token]`
- DoD: формат `XXXX-XXXX-XX` и негруппированный код приводят к одному token

#### `/activate-account/[token]` 🟢
- Роли: неаутентифицированный, только с валидным `UserActivationToken`
- Приоритет: mobile-first
- Назначение: подтвердить личность (`username`) перед установкой пароля — только
  `verifySystemActivationToken`, не worker `verifyActivationToken`
- Данные: `username`, `locale`
- Действия: continue → `/set-account-password`
- Состояния: loading; error (`TOKEN_EXPIRED`, `TOKEN_USED`, `TOKEN_INVALID`, `RATE_LIMITED` —
  каждый со своим сообщением и ссылкой на login)
- Откуда: код/ссылка/QR от `ADMIN`
- Куда: `/set-account-password`
- API: `GET /api/auth/activate-account?token=...`
- DoD: просроченный/использованный токен даёт понятную ошибку и не пускает дальше

#### `/set-account-password` 🟢
- Роли: неаутентифицированный, только с валидным `UserActivationToken`
- Приоритет: mobile-first
- Назначение: установить первый пароль standalone `FOREMAN`
- Данные: требования к паролю (8–256 символов)
- Действия: submit пароля дважды (mismatch-валидация)
- Состояния: loading; error (валидация пароля, `TOKEN_EXPIRED`/`TOKEN_USED`/`TOKEN_INVALID`,
  `ACCOUNT_NOT_ELIGIBLE`, `RATE_LIMITED`)
- Откуда: `/activate-account/[token]`
- Куда: автологин (cookie от backend) → `/foreman` — **не** `/worker`; на самом экране показывается
  `username` с кнопкой копирования, token убирается из адресной строки
- API: `POST /api/auth/set-account-password`
- DoD: пароль установлен, токен переходит в `USED`, повторное использование токена невозможно

#### `/admin/settings` ⚪
- Роли: `ADMIN`, `SUPER_ADMIN`
- Приоритет: desktop
- Назначение: настройки приложения (2FA-политика, длительность сессии) — конкретный набор вне этого
  документа
- Откуда: nav

## 3. Работник (`/worker/*`, mobile-first)

Ежедневная домашняя страница `/worker` не требует от работника понимать период или табель. Экраны
кабинета параметризованы `periodId` (и внутри — `timesheetId`, резолвится сервером из
`periodId`+сессии). Работник может иметь несколько actionable периодов одновременно — навигация
между ними явная, но обычный Check In/Out всегда доступен с домашней страницы.

#### `/worker` 🟢 (после ЭТАП 7A — основной экран после логина) — **`[2026-08-15] T7A Worker Online
Clock UI реализовано; [2026-08-14] T7A.7B добавил offline outbox — экран больше не online-only.`**
- Роли: `WORKER`
- Приоритет: mobile-first, 390×844 проверено (offline-сценарии тоже, Playwright), touch-target
  ≥48px, основное действие доступно одной рукой; responsive до desktop без горизонтального scroll
  (1280×800 проверено, включая keyboard-активацию `Check In`/`Check Out` клавишей Enter)
- Назначение: максимально простой ежедневный clock без плотной таблицы и бухгалтерских терминов,
  работающий и без сети
- Данные (реализовано): имя работника, локальная дата, список текущих `SiteAssignment` (primary
  отмечен и выбран по умолчанию), authoritative `siteName`/`workAreaName`/время начала открытой
  смены и живая продолжительность — из `getClockState`/`listWorkerCurrentAssignments`
  (`app/worker/page.tsx`, server-side, `Promise.all`), спроецированные (`projectClockState`) поверх
  ещё неподтверждённого outbox-хвоста, когда он есть. Индикатор online/offline, счётчик pending
  outbox-записей и кнопка «Sync now» — реализованы (`lib/offline-outbox/`). GPS-accuracy badge,
  `Today`/`This week` интервалы, ближайший cutoff — **не реализованы** (не входили в scope ни
  одного из слайсов T7A/T7A.7A/T7A.7B)
- Действия (реализовано): доминирующая `Check In` (disabled без назначения/во время запроса);
  `Check Out`; `Switch site` (атомарная пара, явное подтверждение, старый/новый объект показаны) —
  все три сначала атомарно пишутся в IndexedDB outbox, затем синкаются через `POST
  /attendance/sync`, а не напрямую в `check-in`/`check-out`/`switch-site`; ссылки на
  `/worker/periods` (или сразу единственный actionable период) и `/worker/history`. `Add break` —
  не реализовано (вне текущего scope, не clock-функциональность)
- Меню (`Today`/`My week`/`All hours`/`Corrections`/`Profile`/`Help`/`Logout`) — **не реализовано**;
  вместо него — два прямых текстовых линка, см. выше
- Состояния (реализовано): `Clocked out` (с empty state, если назначений нет); `Clocked in`
  (таймер, никогда не отрицательный, помечен «waiting for sync», пока запись ещё не ACKed);
  `Getting location…`; «Saved on device — syncing…»/«waiting for sync»; `Syncing…`/aria-live
  статус для sync-попыток; человеческие сообщения для `OUTSIDE_GEOFENCE`/`SITE_NOT_FOUND`/
  `CLIENT_EVENT_ID_REUSED`/`NO_OPEN_SHIFT_TO_SWITCH`/`RATE_LIMITED`/`CSRF_REJECTED`/
  `NO_EMPLOYEE_PROFILE`/`NOT_AUTHENTICATED`/`VALIDATION_ERROR`/network-timeout; «Offline setup is
  not ready yet» (первый запуск offline без bootstrap — действия структурно недоступны); paused
  баннер для `DEVICE_NOT_OWNED`/`DEVICE_REVOKED`/истёкшей сессии (очередь не стирается, безопасное
  действие — Retry либо «Log in again»); список «Needs attention» для `FAILED_TERMINAL`-записей.
  `GPS_NOT_VERIFIED`/`outside geofence` не блокируют локально — тот же контракт, что бэкенд
  (T7A_1_ATTENDANCE_CLOCK_DESIGN.md §5.3), для offline-событий проверяется сервером при синке.
  Reload восстанавливает durable state и через server render, и через IndexedDB outbox (ещё не
  синкнутые действия переживают reload/remount — не через PWA/offline cache, полноценный service
  worker по-прежнему не реализован, см. ниже)
- Откуда: логин `WORKER`
- Куда: `/worker/periods/[periodId]` (или список `/worker/periods`), `/worker/history`
- API: `GET clock-state`, `GET attendance/context` (device bootstrap), `POST attendance/sync`
  (единственный путь применения Check In/Out/Switch Site теперь) — `check-in`/`check-out`/
  `switch-site` остаются нетронутым online-роутами, но `/worker` UI их больше не вызывает напрямую
- DoD: при одном назначении `Check In` не требует выбора объекта (подтверждено тестом); при
  нескольких выбор понятен до старта; `Switch site` создаёт атомарную пару без промежуточного
  «нигде не отмечен» состояния и переживает crash/reload без orphaned-половины (подтверждено);
  двойной клик не создаёт два разных attempt (подтверждено); offline check-in→reload→offline
  check-out→reconnect→sync даёт ровно одну закрытую смену (подтверждено); координаты не попадают в
  DOM/console/`BroadcastChannel` (подтверждено); network-unknown retry повторяет тот же payload/id
  (подтверждено)
- **Явно НЕ реализовано**: полноценный service worker/PWA offline-shell (сама навигация `/worker`
  при полностью недоступной сети не работает — только уже открытая вкладка и её outbox), GPS-
  accuracy badge, `Today`/`This week` сводка, `Add break`, полное меню, scheduler/auto-submit,
  exception-review UI, admin attendance overview

#### `/worker/periods` ⚪ (список actionable периодов, точка входа при нескольких)
- Роли: `WORKER`
- Приоритет: mobile
- Назначение: список actionable периодов работника — обычно один, но может быть несколько
- Данные: `PayrollPeriodParticipant`+`Timesheet.status` каждого actionable периода
- Действия: → открыть период
- Состояния: loading; empty («вам ещё не назначили объект»); error
- Откуда: логин `WORKER` (если периодов больше одного; иначе редирект сразу в единственный)
- Куда: `/worker/periods/[periodId]`
- API: `GET /api/worker/periods/actionable`
- DoD: два одновременных actionable периода видны и различимы, каждый ведёт на свой `timesheetId`

#### `/worker/periods/[periodId]` 🟢
- Роли: `WORKER`
- Приоритет: mobile (подробный кабинет периода из `/worker` или `My week`)
- Назначение: показать объект(ы), рабочую область, шаблон и статус табеля этого периода — финальная
  точка первого вертикального сценария; после ЭТАП 7A это подробный недельный кабинет, а не
  ежедневный clock-экран
- Данные: активные `SiteAssignment[]` (может быть несколько, `isPrimary` — основной), `PayrollPeriod`,
  `Timesheet.status`; при `RETURNED` — **все** причины возврата текущей версии (`returnReasons[]`,
  `GET .../timesheets/:timesheetId`, реализовано); после ЭТАП 7A — submission source/cutoff,
  site-scope route и exceptions
- Действия: перейти к вводу часов (если draft/returned/withdrawn), посмотреть immutable отправленную
  версию и её маршрут, вручную отправить; до начала review — явно `Withdraw` в **новый** draft;
  после возврата — исправить и переотправить; после final approval — открыть correction request
- Состояния: loading; **empty — критично**: нет ни одного активного назначения → «вам ещё не
  назначили объект»; offline — просмотр последнего кэша; `manual submitted`, `auto submitted`,
  `auto submitted with exceptions`, `awaiting foreman`, `returned`, `ready for admin`,
  `final approved`, `correction pending`
- Откуда: `/worker`, `/worker/periods`
- Куда: `/worker/periods/[periodId]/hours`
- API: `GET /api/worker/timesheets/:timesheetId`, `GET /api/worker/assignments/current`
- DoD: работник, назначенный пять минут назад, видит правильные данные без релогина; отправленная
  версия никогда не редактируется на месте, но экран всегда объясняет доступный путь исправления и
  показывает, кому/когда она отправлена и что ожидается дальше; при `RETURNED` — **каждая** причина
  возврата видна полным текстом с понятной подписью объекта (не UUID), без дополнительного клика;
  если табель `RETURNED`, но с одного объекта причина уже устранена, а с другого объекта вернули
  почти одновременно — обе причины видны рядом (`03_...`, §4.7); после переотправки причины
  предыдущей версии не показываются как актуальные (новая версия — новые, в основном `PENDING`
  scope), но исходные строки не удаляются

#### `/worker/periods/[periodId]/hours` ⚪ (ввод часов — фаза 3 роадмапа)
- Роли: `WORKER`
- Приоритет: mobile
- Назначение: список дней периода. При `Timesheet.status IN (DRAFT, RETURNED)` — редактируется
  mutable `TimesheetDraft` этого `timesheetId`. При `SUBMITTED`/`FOREMAN_APPROVED` — read-only
  просмотр последней immutable версии (draft на этот момент физически пуст, экран сам определяет
  источник данных по статусу и обращается к соответствующему API)
- Данные: `TimesheetDraftDay[]` (редактируемо) либо `TimesheetDay[]` текущей версии (read-only); при
  `RETURNED` — те же `returnReasons[]`, что на `/worker/periods/[periodId]` (реализовано, без
  дополнительного клика)
- Действия: → редактировать день (только если редактируемо)
- Состояния: loading; empty (период открыт, дней ещё нет — показать шаблон как подсказку); error;
  offline (только просмотр последнего кэша)
- Откуда: `/worker/periods/[periodId]`
- Куда: `/worker/periods/[periodId]/hours/[date]`
- API: `GET /api/worker/timesheets/:timesheetId/draft` (редактируемое состояние),
  `GET /api/worker/timesheets/:timesheetId/current-version` (read-only состояние)
- DoD: попытка изменить immutable `SUBMITTED`-версию на месте отклоняется; UI вместо тупика
  предлагает разрешённый lifecycle-action: `Withdraw` до начала review, обработать `RETURNED`, либо
  correction request после final approval. Любое исправление создаёт новую версию, старую не меняет

#### `/worker/periods/[periodId]/hours/[date]` ⚪
- Роли: `WORKER`
- Приоритет: mobile, touch-target ≥48px
- Назначение: редактирование одного дня — интервалы, перерывы, второй объект в тот же день (в т.ч.
  два интервала одного объекта, но разных активных назначений — `sourceAssignmentId` резолвится
  сервером автоматически, экран его не запрашивает и не показывает). День либо полностью рабочий
  (`dayType=WORK`, может содержать интервалы, опционально `confirmedZero=true` при их отсутствии),
  либо полностью отсутствие (`dayType != WORK`, интервалы и `confirmedZero=true` недопустимы) —
  смешение запрещено
- Данные: `TimesheetDraftSegment[]`/`TimesheetDraftBreakSegment[]` дня; каждый интервал требует
  обязательные начало и конец (нет «открытых» интервалов без конца); при `RETURNED` — те же
  `returnReasons[]` (реализовано, без дополнительного клика — работник исправляет день, видя
  причину прямо здесь)
- Действия: добавить/удалить интервал — сохраняется в draft сразу (снимает `confirmedZero`, если он
  был установлен, — UI требует явно снять галочку «ноль часов» перед добавлением интервала, сервер
  отклоняет неявную комбинацию); **подтвердить ноль часов** (`confirmedZero=true`, доступно только
  для дня без сегментов) — единственное non-WORK-подобное действие, доступное прямо на этом экране.
  **Персональное отсутствие (`SICK_LEAVE`/`VACATION`/`UNPAID_LEAVE`/`OTHER`) нельзя выставить прямо
  здесь** — экран не предлагает выбор этих `dayType`, вместо этого показывает ссылку «отметить
  отсутствие» → `/worker/absences` (создаёт `Absence(PENDING)`, только после одобрения `ADMIN`
  overlay сам проставит `dayType`/`sourceAbsenceId` на этот день, `03_...`, §4.2); если день был
  предметом `OPEN`-предложения — **любое** сохранение (не только принятие предложения отдельным
  действием) резолвит его: `ACCEPTED`, если итоговое содержимое совпало с `proposedSegments`, иначе
  `REPLACED`; повторное редактирование того же дня заново пересчитывает статус (`ACCEPTED ↔
  REPLACED`) вплоть до отправки табеля, после чего решение становится окончательным
- Состояния: error (`WORK_SEGMENT_OVERLAP` — пересечение внутри этого draft; `SITE_NOT_ASSIGNED` —
  нет активного назначения на этот объект/область в эту дату; `DAY_TYPE_CONFLICT` — попытка добавить
  интервал на день-отсутствие или пометить день с интервалами как отсутствие; `DAY_STATE_CONFLICT` —
  попытка сохранить `confirmedZero=true` одновременно с интервалами, в том же запросе или поверх уже
  существующих; `403 DAY_TYPE_REQUIRES_ABSENCE` — гипотетическая прямая попытка выставить
  персональный non-WORK `dayType` в обход UI, отклонена сервером)
- Откуда: `/worker/periods/[periodId]/hours`
- Куда: `/worker/periods/[periodId]/hours`
- API: `PATCH /api/worker/timesheets/:timesheetId/days/:date` — отклик может включать
  `resolvedProposals[]`, если сохранение разрешило одно или несколько предложений прораба; UI
  показывает короткое подтверждение («предложение прораба принято»/«предложение прораба отклонено
  вашей правкой»), не молчаливо
- DoD: `07:00–11:00` A + `12:00–16:00` B в один день — без ошибки; `07:00–12:00` A + `11:00–16:00` B
  — отклонено; сохранение интервала без конца — отклонено на уровне формы (обязательное поле) и на
  сервере (`400 VALIDATION_ERROR`); ручное редактирование дня с ни разу не тронутым `OPEN`-
  предложением выводит его из `OPEN` без отдельного вызова «принять предложение»

#### `/worker/periods/[periodId]/submit` ⚪
- Роли: `WORKER`
- Приоритет: mobile
- Назначение: подтверждение отправки табеля
- Данные: сводка перед отправкой; при `RETURNED` — те же `returnReasons[]` (реализовано); если есть
  `OPEN`-предложения — список, submit недоступен; ближайший company cutoff и пояснение, что при
  отсутствии ручной отправки scheduler отправит текущий снимок на проверку, но не утвердит его
- Действия: `timesheet.submit`
- Состояния: loading; error (`409 UNRESOLVED_PROPOSALS` — список дней, требующих решения, ссылка на
  каждый; `409 INVALID_STATE_TRANSITION`)
- Откуда: `/worker/periods/[periodId]/hours`
- Куда: `/worker/periods/[periodId]` (статус «ожидает проверки»)
- API: `POST /api/worker/timesheets/:timesheetId/submit`
- DoD: попытка отправить с необработанным предложением — явный список, не общая ошибка; повторный
  ручной submit или scheduler для уже отправленной версии не создаёт дубль

#### `/worker/history` ⚪
- Роли: `WORKER`
- Приоритет: mobile
- Назначение: список всех периодов работника (не только actionable) и их статус
- Данные: `Timesheet[]` (все периоды работника) с `MANUAL`/`AUTO`, timestamp отправки и текущим
  review/correction status
- Действия: → детали периода
- Состояния: loading; empty; error
- Откуда: `/worker/periods/[periodId]`, nav
- Куда: `/worker/history/[timesheetId]`
- API: `GET /api/worker/timesheets`

#### `/worker/history/[timesheetId]` ⚪ (используется и как «возвращённый табель»)
- Роли: `WORKER`
- Приоритет: mobile
- Назначение: детали конкретного табеля (через `current-version`, read-only); если `RETURNED` — по
  каждому дню с предложением прораба, ещё не ставшим `RESOLVED`: заявлено N ч / предложено M ч /
  разница ±К ч + причина, с пометкой текущего статуса (`OPEN`/`ACCEPTED`/`REPLACED`)
- Данные: текущая версия (`current-version`), `ApprovalAction[]`, `TimesheetReviewProposal[]`
- Действия: на каждое предложение со `status IN (OPEN, ACCEPTED, REPLACED)` — три равнозначных
  варианта: «принять» (`timesheet.accept_proposal`, применяет `proposedSegments` **только к
  сегментам этого объекта в этот день**, оставляя интервалы других объектов того же дня нетронутыми);
  «оставить как есть» (`timesheet.reject_proposal` — новая, явная кнопка, **не** трогает данные дня,
  только фиксирует `status → REPLACED` для этого предложения; отдельна от «исправить самому», чтобы
  работник не был вынужден изображать бессмысленную правку ради того же результата); «исправить
  самому» (→ `/worker/periods/[periodId]/hours/[date]`, свободное редактирование **только сегментов
  этого объекта** — правка другого объекта того же дня не резолвит это предложение, см. DoD ниже).
  «Принять»/«исправить самому» **не отправляют** табель повторно — работник переходит к submit
  отдельным явным действием, когда разрешит все предложения. Статус пересчитывается при каждом
  последующем сохранении **того же объекта**, пока не станет `RESOLVED` при отправке табеля — после
  этого предложение показывается только как историческая запись, действия по нему недоступны
- Состояния: loading; error (`409 STALE_PROPOSAL` — предложение относится к версии, из которой draft
  уже не переинициализирован, UI подсказывает обновить экран; `409 PROPOSAL_ALREADY_RESOLVED` —
  предложение уже зафиксировано прошлой отправкой, показывается как read-only история)
- DoD: сразу после возврата табеля прорабом (до того как работник хоть что-то поменял) все свежие
  предложения показаны со `status=OPEN` — системное копирование содержимого версии в draft,
  выполненное сервером при подготовке этого экрана, не помечает их «уже отклонёнными» (`03_...`,
  §4.6, «Жизненный цикл `status`»); правка объекта A на `/worker/periods/[periodId]/hours/[date]` не
  меняет статус предложения объекта B той же даты, даже если оба показаны на этом экране одновременно
- Куда: `/worker/periods/[periodId]/hours/[date]`, `/worker/periods/[periodId]/submit`
- API: `GET /api/worker/timesheets/:timesheetId/current-version`, `POST /api/worker/
  review-proposals/:proposalId/accept`, `POST /api/worker/review-proposals/:proposalId/reject`
- DoD: причина возврата и структурированное original/proposed/delta всегда видны вместе

#### `/worker/profile` 🟢
- См. `/profile` выше.

#### `/worker/absences` ⚪ (later phase — permission-контракт полный, route/API — следующая фаза)
- Роли: `WORKER`
- Приоритет: mobile
- Назначение: **единственный** путь работника к персональному отсутствию
  (`SICK_LEAVE`/`VACATION`/`UNPAID_LEAVE`/`OTHER`) — запросить будущее отсутствие и посмотреть статус
  собственных `Absence`; прямая установка non-WORK `dayType` через `/worker/periods/[periodId]/
  hours/[date]` запрещена сервером (`403 DAY_TYPE_REQUIRES_ABSENCE`, `03_...`, §4.2)
- Данные: `Absence[]` работника (`absence.read.own`) — полный `type`/`note`
- Действия: создать запрос (`absence.create.own`, создаёт `PENDING`) — не входит в первый
  вертикальный срез
- API: не спроектирован в `04_...` — контракт `absence.approve` (одобрение, вне этого экрана)
  зафиксирован в `04_...`, §13, для консистентности будущей реализации

## 4. Прораб (`/foreman/*`, desktop-first, планшет в поле)

Единица работы прораба — `TimesheetReviewScope(scopeType=SITE)`, никогда `NON_SITE`. Если работник
сменил объект внутри периода, каждый прораб видит и решает только свой scope; `Timesheet.status →
FOREMAN_APPROVED` только когда все scope версии подтверждены (включая возможный `NON_SITE`,
проверяемый отдельно администратором). Собственные scope прораба (дуал-роль) исключены из его же
очереди.

#### `/foreman` 🟢 **`[2026-08-18] T7A.9B реализовано`**
- Роли: `FOREMAN` (`timesheet.read.assigned`+`attendance.exception.read.assigned`, permission-check)
- Приоритет: desktop + планшет
- Назначение: scoped operational overview — прежний pendingCount/exceptionCount-блок сохранён
  (ссылки на review queue и attendance exceptions queue), дополнен тем же worker-list/summary/
  фильтрами, что у `/admin`, но только на текущих объектах прораба и без conflicts-секции
- Данные: `OverviewResult`, отфильтрованный по текущим `ForemanAssignment`-сайтам, dual-role
  self-exclusion; manual/auto, GPS/sync/missing-checkout exceptions, ожидающие site-scopes,
  recorded-vs-reported diff — только по своим сайтам
- Действия: → очередь проверки (`/foreman/review`); те же 13 state-фильтры/period/site/pageSize,
  что у admin; ссылки внутри worker-rows ведут только на уже существующие scoped-роуты
  (`/foreman/review/:timesheetId`, `/foreman/attendance/exceptions`) — никаких `/admin` URL
- Состояния: те же, что у `/admin` (loading/normal/no-period/no-workers/empty-filter/invalid/
  not-found/access-denied/error/pagination); чужой `siteId` → пустой список, не `403`/`404`
- Откуда: логин `FOREMAN`
- Куда: `/foreman/review`, `/foreman/review/:timesheetId`, `/foreman/attendance/exceptions`
- API: не самостоятельный fetch — Server Component напрямую вызывает
  `getForemanOperationalOverview` (`lib/attendance-overview.ts`), тот же server-only wrapper, что и
  `GET /api/foreman/overview` (`04_ADMIN_FIRST_API_CONTRACTS.md` §9.1e) — контракт не менялся
- DoD: числа совпадают с реальным списком в `/foreman/review` в момент запроса (гарантировано на
  уровне backend, единый REPEATABLE READ snapshot); ноль `/admin`-ссылок, ноль conflicts-данных в
  DOM/RSC/network для этой роли (live-подтверждено grep'ом)

#### `/foreman/review` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop + планшет
- Назначение: список `TimesheetReviewScope(scopeType=SITE, status=PENDING)` на объектах прораба,
  разделённый на стандартные/с отклонениями
- Данные: `TimesheetReviewScope` + родительский `Timesheet`/`Employee`, с флагом `hasException`
- Действия: → стандартные, → с отклонениями, → карточка табеля
- Состояния: loading; empty; error
- Откуда: `/foreman`
- Куда: `/foreman/review/standard`, `/foreman/review/exceptions`, `/foreman/review/[timesheetId]`
- API: `GET /api/foreman/review-scopes?status=PENDING`
- DoD: работник другого объекта никогда не появляется в этом списке; собственные scope прораба
  (если он же `WORKER`) исключены; после ЭТАП 7A видно, отправил ли работник сам или scheduler, но
  обе версии проходят одинаковую проверку

#### `/foreman/review/standard` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: scope без отклонений — кандидаты на массовое подтверждение
- Данные: подмножество `/foreman/review` где `hasException=false`
- Действия: выбрать группу → `/foreman/review/bulk-approve`
- API: `GET /api/foreman/review-scopes?status=PENDING&hasException=false`

#### `/foreman/review/exceptions` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: scope с отклонениями — требуют индивидуального просмотра, недоступны для массового
  подтверждения
- Данные: подмножество где `hasException=true`, включая `GPS_NOT_VERIFIED`, missing checkout,
  unresolved sync conflict и auto-submit неполных данных
- Действия: → карточка табеля
- API: `GET /api/foreman/review-scopes?status=PENDING&hasException=true`
- **Не путать с `AttendanceException`** (отдельная сущность — GPS/geofence/switch-site/overlap и
  т.п. аномалии самого clock-события, `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §11): `hasException`
  здесь — производный флаг `TimesheetReviewScope`, вычисляемый `computeSiteScopeHasException`, не
  прямое чтение `AttendanceException`. **`[2026-08-14]`** read-only backend для самого
  `AttendanceException` — `GET /api/{admin,foreman}/attendance/exceptions[/:exceptionId]`
  (T7A.8A) — реализован; **`[2026-08-15]`** резолюция — `POST .../resolve` с
  `DISMISS`/`ACKNOWLEDGE_AS_VALID` (T7A.8B.1), `PAIR_ORPHAN_EVENTS` (T7A.8B.2),
  `CONFIRM_SOURCE_ASSIGNMENT` (T7A.8B.3) и `FORCE_CLOSE_OPEN_SHIFT` (T7A.8B.4A) — последние два
  `ADMIN`/`SUPER_ADMIN`-only, `FOREMAN` не получает ни одно из них; **`[2026-08-18]`**
  `REASON_EDIT` (T7A.8B.4B) — отдельный `POST .../exceptions/:exceptionId/edit`,
  `ADMIN`/`SUPER_ADMIN`-only, `FOREMAN` — безусловный `403`. **Все шесть resolution-действий §11
  теперь реализованы — backend T7A.8B полностью завершён.** **`[2026-08-18]` T7A.8C.1** — новый
  read-only Exception Review UI: `/admin/attendance/exceptions[/:exceptionId]` и
  `/foreman/attendance/exceptions[/:exceptionId]` (см. §2/§4 ниже) — список и карточка
  `AttendanceException`, **не** расширение этой страницы и **не** та же сущность (см. предупреждение
  выше — эта страница по-прежнему только про `TimesheetReviewScope.hasException`).
  **`[2026-08-18]` T7A.8C.2** — формы всех шести resolution-действий реализованы на карточке
  исключения (см. `/admin/attendance/exceptions/[exceptionId]` и `/foreman/attendance/exceptions/
  [exceptionId]` выше); **T7A.8C объявляется завершённым целиком**.

#### `/foreman/review/[timesheetId]` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: карточка табеля — дни/интервалы только на объекте(ах) прораба, сравнение с плановым
  снимком; если табель покрывает несколько объектов, дни на чужих объектах видны свёрнутыми. После
  ЭТАП 7A показывает исходное clock-время, заявленное после ручной правки время и GPS-исключения
  только по собственным объектам прораба
- Данные: текущая `TimesheetVersion` + собственный `TimesheetReviewScope` прораба; после ЭТАП 7A —
  связанные clock-события и diff без раскрытия GPS чужих объектов
- Действия: → предложить исправление, → вернуть, → подтвердить (все — на уровне своего scope)
- Откуда: `/foreman/review/standard`, `/foreman/review/exceptions`
- Куда: `/foreman/review/[timesheetId]/propose-correction`, `.../return`, `.../approve`
- API: `GET /api/foreman/timesheets/:timesheetId`

#### `/foreman/review/[timesheetId]/propose-correction` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: главный экран расхождения план/факт — прораб видит заявленное работником время дня
  (например 10 ч) и вводит структурированную замену (интервалы, из которых сервер сам вычисляет
  итоговые минуты) — например 8 ч. Это создаёт `TimesheetReviewProposal`, **не** меняет
  `TimesheetVersion` напрямую. **Каждое предложение всегда структурировано** — пустой набор
  интервалов означает «предлагаю обнулить часы этого объекта за этот день», минутная сводка без
  интервалов не существует как отдельный путь
- Данные: `TimesheetDay`+`WorkSegment` конкретного дня (заявленные минуты считаются отсюда), форма
  замены интервалов (может быть пустой), обязательное `reason`
- Действия: submit → создаёт один или несколько `TimesheetReviewProposal` и переводит scope в
  `RETURNED`
- Состояния: error (`403 SELF_APPROVAL_FORBIDDEN`; `400 VALIDATION_ERROR`, если интервалы
  пересекаются или выходят за правила рабочего дня)
- Откуда: карточка табеля
- Куда: `/foreman/review`
- API: `POST /api/foreman/review-scopes/:reviewScopeId/return` (с телом `proposals: [{
  timesheetDayId, proposedSegments, reason }]`)
- DoD: работник и `ADMIN` видят заявленные/предложенные минуты и разницу рядом с причиной, не
  только текст возврата

#### `/foreman/review/[timesheetId]/return` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: вернуть свой `TimesheetReviewScope` работнику без структурированного предложения.
  Разрешено, даже если `Timesheet.status` уже сменился на `RETURNED` из-за почти одновременного
  возврата другого объекта той же версии (второй прораб не теряет право зафиксировать своё
  несогласие) — в отличие от подтверждения (см. `approve` ниже)
- Данные: обязательное поле причины
- Действия: `timesheet.return` (на уровне scope)
- Состояния: loading; error (причина пуста → 400 на сервере; `403 SELF_APPROVAL_FORBIDDEN`; `409
  STALE_REVIEW_SCOPE` — устаревшая версия)
- API: `POST /api/foreman/review-scopes/:reviewScopeId/return`
- DoD: возврат хотя бы одного scope переводит весь `Timesheet.status` в `RETURNED`, работник видит
  объединённые причины со всех объектов; второй почти одновременный возврат другого объекта той же
  версии проходит успешно, не теряется

#### `/foreman/review/[timesheetId]/approve` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: подтвердить свой `TimesheetReviewScope`. Доступно **только пока `Timesheet.status =
  SUBMITTED`** — если табель уже переведён в `RETURNED` возвратом другого объекта той же версии
  (даже долями секунды раньше), подтвердить нельзя: draft уже переоткрыт для правки, содержимое
  могло начать меняться
- Действия: `timesheet.foreman_review` approve
- Состояния: loading; error (`403 SELF_APPROVAL_FORBIDDEN`; `409 STALE_REVIEW_SCOPE` — устаревшая
  версия **или** `Timesheet.status != SUBMITTED`, UI в обоих случаях подсказывает обновить список,
  не разграничивая причину визуально)
- API: `POST /api/foreman/review-scopes/:reviewScopeId/approve`
- DoD: `Timesheet.status` переходит в `FOREMAN_APPROVED` только когда подтверждены все scope этой
  версии, не только scope текущего прораба; попытка подтвердить scope сразу после того, как другой
  прораб вернул свой, — отклоняется

#### `/foreman/review/bulk-approve` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: подтвердить выбранную группу стандартных `TimesheetReviewScope` одним действием
- Данные: список выбранных `reviewScopeId`
- Действия: `timesheet.bulk_approve`
- Состояния: loading; error (если в выборку попал scope с отклонением, собственный scope прораба, или
  scope, чей `Timesheet.status` уже не `SUBMITTED` — сервер отклоняет весь запрос с точным списком
  проблемных id)
- API: `POST /api/foreman/review-scopes/bulk-approve`
- DoD: массовое подтверждение атомарно — либо весь пакет проходит, либо ни один; версия
  `AUTO_SUBMITTED_WITH_EXCEPTIONS` не может попасть в bulk approve до разрешения исключений

#### `/foreman/workers` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: работники на объектах прораба
- Данные: `Employee` через активный `SiteAssignment` на объектах прораба
- API: `GET /api/foreman/workers`

#### `/foreman/history` ⚪
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: история решений прораба (подтверждённые/возвращённые)
- Данные: `ApprovalAction[]` где `reviewerUserId = текущий`
- Действия: фильтр по периоду/работнику
- API: `GET /api/foreman/history`

#### `/foreman/attendance/exceptions` 🟢 **`[2026-08-18] T7A.8C.1 реализовано (list foundation)`**
- Роли: `FOREMAN` (`attendance.exception.read.assigned`, permission-check, не role-check)
- Приоритет: desktop
- Назначение: очередь `AttendanceException` объектов прораба — **не путать** с
  `/foreman/review/exceptions` (та — `TimesheetReviewScope.hasException`, другая сущность, см.
  предупреждение там)
- Данные: тот же `ExceptionListItem[]`, что у admin-версии, но через
  `attendance.exception.read.assigned` scope (`getForemanSiteIds`, пересчитывается на каждый
  request); `employeeId`-фильтр недоступен (как и в API)
- Действия: те же фильтры `status`/`type`/`from`/`to`; → карточка
- Состояния: те же, что у admin-версии, плюс отдельная empty-фраза, если у прораба сейчас нет ни
  одного текущего объекта
- Откуда: `/foreman` (ссылка «Go to attendance exceptions», отдельно от секции review queue)
- Куда: `/foreman/attendance/exceptions/[exceptionId]`
- API: `GET /api/foreman/attendance/exceptions` (T7A.8A, без изменений)
- DoD: чужой объект никогда не появляется в списке; `siteId`-фильтр на чужой объект не расширяет
  scope (пустой результат, не ошибка); dual-role `FOREMAN`+`WORKER` не видит собственные исключения

#### `/foreman/attendance/exceptions/[exceptionId]` 🟢 **`[2026-08-18] T7A.8C.1+T7A.8C.2 реализовано`**
- Роли: `FOREMAN`
- Приоритет: desktop
- Назначение: карточка исключения — тот же `ExceptionDetail`, что у admin-версии, без ссылки на
  `timesheet` (только статус текстом, без id). **`[2026-08-18]`** Три доступных прорабу действия —
  `DISMISS`/`ACKNOWLEDGE_AS_VALID`/`PAIR_ORPHAN_EVENTS` (тот же `ExceptionActionPanel`, что у admin,
  с `apiBasePath="/api/foreman/..."`); admin-only действия (`CONFIRM_SOURCE_ASSIGNMENT`/
  `FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT`) **отсутствуют в самом DOM/RSC**, не просто задизейблены —
  подтверждено `grep`-проверкой HTML-ответа
- Данные: см. admin-версию выше (без `REASON_EDIT`-фрагментов — эта форма прорабу недоступна)
- Состояния: loading; безопасный «not found» — единый для malformed/missing/out-of-scope id, own↔
  foreign `OVERLAPPING_SHIFT` — чужая сторона остаётся `null`, экран не пытается её восстановить
- Откуда: `/foreman/attendance/exceptions`
- API: `GET /api/foreman/attendance/exceptions/:exceptionId` (T7A.8A, без изменений)

## 5. Диаграммы потоков

### 5.1 Вход, активация, восстановление

```mermaid
flowchart TD
    A["Открыл ссылку/код активации"] --> B["/activate/[token]"]
    B -->|валиден| C["/set-password"]
    B -->|истёк/использован| B
    C --> D["/login"]
    D -->|успех| E{Роль}
    E -->|ADMIN/SUPER_ADMIN| F["/admin/setup или /admin"]
    E -->|FOREMAN| G["/foreman"]
    E -->|WORKER| H["/worker — Today / Check In-Out"]
    D -->|забыл пароль| I["/reset-password/request"]
    I --> J["/reset-password/[token]"]
    J --> D
```

### 5.2 Первый вертикальный сценарий (admin → worker видит назначение)

```mermaid
flowchart LR
    S1["/admin/sites/new"] --> S2["/admin/sites/siteId/work-areas"]
    S2 --> S3["/admin/templates/new"]
    S3 --> S4["/admin/workers/new"]
    S4 --> S5["/admin/assignments/new"]
    S5 --> S6["/admin/periods"]
    S6 --> S7["код активации выдан"]
    S7 --> S8["/activate/token → /set-password"]
    S8 --> S9["/login"]
    S9 --> S10["/worker — видит объект и готов к Check In"]
```

### 5.3 Ежедневный цикл работника

```mermaid
flowchart TD
    W1["/worker — Today"] --> W2["Check In + GPS snapshot"]
    W2 --> W3["WORKING — timer"]
    W3 -->|Switch site| W4["Check Out A + Check In B"]
    W3 -->|конец дня| W5["Check Out + GPS snapshot"]
    W4 --> W5
    W5 --> W6["Today / My week — recorded time"]
    W6 -->|нужно уточнить| W7["hours/date — reported time + reason"]
    W7 --> W6
    W6 -->|manual submit| W8["immutable version, source MANUAL"]
    W6 -->|cutoff, не отправил| W9["immutable version, source AUTO"]
    W9 -->|есть проблемы| W10["AUTO_SUBMITTED_WITH_EXCEPTIONS"]
    W8 --> W11["site-scopes → foreman/admin review"]
    W9 --> W11
    W10 --> W11
    W11 -->|return| W12["новый draft + before/after"]
    W12 --> W6
    W11 -->|все scope approved| W13["READY FOR ADMIN → FINAL_APPROVED"]
```

### 5.4 Проверка → финальное утверждение (включая административный fallback)

```mermaid
flowchart TD
    R1["SUBMITTED — TimesheetReviewScope(SITE/NON_SITE) созданы"] --> R2{У объекта есть свой FOREMAN, отличный от WORKER табеля?}
    R2 -->|да| R3["/foreman/review/... → approve/return"]
    R2 -->|нет — единственный FOREMAN=WORKER| R4["/admin/review-fallback/... → approve/return"]
    R1 --> R5["NON_SITE — только /admin/review-fallback"]
    R3 --> R6{Все scope APPROVED?}
    R4 --> R6
    R5 --> R6
    R6 -->|да| R7["FOREMAN_APPROVED"]
    R6 -->|нет| R1
    R7 --> R8["/admin/timesheets/timesheetId/approve"]
    R8 --> R9["FINAL_APPROVED"]
    R9 --> R10["period.lock → LOCKED"]
```
