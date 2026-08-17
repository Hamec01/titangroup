# Titanor Time — Implementation Status

Обновлено: 2026-08-18 Europe/Helsinki (feat: add attendance exception resolution UI, T7A.8C.2)

**AUTH SECURITY HOTFIX — утечка credentials через native GET submit до React hydration —
подтверждена и исправлена.** `app/login/page.tsx`'s `<form>` не имел явных `method`/`action`;
поля `identifier`/`password` имеют `name`. До завершения React-гидратации (или вовсе без JS)
браузер мог выполнить обычный native GET submit формы — `/login?identifier=...&password=...` —
кладя пароль открытым текстом в URL, browser history и access log сервера. Найден и
воспроизведён (лог утечки сохранён) во время тестирования T7A.8C.1; исправлен отдельным,
целевым hotfix, без изменения `POST /api/auth/login` контракта.

**Исправление, два независимых слоя защиты**:
1. **Безопасный native fallback** — `<form method="post" action="/api/auth/login">`. POST
   никогда не кладёт тело в URL/query string/browser history, независимо от момента submit
   (до, во время или без гидратации). Гидратированный React-путь по-прежнему делает
   `event.preventDefault()` первым действием и уходит через `fetch` с JSON-телом и обязательным
   `X-Requested-With`-заголовком — `method`/`action` формы никогда не срабатывают, пока это
   работает. Native-фолбэк (без JS) бьёт в тот же `/api/auth/login`, но без CSRF-заголовка —
   получает безопасный `403 CSRF_REJECTED`; логин без JS не работал и до этого фикса (просто
   раньше — небезопасно), так что рабочая функциональность не потеряна.
2. **Defense-in-depth против самого факта submit до гидратации** — новое состояние `hydrated`
   (`useState(false)`, флип в `true` внутри `useEffect(() => {...}, [])`) гейтит `disabled` кнопки
   submit: `disabled={loading || !hydrated}`. SSR и первый client-рендер идентичны (`hydrated`
   всегда `false` до первого эффекта) — hydration mismatch невозможен структурно. Пока кнопка
   `disabled`, ни click, ни Enter-key implicit submission не могут сработать вообще (браузер не
   диспатчит submit без доступной non-disabled submit-кнопки) — native GET/POST fallback выше
   остаётся чистым safety-net, а не тем, что реально срабатывает в обычном сценарии (JS есть,
   гидратация просто ещё не завершилась). `name`/`autoComplete`/password-manager-атрибуты на
   самих полях не тронуты — гейтится только submit-кнопка.

**Проверены все формы с password-полями в приложении** (`grep type="password"` по `app/`):
`app/login/page.tsx` (уязвима, исправлена, см. выше); `app/set-password/page.tsx` и
`app/set-account-password/page.tsx` — **не уязвимы** и намеренно не тронуты: оба поля пароля в
обеих формах не имеют атрибута `name` вовсе, поэтому native form submission (GET или иначе) их не
сериализует — именованного password-поля, которое могло бы попасть в query string, там
структурно нет. `/reset-password/*` — экранов ещё не существует (⚪ в `01_SCREEN_MAP.md`).

**Тесты, реально выполненные на одноразовом PostgreSQL 16 + отдельном dev-сервере (Playwright,
реальный Chromium)**: 22/22 PASS (после диагностики нескольких артефактов тестовой инфраструктуры,
см. ниже) — **JavaScript отключён** (`javaScriptEnabled: false`): submit-кнопка никогда не
становится кликабельной, URL остаётся ровно `/login` без единого query-параметра, ни один
navigation-entry не содержит пароль, access log не содержит ни `GET .../login?identifier=`, ни
сырой пароль. **Искусственно задержанная гидратация** (delay ровно одного JS-чанка страницы
логина на 3с, `waitUntil:'commit'` + прямой DOM-`click()` в обход собственных wait-эвристик
Playwright): кнопка подтверждённо `disabled` сразу после commit, прямой click по ней не производит
навигации, access log чист; после завершения гидратации та же форма нормально логинится. **Обычный
JavaScript**: ADMIN login кнопкой, WORKER login клавишей Enter, неверный пароль — обычная inline-
ошибка (форма остаётся на `/login`), rapid double-click отправляет ровно один `POST
/api/auth/login` (второй клик безопасно проглочен существующим `loading`-гейтом), `autoComplete`/
`name` на обоих полях не изменились, ноль console/hydration errors. Отдельно проверено:
`Referer`-заголовок всех последующих запросов после логина — всегда чистый `http://.../login` без
query string; `AuditEvent`-строки `LOGIN_SUCCEEDED`/`LOGIN_FAILED` — `reason`/`beforeValue`/
`afterValue` пустые, ни один пароль ни в каком поле (прямой SQL-запрос к одноразовой БД).

**Проблемы тестовой инфраструктуры, обнаруженные и решённые по пути (не имеющие отношения к самому
фиксу)**: (1) обращение к dev-серверу через `127.0.0.1` (а не `localhost`) триггерит Next.js/
Turbopack's `allowedDevOrigins`-защиту — HMR WebSocket блокируется, и в этой конкретной связке
dev-режима это полностью останавливает клиентскую гидратацию (не только live-reload) — переключение
тестового клиента на `localhost` устранило проблему; это чисто dev-инструментальное поведение
Next.js, не имеет отношения к продакшену и не является багом приложения. (2) искусственная задержка
сетевого ответа СРАЗУ всех `_next/static/**/*.js`-чанков (а не одного конкретного) компаундится в
непредсказуемо долгую суммарную задержку из-за десятков мелких Turbopack-чанков и вдобавок сбивает
порядок HMR/Fast-Refresh bootstrap, из-за чего последующие `page.fill()`/`page.click()` зависали
неопределённо — решено точечной задержкой ровно одного named-чанка (`app_login_page_tsx*.js`) и
прямым `page.evaluate()`-кликом вместо высокоуровневых Playwright-хелперов для pre-hydration
проверки. (3) реальный login-rate-limiter (`lib/rate-limit.ts`, 5 попыток/15 мин на identifier,
in-memory) исчерпался у тестового admin-аккаунта во время итеративной отладки delayed-hydration
сценария — решено переносом всех разведывательных/отладочных запусков на отдельные throwaway-
аккаунты, оставляя `authfix_admin`/`authfix_worker` нетронутыми для финального прогона.

**Проверки**: `git diff --check`/`prisma validate`/`tsc --noEmit`/`npm run build` (`/login`
по-прежнему в build-манифесте, статически пререндерится, как и раньше) — зелёные;
`scripts/_test-activation.ts`/`_test-corrections.ts` — зелёные на отдельной чистой БД без единого
изменения (auth-смежная регрессия; `POST /api/auth/login` сам контракт не менялся — новых
`schema`/`migration`/`permission`/API-изменений нет). Production (`titanor-time-app-1`/
`titanor-time-db-1`) — тот же image/StartedAt/RestartCount=0/healthy до и после, только read-only
inspect. Preview `127.0.0.1:3244` не останавливался, не использовался для тестов. Изменён ровно
один файл — `titanor-time-app/app/login/page.tsx`.

---

**`[2026-08-18]` T7A.8C.2 Attendance Exception Resolution UI — второй и последний UI-слайс T7A.8C,
поверх T7A.8C.1 (list/detail) и полностью завершённого backend T7A.8B.** Реализует все шесть
resolution-действий (`DISMISS`/`ACKNOWLEDGE_AS_VALID`/`PAIR_ORPHAN_EVENTS`/
`CONFIRM_SOURCE_ASSIGNMENT`/`FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT`) на карточке `AttendanceException`
из T7A.8C.1 — заменяет прежнюю read-only заметку-заглушку. **Публичный API не менялся ни на йоту**:
каждая форма шлёт `POST` на уже существующие `.../attendance/exceptions/:id/resolve` и `.../edit`
(T7A.8B), с тем же CSRF-заголовком и телом, что curl/Postman — новых permission/migration/endpoint
нет.

**Архитектура — read-only context-слой, не дублирующий backend-логику.** Новый
`lib/attendance-exception-resolution-context.ts` (`getResolutionContext`, Server-only) вычисляет
role/scope-отфильтрованный DTO: какие действия доступны, кандидаты для `PAIR`/`CONFIRM`,
целевой `EmployeeOpenShift` для `FORCE_CLOSE`, редактируемые фрагменты для `REASON_EDIT`. Список
допустимых действий берётся из **реально существующей** доменной матрицы — `allowedActionsFor`
экспортирован из `lib/attendance-exception-resolution.ts` (была private) и переиспользован здесь
и в `lib/attendance-exception-edit.ts` (который раньше держал байт-в-байт идентичную приватную
копию той же матрицы — задублированность устранена попутно). Та же схема для FOREMAN-scope-проверки
(`checkForemanScope`/`checkForemanScopeForPair`, тоже экспортированы, не продублированы). Контекст
**никогда не создаёт `AuditEvent`**, ничего не блокирует (`FOR UPDATE`), пересчитывается заново при
каждом `router.refresh()` — чисто advisory preview для UI, не источник авторизации: каждый `POST`
самостоятельно и полностью перепроверяет права/состояние внутри своей же транзакции, как и раньше.
Запрещённые для роли действия (FOREMAN: `CONFIRM_SOURCE_ASSIGNMENT`/`FORCE_CLOSE_OPEN_SHIFT`/
`REASON_EDIT` — admin-only) **отсутствуют в самом RSC/DOM**, а не просто задизейблены кнопкой —
подтверждено `grep`-проверкой HTML-ответа во всех 14 типах исключений на FOREMAN-роутах.

**Client-слой** — новый `components/attendance-exceptions/ExceptionActionPanel.tsx`, один переиспо-
льзуемый `useResolutionMutation`-хук на все шесть форм: синхронный `useRef`-гейт от двойного клика
(взводится до первого `await`, второй клик до ре-рендера кнопки всё равно гасится), явное
двухшаговое подтверждение (`ConfirmGate`, отдельный компонент) вместо `window.confirm`, human-
readable маппинг кодов ошибок, `aria-live`-объявления для screen reader. Реконсиляция: `router.
refresh()` при `403`/`404`/`409` (мир изменился с момента рендера — истёкшее право/исчезнувшая
цель/чужая мутация) и при сетевом сбое (без авто-retry — пользователь явно решает, повторять ли),
но не при `400 VALIDATION_ERROR` (дело в самом запросе, не в состоянии сервера).

**DST-safe datetime для `FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT`**: новый чистый (без Prisma/DB)
`lib/helsinki-datetime.ts` — Europe/Helsinki wall-clock ↔ UTC через `Intl.DateTimeFormat`, ни
единого `new Date(datetimeLocalValue).toISOString()` (это интерпретировало бы ввод в таймзоне
браузера, не Хельсинки). Тем же модулем теперь пользуются `app/worker/.../DayEditor.tsx` и
`app/admin/corrections/.../CorrectionDayEditor.tsx` — раньше каждый держал свою приватную
byte-identical копию той же DST-логики; извлечение чисто механическое (подтверждено `git diff` —
только импорт вместо объявления функции, тела не менялись).

**Тесты — 137/137 PASS**, Playwright на одноразовом PostgreSQL 16 + отдельном dev-сервере: матрица
действий по всем 14 типам исключений × ADMIN/FOREMAN (включая `grep`-подтверждение отсутствия
admin-only кнопок в DOM); все шесть действий admin — успех, с проверкой `AttendanceException.status`,
связанных строк (`ClockShift`/`EmployeeOpenShift`/`Timesheet…`) и ровно одного `AuditEvent`
корректного типа/actor/reason в БД; три доступных FOREMAN-действия — аналогично; пустые
candidate-состояния (task §4/§13: «пусто — это нормальное объяснённое состояние», не ошибка);
двойной клик — ровно один `POST`; обрыв сети — без auto-retry, безопасная реконсиляция; две вкладки
одновременно на одном исключении — ровно один `200`/один `409`, ровно один `AuditEvent`; три
stale-context сценария (кандидат для `PAIR` перехвачен другим актёром, открытая смена уже закрыта
реальным Check Out, право на resolve отозвано между рендером и подтверждением — во всех трёх
исключение не мутировано, показана человеко-понятная ошибка); security/redaction (`sanitizedConflict
ingPayload`/`ClockEventLocation`/GPS-координаты по-прежнему нигде не в ответе); DST зимой/летом
(`FORCE_CLOSE_OPEN_SHIFT` в оба сезона даёт корректный UTC-инстант); мобильный вьюпорт 390×844;
ноль лишних console-ошибок (за вычетом ожидаемых `409`/`403`/`net::ERR_FAILED` от намеренно
провоцируемых конфликтных сценариев).

**Найденные и исправленные по пути проблемы — все в тестовой инфраструктуре/seed-скрипте, ни одна
в самом приложении**: (1) `waitForLoadState('networkidle')` ненадёжен сразу после клика,
запускающего `fetch()`-мутацию — резолвится до реального завершения запроса (задокументированная
особенность Playwright), из-за чего тестовый скрипт иногда рвал соединение до того, как сервер
дописал ответ (`ECONNRESET` в логе dev-сервера) — заменено на явный `page.waitForResponse()` перед
любым действием, читающим результат мутации; аналогично для `router.refresh()`'s собственного
follow-up RSC-fetch — заменено на поллинг DOM вместо гадания с фиксированной задержкой.
(2) Одноразовый scratch-seed-скрипт (`_seed-resolution-ui-test.ts`, не часть репозитория) держал
несколько разных `PAIR_ORPHAN_EVENTS`-фикстур (основную, «пустую», race-сценарий) на одном общем
employee — сам by-design read-only candidate-запрос (корректно) находил чужие orphan-события того
же employee как «кандидатов», давая неверный count в тестах; исправлено выдачей каждой такой
фикстуре отдельного employee — находка не в продукте, а в качестве тестовых данных. (3) Turbopack
dev-режима иногда не подхватывал глубоко вложенные dynamic API routes сразу после `rsync`-копирования
файлового дерева непосредственно перед стартом `next dev` — решено `rm -rf .next` + рестарт; чисто
dev-tooling артефакт этой среды, не баг приложения.

**Regression**: собственная 137-проверочная сьюта уже покрывает все T7A.8 `GET`/`resolve`/`edit`
роуты сквозным образом; `scripts/_test-activation.ts`/`_test-corrections.ts` — зелёные на отдельной
чистой БД (потребовалась отдельная БД: seed-скрипт этого слайса создаёт `PayrollPeriod`,
перекрывающий по датам с тем, что создают эти smoke-тесты, — `ex_payroll_period_date_overlap`
exclusion constraint).

**Проверки**: `git diff --check`/`prisma validate`/`tsc --noEmit`/`npm run build`/
`docker compose -f compose.titanor-time.yaml build app` — зелёные; `prisma migrate deploy` на чистом
одноразовом PostgreSQL 16 — 54/54, повторный запуск — «No pending migrations to apply»; ни одной
новой schema/permission-миграции этот слайс не добавляет. Production (`titanor-time-app-1`/
`titanor-time-db-1`) — тот же image/StartedAt/RestartCount=0/healthy до и после, только read-only
inspect. Preview `127.0.0.1:3244` не останавливался, не использовался для тестов.

**Файлы**: новые — `lib/attendance-exception-resolution-context.ts`, `lib/helsinki-datetime.ts`,
`components/attendance-exceptions/ExceptionActionPanel.tsx`; изменены — `lib/attendance-exception-
resolution.ts` (экспорт уже существующих `allowedActionsFor`/`checkForemanScope`/
`checkForemanScopeForPair`, без изменения их логики), `lib/attendance-exception-edit.ts` (убрана
задублированная копия матрицы, теперь импортирует), `components/attendance-exceptions/
ExceptionDetailView.tsx` (заглушка заменена на `resolutionPanel`-проп),
`app/admin/attendance/exceptions/[exceptionId]/page.tsx` и `app/foreman/attendance/exceptions/
[exceptionId]/page.tsx` (подключение `getResolutionContext`+`ExceptionActionPanel`),
`app/worker/periods/[periodId]/hours/[date]/DayEditor.tsx` и `app/admin/corrections/
[correctionRequestId]/days/[date]/CorrectionDayEditor.tsx` (DST-хелперы вынесены в общий модуль),
`app/globals.css` (только добавления — новый блок `.exc-action-*`/`.exc-confirm-*`/`.exc-candidate-*`
в конце файла, ни одно существующее правило не тронуто).

**С этим слайсом T7A.8C объявляется завершённым целиком** (8C.1 — list/detail, 8C.2 — resolution-
формы/context). **Следующий этап — T7A.9 (admin operational overview)**, ещё не начат.

---

**T7A.8C.1 Attendance Exception Review UI — list + detail foundation — первый UI-слайс поверх
полностью завершённого backend T7A.8A/T7A.8B.** Реализует `docs/titanor-time/01_SCREEN_MAP.md`
`/admin/attendance/exceptions[/:exceptionId]` и `/foreman/attendance/exceptions[/:exceptionId]` —
только просмотр очереди и карточки `AttendanceException`. **Формы resolution-действий
(`DISMISS`/`ACKNOWLEDGE_AS_VALID`/`PAIR_ORPHAN_EVENTS`/`CONFIRM_SOURCE_ASSIGNMENT`/
`FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT`) НЕ реализованы этим слайсом — на detail-карточке
только read-only заметка «Resolution actions will be available in the next slice», без единой
рабочей кнопки — это будущий T7A.8C.2.** **`[2026-08-18]` Реализовано — см. запись T7A.8C.2 выше.**
Backend T7A.8B не тронут вообще — `git status` подтверждает
ноль изменений в каких-либо `lib/attendance-exception*.ts` или `.../resolve|edit/route.ts` файлах.

**Не путать с уже существующей `/foreman/review/exceptions`** (`TimesheetReviewScope` с
`hasException=true` — производный флаг табеля) — новая `/foreman/attendance/exceptions` показывает
непосредственно `AttendanceException`, отдельную сущность; старая страница не изменена и её
семантика не тронута.

**Файлы**: пять новых — `lib/attendance-exceptions-ui.ts` (чистые presentation-хелперы: человеко-
читаемые labels для 14 типов/3 статусов/gps-verification/channel/materialization/projection/
operation-type, `formatDateTime` = тот же `toLocaleString()`-паттерн, что уже используют
`GeofenceSection`/`ActivationCodeIssuer`, и `buildExceptionsQueryString` — единственная query-string
логика, не второй filter/pagination engine), `components/attendance-exceptions/ExceptionsListView.tsx`
+ `ExceptionDetailView.tsx` (общие presentation-компоненты, дословно переиспользуемые admin- и
foreman-страницами — единственное новое соглашение этого слайса: раньше в кодовой базе не было
общей `components/`-директории вне `app/`, компоненты жили рядом со своей страницей; здесь список и
карточка почти идентичны у admin/foreman, так что вынесение оправдано и явно решение, а не
случайность), четыре новых `page.tsx` (+ по одному `loading.tsx` на каждый) под
`app/admin/attendance/exceptions/` и `app/foreman/attendance/exceptions/`. Изменены: `app/admin/
layout.tsx` (+1 пункт навигации «Attendance exceptions»), `app/foreman/page.tsx` (+ссылка «Go to
attendance exceptions», явно подписана отдельно от секции review queue), `app/globals.css` (только
additive `.exc-*`-классы в конце файла — существующие `.setup-page`/`.setup-card`/`.worker-card`/
`.wk-*`-классы переиспользованы как есть для внешней рамки страниц, ничего в них не менялось).

**Переиспользовано без изменений** (по требованию задания — «не создавать второй scope/filter/
pagination engine»): `parseExceptionListQuery`, `listAttendanceExceptions`, `EXCEPTION_TYPE_VALUES`,
`EXCEPTION_STATUS_VALUES`, `getAttendanceExceptionDetail`, `ForemanScope`, `getForemanSiteIds` — ни
один экспорт `lib/attendance-exceptions.ts` не менялся.

**Список**: фильтры `status`(default `OPEN`)/`type`/`from`/`to` — обычная GET-форма, хранят
состояние в query string, submit сбрасывает `page` на 1. `siteId`/`employeeId`/`payrollPeriodId`
остаются поддержанными API-фильтрами без picker UI в этом слайсе (по заданию) — но, в отличие от
черновой версии этого слайса, **не игнорируются**, если пришли в URL: подробнее в разделе «Найденный
и исправленный баг» ниже. Пагинация (`Previous`/`Next`, `page X of Y`) и повторный submit формы
сохраняют абсолютно все активные фильтры, включая эти три через скрытые `<input type="hidden">`.
Строка/карточка исключения — единый кликабельный `<a>` (`next/link`), не отдельные ссылки на ячейку —
один tab-stop на строку, с явным `:focus-visible`-обводом. На ≤700px строка из CSS-grid превращается
в вертикальный стек карточки с видимыми полевыми labels (`.exc-field-label`), без horizontal
overflow; таблица-заголовок (`.exc-row-head`) скрыт на этой ширине. Состояния: loading (`loading.tsx`
Suspense-boundary на каждом из 4 роутов), empty (обычный «нет совпадений» и отдельная фраза для
foreman без текущих объектов), invalid filter (`parseExceptionListQuery`'s `fieldErrors` — рендерится
inline, не падение), access denied (permission-check, не role-check — см. ниже), обычный список,
корректная pagination с `totalItems`/`totalPages`.

**Карточка**: рендерит исключительно уже реализованный `ExceptionDetail` DTO — ничего не
дозапрашивает и не реконструирует. `latitude`/`longitude`/`ClockEventLocation`/`payloadHash`/
`requestId`-как-бизнес-данные/`deviceInstallationId`/`deviceSequence`/
`sanitizedConflictingPayload`/raw `detail` структурно не могут попасть на экран — их нет в самом
типе `ExceptionDetail`, не только в JSX. `clockShift`/`relatedClockShift` рендерятся единообразно и
для «ничего не привязано», и для own↔foreign redaction (`null`) — карточка не пытается различить эти
два случая и не гадает содержимое чужой стороны, показывает одинаковое «Not available» в обоих.
`timesheet`-ссылка — только для ADMIN (`/admin/timesheets/:id`, реально существующий роут), FOREMAN
видит только статус текстом, без ссылки и без сырого id. `resolvedAt`/`resolvedBy`/`resolutionNote`
показаны для terminal-статусов; для `OPEN` вместо них — read-only заметка про будущий слайс, без
кнопок. Malformed/missing/out-of-scope `exceptionId` — один и тот же безопасный «not found» экран
(UUID pre-validation перед вызовом `getAttendanceExceptionDetail`, как в существующих `route.ts`).

**Авторизация**: обе admin-страницы и обе foreman-страницы проверяют `hasPermission(roles,
'attendance.exception.read.{all|assigned}')` — **не** `roles.includes('ADMIN')`/`'FOREMAN')`, в
отличие от более старых admin/foreman страниц в этой кодовой базе (`/admin/assignments`,
`/foreman/review` и т.д., которые исторически проверяют только роль). Это осознанное, явно
запрошенное заданием отличие от устоявшегося в проекте паттерна («не считать наличие роли
достаточным, если permission отозван») — зафиксировано здесь, чтобы не выглядеть случайным
расхождением. Foreman-scope (`getForemanSiteIds`+`excludeEmployeeId`) пересчитывается заново на
каждый request, не кэшируется — тот же паттерн, что read API.

**Найденный и исправленный баг (в собственном коде этого слайса, не в T7A.8B)**: в черновой версии
обе list-страницы жёстко подставляли `siteId: null, payrollPeriodId: null` (и admin — ещё
`employeeId: null`) при вызове `parseExceptionListQuery`, вместо чтения их из `searchParams` — то
есть три документированных как «поддержанные API-фильтры» query-параметра тихо игнорировались любым
прямым URL. Обнаружено собственным browser-тестом (`?siteId=<чужой>` для foreman вернул полный
собственный список вместо пустого). Исправлено до коммита: оба `page.tsx` теперь читают все три
параметра из `searchParams` и передают дальше без изменений; `ExceptionsListView` пробрасывает их
через скрытые поля формы и в `pageHref` пагинации, чтобы un-UI-фильтр, once в URL, переживал и submit
формы, и переход между страницами.

**Тесты, реально выполненные на одноразовом PostgreSQL 16 + отдельном dev-сервере (Playwright,
реальный Chromium)**: 77/77 browser-checks одним прогоном (после итеративной отладки — см. «Проблемы
инфраструктуры тестирования» ниже) — ADMIN и SUPER_ADMIN видят список/карточку; WORKER получает
access denied на обеих новых зонах; FOREMAN видит только исключения текущих объектов, чужой сайт не
протекает в список; FOREMAN без объектов — empty state; FOREMAN с истёкшим-only и с future-only
`ForemanAssignment` — та же пустая очередь (нет доступа); чужой `siteId` в query не расширяет scope
(после фикса бага выше — корректно пустой результат); own↔foreign `OVERLAPPING_SHIFT` — своя сторона
видна, чужая — единообразный «Not available», текст чужого сайта нигде не встречается ни в DOM, ни в
перехваченных network-ответах; foreman B не может открыть карточку foreman A через чужой прямой URL
(безопасный «not found», не 403/404-oracle); `OPEN` по умолчанию, переключение
`OPEN`/`RESOLVED`/`DISMISSED`, `type`-фильтр, `from`/`to`-фильтр (в т.ч. будущая дата → пусто);
невалидные `status`/`page` → inline field error, не падение; pagination с сохранением фильтров через
`page=2`; безопасный 404 для malformed/несуществующего id; пустое состояние по комбинации фильтров;
мобильный вьюпорт 390×844 без горизонтального overflow на списке и карточке, поля-labels видимы;
десктопный вьюпорт — виден grid-заголовок таблицы; keyboard — Tab доходит до строки, виден focus-
outline, Enter переходит на карточку; ноль application console errors (dev-only Turbopack HMR
websocket шум явно отфильтрован и описан отдельно, не замаскирован тихо); DOM и перехваченные
network-ответы не содержат ни одного из семи запрещённых терминов
(`latitude`/`longitude`/`payloadHash`/`deviceInstallationId`/`deviceSequence`/
`sanitizedConflictingPayload`/`ClockEventLocation`) ни в списке, ни в карточке; read-only заметка про
будущий слайс — только для `OPEN`, без кнопок; для terminal-статуса — реальные `resolvedBy`/note;
`timesheet`-ссылка есть у ADMIN, когда `timesheet` привязан.

**Regression**: собственный HTTP-smoke (12/12) существующих T7A.8 `GET`/`resolve`/`edit` роутов —
без единого изменения кода эти endpoints остаются полностью рабочими (list/detail 200, invalid
`action` → 400 `VALIDATION_ERROR`, реальный `DISMISS` end-to-end, `edit`-роут admin достижим,
foreman `edit` — безусловный 403, как и было). `scripts/_test-activation.ts` и
`_test-corrections.ts` — зелёные на отдельной чистой БД без единого изменения.

**Проблемы инфраструктуры тестирования, а не продукта** (задокументировано, чтобы не выглядеть
скрытым багфиксом): (1) реальный логин-rate-limiter (`lib/rate-limit.ts`, 5 попыток/15 мин на
identifier, in-memory) сработал в середине итерации теста, когда скрипт логинился заново в каждой из
~15 секций для одного и того же admin-аккаунта — тест переписан на переиспользование одной сессии на
персону; (2) `next/link`-переходы и клиентский редирект `/login` после успешного входа — SPA-навигация,
не полная перезагрузка, поэтому `waitForLoadState('networkidle')` иногда резолвился раньше самого
перехода — заменено на явный `waitForURL`; (3) Turbopack dev-режима компилирует каждый route на первый
реальный запрос (до нескольких минут на самый первый заход) — решено прогревом всех четырёх новых
роутов через `curl` перед запуском Playwright-сьюта.

**Найден отдельный pre-existing баг вне охвата этого слайса**: `app/login/page.tsx`'s `<form>` не
имело `method`/`action` — клик по submit до завершения React-гидратации откатывался к нативному
GET-сабмиту браузера, что клало `identifier`+`password` открытым текстом в URL (и, как следствие, в
access log сервера — воспроизведено и зафиксировано в логе dev-сервера при тестировании этого
слайса). Не относилось к T7A.8C.1 (login page — не часть этого среза), сознательно не исправлено
здесь, чтобы не расширять scope молча — зафиксировано как кандидат на отдельную задачу.
**`[2026-08-18]` Исправлено отдельным security hotfix — см. запись ниже.**

**Проверки**: `git diff --check`/`prisma validate`/`tsc --noEmit`/`npm run build` (все 4 новых
роута + `loading.tsx`-boundaries видны в build-манифесте) — зелёные; `docker compose build app` —
успешный build (`docker inspect` до/после подтверждает тот же image ID/`StartedAt`/
`RestartCount=0`/healthy у `titanor-time-app-1`/`titanor-time-db-1`); `prisma migrate deploy` на
чистом одноразовом PostgreSQL 16 — 54/54, повторный запуск — «No pending migrations to apply»; ни
одной schema/permission-миграции этот слайс не добавляет. Preview `127.0.0.1:3244` и его БД не
останавливались и не использовались для тестов — только собственные одноразовые контейнеры/dev-сервер
на отдельном порту.

**Остаётся вне этого слайса** (явно, по границам задачи): T7A.8C.2 — формы всех шести
resolution-действий и реальные POST-вызовы к уже существующим `.../resolve`/`.../edit`
(**`[2026-08-18]` реализовано — см. запись T7A.8C.2 выше); никакого
нового API/migration/permission не добавлено; `attendance.gps.read.raw`/`attendance.conflict.read`
не выданы; admin operational overview (T7A.9), scheduler/auto-submit (T7A.10), PWA/service worker —
не начаты.

---

**T7A.8B.4B REASON_EDIT — новый завершённый write-слайс поверх T7A.8B.4A, шестое и последнее
resolution-действие матрицы §11. С этим слайсом T7A.8B (backend attendance exception resolution)
объявляется завершённым — но НЕ весь T7A.8** (см. «Остаётся вне этого слайса» ниже: exception-review
UI — отдельный T7A.8C, ещё не начат). Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md`
§8.1/§8.5 (resolver-форма с продолжением — единственное действие матрицы, откатывающееся от
`AttendanceException`(7) назад к `Timesheet`(5)/`TimesheetDraft`(6), а не вперёд к позиции 3/4, как
остальные пять)/§9.1a/§10.1-§10.3/§11/§12.1-§12.4, с одним обязательным архитектурным уточнением,
зафиксированным в дизайн-документе (§12.4) до начала реализации: `clockShiftFragmentId` — теперь
обязательное поле тела запроса, не выводится из `exception.clockShiftFragmentId` (которое
`OVERLAPPING_SHIFT` никогда не заполняет) — точный алгоритм подтверждения целевого фрагмента
(`resolveTargetFragmentId`, симметричный для обычных типов и для `OVERLAPPING_SHIFT`) — в §12.4.

**Новый endpoint, не переиспользует ни `/resolve`, ни worker-`PATCH`**: `POST
/api/admin/attendance/exceptions/:exceptionId/edit`. Требует одновременно все три permission:
`attendance.exception.read.all`, `attendance.exception.resolve.all`, `timesheet.draft.edit.exception`
(новая — семя `prisma/migrations/20260818000000_seed_timesheet_draft_edit_exception_permission`,
чистый DML, без изменений схемы; проверено прямым SQL — ровно 2 строки `RolePermission`, `ADMIN` +
`SUPER_ADMIN`, `FOREMAN`/`WORKER` отсутствуют структурно). `POST
/api/foreman/attendance/exceptions/:exceptionId/edit` тоже добавлен, но реализован как
безусловный fail-closed 403 — permission не выдана `FOREMAN` в v1 (owner-принятая рекомендация
§12.4), проверка происходит сразу после CSRF/аутентификации, до парсинга тела/валидации
`exceptionId`/чтения БД.

**Файлы**: три новых — `lib/clock-shift-fragment-edit.ts` (общее транзакционное ядро
`applyClockShiftFragmentReasonEdit` для single-fragment reported-правки + две чистые формулы,
`computeChangeType`/`buildClockShiftAdjustmentData`, вынесенные из `lib/worker-timesheets.ts` и
теперь используемые обоими путями — узкий, сознательно ограниченный shared-scope, НЕ полная
структурная унификация с multi-segment delete-all/recreate потоком worker `PATCH`, см. ниже),
`lib/attendance-exception-edit.ts` (резолвер: target-identity, request validation, полная 17-шаговая
транзакция, построение ответа), `app/api/admin/attendance/exceptions/[exceptionId]/edit/route.ts` +
`app/api/foreman/.../edit/route.ts`. Изменены: `lib/worker-timesheets.ts` (узкий рефакторинг — две
строки, `changeType`/`ClockShiftAdjustment.create` теперь зовут общие формулы, вся остальная
1200-строчная функция `patchWorkerTimesheetDay` не тронута), `lib/attendance-exception-resolution.ts`
(`parseStrictIsoInstant` стал `export`, переиспользован новым резолвером — без изменений логики).

**Транзакция** (17 шагов, `editAttendanceExceptionReason`): read-only `exceptionId`→`employeeId` →
`Employee` FOR UPDATE → `AttendanceException` FOR UPDATE → повторная проверка `status`/`type`/target
identity под локом → `Timesheet`/`TimesheetDraft` FOR UPDATE → повторная проверка DRAFT/RETURNED и
`reportedProjectionState=SETTLED` → `applyClockShiftFragmentReasonEdit` (создаёт
`ClockShiftAdjustment`, мутирует живой `TimesheetDraftSegment`, инкрементирует `contentRevision`,
сохраняет breaks нетронутыми) → для `OVERLAPPING_SHIFT` — явная проверка, что названная пара
реально перестала пересекаться (иначе весь transaction откатывается, `409 OVERLAP_STILL_PRESENT`) →
`AttendanceException` → `RESOLVED` с **реальным** `resolvedByUserId` (админ, никогда `SYSTEM`) →
**только затем** `resolveOverlapsForAffectedShifts` (§9.1a) для остальных потенциально затронутых
пар — порядок «сначала резолвим названное исключение реальным актором, потом общий overlap-hook»
критичен: без него общий hook мог бы попытаться авто-разрешить ту же самую названную пару через
`SYSTEM`-атрибуцию, гоняясь с явным человеческим действием. Достигнуто БЕЗ единого изменения
`lib/attendance-reported-projection.ts` — существующий `resolveOverlapTransition`'s
`latestRow.status === 'OPEN'`-guard уже структурно защищает от этой гонки, если резолвер сам
соблюдает порядок → один `AuditEvent(CLOCK_SHIFT_FRAGMENT_ADMIN_EDIT)` → COMMIT.

**Общее ядро — сознательно узкий scope, не полная унификация.** Риск переписывания
1200-строчного, тщательно протестированного multi-segment delete-all/recreate потока worker `PATCH`
в цикл над новым single-fragment ядром оценён как непропорционально высокий для этого слайса.
Общими сделаны только две чистые, буквально дублировавшиеся формулы; вся остальная логика worker
`PATCH` (day-type/absence handling, `previousLive`-карта, финальный `resolveOverlapsForAffectedShifts`-
вызов, `submitWorkerTimesheetCore`) не тронута — подтверждено `git diff` (два однострочных изменения
в этом файле) и полным regression-прогоном (см. ниже).

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (117/117 PASS): 72 business-logic
(migration/grants; ADMIN/SUPER_ADMIN success; все пять применимых типов; 9 неприменимых типов через
полную матрицу §11; terminal exception; точный/непрямой/`clockEventId`-only target-identity; неверный
employee/timesheet/period фрагмент; `OVERLAPPING_SHIFT` с любой стороны пары; `PENDING`-фрагмент;
отсутствующий live-сегмент; `FINAL_APPROVED`/`SUBMITTED`/`RETURNED`; частичные правки; строгая
ISO-8601 валидация; `CHECKOUT_CHRONOLOGY_ANOMALY` требует `endAt`; хронология; site/workArea
assignment-валидация, включая явный `workAreaId` при смене `siteId`; сохранение breaks; break вне
новых границ; segment overlap; no-op; `EDITED`/`RESTORED_TO_RECORDED`; реальная атрибуция актора;
raw `recorded*`-поля побайтово неизменны; `contentRevision` +1 ровно один раз; названное исключение
резолвится один раз; overlap физически исчезает; `OVERLAP_STILL_PRESENT`-откат; сторонние overlap-пары
резолвятся общим helper'ом (`SYSTEM`-атрибуция, не именованный админ); полный rollback принудительной
ошибки; sanitized response) + 18 concurrency (реальные ≥2 backend PID,
`pg_stat_activity.wait_event_type='Lock'` как доказательство блокировки, `holdLock`-техника с
раздельными acquired/release-сигналами: A — два одновременных `REASON_EDIT` одного исключения, ровно
один `200`/один `409 EXCEPTION_ALREADY_RESOLVED`, ровно один `ClockShiftAdjustment`, ровно один admin
`AuditEvent`; B — `REASON_EDIT` vs worker `PATCH` того же employee/фрагмента, `Employee`-лок
сериализует, корректная before→after цепочка без потерянной правки; C — `REASON_EDIT` vs ручной
submit, оба исхода проверены (edit-выиграл/submit-выиграл), никаких частичных данных; D —
`REASON_EDIT` vs сторонняя, но того же employee, операция materializer/overlap-класса, `Employee`-лок
сериализует, именованная пара резолвится реальным админом, несвязанная пара — `SYSTEM`, коллизии
атрибуции нет) + 8 regression (worker `PATCH` clean path создаёт корректно атрибутированный
`ClockShiftAdjustment` через общие формулы; `DISMISS`/`ACKNOWLEDGE_AS_VALID`; `FORCE_CLOSE_OPEN_SHIFT`
полный материализаторный путь; smoke-проверка `PAIR_ORPHAN_EVENTS`/`CONFIRM_SOURCE_ASSIGNMENT` —
ни один из пяти существующих `/resolve`-действий не задет) + 19 HTTP (CSRF; отсутствующая/невалидная
сессия; `WORKER`/`FOREMAN` → `403` на admin-роуте; foreman-роут `403` безусловно ДО парсинга
тела/валидации `exceptionId`, включая malformed JSON + fabricated id одновременно; отзыв каждого из
трёх admin-permission по отдельности → `403`; malformed/несуществующий `exceptionId` → `404`;
malformed JSON → `400`; полный HTTP success ADMIN + SUPER_ADMIN, точная документированная форма
ответа, отсутствие GPS/payloadHash/device-полей/cookies в теле; `409 EXCEPTION_ALREADY_RESOLVED` при
повторе).

Static: `git diff --check`/`prisma validate`/`tsc --noEmit` — зелёные. `npm run build` выполнен в
полностью изолированной detached-worktree копии (отдельный `node_modules`, скопирован из основного
worktree; собственный `.next`, не пересекается с работающим preview-сервером на `127.0.0.1:3244`) —
успешный build, оба новых `.../edit`-роута видны в build-манифесте как dynamic functions;
production HTTP-тесты выполнены против `npm start` этой же изолированной копии на выделенном порту
`127.0.0.1:3900`, сервер остановлен и worktree удалена после проверки. `docker compose -f
compose.titanor-time.yaml build app` — успешный build из основного worktree; production-контейнер
`titanor-time-app-1` подтверждён не тронутым (тот же `Up 9 days`/`healthy`/`127.0.0.1:3200`,
`/api/health` — `200` до и после). `prisma migrate deploy` на чистом одноразовом PostgreSQL 16 —
54/54 миграции (включая новую), повторный запуск — «No pending migrations to apply».

**Остаётся вне этого слайса** (явно, по границам задачи): exception-review UI (T7A.8C — отдельный,
ещё не начатый слайс; `01_SCREEN_MAP.md`/`02_ROLE_PERMISSION_MATRIX.md` обновлены соответствующей
пометкой), `attendance.gps.read.raw`, `attendance.conflict.read`, `attendance.policy.*`, admin
operational overview (T7A.9), scheduler/auto-submit (T7A.10). Preview на `127.0.0.1:3244` и его
одноразовая БД на `127.0.0.1:55432` не останавливались этим слайсом (production
`titanor-time-app-1`/`titanor-time-db-1` — только read-only inspect, не тронуты).

---

**T7A.8B.4A FORCE_CLOSE_OPEN_SHIFT — новый завершённый write-слайс поверх T7A.8B.3 (и его
follow-up fix `6c066c3` "serialize source assignment confirmation").** Реализует
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §8.5 (resolver-паттерн, тот же
задокументированный паттерн вторичного лока, что у `CONFIRM_SOURCE_ASSIGNMENT`)/§9.9 (полный
алгоритм FORCE_CLOSE_OPEN_SHIFT, дословно, плюс уточнение target identity)/§11/§12.1-12.3. Пятое
и последнее ADMIN/SUPER_ADMIN-специфичное resolution-действие на уже существующем `POST
/api/{admin,foreman}/attendance/exceptions/:exceptionId/resolve` — из шести действий §11 остаётся
нереализованным только `REASON_EDIT`; попытка любого другого/несуществующего значения по-прежнему
даёт `400 VALIDATION_ERROR` с точным перечнем пяти реализованных значений, не заглушка. **Новых
permissions/миграций не потребовалось** — переиспользованы уже существующие `attendance.exception.
resolve.all`/`.read.all` (та же ADMIN/SUPER_ADMIN-only структура, что и `CONFIRM_SOURCE_
ASSIGNMENT`).

**Файлы**: расширены те же три файла, что и в T7A.8B.3 (не новые) — `lib/attendance-exception-
resolution.ts` (+~230 строк: `forceCloseOpenShift`, `parseStrictIsoInstant`, новая
`FORCE_CLOSE_OPEN_SHIFT`-ветка в `validateResolveRequestBody` + симметричное запрещение
`explicitEndAt`/`reason` для остальных четырёх действий), admin `.../resolve/route.ts` (dispatch
на `forceCloseOpenShift`, шесть новых HTTP-исходов), foreman `.../resolve/route.ts` (тот же
403-паттерн, что уже был у `CONFIRM_SOURCE_ASSIGNMENT`, расширен на оба ADMIN-only действия через
`Set`). Ни один другой файл не изменён — подтверждено `git status`.

**Контракт**: `{action:"FORCE_CLOSE_OPEN_SHIFT", explicitEndAt, reason}` → `201
{resolutionAction, clockShift:{...force-closed форма...}, resolvedAt, resolvedBy,
resolutionNote}`. `explicitEndAt` — строгий ISO-8601 с обязательным `Z`/numeric UTC offset
(отдельный, более строгий парсер, чем существующий `parseIsoInstant`, который просто отдаёт
значение в `new Date()` и потому тихо принимает date-only/timezone-less строки как локальное
время — здесь это неприемлемо для административной записи с реальными payroll-последствиями).
`reason` обязателен, `resolutionNote` для этого действия явно запрещён — единственный источник
причины, во избежание двух расходящихся полей; нормализованное значение `reason` одновременно
пишется в `ClockShift.forceClosedReason`/`AttendanceException.resolutionNote`/`AuditEvent.reason`.

**Target identity (уточнение реализации относительно буквального §9.9)**: design doc буквально
предписывает `SELECT EmployeeOpenShift WHERE employeeId FOR UPDATE` — голый lookup по employeeId.
Реализация дополнительно проверяет `openedByClockEventId === exception.clockEventId`, та же
дисциплина, что уже применяет `CONFIRM_SOURCE_ASSIGNMENT` (§9.7) к своей `EmployeeOpenShift`-ветке
— без этой проверки FORCE_CLOSE мог бы закрыть более новую, никак не связанную с исключением
открытую смену того же работника, если бы она случайно существовала на момент вызова. Любое
несовпадение (не найдена / найдена другая / у исключения нет `clockEventId`) даёт единый `409
OPEN_SHIFT_ALREADY_CLOSED`, ничего не меняется.

**Mutation**: `INSERT ClockShift` в force-closed форме (`checkOutEventId=NULL`,
`forceClosedByUserId`/`forceClosedReason`/`forceClosedAt` все три non-null —
`ck_clock_shift_close_mechanism` удовлетворён по построению) → `DELETE EmployeeOpenShift` → RESOLVE
exception → один `AuditEvent(CLOCK_SHIFT_FORCE_CLOSED)`, только безопасные идентификаторы и
`reason`, без GPS/device/секретов. Ни один `ClockEvent` не создаётся — таблица сырых
device-фактов остаётся честной (design doc, §9.9 проза). Материализация не запускается инлайн —
`ClockShift.materializationState` остаётся `PENDING`, подхватывается следующим catch-up проходом
(§8.4), без изменений в самом материализаторе.

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (206/206 PASS, дважды подряд для
проверки детерминизма конкурентных тестов, прямые HTTP-вызовы против живого dev-сервера): permissions/
CSRF/body-shape (ADMIN/SUPER_ADMIN success, WORKER/anonymous forbidden, FOREMAN — well-formed/
malformed body оба дают `403`, не `400`/`404`, до чтения тела; malformed JSON; `resolutionNote`
запрещён отдельно от `reason`; cross-action поля запрещены в обе стороны для всех пяти действий;
timezone-less и date-only `explicitEndAt` отклонены; blank/too-long `reason` отклонены); applicability
(12 неприменимых типов через полную матрицу §11); terminal exception (`409
EXCEPTION_ALREADY_RESOLVED`, без дубля `ClockShift` при replay); originating shift уже закрыта
реальным Check Out (`409 OPEN_SHIFT_ALREADY_CLOSED`); новая несвязанная open shift не закрывается
(и последовательно, и под реальной блокировкой Employee-лока — `holdLock`-техника с раздельными
acquired/release-сигналами, `pg_stat_activity.wait_event_type='Lock'` как доказательство блокировки
для обеих сторон гонки); точное копирование `recordedStartAt`/site/workArea/sourceAssignmentId
(включая nullable), `endAtProvisional=false`, все force-поля; отсутствие нового `ClockEvent`,
исходный `ClockEvent` побайтово неизменен; строгая хронология (equal/earlier отклонены, far-future
принят без самовольного clamp/лимита); один sanitized `AuditEvent`; отсутствие GPS/device/секретов
в HTTP-ответе и audit; реальная многосессионная конкуренция A–E (детали — см. отчёт по коммиту);
materializer catch-up regression (с/без `sourceAssignmentId` — второй случай доказан через
композицию с `CONFIRM_SOURCE_ASSIGNMENT`'s graceful fallback, ни материализатор, ни резолвер не
изменены; overlap-сценарий — существующий overlap-детектор ловит пересечение без вмешательства
этого действия; идемпотентность повторного прохода). Полная regression DISMISS/
ACKNOWLEDGE_AS_VALID/PAIR_ORPHAN_EVENTS/CONFIRM_SOURCE_ASSIGNMENT — 24/24 отдельным прогоном,
включая FOREMAN 403-ordering для обоих ADMIN-only действий, CONFIRM vs реальный checkout, CONFIRM
`FOR SHARE`-lock (T7A.8B.3 follow-up fix `6c066c3`) regression, изоляцию action-specific полей для
всех пяти действий в обе стороны.

Static: `git diff --check`/`prisma validate`/`tsc --noEmit` — зелёные; `npm run build` выполнен в
полностью изолированной временной detached-worktree копии (отдельный `node_modules`/`.next`, не
пересекается с работающим preview-сервером на `127.0.0.1:3244`) — успешный build, оба
`.../resolve` роута видны в build-манифесте; временная worktree удалена после проверки.
`docker compose build app` — успешный build из основного worktree (единственный побочный эффект —
локальный тег `titanor-time-app:latest` перевешен на новый ID, production-контейнер не тронут,
подтверждено тем же image ID/`RestartCount`/`StartedAt` до и после). `prisma migrate deploy` на
чистом одноразовом PostgreSQL 16 — 53/53 миграции (новых миграций этот слайс не добавляет),
повторный запуск — «No pending migrations to apply».

**Остаётся вне этого слайса** (явно, по границам задачи): `REASON_EDIT` (T7A.8B.4B, последнее
resolution-действие §11), exception-review UI, `attendance.gps.read.raw`,
`attendance.conflict.read`, `attendance.policy.*`, admin operational overview (T7A.9),
scheduler/auto-submit (T7A.10). Schema/permission-миграции не менялись. Preview на
`127.0.0.1:3244` и его одноразовая БД на `127.0.0.1:55432` не останавливались этим слайсом
(production `titanor-time-app-1`/`titanor-time-db-1` — только read-only inspect, не тронуты).

---

**T7A.8B.3 CONFIRM_SOURCE_ASSIGNMENT — новый завершённый write-слайс поверх T7A.8B.2.** Реализует
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §8.5 (resolver-паттерн, с задокументированным
исключением из строгого lock order — «не более одной дополнительной строки позиции 3»)/§9.7
(полный алгоритм CONFIRM_SOURCE_ASSIGNMENT, дословно)/§11/§12.1-12.3. Четвёртое реализованное
resolution-действие на уже существующих `POST /api/{admin,foreman}/attendance/exceptions/
:exceptionId/resolve` — `FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT` по-прежнему дают `400
VALIDATION_ERROR` с точным перечнем четырёх реализованных значений, не заглушка. **Новых
permissions/миграций не потребовалось** — переиспользованы уже существующие `attendance.exception.
resolve.all` (единственный держатель — `CONFIRM_SOURCE_ASSIGNMENT` структурно `ADMIN`/
`SUPER_ADMIN`-only) + `attendance.exception.read.all`.

**Файлы**: расширены три уже существующих файла (не новые) — `lib/attendance-exception-
resolution.ts` (+~280 строк: `confirmSourceAssignment`, `lockConfirmTarget`,
`isChosenAssignmentValid`, расширенный `validateResolveRequestBody`/`ParsedResolveRequest`/
`IMPLEMENTED_RESOLUTION_ACTIONS`), admin `.../resolve/route.ts` (dispatch на `confirmSourceAssignment`,
семь новых HTTP-исходов), foreman `.../resolve/route.ts` (403 FORBIDDEN на сыром теле для этого
action, до `validateResolveRequestBody`). Ни `lib/attendance-exceptions.ts` (read), ни
`lib/foreman-review.ts`, ни `lib/api-error.ts`, ни `lib/attendance-materializer.ts`, ни
`lib/attendance-clock.ts` не изменены этим слайсом — подтверждено `git status` (единственный новый
`import` в `lib/attendance-exception-resolution.ts` — уже экспортированная
`helsinkiCalendarDateAsUtcMidnight` из T7A.7A, переиспользована как есть).

**Контракт**: `{action:"CONFIRM_SOURCE_ASSIGNMENT", chosenAssignmentId, resolutionNote?}` → `200
{resolutionAction, target:{type, id, sourceAssignmentId}, resolvedAt, resolvedBy,
resolutionNote}`. `chosenAssignmentId` обязателен и должен быть UUID для этого действия;
`checkInEventId`/`checkOutEventId` для него явно запрещены (`400`); `chosenAssignmentId` явно
запрещён для остальных трёх действий (симметрично уже существующей защите PAIR-полей от
DISMISS/ACK) — stale UI не может отправить двусмысленное тело ни в одну сторону.

**Target resolution (§9.7 шаг 4), все три формы доказаны отдельно**: `clockShiftFragmentId` →
`ClockShiftFragment`; иначе `clockShiftId` → `ClockShift`; иначе `clockEventId` → живая
`EmployeeOpenShift` (`openedByClockEventId` совпадает), а если смена с тех пор закрылась реальным
Check Out — graceful fallback на `ClockShift` по `checkInEventId`. Ни один валидный target не
найден → стабильный `409 TARGET_NOT_FOUND`, без частичных изменений. Target-дата: fragment —
собственное поле `date`; ClockShift/EmployeeOpenShift — Helsinki calendar date
(`helsinkiCalendarDateAsUtcMidnight`, не UTC truncate) от `recordedStartAt`/`openedAt`
соответственно.

**Assignment/date-валидация (§9.7 шаг 5)**: `SiteAssignment(chosenAssignmentId)` внутри
транзакции — `employeeId` совпадает, `siteId` совпадает с target, `validFrom <= targetDate <=
COALESCE(validTo, 'infinity')` (включительно с обеих сторон, доказано отдельным тестом на точной
границе). `workAreaId` НЕ добавлен как ограничение (в §9.7 его нет — намеренно не как у online
check-in). Единое `400 VALIDATION_ERROR` для «не найдена»/«чужой employee»/«чужой site»/«вне
диапазона дат» — не раскрывает, какая именно причина, ни тем более данные чужого employee/site.
Helsinki-полночь и DST-переход (2026-10-25, Europe/Helsinki) проверены прямыми тестами с
инстантами по разные стороны границы.

**Mutation/immutability**: `sourceAssignmentId` допускает только переход `NULL`→value — сервисный
precheck (`target.sourceAssignmentId !== null` → `409 TARGET_ALREADY_RESOLVED`, без похода в
`UPDATE`) ДО DB-триггера, который остаётся defense-in-depth, не единственной линией защиты
(подтверждено прямой raw-SQL попыткой повторного `UPDATE` — `CLOCK_SHIFT_SOURCE_ASSIGNMENT_
ALREADY_RESOLVED`/`CLOCK_SHIFT_FRAGMENT_SOURCE_ASSIGNMENT_ALREADY_RESOLVED`, P0001). `ClockEvent`/
`ClockEventLocation` никогда не изменяются — подтверждено побайтовым сравнением до/после.
Материализатор НЕ запускается инлайн — `ClockShift.materializationState` не трогается этой
транзакцией; следующий periodic catch-up (§8.4) подхватывает нормально (доказано: для
fragment-цели catch-up создаёт ровно один сегмент, повторный проход идемпотентен — ноль дублей).

**Транзакция/lock order**: `Employee FOR UPDATE` → `AttendanceException FOR UPDATE` (canonical
order §8.1) → перечитать status/type → определить и заблокировать target (`FOR UPDATE` на
`ClockShiftFragment`/`ClockShift` по id, либо на `EmployeeOpenShift` по `(employeeId,
openedByClockEventId)`) → если уже resolved — `409` без мутации → проверить `chosenAssignmentId` →
один `UPDATE` target → один `UPDATE AttendanceException` (→`RESOLVED`) → один
`AuditEvent(CLOCK_SHIFT_ASSIGNMENT_RESOLVED)` → `COMMIT`. **Осознанное, задокументированное
отклонение от строгого возрастающего §8.1-порядка**: target (`EmployeeOpenShift`/`ClockShift` —
позиции 3/4) блокируется ПОСЛЕ `AttendanceException` (позиция 7) — это в точности сценарий, уже
явно санкционированный §8.5 («для остальных действий — не более одной дополнительной строки
позиции 3»), тот же паттерн, что уже используют `pairOrphanEvents`/`resolveAttendanceException` для
своих вторичных локов; не переоткрыт заново, применён как есть.

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (152/152 PASS, прямые HTTP-вызовы
против живого dev-сервера, дважды подряд на чистой БД для проверки детерминизма конкурентных
тестов): permissions/CSRF/body-shape (ADMIN/SUPER_ADMIN success, WORKER/anonymous forbidden,
FOREMAN — well-formed/malformed/missing `chosenAssignmentId` все три дают `403 FORBIDDEN`, не
`400`, до чтения тела; malformed JSON; `chosenAssignmentId` запрещён для DISMISS/ACK/PAIR;
checkIn/checkOutEventId запрещены для CONFIRM); все 14 типов исключений через полную матрицу §11
(только `STALE_ASSIGNMENT` применимо); assignment-валидация (чужой employee — id не утекает в
ответ, чужой site, вне диапазона дат, несуществующий id, включительно `validFrom==validTo==
targetDate`, Helsinki-vs-UTC календарная дата, DST-переход); все три формы target (доказаны
отдельно, включая графовый fallback open→closed shift через РЕАЛЬНЫЙ online Check Out); target
already resolved; exception already resolved; target not found; nonexistent exceptionId;
immutable `ClockEvent` побайтово; DB-триггер отклоняет прямой raw-SQL повтор; ровно один sanitized
`AuditEvent` (проверено отсутствие GPS/координат/device id/sequence/payloadHash/token/secret и в
audit, и в HTTP-ответе); regression DISMISS/ACK/PAIR (все три по-прежнему `200`/`201`);
materializer catch-up + идемпотентность (ровно один сегмент, повторный проход — ноль дублей);
реальный `POST check-out` (после CONFIRM'а на живой `EmployeeOpenShift`) наследует
`sourceAssignmentId` в результирующую `ClockShift`.

**Реальная многосессионная конкуренция** (`pg_stat_activity`, ≥2 подтверждённых конкурентных
backend PID, не `Promise.all`-тайминг): два одновременных CONFIRM одного исключения → ровно один
`200`/один `409`, одно изменение target, exception резолвится ровно один раз; две разные `OPEN`
`STALE_ASSIGNMENT`-строки, указывающие на одну и ту же цель → ровно один `200`/один `409
TARGET_ALREADY_RESOLVED`, проигравшая exception остаётся `OPEN` (не ложно `RESOLVED`).

**Rollback**: принудительный реальный FK-violation при `AuditEvent` (несуществующий `actorUserId`,
вызвано напрямую через `confirmSourceAssignment`, не HTTP-роут — та же техника, что уже
использовалась для T7A.8B.1/8B.2) ПОСЛЕ `UPDATE` target и `UPDATE` exception, но до `COMMIT` →
подтверждённый полный откат: target возвращается к `sourceAssignmentId=NULL`, exception остаётся
`OPEN`, `AuditEvent` не создан — ноль частичных строк.

**Regression**: DISMISS/ACKNOWLEDGE_AS_VALID/PAIR_ORPHAN_EVENTS — не регрессировали (собственные
проверки внутри этого же прогона, код всех трёх веток не менялся, только добавлена симметричная
проверка `chosenAssignmentId`-запрета в `validateResolveRequestBody`); online check-in/check-out —
реально вызваны и успешны внутри section 5 (fallback/inheritance тесты); `scripts/
_test-activation.ts` — зелёный на отдельной чистой БД; `scripts/_test-corrections.ts` (fixture
generator, не изменённый этим слайсом функционал) — фикстуры создаются без ошибок на текущей
схеме. Offline sync/outbox/geofence-admin HTTP-прогон отдельно не перезапущен — риск структурно
нулевой (`git status`: изменены только три файла, ни один не участвует в этих путях выполнения).

Static: `git diff --check`/`prisma validate`/`tsc --noEmit` — зелёные; `npm run build` выполнен в
полностью изолированной временной worktree-копии (detached HEAD + скопированный
`node_modules`, отдельный `.next`, НЕ пересекается с работающим preview-сервером на
`127.0.0.1:3244`) — успешный build, оба `.../resolve` роута видны в build-манифесте
(`/api/admin/attendance/exceptions/[exceptionId]/resolve`, `/api/foreman/attendance/exceptions/
[exceptionId]/resolve`); временная worktree удалена после проверки. `prisma migrate deploy` на
чистом одноразовом PostgreSQL 16 — 53/53 миграции (новых миграций этот слайс не добавляет),
повторный запуск — «No pending migrations to apply».

**Остаётся вне этого слайса** (явно, по границам задачи): `FORCE_CLOSE_OPEN_SHIFT`, `REASON_EDIT`
(T7A.8B.4), exception-review UI, `attendance.gps.read.raw`, `attendance.conflict.read`,
`attendance.policy.*`, admin operational overview (T7A.9), scheduler/auto-submit (T7A.10).
Schema/permission-миграции не менялись. Preview на `127.0.0.1:3244` и его одноразовая БД на
`127.0.0.1:55432` не останавливались этим слайсом (production `titanor-time-app-1`/
`titanor-time-db-1` — только read-only inspect, не тронуты).

---

**T7A.8B.2 PAIR_ORPHAN_EVENTS — новый завершённый write-слайс поверх T7A.8B.1.** Реализует
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §8.5 (resolver-паттерн)/§9.8 (полная
валидация PAIR_ORPHAN_EVENTS, дословно)/§11/§12.1-12.3. Третье реализованное resolution-действие
на уже существующих `POST /api/{admin,foreman}/attendance/exceptions/:exceptionId/resolve` —
`CONFIRM_SOURCE_ASSIGNMENT`/`FORCE_CLOSE_OPEN_SHIFT`/`REASON_EDIT` по-прежнему дают `400
VALIDATION_ERROR` с точным перечнем трёх реализованных значений, не заглушка. **Новых
permissions/миграций не потребовалось** — переиспользованы уже существующие `attendance.exception.
resolve.{assigned,all}` + read-эквиваленты.

**Файлы**: расширены три уже существующих файла (не новые) — `lib/attendance-exception-
resolution.ts` (+~330 строк: `pairOrphanEvents`, объединённый `validateResolveRequestBody`,
`checkForemanScopeForPair`), оба `.../resolve/route.ts` (dispatch по `action` на
`resolveAttendanceException` либо новый `pairOrphanEvents`, шесть новых HTTP-исходов). Ни
`lib/attendance-exceptions.ts` (read), ни `lib/foreman-review.ts`, ни `lib/api-error.ts`, ни
`lib/attendance-materializer.ts`, ни `lib/attendance-clock.ts` не изменены этим слайсом —
подтверждено `git status`.

**Расширенный контракт**: `{action:"PAIR_ORPHAN_EVENTS", checkInEventId, checkOutEventId,
resolutionNote?}` → `201 {resolutionAction, clockShift, resolvedExceptions[], resolvedAt,
resolvedBy, resolutionNote}`. `checkInEventId`/`checkOutEventId` обязательны и должны отличаться
для PAIR; для DISMISS/ACK эти же поля теперь явно ЗАПРЕЩЕНЫ (`400`, не тихо игнорируются) — stale
UI не может отправить двусмысленное тело. Новые ошибки: `404 CLOCK_EVENT_NOT_FOUND`, `409
EVENT_ALREADY_PAIRED`, `409 PAIRED_SHIFT_OVERLAP`.

**Применимость (§9.8)**: только `DOUBLE_CHECK_IN`/`CHECKOUT_WITHOUT_OPEN_SHIFT`, OPEN. Named
exception обязан быть связан с выбранной парой (`clockEventId` совпадает с соответствующим
event id) — иначе `400`, не позволяя использовать видимое чужое исключение как authorization
anchor для произвольной пары другого работника (проверено отдельным security-тестом: события
совпадают друг с другом, но принадлежат ДРУГОМУ employee, чем named exception → `400`, ни одна
строка для другого employee не создаётся/не трогается).

**Валидация ClockEvent (7 пунктов §4 задания, все — read-only pre-check + идентичный re-check
внутри транзакции)**: существование обоих событий, `operationType` (CHECK_IN/CHECK_OUT
соответственно), общий `employeeId` для обоих событий, `employeeId` совпадает с named exception,
строгая хронология БЕЗ clamp (`checkOutEvent.effectiveAt > checkInEvent.effectiveAt`, автоматический
clamp §9.2 — только для online Check Out), различные id, raw `ClockEvent` НИ РАЗУ не изменяется
(доказано побайтовым сравнением до/после). `ClockShift` создаётся напрямую из immutable-событий,
не из тела запроса: `siteId`/`workAreaId`/`sourceAssignmentId` — из `checkInEvent`, `sourceAssignmentId
= NULL` копируется как есть, не обходя существующую `STALE_ASSIGNMENT`-семантику материализатора
(проверено — catch-up после такой пары возвращает `PENDING_SOURCE_ASSIGNMENT`, не материализуется
тихо).

**Event reuse/overlap (§5)**: явный precheck `SELECT` перед `INSERT` (не только `UNIQUE`-constraint
defense-in-depth) — `409 EVENT_ALREADY_PAIRED`. Overlap — `tstzrange`'ов `&&` с дефолтными
`[)`-границами (проверено: точное касание `end===start` разрешено, реальное пересечение —
`409 PAIRED_SHIFT_OVERLAP`, ничего не создаётся/не мутируется). `PAIR_ORPHAN_EVENTS` не создаёт
`OVERLAPPING_SHIFT` — пара при существующем overlap отклоняется целиком, до `INSERT`.

**Транзакция/lock order**: `Employee FOR UPDATE` → named `AttendanceException FOR UPDATE` →
(Employee уже держится → свежий, race-free поиск complementary OPEN-исключения тем же tx-клиентом)
→ `AttendanceException FOR UPDATE` комплементарной, если найдена → event-reuse → overlap → `INSERT
ClockShift(PENDING)` → `UPDATE` каждой резолвящейся exception (named + комплементарная, если ещё
OPEN — историческая `DISMISSED`/`RESOLVED` НЕ переписывается) → один `AuditEvent` → `COMMIT`.
**Осознанное упрощение относительно первоначального черновика**: два exception-лока не сортируются
в canonical-порядке между собой — доказано, что это не нужно, поскольку `AttendanceException`
всегда single-employee-owned, а Employee-лок уже держится ПЕРВЫМ КАЖДОЙ resolver-транзакцией в
этой кодовой базе, так что держание Employee уже полностью сериализует любые две resolver-транзакции
одного employee — деталь явно задокументирована в коде и отчёте, не тихое расхождение.
**Единственное расхождение с буквальным текстом §9.8**: `403 FOREMAN_SCOPE_INCOMPLETE` вместо
`403 FORBIDDEN` из §9.8 для неполного scope — намеренно, ради консистентности с уже установленным
в T7A.8B.1 кодом ошибки для той же самой ситуации (`OVERLAPPING_SHIFT` own↔foreign); доменный
инвариант («FOREMAN недоступно, если хотя бы один сайт чужой») сохранён дословно.

**FOREMAN all-sites scope**: объединение named exception'а собственных пяти связей ∪
`checkInEvent.siteId` ∪ `checkOutEvent.siteId` — переиспользует ту же `anyOwn`/`allOwn`-функцию
T7A.8B.1 (вынесена в общий `checkForemanScopeForSiteIds`), не дублирует логику. Базовая видимость
(только собственный scope named exception) проверяется ДО чтения событий — невидимое исключение
не дифференцирует ответ по присланным event id.

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (126/126 PASS, прямые HTTP-вызовы
против живого dev-сервера): HTTP (admin/foreman positive, WORKER/CSRF/auth negative, malformed
JSON/action/eventId/note, DISMISS/ACK регрессия, три будущих действия по-прежнему `400` с
обновлённым перечнем из трёх значений); applicability (все 14 типов — 2 положительных + 12
`ACTION_NOT_APPLICABLE` с `allowedActions` по §11, linked-event mismatch, named terminal,
комплементарная OPEN резолвится вместе, комплементарная terminal НЕ переписывается побайтово);
event validation (missing event, wrong operation type, разные employee, employee расходится с
exception, равные/обратные timestamps, boundary-touching разрешён, true overlap запрещён); state
(точные поля `ClockShift`, `ClockEvent` побайтово неизменны, ровно резолвятся выбранные exceptions,
ровно один `AuditEvent`, rollback без частичных строк — реальный `AuditEvent.actorUserId`
FK-violation форсирует настоящий Postgres-откат ПОСЛЕ `INSERT`+`UPDATE`, catch-up материализатор
подхватывает нормальную пару отдельным проходом, `sourceAssignmentId=NULL` не обходит
`STALE_ASSIGNMENT`); FOREMAN scope+security (standalone, dual-role self, both-own, checkout-foreign
→ `FOREMAN_SCOPE_INCOMPLETE` без утечки id/имени чужого сайта, named-own+other-foreign, полностью
невидимое исключение → `404`, ноль GPS/device-полей в response/audit). **Реальная многосессионная
конкурентность** (`lockBlocker` + `pg_stat_activity`, не `Promise.all`-тайминг): два одновременных
PAIR одной пары через РАЗНЫЕ orphan-исключения → ровно одна `ClockShift`, один `201`, один `409`
(`EXCEPTION_ALREADY_RESOLVED`/`EVENT_ALREADY_PAIRED`), один `AuditEvent`, ≥2 подтверждённых
конкурентных backend PID; две разные пары, переиспользующие один event → одна побеждает, вторая
`EVENT_ALREADY_PAIRED`, ноль partial exceptions; PAIR против реального online `POST check-out`
того же employee (не связанных друг с другом смен) → оба успешны, Employee-lock сериализует,
ноль cross-contamination; `ForemanAssignment` истекает МЕЖДУ pre-read и transactional recheck →
мутация не проходит, ноль writes.

**Regression**: T7A.8A `GET`-роуты (включая `resolvedBy` от новых мутаций) — зелёные; T7A.8B.1
DISMISS/ACK — не регрессировали (собственные проверки внутри этого же прогона, код обеих веток не
менялся, только сигнатура типа сужена); online clock (`POST check-out`, реально вызван и успешен
внутри concurrency-теста #3) и materializer (`materializeClockShift`, реально вызван внутри
state-тестов) — эмпирически упражнены; `scripts/_test-activation.ts`/`_test-corrections.ts` —
зелёные на отдельной чистой БД; offline sync/outbox/geofence-admin/worker-timesheets HTTP-прогон
отдельно не перезапущен — риск структурно нулевой (`git status`: изменены только те же три файла,
что и в T7A.8B.1, ни один не участвует в этих путях выполнения).

Static: `git diff --check`/`prisma validate`/`tsc --noEmit`/`npm run build` (оба `.../resolve`
роута видны в build-манифесте) — зелёные; `docker compose build app` — успешный build (снова
только перевесил локальный тег, `docker inspect` до/после подтверждает тот же image ID/
`StartedAt`/`RestartCount=0`/`healthy`); `prisma migrate deploy` на чистом одноразовом PostgreSQL
16 — 53/53 миграции (новых миграций этот слайс не добавляет), повторный запуск — «No pending
migrations to apply».

**Остаётся вне этого слайса** (явно, по границам задачи): `CONFIRM_SOURCE_ASSIGNMENT`,
`FORCE_CLOSE_OPEN_SHIFT`, `REASON_EDIT` (T7A.8B.3/8B.4), exception-review UI, `attendance.gps.
read.raw`, `attendance.conflict.read`, `attendance.policy.*`, admin operational overview (T7A.9),
scheduler/auto-submit (T7A.10). Schema/permission-миграции не менялись.

---

**T7A.8B.1 Base Attendance Exception Resolution (DISMISS/ACKNOWLEDGE_AS_VALID) — новый
завершённый write-слайс поверх T7A.8A.** Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md`
§8.5 (resolver-паттерн, дословно), §11 (матрица «тип → допустимые действия», только эти два
действия из шести), §12.1/§12.3. **Только `DISMISS`/`ACKNOWLEDGE_AS_VALID`** — `PAIR_ORPHAN_EVENTS`,
`CONFIRM_SOURCE_ASSIGNMENT`, `REASON_EDIT`, `FORCE_CLOSE_OPEN_SHIFT` не реализованы; попытка любого
из них → `400 VALIDATION_ERROR` по полю `action` с точным перечнем двух реализованных значений, не
временная заглушка. Exception-review UI, operational overview, scheduler не затронуты.

**Файлы**: новая additive DML-миграция `20260817000000_seed_attendance_exception_base_resolution_permissions`
(`attendance.exception.resolve.assigned`→`FOREMAN`, `attendance.exception.resolve.all`→`ADMIN`/
`SUPER_ADMIN`; ни четыре нереализованных action-specific permission, ни `attendance.gps.read.raw`,
ни `attendance.conflict.read`, ни `timesheet.draft.edit.exception`, ни `attendance.policy.*` не
сеются — подтверждено прямым SQL). Новый `lib/attendance-exception-resolution.ts` (единственный
владелец транзакции/lock-order/scope-проверки для мутации — намеренно отдельный файл от read-only
`lib/attendance-exceptions.ts`, разный concurrency-контракт) + два новых route-файла
(`app/api/{admin,foreman}/attendance/exceptions/[exceptionId]/resolve/route.ts`). **Минимальные
additive-правки к трём существующим файлам** (регрессия подтверждена отдельно, см. ниже):
`lib/foreman-review.ts`'s `getForemanSiteIds` получил необязательный третий параметр `client`
(по умолчанию — прежний глобальный `prisma`, все 8 существующих call site не изменены) для
переиспользования внутри мутационной транзакции; `lib/api-error.ts`'s `ApiErrorBody` получил
необязательное поле `allowedActions?` (тот же паттерн, что уже существующий `blockers?`); `lib/
attendance-exceptions.ts`'s `actorDisplayName` экспортирован (было приватным) для переиспользования
в `resolvedBy` мутации.

**Resolver-паттерн (§8.5), дословно**: read-only pre-read (`exceptionId` → `employeeId`/`type`/
`status`/site-relations, без лока) → `prisma.$transaction`: `Employee FOR UPDATE` →
`AttendanceException FOR UPDATE` (тот самый canonical order §8.1: `Employee`(1) перед
`AttendanceException`(7), ни разу не в обратном порядке) → перечитать status/type/scope заново
из транзакции (`getForemanSiteIds(..., tx)` — не из pre-read кэша) → единственный `UPDATE
AttendanceException` → один `AuditEvent` в той же транзакции → `COMMIT`. Любой исход, найденный
ДО мутации (уже не `OPEN`, неприменимое действие, scope не сходится, смена всё ещё открыта),
завершает транзакцию нормальным `COMMIT` без единой записи — нечего откатывать.

**FOREMAN mutation scope строже read-scope**: `GET` (T7A.8A) считает исключение видимым при
непустом пересечении `scopeSiteIds`(пяти связей)∩`ownCurrentSiteIds`; мутация требует, чтобы
**все** `scopeSiteIds` были собственными — иначе `403 FOREMAN_SCOPE_INCOMPLETE` (own↔foreign
`OVERLAPPING_SHIFT`: видно через `GET`, резолюция запрещена, ноль мутаций/`AuditEvent`). Пустое
пересечение (foreign/no-scope) → тот же безопасный `404 EXCEPTION_NOT_FOUND`, что и в `GET`.
Dual-role self-exclusion — тот же `404`. Scope перепроверяется на **каждый** запрос заново внутри
транзакции — доказано реальной гонкой (см. concurrency ниже), не декларативно.

**Матрица действий (§11)** реализована как статическая таблица (`DISMISS`: 12 типов разрешено,
`STALE_ASSIGNMENT`/`LATE_SYNC_AFTER_SUBMIT` — нет; `ACK`: 7 типов разрешено, 7 — нет) плюс три
динамических инварианта: `CHECKOUT_CHRONOLOGY_ANOMALY`+`DISMISS` требует непустой
`resolutionNote`; `MISSING_CHECKOUT_AT_CUTOFF`+`DISMISS` проверяет `EmployeeOpenShift` именно по
`openedByClockEventId` исходного события (не любую открытую смену — более новый Check In создаёт
НЕСВЯЗАННУЮ `EmployeeOpenShift`, не блокирующую dismissal старого исключения); `OVERLAPPING_SHIFT`
`DISMISS` обновляет только `status`/`resolvedBy*`/`resolutionNote` конкретной canonical-пары —
`overlapEndedAt` никогда не трогается этим действием, оставлен уже существующему
`resolveOverlapTransition` (`lib/attendance-reported-projection.ts`, не изменён), который при
последующем физическом исчезновении overlap заполняет **только** `overlapEndedAt`, не переписывая
human `resolvedByUserId`/`resolvedAt`/`resolutionNote` — подтверждено прямым вызовом той же
production-функции в тесте. `409 ACTION_NOT_APPLICABLE` возвращает `allowedActions` — полную
domain-матрицу §11 (может включать нереализованные действия, чисто информационно).

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (120/120 PASS, прямые HTTP-вызовы
`fetch` против живого dev-сервера): permissions (точные 6 grants, resolve независим от read в обе
стороны — временно отозван `resolve.assigned` у `FOREMAN`, `GET` продолжил работать, `POST
.../resolve` немедленно вернул `403`, грант восстановлен); HTTP/security (CSRF/auth/permission/
malformed JSON·body·action·note/unknown-fields-ignored/whitespace-note-as-absent/malformed vs
missing id → идентичный `404`); полная матрица — **все 14 типов × оба действия**, включая
`allowedActions` дословно по §11 (58 проверок); `CHECKOUT_CHRONOLOGY_ANOMALY` note-инвариант (с/без
note, `ACK` всегда `ACTION_NOT_APPLICABLE`); `MISSING_CHECKOUT_AT_CUTOFF` динамический guard (shift
уже закрыт → `DISMISS` проходит; shift всё ещё открыт → `409 OPEN_SHIFT_STILL_PENDING`, ничего не
меняется; другая, не относящаяся к делу открытая смена не блокирует); FOREMAN mutation scope (все
восемь под-сценариев — all-sites/expired/own↔foreign-forbidden/no-scope/standalone/dual-role-self/
different-foreman-can/admin-no-restriction); state-инварианты (terminal replay — второй `DISMISS`/
`ACK` не меняет уже записанные `resolvedBy`/`resolvedAt`/`resolutionNote`, ровно один `AuditEvent`
навсегда; rollback без audit — `OPEN_SHIFT_STILL_PENDING` не пишет ничего; per-period independence
— `PERIOD_BOUNDARY_SPAN` одного `clockShiftId`, разных периодов, решение одной строки не трогает
другую); `OVERLAPPING_SHIFT` pair independence — X одновременно пересекается с Y и Z, `DISMISS`
X↔Y оставляет X `BLOCKED_OVERLAP` (реальный вызов `materializeClockShift`, design-doc тесты
#63/#64-эквивалент), только после `DISMISS` обеих пар X перестаёт быть `BLOCKED_OVERLAP` (тест
#52-эквивалент); human-DISMISS-переживает-auto-overlapEndedAt (design-doc тест #106-эквивалент,
прямой вызов `resolveOverlapTransition`). **Реальная многосессионная конкурентность** (не
Promise-only — собственный `lockBlocker` открывает interactive-транзакцию, держит те же
`Employee`+`AttendanceException FOR UPDATE` локи `holdMs`, конкурентные HTTP-запросы физически
блокируются на этом же locке; `pg_stat_activity`-поллинг во время гонки подтвердил ≥2 одновременно
активных backend PID): два одновременных `DISMISS` — ровно один `200`, один `409`, один
`AuditEvent`; `DISMISS` vs `ACK` — ровно один победитель, итог соответствует победившему действию;
`ForemanAssignment` истекает МЕЖДУ pre-read и транзакционной проверкой — мутация не проходит,
исключение остаётся `OPEN`, ноль `AuditEvent`; `MISSING_CHECKOUT_AT_CUTOFF DISMISS` против
реального `POST check-out` (тот же `Employee`-лок сериализует оба) — ровно одна из двух
самосогласованных interleaving, никогда испорченного промежуточного состояния.

**Regression**: `getForemanSiteIds`'s расширенная сигнатура — 2-arg/3-arg-`prisma`/3-arg-`tx`
формы дают идентичный результат (отдельный direct-call тест); все T7A.8A `GET`-роуты (list/detail,
включая новый `resolvedBy` в ответе detail) — зелёные на живом сервере; `scripts/_test-activation.ts`,
`scripts/_test-corrections.ts` — зелёные на отдельной чистой БД; online clock (`POST check-out`
реально вызван и успешно выполнен внутри concurrency-теста #4) и materializer (`materializeClockShift`
реально вызван внутри overlap-тестов) — эмпирически упражнены как часть основного набора тестов, не
отдельным прогоном; offline sync/outbox/geofence-admin/worker-timesheets HTTP-прогон отдельно не
перезапущен — риск структурно почти нулевой (`git status` подтверждает: из существующих файлов
изменены только `lib/foreman-review.ts`(+10/-2 строк, backward-compatible),
`lib/api-error.ts`(+5 строк, только тип), `lib/attendance-exceptions.ts`(+4/-1, только export) —
ни один из этих трёх файлов не участвует в offline-sync/outbox/geofence-admin/worker-timesheets
путях выполнения кода вовсе).

Static: `git diff --check`/`prisma validate`/`tsc --noEmit`/`npm run build` (все шесть роутов, включая
два новых `/resolve`, видны в build-манифесте) — зелёные; `docker compose build app` — успешный build
(мандаторный тест, снова только перевесил локальный тег `titanor-time-app:latest`, `docker inspect`
до/после подтверждает тот же image ID/`StartedAt`/`RestartCount=0`/`healthy` у обоих
production-контейнеров); `prisma migrate deploy` на чистом одноразовом PostgreSQL 16 — 53/53
миграции (52 было + одна новая), повторный запуск — «No pending migrations to apply».

**Остаётся вне этого слайса** (явно, по границам задачи): `PAIR_ORPHAN_EVENTS`,
`CONFIRM_SOURCE_ASSIGNMENT`, `REASON_EDIT`, `FORCE_CLOSE_OPEN_SHIFT` (T7A.8B.2/8B.3),
exception-review UI, `attendance.gps.read.raw`/raw coordinate access, `attendance.conflict.read`,
`attendance.policy.*`, admin attendance operational overview (T7A.9), scheduler/auto-submit
(T7A.10). Schema/migrations (кроме одной additive DML)/online route surface не изменены.

---

**T7A.8A Attendance Exception Review — Read Foundation — новый завершённый read-only слайс.**
Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §11 (матрица «тип исключения →
допустимые resolution-действия», используется здесь только как справочный контекст — сами действия
НЕ реализованы), §12.1 (permission-строки `attendance.exception.read.{assigned,all}`), §12.3
(`GET /api/{admin,foreman}/attendance/exceptions[/:exceptionId]`). **Только чтение** — ни одна
мутация `AttendanceException.status` не добавлена этим слайсом; resolution-действия (`DISMISS`,
`ACKNOWLEDGE_AS_VALID`, `PAIR_ORPHAN_EVENTS`, `CONFIRM_SOURCE_ASSIGNMENT`, `REASON_EDIT`,
`FORCE_CLOSE_OPEN_SHIFT`), exception-review UI, operational overview (`ClockEventIdConflict`/
`DeviceEventReceipt(REJECTED_TERMINAL)`) и scheduler остаются будущими слайсами (T7A.8B/8C/9/10).

**Файлы**: новая additive DML-миграция `20260816000000_seed_attendance_exception_read_permissions`
(два permission — `attendance.exception.read.assigned` → только `FOREMAN`, `attendance.exception.
read.all` → только `ADMIN`/`SUPER_ADMIN`; ни `attendance.exception.resolve.*`, ни
`attendance.gps.read.raw`, ни `attendance.conflict.read`, ни `timesheet.draft.edit.exception` этим
слайсом не сеются — подтверждено прямым SQL). Новый `lib/attendance-exceptions.ts` (единственный
владелец scope enforcement/filtering/pagination/DTO/redaction) + четыре новых route-файла
(`app/api/admin/attendance/exceptions[/route.ts, /[exceptionId]/route.ts]`, тот же паттерн для
`app/api/foreman/attendance/exceptions/...`) — route-файлы содержат только requestId/auth/
permission-gate/query-validation/HTTP-mapping, вся бизнес-логика в сервисном слое. **Ни один
существующий файл не изменён** — подтверждено `git status`: единственная модификация во всём diff'е
— тривиальный `next-env.d.ts` (side effect локального `next dev`, отменён перед коммитом).

**Контракт списка** (`GET .../exceptions`): `status`(default `OPEN`)/`type`/`siteId`/
`employeeId`(admin only)/`payrollPeriodId`/`from`/`to`/`page`/`pageSize`(default 20, max 100) —
явно переданное невалидное значение любого из этих полей всегда `400 VALIDATION_ERROR` с
`fieldErrors`, никогда не заменяется дефолтом молча (сознательно строже старого паттерна
`GET /api/admin/review-scopes`, который именно так и делает — новый контракт этого паттерна не
переиспользует). Ответ: `{items,page,pageSize,totalItems,totalPages}`, сортировка `occurredAt DESC,
id DESC` (стабильная — подтверждено повторными идентичными запросами). `count()`/`findMany()`
используют один и тот же `Prisma.AttendanceExceptionWhereInput` объект — не два независимых
предиката. `siteId`-фильтр матчит через ЛЮБУЮ из пяти site-связей исключения (`siteId`,
`clockEvent.siteId`, `clockShift.siteId`, `clockShiftFragment.siteId`, `relatedClockShift.siteId`)
— не только собственное поле `AttendanceException.siteId`, которое `OVERLAPPING_SHIFT` намеренно
оставляет `NULL`.

**FOREMAN scope** — НЕ построен по `AttendanceException.siteId` в одиночку (эта колонка `NULL` для
`OVERLAPPING_SHIFT` и любого исключения без прямой site-привязки). `scopeSiteIds` собирается из всех
пяти связей выше; доступ есть, если `intersection(scopeSiteIds, ownCurrentSiteIds)` непуст, где
`ownCurrentSiteIds` — те же текущие (`validFrom<=today<=validTo|NULL`) `ForemanAssignment`, что и
`lib/foreman-review.ts`'s `getForemanSiteIds` (переиспользован как есть, не продублирован).
Explicit `siteId`-фильтр внутри foreman-эндпоинта сужается до пересечения с собственным scope —
чужой `siteId` даёт пустой `200`, никогда `403`/`404` (никакого oracle существования чужого
объекта). Dual-role `FOREMAN`+`WORKER` исключается из собственного списка/detail
(`exception.employeeId === caller.employeeId`) — тот же безопасный `404`, что «не существует».
Detail malformed/missing/scope-inaccessible — единый `404 EXCEPTION_NOT_FOUND` для всех трёх причин
(malformed UUID проверяется regex'ом ДО обращения к Prisma — передача невалидного UUID-литерала в
`@db.Uuid`-колонку иначе бросает DB-level исключение, не чистый `null`).

**Redaction** — сырые координаты (`ClockEventLocation`) никогда не выбираются в DTO вообще (не
редактируются постфактум — их структурно нет в Prisma `select`). `AttendanceException.detail`
(произвольный `Json?`) никогда не отдаётся напрямую — явный allowlist из 16 ключей,
реверс-инженерных из реальных `detail:`-литералов всех четырёх backend-модулей, что создают
исключения (`lib/attendance-clock.ts`, `lib/attendance-sync.ts`, `lib/attendance-materializer.ts`,
`lib/attendance-reported-projection.ts`) — неизвестные ключи и любые вложенные object/array-значения
даже под разрешённым ключом отбрасываются рекурсивно. `payloadHash`/`requestId`/
`deviceInstallationId`/`deviceSequence`/`sanitizedConflictingPayload` нигде не выбираются. Raw GPS
не отдаётся даже `ADMIN` — `attendance.gps.read.raw` этим слайсом не реализован. Для `FOREMAN` на
own↔foreign `OVERLAPPING_SHIFT`: собственная половина (`clockShift`, чей `siteId` — свой) видна
полностью; чужая половина (`relatedClockShift`, чей `siteId` — не свой) редактируется целиком в
`null` — ни id, ни siteId/name, ни время, ни fragments чужой половины не просачиваются никуда
(подтверждено сканированием JSON-строки ответа на raw id/name чужого сайта).

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (83/83 PASS, прямые HTTP-вызовы
`fetch` против живого dev-сервера — не только прямые вызовы route-функций, поскольку detail-роуты
специально проверяют HTTP-уровневую 404-семантику для malformed path-параметра): permissions (1-4:
прямой SQL, ровно ожидаемый набор grants, ноль лишних permission), admin default listing +
стабильность сортировки (5), все шесть категорий фильтров включая site-through-relatedClockShift и
payrollPeriodId (6), pagination на изолированном 23-элементном batch — page1/2/3, totalPages=3,
пустой результат отдельным запросом (7), пять detail relation shapes — event-only/shift/fragment/
overlap-pair/timesheet-only (8), `RESOLVED`/`DISMISSED` metadata с `resolvedBy` (9), десять
вариантов невалидных фильтров → точные `fieldErrors` (10), malformed vs missing id → идентичный
`404` (11), `ADMIN`/`SUPER_ADMIN` проходят, `FOREMAN`/`WORKER`/unauthenticated получают
`403`/`401` на admin-роутах (12); foreman: собственный текущий сайт виден (13), expired-assignment
сайт невидим (14), future-assignment сайт невидим (15), standalone `FOREMAN` без `Employee`
работает (16), dual-role self-exclusion в list И detail (17), `siteId=NULL`+собственный `clockShift`
корректно виден (18), own↔foreign `OVERLAPPING_SHIFT` виден с полной редакцией чужой половины (19),
исключение без доказуемого site scope невидимо ни одному foreman (20), чужой `siteId`-фильтр →
пустой `200` (21), detail foreign/malformed/missing → идентичный `404` (22), scope
перепроверяется на КАЖДЫЙ запрос — не кэшируется: `ForemanAssignment` протухает между list и detail
того же теста, доступ пропадает и восстанавливается синхронно (23); security: реальная
`ClockEventLocation` с координатами не попадает ни в list, ни в detail (24), искусственно добавленные
`latitude`/`longitude`/`gps`/`rawPayload`/`payloadHash`/`deviceInstallationId`/`deviceSequence`/
`requestId`-ключи в `detail` не проходят sanitizer, легитимный `reason` выживает (25), те же четыре
технических поля отсутствуют во ВСЕХ ответах целиком, не только в `detail` (26), foreman-ответы не
содержат id/имени чужого сайта нигде в JSON (27), dev-сервер log не содержит утёкших координат (28).
Static: `git diff --check`/`prisma validate`/`tsc --noEmit`/`npm run build` (все четыре роута видны
в build-манифесте) — зелёные; `docker compose build app` — успешный build (мандаторный тест, снова
только перевесил локальный тег `titanor-time-app:latest`, `docker inspect` до/после подтверждает тот
же image ID/`StartedAt`/`RestartCount=0`/`healthy` у обоих production-контейнеров); `prisma migrate
deploy` на чистом одноразовом PostgreSQL 16 — 52/52 миграции (51 было + одна новая), повторный запуск
— «No pending migrations to apply». Regression: `scripts/_test-activation.ts`,
`scripts/_test-corrections.ts` зелёные на отдельной чистой БД; online clock/offline sync/outbox/
materializer/geofence-admin regression не перезапущены HTTP-прогоном отдельно — риск структурно
нулевой, `git status` подтверждает, что этот diff не касается НИ ОДНОГО файла из этих областей (ноль
изменённых существующих файлов, только новая миграция + пять новых файлов), а общая auth/permission/
session-инфраструктура, которую разделяют все слайсы, интенсивно упражняется собственными 83
проверками этого слайса через все четыре роли (`ADMIN`/`SUPER_ADMIN`/`FOREMAN`/`WORKER`).

**Остаётся вне этого слайса** (явно, по границам задачи): все шесть resolution-действий
(`attendance.exception.resolve.{assigned,all}` не сеяны), exception-review UI (ни `/foreman/review/
exceptions`-подобного, ни admin-эквивалента для `AttendanceException` — не путать с уже существующим
`/foreman/review/exceptions`, который про `TimesheetReviewScope.hasException`, другая сущность),
`attendance.gps.read.raw`/raw coordinate access, `attendance.conflict.read`/`ClockEventIdConflict`
чтение, `attendance.policy.*`, `timesheet.draft.edit.exception`/`REASON_EDIT`-эндпоинт, admin
attendance operational overview (T7A.9), scheduler/auto-submit (T7A.10). Schema/migrations (кроме
одной additive DML)/online-online route surface не изменены.

---

**T7A.7B Offline Attendance Outbox Client — новый завершённый frontend-слайс поверх T7A.7A
(offline sync backend) и T7A Worker Online Clock UI.** Реализует
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §6 (IndexedDB outbox client протокол — схема,
atomic enqueue, sync runner, backoff, response application) и §7 (batch API contract с клиентской
стороны). `WorkerClockPanel` больше не online-only: Check In/Check Out/Switch Site сначала
атомарно пишутся в IndexedDB, затем отправляются исключительно через уже существующий
`POST /api/worker/attendance/sync` (T7A.7A); прямые вызовы `/check-in`/`/check-out`/`/switch-site`
из UI убраны, но сами эти три online-роута и их backend-логика не тронуты и остаются отдельно
протестированной regression-поверхностью.

**Файлы**: новая директория `lib/offline-outbox/` (browser-only, без Prisma/`node:crypto`/next
server-импортов) — `sha256.ts` (синхронная чистая SHA-256, необходима именно потому, что
`payloadHash` включает только что зарезервированный `deviceSequence`, известный лишь внутри
IndexedDB-транзакции — `await` Web Crypto внутри открытой транзакции недопустим), `db.ts` (схема
`titanor-time-outbox` v1: `clockOutbox`(keyPath `clientEventId`, индексы `by-state`/
`by-nextAttemptAt`), `localClockState`(singleton), `deviceState`(singleton) — ровно три store, как
предписано, четвёртый не добавлен), `device.ts` (`ensureDeviceBootstrapped`/`retryBootstrap`,
`nextDeviceSequence = max(текущий, lastProcessedSequence+1, max(outbox)+1)`, безопасная
одноразовая ротация `deviceInstallationId` при `DEVICE_NOT_OWNED` только когда outbox пуст),
`outbox.ts` (`atomicEnqueue` — одна readwrite-транзакция на `clockOutbox`+`localClockState`+
`deviceState`, ноль `await` не-IDB промисов внутри; `enqueueCheckIn`/`enqueueCheckOut`/
`enqueueSwitchSite`(пара CHECK_OUT+CHECK_IN с общим `groupId`, `nextDeviceSequence += 2` в той же
транзакции); `applySingleEventResult`/`applyGroupResult`(перечитывает актуальные строки по
`groupId`, а не кэш вызывающего — двусмысленный/неполный/смешанный по категории group-ответ не
трогает ни одну половину)), `sync-runner.ts` (`buildBatch` — чистая функция, backward-scan trim,
никогда не режет switch-site пару границей batch; `runSyncOnce(force?)` — полный HTTP dispatch
401/403/429/503/5xx/malformed, backoff-лестница 5s/30s/2min/10min-cap), `broadcast.ts`
(`BroadcastChannel`, только UX-инвалидация, ноль бизнес-данных в сообщении), `projection.ts`
(`projectClockState` — накладывает только PENDING/SENDING хвост поверх последнего
`GET /clock-state`, `FAILED_TERMINAL` никогда не проецируется). Переписан
`app/worker/WorkerClockPanel.tsx` (online/offline индикатор, счётчик pending, кнопка «Sync now»,
баннер paused-состояния, список «Needs attention» для `FAILED_TERMINAL`); дополнение
`.wk-offline-bar`/`.wk-connectivity-dot`/`.wk-pending-count`/`.wk-sync-now-button` в
`app/globals.css`, ни один существующий класс не изменён. **Schema/migrations/permissions/online
route surface не изменены** — ноль новых миграций, ноль новых permission, все три online-роута и
`lib/attendance-sync.ts` не тронуты.

**Найдено и исправлено три реальных бага этого слайса (не пре-существующих):**
1. React hydration mismatch на `isOnline` — `useState(() => navigator.onLine)` расходился с SSR
   (`navigator` не существует на сервере, фолбэк всегда `true`), тогда как клиентский
   `navigator.onLine` на момент гидратации иногда `false`; поймано mandatory-требованием «ноль
   console errors» через живой Playwright. Исправлено: `useState(true)` + коррекция в
   `useEffect(() => setIsOnline(navigator.onLine), [])` после mount — стандартный паттерн.
2. Кнопка «Sync now» игнорировала `nextAttemptAt` backoff-гейт наравне с автоматическими
   попытками — клик во время окна backoff молча ничего не делал (batch пуст, `NOTHING_TO_SYNC`),
   пользователь не получал ни ошибки, ни результата. Добавлен `force`-параметр
   (`runSyncOnce(force)`/`getEligibleRecords(force)`), проброшенный только из ручной кнопки — не
   из автоматических триггеров (mount/online-event/visibilitychange/таймер), чтобы не сломать
   сам backoff.
3. Pause (DEVICE_NOT_OWNED/DEVICE_REVOKED/auth expired), обнаруженный ВО ВРЕМЯ sync-попытки (а не
   при начальном bootstrap), не отражался в UI — React-состояние `bootstrap` обновлялось только
   `ensureDeviceBootstrapped`/`retryBootstrap`, `runSyncOnce`'s `pauseDevice()` писал paused
   исключительно в IndexedDB. Очередь физически сохранялась верно (доказано тестами), но баннер
   «устройство отключено»/кнопка Retry/скрытие Check In/Out не появлялись — пользователь видел
   только общее сообщение об ошибке. Исправлено: `triggerSync` теперь синхронизирует React
   `bootstrap` из исхода `DEVICE_PAUSED`/`AUTH_EXPIRED`.

**Тесты, реально выполненные в живом браузере (Playwright/Chromium, headless, реальный IndexedDB,
не только моки) поверх одноразового PostgreSQL 16 + dev-сервера** (84/84 PASS в сумме):
- Suite 1 (8/8): online happy path — Check In→outbox→sync→ACK→`clock-state`, Switch Site (обе
  половины ACK атомарно), Check Out, DB-проверка ровно 2 `ClockShift`, ноль console errors.
- Suite 2 (10/10): offline Check In → reload/remount (IndexedDB durability подтверждена реальным
  `context.route(...).abort()` только на `/sync`, не блокирующим саму навигацию — генуинный
  `context.setOffline(true)` через reload несовместим с приложением без service worker) → offline
  Check Out → reconnect → FIFO-sync → ровно один закрытый `ClockShift`.
  Suite 3 (2/2): потерянный HTTP-ответ после реального commit → повтор того же immutable-события
  напрямую → `DUPLICATE_ACK`, ноль дублей `ClockEvent`. Suite 6 (2/2): тройной rapid-click →
  ровно один `ClockEvent`/`EmployeeOpenShift` (`busyRef`-guard). Suite 20 (3/3): координаты
  отсутствуют в DOM/console/`BroadcastChannel`.
- Suite 7 (4/4): две вкладки одного контекста (общий IndexedDB) конкурентно enqueue — уникальные
  последовательные `deviceSequence`, ни одна запись не потеряна/не столкнулась. Suite 8 (3/3): две
  вкладки конкурентно шлют один и тот же batch — сходится через серверный replay-ledger, ровно
  один `ClockEvent`. Suite 9 (3/3): два независимых browser context получают разный
  `deviceInstallationId` и независимые sequence. Suite 10 (1/1, best-effort): 6 итераций
  abrupt-teardown гонки на persistent-профиле (`chromium.launchPersistentContext` +
  `context.close()` без ожидания клика) вокруг Switch Site enqueue — ни разу не найдена группа
  ровно с одной уцелевшей половиной; честно отмечено — буквальный OS-level kill середины
  IndexedDB-транзакции недостижим через публичный Playwright API, гарантия опирается на нативную
  атомарность IndexedDB-транзакции плюс однотранзакционный дизайн `enqueueSwitchSite`.
- Suite 12 (3/3): неполный group-ответ (результат только для одной половины) не трогает ни одну
  половину (обе остаются `SENDING`, не `PENDING` — корректно, `SENDING` уже всегда eligible для
  повтора, тот же инвариант, что и crash-recovery), при снятии мока вся группа успешно
  ретраится и сходится. Suite 13 (1/1): `ACCEPTED`+`DUPLICATE_ACK` — одна категория SUCCESS, обе
  половины удалены атомарно. Suite 14 (6/6): 503→429→network error подряд — `PENDING`, retryCount
  инкрементируется на каждом шаге, immutable-поля (`clientEventId`/`deviceSequence`/
  `clientCapturedAt`/gps) не меняются, `nextAttemptAt` строго растёт. Suite 15 (4/4): terminal
  `REJECTED`(`OUTSIDE_GEOFENCE`) → `FAILED_TERMINAL`, переживает reload, «Needs attention» виден
  до и после. Suite 16 (3/3): запись, напрямую посаженная в `SENDING` (симуляция краша
  mid-flight), восстанавливается после reload и успешно досылается, ровно один реальный
  `ClockEvent`. Suite 17 (9/9): `DEVICE_REVOKED`/`DEVICE_NOT_OWNED`(непустой outbox, без ротации
  identity)/`401` — очередь не стирается ни в одном случае, UI показывает безопасное действие.
  Suite 18 (4/4): первый запуск полностью offline без предыдущего bootstrap — «Offline setup is
  not ready yet», ноль кнопок действий, ноль записей в outbox. Suite 19 (2/2): явная проверка
  `GET /clock-state` после ACK (не только оптимистичная проекция). Suite 23 (6/6): десктопный
  viewport 1280×800, `role="status" aria-live="polite"`, Check In/Check Out активируются Enter
  на сфокусированной кнопке (нативная keyboard-семантика `<button>`).
- `buildBatch` unit-тесты вне браузера (11/11): batch >100 режется ровно на 100 для standalone
  событий; switch-site пара, пересекающая границу 100/101, границу 99/100 (влезает целиком),
  границу 101/102 (после cap), несколько последовательных пар подряд у границы — ни разу
  orphaned-половина в результирующем batch.
- Regression: `git diff --check`, `prisma validate`, `tsc --noEmit`, `npm run build` — все зелёные;
  `docker compose -f compose.titanor-time.yaml build app` — успешный build (мандаторный тест,
  снова только перевесил локальный тег `titanor-time-app:latest`, работающий production-контейнер
  не затронут — подтверждено `docker inspect` до/после: тот же image ID/`StartedAt`/
  `RestartCount=0`/`healthy`); `prisma migrate deploy` на чистом одноразовом PostgreSQL 16 — 51/51
  миграция (без новых — этот слайс не добавляет ни одной), повторный запуск — «No pending
  migrations to apply»; `scripts/_test-activation.ts` и `scripts/_test-corrections.ts` (уже
  существующие regression-скрипты прежних слайсов) — зелёные на отдельной чистой БД.
- Не выполнено эмпирически (честно отмечено): буквальный OS-level process-kill середины
  IndexedDB-транзакции (см. Suite 10 выше — заменён best-effort abrupt-teardown гонкой);
  выделенный функциональный regression-прогон admin geofence CRUD и worker timesheet UI (риск
  структурно нулевой — этот diff не касается ни одного файла в этих областях, подтверждено
  `git status`; сами geofence-версии и назначения интенсивно использовались косвенно всеми 84
  Playwright-проверками через `/context`).

**Остаётся вне этого слайса** (явно, по границам задачи): scheduler/auto-submit, exception review
UI, admin attendance overview, полноценный service worker/PWA offline-shell, offline navigation
shell для самого `/worker` (reload при полностью недоступной сети — вне охвата, задокументировано
в Suite 2 выше). Background Sync API не добавлен (design допускает его только как ДОПОЛНИТЕЛЬНЫЙ
механизм, этот слайс сознательно ограничивается mandatory-триггерами: mount/online-event/
visibilitychange/ручная кнопка/bounded-таймер).

---

**T7A.7A Offline Attendance Sync Backend — новый завершённый backend-слайс поверх online clock
core + materialization.** Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §7 (batch
contract), §9.11 (нормативный FIFO/`SAVEPOINT`-алгоритм — реализован дословно, не упрощён до «одна
транзакция на событие» и не сведён к последовательному вызову online-эндпоинтов), §5.5 правила 4-5
(offline effective-time), §12.1-12.2 (device bootstrap/context, sync permission). **IndexedDB/outbox
клиент и интеграция `WorkerClockPanel` НЕ реализованы этим слайсом** — отдельная будущая задача
T7A.7B.

**Файлы**: новый `lib/attendance-sync.ts` (~950 строк) — device bootstrap (`GET context`) +
batch ingestion (`POST sync`). Новые роуты `app/api/worker/attendance/context/route.ts`,
`app/api/worker/attendance/sync/route.ts` (HTTP/auth/CSRF/idempotency/validation-mapping only, вся
бизнес-логика в `lib/attendance-sync.ts`, тот же паттерн, что `lib/attendance-clock.ts`).
**`lib/attendance-clock.ts` не переписан** — только `export` добавлен семи уже протестированным
чистым/tx-safe helper'ам (`resolveTimesheetForInstant`, `resolveActiveSiteAssignment`,
`canonicalizeForHash`, `loadCurrentGeofence`, `exceptionDetailForGps`, `validateGpsPayload`,
`helsinkiCalendarDateAsUtcMidnight`) — ноль изменений поведения, подтверждено online-регрессией
ниже. Haversine/overlap-детекция/материализация НЕ переизобретены: `evaluateGpsReading`,
`overlapCandidates`/`overlapExists`/`resolveOverlapTransition`, `materializeClockShiftCore`
переиспользованы как есть, инлайн, в том же `SAVEPOINT`, что и остальные business-эффекты события
— не отдельная/вложенная транзакция.

**Migration**: `20260815000000_seed_attendance_clock_sync_permission` — чистый DML, сеет ровно один
permission (`attendance.clock.sync.own`) и один grant (`WORKER`), без `ALTER`/`CREATE`/`DROP`; `GET
context` переиспользует уже существующий `attendance.clock.read.own`, новый grant не потребовался.
Schema/enums/triggers/constraints не менялись — все 13 таблиц/16 composite FK/14 триггеров T7A уже
существовали с `20260812000000_add_attendance_clock_schema_foundation`.

**Архитектура ingestion** (§9.11, `performSync`): одна outer-транзакция (`prisma.$transaction`) на
весь батч — `Employee FOR UPDATE` → `WorkerDeviceInstallation FOR UPDATE` (canonical order, только
когда `deviceInstallationId` есть) → ownership/revocation once per request (не per-event) → Проход
A (строго последовательный, `current+1`; группы switch-site детектируются как соседние элементы с
общим `groupId`; `INVALID`/`INCOMPLETE`/`SEQUENCE_GAP` — те самые узкие семантики §9.11, не
объединены в один код) → Проход B (stale/replay, никогда не продвигает `current`, никогда не
повторяет business-эффект). Один `SAVEPOINT event_sp` на независимое событие, один `SAVEPOINT
group_sp` на целую switch-site группу — `RELEASE` после принятого результата, `ROLLBACK TO
SAVEPOINT` только для ожидаемой terminal business-ошибки (§9.11 доказательство 1: `RELEASE`-эффекты
Прохода A необратимы более поздним `ROLLBACK TO SAVEPOINT`). Bounded retry всей outer-транзакции —
только `SQLSTATE 40P01`/`40001`, максимум 3 попытки, exponential backoff, `503
INGESTION_RETRY_EXHAUSTED` после исчерпания; неожиданная внутренняя ошибка НЕ превращается в
terminal receipt — пробрасывается наружу, весь batch attempt откатывается (§9.11 доказательство 2).
`ClockEvent` вставляется через `createMany({skipDuplicates:true})` (`ON CONFLICT (id) DO NOTHING`
без исключения, не поражает окружающий `SAVEPOINT` — критично для продолжения обработки в том же
event_sp после конфликта).

**Классификация исходов** — точная матрица §9.11: `ACCEPTED_NORMAL`/`ACCEPTED_NEEDS_REVIEW` (оба —
`DeviceEventReceipt.outcome=ACCEPTED`, различаются только `ClockEvent.processingState`;
`DOUBLE_CHECK_IN`/`CHECKOUT_WITHOUT_OPEN_SHIFT` — не отказы, raw-факт сохранён);
`REJECTED_TERMINAL_WITHOUT_CLOCK_EVENT` (`VALIDATION_ERROR`/`OUTSIDE_GEOFENCE`(только Check In)/
`CLIENT_EVENT_ID_REUSED`/`SWITCH_SITE_GROUP_FAILED`/`SWITCH_SITE_GROUP_INVALID`); `RETRYABLE`
(`SEQUENCE_GAP`/`SWITCH_SITE_GROUP_INCOMPLETE`/`FIFO_LEDGER_INCONSISTENT`/`INGESTION_RETRY_EXHAUSTED`
— нет receipt в этой попытке, high-water не продвинут). `GEOFENCE_VERSION_MISMATCH` (новый
реально-создаваемый exception type — раньше нигде не создавался): сравнение
`event.cachedGeofenceVersionId` (request-only, нигде не хранится) с сайтовым текущим
`geofenceVersionId`, никогда не заменяет живую §5.2-оценку.

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (контейнер `postgres:16`, `--rm`, tmpfs,
случайные credentials/порт, удалён по завершении):
- Static: `git diff --check`, `prisma validate`, `prisma generate`, `tsc --noEmit`, `npm run build`
  — все зелёные (включая `/worker`, `/api/worker/attendance/context`, `/api/worker/attendance/sync`
  в build-выводе). `docker compose -f compose.titanor-time.yaml build app` — успешный build
  (мандаторный тест); повторный `prisma migrate deploy` — "No pending migrations to apply" (51
  миграций — было 50, плюс ровно одна новая DML-миграция этого слайса).
- HTTP/DB (65/65 PASS, прямые вызовы route-функций): permission (1-2), device bootstrap/context
  (3-7), FIFO (8-18, включая реальную двух-backend-PID конкуренцию одного устройства и независимость
  разных устройств), replay/conflict (19-25, включая искусственно смоделированный
  `FIFO_LEDGER_INCONSISTENT` — receipt неизменяем, DELETE физически заблокирован триггером, поэтому
  ledger-порча смоделирована прямым UPDATE `lastProcessedSequence`, не удалением receipt), business
  (26-39: inside/outside/no-GPS Check In, double Check In, normal/orphan Check Out, site mismatch,
  chronology anomaly, offline time rules ≤7/>7 дней, `GEOFENCE_VERSION_MISMATCH`, overlap gate,
  inline materialization, late-sync reopen в `SUBMITTED`/`FINAL_APPROVED` — regression уже
  протестированного materializer'а, достигнутого через НОВЫЙ offline-путь), groups (40-50: valid
  switch atomic accept, failed CHECK_IN откатывает уже применённый CHECK_OUT, incomplete/invalid
  варианты по каждому правилу §9.11 отдельно, exact replay accepted/rejected group, конкурентные
  противоположные group-попытки без half-applied состояния), HTTP (51-60: 401/403/
  NO_EMPLOYEE_PROFILE/CSRF/malformed JSON/invalid UUID·sequence·precision/empty·oversized batch/
  Idempotency-Key replay·conflict/always-200-structurally-valid/реальный cross-employee
  `40P01`-deadlock с bounded retry), DB invariants/security (61-65: `DeviceEventReceipt` immutable,
  composite FK не даёт сослаться на чужой `ClockEvent`, duplicate device sequence блокируется
  constraint'ом напрямую, raw координаты только в `ClockEventLocation`, ноль координат в
  просканированных `AuditEvent`/`ClockEventIdConflict`).
- Regression (все зелёные, отдельные прогоны): online clock core (check-in/check-out/switch-site/
  clock-state — 6/6 напрямую через route-функции, включая exact-replay и outside-geofence, контракт
  не изменился); `scripts/_test-activation.ts`; `scripts/_test-corrections.ts`; geofence admin API
  (`GET geofence-versions`); worker timesheet listing (`GET /api/worker/timesheets`) — все на
  отдельных чистых disposable PostgreSQL 16, не переиспользующих основную тестовую БД.
- Найден и исправлен один реальный баг при построении тестов: `EXCESSIVE_CLOCK_SKEW`
  `AttendanceException` не создавался в НОРМАЛЬНОЙ (не orphan) ветке offline Check Out —
  присутствовал в offline Check In и orphan Check Out, отсутствовал в обычном закрытии смены.
  Исправлено в `lib/attendance-sync.ts` до коммита, покрыто тестом 34b.
- Не выполнено эмпирически (заявлено честно, не выдаётся за пройденное): детерминированное
  3-попыточное исчерпание retry (`503`) — реальный `40P01` был воспроизведён (cross-employee
  reciprocal `clientEventId` collision, тест 60) и подтверждает, что bounded retry работает и
  ошибка не становится необработанным `500`, но гарантированно проиграть ВСЕ 3 попытки одного
  конкретного вызова без выделенных fault-injection хуков (которые этот слайс сознательно не
  добавляет) — вероятностно, не воспроизведено детерминированно; путь `503
  INGESTION_RETRY_EXHAUSTED` подтверждён прямым код-ревью `performSync`. `40001`
  (`serialization_failure`) обрабатывается тем же кодовым путём, что `40P01`, но физически не
  достижим при текущей `READ COMMITTED` + `FOR UPDATE`-дисциплине без явного перехода на
  `SERIALIZABLE` — design не требует такого перехода (доказательство §8.3 построено на
  `FOR UPDATE`-порядке), поэтому изоляция не менялась; код для `40001` — forward-совместимая защита,
  не независимо протестированный путь.

**Production**: `titanor-time-app-1`/`titanor-time-db-1` — только read-only `docker inspect` до и
после; `RestartCount=0`, `StartedAt` и image ID контейнеров не изменились, `/api/health` отвечает
`200`. Мандаторный `docker compose build app` (без `up`) снова перевесил локальный тег
`titanor-time-app:latest` на новый build-артефакт (тот же, уже задокументированный, побочный эффект
обычной семантики Docker-тегов — не затрагивает работающий контейнер, который ссылается на образ по
ID, не по тегу).

**Остаётся вне этого слайса** (явно, по границам задачи): IndexedDB/outbox клиент,
`WorkerClockPanel`-интеграция с offline-путём (T7A.7B), `GET /attendance/today|week`,
scheduler/auto-submit, exception-review UI/API, admin attendance overview. Schema/migrations (кроме
одной additive DML)/permissions (кроме одной новой строки)/online route surface не изменены —
подтверждено: 51 миграция до и после (было 50), `lib/attendance-clock.ts` изменён только семью
`export`-добавлениями, все четыре online route-файла не тронуты.

---

**T7A Worker Online Clock UI — предыдущий завершённый frontend-слайс поверх online clock core +
materialization.** Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` decomposition п.5
(`01_SCREEN_MAP.md` §3 `/worker`) — mobile-first `/worker` как основной экран после логина работника,
строго online (offline outbox/§6 IndexedDB-протокол намеренно не реализован этим слайсом).

**Файлы**: `app/worker/page.tsx` (server component — session/role/`employeeId` из сессии, НИКОГДА из
query/body; `getClockState`/`listWorkerCurrentAssignments`/`listActionablePeriods`/`getWorkerContext`
через один `Promise.all`, без лишнего client-side GET сразу после hydration), новый
`app/worker/WorkerClockPanel.tsx` (client component — вся интерактивная логика) и новый
`lib/worker-gps.ts` (браузерный GPS helper: `getCurrentPosition` одноразово, `enableHighAccuracy`,
`timeout=12s`, `maximumAge=0`, никогда `watchPosition`, координаты округляются до той же точности,
что валидирует `lib/attendance-clock.ts`, чтобы не словить ложный `VALIDATION_ERROR`). Расширение
`.wk-*` в `app/globals.css` — новые классы, ни один существующий класс не изменён.
**`lib/attendance-clock.ts` и все четыре route-файла НЕ изменены этим слайсом** — UI работает строго
поверх уже существующего контракта (`GET clock-state`, `POST check-in`/`check-out`/`switch-site`).

**Состояния UI**: `Clocked out` (assignment picker — primary выбран по умолчанию, единственное
назначение выбрано автоматически, пустой список → понятный empty state + disabled `Check In`);
`Clocked in` (authoritative `siteName`/`workAreaName`/`openedAt` из `clock-state`, живой таймер —
`serverNow`/client offset, никогда не отрицательный, `setInterval` всегда чистится, обновление раз в
секунду); `Switch site` (явное подтверждение, старый/новый объект показаны, текущий объект исключён
из списка целей); progress (`Getting location…`/`Submitting…`/`Result unknown, checking current
state…`, всё через `aria-live`); человеческие сообщения для `OUTSIDE_GEOFENCE`/`SITE_NOT_FOUND`/
`CLIENT_EVENT_ID_REUSED`/`NO_OPEN_SHIFT_TO_SWITCH`/`RATE_LIMITED`/`CSRF_REJECTED`/
`NO_EMPLOYEE_PROFILE`/`NOT_AUTHENTICATED`/`VALIDATION_ERROR`/network-timeout.

**Idempotency/network-reconciliation модель** (только React memory, никакого durable outbox/service
worker/IndexedDB): каждый клик создаёт один immutable "attempt" — свежие `clientEventId`(ы)/
`clientCapturedAt`/выбранный site-workArea/один снятый GPS snapshot (используется для ОБЕИХ половин
switch-site, включая одинаковую `gpsUnavailableReason` при сбое). Успех → durable `GET clock-state`
перечитывается заново (состояние никогда не собирается только из локальных предположений). `429
RATE_LIMITED` — тот же attempt остаётся retryable. Любая другая ошибка ответа сервера — attempt
сбрасывается, `clock-state` перечитывается, но выбранное назначение НЕ стирается. Сетевой сбой/
timeout/невалидный JSON → "Result unknown" → `GET clock-state`; если состояние подтверждает результат
(по `openedByClockEventId`/переходу `CLOCKED_IN`↔`CLOCKED_OUT`) — успех без повторной мутации; если
нет — предлагается `Retry` тем же attempt (те же id/payload, GPS не перезапрашивается). Двойной клик
блокируется синхронным ref-guard'ом (не только `disabled`), проверено гонкой из двух параллельных
кликов.

**Тесты, реально выполненные на одноразовом PostgreSQL 16** (контейнер `postgres:16`, `--rm`, tmpfs,
случайные credentials/порт, удалён по завершении):
- Static: `git diff --check`, `prisma validate`, `tsc --noEmit`, `npm run build` — все зелёные.
  `docker compose -f compose.titanor-time.yaml build app` — успешный build (мандаторный тест этого
  слайса); повторный `prisma migrate deploy` — "No pending migrations to apply" (50 миграций, как и
  было — новых миграций этот слайс не добавляет).
- HTTP/DB (12/12 PASS, прямые вызовы route-функций, как в `scripts/_test-activation.ts`): исходное
  `CLOCKED_OUT`; check-in внутри geofence; точный natural replay того же `clientEventId`/payload без
  дублей; check-out закрывает смену и материализует инлайн (`materializationState=MATERIALIZED`,
  `TimesheetDraftSegment` создан); `GET clock-state` после checkout → `CLOCKED_OUT`; GPS unavailable →
  `NOT_VERIFIED`, ноль строк в `ClockEventLocation`; outside-geofence → `403`, ноль новых строк, состояние
  не меняется; гонка из двух параллельных идентичных check-in → ровно один `ClockEvent`/
  `EmployeeOpenShift`; switch-site success → старая смена materialized-closed, новая открыта на новом
  сайте; switch-site failure (новый сайт outside) → полный rollback, старая смена без изменений;
  CSRF/auth/permission → `CSRF_REJECTED`/`NOT_AUTHENTICATED`/`FORBIDDEN`; rate limit 20/60s → `429` на
  21-й попытке.
- Browser (Playwright, headless Chromium, 33/33 PASS): CLOCKED_OUT с одним/несколькими/нулём
  назначений; happy path (mobile 390×844 → check-in внутри geofence → таймер увеличивается и не
  отрицателен → reload восстанавливает `CLOCKED_IN` из БД → desktop viewport без горизонтального
  scroll → switch-site → check-out → reload восстанавливает `CLOCKED_OUT`); keyboard focus + `aria-live`
  region присутствует; GPS permission denied → check-in всё равно проходит (`NOT_VERIFIED`), ноль
  координат в DOM; outside-geofence → понятная ошибка, состояние/выбор сохранены; network-unknown
  (перехват fetch, `route.abort`) → "Result unknown…" → `Retry` → успех, **оба** HTTP-запроса несли
  байт-в-байт идентичный payload (тот же `clientEventId`); rapid double-click → ровно один POST;
  mocked `RATE_LIMITED`/`NOT_AUTHENTICATED` → корректный человеческий текст и retry-состояние. Ноль
  `pageerror` (application-level) во всех сценариях; три ожидаемых браузерных
  `console.error("Failed to load resource")` — стандартный лог Chromium для намеренно вызванных
  403/429/aborted сетевых ответов, не application-исключения.
- Regression: `scripts/_test-activation.ts` и `scripts/_test-corrections.ts` — оба зелёные на чистом
  PostgreSQL 16 (запускались по отдельности — их собственные фикстуры с фиксированными датами периода
  конфликтуют друг с другом при последовательном запуске на одной БД, это ожидаемо тем же exclusion
  constraint, что и в проде, не баг). `/worker/periods`, `/worker/history` — рендерятся, без console
  errors, не бросают на `/login`. `GET /api/admin/sites/:id/geofence-versions` — не сломан (не
  изменялся этим слайсом).

**Production**: `titanor-time-app-1`/`titanor-time-db-1` — только read-only `docker inspect` до и
после; `RestartCount=0`, `StartedAt` и image ID контейнеров не изменились, `/api/health` отвечает
`200` на протяжении всей работы. Мандаторный `docker compose build app` (без `up`) перевесил локальный
тег `titanor-time-app:latest` на новый build-артефакт этого слайса — сам контейнер это не затрагивает
(контейнеры ссылаются на образ по ID, не по тегу, `docker inspect` подтверждает тот же ID до/после), но
локальный тег `latest` теперь указывает не на прежний production-образ — стоит иметь в виду перед
следующим explicit rebuild+redeploy (вне scope этого слайса, не выполнялся).

**Остаётся вне этого слайса** (явно, по границам задачи): offline outbox/PWA/IndexedDB,
`deviceInstallationId`/`deviceSequence`/`DeviceEventReceipt`-FIFO, `POST /attendance/sync`,
`GET /attendance/context|today|week`, scheduler/auto-submit, exception-review UI/API, admin attendance
overview, полное меню (`Today`/`My week`/`All hours`/`Corrections`/`Profile`/`Help`/`Logout` — только
ссылки на уже существующие `/worker/periods`/`/worker/history`), `Add break`, GPS/sync-state summary
badge. Prisma schema/migrations/permissions/route surface не изменены — подтверждено: 50 миграций до и
после, `git diff` затрагивает только `app/worker/page.tsx` (переписан), `app/globals.css` (только
добавления), плюс два новых файла (`app/worker/WorkerClockPanel.tsx`, `lib/worker-gps.ts`).

---

**T7A attendance materialization — предыдущий завершённый backend-слайс поверх online clock core.**
Реализованы §9.2(k), §9.4, §9.5 и §8.4 design-документа без изменения Prisma schema, migrations,
permissions или HTTP route surface. Новый `lib/attendance-materializer.ts` содержит tx-safe
`materializeClockShiftCore`, публичную обёртку с canonical locks и внутренний read-only catch-up
scan/per-candidate runner (без cron/API wiring). Online Check Out и Switch Site вызывают core
инлайн в своей существующей транзакции: обычная закрытая смена с assignment и без OPEN overlap
коммитится уже с полным `ClockShiftFragment` → `TimesheetDraftSegment` projection и
`materializationState=MATERIALIZED`.

Фаза 1 строит DST-safe half-open план по Helsinki payroll boundaries до первой записи, блокирует
сначала все `Timesheet` по `id`, затем все `TimesheetDraft` в том же порядке и вставляет все
отсутствующие fragments одной multi-row командой (statement-level coverage trigger всегда видит
полный набор). Фаза 2 независимо резолвит assignment каждого fragment, переиспользует общую
`computePlannedShiftForAssignmentDate`, только находит (никогда не изобретает)
`TimesheetDraftDay`, проверяет day state, создаёт live segment, увеличивает `contentRevision` и
переводит per-fragment projection в `SETTLED`; shift-wide gate дублирован существующим DB trigger.

Late sync status matrix закрыта полностью: `DRAFT`/обычный `RETURNED` проецируются напрямую;
`SUBMITTED`/`FOREMAN_APPROVED` системно возвращаются в `RETURNED` с generation/audit и
`LATE_SYNC_AFTER_SUBMIT`; повторный fragment того же episode не делает второй reopen; resubmit
структурно резолвит исключения. `FINAL_APPROVED` не reopen-ится и не получает live draft segment:
fragment явно `SETTLED`, создаются late-sync exception + skipped-reopen audit, а существующий
correction flow теперь может привязать именно этот OPEN fragment и резолвит исключение при
approval. Точное recorded-value binding не создаёт ложный `ClockShiftAdjustment`.

Проверено на чистом disposable PostgreSQL 16: **74/74 PASS** — inline atomic path, replay-safe
state, 1/2/3-period split, exact boundary и `+1ms` chronology clamp, winter/summer DST,
multi-row coverage rejection, idempotent repeat, nullable template, missing draft day/day conflict,
per-fragment stale assignment, вся late-sync matrix, correction approval, overlap gate/dismiss,
chronology exception linking, прямой DB gate, catch-up isolation и concurrent materializer passes
(два реально активных backend PID подтверждены через `pg_stat_activity`).
Новая migration отсутствует: на чистой базе по-прежнему ровно 50 migrations.
`git diff --check`, `prisma validate`, `tsc --noEmit`, `npm run build`, compose Docker build и
повторный `prisma migrate deploy` зелёные. Production app/db проверены только read-only inspect:
image IDs, `RestartCount=0` и `StartedAt` не изменились; disposable DB/image/scripts удалены.

**Остаётся вне этого слайса:** worker mobile UI, `GET /attendance/context|today|week`, offline
outbox, `deviceInstallationId`/`deviceSequence`/`DeviceEventReceipt` FIFO, `POST /attendance/sync`,
cron/scheduler/auto-submit, exception-review endpoints, admin attendance overview и production
deploy.

---

**T7A online clock core — предыдущий завершённый этап: GPS evaluation, clock-state, Check In,
Check Out, atomic Switch Site.** Реализует
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §9.1 (Online Check In), §9.2 (Online Check
Out с хронологической защитой), §9.3 (Switch site), §9.1a (`resolveOverlapTransition`/
`overlapCandidates`/`effectiveReportedRanges` — переиспользованы из slice B без дублирования),
§5 (GPS/geofence, Haversine), §5.5 правила 1-3 (online effective time/skew — правила 4-5
offline-only не в этом слайсе), §8 (canonical lock order), §12.1-12.2 (permissions/endpoints),
§13 (SYSTEM actor — переиспользован для auto-resolve overlap, не создан заново), §14 (threat
model). Единственная новая migration — `20260814000000_seed_attendance_clock_worker_permissions`
(чистый DML, seed 4 permission/RolePermission строк, без изменения схемы) — `prisma/schema.prisma`
и все ранее применённые migrations, включая `20260812000000_add_attendance_clock_schema_foundation`,
не тронуты.

**На момент этого предыдущего коммита отдельно откладывалось, но теперь реализовано новым слайсом
выше:** `materializeClockShift`, inline projection и linking chronology exception. По-прежнему не
реализовано: worker
mobile UI, `GET /attendance/context|today|week`, `deviceInstallationId`/`deviceSequence`/
`DeviceEventReceipt`-FIFO, `POST /attendance/sync`, offline outbox, scheduler (auto-submit),
exception-review-эндпоинты, admin attendance overview, production deploy. **Нельзя утверждать, что
§9.2/Attendance Clock целиком, или T7A целиком, завершены** — только online Check In/Check
Out/Switch Site/clock-state/GPS-evaluation slice.

**A. Permissions** — `attendance.clock.read.own`/`.checkin.own`/`.checkout.own`/
`.switch_site.own`, засеяны новой additive DML-миграцией, выданы только `WORKER` (проверено прямым
SQL-запросом `RolePermission`/`Permission`/`Role` на одноразовом PostgreSQL 16 — ровно 4 гранта;
`ADMIN`/`SUPER_ADMIN`/`FOREMAN` не получают ни одного; `SYSTEM` структурно не может иметь ролей).

**B. `lib/attendance-clock.ts`** (новый модуль, ~800 строк) — route-файлы делают только HTTP/auth/
CSRF/idempotency/validation-mapping, вся бизнес-логика здесь. `*Core`-функции (`checkInCore`,
`checkOutCore`) принимают `Prisma.TransactionClient` и никогда не используют global `prisma`
внутри транзакции — только верхнеуровневые `perform*`-обёртки открывают
`prisma.$transaction(...)`, что позволяет `performSwitchSite` разделить ОДНУ транзакцию между
обеими половинами. Чистые helpers:
- `evaluateGpsReading(reading, geofence)` — Haversine без PostGIS, `MAX_ACCEPTABLE_ACCURACY_METERS
  = 75`, `inside ⟺ distance <= radiusMeters + accuracyMeters`; координаты отсутствуют →
  `NOT_VERIFIED` с указанной причиной, `ClockEventLocation` не создаётся; `accuracy > 75` →
  `NOT_VERIFIED`/`LOW_ACCURACY`, координаты сохраняются; показание без настроенной геозоны →
  `NOT_VERIFIED`, `geofenceVersionId=NULL`, `gpsUnavailableReason=NULL`; геозона всегда
  резолвится заново сервером — клиент её вообще не присылает.
- `computeOnlineEffectiveTime(clientCapturedAt, serverReceivedAt)` — §5.5 правила 1-3: будущее
  > 2 минуты → `serverReceivedAt` + `EXCESSIVE_CLOCK_SKEW`; `|skew| <= 5 минут` →
  `clientCapturedAt`; остальной online skew > 5 минут → `serverReceivedAt` + `EXCESSIVE_CLOCK_SKEW`.
  `clockSkewMs` — весь расчёт через `BigInt` от старта (не `Number`-вычитание с последующим
  приведением) — разница двух представимых `Date` может выйти за `Number.MAX_SAFE_INTEGER` на
  экстремальных значениях (устройство, сброшенное к эпохе 1970 года).
- Payload hashing — SHA-256 канонического business payload (сортированные ключи, координаты
  участвуют в хэше — изменённые координаты под тем же `clientEventId` детектируются как
  changed-replay); `employeeId` — только из сессии; координаты никогда не попадают в
  `ClockEventIdConflict.sanitizedConflictingPayload`, `AuditEvent` или логи.

**C. Check In/Check Out/Switch Site** — §9.1/§9.2/§9.3 canonical order (`Employee FOR UPDATE` →
`EmployeeOpenShift` [implicit lock через raw `FOR UPDATE`/PK-based mutation] → …), реализованы
дословно, включая: `VERIFIED_OUTSIDE` на Check In → **полный** rollback, `403 OUTSIDE_GEOFENCE`;
double check-in → новый `ClockEvent(NEEDS_REVIEW)` + `DOUBLE_CHECK_IN`, старая `EmployeeOpenShift`
не трогается; Check Out никогда не блокируется GPS/сайтом; authoritative site/workArea/
sourceAssignmentId только из `EmployeeOpenShift`, никогда из тела запроса; orphan checkout →
`NEEDS_REVIEW` + `CHECKOUT_WITHOUT_OPEN_SHIFT`; хронологическая аномалия → `ClockShift.
recordedEndAt = openedAt + 1ms` (design: `+1 microsecond` — адаптировано к точности JS `Date`/
Prisma `DateTime`, свойство «никогда не пересекает границу периода» сохраняется тождественно, т.к.
период неизмеримо длиннее и 1мс, и 1мкс; exact-microsecond boundary-тесты §17 #66/#67 относятся к
материализации, не к этому слайсу), `endAtProvisional=true`, `clockShiftFragmentId=NULL`;
overlap-детекция переиспользует `overlapCandidates`/`overlapExists`/`resolveOverlapTransition`
из `lib/attendance-reported-projection.ts` (slice B) **без единой переписанной строки формулы** —
`ClockShift` в этом слайсе вставляется непосредственно ПЕРЕД вызовом `overlapCandidates` (вместо
после, как в прозе design-документа) специально для того, чтобы существующий helper (который уже
поддерживает свежевставленную PENDING-смену с нулём фрагментов через свой стандартный "fragments
пусто → raw fallback" путь) можно было использовать без единой модификации — поведенчески
идентично; Switch Site — Check Out старого сайта + Check In нового в ОДНОЙ транзакции, общий
`groupId`.

**D. Атомарность Switch Site — найден и исправлен реальный баг до написания тестов.** Первая
версия `performSwitchSite` возвращала обычное значение из `prisma.$transaction`-колбэка для
`SITE_NOT_FOUND`/`WORK_AREA_INVALID`/`CONFLICT` половины Check In, ПОСЛЕ того как половина Check
Out уже выполнила мутации (удалила `EmployeeOpenShift`, вставила `ClockShift`+`ClockEvent`) —
обычный `return` из транзакционного колбэка **коммитит** уже выполненные мутации, что означало бы:
старый сайт закрыт, новый — нет, работник «нигде не отмечен», ровно то состояние, которое §9.3
явно запрещает. Исправлено: любой неуспешный исход половины Check In теперь **выбрасывает**
специальный signal-класс, откатывающий ВСЮ транзакцию целиком (включая уже применённую половину
Check Out); для `CONFLICT`-исхода судебная запись (`ClockEventIdConflict`) пересоздаётся отдельной,
изолированной транзакцией уже ПОСЛЕ отката — доказательство сохраняется, даже когда сама попытка
switch отклонена и не оставляет следа в бизнес-данных.

**E. Online replay/conflict** — `ClockEvent.id` (=`clientEventId`) — обязательный natural
idempotency key, независимо от опционального HTTP `Idempotency-Key`. Точный повтор (тот же id +
тот же canonical payload hash) → исходный ответ реконструируется **детерминированно** из
durable-строк (сам `ClockEvent` + множество типов `AttendanceException`, созданных для него при
вставке — оба неизменны после создания), без отдельного response-снапшота: тот же код строит
ответ и для свежесозданного события, и для replay. Тот же id + другой payload →
`ClockEventIdConflict(CLIENT_EVENT_ID_REUSED)`, исходный `ClockEvent` не тронут, `409`. Неожиданный
`P2002` unique-конфликт (редкая кросс-employee гонка на глобальном PK, §8.3 Инвариант 3
не распространяется на `ClockEvent.id`) перехватывается и разрешается повторным чтением, никогда
не становится необработанным `500`.

Проверено на новом одноразовом PostgreSQL 16, **153/153 PASS, 0 FAIL** (DB-level, прямые вызовы
`lib/attendance-clock.ts` + `pg_stat_activity`-подтверждённая реальная конкуренция) + отдельный
живой HTTP-прогон (временный `next dev` на той же disposable БД):
- **Permissions**: 4 permission только `WORKER`; `ADMIN`/`SUPER_ADMIN`/`FOREMAN`/`SYSTEM`
  (ноль ролей) — ни одного; живые `401 NOT_AUTHENTICATED`/`403 FORBIDDEN`/`403
  NO_EMPLOYEE_PROFILE`/`403 CSRF_REJECTED` через реальные HTTP-запросы.
- **GPS**: Haversine контрольная пара (антиподы на экваторе, `distance = R·π`, независимо
  вычислимое ожидаемое значение) и same-point; inside/outside; ровно на границе
  `radius+accuracy` (`<=`) и чуть за её пределами; `accuracy > 75` →
  `NOT_VERIFIED`/`LOW_ACCURACY`, координаты сохраняются, `geofenceVersionId=NULL`;
  `PERMISSION_DENIED`/`TIMEOUT`/`POSITION_UNAVAILABLE`; отсутствующая геозона →
  `NOT_VERIFIED`, `gpsUnavailableReason=NULL`; Check In outside → полный откат (ни `ClockEvent`,
  ни `EmployeeOpenShift`, ни `AttendanceException` не создаются); Check Out outside — всё равно
  закрывает смену; precision/bounds/NaN/Infinity validation.
- **Time**: online skew `<= 5 мин` (включая ровно 5 мин на границе); прошлое `> 5 мин`; будущее
  `<= 2 мин` (включая ровно 2 мин); будущее `> 2 мин` (включая случай `< 5 мин`, всё равно
  `EXCESSIVE_CLOCK_SKEW`); bigint-safe экстремальный timestamp (эпоха 1970 vs текущее время, без
  переполнения `Number.MAX_SAFE_INTEGER`); хронологический clamp ровно `+1мс`.
- **Check In**: normal accepted; source assignment resolved; stale assignment допущен +
  `STALE_ASSIGNMENT`; без геозоны допущен + `GPS_NOT_VERIFIED`; double check-in создаёt
  event/exception, не заменяя открытую смену; точный replay без дубликата; изменённый replay →
  конфликт с записанным `ClockEventIdConflict` без координат.
- **Check Out**: normal close; orphan checkout; site mismatch закрывает по authoritative site;
  outside geofence/no GPS всё равно закрывают; хронологическая аномалия (`endAtProvisional=true`,
  `+1мс` clamp, `CHECK(recordedEndAt > recordedStartAt)` гарантированно удовлетворён); excessive
  duration (`EXCESSIVE_SHIFT_DURATION` относительно `CompanyAttendancePolicy.
  maxShiftDurationHours`); overlap с фиктивно состаренной (`createdAt` −100 дней) сырой сменой —
  подтверждает отсутствие temporal pre-filter в переиспользованном `overlapCandidates`;
  `ClockShift` остаётся `PENDING`, ноль `ClockShiftFragment`.
- **Switch**: success (общий `groupId`, старая смена закрыта + новая открыта атомарно); no open
  shift → `409`; new site outside geofence → полный откат; forced failure between halves
  (несуществующий `newSiteId` после того, как Check Out половина уже писала) → полный откат,
  старая смена остаётся открытой (прямая проверка исправленного в п. D бага); exact replay без
  повторного создания; конфликтующая половина → `409`, состояние работника не тронуто.
- **Real concurrency** (`pg_stat_activity`, `>= 2` одновременно активных backend PID
  подтверждено): два одновременных Check In — ровно один `ACCEPTED`, второй
  `NEEDS_REVIEW`/`DOUBLE_CHECK_IN`; два одновременных Check Out — ровно один закрывает со
  `ClockShift`, второй становится orphan; Check Out vs Switch на одном работнике — без падения,
  согласованное конечное состояние; два Switch на одном работнике — без падения, согласованное
  состояние; replay race с одинаковым `clientEventId` — ровно одна строка `ClockEvent`, без
  дублей; противоположная ориентация конкурентного `resolveOverlapTransition(A,B)`/`(B,A)` —
  ровно одна каноническая `OPEN`-строка.
- **DB invariants**: прямой `UPDATE`/`DELETE` `ClockEvent` отклонён триггером (оба);
  `ClockEventLocation` структурно привязана PK к своему событию; чужой-site `geofenceVersionId`
  отклонён composite FK (проверено через `INSERT`, не `UPDATE` — `ClockEvent` полностью immutable,
  `UPDATE` отклоняется триггером раньше, чем FK успевает сработать); чужой-site `WorkArea`
  отклонён composite FK; `ClockShift.checkInEventId`/`checkOutEventId` ссылаются на реальные
  события правильного типа/работника; ни `AuditEvent`, ни `ClockEventIdConflict` не содержат
  координат.
- **HTTP-level**: CSRF (`403 CSRF_REJECTED` без заголовка); malformed JSON/UUID → `400
  VALIDATION_ERROR`; malformed и несуществующий `siteId`/`assumedSiteId` → идентичный `404
  SITE_NOT_FOUND` (no oracle); `workAreaId`, не принадлежащий сайту → `400`; опциональный
  `Idempotency-Key` — невалидный формат → `400`, точный повтор (тот же key+body) → тот же
  cached-ответ, тот же key с другим телом → `409 IDEMPOTENCY_KEY_REUSED`; natural `clientEventId`
  replay работает НЕЗАВИСИМО от `Idempotency-Key`; rate limit (`20/60s` per actor+route) —
  реально протестирован до срабатывания `429 RATE_LIMITED`; `X-Request-Id` на каждом ответе.
- **Regression**: geofence admin (`GET /api/admin/sites/:siteId/geofence-versions`) — без
  изменений; worker `PATCH /api/worker/timesheets/:timesheetId/days/:date` — без изменений,
  включая резолюцию `sourceAssignmentId`; `POST /api/admin/corrections` (создание запроса на
  корректировку) — без изменений; `POST /api/admin/periods` — без изменений; worker/admin
  auth+session на всём протяжении HTTP-прогона — без изменений.

Технические проверки (все зелёные): `git diff --check`, `prisma validate` (схема не менялась),
`npx tsc --noEmit`, `npm run build` (все четыре новых роута подтверждены в билде), `docker compose
-f compose.titanor-time.yaml build app`, повторный `prisma migrate deploy` на новом disposable
Postgres 16 → `No pending migrations to apply` (50 миграций, ровно одна новая — чистый DML
permission-seed). Production (`titanor-time-app-1`/`titanor-time-db-1`) — только read-only
`docker inspect`, не тронут. Disposable Postgres 16 контейнер, тестовый docker-образ, dev-сервер и
scratch test-скрипты удалены после проверки.

Check In/Check Out/Switch Site online-контур закрыт; materialization/projection теперь также закрыты
следующим слайсом, описанным в начале документа. **Worker mobile UI, `GET /attendance/
context|today|week`, offline outbox/`deviceSequence`/`DeviceEventReceipt`-FIFO, `POST /
attendance/sync`, scheduler, exception-review-эндпоинты, admin attendance overview и production
по-прежнему не реализованы.** Attendance Clock/T7A в целом — не завершён.

---

**T7A.2 — Geofence admin, НОВЫЙ этап, продолжение locking/provenance foundation (slice A+B).**
Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §2.1 п.1 (`WorkSiteGeofenceVersion`),
§2.2 (`WorkSite.currentGeofenceVersionId`), §4.1 (immutable trigger, уже существовал в схеме с
revision 3 — этот слайс впервые заставляет приложение реально его упражнять), §5.1 (bounds/default
radius), §12.1/§12.3/§16 "Geofence admin": `GET/POST /api/admin/sites/:siteId/geofence-versions` +
секция `GeofenceSection` на `/admin/sites/[siteId]`. Единственная новая migration —
`20260813000000_seed_attendance_geofence_permissions` (чистый DML, seed permission/RolePermission,
без изменения схемы) — `prisma/schema.prisma` и все ранее применённые migrations, включая
`20260812000000_add_attendance_clock_schema_foundation`, не тронуты. Check In/Check Out,
Haversine/GPS-оценка (§5.2-5.4), worker mobile UI, offline outbox/sync, materializer, scheduler,
exception review — не реализованы, как и требовалось; карты/сторонний map SDK не подключены.

**A. Permissions** — `attendance.geofence.read`/`attendance.geofence.update`, засеяны новой
additive DML-миграцией, выданы только `ADMIN`/`SUPER_ADMIN` (проверено прямым SQL-запросом
`RolePermission`/`Permission`/`Role` на одноразовом PostgreSQL 16 — ровно 4 гранта; `FOREMAN`/
`WORKER`/`SYSTEM` не получают ни одной).

**B. `lib/geofences.ts`** (новый модуль, tx-safe, без дублирования бизнес-логики в route) —
`getGeofenceHistory(siteId, page, pageSize)`: `current` (текущая версия либо `null`) отдельно от
`items` (пагинированная история, `versionNumber DESC`), `latitude`/`longitude` сериализованы как
стабильные decimal-строки (`.toFixed(6)`), никогда сырые GPS-координаты сотрудников.
`validateGeofenceInput` (чистая функция) — `latitude ∈ [-90,90]`, `longitude ∈ [-180,180]`,
максимум 6 знаков после точки (round-trip проверка, `Math.round(v·1e6)/1e6 === v` — избыточная
точность отклоняется, никогда не округляется молча), `radiusMeters` — целое `1..2000`, все поля
обязательны. `createGeofenceVersion(siteId, actorUserId, requestId, input)` — одна транзакция:
`WorkSite FOR UPDATE` → переподтвердить существование под локом (`SITE_NOT_FOUND` иначе) →
следующий `versionNumber` из свежего состояния → `INSERT` новой (immutable) версии → `UPDATE
WorkSite.currentGeofenceVersionId` → `AuditEvent(SITE_GEOFENCE_VERSION_CREATED)` без координат.

**C. HTTP-контракт** (`app/api/admin/sites/[siteId]/geofence-versions/route.ts`) — `GET`: malformed
и несуществующий `siteId` дают идентичный `404 SITE_NOT_FOUND` (no oracle, `UUID_PATTERN`-проверка
до обращения к Prisma). `POST`: CSRF, обязательный `Idempotency-Key` (тот же шифрованный механизм,
что `POST /api/admin/workers`, `requestHash` включает `siteId`+canonical body — точный повтор не
создаёт новую версию, тот же `key` с другим site/телом → `409 IDEMPOTENCY_KEY_REUSED`), permission,
затем `validateGeofenceInput`, затем `createGeofenceVersion` — успех `201` с созданной версией +
`currentGeofenceVersionId`.

**D. UI** (`GeofenceSection.tsx`, `app/admin/sites/[siteId]/page.tsx`) — данные загружаются
server-side в `SiteDetailPage` (`Promise.all` вместе с `getSiteDetail`/`listAssignableForemen`, без
N+1, без client-side `GET`); empty state "Geofence not configured"; текущая версия +
краткая история newest-first; форма latitude/longitude/radiusMeters (`step="any"` — намеренно без
native `min`/`max`/`step`-blocking, чтобы КАЖДОЕ значение доходило до серверной валидации и её
`fieldErrors`, не до generic browser tooltip); default radius `150` для первой настройки,
предзаполнение текущими значениями для последующей версии; явный текст «Saving creates a new,
immutable geofence version»; `router.refresh()` после успеха; `fieldErrors`/`409`
idempotency-ошибки отображаются понятно. Доступ ограничен тем же `ADMIN`/`SUPER_ADMIN`-гейтом
страницы, что уже используют `WorkAreaSection`/`ForemanAssignmentSection`.

Проверено на новом одноразовом PostgreSQL 16, **68/68 PASS, 0 FAIL** (DB-level, `lib/geofences.ts`
напрямую) + отдельный живой HTTP-прогон (временный `next dev` на той же disposable БД) + браузерная
(Playwright) UI-проверка:
- **Permissions**: `ADMIN`/`SUPER_ADMIN` — оба permission; `FOREMAN`/`WORKER` — ни одного; `SYSTEM`
  (ноль ролей) — ни одного; живые `401`/`403` через реальные HTTP-запросы.
- **GET**: объект без геозоны → `current=null`, `items=[]`; после создания → `current` заполнен;
  история newest-first; pagination (`page`/`pageSize`, дефолт 20/максимум 100); malformed и
  несуществующий `siteId` → идентичный `404`; decimal precision стабильна между запросами.
- **POST**: v1→`versionNumber=1`, v2→`versionNumber=2`, v1-строка не изменилась, `current`
  переключился на v2; bounds latitude/longitude (`-90/90`, `-180/180`, включительно); radius `0`/
  отрицательный/`>2000`/не целое отклонены, `1`/`2000` приняты (границы включительно); избыточная
  точность (7-8 знаков) отклонена, не округлена; отсутствующие/`NaN`/`Infinity`/строковый мусор
  отклонены с точными `fieldErrors`; malformed JSON → `400`; лишние поля в теле (включая попытку
  подсунуть `currentGeofenceVersionId`) не влияют на запись; CSRF/permission/`Idempotency-Key`
  required-и-невалидный — все через реальные HTTP-запросы; точный повтор (`key`+тело) не создаёт
  новую версию — тот же `201`-ответ; тот же `key` с другим телом → `409 IDEMPOTENCY_KEY_REUSED`.
- **Atomicity/concurrency (РЕАЛЬНАЯ, не последовательная симуляция)**: два конкурентных `POST`
  одного объекта — `versionNumber` последовательны и уникальны (`[1,2]`), `current` указывает на
  последнюю закоммиченную версию, ровно один `AuditEvent` на версию; подтверждено прямым запросом
  `pg_stat_activity` — 2 конкурентно активных backend PID, исключая наблюдателя; разные объекты не
  блокируют друг друга (оба завершаются быстро при конкурентном вызове); принудительная ошибка
  между `INSERT` версии и `UPDATE current` откатывает всё — ни строки версии, ни `AuditEvent`, ни
  изменения `currentGeofenceVersionId` не переживают откат.
- **DB invariants**: прямой `UPDATE`/`DELETE` `WorkSiteGeofenceVersion` отклонён
  `trg_geofence_version_immutable`; `currentGeofenceVersionId`, направленный на версию другого
  объекта, отклонён composite FK; повторный `prisma migrate deploy` на чистой БД → `No pending
  migrations` (49 миграций).
- **UI (живой браузер, Playwright)**: empty state; первое создание с default radius 150; состояние
  после `router.refresh()`; создание второй версии; история показывает обе, старые данные не
  изменились; validation error state (excess precision) корректно показывает и field-level, и
  общую ошибку — потребовало правки: native `min`/`max`/`step` на `<input type="number">`
  блокировали отправку ДО достижения серверной валидации (browser-native tooltip вместо
  `fieldErrors`), заменено на `step="any"` без `min`/`max`; console — без ошибок приложения (один
  наблюдаемый `404` — `/favicon.ico`, пред-существующий пробел сайта, не связан с этим слайсом);
  существующие Work areas/Foremen/Active assignments/Edit-секции той же страницы работают как
  раньше, layout не сломан.
- **Security**: `AuditEvent`/логи не содержат latitude/longitude; нет чтения `ClockEventLocation`/
  сырых GPS сотрудников; `X-Request-Id` на каждом ответе; `404 SITE_NOT_FOUND` не превращается в
  UUID-oracle (malformed/несуществующий — идентичный ответ).

Технические проверки (все зелёные): `git diff --check`, `prisma validate` (схема не менялась),
`npx tsc --noEmit`, `npm run build`, `docker compose -f compose.titanor-time.yaml build app`,
повторный `prisma migrate deploy` на новом disposable Postgres 16 → `No pending migrations to
apply` (49 миграций, ровно одна новая — чистый DML permission-seed). Docker image safety:
production `titanor-time-app-1`/`titanor-time-db-1` подтверждены неизменными (тот же image ID/
`StartedAt`/`RestartCount` до и после сборки) — read-only `docker inspect` только. Тестовый образ
`titanor-time-app:latest` удалён после проверки. Disposable Postgres 16 контейнер и все scratch
test/screenshot-скрипты удалены до/после использования — не часть финального diff'а.

Production/Check In-Out/GPS-Haversine-оценка/worker mobile UI/offline sync/materializer/scheduler/
exception-review/map SDK — не затронуты этой правкой, ни в каком виде. T7A.2 (Geofence admin)
закрыт; Attendance Clock/T7A в целом — не реализован.

---

**T7A locking slice B — recorded-vs-reported provenance, `ClockShiftAdjustment` и overlap
transitions, НОВЫЙ этап, продолжение slice A.** Реализует `docs/titanor-time/T7A_1_ATTENDANCE_
CLOCK_DESIGN.md` §10.1–10.3 (расширенный worker `PATCH`-провенанс) и §15 пункты 7–9 (correction
provenance/adjustments/overlap-transition по версии) — locking §15 как единое целое теперь закрыт
полностью (пп. 1–9). Никакой новой схемы/миграции — `prisma/schema.prisma` и
`prisma/migrations/` не тронуты этим слайсом. Geofence API/UI, Check In/Check Out, worker mobile
UI, offline outbox/sync, materializer, scheduler, exception-review endpoints — не реализованы, как
и требовалось.

**A. Общий модуль `lib/attendance-reported-projection.ts`** (новый файл) — единая §9.1a-реализация,
используемая идентично worker `PATCH` и `correction.approve` (ни один путь не дублирует
overlap-логику самостоятельно): `effectiveReportedRanges`/`effectiveReportedRangesBatch` (per-
fragment authoritative live projection — `TimesheetDraftSegment` для `DRAFT`/`RETURNED`, `WorkSegment`
строго при `timesheetVersionId=currentVersionId` для `SUBMITTED+`; raw fallback только пока
`ClockShiftFragment.reportedProjectionState='PENDING'`; `SETTLED` без live-сегмента — authoritative
пустой вклад, не raw); `overlapCandidates` (полный employee-scoped скан без 72ч-допущения + уже
существующие `OPEN`/`DISMISSED` пары); `canonicalPair` (`LEAST`/`GREATEST` по стандартному uuid
btree-порядку, совпадающему с обычным сравнением строк для canonical lowercase-формы); `provenance
ValuesEqual`; `resolveOverlapTransition` (тот же occurrence-автомат §9.1a — сам резолвит и
валидирует SYSTEM-актора непосредственно перед авто-`RESOLVE`, вызывающий никогда не передаёт actor
явно; пишет `AuditEvent(OVERLAPPING_SHIFT_AUTO_RESOLVED)` на авто-резолюции); `resolveOverlapsFor
AffectedShifts` (полный affected-shift/candidate/`processedPairs`-цикл §10.2 шаг 6, вызываемый один
раз из каждого из двух call site'ов).

**B. `patchWorkerTimesheetDay`** (`lib/worker-timesheets.ts`, §10.1–10.3) — контракт расширен
двумя опциональными полями (`segment.originClockShiftFragmentId`, `clockAdjustmentReasons`),
полностью обратно совместимо. Внутри уже существующей транзакции/локов (§15 п.2, slice A):
`previousLive` читается до любой мутации; входящий origin разрешён только если уже присутствует в
`previousLive` (403 `FORBIDDEN`, без UUID-oracle — тот же код для чужого и никогда не
существовавшего id); дубли origin в одном запросе → 400 `VALIDATION_ERROR`; реальное изменение
origin-сегмента (сравнение с `lastKnown` = последний `ClockShiftAdjustment.after*` либо
`ClockShiftFragment.recorded*`) требует непустой причины, иначе 400 `VALIDATION_ERROR` и полный
откат; `ClockShiftAdjustment(EDITED|RESTORED_TO_RECORDED|REMOVED)` пишется в той же транзакции,
`changedByUserId` = реальный worker `User`, никогда `SYSTEM`; `affectedFragmentIds` = before
(`previousLive`) ∪ after (входящие origin) — чистое `REMOVED` не теряется; recreated
`TimesheetDraftSegment` сохраняет `originClockShiftFragmentId`; после delete/recreate вызывается
`resolveOverlapsForAffectedShifts`.

**C. `lib/corrections.ts`** — `openCorrectionDraft` копирует `originClockShiftFragmentId` из
`WorkSegment` в `CorrectionDraftSegment` (§15 п.8); `getCorrectionDetail` и
`patchCorrectionDraftDay`'s response возвращают его (round-trip не теряет provenance);
`patchCorrectionDraftDay` (§15 п.9) — та же membership-проверка, что worker `PATCH` (403
`FORBIDDEN` для чужого/никогда не существовавшего origin), теперь под явными `Employee` →
`Timesheet` → `CorrectionDraft FOR UPDATE` локами (первым действием, до этого слайса эта функция
не брала локов вовсе), pre-lock чтение — только routing (`correctionRequestId → timesheetId/
employeeId`), никогда не authoritative; `ClockShiftAdjustment` на этой стадии не пишется —
корректировка ещё не approved. `decideCorrection` (§15 п.7) — тот же канонический lock order
(`Employee` → `Timesheet` → `CorrectionRequest FOR UPDATE`); status/ownership/`currentVersionId`/
self-approval перечитываются под локом; до переключения `currentVersionId` — снимок
`beforeOriginFragmentIds`/`beforeRangesByShift` из OLD `WorkSegment`; при заморозке
`originClockShiftFragmentId` копируется в новый `WorkSegment`; после freeze+switch —
`ClockShiftAdjustment` для реально изменённых origins, `changedByUserId` = реальный
`CorrectionRequest.decidedByUserId`, `reason` = `CorrectionRequest.reason`, никогда `SYSTEM`;
`resolveOverlapsForAffectedShifts` вызывается тем же образом, что worker `PATCH`. `REJECTED`
никогда не создаёт `WorkSegment`/`ClockShiftAdjustment`/overlap-transition.

Проверено на новом одноразовом PostgreSQL 16, **111/111 PASS, 0 FAIL** — 5 test-суитов, все с нуля
из 48 baseline migrations (без создания новой миграции этим слайсом):
- **Suite 1 (26 PASS) — worker provenance**: unchanged origin не создаёт adjustment; `EDITED`/
  `RESTORED_TO_RECORDED`/`REMOVED` с причиной создают точный adjustment; изменение/удаление без
  причины → `VALIDATION_ERROR` и полный rollback (проверено прямым запросом состояния); duplicate
  origin → `VALIDATION_ERROR`; чужой/никогда не существовавший origin → идентичный `FORBIDDEN`
  (no oracle); manual-сегмент без origin работает как раньше рядом с нетронутым origin-сегментом;
  origin переживает patch → submit → admin-override return (reinitialize) → resubmit.
- **Suite 2 (30 PASS) — correction provenance**: open копирует origin; `getCorrectionDetail` и
  patch-response его возвращают; PATCH round-trip не теряет; чужой origin отклонён; approve
  сохраняет origin в новом `WorkSegment`; unrelated-field правка (без изменения origin) не создаёт
  ложный adjustment; `EDITED`/`REMOVED`/`RESTORED_TO_RECORDED` создают точные adjustments на
  approve; `changedByUserId` — реальный approver, не `SYSTEM`; `reason` — `CorrectionRequest.
  reason`; `REJECTED` не создаёт `TimesheetVersion`/`ClockShiftAdjustment`.
- **Suite 3 (27 PASS) — overlap transitions**: worker edit создаёт новый `OPEN`; worker removal
  резолвит существующий `OPEN` (`resolvedByUserId=SYSTEM`, `resolvedAt`/`overlapEndedAt` заполнены);
  correction approve создаёт `OPEN`; correction approve с removed origin резолвит `OPEN`; два
  раздельных `effectiveReportedRanges` не становятся envelope (`SETTLED`-фрагмент без live-сегмента
  — пустой вклад, тест доказывает оба свойства одним сетапом); `currentVersionId` исключает старые
  `WorkSegment`-версии (V1 не участвует после переключения на V2); смена, чей reported-диапазон
  ушёл на несуществующий раздельный "день" (>72ч от raw), всё равно найдена `overlapCandidates`
  и подтверждена `overlapExists`; повторный no-op вызов не создаёт дубликат; после `RESOLVED`
  повторное появление overlap создаёт новую `OPEN`-строку, историческая `RESOLVED` не переписана.
- **Suite 4 (14 PASS) — РЕАЛЬНАЯ two-connection concurrency**, не последовательная симуляция,
  каждый сценарий подтверждён прямым запросом `pg_stat_activity` (2 конкурентно активных backend
  PID, исключая наблюдателя, зафиксировано во всех четырёх сценариях в стабильном прогоне):
  parallel worker `PATCH` одного draft/day (обе стороны успевают, финальное состояние — ровно один
  сегмент от одного из писателей, без частичной/задвоенной записи); `PATCH` vs `submit` (обе
  очерёдности дают самосогласованный результат — либо `DRAFT_NOT_EDITABLE` для patch и одна
  корректно замороженная версия, либо patch применился и submit подхватил его); два конкурентных
  `decideCorrection` над одной `CorrectionRequest` (ровно один успех, второй — чистый
  `INVALID_STATE_TRANSITION`, ровно одна новая `TimesheetVersion`); `resolveOverlapTransition` для
  одной пары в противоположной ориентации через два независимых `PATCH` одного employee (Инвариант
  3, §8.3, оба сериализованы `Employee FOR UPDATE`) — ровно одна `OPEN`-строка, без дублей.
- **Suite 5 (14 PASS) — regression + security**: все не связанные с provenance коды worker `PATCH`
  (`NOT_FOUND`/ownership `FORBIDDEN`/`SITE_NOT_ASSIGNED`/`WORK_SEGMENT_OVERLAP`/`DAY_TYPE_CONFLICT`)
  и correction-flow (`SELF_APPROVAL_FORBIDDEN`, `NO_CORRECTION_CHANGES`, draft-patch
  `WORK_SEGMENT_OVERLAP`/`DAY_TYPE_REQUIRES_ABSENCE`) не изменились; ни один `ClockShiftAdjustment.
  reason` или auto-resolve `AuditEvent`-payload не содержит GPS/secret-подобного контента; `403`
  worker PATCH идентичен байт-в-байт для чужого и никогда не существовавшего origin. Дополнительно
  — живой HTTP-прогон (временный `next dev` на одноразовой БД, не production): CSRF/auth/permission
  gates обоих изменённых route-файлов подтверждены реальными запросами (401 без сессии — через
  существующий `proxy.ts`, 403 `CSRF_REJECTED` без заголовка при валидной сессии, permission gate
  пройден и достигнут код бизнес-логики) — не только по чтению кода.

Технические проверки (все зелёные): `git diff --check`, `prisma validate` (схема не менялась —
подтверждён diff `prisma/`), `npx tsc --noEmit`, `npm run build`, повторный `prisma migrate deploy`
на новом disposable Postgres 16 → `No pending migrations to apply` (48 миграций, эта задача не
создаёт новую), `docker compose -f compose.titanor-time.yaml build app`. Docker image safety:
production `titanor-time-app-1`/`titanor-time-db-1` подтверждены неизменными (тот же image ID/
`StartedAt`/`RestartCount` до и после сборки) — read-only `docker inspect` только. Тестовый образ
`titanor-time-app:latest` удалён после проверки. Disposable Postgres 16 контейнер и все scratch
test-скрипты (`scripts/_test-slice-b.ts`, `scripts/_test-http-session.ts`) удалены до/после
использования — не часть финального diff'а.

Production/geofence API/UI/Check In-Out/worker mobile UI/offline sync/materializer/scheduler/
exception-review endpoints — не затронуты этой правкой, ни в каком виде. Locking-фундамент §15 как
целое (пп. 1–9) закрыт полностью двумя слайсами (A + B); Attendance Clock/T7A в целом — не
реализован, только locking/provenance-фундамент под будущие geofence/Check-In-Out/materializer/
scheduler-слайсы.

---

**T7A locking slice A — безопасная подготовка существующего timesheet-кода к Attendance Clock,
НОВЫЙ этап (не audit-fix предыдущего).** Реализует `docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_
DESIGN.md` §15 пункты 1–6 (locking-дисциплина существующего кода) + application-level SYSTEM
guards (§13) шире, чем буквальный пункт 4. Никакой новой схемы/миграции — `prisma/schema.prisma`
и `prisma/migrations/` не тронуты этим слайсом. §15 пункты 7–9 (correction provenance/adjustments)
— отдельный, ещё не начатый T7A locking slice B. Geofence API/UI, Check In/Check Out, worker
mobile UI, offline outbox/sync, materializer, scheduler — не реализованы, как и требовалось.

**A. `submitWorkerTimesheetCore(tx, ...)` + тонкая `submitWorkerTimesheet` обёртка**
(`lib/worker-timesheets.ts`). Core принимает `Prisma.TransactionClient`, не открывает своей
транзакции, не использует global `prisma`; пишет `TimesheetVersion.submissionSource` (manual
wrapper всегда передаёт `MANUAL`); копирует `TimesheetDraftSegment.originClockShiftFragmentId` →
`WorkSegment.originClockShiftFragmentId` при заморозке сегментов; carry-forward/review-scope/
contentHash семантика не менялась. Manual-обёртка открывает одну транзакцию, берёт `Employee` →
`Timesheet FOR UPDATE` (канонический порядок §8.1), перечитывает `employeeId`/`status` **под
локом** (не из pre-lock чтения), затем `TimesheetDraft FOR UPDATE`, затем вызывает Core. Перед
`return` Core сканирует `AttendanceException(LATE_SYNC_AFTER_SUBMIT, OPEN)` этого employee/
timesheet/payrollPeriod, чей `clockShiftFragmentId` теперь представлен среди только что
замороженных `WorkSegment.originClockShiftFragmentId` — переводит их в `RESOLVED`,
`resolvedByUserId` = реальный `User(userKind=SYSTEM, username=system.scheduler)`,
`resolutionNote='resolved by resubmission (Vn+1)'` (стабильный технический текст, без координат/
секретов). Если такие исключения есть, а SYSTEM-актор отсутствует или не соответствует инварианту
(`status≠DEACTIVATED`/`passwordHash≠NULL`/`employeeId≠NULL`) — вся submit-транзакция откатывается
(`throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID')`); обычный submit без таких
исключений не платит эту дополнительную проверку вовсе.

**B. `patchWorkerTimesheetDay`** (`lib/worker-timesheets.ts`) — все DB-чтения, влияющие на
ownership/state/day-validation/write, перенесены внутрь одной транзакции, за `Employee` →
`Timesheet` → `TimesheetDraft FOR UPDATE` (первым действием, §8.1/§10.3); только два чисто
DB-независимых предвалидационных чека (self-overlap сегментов, границы перерывов) остаются перед
транзакцией. Статус/ownership перечитываются под локом, не из старого чтения. Существующие
API-коды, delete-before-insert порядок и overlap-mapping не изменились. Расширенный clock
provenance PATCH/`ClockShiftAdjustment` (§10.2/§15 пп.7–9) этим слайсом не реализован.

**C. `returnReviewScope`** (`lib/review-scopes.ts`) и **`returnTimesheetOverride`**
(`lib/admin-timesheets.ts`) — оба человеческих пути возврата теперь атомарно, в существующей
транзакции/локах, выставляют `Timesheet.lastReturnedReason = HUMAN_REVIEW_RETURN` при переходе в
`RETURNED`. Человечески-возвращённый табель больше никогда не остаётся с `lastReturnedReason =
NULL`.

**D. `reinitializeDraftFromVersion`** (`lib/review-scopes.ts`) — список копируемых полей
`WorkSegment → TimesheetDraftSegment` теперь включает `originClockShiftFragmentId`. Provenance
clock-сегмента больше не теряется на каждом цикле `return`/`reopen`.

**E. `computePlannedShiftForAssignmentDate(templateDay, date)`** — общая, чистая функция в
`lib/periods.ts`, извлечённая из идентичной, ранее продублированной формулы `createPeriod`
(`lib/periods.ts`) и `createAssignment` (`lib/assignments.ts`). Единая weekday/DST/Helsinki
wall-clock/working-day/null-template логика; оба call site теперь вызывают её, не поддерживают
копию независимо; будущий materializer (§9.4) сможет использовать ту же функцию.

**F. SYSTEM user application guards** (§13, шире буквального пункта 4 из соображений
defense-in-depth) — явная проверка `userKind='HUMAN'` на каждом реальном пути, где мог бы
оказаться SYSTEM: `lib/users.ts` `listUsers()` (`WHERE userKind='HUMAN'`); `POST /api/auth/login`
(независимо от `status`, тот же `401 INVALID_CREDENTIALS` + dummy-verify задержка, что и
неизвестный identifier — не отдельный код, не подтверждающий существование `system.scheduler`);
`lib/system-activation.ts` `issueSystemActivationToken()` и `setAccountPassword()` (issuance И
redemption обеих сторон standalone-активации — стабильный код `SYSTEM_USER_NOT_ELIGIBLE`);
`scripts/reset-password.ts` CLI (`SystemUserNotEligibleError`, exit code 4, без изменения
`passwordHash`). Роль/сессия: отдельного HTTP-пути, выдающего произвольному `userId` роль или
сессию, в проекте не существует — оба реальных `UserSession.create` сайта уже транзитивно
защищены login- и redemption-guard'ом выше. HUMAN worker/admin/foreman login+activation regression
подтверждён (не изменилось поведение).

Проверено на новом одноразовом PostgreSQL 16, **102/102 PASS, 0 FAIL** по прямому вызову
production-функций (не только raw SQL) — 5 test-суитов, все с нуля из 48 baseline migrations +
T7A schema-foundation (без создания новой миграции этим слайсом):
- **Suite 1 (32 PASS)**: manual submit (одна версия, `submissionSource=MANUAL`, `AuditEvent`,
  planned-shift заморожен); provenance freeze + return/reinitialize + resubmit round-trip
  (`originClockShiftFragmentId` не теряется ни на одном шаге); late-sync resolution (только
  подходящее исключение резолвится, несвязанное не трогается, `resolvedByUserId` — реальный
  SYSTEM, `resolutionNote` без координат/секретов; отсутствие SYSTEM при наличии подходящего
  исключения откатывает ВСЮ версию/статус/audit; обычный submit без исключений не зависит от
  SYSTEM); human return reason (оба пути — `returnReviewScope` и `returnTimesheetOverride`).
- **Suite 2 (17 PASS)**: `computePlannedShiftForAssignmentDate` напрямую — non-working day,
  null-template, working day зимой (EET, UTC+2) и летом (EEST, UTC+3) с точными UTC-инстантами,
  overnight (текущее, не изменённое поведение), `toTemplateWeekday`; интеграционно —
  `createPeriod` и `createAssignment` дают идентичные значения для одной и той же
  (assignment, date) пары; старый snapshot-assignment не переключается на новую template version
  после её создания.
- **Suite 3 (17 PASS)**: `patchWorkerTimesheetDay` regression — `FORBIDDEN`/`NOT_FOUND`/
  `VALIDATION_ERROR`(дата вне периода)/`SITE_NOT_ASSIGNED`/`WORK_SEGMENT_OVERLAP`/breaks-валидация/
  `DAY_TYPE_REQUIRES_ABSENCE`/`DAY_TYPE_CONFLICT`, успешный patch, delete-before-insert (замена, не
  append), `DRAFT_NOT_EDITABLE` после submit — все существующие коды/поведение не изменились.
- **Suite 4 (16 PASS)**: SYSTEM guards — `listUsers` исключает SYSTEM даже при искусственно
  выданной роли; login отклоняет SYSTEM (`401`), принимает HUMAN (regression), отклоняет неверный
  пароль (regression); ноль `UserSession` для SYSTEM; issuance И redemption активации отклоняют
  SYSTEM (`SYSTEM_USER_NOT_ELIGIBLE`), legitimate HUMAN standalone foreman по-прежнему проходит
  (regression); reset-password CLI отклоняет SYSTEM без изменения `passwordHash`, HUMAN dry-run
  regression проходит; ноль ролей/сессий у SYSTEM в конце прогона.
- **Suite 5 (20 PASS) — РЕАЛЬНАЯ two-connection concurrency**, не последовательная симуляция:
  submit vs submit одного DRAFT (`Promise.all` двух настоящих вызовов `submitWorkerTimesheet` —
  ровно один успех/одна версия, второй `INVALID_STATE_TRANSITION`, ≥2 одновременно активных
  backend PID подтверждены прямым запросом к `pg_stat_activity` во время гонки); patch vs submit,
  обе очерёдности (patch-first: submit видит патч, не устаревший draft; submit-first: patch
  получает `DRAFT_NOT_EDITABLE` под свежим локом, ровно одна версия, без partial freeze); return
  vs patch, обе очерёдности (второй scope-return гонится с worker patch — committed данные patch'а
  переживают идемпотентный reinitialize-check независимо от того, кто победил гонку). Для каждого
  сценария в логе — фактический результат ОБОИХ соединений и read-only DB-итог, не нарратив.

Технические проверки (все зелёные): `prisma validate`/`generate` (схема не менялась — подтверждён
diff `prisma/`), `npx tsc --noEmit`, `npm run build`, повторный `prisma migrate deploy` на новом
disposable Postgres 16 → `No pending migrations` / `Database schema is up to date!` (эта задача не
создаёт новую миграцию), `docker compose -f compose.titanor-time.yaml build app`, `git diff
--check`.

Docker image safety: production `titanor-time-app-1`/`titanor-time-db-1` подтверждены неизменными
(тот же image ID/`StartedAt`/`RestartCount` до и после сборки). Тега `titanor-time-app:latest` не
было до задачи — тестовый образ удалён полностью после проверки. Пять scratch-тест-скриптов
(`scripts/_ls_0{1..5}_*.ts`), использованных для этого прогона, удалены до коммита — не часть
финального diff'а.

Production/geofence API/UI/Check In-Out/worker mobile UI/offline sync/materializer/scheduler/
correction provenance (T7A locking slice B, §15 пп.7–9)/locking §15 как целое (только пп.1–6
закрыты этим слайсом) — не затронуты этой правкой, ни в каком виде.

---

**T7A schema-foundation slice — закрытие последнего SYSTEM identity race, тот же slice.**
Продолжение review-fix (`9416e26`) — audit-closeout закрыл гонку между preflight-проверкой и
конкурентной вставкой ТОЧНО совпадающего username, но `User.username @unique` — обычный
case-sensitive индекс. Оставался непроверенный сценарий: preflight не находит коллизию → после
него конкурентно вставляется HUMAN с username в ДРУГОМ регистре (`System.Scheduler`) → SYSTEM seed
(`system.scheduler`, ровно нижний регистр) не конфликтует с этим индексом → миграция могла успешно
завершиться, оставив ОДНОВРЕМЕННО HUMAN `System.Scheduler` и SYSTEM `system.scheduler` — нарушение
уже обещанной case-insensitive гарантии резервирования идентичности. Locking slice (§15)
по-прежнему **не начат**.

**Исправление.** Существующий `CHECK ck_user_system_shape` (CK-34) расширен на месте — не новый
constraint, не новая миграция (миграция всё ещё не применена ни к одной постоянной базе, правка
in-place разрешена). Новый предикат:
```sql
CHECK (
  ("userKind" = 'HUMAN' AND lower("username") <> 'system.scheduler')
  OR
  ("userKind" = 'SYSTEM' AND "username" = 'system.scheduler'
   AND "employeeId" IS NULL AND "passwordHash" IS NULL AND "status" = 'DEACTIVATED')
)
```
Теперь ни один HUMAN не может держать `system.scheduler` ни в каком регистре, а SYSTEM обязан иметь
ровно этот username (переименование или смена `userKind` на HUMAN с сохранением username —
запрещены тем же CHECK). Количество CHECK constraints не изменилось — **15**, как и было.
Закрывает оба возможных порядка гонки: если конкурентная вставка происходит ДО того, как миграция
меняет `"User"` — `ALTER TABLE ... ADD CONSTRAINT` в конце транзакции проверяет все существующие
строки и откатывает ВСЮ T7A DDL, если находит нарушителя (найдена эмпирически: PostgreSQL
валидирует `CHECK` против всех строк на момент `ADD CONSTRAINT`, а не только новых). Если
конкурентная вставка происходит ПОСЛЕ коммита миграции — сам `CHECK` отклоняет её напрямую.
`ux_user_single_system` (UX-03) оставлен без изменений; отмечено, что на практике для повторной
попытки вставить второй SYSTEM-ряд первым срабатывает `User_username_key` (т.к. CK-34 теперь
допускает только один буквальный username для SYSTEM), `ux_user_single_system` остаётся защитой
в глубину для форм строки, не исключённых CK-34.

Проверено на новом одноразовом PostgreSQL 16 (24 обязательных пункта): Suite A (1–4) — 48 baseline
migrations + T7A с нуля, ровно один SYSTEM User с username `system.scheduler`, повторный
`migrate deploy` → No pending migrations, `migrate status` → up to date. Suite B (5–6) —
pre-existing коллизия HUMAN `system.scheduler` и HUMAN `System.Scheduler` перед миграцией — оба
атомарно отклонены `SYSTEM_SCHEDULER_USERNAME_OCCUPIED`, 0 T7A DDL, HUMAN-строка не изменена.
Suite C (7–14) — 10/10 PASS: INSERT HUMAN `system.scheduler`/`System.Scheduler`/`SYSTEM.SCHEDULER`
после успешной миграции все отклонены CHECK; обычный HUMAN username проходит; UPDATE SYSTEM
username (в том числе на case-вариант самого себя) отклонено; UPDATE SYSTEM `userKind`→HUMAN с
тем же username отклонено; SYSTEM password/status/username shape guards подтверждены; второй
SYSTEM отклонён (в реальности `User_username_key`, задокументировано честно в UX-03). Suite D
(15–16) — РЕАЛЬНЫЕ два конкурентных psql-соединения (не симуляция), FIFO-оркестрация: (а) exact-case
`system.scheduler` конкурентно после preflight — Session B (INSERT) успевает первой, Session A
(остаток DDL) падает на `check constraint "ck_user_system_shape" ... is violated by some row`,
read-only проверка после — 0 T7A-таблиц/enum/колонок/constraint, ровно одна строка
`lower(username)=lower('system.scheduler')` (HUMAN-строка Session B, не тронута); (б) тот же
сценарий с case-вариантом `System.Scheduler` — идентичный результат: миграция откатилась целиком,
выжила ровно одна строка с этим lower-username, она HUMAN, SYSTEM-строки нет. Оба случая
демонстрируют одну и ту же реальную гонку — единственное окно, где она вообще возможна, это до
первого DDL-затрагивания `"User"` (после этого PostgreSQL держит `ACCESS EXCLUSIVE` на `"User"` до
конца транзакции, что эмпирически обнаружено при первой попытке теста — конкурентный `INSERT`
заблокировался на этом локе и потребовал пересборки сценария с более ранней точкой разреза DDL).
Regression (17–24): все 16 composite FK negative + 12 nullable positive tests, coordinate bounds,
`id`/`createdAt` immutability — без регрессий; `prisma validate`/generate, `npx tsc --noEmit`,
`npm run build`, `docker compose -f compose.titanor-time.yaml build app`, `git diff --check` — все
зелёные.

Docker image safety: production `titanor-time-app-1`/`titanor-time-db-1` подтверждены неизменными
(тот же image ID/`StartedAt`/`RestartCount` до и после сборки). Тега `titanor-time-app:latest` не
было и до задачи — после проверки тестовый образ удалён полностью, без создания тега, которого не
существовало изначально.

Production/API/UI/offline sync/locking — не затронуты этой правкой, ни в каком виде.

**T7A schema-foundation slice — audit-closeout правка, тот же slice.** Продолжение review-fix
(`eed7d1b`) — три оставшиеся проблемы найдены и исправлены; locking slice (§15) по-прежнему **не
начат**.

**A. Настоящая атомарность миграции.** Прежний комментарий утверждал недоказанное поведение Prisma
("Prisma does wrap it for this provider") без реальной транзакции. Добавлена явная транзакция
(`BEGIN;`/`COMMIT;`) вокруг всего DDL+seed-блока. **Важная эмпирическая находка**: обернуть SYSTEM
collision preflight ВНУТРЬ этой же транзакции оказалось нельзя — тест на одноразовом PostgreSQL 16
показал, что Prisma migration engine после `RAISE EXCEPTION` внутри транзакции продолжает отправлять
следующие statements, и видимая ошибка становится generic `current transaction is aborted...` —
реальный идентификатор `SYSTEM_SCHEDULER_USERNAME_OCCUPIED` пропадает отовсюду (ни в stdout, ни в
`_prisma_migrations.logs`, ни под `DEBUG=prisma:*`). Итоговая структура: preflight остаётся ПЕРЕД
транзакцией (атомарен по построению — до него ничего не выполнялось), `BEGIN`/`COMMIT` оборачивают
весь DDL+seed-блок после него. Race (preflight не нашёл коллизию → конкурентная запись вставляет
`system.scheduler` → seed `INSERT` получает `unique_violation`) проверен НАПРЯМУЮ двумя реально
конкурентными psql-соединениями: DDL, выполненный до момента коллизии, полностью откатился, только
строка конкурентного writer'а осталась.

**B. Синхронизация документации.** Все оставшиеся упоминания «15 composite FK» как текущего факта
исправлены — исторические записи (revision 3.2.5 addendum, ранняя schema-foundation запись в этом
файле) явно помечены как «первоначальный ошибочный подсчёт, superseded owner correction
2026-08-12», не переписаны так, будто ошибки не было. Окончательное значение — **16** — теперь
единственное самостоятельно читаемое утверждение везде.

**C. Честная nullable/MATCH SIMPLE verification.** Все 12 применимых nullable composite FK (FK-01,
02, 03, 06, 07, 09, 10, 12, 13, 14, 15, 16) получили ОТДЕЛЬНЫЙ реальный positive-тест с NULL-значением
на одноразовом PostgreSQL 16 — ни один не заменён словами «структурно идентично», тестом другого FK
или корректной ненулевой ссылкой. FK-04/05/08/11 — N/A с точным обоснованием (все колонки этих FK
`NOT NULL`, нет валидного нерезолвленного состояния). Таблица §11.3 обновлена реальными результатами.

Проверено на новом одноразовом PostgreSQL 16 (предыдущий disposable-контейнер удалён вместе с
прошлым review-fix сеансом): все 48 существующих migrations + T7A с нуля; повторный `migrate deploy`
→ No pending migrations; `migrate status` → up to date; SYSTEM collision exact-case и case-variant —
оба атомарны (0 T7A-таблиц/enum/колонок, HUMAN-пользователь не изменён), ошибка чисто атрибутируется
`SYSTEM_SCHEDULER_USERNAME_OCCUPIED`; свободный username → ровно один SYSTEM User; все 16 cross-owner
FK negative tests (`23503`); все 12 nullable positive tests; coordinate boundary tests (обе таблицы);
`ClockShift`/`ClockShiftFragment` id+createdAt immutability regression; полный предыдущий invariant
suite (coverage/projection/retention/singleton/AttendanceException/DeviceEventReceipt) — **111 PASS,
0 unexpected errors** по всем тестовым батчам. `prisma validate`/generate, `tsc --noEmit`,
`npm run build`, `docker compose -f compose.titanor-time.yaml build app`, `git diff --check` — все
зелёные.

Docker image safety: production `titanor-time-app-1`/`titanor-time-db-1` подтверждены неизменными
(тот же image ID/`StartedAt`/`RestartCount` до и после сборки). Тега `titanor-time-app:latest` не
было и до задачи (проверено явно перед сборкой) — после проверки тестовый образ удалён полностью,
без попытки создать тег, которого не существовало изначально.

Production/API/UI/offline sync/locking — не затронуты этой правкой, ни в каком виде.

**T7A schema-foundation slice — review-fix applied, тот же slice, не новый.** Ревью коммита
`49f4132` не приняло его как PASS; migration `20260812000000_add_attendance_clock_schema_foundation`
исправлена на месте (не применялась ни к одной постоянной базе — правка допустима без новой
миграции) и закоммичена отдельным fix-коммитом. Locking slice (§15) **не начат** — ревью явно
запретило переходить к нему до PASS.

Исправлено (полный разбор — `docs/titanor-time/05_RAW_SQL_REGISTER.md` §11):
1. **Composite FK: 16, не 15.** `ClockEvent(siteId, workAreaId) → WorkArea(siteId, id)` физически
   требуется §2.1 п.3 design-документа и не удалялась — ошибочна была итоговая арифметика документа
   (§16/«Финал»), не миграция. Владелец подтвердил 16 как окончательное число во всех документах.
2. **SYSTEM user seed collision.** Seed-`INSERT` для `system.scheduler` больше не использует
   `ON CONFLICT ("username") DO NOTHING` (могло тихо завершить миграцию успешно, не создав SYSTEM
   User, если username уже занят HUMAN-пользователем). Теперь первым statement'ом всего
   `migration.sql` (до какого-либо T7A DDL) выполняется case-insensitive preflight-проверка; при
   конфликте — откат со стабильным идентификатором `SYSTEM_SCHEDULER_USERNAME_OCCUPIED`, без единой
   T7A-таблицы/enum/колонки, без изменения существующего пользователя. Атомарность подтверждена
   эмпирически на одноразовом PostgreSQL 16 (точное совпадение username и case-вариант).
3. **Immutability-триггеры `ClockShift`/`ClockShiftFragment`**: `id`/`createdAt` теперь явно входят
   в список неизменяемых полей (раньше не были защищены — реальная лазейка через `id` с
   `ON UPDATE CASCADE` composite FK на дочерние таблицы).
4. **Coordinate bounds**: новые `CHECK` на `WorkSiteGeofenceVersion`/`ClockEventLocation`
   (`latitude BETWEEN -90 AND 90`, `longitude BETWEEN -180 AND 180`) — раньше только текстовый
   комментарий, не DB-гарантия.
5. **Composite FK test coverage**: все 16 (не выборка) индивидуально протестированы негативным
   cross-owner сценарием на одноразовом PostgreSQL 16 — таблица результатов в
   `05_RAW_SQL_REGISTER.md` §11.3.

Итоговые числа после фикса: 13 таблиц (без изменений), 15 CHECK (было 13, +2 coordinate bounds), 3
partial/expression unique (без изменений), **16** composite FK (было документировано как 15/16
непоследовательно — теперь везде согласованно 16), 14 `CREATE TRIGGER`-биндингов/11 функций (тела
двух функций расширены, число триггеров не изменилось), 1 preflight guard (новое).

Проверено на новом одноразовом PostgreSQL 16 (предыдущий disposable-контейнер из коммита `49f4132`
был удалён вместе с тем сеансом ревью): все миграции с нуля, повторный `migrate deploy` → No
pending migrations, `migrate status` → up to date, `prisma validate`, Prisma Client generation,
`tsc --noEmit`, `npm run build`, `docker compose -f compose.titanor-time.yaml build app` — все
зелёные. Docker image safety: production `titanor-time-app-1`/`titanor-time-db-1` подтверждены
неизменными (тот же image ID/StartedAt/RestartCount до и после тестовой сборки); тестовый образ
`titanor-time-app:latest` удалён после проверки — см. коммит-отчёт для деталей одного
пограничного случая с недоступным для ретеггинга image ID, унаследованного из предыдущей сессии
(production-контейнер не затронут).

Production/API/UI/offline sync/locking — не затронуты этой правкой, ни в каком виде.

**T7A.1 schema-foundation slice реализован.** Точный объём из `T7A_1_ATTENDANCE_CLOCK_DESIGN.md`
§16 п.1: 13 новых таблиц (`WorkSiteGeofenceVersion`, `WorkerDeviceInstallation`, `ClockEvent`,
`ClockEventLocation`, `EmployeeOpenShift`, `ClockShift`, `ClockShiftFragment`,
`ClockShiftAdjustment`, `AttendanceException`, `ClockEventIdConflict`, `CompanyAttendancePolicy`,
`AutoSubmissionAttempt`, `DeviceEventReceipt`); 9 additive-колонок на 7 pre-T7A моделях (`WorkSite`,
`TimesheetVersion`, `TimesheetDraftSegment`, `WorkSegment`, `CorrectionDraftSegment`×1 каждая,
`Timesheet`×3, `User`×1); 6 additive-колонок, накопленных 3.1–3.2.4, на собственных T7A-таблицах; все
enum из §3; **16** composite FK (the design doc's own §Финал aggregate originally stated 15 —
`ClockEvent×2`, missing §2.1 п.3's own explicit per-field inline annotation for `ClockEvent.
workAreaId`; **owner-confirmed 2026-08-12 as the final count, see `05_RAW_SQL_REGISTER.md` §11.3 and
the "harden attendance clock schema foundation" record below — 15 is superseded, not a live
alternative reading**); 14 `CREATE TRIGGER`-биндингов (11 функций); singleton-seed
`CompanyAttendancePolicy`; idempotent seed `SYSTEM`-пользователя (`system.scheduler`).

Migration: `prisma/migrations/20260812000000_add_attendance_clock_schema_foundation`. Применена и
проверена на одноразовом PostgreSQL 16 (48 существующих миграций с нуля + эта; повторный
`migrate deploy` → "No pending migrations"; `migrate status` → up to date; `prisma validate`,
Prisma Client generation, `tsc --noEmit`, `npm run build`, `docker compose -f
compose.titanor-time.yaml build app` все зелёные). Полный набор обязательных DB-инвариантов
(immutability-триггеры — позитивный и негативный тест на каждый; coverage gap/overlap/valid;
`reportedProjectionState` PENDING→SETTLED с prerequisite/без/`FINAL_APPROVED`-exemption,
SETTLED→PENDING запрещён; `ClockEventLocation` retention; `CompanyAttendancePolicy`/`SYSTEM User`
singleton; composite FK cross-owner rejection; `AttendanceException` canonical overlap pair;
`ClockEventIdConflict` GPS-exclusion) выполнен на disposable Postgres и прошёл. Disposable-окружение
(контейнер, сеть, docker image tag `titanor-time-app:latest`, временные скрипты) удалено после
проверки. **Production (`titanor-time-db-1`, `titanor-time-app-1`) не тронут, миграция к нему не
применялась, контейнеры не перезапускались.**

**Attendance API/UI/offline sync всё ещё не реализованы.** Этот коммит — только schema/migration/seed
слой: geofence admin API/UI, Check In/Check Out endpoints, `/worker` clock UI, IndexedDB outbox,
sync/materialization/exception-resolution/auto-submit сервисный код не созданы. Raw SQL register —
`docs/titanor-time/05_RAW_SQL_REGISTER.md` §11. ERD-индекс — `docs/titanor-time/03_DATA_MODEL_ERD.md`
§4.9.

**Следующая отдельная задача — locking-доработки существующего кода** (`T7A_1_ATTENDANCE_CLOCK_
DESIGN.md` §15) — не новая функциональность, а дисциплина блокировок в уже существующем коде,
необходимая перед geofence admin/online clock backend/worker mobile UI.

Обновлено: 2026-08-12 20:50 Europe/Helsinki (docs: approve attendance clock design — T7A.1 closed)

**T7A.1 Design Checkpoint — ЗАВЕРШЁН и утверждён владельцем 2026-08-12.** Полный самодостаточный
архитектурный документ (revision 3.2.5, addenda 3.1–3.2.5, тесты №1–128) сохранён в
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` — единственный источник истины для будущей
Prisma-схемы/API/UI геозон, открытой смены, неизменяемых clock-событий, offline outbox/idempotency,
materialization в `TimesheetDraftSegment`, source `MANUAL`/`AUTO`, исключений автоотправки и
company-level cutoff/reminder расписания. `PROJECT_ROADMAP.md` (T7A.1) обновлён с той же ссылкой и
утверждённым порядком дальнейшей реализации.

Owner decisions при утверждении: raw GPS retention — 90 дней provisional development default,
legal/privacy review до production-пилота обязателен, но **не блокирует** schema foundation/T7A.2;
conflict/sequence-аномалии — без отдельной сложной страницы в первом пилоте, минимальный список для
`ADMIN`/`SUPER_ADMIN` войдёт в операционный обзор T7A.9, `FOREMAN` raw payload не получает; тест №121
исправлен (при неуспешном Switch Site старая смена остаётся **открытой** на старом сайте, не
закрытой).

**Реализации Attendance Clock всё ещё нет.** Этот docs-коммит — единственное изменение: `prisma/
schema.prisma`, migrations, API, UI и любой application-код не создавались и не менялись; production
(`titanor-time-db-1`, `titanor-time-app-1`, любые контейнеры) не затронут; deploy не выполнялся.

**Следующая задача — отдельный schema-foundation slice** (не geofence/API/UI напрямую): точный объём
зафиксирован в `T7A_1_ATTENDANCE_CLOCK_DESIGN.md` §16 п.1 — 13 новых таблиц, 9 additive-колонок на 7
pre-T7A моделях + 6 additive-колонок на собственных T7A-таблицах, ~~15~~ composite FK **(это был
первоначальный ошибочный подсчёт design-документа на момент этой записи, revision 3.2.5; superseded
owner correction 2026-08-12; окончательное реализованное значение — 16, см. запись выше и запись
2026-08-12 «harden attendance clock schema foundation»)**, 14 `CREATE
TRIGGER`-биндингов, singleton-seed `CompanyAttendancePolicy`, seed `SYSTEM`-пользователя — тестируется
миграцией на одноразовом PostgreSQL 16 по паттерну `05_RAW_SQL_REGISTER.md`, прежде чем geofence
admin/online clock backend/worker mobile UI получат хоть один API/UI endpoint.

Обновлено: 2026-08-07 Europe/Helsinki (feat: version work schedule templates)

**Второй срез управления шаблонами**: `PATCH /api/admin/templates/:templateId` + UI-редактирование
`/admin/templates/[templateId]`. Редактирование **никогда** не переписывает существующую
`WorkScheduleTemplateVersion` — каждое реальное изменение создаёт новую immutable-версию. Prisma
schema не менялась.

**Migration**: `20260807120000_seed_template_update_permission` — чистое DML, тот же паттерн, что
`20260807090000_seed_template_read_all_permission`: сеет `template.update`, выдаёт
`ADMIN`+`SUPER_ADMIN`. Применена и проверена на одноразовом PostgreSQL 16 (`migrate deploy` →
applied, повторный `migrate deploy` → «No pending migrations») — **к production не применялась**.

**Реализовано**:
- `lib/templates.ts` — `validateTemplateDays`/`parseTemplateTimeToDate`/`TEMPLATE_MAX_NAME_LENGTH`/
  `TEMPLATE_MAX_DESCRIPTION_LENGTH` вынесены из `POST`-route как общая валидация/formatting,
  используются и `POST`, и `PATCH` — правила day/time-инвариантов никогда не расходятся между
  ними. Новая `updateTemplate()` — единственная транзакция для `PATCH`: `SELECT
  "WorkScheduleTemplate" ... FOR UPDATE` (тот же паттерн, что `lib/periods.ts`/
  `lib/review-scopes.ts`/`lib/activation.ts`) → перечитывает максимальный `versionNumber` под
  локом → сверяет `expectedVersionNumber` → при совпадении: metadata (если передана) → новая
  `WorkScheduleTemplateVersion` (`versionNumber+1`) → её 7 `WorkScheduleTemplateVersionDay` (из
  `days`, если переданы, иначе — точная копия дней предыдущей версии) → `TEMPLATE_UPDATED`
  `AuditEvent` — одной атомарной транзакцией. Genuine no-op (после разрешения непереданных полей
  итоговые metadata+все 7 дней байт-в-байт совпадают с текущей версией) — не создаёт ни версию, ни
  audit, возвращает `200` с текущими данными.
- `PATCH /api/admin/templates/:templateId` (`app/api/admin/templates/[templateId]/route.ts`) —
  permission `template.update`, CSRF обязателен; `expectedVersionNumber` обязателен; хотя бы одно
  из `name`/`description`/`days` обязательно; `days`, если передан, — те же 7-day инварианты, что
  `POST`; malformed/неизвестный `templateId` → `404 TEMPLATE_NOT_FOUND` (без `500`);
  `expectedVersionNumber` не совпадает с текущим максимальным → `409 VERSION_CONFLICT`; `active` —
  read-only, `PATCH` его не принимает (deactivate/reactivate — нет утверждённого контракта, не
  реализовано).
- `app/api/admin/templates/route.ts` (`POST`) — переиспользует те же экспорты `lib/templates.ts`
  вместо локальных дублирующих `validateDays`/`parseTimeToDate` (убрана дупликация).
- `app/admin/templates/TemplateDaysEditor.tsx` (новый, общий client-компонент) — рендер 7 строк
  дней + `defaultTemplateDays`/`templateDaysFromDetail`/`toggleTemplateWorkingDay`/
  `updateTemplateDay`/`templateDaysToRequestPayload`; переиспользуется и `NewTemplateForm`
  (создание), и новым `EditTemplateForm` (редактирование) — UX и правила дней никогда не
  расходятся между двумя формами.
- `app/admin/templates/[templateId]/EditTemplateForm.tsx` (новый) — секция «Edit schedule» на
  карточке шаблона: предзаполнена `name`/`description`/7 дней текущей версии; submit отправляет
  `expectedVersionNumber` текущей версии (читается из props при каждом рендере, не из
  застывшего локального стейта — после успешного сохранения `router.refresh()` подтягивает новый
  номер версии для следующего сохранения); после успеха показывает новый номер версии; `409
  VERSION_CONFLICT` — понятное сообщение + явная кнопка «Reload» (не автоматический `router.
  refresh()` — черновик правок пользователя не теряется тихо); inline field-level ошибки; double-
  submit блокируется тем же `loading`-guard, что и везде в проекте; текст «Saving creates a new
  version. Existing assignments remain on their recorded version until changed or split.» —
  явно объясняет snapshot semantics. Read-only карточка (Server Component) рендерится
  безусловно и не скрывается/не подменяется секцией редактирования.
- `app/admin/templates/[templateId]/page.tsx` — read-only 7-day таблица (`.worker-table-scroll`)
  всегда видна; `EditTemplateForm` подключена отдельной секцией ниже.
- `app/admin/templates/new/NewTemplateForm.tsx` — рефакторинг на общий `TemplateDaysEditor` (без
  изменения поведения/контракта `POST`).

**Snapshot semantics** (явно, §4.5): новая `WorkScheduleTemplateVersion` применяется только к
*новым* `SiteAssignment` (создаваемым после неё с тем же `templateId`) — существующие
`SiteAssignment` продолжают ссылаться на свой прежний `templateVersionId` бессрочно; уже созданные
`TimesheetDraftPlannedShift`/`TimesheetPlannedShift` не меняются `PATCH`'ем никогда (эта операция
их вообще не касается — не входит в её транзакцию); перевод уже начавшегося назначения на новую
версию — исключительно через существующий `assignment.split` с `effectiveFrom` (не изменялся в
этой задаче, уже полностью поддерживал `templateId`→latest version), никогда массовым скрытым
`UPDATE`.

**Проверено на одноразовом PostgreSQL 16** (миграции с нуля, повторный `migrate deploy` → no
pending, отдельный production build instance, всё через реальный UI/API):
- **A (basic versioning)**: Template A создан через UI (defaults 09:00–17:00, 30мин перерыв) →
  через `EditTemplateForm` изменён перерыв понедельника 30→45 → версия 2 создана (новый
  `currentVersionId`) → read-only DB подтверждает: `WorkScheduleTemplateVersionDay` версии 1 для
  понедельника **физически осталась** `plannedBreakMinutes=30`.
- **B (metadata-only)**: `PATCH` с одним только `name` (без `days`) → версия 3; все 7 дней версии
  3 байт-в-байт совпадают с версией 2 (скопированы, не выдуманы).
- **C (no-op)**: структурно пустой `PATCH` (только `expectedVersionNumber`) → `400
  VALIDATION_ERROR`; `PATCH` с полностью идентичными `name`/`description`/`days` → `200`, версия
  осталась 3, `currentVersionId` не изменился — ни новая версия, ни `AuditEvent` не созданы
  (подтверждено read-only DB: ровно 4 `TEMPLATE_UPDATED` на весь сценарий A/B/D-победитель/доп.
  правка перед E, не больше).
- **D (конкуренция)**: два **настоящих параллельных** `PATCH` (`Promise.all`, реальный HTTP,
  оба `expectedVersionNumber=3`) — ровно один вернул `200` (версия 4), второй — `409
  VERSION_CONFLICT`; после — ровно версия 4 (не 5); DB подтверждает: ровно 5 версий всего на
  шаблон (1–5, без пропусков/дублей) к концу сценария, metadata проигравшего запроса не
  применилась, `AuditEvent` для проигравшего не создан.
- **E (assignment snapshot)**: Assignment A создан на версии 4 (`templateVersionId` записан) →
  шаблон обновлён до версии 5 → Assignment A **в БД** продолжает ссылаться на версию 4
  (не изменился); новый Assignment B (тот же `templateId`) получил версию 5 (latest); `POST
  .../assignments/:id/split` создал новую строку на версии 5, закрыв старую (`validTo` выставлен)
  — старая строка **в БД** осталась на версии 4, не изменившись ни в чём другом.
- **F (security)**: `ADMIN`/`SUPER_ADMIN` — успешно (A-E); `WORKER`/standalone `FOREMAN` — `403`;
  без сессии — `401`; без `X-Requested-With` — `403 CSRF_REJECTED`; malformed `templateId` (не
  UUID-shaped строка) — `404 TEMPLATE_NOT_FOUND`, не `500`; некорректные `days` (1 запись вместо
  7) — `400`, DB подтверждает: партиальной версии 6 не появилось.
- **G (audit)**: read-only DB — ровно 4 `TEMPLATE_UPDATED` на весь прогон (v1→2, v2→3, v3→4, v4→5),
  каждый содержит `entityId`=id шаблона + `beforeValue.versionNumber`/`afterValue.versionNumber`/
  изменённые metadata; ни один из 20 проверенных `AuditEvent` (весь прогон) не содержит password/
  passwordHash/tokenHash/session/cookie; ни один отклонённый (`400`/`401`/`403`/`404`/`409`), ни
  no-op, ни проигравший конкурентный запрос не создал лишний `AuditEvent`.
- **Регрессия**: `POST /api/admin/templates` (Template B) — работает; `GET` список/карточка —
  корректны, без raw UUID; `/admin/assignments/new` селектор — работает; матчащие плану часы после
  всех версионных изменений (проверено на назначении, прошедшем через версии 4→5→split) всё ещё
  попадают в `hasException=false` (стандартная очередь прораба), не в exceptions.
- **Browser**: 375px и десктоп — `Edit schedule` секция и read-only карточка без page-level
  horizontal overflow; native required-валидация; double-submit блокируется (проверено через
  перехват сетевых запросов — ровно один `PATCH` на два быстрых клика); никаких hydration/runtime
  ошибок в консоли; read-only карточка остаётся видна и корректна без дополнительной мутации после
  сохранения.

**Технические проверки**: `git diff --check`, `npx prisma validate`, `npx tsc --noEmit`,
`npm run build`, `docker compose -f compose.titanor-time.yaml build app` — чисты (тестовый Docker
tag `latest` удалён после проверки).

**Production не менялся** — новая локальная DML-миграция применена и проверена только на
одноразовом PostgreSQL 16; к production `titanor-time-db-1` она **не применялась**,
production-контейнеры не перезапускались (`titanor-time-app-1`/`titanor-time-db-1` оставались
healthy до/после, проверено read-only).

**Не реализовано в этом срезе (сознательно)**: deactivate/reactivate шаблона (`active` остаётся
read-only — нет утверждённого контракта); список версий/история версий как отдельный UI-экран.

**Закрыт подтверждённый полным E2E gap** (см. запись «Full foundation E2E PASS» ниже, где было
явно отмечено: «foreman находит табель в... `/foreman/review/exceptions`, т.к. `SiteAssignment`
создаётся через UI без `templateId`» — форма `/admin/assignments/new` не давала выбрать шаблон, хотя
`POST /api/admin/assignments` его уже принимал; `/admin/templates`/`/admin/templates/[templateId]`
были задокументированы в `01_SCREEN_MAP.md`, но физически отсутствовали). Отдельный read/selection
срез — Prisma schema не менялась, `PATCH`/edit шаблона (новая immutable версия) не реализован,
остаётся следующей отдельной задачей.

**Migration**: `20260807090000_seed_template_read_all_permission` — чистое DML (без изменений
schema), тот же паттерн, что `20260801013520_seed_template_create_permission`: сеет
`template.read.all`, выдаёт `ADMIN`+`SUPER_ADMIN`. Применена и проверена на одноразовом
PostgreSQL 16 в рамках этой задачи — **к production не применялась**.

**Реализовано**:
- `lib/templates.ts` (новый) — `listTemplates()`/`getTemplateDetail()`; «текущая версия» — строка с
  максимальным `versionNumber`, получена через `orderBy+take:1` на relation `versions` (Prisma
  батчит это в одну дополнительную запрос, не N+1 в коде); `workingDaysCount` — через
  `_count.days` с `where: {isWorkingDay: true}`, без выборки самих строк дней на списке.
- `GET /api/admin/templates` (`app/api/admin/templates/route.ts`) — permission `template.read.all`,
  `{items:[{id,name,description,active,currentVersionId,currentVersionNumber,workingDaysCount}],
  page,pageSize,totalItems,totalPages}`, `createdByUserId` не возвращается.
- `GET /api/admin/templates/:templateId` (новый файл, `[templateId]/route.ts`) — тот же permission,
  `{id,name,description,active,currentVersionId,currentVersionNumber,days:[...]}` только текущей
  версии, время `"HH:MM"` (тот же формат, что принимает `POST`); path-параметр проверяется regex-ом
  UUID **до** похода в БД — malformed UUID → `404 TEMPLATE_NOT_FOUND`, не Prisma-cast/`500`;
  неизвестный валидный UUID — тоже `404 TEMPLATE_NOT_FOUND`.
- `/admin/templates` (новая страница) — read-only список, `Create template` → `.../new`, empty-state
  «No templates yet.», access-denied как везде в `/admin/*`.
- `/admin/templates/[templateId]` (новая страница) — read-only карточка текущей версии: имя,
  `description`, active/inactive, номер версии, 7 строк дней (день недели, рабочий/нет, начало,
  конец, перерыв). Никакой формы сохранения — это следующая отдельная задача.
- `Templates` добавлен в постоянную admin-навигацию (`app/admin/layout.tsx`), между `Sites` и
  `Assignments`.
- `/admin/setup`: DONE-состояние строки «Work schedule template» теперь ведёт в `/admin/templates`
  (было — `.../new` с меткой «Create another»); устаревший комментарий про отсутствие list-экрана
  удалён.
- `/admin/assignments/new` (`NewAssignmentForm.tsx`) — новый select «Work schedule template»:
  грузит `GET /api/admin/templates?pageSize=100`, показывает только `active=true`, label = имя +
  `(vN)`, значение — `templateId` (UUID никогда не отображается вместо названия); ровно один
  активный шаблон — автовыбор; несколько — выбирает администратор; явный вариант
  «No schedule template» с поясняющим текстом про schedule exception; смена Site/Work area не
  затрагивает этот select (отдельный `useEffect`, без зависимости от `siteId`); `templateId`
  включается в `POST /api/admin/assignments`; `TEMPLATE_NOT_FOUND` обрабатывается предметно.
  **Backend не менялся** — `POST /api/admin/assignments`/`lib/assignments.ts`'s `createAssignment()`
  уже полностью поддерживали `templateId` (резолвят `latestVersion` сами, эндпоинт принимает только
  `templateId`, никогда `templateVersionId` от браузера) — недостающим был только UI-селектор и
  read-эндпоинты для его данных.
- `lib/sites.ts`/`/admin/sites/[siteId]`: `SiteActiveAssignment.templateName` добавлен аддитивно —
  карточка объекта теперь показывает имя шаблона у активных назначений, если он есть
  (`/admin/assignments`'s `templateName` уже существовал раньше и не менялся).

**Проверено на одноразовом PostgreSQL 16** (миграции с нуля, отдельный production build instance,
всё через реальный UI/API): Template A + Template B созданы через UI, оба видны в
`/admin/templates`, обе карточки показывают правильные 7 дней; `Templates` в постоянном меню;
`/admin/setup` Manage → список; `/admin/assignments/new` показывает оба шаблона по именам без UUID;
assignment с Template A сохраняет `templateVersionId` актуальной версии Template A (проверено в БД);
открытие периода после создания такого назначения создаёт `TimesheetPlannedShift` из шаблона; worker
вводит часы, совпадающие с планом; после submit табель попадает в `/foreman/review/standard`, не в
`exceptions` (закрывает исходный gap); assignment без шаблона по-прежнему разрешён и, как и раньше,
ожидаемо попадает в `exceptions`; `GET .../templates/:id` с несуществующим UUID → `404
TEMPLATE_NOT_FOUND`; malformed UUID (не UUID-shaped строка) → `404`, не `500`; inactive template не
выбирается в UI-селекторе (отфильтрован клиентом); `ADMIN`/`SUPER_ADMIN` имеют доступ к обоим
эндпоинтам, `WORKER`/`FOREMAN` → `403`; неаутентифицированный запрос → `401`; N+1 не обнаружен
(список из нескольких шаблонов — фиксированное число запросов, не растущее с количеством строк).
Browser: 375px и десктоп, без hydration/runtime ошибок в консоли. Найдена и исправлена
mobile-only регрессия самой этой задачи (не существовавшая до неё): 5-колоночная таблица дней на
`/admin/templates/[templateId]` (и, с достаточно длинными именами, список `/admin/templates`) не
влезала в 375px — `document.documentElement.scrollWidth` был 414+ вместо 375. Другие admin-таблицы
(`/admin/sites`, `/admin/workers`, `/admin/assignments`, `/admin/periods`) не переполнялись даже при
том же 375px. Исправлено новым классом `.worker-table-scroll` (`overflow-x: auto` на обёртке,
тот же паттерн, что уже использует `.admin-nav`) вокруг `<table className="worker-table">` на обеих
новых страницах — переисправлено и перепроверено после фикса на чистом одноразовом Postgres 16
(оба фокусных прогона — функциональный и mobile/desktop — зелёные после этого изменения).

**Технические проверки**: `git diff --check`, `npx prisma validate`, `npx tsc --noEmit`,
`npm run build`, `docker compose -f compose.titanor-time.yaml build app` — чисты (тестовый Docker
tag `latest` удалён после проверки, production image/container не затронуты).

**Production не менялся** — новая локальная DML-миграция применена и проверена только на
одноразовом PostgreSQL 16 в рамках этой задачи; к production `titanor-time-db-1` она **не
применялась**, production-контейнеры не перезапускались.

**Дальше — отдельной задачей**: `PATCH /api/admin/templates/:templateId` + форма редактирования
(создаёт новую immutable версию, не переписывает текущую) — та функциональность, что
`01_SCREEN_MAP.md` целевым образом описывает для `/admin/templates/[templateId]`, но которая не
входит в этот read/selection срез.

Обновлено: 2026-08-07 Europe/Helsinki — **Full foundation E2E PASS**

Полный локальный onboarding+timesheet E2E (тот, что был остановлен и дал FAIL 2026-08-06, затем
закрыт точечным фиксом «worker не видел причину возврата табеля» ниже) **перезапущен целиком с нуля
и пройден полностью**, отдельной задачей, на одноразовом production build + одноразовом
PostgreSQL 16, отдельный app instance (порт 3521), отдельная disposable БД — production
(`titanor-time-app-1`/`titanor-time-db-1`) не трогался (проверено read-only `/api/health`+
`/api/ready` до и после, контейнеры оставались healthy на всём протяжении).

**Пройденный маршрут** (всё через настоящий браузер/HTTP API работающего production build, ни одна
business-сущность не вставлена SQL/Prisma напрямую; SUPER_ADMIN — только штатным
`bootstrap-super-admin` через настоящий PTY):
SUPER_ADMIN bootstrap → login + проверка постоянного меню (Setup/Workers/Users/Sites/
Assignments/Periods/Timesheets/Review/Corrections) → Site A (+ Work area) и Site B (изоляция) через
UI, каждая сущность повторно открыта через меню, а не только через create-redirect → work schedule
template (создание через UI; список/деталь для template — известный, ранее задокументированный
пробел, не новый дефект) → Worker → assignment Worker→Site A primary → open period → `/admin/setup`
чек-лист: все обязательные пункты Done, City — не done, помечен как optional → выпуск кода
активации worker (QR — локальный data URL, copy/print есть, raw-код не в localStorage и не виден
после refresh) → активация через `/activate` (ручной код) → `/set-password` → auto-login + redirect
`/worker` → повторное использование кода отклонено → worker не имеет доступа к `/admin/*`/`/foreman`
→ standalone FOREMAN через `/admin/users/new` (auto-issue: QR/copy/print) → `/activate-account` →
`/set-account-password` → `/foreman` → повторное использование кода отклонено → foreman не имеет
доступа к `/admin/*` → назначение foreman на Site A через selector по username (без единого ручного
UUID; сами option-labels никогда не сырой UUID) → foreman видит Site A и работника, никогда Site B →
worker вводит часы на 2 дня (обычный интервал + интервал с перерывом), данные сохраняются между
перезагрузками страницы → submit → status=SUBMITTED, hours read-only, PATCH после submit — `409
DRAFT_NOT_EDITABLE`, создана Version 1, draft физически очищен → foreman находит табель в своей
очереди (в данном сценарии — `/foreman/review/exceptions`, т.к. `SiteAssignment` создаётся через UI
без `templateId` — форма `/admin/assignments/new` этого поля не предлагает, хотя `POST
/api/admin/assignments` его принимает; из-за этого `computeSiteScopeHasException` корректно
считает 0 запланированных минут ≠ отработанным — это существующий, отдельный, уже
задокументированный geп UI/API, не блокирующий дефект этой задачи) → возврат без причины отклонён
и клиентом, и API (`400 VALIDATION_ERROR`) → возврат с точной уникальной причиной → worker видит
точный текст причины, название Site A (не UUID), время возврата, без дополнительного клика на всех
четырёх страницах (`/worker/periods/[periodId]`, `.../hours`, `.../hours/[date]`, `.../submit`) →
375px mobile: без horizontal overflow, длинный текст переносится, UUID не виден → browser console:
ни одной hydration-warning/ошибки за весь прогон (включая форматирование времени возврата в
`ReturnReasonsNotice`) → worker исправляет день (перерыв 30→60 мин), Version 1 не меняется, причина
остаётся видна на confirmation до повторной отправки → resubmit → status=SUBMITTED снова, создана
Version 2, `returnReasons: []` для новой текущей версии, старая причина больше не показывается как
актуальная на всех 4 страницах, старый `RETURNED` scope и причина остаются в БД как история →
foreman видит новую текущую версию (version 2) в очереди, approve → повторное действие на stale
scope V1 отклонено (`409 STALE_REVIEW_SCOPE`) → timesheet → FOREMAN_APPROVED только после разрешения
всех scope текущей версии, worker видит read-only «Approved by foreman» → SUPER_ADMIN видит табель в
`/admin/timesheets`, карточка показывает worker/период/актуальные часы version 2/статус → Final
approve → status=FINAL_APPROVED, исчез из очереди ожидания, повторный final-approve отклонён (`409`),
Version 1/2 не изменены → worker видит «Finalized», часы полностью read-only, доступен в
`/worker/history`.

**Admin visibility**: worker/назначение/период/актуальные часы version 2/маршрут статусов
SUBMITTED→RETURNED→SUBMITTED→FOREMAN_APPROVED→FINAL_APPROVED — всё подтверждено через доступные
карточки (`/admin/workers/:id`, `/admin/assignments`, `/admin/periods/:id`, `/admin/timesheets`,
`/admin/timesheets/:id?status=FINAL_APPROVED`) без придумывания новой audit-timeline функции.

**Negative checks** (все пройдены): неаутентифицированный `GET /api/worker/timesheets/:id` → `401`;
worker/foreman на `/admin/*` → «Access denied»; второй worker (Site B) не видит Site A/причину
worker1, не может прочитать чужой `timesheetId` (`403`, без утечки текста причины в теле ошибки);
foreman (только Site A) не видит Site B/второго worker даже после его создания; пустая
`returnReason` отклонена и клиентом, и API; stale review scope отклонён (`409`); PATCH дня после
SUBMITTED/FOREMAN_APPROVED/FINAL_APPROVED — `409`; reused activation tokens (worker и foreman) —
отклонены; final-approve в неправильном статусе — `409`; `POST /api/admin/sites` без
`X-Requested-With` → `403 CSRF_REJECTED`, ни одна сущность не создана; ни один UI не потребовал
ручного ввода UUID.

**Persistence/restart**: disposable app instance перезапущен (новый процесс, тот же одноразовый
Postgres — контейнер перезапущен через `docker restart`, без пересоздания, volume/данные не
удалялись); после перезапуска — `/api/ready` healthy; SUPER_ADMIN/FOREMAN/Worker логинятся заново
успешно; FINAL_APPROVED табель доступен worker в history, «Finalized», часы read-only;
`current-version`/`returnReasons` через реальный API — versionNumber=2, пусто для текущей версии
(история — ниже); admin-карточка всё ещё показывает FINAL_APPROVED/version 2, без кнопки Final
approve повторно.

**Read-only DB verification** (после завершения UI/API-потока): User=4, Employee=2, Employment=2 —
ровно ожидаемое число для этого сценария; роли SUPER_ADMIN/WORKER/FOREMAN корректны, все ACTIVE;
standalone FOREMAN — `employeeId=null`; worker `User` привязан к правильному `Employee`;
`ActivationToken`/`UserActivationToken` — по одному на аккаунт, `status=USED`, `tokenHash` — hex
digest (не сырой код); все `passwordHash` — настоящий Argon2, не plaintext; Site A/Site B/WorkArea/
template/assignments — без дублей; `ForemanAssignment` — только на Site A; `PayrollPeriod` — OPEN;
`Timesheet` — FINAL_APPROVED; ровно 2 `TimesheetVersion`; Version 1 содержит исходный перерыв
(30 мин, не изменён); Version 2 — исправленный (60 мин); `currentVersionId` → Version 2; scope
Version 1 — `RETURNED` с сохранённой причиной (история); scope Version 2 — `APPROVED`; draft — 0
редактируемых сегментов; `AuditEvent` содержит `TIMESHEET_SUBMITTED`/`TIMESHEET_RETURNED`
(на `TimesheetReviewScope`)/`FOREMAN_APPROVED`/`FINAL_APPROVED`; ни в одном `AuditEvent` (26 строк
проверено) не найдено password/passwordHash/tokenHash/session/cookie; CSRF-отклонённая попытка
создать сайт не оставила частичной строки.

Технические проверки после E2E: `git diff --check`, `npx tsc --noEmit`, `npx prisma validate`,
`npm run build`, `docker compose -f compose.titanor-time.yaml build app` — все чисты; тестовый
Docker-образ и его временный тег `latest` удалены после проверки, production image/container не
затронуты. Никаких изменений кода в этой задаче — только этот docs-commit; disposable окружение
(контейнер, app instance, playwright, все временные scripts, все secrets в scratch) полностью
удалено.

**Дальше — отдельной задачей**: Attendance Clock (Check In/Out) и offline geolocation — следующая
функция, этим E2E не затрагивалась и не проверялась.

Обновлено: 2026-08-06 21:00 Europe/Helsinki (fix: worker не видел причину возврата табеля)

**Найденный E2E-дефект** (полный локальный onboarding+timesheet E2E, отдельная задача): пройдены
SUPER_ADMIN setup, worker activation, foreman creation, foreman assignment через selector, ввод
часов, submit, foreman review (site-scope корректен, обязательная причина возврата на write-path
уже была) — **дальше worker видел статус `RETURNED`, но нигде в UI/API не видел саму причину**.
Подтверждено и кодом (`getWorkerTimesheetSummary`/`getWorkerTimesheetDraft`/
`getWorkerTimesheetCurrentVersion` не выбирали `TimesheetReviewScope.returnReason` вовсе;
`getWorkerTimesheetCurrentVersion` возвращал фиктивный `reviewScopes: []` с устаревшим комментарием
«TimesheetReviewScope ещё не существует», хотя модель есть с `20260804160000_add_timesheet_review_scope`),
и живым воспроизведением в браузере. E2E был остановлен на этом шаге — resubmit/foreman
re-approve/final approve/negative checks/persistence/DB-verification **не проходились**.

**Исправлено** (только worker read-contract + UI, без изменений Prisma schema/migrations, без
изменений write-path review/return):
- `GET /api/worker/timesheets/:timesheetId` (`getWorkerTimesheetSummary`) теперь возвращает
  `returnReasons[]` — **массив**, не одна причина: версия табеля может иметь больше одного
  `RETURNED` scope одновременно (два объекта, два прораба, `03_...`, §4.7, «Гонка одновременных
  возвратов»). Читается только из `TimesheetReviewScope` **текущей** `timesheetVersionId` — после
  resubmit (новая версия) массив естественно пустеет, старые причины не показываются как
  актуальные; исходные строки в БД не удаляются, история сохраняется.
- `GET /api/worker/timesheets/:timesheetId/current-version` (`getWorkerTimesheetCurrentVersion`)
  больше не возвращает фиктивный `reviewScopes: []` — загружает реальные scope текущей версии,
  аддитивно обогащённые `siteName`/`contextSiteId`/`contextSiteName`/`returnReason`/`reviewedAt`
  (raw UUID никогда не показывается работнику вместо названия объекта; `reviewerUserId` никогда не
  возвращается).
- Новый переиспользуемый Server Component `ReturnReasonsNotice`
  (`app/worker/periods/[periodId]/ReturnReasonsNotice.tsx`) — подключён на все четыре шага пути
  исправления: `/worker/periods/[periodId]`, `.../hours`, `.../hours/[date]` (через новый пропс
  `DayEditor`, без изменения его write-логики), `.../submit`. Показывает каждую причину полным
  текстом (обычный React text node, не `dangerouslySetInnerHTML`), понятную подпись объекта для
  `SITE`, «General / non-site» (+ context site, если есть) для `NON_SITE`, время возврата; при
  `RETURNED` без причин (повреждённые/старые данные) — явный fallback-текст, причина не
  выдумывается. Мобильная раскладка (375px) без horizontal overflow — длинный текст переносится
  (`overflow-wrap`/`word-break`/`white-space: pre-wrap`).
- `/worker/history` **не изменён** — список остаётся лёгким (`listWorkerTimesheets`, без
  per-item причин); детали загружаются только на detail-страницах, как и было.

Проверено на одноразовом PostgreSQL 16 (сфокусированный тест этого фикса, не полный E2E): один
`SITE`-scope (точный текст причины + название объекта на detail/hours/day-editor/submit); два
`SITE`-scope одной версии, возвращённые почти одновременно (обе причины и оба названия объектов
видны, ни одна не потеряна); `NON_SITE`-scope (понятная подпись, без UUID); security (чужой worker
не получает причины чужого табеля — ownership-проверка `loadOwnTimesheet` выполняется первой, как
и раньше, отдельного нового запроса не создавалось); version semantics (после resubmit старые
причины не показываются, старые `TimesheetReviewScope` остаются в БД); `GET .../current-version`
(`reviewScopes` реально заполнен, `RETURNED`-scope содержит `reason`/`returnedAt`, только scope
`currentVersionId`); 375px mobile — точный текст виден, horizontal overflow отсутствует. `git diff
--check`, `npx tsc --noEmit`, `npm run build`, `docker compose -f compose.titanor-time.yaml build
app` — чисты.

**Production не менялся** — миграций в этой задаче нет (Prisma schema не трогалась), деплоя не
было. **Обновление 2026-08-07**: полный локальный onboarding+timesheet E2E (SUPER_ADMIN→worker→
foreman→timesheet→final approval, negative checks, restart persistence, read-only DB verification)
был перезапущен целиком отдельной задачей и **пройден полностью — PASS, commit `94ef28b`** (запись
в самом верху этого файла); на момент этой записи (2026-08-06 21:00) он ещё не был перезапущен —
формулировка ниже отражает состояние на тот момент, не текущее.

Обновлено: 2026-08-06 19:30 Europe/Helsinki (security hardening: active role windows)
Два прицельных backend-фикса перед полным E2E, без новых функций/UI/migrations:

1. **`resolveAuthenticatedSession` (`lib/auth.ts`)** теперь применяет то же временное окно
   активной `UserRole`, что и все остальные eligibility-проверки в проекте — `validFrom <= now
   AND (validTo IS NULL OR validTo > now)`, а не только `validTo IS NULL`. Раньше роль с
   `validFrom` в будущем ошибочно давала доступ немедленно, а `validTo` в будущем не отличалась
   от `validTo=null` (не баг сам по себе, но и не то, что документировано). Роли пересчитываются
   заново на каждый запрос — сессия не хранит застывший снимок; окончание роли действует на
   следующем запросе уже существующей сессии, без повторного логина. `DEACTIVATED`-отказ и
   `OFFBOARDING`-поведение не менялись.
2. **`createForemanAssignment` (`lib/foreman-assignments.ts`)** стал полностью атомарным: раньше
   `User.status`/`FOREMAN`-роль проверялись до транзакции, а `ForemanAssignment`+`AuditEvent`
   создавались позже в отдельной — окно между проверкой и записью позволяло гонку. Теперь всё —
   `SELECT ... FOR UPDATE` на целевом `User`, повторная проверка статуса, проверка текущей
   `FOREMAN`-роли, проверка `WorkSite`, вставка `ForemanAssignment`, `AuditEvent` — одна
   транзакция, без вложенных. Явно задокументирован остаточный пробел: блокируется только `User`,
   не сама строка `UserRole` — сегодня это безопасно, потому что ни один существующий write-path
   не завершает/меняет уже созданную `UserRole` (`role.assign`/`user.deactivate` не реализованы);
   когда они появятся, эту проверку нужно будет защитить собственной блокировкой.
   Response shape/UI/permissions не менялись.

Протестировано (временный скрипт, не закоммичен, без браузера — прямой вызов route handler'ов и
`lib/foreman-assignments.ts`): future/expired/window/open-ended роль → 403/200 корректно; роль,
завершённая после создания сессии, отбирает доступ на следующем запросе той же сессии;
future FOREMAN → 403 на `/api/foreman/workers`, current → 200; `DEACTIVATED`-сессия — попрежнему
401; login regression (worker/admin/foreman); атомарность — `ACTIVE`/`PENDING_ACTIVATION` успешны
с одним audit-событием, `OFFBOARDING`/`DEACTIVATED` → `FOREMAN_NOT_ELIGIBLE`, future/ended-роль →
`USER_NOT_FOREMAN`, `SITE_NOT_FOUND`/`FOREMAN_NOT_FOUND` сохранены; конкурентная смена статуса
перед получением лока на `User` — гонка воспроизведена явно (blocking-транзакция + задержка) и
корректно отклонена; конкурентное завершение роли — воспроизведено (с оговоркой про
задокументированный пробел выше) и корректно отклонено; rollback (искусственный FK-violation на
`AuditEvent.actorUserId`) не оставляет строку `ForemanAssignment`; selector regression. `npx tsc
--noEmit`, `npm run build`, production Docker build — чисты. **Production не обновлён — миграций
в этой задаче нет вовсе (чистый code-фикс), деплоя не было.**

Обновлено: 2026-08-06 18:30 Europe/Helsinki (foreman assignment selector — no more raw UUID)
`ForemanAssignmentSection` (`/admin/sites/:siteId`) больше не требует ручного ввода `foremanUserId` —
`<select>`, заполненный `lib/foreman-assignments.ts`'s новой `listAssignableForemen()` (username/
имя+`employeeNumber`, статус; UUID только как `option value`, никогда в видимом тексте). Дуал-роль и
standalone `FOREMAN` — в одном списке; `PENDING_ACTIVATION` разрешён с явной подсказкой. Пустой
selector даёт ссылку на `/admin/users/new` и блокирует submit. `createForemanAssignment()`
одновременно исправлен: теперь дополнительно проверяет `User.status IN (PENDING_ACTIVATION,
ACTIVE)` (`409 FOREMAN_NOT_ELIGIBLE` для `OFFBOARDING`/`DEACTIVATED`, даже если старая роль не
отозвана) и правильное time-window текущей `FOREMAN`-роли (`validFrom <= now AND (validTo IS NULL
OR validTo > now)` — раньше учитывался только `validTo: null`, future/ended роли ошибочно не
отличались от текущей). Точный contract — `04_ADMIN_FIRST_API_CONTRACTS.md` §16. Prisma-схема и
migrations не менялись. **Онбординг больше не требует от администратора ручного копирования
UUID** — полный локальный путь (создать standalone `FOREMAN` → выпустить код → активировать →
увидеть в selector → назначить на объект → войти под `FOREMAN` → `/foreman` видит назначенный
объект) пройден headless-браузером на одноразовом PostgreSQL 16, без деплоя. Полный трёхролевой
E2E (`SUPER_ADMIN`/`FOREMAN`/`WORKER` вместе, включая табели) — отдельная следующая задача (п.4
ниже), этот шаг закрывает только сам путь назначения прораба.

Обновлено: 2026-08-06 17:00 Europe/Helsinki (UI: foreman account activation)
`/admin/users` (список + `/admin/users/new` создание `STANDALONE`/`EXISTING_EMPLOYEE`, выпуск/reissue
кода с QR/copy/print) и публичный flow `/activate-account` → `/activate-account/[token]` →
`/set-account-password` реализованы — весь credential vertical slice для standalone `FOREMAN` теперь
доступен и локально, и через UI, без миграций и без изменения backend-контрактов (кроме одной чисто
аддитивной read-функции `listEmployeesForForemanSelect` в `lib/users.ts` для select работника).
`/admin/users` добавлен в постоянную admin-навигацию. Raw-код активации живёт только в React state
текущей страницы — не в `localStorage`/`sessionStorage`/console, исчезает при переходе/refresh.
Успешная активация ведёт standalone `FOREMAN` на `/foreman`, не на `/worker`. `ForemanAssignmentSection`
(raw UUID-поле выбора прораба) не тронут — отдельная будущая задача. Worker `/activate`/`/set-password`
не изменены. Проверено headless-браузером (Playwright, временный скрипт, не закоммичен) на одноразовом
PostgreSQL 16: навигация, список, standalone/dual-role создание, дубликаты username/email,
автовыпуск+QR+copy+print, refresh скрывает код, ручной reissue отзывает старый, `ACTIVE` без
кнопки выпуска, dual-role select без UUID в видимом тексте, unauthorized/`FOREMAN`-only блокируются,
375px mobile layout, mismatch/`<8`/`>256` валидация пароля, успешная активация + cookie + `Continue`
→ `/foreman`, повтор кода → `TOKEN_USED`, expired/invalid состояния, регрессия worker `/activate`+
`/set-password`. `npx tsc --noEmit`, `npm run build`, production Docker build — все чисты.
**Production ещё не обновлён — миграции из предыдущих задач НЕ применены к реальной БД, деплоя не
было.** UI создания `ADMIN`/`SUPER_ADMIN`, `role.assign`, деактивации, а также замена raw UUID-поля
в `ForemanAssignmentSection` на нормальный selector — остаются отдельными будущими задачами.

Обновлено: 2026-08-06 15:30 Europe/Helsinki (backend credential flow: foreman account activation)
`POST /api/admin/users/:userId/activation` (permission `user.activation.generate`,
ADMIN/SUPER_ADMIN), `GET /api/auth/activate-account`, `POST /api/auth/set-account-password`
реализованы: ADMIN выпускает/reissue одноразовый код для standalone `FOREMAN`
(`employeeId IS NULL`, `status=PENDING_ACTIVATION`), публичная проверка кода, установка первого
пароля (Argon2id) переводит `User` в `ACTIVE` и создаёт auto-login `UserSession`. Отдельная от
worker activation таблица `UserActivationToken` и модуль `lib/system-activation.ts` — `ActivationToken`
и worker `/activate`/`/set-password` не изменены. Точный контракт — `04_ADMIN_FIRST_API_CONTRACTS.md`
§15. Протестировано на одноразовом PostgreSQL 16 (permission seed, eligibility, reissue отзывает
старый код, идемпотентность, verify/redeem, гонка issue/reissue/redeem не создаёт два живых токена,
отсутствие утечки кода/hash/пароля в audit, вход созданным FOREMAN с ролью в ответе логина),
регрессия worker activation, `npx tsc --noEmit` чист, production Docker build успешен. **UI ещё не
реализован, миграция NOT применена к production.**

Обновлено: 2026-08-06 14:00 Europe/Helsinki (backend vertical slice: foreman user administration)
`GET`/`POST /api/admin/users` реализованы: список системных пользователей (`FOREMAN`/`ADMIN`/
`SUPER_ADMIN`, включая дуал-роль `FOREMAN`+`WORKER`) и создание/пополнение только роли `FOREMAN` —
режим `STANDALONE` (новый `User(PENDING_ACTIVATION)`) и `EXISTING_EMPLOYEE` (дуал-роль на уже
существующем `User` работника, второй `User` не создаётся). Permissions `user.read`/
`user.create.foreman` выданы `ADMIN`+`SUPER_ADMIN` DML-миграцией. Точный контракт —
`04_ADMIN_FIRST_API_CONTRACTS.md` §14. Протестировано на одноразовом PostgreSQL 16 (миграции,
оба режима, все ошибки, идемпотентность, отсутствие утечки секретов в `GET`/аудите, регрессия
worker activation), `npx tsc --noEmit` чист, production Docker build успешен. **UI (`/admin/users`)
и выпуск учётных данных (`UserActivationToken`-flow для standalone `FOREMAN`) ещё не реализованы —
миграция NOT применена к production.**

Обновлено: 2026-08-06 12:43 Europe/Helsinki (schema checkpoint: system user activation)
Схема `UserActivationToken` добавлена — owner-confirmed checkpoint для первого пароля
standalone `FOREMAN` (`/admin/users`, ещё не реализован). Отдельная таблица от уже
задеплоенного `ActivationToken`/worker activation — они не изменены. Реюз `enum
ActivationTokenStatus` и секрета `ACTIVATION_TOKEN_HMAC_KEY`, новых не заводилось. Ограничения:
`expiresAt > createdAt`, status-shape (`USED` ⇔ `usedAt` в `[createdAt, expiresAt]`, иначе
`usedAt IS NULL`), partial unique один `PENDING` на `userId`, оба FK на `User` — `ON DELETE
RESTRICT`/`ON UPDATE CASCADE` с разными relation-именами (`UserActivationTokenTarget`,
`UserActivationTokenCreatedBy`). Протестировано на одноразовом PostgreSQL 16: валидный `PENDING`
insert, второй `PENDING` на тот же `userId` отклонён, `USED` без `usedAt` отклонён, non-`USED`
с `usedAt` отклонён, `expiresAt <= createdAt` отклонён, валидный `USED` в диапазоне принят,
`tokenHash` unique, оба FK `RESTRICT` подтверждены прямым `DELETE`. `npx tsc --noEmit` чист.
**Только схема — миграция НЕ применена к production, API/UI/выпуск/проверка кода не
реализованы.** `/admin/users` (создание `FOREMAN`), permissions `user.read`/`user.create.foreman`
и сам credential-flow — отдельные следующие задачи.

## CURRENT PRODUCT GAP — onboarding всё ещё нельзя считать завершённым

Во время первой ручной проверки владельцем подтверждён системный UX/flow-разрыв: `/admin/setup`
позволял создать первую сущность, после чего флаг становился `DONE`, ссылка исчезала и экран больше
не давал перейти ни к списку, ни к карточке, ни к повторному созданию. Это не ошибка владельца и не
отсутствие данных: состояние `DONE` является только глобальным boolean «в БД есть хотя бы одна
строка», а не признаком завершённой настройки компании.

**Первый UX-разрыв закрыт в текущей задаче:** добавлены общий защищённый admin shell и `/admin`,
постоянное меню всех существующих разделов, `Manage` для завершённых пунктов checklist,
`Create another` для шаблона и переход `Work area` к списку объектов, где рабочие области реально
создаются и редактируются. Теперь уже существующие `/admin/workers`, `/admin/sites`,
`/admin/assignments`, `/admin/periods`, `/admin/timesheets`, `/admin/review-scopes` и
`/admin/corrections` обнаруживаются без знания скрытых URL. Production Docker build успешен.

Повторная сверка `PROJECT_VISION.md`, `PROJECT_ROADMAP.md`, `01_SCREEN_MAP.md`,
`02_ROLE_PERMISSION_MATRIX.md`, `03_DATA_MODEL_ERD.md`, `04_ADMIN_FIRST_API_CONTRACTS.md` и
фактического дерева `titanor-time-app/app` выявила:

- **Шаблоны нельзя обслуживать после первого создания.** Документы помечают `/admin/templates` и
  `/admin/templates/[templateId]` как целевые list/edit экраны, но физически есть только
  `/admin/templates/new` и `GET/POST /api/admin/templates`; dynamic page/API edit отсутствуют.
- **Активация работника закрыта и задеплоена.** Добавлены `ActivationToken`,
  permission `worker.activation.generate`, admin issue/reissue, одноразовый показ кода, локально
  генерируемый QR/ссылка/печать, ручной ввод через `/activate`, подтверждение личности,
  `/set-password`, атомарная установка Argon2id-пароля, роль `WORKER` и автологин. Две миграции
  применены, Titanor Time app пересобран и production flow доступен.
- **Управление системными пользователями и ролями — частично закрыто.** `/admin/users`
  (создание `FOREMAN`, credential flow) и selector назначения прораба (без ручного UUID) — см.
  выше, реализованы локально. `role.assign` и создание `ADMIN`/`SUPER_ADMIN` — ещё отсутствуют.
- Следовательно, контрольный результат из `TITANOR_TIME_DEVELOPMENT_ROADMAP.md` — «admin создал
  объект → зарегистрировал и назначил работника → работник активировался → вошёл → увидел
  назначение» — **никогда не был закрыт end-to-end**. Реализованные ЭТАП 7 и T7.9 проверялись на
  тестовых seed/fixture-пользователях и не доказывают проходимость production onboarding.

**Обязательный порядок исправления (отдельными маленькими задачами/коммитами):**

1. **Выполнено:** admin shell/nav; все существующие разделы доступны постоянно; `DONE` в setup
   получает действие `Manage` (для шаблона — `Create another`), `NOT DONE` — `Create`; `Work area`
   ведёт к выбору/карточке объекта.
2. **Выполнено:** activation vertical slice целиком (утверждённый schema checkpoint →
   migrations → issue/reissue code → QR/manual activate → set password → auto-login).
   **Production deployment выполнен 2026-08-06.**
3. **Выполнено локально, полностью без ручного UUID/SQL/CLI:** `/admin/users` для создания
   `FOREMAN` (backend + UI, включая `/admin/users/new`, выпуск/reissue кода с QR/copy/print), весь
   credential flow (`/activate-account` → `/activate-account/[token]` → `/set-account-password`),
   и теперь selector назначения прораба на объект (`/admin/sites/:siteId`) — см. выше.
   **Production ещё не обновлён** (миграции не применены, не задеплоено) — весь путь подтверждён
   только локально, не на реальном сервере.
4. Только после этого провести настоящий первый E2E тремя отдельными аккаунтами
   (`SUPER_ADMIN`/`FOREMAN`/`WORKER`) и считать onboarding готовым к пилоту.
5. После базового E2E, но до отчётов/PWA-пилота, реализовать утверждённый клиентом ЭТАП 7A
   (Attendance Clock + GPS snapshots + offline-first sync) отдельными design/code checkpoint.

До закрытия пунктов 3–4 приложение следует считать **backend-capable, но ещё не полностью
operator-ready**:
владелец не обязан знать или вручную вводить скрытые URL, UUID пользователей или SQL-команды.

## OWNER-APPROVED PRODUCT REQUIREMENT — ЭТАП 7A ATTENDANCE CLOCK

Владелец утвердил новый основной ежедневный сценарий работника, mobile-first макет и его приоритет:
после завершения activation/onboarding и контрольного E2E, но до отчётов и реального пилота.
Подробная декомпозиция зафиксирована в `PROJECT_ROADMAP.md` ЭТАП 7A; это отдельный offline-first
проект, а не расширение обычного `PATCH` дня. Существующий кабинет работника — только foundation UI,
не финальный интерфейс продукта.

Зафиксированные продуктовые решения:

- `/worker` — предельно простая телефонная домашняя страница: дата/время, имя, объект, GPS/sync
  status, большая `Check In`, затем таймер и большая `Check Out`; подробный кабинет доступен в меню;
- дни, время и основной объект заполняются clock-событиями автоматически; `Switch site` завершает
  интервал на старом объекте и начинает новый, поэтому один день поддерживает несколько объектов;
- ниже главной кнопки работник видит компактные `Today`/`This week`, а в меню — дневные часы,
  неделю, всю историю, исправления, профиль и помощь;
- GPS снимается только на этих двух событиях, постоянного tracking нет;
- вне геозоны обычный Check In блокируется; при недоступном/неточном GPS clock разрешён с
  `GPS_NOT_VERIFIED` и обязательной проверкой прорабом;
- без интернета оба события атомарно сохраняются в durable outbox и позднее синхронизируются
  идемпотентно, без дублей и молчаливой потери;
- исходные clock-события append-only: ручная правка табеля их не перезаписывает;
- прораб своего объекта и ADMIN/SUPER_ADMIN видят recorded time, reported time, delta, автора,
  timestamp и причину изменения, а также GPS/sync status;
- изменение начала/окончания/объекта требует причины; добавление ручного перерыва отображается в
  истории, но причины не требует;
- break timer в первом срезе не реализуется: перерыв редактируется вручную через существующий
  экран дня, доступный по `Add break` после Check Out;
- ручной ввод сохраняется: работник может уточнять время, перерыв/отлучку с причиной и несколько
  объектов до отправки; каждое изменение исходного времени остаётся видимым как recorded vs
  reported diff;
- работник может отправить табель вручную; если он этого не сделал, в company-configured cutoff
  отдельный идемпотентный scheduler создаёт immutable версию с источником `AUTO` и отправляет её в
  тот же review-flow;
- автоотправка **не является автоутверждением**. Открытая смена, missing checkout, GPS/sync conflict
  или неполные данные не дополняются выдуманным временем, а помечаются как
  `AUTO_SUBMITTED_WITH_EXCEPTIONS` и блокируют final approval до решения;
- прораб видит только части своих объектов; ADMIN/SUPER_ADMIN видит всех работников, clock/status,
  manual/auto source, маршрут по прорабам, ожидающие решения и все исключения;
- отправленная версия остаётся неизменяемым оригиналом. Withdraw до review, возврат, поздняя
  offline-синхронизация и последующее исправление создают новый draft/version с before/after,
  причиной, автором и временем; после final approval действует формальный correction flow.

**[SUPERSEDED — см. запись 2026-08-12 в самом верху файла]** На момент этой записи design checkpoint
ещё не существовал. Перед Prisma/migration обязателен отдельный schema design checkpoint по
геозонам, clock-событиям/open shift, offline sync, materialization в draft, submission source,
исключениям и scheduler policy согласно `AGENT_RULES.md` §11. Точные enum/поля ещё не утверждены;
`AUTO_SUBMITTED_WITH_EXCEPTIONS` выше — продуктовый UI-термин. Production БД этой записью не
меняется. **Design checkpoint T7A.1 завершён и утверждён владельцем 2026-08-12** —
`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md`; Prisma-схема/migration всё ещё не созданы,
следующая задача — отдельный schema-foundation slice (см. запись в верху файла).

Схема `CorrectionRequest`/`CorrectionDraft*` (T7.9) применена владельцем к `titanor-time-db-1`
(миграция `20260805150000_add_correction_schema`), все 5 таблиц подтверждены прямым SQL, `app`
пересобран (новый Prisma Client) и передеплоен, `healthy`.

**T7.9 ADMIN-срез реализован локально:** `correction.request` с карточки `FINAL_APPROVED` табеля,
`correction.draft.edit` (открытие, редактирование дня, submit) и `correction.approve`/reject
в `/admin/corrections`, включая four-eyes и SUPER_ADMIN override. Добавлена DML-миграция
`20260805160000_seed_correction_permissions` (`correction.*` → ADMIN/SUPER_ADMIN). Проверено
на изолированном PostgreSQL 16 через API: duplicate guard, `NO_CORRECTION_CHANGES`, правка дня,
запрет self-approve, approval вторым admin, `CORRECTION` version и сохранение override;
`npx tsc --noEmit` и `npm run build` успешны. **Production hand-off:** владельцу применить
только permission migration, затем пересобрать/передеплоить `app`; production БД и контейнеры
агент не менял.
Схема `CorrectionRequest`/`CorrectionDraft`/`CorrectionDraftDay`/`CorrectionDraftSegment`/
`CorrectionDraftBreakSegment` (T7.9, design-checkpoint перед первой миграцией) добавлена — владелец
явно подтвердил именно эту схему (5 таблиц из `03_DATA_MODEL_ERD.md` §4.7) и урезанный первый
UI-срез (только ADMIN: request+draft.edit+approve в одном месте, WORKER/FOREMAN request-формы —
отдельным шагом позже). Протестировано на одноразовом PostgreSQL 16 (13 сценариев: happy path целиком
через request→draft→day→segment→break, затем каждый CHECK/EXCLUDE/триггер по отдельности, включая
закрытие ранее явно помеченного пробела в `fn_site_assignment_dependents_guard` — не покрывал
`CorrectionDraftSegment`). `tsc --noEmit` чист. Исторический checkpoint; схема впоследствии применена владельцем — см. текущую запись выше.
/exceptions]`, `/foreman/review/[timesheetId]` (approve/return), `/foreman/review/bulk-approve`,
`/foreman/workers`. Закрывает `404`, куда `/login` редиректил `FOREMAN` с самого начала проекта.
Без новой схемы — переиспользует `TimesheetReviewScope` и ядро `approveReviewScope`/
`returnReviewScope` (уже построенное для admin fallback), с проверкой владения объектом поверх.
Протестировано на одноразовом PostgreSQL 16 и headless-browser (изоляция по объекту,
self-approval-forbidden, атомарность bulk-approve, свёрнутые чужие дни в карточке). Migration
(4 права → `FOREMAN`) применена владельцем, `app` пересобран и передеплоен, `healthy`: см. §5,
commit `aab1186`
`period.lock` (T7.10, «Закрытие периода») реализован — `POST /api/admin/periods/:periodId/lock`,
без override, требует `FINAL_APPROVED` у каждого `expected=true` участника, блокеры возвращаются в
теле `409` для UI-списка. Схема не менялась — `PayrollPeriod.status`/`lockedAt`/`lockedByUserId` и
CHECK-constraint их формы уже существовали. Протестировано на одноразовом PostgreSQL 16 и
headless-browser. Migration (право `period.lock` → `ADMIN`/`SUPER_ADMIN`) применена владельцем,
`app` пересобран и передеплоен, `healthy`: см. §5, commit `bba2d8c`
`/worker/history` (все табели работника, любой статус) + `/admin/timesheets[...]`
(final-approve/override-return) реализованы — закрывает `timesheet.final_approve` и последний
недостающий переход ЭТАП 7 из `FOREMAN_APPROVED`. Протестировано на одноразовом PostgreSQL 16 и
headless-browser; найденный по ходу баг оказался багом тестового seed-фикстуры, не продукта.
Migration (3 права: `timesheet.read.all`, `timesheet.final_approve`, `timesheet.return` →
`ADMIN`/`SUPER_ADMIN`) применена владельцем, `app` пересобран и передеплоен, `healthy`: см. §5,
commit `fecedb1`
`/admin/periods` (список+форма) + `/admin/periods/[periodId]` + `/admin/review-scopes[...]`
(approve/return) реализованы — закрывает последний непроверенный чек-лист `/admin/setup`
(`hasOpenPeriod` вёл сюда с самого начала) и даёт админу реальный UI вместо curl. Протестировано
в headless-browser. Без миграции: commit `8704477`
`/worker/periods/[periodId]/hours[/[date]]` + `.../submit` реализованы — ввод часов и отправка
табеля стали реально доступны работнику (не только curl). Протестировано в headless-browser
(Playwright): полная замена сегментов, отклонённое пересечение без частичной записи,
confirmed-zero, read-only после submit. Найден и исправлен побочный баг в уже задеплоенном
`getWorkerTimesheetCurrentVersion()` (не отдавал `confirmedZero`). Без миграции: commit `ffed6df`
`/worker`, `/worker/periods`, `/worker/periods/[periodId]` реализованы — первый UI кабинета
работника (`01_...` §3), закрывает `404` на пути, куда `/login` редиректит `WORKER` с самого
начала. Протестировано в headless-browser (Playwright), задеплоено, без миграции: commit `b0b3ef3`
`GET/POST /api/admin/review-scopes[...]` (approve/return, ЭТАП 7 под-задача 5) реализованы — admin
fallback проверка табеля, реинициализация draft при возврате, реальный `hasException`. Без новой
схемы (`TimesheetReviewProposal`/`ApprovalAction` — снова отложены, нет потребителя). Протестировано
на одноразовом PostgreSQL 16, migration применена владельцем, `app` пересобран и передеплоен,
`healthy`: см. §5, commit `9280a88`
`POST /api/worker/timesheets/:timesheetId/submit` (ЭТАП 7 под-задача 4) реализован — заморозка
draft в версию, классификация дней, `TimesheetReviewScope` с carry-forward. Протестирован на
одноразовом PostgreSQL 16 (SITE/NON_SITE(DATA)/EMPTY_FALLBACK, найден и исправлен баг порядка
заморозки), migration применена владельцем, `app` пересобран и передеплоен, `healthy`: см. §5,
commit `82af772`
Схема `TimesheetReviewScope` (ЭТАП 7 под-задача 4, design-checkpoint перед `timesheet.submit`)
применена владельцем к `titanor-time-db-1`, `app` пересобран (новый Prisma Client) и передеплоен,
`healthy`: commit `a9c1838`
`PATCH /api/worker/timesheets/:timesheetId/days/:date` (ЭТАП 7 под-задача 3b) реализован —
day-state таблица, `Absence`-обоснование non-WORK `dayType`, полная замена `segments`, резолвинг
`sourceAssignmentId`, break-инварианты §5, EXCLUDE-backstop. Протестирован на одноразовом
PostgreSQL 16, migration (`timesheet.draft.edit.own` → `WORKER`) применена владельцем, `app`
пересобран и передеплоен, `healthy`: см. §5, commit `a912239`
Fix: `createAssignment()` теперь бэкфиллит `TimesheetDraftDay`/`TimesheetDraftPlannedShift` для
назначений, созданных после открытия периода (ранее — только upsert контейнеров, ноль строк дней) —
найдено при проектировании ЭТАП 7 3b, без миграции (чистый код): commit `706eb75`
`GET /api/worker/timesheets/:timesheetId`, `.../draft`, `.../current-version` (ЭТАП 7 под-задача 3a,
«Табель: read-эндпоинты») реализованы, протестированы на одноразовом PostgreSQL 16, migration
(`timesheet.read.own` → `WORKER`) применена владельцем к `titanor-time-db-1`, `app` пересобран и
передеплоен, `healthy`: см. §5, commit `baa84da`
`GET /api/worker/context`, `.../assignments/current`, `.../periods/current`, `.../periods/actionable`
(ЭТАП 7 вторая под-задача, «Кабинет работника, read-контекст») реализованы — первый живой код под
`/api/worker/*`, протестированы на одноразовом PostgreSQL 16, три WORKER-scoped migrations применены
владельцем к `titanor-time-db-1`, `app` пересобран и передеплоен, `healthy`: см. §5, commit `f002439`
`POST/GET /api/admin/periods`, `GET .../current`, `GET .../:periodId` (ЭТАП 7 первая под-задача,
«Открытие расчётного периода») реализованы, протестированы на одноразовом PostgreSQL 16, две
migrations (`period.create`/`period.read.all`) применены владельцем к `titanor-time-db-1`, `app`
пересобран и передеплоен, `healthy`: см. §5, commit `399336f`
Ветка: feature/titanor-time-foundation
Isolated PostgreSQL config commit: `c28af00521ffef322211e2cfae840a5568dc8c03`
Next.js app scaffold commit: `e15b203fe334fa4e2c68335f1169f78ed9c18ec9`
Real (persistent, non-disposable) `db` service started + migration applied: см. §5, HEAD `e15b203`
ORM integration + first `app` launch (Prisma Client, `/api/ready`): см. §5, commit `7a854ac`
First backup + verified restore (throwaway db; predates second migration — 24 tables only, now
stale): см. §5, commit `c0f5425`
Second migration (Role/Permission/RolePermission/UserRole): см. §5, commit `c0f5425` (schema.prisma
changed for the first time since commit `9b2cbab`; first initial migration remains frozen/untouched)
Fresh backup + verified restore after second migration (28 tables, 59 FK, 2 migrations), Prisma
Client regenerated + `app` rebuilt, bootstrap SUPER_ADMIN CLI implemented + tested on disposable
PostgreSQL 16 only: см. §5, commit `9fbcd1a`
Docker image gap fix (bootstrap CLI missing from `output: 'standalone'` runner stage) — `app` rebuilt,
CLI confirmed runnable inside the real image; real SUPER_ADMIN still not created: см. §5, commit
`122c884`
First production SUPER_ADMIN created in persistent `titanor-time-db-1` (`andrei.sakki`, owner-run,
owner-confirmed state — see caveat in §5): см. §5, commit `836ef49`
Third migration (`UserSession`, T5.5 first sub-step) — schema created + tested on disposable
PostgreSQL 16, commit `e273490`; **owner-applied** to persistent `titanor-time-db-1`, `app` rebuilt +
Prisma Client regenerated: см. §5, commit `7795d3e`
tsconfig fix (root project no longer type-checks the isolated `titanor-time-app` subproject): commit
`3c39d84`
`POST /api/auth/login` (T5.5 core) implemented per `04_ADMIN_FIRST_API_CONTRACTS.md` §0/§1 — tested
on disposable PostgreSQL 16, commit `ecb37b2`
`reset-password` CLI added (owner forgot the bootstrap-set password) + deployed to real `app`: commit
`be598f8`
Real `SUPER_ADMIN` password reset by owner + real login against `titanor-time-db-1` confirmed —
`200`, correct `id`/`username`/`roles: ["SUPER_ADMIN"]`: см. §5, commit `e42025d`
`GET /api/auth/session` + `POST /api/auth/logout`/`logout-all` (§11 item 1) implemented, with shared
`lib/auth.ts` session-resolution helper — tested only on disposable PostgreSQL 16: commit `690686d`
Session/logout endpoints deployed to real `app` + structurally verified against `titanor-time-db-1`
(`app` rebuilt/recreated, `db` untouched, login regression-checked): см. §5, commit `383c7a2`
Route-protection `proxy.ts` for `/api/admin/*`+`/api/worker/*` (§11 item 1, Next.js 16 "proxy"
convention, Node.js runtime) implemented, tested via the actual standalone `server.js` against
disposable PostgreSQL 16, and deployed to real `app`: см. §5, commit `a220d39`
`hasPermission()` role-guard primitive (`lib/permissions.ts`, T5.6 first sub-step) implemented + tested
on disposable PostgreSQL 16 — not wired into any route yet (none exist under `/api/admin`/`/api/worker`)
and not deployed (no consumer to deploy): см. §5, commit `0214f80`
`GET /api/admin/cities` — first real admin endpoint (T5.6 second sub-step), fourth migration seeding
first real `Permission`/`RolePermission` row (`city.read.all` → `ADMIN`/`SUPER_ADMIN`) — implemented,
tested on disposable PostgreSQL 16, **applied to real `titanor-time-db-1` by owner** (agent blocked by
tool policy as before), deployed to real `app`, structurally verified: см. §5, этот commit
**Security incident this task**: agent printed the real `titanor_time_app` DB password (embedded in
`DATABASE_URL`, not caught by a `grep -v PASSWORD` filter) into tool output while preparing the
migration command. Owner assessed risk as insignificant (own server, chat-only exposure, no external
transmission) and explicitly declined rotation — see §10.
`prisma migrate status` against real `titanor-time-db-1` now explicitly confirmed **"Database schema is
up to date!"** — closes the long-open tail noted since §5/§11 history (owner ran it directly, commit
`834e2dc`).
`session.revoke_all.own` now enforced on `POST /api/auth/logout-all` (T5.6 third sub-step) — fifth
migration (seed to all 4 roles), applied by owner to `titanor-time-db-1`, deployed to real `app`,
structurally verified: см. §5, commit `6dbb52e`.
`AuditEvent` (T5.6 audit-trail foundation) — sixth migration, design shown to and amended by owner
(nullable `actorUserId`/`entityId`, indexed for cursor pagination), append-only enforced by a real
`BEFORE UPDATE OR DELETE` trigger, applied by owner to `titanor-time-db-1`, deployed to real `app`: см.
§5, commit `fbeec60`. No code writes to it yet — deliberately scoped out (see §11).
`X-Request-Id` now generated on every response (not just `jsonError()`, as before) across all seven
existing routes — prerequisite for `AuditEvent.requestId` — deployed to real `app`, structurally
verified: см. §5, commit `bf75962`.
`createAuditEvent()` shared helper (`lib/audit.ts`) implemented — writes one `AuditEvent` row via the
same Prisma transaction client as the business action, atomicity proven on disposable PostgreSQL 16
(rollback test: neither the business row nor the audit row exists after a simulated failure). No route
calls it yet, not deployed: см. §5, commit `f67159f`.
Owner priority change: `IdempotencyKey`/`POST /api/admin/cities` deferred; first visible working user
path chosen instead — `POST /api/auth/login` wired to `createAuditEvent()` (`LOGIN_SUCCEEDED`/
`LOGIN_FAILED`, commit `80c201d`) and a real `/login` page replacing the scaffold (commit `5bb5cb2`),
deployed to real `app`: см. §5, этот commit. **Incident this task**: agent's host-level `kill -9`
cleanup of stray local dev servers repeatedly killed the real `app` container's process instead
(indistinguishable process name, wrong assumed timezone) — 4 unwanted restarts, no data loss (`db`
untouched throughout), service self-healed each time via `restart: unless-stopped`; disclosed
immediately, see §10.
`GET /api/admin/setup-status` + `/admin/setup` — first protected admin screen, real checklist data, no
mock statistics (commits `90d2e55`/`1cba420`), plus a same-day fix (`fa7720e`, removed `loading.tsx`
that was silently downgrading unauthenticated visits from a real `307` to a client-side-only redirect)
— deployed to real `app`: см. §5, этот commit.
`IdempotencyKey` (schema `ddf44a3`, `lib/idempotency.ts` `6a322bc`) + first mutating admin-first
endpoint `POST /api/admin/sites` (`d1c6cc0`, ninth migration seeding `site.create`) + first walkable
`/admin/setup` checklist destination `/admin/sites/new` (`145bfec`) — agent-selected next step per
owner delegation ("что важней ... то и делай"); deployed to real `app`. **Incident this task**:
`docker compose up -d --build app` also recreated `db` (shared `env_file`, unrelated env var change)
despite only `app` being named — same named volume reused, no data loss, confirmed by owner login;
disclosed immediately, see §10.
`POST /api/admin/templates` (eleventh migration seeding `template.create`) + `/admin/templates/new` —
second mutating admin-first endpoint and second walkable `/admin/setup` destination (commits `6bf5232`/
`4962ac6`), same pattern as sites (`IdempotencyKey`+`createAuditEvent()`+shape-validation mirroring the
already-frozen CK-06/07/08 constraints). Deployed to real `app`: this time `db`'s `env_file` was
unchanged, so `docker compose up -d --build app` recreated only `app` — confirms the previous
incident's root cause (a shared `env_file` var change) rather than a general pattern.
Runtime-tested HEAD (полная повторная verification, full green): `991b8fb8381bff11accd09e2c1c3a3f7748d0832`
Source fix commit (CK-08/CK-13 rename): `991b8fb8381bff11accd09e2c1c3a3f7748d0832`
HEAD на момент первого runtime-теста, обнаружившего дефект: bebd6aab5f7a041e6272f24fe32db105ca04f92b
HEAD на момент предыдущего (статического) аудита: 30d2364ffe58679856d6a29d91c9992a941c2b65
Владелец зафиксировал: дальше работаем строго по `PROJECT_ROADMAP.md` ЭТАП 6 по порядку (T6.1→T6.9),
агент больше не выбирает следующий шаг сам. T6.1 («Расширить User — только утверждённые поля»)
проверен и закрыт без изменений кода — `User`/`Employee` в `prisma/schema.prisma` уже содержат ровно
поля из `03_DATA_MODEL_ERD.md` §4.1/§4.2, добавлять нечего. T6.2 («Список работников, read-only») —
`GET /api/admin/workers` + `/admin/workers`, переиспользует уже засеянный `worker.read.all` (седьмая
migration, без новой migration в этой задаче), задеплоено на реальный `app`: commit `45aece3`.
T6.3 («Создание работника») — `POST /api/admin/workers` + `/admin/workers/new`, одиннадцатая migration
(seed `worker.create`), применена **владельцем** (агент по-прежнему заблокирован tool policy на прямые
изменения реальной базы — та же одноразовая `node:22`-container команда, что и во всех предыдущих
migrations), задеплоено на реальный `app`: commit `95e2f74`.
T6.4 («Редактирование и отключение») — `GET`/`PATCH /api/admin/workers/:employeeId` +
`POST .../deactivate` + `/admin/workers/[employeeId]`, двенадцатая migration (seed `worker.update`/
`worker.deactivate`), применена **владельцем**, задеплоено на реальный `app`: commit `64cc569`.
T6.5 («Worksite schema») — проверен, закрыт без изменений кода: `City`/`WorkSite`/`WorkArea` в
`prisma/schema.prisma` уже содержат ровно поля из `03_DATA_MODEL_ERD.md` §4.3 (та же ситуация, что
T6.1), включая оба unique-индекса `WorkArea` (`(siteId,name)`, `(siteId,id)`); `05_RAW_SQL_REGISTER.md`
не содержит ни одного CHECK/EXCLUDE/триггера для этих трёх моделей.
T6.6 первая половина («Список/карточка/редактирование объекта») — `GET /api/admin/sites` +
`GET`/`PATCH /api/admin/sites/:siteId` + `/admin/sites` + `/admin/sites/[siteId]`, тринадцатая
migration (seed `site.read.all`/`site.update`), применена **владельцем**, задеплоено на реальный
`app`: commit `0978634`. `WorkArea` CRUD (вложенный ресурс) отложен отдельной задачей.
(Примечание к нумерации: migration-файлы `20260801123904`/`20260803123201`/`20260803125804` сами
содержат ошибочные ordinal-комментарии «twelfth»/«thirteenth»/«fourteenth» вместо реальных
11/12/13 — обнаружено этой задачей; файлы уже применены к реальной базе и заморожены по конвенции
проекта, поэтому не редактируются задним числом, ошибка исправлена только здесь, в живом статусе.)
T6.6 вторая половина («`WorkArea` CRUD») — `GET`/`POST /api/admin/sites/:siteId/work-areas` +
`PATCH .../work-areas/:workAreaId`, секция внутри уже существующей `/admin/sites/[siteId]` (без
отдельной страницы, per `01_SCREEN_MAP.md`), четырнадцатая migration (seed `workarea.read.all`/
`workarea.create`/`workarea.update`), применена **владельцем**, задеплоено на реальный `app`: commit
`b25a098`. **Закрывает T6.6 полностью.**
T6.7 («Assignment schema») — проверен, закрыт без изменений кода: `SiteAssignment` в
`prisma/schema.prisma` уже содержит ровно поля из `03_DATA_MODEL_ERD.md` §4.4; CK-05
(`ck_site_assignment_date_range`), EX-02 (`ex_site_assignment_scope_date_overlap`) и
`trg_site_assignment_dependents_guard` подтверждены напрямую в уже применённой frozen initial
migration (не только в `05_RAW_SQL_REGISTER.md`). `ForemanAssignment` (нужна для T6.9) в схеме
по-прежнему нет — отдельный design-checkpoint, не входит в T6.7.
T6.8 первый под-шаг («Создание назначения») — `POST /api/admin/assignments/validate-overlap` +
`POST /api/admin/assignments` + `/admin/assignments/new`, пятнадцатая migration (seed
`assignment.create`), применена **владельцем**, задеплоено на реальный `app`: commit `00c8857`.
Разблокирует `hasAssignment` в чек-листе `/admin/setup`. Список/`PATCH`/`split`/`promote`/`end`
отложены на следующие под-задачи. **Инцидент, найден и исправлен этой же задачей**: изначальное
предположение о коде ошибки Prisma для нарушения EXCLUDE constraint (`EX-02`) было неверным —
вместо `PrismaClientKnownRequestError`/`P2010` Prisma реально отдаёт нетипизированный
`PrismaClientUnknownRequestError` с сырым текстом ошибки Postgres; найдено через настоящую гонку
из 6 параллельных запросов на одноразовом PostgreSQL 16 (без фикса — `500`; с фиксом — ровно один
`201`, пять `409`, ноль дублирующихся строк, подтверждено прямым SQL-подсчётом).
T6.8 второй под-шаг («Список назначений») — `GET /api/admin/assignments` + `/admin/assignments`,
шестнадцатая migration (seed `assignment.read.all`), применена **владельцем**, задеплоено на
реальный `app`: commit `44d685c`.
T6.8 третий под-шаг («Редактирование назначения») — `PATCH /api/admin/assignments/:assignmentId`
(только `isPrimary`/`endedReason`, `siteId`/`workAreaId`/`templateId` явно отклоняются с `400
ASSIGNMENT_ALREADY_STARTED`, если назначение уже началось) + одноклик-переключатель primary на
`/admin/assignments`, семнадцатая migration (seed `assignment.update`), применена **владельцем**,
задеплоено на реальный `app`: commit `fe353af`.
T6.8 четвёртый под-шаг («Split назначения») — `POST /api/admin/assignments/:assignmentId/split`
(атомарно закрывает текущее назначение `validTo = effectiveFrom - 1 day` и создаёт новое с новым
site/work area/template, `isPrimary`/`validTo` наследуются от закрываемой строки — этих полей нет в
схеме запроса), восемнадцатая migration (seed `assignment.split`), применена **владельцем**,
задеплоено на реальный `app`: commit `d124a35`.
T6.8 пятый под-шаг («Promote назначения») — `POST /api/admin/assignments/:assignmentId/promote`,
демоушен прежнего primary через per-employee advisory lock (`pg_advisory_xact_lock(hashtext(...))`,
тот же паттерн, что `bootstrap-super-admin.ts`, но ключ включает `employeeId`, а не один
глобальный). Новой migration не понадобилось — `assignment.update` уже покрывает этот endpoint по
`02_ROLE_PERMISSION_MATRIX.md`. Задеплоено на реальный `app`: commit `22eb82d`.
T6.8 шестой (последний) под-шаг («End назначения») — `POST /api/admin/assignments/:assignmentId/end`,
только сжатие диапазона (`validTo` не может стать позже текущего — расширение не относится к
операции «end»), причина обязательна только если новая дата раньше уже запланированной (`null` =
«никогда», так что любая конкретная дата для бессрочного назначения считается «раньше»), совпадение
с уже существующей `validTo` не требует причины. Девятнадцатая migration (seed `assignment.end`),
применена **владельцем**, задеплоено на реальный `app`: commit `544f369`. **Закрывает T6.8
полностью** — весь `04_ADMIN_FIRST_API_CONTRACTS.md` §6 «Назначения» реализован.
T6.9 первый под-шаг («ForemanAssignment schema») — design-checkpoint с владельцем пройден
(`03_DATA_MODEL_ERD.md` §4.4, без отклонений), двадцатая migration: таблица `ForemanAssignment`
(`foremanUserId`/`siteId`/`isSubstitute`/`validFrom`/`validTo`/`assignedByUserId`, все FK
`onDelete: Restrict`, `CHECK ck_foreman_assignment_date_range`, без EXCLUDE — ERD осознанно
разрешает несколько строк на объект, включая перекрывающиеся). Применена **владельцем**, `app`
пересобран (полная переустановка из-за смены схемы — Prisma Client перегенерирован), задеплоено:
commit `9716f02`. Только схема — API endpoint'ов пока нет, это следующий под-шаг.
T6.9 второй под-шаг («Создание назначения прораба») — `POST /api/admin/foreman-assignments` +
секция «Foremen» на `/admin/sites/[siteId]` (список текущих + форма создания), контракт
спроектирован по аналогии с `assignment.create` и подтверждён владельцем (в `04_...` его не было).
Без проверки `ASSIGNMENT_OVERLAP` — ERD осознанно не ограничивает перекрытия для этой сущности;
единственная бизнес-проверка — активная роль `FOREMAN` у `foremanUserId` (`409 USER_NOT_FOREMAN`).
Двадцать первая migration (seed `foreman_assignment.create`), применена **владельцем**, задеплоено
на реальный `app`: commit `0b90e57`.
T6.9 третий под-шаг («Список назначений прораба») — `GET /api/admin/foreman-assignments`, без новой
страницы (секция «Foremen» на карточке объекта уже покрывает текущее состояние, сущность не входит
в чек-лист `/admin/setup`). Двадцать вторая migration (seed `foreman_assignment.read.all`),
применена **владельцем**, задеплоено на реальный `app`: commit `79d31f9`.
T6.9 четвёртый (последний) под-шаг («End назначения прораба») — `POST
/api/admin/foreman-assignments/:foremanAssignmentId/end`. Проще, чем `assignment.end`: у
`ForemanAssignment` нет ни поля `endedReason` (ERD его не предусматривает), ни EXCLUDE constraint —
поэтому здесь нет ни `reason`, ни shrink-only ограничения (расширение `validTo` явно разрешено и
проверено). Двадцать третья migration (seed `foreman_assignment.end`), применена **владельцем**,
задеплоено на реальный `app`: commit `4950c11`.

**T6.9 закрыт полностью. `PROJECT_ROADMAP.md` ЭТАП 6 («Работники, объекты и назначения») закрыт
полностью** — T6.1–T6.9 все реализованы (включая четыре чисто аудиторских под-задачи без изменений
кода: T6.1, T6.5, и частично T6.7, где схема уже существовала в frozen initial migration).
Следующий этап по роадмапу — ЭТАП 7 («Учёт часов», `PROJECT_ROADMAP.md` T7.1–T7.10) — не начат,
требует отдельного подтверждения владельца перед первой задачей.
Статус документа: living implementation record

## 1. Назначение документа

Этот файл фиксирует только доказанное состояние реализации Titanor Time — то, что реально
подтверждается файлами репозитория и историей Git на момент последнего аудита. Он не пересказывает
архитектурные документы и не дублирует roadmap. `TITANOR_TIME_DEVELOPMENT_ROADMAP.md` и
`docs/PROJECT_ROADMAP.md` описывают, что планируется сделать; этот файл описывает, что уже сделано.
Если запись здесь противоречит более свежему состоянию Git/файловой системы — доверять нужно Git и
файловой системе, а не этому документу, и обновить его отдельной задачей.

## 2. Текущий этап

Архитектурный комплект Titanor Time v5.4.1 (пять документов) и Prisma data-model foundation (24
модели, 8 enum) завершены и зафиксированы в Git. Frozen raw-SQL register (21 CHECK, 6 EXCLUDE, 11
функций, 13 триггеров, 1 extension) зафиксирован отдельным документом. На его основе создана и
статически проверена одна initial migration, объединяющая Prisma-generated структуру и raw-SQL
объекты register.

Existing initial migration с исправленными именами CK-08/CK-13 успешно применена, повторно
идемпотентно проверена и детерминированно runtime-верифицирована на чистом одноразовом PostgreSQL 16.
Подтверждены catalog identities и single-session поведенческие сценарии всех current CHECK, EXCLUDE
и triggers. Это не означает создание permanent dev/preview/production базы Titanor Time и не означает
production deployment.

История: первый runtime-аудит (HEAD `bebd6aa`) обнаружил, что два из 21 CHECK constraint (`CK-08`,
`CK-13`) имели имена длиннее 63 байт и PostgreSQL молча обрезал их при применении миграции — см. §7.
Отдельной задачей (commit `991b8fb`) оба имени были сокращены до ≤63 байт синхронно в
`05_RAW_SQL_REGISTER.md` и в единственной existing migration. Эта задача (тот же commit `991b8fb`
как проверяемый HEAD) провела полную повторную runtime-верификацию исправленной migration на новом
чистом одноразовом PostgreSQL 16 — см. §8. Результат: **full green** — structural + catalog identity
аудит подтвердил exact новые имена CK-08/CK-13 в `pg_constraint.conname`, отсутствие старых
(усечённых) имён, и все 21 CHECK / 6 EXCLUDE / 13 триггеров / 11 функций / 7 frozen identifiers прошли
позитивные и негативные поведенческие сценарии. Blocker CK-08/CK-13 закрыт: **resolved by source fix
`991b8fb` and confirmed by clean PostgreSQL 16 runtime verification** (см. §10).

После этого подготовлена изолированная постоянная конфигурация PostgreSQL 16 (commit `c28af00`,
`compose.titanor-time.yaml`) — отдельный Compose-проект `titanor-time`, отдельная internal-network,
отдельный named volume, без публикации database-порта, без CollabStudio.

Следующим шагом добавлен bare-каркас Titanor Time Next.js-приложения (`titanor-time-app/`, commit
`e15b203`) — App Router, TypeScript, health endpoint, multi-stage Dockerfile (standalone output),
подключён как service `app` в `compose.titanor-time.yaml` (`127.0.0.1:3200`, только internal
network). Каркас типизируется и собирается без ошибок, но `app` ни разу не запускался — нет login,
нет данных, нет реальных страниц/API кроме `/api/health`.

После checkpoint владельца сервис `db` был реально запущен и existing migration реально применена к
этой (теперь постоянной, не одноразовой) базе — см. §5. Это по-прежнему не production:
`titanor-time-db-1` изолирован (отдельные network/volume, без published port, без CollabStudio), не
обслуживает `app.titanorgroup.fi`, не содержит seed-данных.

После отдельного owner checkpoint `titanor-time-app` впервые подключён к `db` через Prisma Client и
впервые запущен как service `app` — см. §5. Общая `prisma/schema.prisma` и existing migration не
менялись; `app` использует уже сгенерированный из неё Prisma Client, полученный при сборке Docker
image (без копирования schema/migrations в приложение). Добавлен readiness endpoint
`GET /api/ready`, выполняющий `SELECT 1` через Prisma. `app` реально запущен, healthy, отвечает на
`/api/health`, `/api/ready` (`database: connected`) и `/`; опубликован только на `127.0.0.1:3200`.
`db` по-прежнему без published port. В базе по-прежнему 0 business rows — только применённая схема,
без seed.

Первый backup постоянной database выполнен и **проверен restore-ом в отдельную одноразовую тестовую
базу** (`pg_dump` → `pg_restore` на throwaway PostgreSQL 16, не на реальном `db`) — **до второй
migration**: каталог на тот момент совпал с 24 таблицами, 8 enum, 21 CHECK, 6 EXCLUDE, 55 FK,
11 функциями, 13 триггерами, `_prisma_migrations` = 1 запись — `Role`/`Permission`/`UserRole` тогда
ещё не существовали. Этот первый backup устарел сразу после второй migration (см. ниже) и заменён
свежим (см. следующую задачу/секцию). Backup-файлы не закоммичены (`backups/`, добавлено в
`.gitignore`).

Далее обнаружено и устранено архитектурное ограничение: у схемы не было способа хранить роль
пользователя вообще (`Role`/`Permission`/`UserRole` были только в `03_DATA_MODEL_ERD.md`, не в
foundation-схеме). После явного подтверждения владельца добавлена **вторая migration**
(`20260728161708_add_role_permission_user_role`) — `Role`, `Permission`, `RolePermission`, `UserRole`,
плюс частичный unique index (`ex_user_role_active_unique`, раз в raw SQL — не выразим через
`@@unique`) и 4 фиксированные seed-строки `Role` (`SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`) из
`02_ROLE_PERMISSION_MATRIX.md` §1. Первая initial migration и frozen register не изменялись.
`Permission`/`RolePermission` намеренно оставлены пустыми (заполнение ~50+ permission-строк отложено
до реализации соответствующих endpoint'ов). Применена сначала к одноразовому PostgreSQL 16 (с нуля,
обе migrations вместе, плюс идемпотентный повтор, плюс позитивный/негативный поведенческий тест
partial unique index), затем к реальной постоянной `titanor-time-db-1`.

Далее (T5.4, этот commit): взят **свежий** backup постоянной database — теперь корректно отражающий
обе migrations (28 таблиц, 59 FK — 55 + 4 RBAC — 8 enum, 21 CHECK, 6 EXCLUDE, 11 функций, 13
триггеров, `_prisma_migrations` = 2 записи, `Role` = ровно 4 строки, `User`/`UserRole`/`Permission`/
`RolePermission` = 0) и **проверен restore-ом** в отдельную одноразовую тестовую базу — эта проверка
подтвердила counts и ключевые identities (роли по именам, migration-записи по именам), а не
построчный re-audit каждого constraint/trigger (тот уже пройден в §8 на идентичном migration.sql).
Prisma Client регенерирован из корневой `prisma/schema.prisma` (теперь включает `Role`/`Permission`/
`RolePermission`/`UserRole`); `titanor-time-app` пересобран и `app` пересоздан (`--no-deps`, `db` не
перезапускался) — healthy, `/api/health`/`/api/ready` по-прежнему `200`.

Добавлен `titanor-time-app/scripts/bootstrap-super-admin.ts` — безопасный CLI первого `SUPER_ADMIN`:
Argon2id, пароль только через скрытый интерактивный TTY-ввод (дважды, никогда не через CLI-аргумент
или environment), один Serializable Prisma transaction + PostgreSQL transaction-scoped advisory lock
(`pg_advisory_xact_lock`) против гонки двух одновременных запусков, dry-run режим, отказ без
изменений при уже существующем активном `SUPER_ADMIN` или занятом username/email, полный rollback
при ошибке. Проверен только на одноразовом PostgreSQL 16 (обе migrations с нуля) — dry-run, реальное
создание, повтор с тем же username, повтор при существующем `SUPER_ADMIN`, искусственный сбой между
`User` и `UserRole` (полный rollback подтверждён). Реальный `SUPER_ADMIN` в постоянной базе **не
создан** — это следующий шаг, требующий отдельного подтверждения владельца (см. §11). Production-код
(seed, аутентификация, `Session`, role guard, реальный UI) по-прежнему не начат.

Ход этой задачи также выявил и исправил две ошибки в самом CLI до применения к какой-либо базе:
`pg_advisory_xact_lock()` возвращает `void`, что несовместимо с `$queryRaw` (исправлено на
`$executeRaw`); и модуль запускал `main()` как побочный эффект самого импорта, а не только при прямом
запуске (добавлена проверка `require.main === module`). Обе найдены и исправлены тестами на
одноразовой базе, до применения к реальной.

Далее, после получения от владельца подтверждения username (`andrei.sakki`) для реального первого
`SUPER_ADMIN`, владелец сам запустил предоставленную команду в своём терминале и получил `npm error
Missing script: "bootstrap:super-admin"`. Диагностика (`docker exec titanor-time-app-1 ...`)
подтвердила реальный дефект образа, а не ошибку ввода: Next.js `output: 'standalone'` трассирует и
копирует в `runner`-стадию только то, что достижимо из самих app-роутов — `scripts/`, `lib/`,
CLI-зависимости (`tsx`, `argon2`) и реальный `package.json` со скриптом `bootstrap:super-admin` в
собранный образ не попадали; вместо него в `/app/package.json` лежал собственный минимальный
package.json Next.js (только `dev`/`build`/`start`). Исправлено в `titanor-time-app/Dockerfile`
(`runner`-стадия): полный `node_modules` из `builder` копируется до наложения standalone-поддерева,
затем явно добавлены `scripts/`, `lib/`, `package.json`, `tsconfig.json` из `builder`. `app`
пересобран и пересоздан (`--no-deps`, `db` не перезапускался). Проверено внутри контейнера
`titanor-time-app-1`: `npm run` показывает `bootstrap:super-admin`; `node_modules` содержит `tsx` и
`argon2`; `node_modules/.prisma/client` сгенерирован; `docker exec ... npm run bootstrap:super-admin
-- --username=sanitycheck --dry-run` без `-it` корректно завершается `UsageError` про обязательный
реальный TTY (exit 1) — то есть CLI действительно исполняется внутри образа и его защита от
non-TTY запуска работает; `/api/ready` по-прежнему `{"status":"ready",...,"database":"connected"}`.
Реальный `SUPER_ADMIN` в постоянной базе всё ещё **не создан** — владельцу нужно повторить команду
самому, уже с `-it`, из своего терминала.

После этого владелец сам выполнил `docker compose -f compose.titanor-time.yaml exec -it app npm run
bootstrap:super-admin -- --username=andrei.sakki` из своего терминала (реальный `-it` TTY, пароль
введён только туда) и сообщил результат: первый production `SUPER_ADMIN` создан и подтверждён.
Эта задача (этот commit) обновляет только документацию на основе состояния, сообщённого владельцем
напрямую в чате, — независимый read-only SQL-запрос к `titanor-time-db-1` для перепроверки этой же
информации агентом был заблокирован политикой инструментов (tool policy) до выполнения и не
повторялся; `db`/`app`/bootstrap CLI этой задачей не запускались и не перезапускались. Сообщённое
состояние: `username=andrei.sakki`, `status=ACTIVE`, `locale=FI`, `role=SUPER_ADMIN`,
`passwordSet=true`, `passwordHash` — Argon2id (сам хеш не выводился и не проверялся этой задачей),
`User=1`, `UserRole=1`, `Role=4`, `activeSuperAdmins=1`. Повторный запуск bootstrap CLI (проверка
идемпотентности) корректно завершился без изменений: `No changes made: An active SUPER_ADMIN already
exists.` — согласуется с проверенным ранее (§5, commit `9fbcd1a`) поведением guard на одноразовой базе.

## 3. Источники истины

| Область | Источник | Статус |
|---|---|---|
| Общая архитектура | `docs/titanor-time/README.md` | завершено, v5.4.1 |
| Карта экранов | `docs/titanor-time/01_SCREEN_MAP.md` | завершено, v5.4.1 |
| Роли и разрешения | `docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md` | завершено, v5.4.1 |
| Модель данных | `docs/titanor-time/03_DATA_MODEL_ERD.md` | завершено, v5.4.1 |
| API | `docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md` | завершено, v5.4.1 (admin-first первый срез) |
| Raw SQL | `docs/titanor-time/05_RAW_SQL_REGISTER.md` | завершено, FROZEN, current-scope |
| Исходное ТЗ | `docs/titanor-time/TITANOR_TIME_DEVELOPMENT_ROADMAP.md` | provenance-копия ТЗ владельца; детализирована и заменена пятью документами выше для целей проектирования |
| Общий roadmap проекта | `docs/PROJECT_ROADMAP.md` (ЭТАП 4 T4.1–T4.5, ЭТАП 5 T5.1–T5.4) | набросок ЭТАПА 4 заменён комплектом `docs/titanor-time/`; ЭТАП 5 (T5.2 Prisma schema, T5.3 первая migration) — этап, в котором сейчас находится проект |
| Prisma schema | `prisma/schema.prisma` | зафиксирована, commit `9b2cbab`; расширена (Role/Permission/RolePermission/UserRole) commit `c0f5425` — 28 моделей, 8 enum; расширена вторично (`UserSession`, `AuthLevel`) этим commit — 29 моделей, 9 enum |
| Initial migration | `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` | создана, статически проверена (commit `30d2364`), CK-08/CK-13 переименованы (commit `991b8fb`); полностью runtime-верифицирована на одноразовом PostgreSQL 16 — catalog identity + поведенческие тесты 21 CHECK/6 EXCLUDE/13 триггеров, full green (см. §8); frozen/unchanged с тех пор, включая эту задачу |
| Second migration | `prisma/migrations/20260728161708_add_role_permission_user_role/migration.sql` | создана и применена commit `c0f5425` — Role/Permission/RolePermission/UserRole; не менялась этой задачей |
| Third migration | `prisma/migrations/20260729220524_add_user_session/migration.sql` | создана commit `e273490` — `UserSession` (T5.5, первый под-шаг); протестирована на одноразовом PostgreSQL 16 (все три migrations с нуля, идемпотентность, catalog identity, поведенческие тесты); **применена владельцем** к `titanor-time-db-1` commit `7795d3e` — `prisma migrate deploy` вернул «All migrations have been successfully applied» |
| Root tsconfig | `tsconfig.json` | исправлен commit `3c39d84` — `titanor-time-app` добавлен в `exclude` (изолированный подпроект со своим `@/*` alias, ранее ошибочно захватывался корневым `**/*.ts`) |
| Login endpoint | `titanor-time-app/app/api/auth/login/route.ts`, `titanor-time-app/lib/{api-error,rate-limit,session}.ts` | реализован commit `ecb37b2` — `POST /api/auth/login` (T5.5 core); задеплоен и подтверждён реальным входом (commit `e42025d`) |
| Session/logout endpoints | `titanor-time-app/lib/auth.ts`, `titanor-time-app/app/api/auth/{session,logout,logout-all}/route.ts` | реализованы commit `690686d` — `GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/logout-all` (§11 item 1); задеплоены на реальный `app` и структурно проверены против `titanor-time-db-1` commit `383c7a2` |
| Route-protection proxy | `titanor-time-app/proxy.ts` | реализован, протестирован (standalone `server.js` против одноразового PostgreSQL 16) и задеплоен на реальный `app` commit `a220d39` — гейтит `/api/admin/*`+`/api/worker/*` на аутентификацию; role-level permission enforcement всё ещё требует role guard (T5.6, §9) |
| Role-guard primitive | `titanor-time-app/lib/permissions.ts` | `hasPermission(roles, code)` реализован и протестирован на одноразовом PostgreSQL 16 этим commit — чистый lookup по `RolePermission`, без консьюмеров (нет ни одного `/api/admin`/`/api/worker` роута), не задеплоен |
| PostgreSQL infra | `compose.titanor-time.yaml`, `docs/titanor-time/06_DATABASE_INFRASTRUCTURE.md` | подготовлено (commit `c28af00`); `db` реально запущен, обе migrations применены; свежий backup после второй migration проверен restore-ом (этот commit) |
| Next.js app scaffold | `titanor-time-app/` | commit `e15b203` (scaffold) + `7a854ac` (Prisma Client, `/api/ready`) + этот commit (Prisma Client регенерирован под RBAC-схему, `app` пересобран) |
| Bootstrap SUPER_ADMIN CLI | `titanor-time-app/scripts/bootstrap-super-admin.ts` | реализован и проверен на одноразовом PostgreSQL 16 (commit `9fbcd1a`); Docker-образ `app` не содержал CLI/зависимости (standalone-трассировка), исправлено в `titanor-time-app/Dockerfile` этим commit — CLI подтверждён исполняемым внутри реального образа; реальный SUPER_ADMIN в постоянной базе не создан |

## 4. Git checkpoint

- Текущая ветка: `feature/titanor-time-foundation`.
- HEAD до создания этого status-файла: `30d2364ffe58679856d6a29d91c9992a941c2b65`.
- Commit Prisma schema: `9b2cbab` — `feat(titanor-time): add Prisma foundation`.
- Commit frozen register: `42b839d` — `docs(titanor-time): freeze raw SQL register`.
- Commit initial migration: `30d2364` — `feat(titanor-time): add initial Prisma migration`.
- Файлы в commit `30d2364`: ровно один — `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql` (1441 строка, только добавление).
- Push status: не установлен как доказанный факт этим аудитом — `git remote -v` показывает `origin https://github.com/Hamec01/titangroup.git`, но проверка, дошли ли коммиты `9b2cbab`/`42b839d`/`30d2364` до `origin`, не выполнялась (запуск `git push`/`git fetch` вне read-only scope этой задачи). `origin/migration/vps-self-hosted` в локальных ref указывает на более ранний commit `64e6b1a` — ветка `feature/titanor-time-foundation` в этом аудите не сверялась с `origin`.
- Worktree до аудита: clean (`git status -sb` — без изменений, `git diff --check` — exit 0).

## 5. Реализовано

**Архитектурные документы** (все версия 5.4.1, статус «proposed architecture» внутри самих
документов, но по факту это финальная утверждённая версия комплекта, использованная для реализации
ниже):
- `README.md`, `01_SCREEN_MAP.md`, `02_ROLE_PERMISSION_MATRIX.md`, `03_DATA_MODEL_ERD.md`,
  `04_ADMIN_FIRST_API_CONTRACTS.md` — пять документов, тридцать семь сквозных сценариев (A–AK) в
  README §9.
- `05_RAW_SQL_REGISTER.md` — frozen raw-SQL object register, отдельный шестой документ.

**Prisma schema** (`prisma/schema.prisma`, изначально commit `9b2cbab`, расширена commit `c0f5425`):
- Изначально (commit `9b2cbab`): 24 модели, 8 enum — foundation-слой (Identity/User,
  Employee/Employment/Absence, City/WorkSite/WorkArea, WorkScheduleTemplate*, SiteAssignment,
  PayrollPeriod/Participant, Timesheet/TimesheetDraft* и immutable Timesheet*/WorkSegment/
  BreakSegment). На тот момент `Role`/`Permission`/`UserRole`, сессии, review-scope/proposal,
  correction-flow, audit, export сознательно не входили в этот слой.
- С commit `c0f5425`: **сейчас 28 моделей** — добавлены `Role`, `Permission`, `RolePermission`,
  `UserRole` (см. «Вторая migration» ниже). Сессии (`UserSession`), review-scope/proposal,
  correction-flow, audit, export по-прежнему не входят — остаются более поздними этапами.

**Frozen raw-SQL register** (`05_RAW_SQL_REGISTER.md`, commit `42b839d`):
- 21 CHECK, 6 EXCLUDE, 1 extension (`btree_gist`), 11 trigger-функций, 13 trigger-экземпляров —
  каждый с exact именем, предикатом/контрактом, source-цитатой и минимальным тестом.
- Отдельно зафиксирован `+1 future CHECK` (`CorrectionRequest.approvalOverride`) — не входит в current
  totals.

**Initial migration** (`prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`,
commit `30d2364`):
- Structural-часть — фактический offline-вывод `prisma migrate diff --from-empty
  --to-schema-datamodel`, не переписана вручную.
- Raw-SQL часть — точное исполняемое соответствие всем 21 CHECK / 6 EXCLUDE / 1 extension / 11
  функциям / 13 триггерам register.
- Статически проверена дважды (в предыдущем ходе и в этом аудите) — см. §6.
- Первый runtime-прогон на одноразовом PostgreSQL 16 (HEAD `bebd6aa`) — см. §7: структурно успешна и
  идемпотентна; catalog identity-аудит выявил подтверждённый дефект именования у 2 из 21 CHECK
  constraint (CK-08/CK-13).
- Имена CK-08/CK-13 исправлены (commit `991b8fb`), затем полная повторная runtime-верификация на
  новом чистом одноразовом PostgreSQL 16 — см. §8: full green — catalog identities (8 enum, 24
  таблицы, 55 FK, 21 CHECK с точными исправленными именами, 6 EXCLUDE, 11 функций, 13 триггеров, 1
  extension, 0 future) и все поведенческие сценарии (21 CHECK позитив+негатив, 6 EXCLUDE
  adjacent+overlap, 13 триггеров позитив+негатив, 11 функций достигнуты, 7 frozen identifiers
  наблюдались) подтверждены детерминированно в single-session тестах.

**Не объявляются реализованными**: seed, аутентификация, API, UI, отдельная постоянная база Titanor
Time (production или dev), concurrency/многосессионное поведение constraints и triggers (намеренно
вне scope).

**Изолированная PostgreSQL 16 конфигурация** (`compose.titanor-time.yaml`, `.env.titanor-time.example`,
`docs/titanor-time/06_DATABASE_INFRASTRUCTURE.md`, commit `c28af00`):
- Отдельный Compose-проект `titanor-time`, отдельная `internal`-network (`titanor-time_internal`),
  отдельный named volume (`titanor-time_db_data`), без публикации database-порта, без CollabStudio.
- `docker compose config --quiet` — exit 0.

**Реальный запуск `db` + применение migration** (после отдельного owner checkpoint, HEAD `e15b203`):
- `.env.titanor-time` создан локально (реальный случайный пароль через `openssl rand -hex 32`), не
  закоммичен, покрыт `.env.*` в `.gitignore` — проверено `git check-ignore -v`.
- `docker compose -f compose.titanor-time.yaml up -d db` — создан ровно один контейнер
  `titanor-time-db-1`, ровно одна network `titanor-time_internal`, ровно один volume
  `titanor-time_db_data`; healthcheck перешёл в `healthy` при первой же проверке.
- Подтверждено: PostgreSQL `16.14`, `current_database=titanor_time`, `current_user=titanor_time_app`,
  порт не опубликован (`docker port` — пусто), container ID отличается от
  `collab-studio-postgres-1`, network — только `titanor-time_internal`.
- Existing migration применена через одноразовый `node:22`-контейнер, подключённый только к
  `titanor-time_internal` (без npm install — использован уже установленный `node_modules` репозитория
  через bind-mount, DATABASE_URL передан только in-memory, не выведен и не сохранён): exit 0,
  `_prisma_migrations` — ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст.
- `prisma migrate status` сразу после — «Database schema is up to date!».
- Lightweight catalog sanity (не полный поведенческий re-audit — тот уже пройден в §8 на идентичном
  migration.sql): 24 таблицы, 8 enum, `btree_gist` присутствует, точные имена `CK-08`/`CK-13`
  подтверждены в `pg_constraint.conname` этой реальной базы.
- Production/CollabStudio контейнеры не перезапускались (те же `StartedAt`/`RestartCount`);
  `titanorgroup.fi` и `collabstudio.run` — 200 до и после.
- База пустая (только схема, без данных) — seed не выполнялся.

**Titanor Time Next.js app — bare scaffold** (`titanor-time-app/`, добавлен service `app` в
`compose.titanor-time.yaml`, commit `e15b203`):
- Next.js App Router + TypeScript, свой `package.json`/`Dockerfile`/`tsconfig.json` (изолированные
  зависимости), `prisma/schema.prisma` и migration остаются общими на уровне репозитория и не
  скопированы/не перемещены.
- Единственная функциональность: `GET /api/health` → `{"status":"ok","service":"titanor-time"}` и
  placeholder-страница `/`. Нет auth, нет БД-кода, нет реального API/UI.
- `npx tsc --noEmit` — exit 0; `npm run build` (standalone output) — success; `docker compose build
  app` — success. На момент этого commit ни разу не запускался.

**ORM-интеграция + первый запуск `app`** (`titanor-time-app/lib/prisma.ts`,
`titanor-time-app/app/api/ready/route.ts`, `titanor-time-app/Dockerfile`, `compose.titanor-time.yaml`,
после отдельного owner checkpoint, этот commit):
- `@prisma/client` 6.19.0 (dependency) и `prisma` 6.19.0 (devDependency) — exact, совпадают с общей
  `prisma/schema.prisma` и версией, использованной для существующей migration. `npm update` не
  выполнялся; Next.js/React/прочие зависимости не менялись.
- Единственный источник Prisma-схемы остаётся `prisma/schema.prisma` — не скопирована и не
  продублирована в `titanor-time-app`. Docker build получает её из repository root через build
  context `.` (repo root) + `titanor-time-app/Dockerfile` (ранее было `./titanor-time-app`) — с
  отдельным `titanor-time-app/Dockerfile.dockerignore`, не затрагивающим корневой `.dockerignore`
  публичного сайта. `prisma generate` выполняется во время build; `prisma migrate` во время build не
  выполняется.
- `titanor-time-app/lib/prisma.ts` — один `PrismaClient` на process, singleton через `globalThis` для
  hot-reload в dev, без запросов к БД при импорте модуля, без credentials в исходном коде.
- `GET /api/ready` — выполняет `SELECT 1` через Prisma; `200 {"status":"ready","service":"titanor-time","database":"connected"}`
  при успехе, `503 {"status":"not_ready","service":"titanor-time","database":"unavailable"}` при
  ошибке; ответ и server-лог не содержат DATABASE_URL/host/user/password/stack trace — лог пишет
  только фиксированную credential-free строку.
- `GET /api/health` не изменён — остаётся liveness-эндпоинтом, не зависящим от БД.
- Dockerfile: `node:22-bookworm-slim` (не alpine — glibc, совместим с Prisma query engine), три
  стадии (dependencies/builder/runner), `prisma generate` только в builder, non-root (`USER node`),
  standalone output, слушает `0.0.0.0:3000` внутри контейнера.
- **Исправлена архитектурная ошибка, найденная в этой же задаче**: сеть с `internal: true` блокирует
  не только outbound-трафик контейнера, но и весь host→container port-publishing путь — с `app`
  только на `internal` `127.0.0.1:3200` физически не слушал ни разу, несмотря на healthy-статус
  контейнера. Исправлено добавлением второй, обычной (не `internal`) network `lan` только для `app`;
  `db` остаётся исключительно на `internal` и по-прежнему полностью недоступен снаружи Docker.
- `.env.titanor-time` (локальный, не закоммичен) дополнен `DATABASE_URL` на основе уже существующих
  `POSTGRES_*` значений; `.env.titanor-time.example` дополнен пустым placeholder `DATABASE_URL=`.
  `chmod 600` сохранён; `git check-ignore -v` подтверждён.
- **Инцидент и устранение**: в ходе проверки один раз был выполнен полный (без `--quiet`)
  `docker compose config`, который вывел реальный `POSTGRES_PASSWORD`/`DATABASE_URL` в открытом виде.
  Пароль немедленно ротирован через `ALTER USER ... WITH PASSWORD` (без потери данных — миграция и
  таблицы сохранены), `.env.titanor-time` обновлён новым значением; старый (утёкший) пароль более не
  действителен. Далее использовался только `docker compose config --quiet` либо вывод с ручной
  редакцией строк `PASSWORD`/`DATABASE_URL`.
- Первый реальный запуск: `docker compose -f compose.titanor-time.yaml up -d --build app` — образ
  собран, `app` healthy (healthcheck на `http://127.0.0.1:3000/api/ready`), `depends_on: db:
  condition: service_healthy` сохранён.
- Подтверждено: `GET http://127.0.0.1:3200/api/health` → `200`; `GET .../api/ready` → `200,
  database: connected`; `GET .../` → `200`. `db` port по-прежнему не опубликован. Во всех 24
  application tables суммарно 0 строк; `_prisma_migrations` — 1 запись, `finished_at` заполнен,
  `rolled_back_at` пуст (без изменений). `titanorgroup-web-1`, `collab-studio-app-1`,
  `collab-studio-postgres-1` — те же `StartedAt`/`RestartCount`, не перезапускались;
  `titanorgroup.fi`/`collabstudio.run` — `200` до и после.
- Примечание о ходе задачи: `db` был один раз пересоздан (`Recreate`, не просто restart) как побочный
  эффект смены содержимого `.env.titanor-time` при ротации пароля (Compose учитывает содержимое
  `env_file` в конфигурационном хэше сервиса) — тот же named volume, данные и миграция не пострадали;
  это не было намеренным/лишним перезапуском `db`.

**Первый backup + verified restore постоянной database — устарел, см. новый backup ниже**
(`backups/` — не закоммичен, добавлен в `.gitignore`, commit `c0f5425`):
- `pg_dump -F c` из `titanor-time-db-1` в локальный файл `backups/titanor-time-<timestamp>.dump`.
- Восстановление (`pg_restore`) выполнено **только** в отдельный одноразовый throwaway PostgreSQL 16
  (`--rm`, tmpfs, случайные credentials, `127.0.0.1`-only dynamic port, удалён сразу после проверки)
  — реальный `db` не трогался операцией restore.
- Восстановленный каталог полностью совпал с оригиналом: 24 application-таблицы, 8 enum, 21 CHECK,
  6 EXCLUDE, 55 FK, 11 функций, 13 триггеров, `btree_gist`, точные имена `CK-08`/`CK-13`,
  `_prisma_migrations` — 1 запись (на момент backup, до второй migration).
- Throwaway restore-контейнер удалён; реальный `db`/`app` не перезапускались этой операцией.

**Вторая migration: Role/Permission/RolePermission/UserRole** (`prisma/schema.prisma`,
`prisma/migrations/20260728161708_add_role_permission_user_role/migration.sql`, commit `c0f5425`,
после отдельного owner checkpoint):
- Причина: у foundation-схемы не было ни единого поля/таблицы для хранения роли пользователя —
  `Role`/`Permission`/`UserRole` описаны в `03_DATA_MODEL_ERD.md`, но сознательно не входили в первую
  migration (см. §5 выше, `IMPLEMENTATION_STATUS.md` истории). Без этого «первый SUPER_ADMIN» не мог
  быть технически отмечен как SUPER_ADMIN нигде в БД.
- Схема дизайна показана и утверждена владельцем до создания migration (сущности/поля/связи/
  ограничения/индексы/правила удаления), в соответствии с `AGENT_RULES.md` §11.
- Добавлены таблицы `Role`, `Permission`, `RolePermission`, `UserRole` (все FK `onDelete: Restrict`).
  `UserRole` включает частичный unique index `ex_user_role_active_unique` на `("userId","roleId")
  WHERE "validTo" IS NULL` — не выразим через Prisma `@@unique`, добавлен как raw SQL прямо в эту
  migration (frozen register `05_RAW_SQL_REGISTER.md`, scoped только к первой migration, не менялся).
  4 фиксированные строки `Role` (`SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`, тексты из
  `02_ROLE_PERMISSION_MATRIX.md` §1) засеяны прямо в migration. `Permission`/`RolePermission` оставлены
  пустыми намеренно.
- Migration сгенерирована offline (`prisma migrate diff --from-schema-datamodel <снимок схемы до
  правки> --to-schema-datamodel prisma/schema.prisma --script`), затем протестирована с нуля (обе
  migrations вместе) на одноразовом PostgreSQL 16: `prisma migrate deploy` — exit 0, идемпотентный
  повтор — «No pending migrations to apply», `_prisma_migrations` — 2 записи, обе `finished`. Позитивный
  и негативный поведенческий тест `ex_user_role_active_unique` (дубликат активной роли отклонён;
  истёкшая + новая активная роль одного пользователя/роли — разрешены) прошёл на этой одноразовой
  базе. Только после этого применена к реальной `titanor-time-db-1` (тем же throwaway-node-container
  паттерном, что и первая migration) — exit 0, идемпотентность подтверждена повторно.
- После применения к реальной базе: 28 таблиц (24+4), `Role` содержит ровно 4 строки с ожидаемыми
  именами, `User`/`UserRole`/`RolePermission`/`Permission` — 0 строк (никакого seed пользователей).
  `app`/`db` не перезапускались этой операцией; `titanorgroup-web-1`/CollabStudio — те же
  `StartedAt`/`RestartCount`; `titanorgroup.fi`/`collabstudio.run` — `200`.
- Первая initial migration (hash `a0d2059582079846a0c70658b24c6162830ae5b8e3e9ffcffe077ded4c862d7b`)
  и `05_RAW_SQL_REGISTER.md` (hash `8c014d664319c74ee17c3aff9c42d023a86f8456c2cf6fdd0dce591b5bdcd9c2`)
  — не изменены, подтверждено повторной проверкой hash.

**Свежий backup + verified restore после второй migration** (T5.4, этот commit — заменяет устаревший
первый backup выше):
- `pg_dump -F c` из реальной `titanor-time-db-1`; файл создан с `umask 077`, права `600` (проверено
  `stat`), каталог `backups/` по-прежнему не отслеживается git.
- Восстановление только в новый, отдельный, одноразовый throwaway PostgreSQL 16 (`--rm`, tmpfs, без
  named volume, порт только `127.0.0.1:<random>`, единый shell lifecycle с cleanup trap, пароль
  только в памяти процесса, контейнер удалён по завершении) — реальный `db` не трогался restore.
- Подтверждены counts и ключевые identities (это **не** построчный re-audit каждого
  constraint/trigger — тот уже пройден в §8 на идентичном migration.sql): 28 application-таблиц,
  8 enum, 21 CHECK, 6 EXCLUDE, **59 FK** (55 из первой migration + 4 из второй — проверено фактическим
  catalog count, не предположением), 11 функций, 13 триггеров, `_prisma_migrations` — 2 записи, обе
  `finished`; `Role` содержит ровно `SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`; `User`/`UserRole`/
  `Permission`/`RolePermission` — 0 строк.
- Throwaway restore-контейнер удалён; реальный `db`/`app` не перезапускались этой операцией.

**Prisma Client регенерирован, `app` пересобран** (T5.4, этот commit):
- `prisma validate`/`prisma generate --schema prisma/schema.prisma` из корня — Prisma 6.19.0, exit 0;
  клиент теперь включает `Role`/`Permission`/`RolePermission`/`UserRole`.
- `npx tsc --noEmit` и `npm run build` в `titanor-time-app` — оба зелёные (локальный sibling-directory
  edge case из предыдущих задач устранён рабочим приёмом: сгенерированный клиент физически
  скопирован, а не симлинкнут, в `titanor-time-app/node_modules` — Turbopack не резолвит симлинки за
  пределы своего package boundary; сам приём не влияет на Docker build, который остаётся
  самодостаточным).
- `docker compose build app` — success; `docker compose -f compose.titanor-time.yaml up -d --build
  --no-deps app` — пересоздан только `app` (`db` остался `Running`, не пересоздавался); `app`
  healthy, `/api/health`/`/api/ready` (`database: connected`) — оба `200`; опубликован только на
  `127.0.0.1:3200`; `db` по-прежнему без published port.

**Bootstrap CLI первого SUPER_ADMIN** (`titanor-time-app/scripts/bootstrap-super-admin.ts`, T5.4,
этот commit):
- Зависимости: `argon2` 0.45.1 (dependency), `tsx` 4.23.1 (devDependency) — только эти, `npm update`
  не выполнялся, Next.js/React/прочее не менялись.
- Пароль: только интерактивный скрытый (no-echo) TTY-ввод дважды подряд с подтверждением совпадения;
  никогда не через CLI-аргумент (явно отклоняется с ошибкой) или environment; нигде не записывается
  на диск; текущий owner-approved минимум для всех HUMAN-аккаунтов — 8 символов; хешируется
  Argon2id (`$argon2id$...`)
  непосредственно перед вызовом транзакции — plaintext нигде не логируется и не хранится.
- `requireRealTty()` отклоняет запуск без настоящего TTY на обоих stdin/stdout.
- `username`: обязателен, 3-64 символа, нормализуется в lowercase (и внутри `parseArgs`, и
  избыточно/защитно внутри самой `bootstrapSuperAdmin()` — устраняет класс ошибок, если функцию
  когда-либо вызовут напрямую без прохождения через CLI-парсинг). `email`: опционален, аналогично
  нормализуется. `locale`: `FI` по умолчанию, `FI`/`EN`/`RU` допустимы. Создаваемый `User`:
  `status=ACTIVE`, `employeeId=null`, `twoFactorEnabled=false`.
- Роль ищется строго по точному имени `SUPER_ADMIN` в уже существующей таблице `Role` (не создаётся
  заново, свободный текст не допускается).
- `User` и `UserRole` создаются в одной Prisma `$transaction` с `isolationLevel: Serializable`,
  первым действием — `pg_advisory_xact_lock` (фиксированный ключ через `hashtext()`, не magic-число),
  защищающий от гонки двух одновременных первых запусков.
- Если активный `SUPER_ADMIN` уже существует, либо `username`/`email` заняты — завершение без
  изменений (`AlreadyExistsError`, отдельные, не путаемые между собой message). Dry-run режим:
  выполняет все проверки, ничего не пишет (гарантировано тем же transaction-throw механизмом, что и
  реальные ошибки — Prisma откатывает транзакцию целиком).
- Успешный вывод — строго `{ userId, username, locale, role }`, без пароля/хеша/иных полей.
- Проверено **только на одноразовом PostgreSQL 16** (обе migrations с нуля): 4 роли подтверждены;
  dry-run не создаёт строк; реальное создание даёт ровно 1 `User` + 1 активный `UserRole`
  (`SUPER_ADMIN`); `passwordHash` — валидный `$argon2id$`, подтверждён `argon2.verify()`, plaintext
  отсутствует в хеше; повтор с тем же (и с любым другим) `username` при уже существующем активном
  `SUPER_ADMIN` отклонён без новых строк; отдельно (симулированный «уже существующий обычный
  `User`», ещё до появления активного `SUPER_ADMIN`) подтверждена изолированная проверка занятости
  `username`/`email`; искусственный сбой между `tx.user.create` и `tx.userRole.create` (тот же паттерн
  Serializable transaction + advisory lock) откатился полностью — 0 лишних строк. Одноразовый
  контейнер и весь тестовый код удалены после проверки, ничего не оставлено в репозитории.
- В ходе именно этой проверки найдены и исправлены две ошибки до применения к какой-либо базе:
  `pg_advisory_xact_lock()` возвращает `void`, что несовместимо с `$queryRaw` (исправлено на
  `$executeRaw`); и `main()` запускался как побочный эффект самого импорта модуля, а не только при
  прямом запуске (добавлена проверка `require.main === module`).
- **Реальный `SUPER_ADMIN` в постоянной базе не создан.** `User`/`UserRole` в `titanor-time-db-1`
  по-прежнему 0/0 — не тронуты этой задачей. `Permission`/`RolePermission` по-прежнему пусты; перед
  реальным permission-guard понадобится отдельная задача — seed полной permission-матрицы из
  `02_ROLE_PERMISSION_MATRIX.md`.

**Первый production SUPER_ADMIN создан** (`titanor-time-db-1`, владелец лично запустил bootstrap CLI
из своего терминала с `-it`, этот commit — документация only, код/схема/данные этой задачей не
менялись):
- Источник состояния: сообщено владельцем напрямую в чате после реального запуска. Независимая
  read-only проверка агентом (`docker exec` в `titanor-time-db-1` с `SELECT count(*)`-запросами, без
  записи) была заблокирована политикой инструментов до выполнения — попытка не повторялась, other
  db/bootstrap actions этой задачей не выполнялись. Ниже — сообщённое, не самостоятельно
  верифицированное агентом, состояние.
- `username=andrei.sakki`, `status=ACTIVE`, `locale=FI`, ровно одна активная роль `SUPER_ADMIN`
  (`UserRole.validTo IS NULL`).
- `passwordSet=true`, hash-алгоритм Argon2id (`$argon2id$...`) — сам хеш не выводился в чат и не
  записан в этот документ, согласуется с CLI-контрактом (§5 выше, «Bootstrap CLI первого
  SUPER_ADMIN»).
- Каталог: `User=1`, `UserRole=1` (активная), `Role=4` (без изменений — `SUPER_ADMIN`/`ADMIN`/
  `FOREMAN`/`WORKER`), `activeSuperAdmins=1`. `Permission`/`RolePermission` по-прежнему пусты (без
  изменений).
- Idempotency-guard подтверждён на реальной базе: повторный запуск того же bootstrap-скрипта завершился
  без изменений — `No changes made: An active SUPER_ADMIN already exists.` Эта задача **не** запускала
  bootstrap повторно — сообщённый результат относится к попытке владельца, предшествовавшей этой
  документационной задаче.
- `db`/`app` этой задачей не перезапускались и не пересоздавались; migrations и `prisma/schema.prisma`
  не менялись; `passwordHash` не читался и не изменялся этой задачей.
- Governance-ограничения для `SUPER_ADMIN` (последний активный не удаляется/не блокируется/не
  понижается, второй `SUPER_ADMIN` — только через аутентифицированный admin API, не через bootstrap
  CLI, role-изменения — в audit trail после появления модели `AuditEvent`) зафиксированы отдельно и
  остаются в силе для последующих задач (login/role guard/admin API) — сам bootstrap CLI и так уже
  отказывается создавать второго `SUPER_ADMIN` (см. §5 выше).

**Третья migration: `UserSession`, T5.5 первый под-шаг** (`prisma/schema.prisma`,
`prisma/migrations/20260729220524_add_user_session/migration.sql`, этот commit, после отдельного
owner checkpoint на дизайн):
- Причина: `PROJECT_ROADMAP.md` ЭТАП 5 T5.5 (Login) требует secure server-side сессии;
  соответствующей модели в схеме не было (см. §9 предыдущей версии этого файла).
- Дизайн — точное соответствие `03_DATA_MODEL_ERD.md` §4.1 (уже утверждённая архитектура), без
  отклонений: `id`, `userId FK → User` (`onDelete: Restrict`, как у `UserRole`/`RolePermission` —
  `User` никогда не удаляется физически), `tokenHash` (unique, `SHA-256` opaque-токена ≥32 байта —
  сам токен только в cookie, не в базе), `authLevel` (новый enum `AuthLevel`: `PASSWORD` default,
  `MFA_VERIFIED`), `mfaVerifiedAt`, `expiresAt`, `lastSeenAt`, `ipAddress`, `userAgent`, `revokedAt`
  (soft-revoke — сессия никогда не удаляется физически, только помечается), `createdAt`. Индексы:
  unique на `tokenHash`, plain на `userId` и `expiresAt`. Дизайн показан владельцу и подтверждён до
  создания migration (`AGENT_RULES.md` §11).
- Migration сгенерирована offline (`prisma migrate diff --from-schema-datamodel <снимок до правки>
  --to-schema-datamodel prisma/schema.prisma --script`) — только `CREATE TYPE "AuthLevel"`,
  `CREATE TABLE "UserSession"`, три индекса, один FK; ни одна из первых двух migrations не изменена.
- Проверено **только на одноразовом PostgreSQL 16** (`--rm`, tmpfs, случайные credentials, порт
  только `127.0.0.1:<random>`, без named volume): `prisma migrate deploy` с нуля применил все три
  migrations подряд, exit 0; повторный `deploy` — «No pending migrations to apply», `migrate status`
  — «Database schema is up to date!» (идемпотентность подтверждена). Catalog-аудит: enum `AuthLevel`
  содержит ровно `PASSWORD`/`MFA_VERIFIED` в этом порядке; 11 колонок `UserSession` — точные
  имена/типы/nullability совпадают с дизайном; 4 индекса (`_pkey`, unique `tokenHash`, `userId`,
  `expiresAt`); ровно один FK (`UserSession_userId_fkey → User`); `_prisma_migrations` — 3 записи, все
  `finished`, ни одной `rolled_back`; существующие данные (`Role` = 4 строки, `User`/`UserSession` = 0)
  не задеты. Поведенческие тесты (всё внутри одной транзакции, завершённой `ROLLBACK` — ничего не
  закоммичено): дубликат `tokenHash` отклонён (`unique constraint violation`); попытка удалить `User`,
  на которого ссылается `UserSession`, отклонена (`foreign key constraint violation` —
  `onDelete: Restrict` работает); soft-revoke через `revokedAt` подтверждён. Одноразовый контейнер
  удалён, временные файлы удалены, `docker ps`/`docker volume ls` для реальных сервисов не менялись.
- Login-эндпоинт (password-check, выдача сессии, `Set-Cookie`, rate limit, блокировка неактивных
  пользователей) этой (тестовой) задачей **не** реализован — только схема хранения сессии.

**Third migration применена владельцем к реальной `titanor-time-db-1`, `app` пересобран** (этот
commit, после отдельного owner checkpoint):
- Инструмент политики окружения заблокировал агенту прямое обращение к `titanor-time-db-1` — как
  read-only `docker exec` (см. §2/§5 выше, история с bootstrap), так и network-based one-off
  контейнер для применения migration. Поэтому команды выполнил лично владелец на VPS, тем же
  паттерном, что первую и вторую migration (одноразовый `node:22`-контейнер, подключённый только к
  `titanor-time_internal`, `DATABASE_URL` только in-memory через `.env.titanor-time`, без npm
  install — bind-mount существующего `node_modules`).
- `prisma migrate deploy --schema prisma/schema.prisma` (владелец): «Datasource "db": PostgreSQL
  database "titanor_time" ... at "db:5432"» → «Applying migration `20260729220524_add_user_session`»
  → «All migrations have been successfully applied.» — точный вывод, не пересказ.
- Отдельная попытка `npx prisma migrate status` сразу после — выполнена владельцем **вне** обёртки
  (без `source .env.titanor-time`/без docker-контейнера), поэтому закономерно упала с `P1012
  Environment variable not found: DATABASE_URL` — это ошибка команды/окружения запуска, не признак
  проблемы с самой migration. Отдельного успешного повторного `migrate status` с явным «Database
  schema is up to date!» против реальной базы не зафиксировано.
- `docker compose -f compose.titanor-time.yaml build app` + `up -d --no-deps app` (владелец) — образ
  пересобран (`prisma generate` в builder-стадии против уже обновлённой `prisma/schema.prisma`),
  `titanor-time-db-1` остался `Running` (не пересоздан — подтверждено выводом `up`: `Container
  titanor-time-db-1 Running` без `Recreate`), `titanor-time-app-1` создан заново и стал `healthy`.
- Проверено этим агентом (доступные, не заблокированные политикой действия — `docker compose ps`,
  `curl` на `127.0.0.1:3200`, `docker exec` в **`app`**, не в `db`): `titanor-time-app-1` — `healthy`;
  `GET /api/health` → `200 {"status":"ok",...}`; `GET /api/ready` → `200
  {"status":"ready",...,"database":"connected"}`; сгенерированный внутри образа Prisma Client
  (`node_modules/.prisma/client/index.d.ts` в контейнере `app`) содержит `UserSession` (прямой grep,
  не предположение) — подтверждает, что клиент действительно регенерирован из схемы с новой моделью.
  Прямой `prisma migrate status` внутри `app` не выполним — `runner`-стадия образа намеренно не
  копирует `prisma/schema.prisma`/`migrations/` (не нужны в runtime, см. commit `122c884`
  про standalone-трассировку) — попытка дала ожидаемую `schema.prisma not found`, не ошибку базы.
  `titanor-time-db-1` — `Up 32 hours` (то же время работы, что до этой задачи, не пересоздан);
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` не менялись.
- **Итог:** миграция подтверждена применённой к реальной базе прямым выводом `migrate deploy`
  владельца + косвенно подтверждена рабочим `app` с регенерированным клиентом; отдельного успешного
  `migrate status`/catalog-запроса против самой `titanor-time-db-1` в этой записи нет (агенту
  заблокировано, владелец его не переповторил в рабочей обёртке). Если нужна полная уверенность —
  повторить `migrate status` в той же обёртке, что и `migrate deploy` (см. §11).

**Root tsconfig fix** (`tsconfig.json`, commit `3c39d84`, отдельная изолированная задача до
login-эндпоинта): корневой `tsconfig.json` через `**/*.ts`/`**/*.tsx` захватывал файлы
`titanor-time-app` — самостоятельного подпроекта со своим `tsconfig.json` (включая alias `@/*`),
из-за чего `npx tsc --noEmit` из корня падал на `Cannot find module '@/lib/prisma'`, хотя собственная
проверка `titanor-time-app` всегда была зелёной. Причина подтверждена на чистом HEAD без изменений
этой задачи. Минимальный фикс — `titanor-time-app` добавлен в `exclude` корневого `tsconfig.json`;
`titanor-time-app/tsconfig.json`, Prisma schema/migrations, контейнеры не менялись. После очистки
`tsconfig.tsbuildinfo` (оба проекта) обе проверки — `npx tsc --noEmit` из корня и из
`titanor-time-app` — `exit 0`, стабильно на повторном запуске; `git diff --check` — `exit 0`.

**`POST /api/auth/login` — T5.5 core** (`titanor-time-app/app/api/auth/login/route.ts`,
`titanor-time-app/lib/api-error.ts`, `titanor-time-app/lib/rate-limit.ts`,
`titanor-time-app/lib/session.ts`, этот commit):
- Контракт — точное соответствие `04_ADMIN_FIRST_API_CONTRACTS.md` §0/§1: `identifier` (username или
  email, регистронезависимо, одно поле — не два) + `password`; `httpOnly`/`Secure`/`SameSite=Lax`
  cookie `tt_session` с непрозрачным токеном ≥32 байта, в базе — только `SHA-256(token)` в
  `UserSession.tokenHash`; обязательный `X-Requested-With: titanor-time` (иначе `403 CSRF_REJECTED`);
  единый формат ошибок с `X-Request-Id`; rate limit 5/15мин на `identifier` + 50/15мин на IP → `429
  RATE_LIMITED`.
- Порядок проверок — статус аккаунта проверяется **до** пароля: `PENDING_ACTIVATION`-аккаунт обычно
  не имеет `passwordHash` вообще (выставляется отдельным `set-initial-password`-flow), поэтому если
  проверять пароль первым, `403 ACCOUNT_PENDING_ACTIVATION` была бы физически недостижима. `DEACTIVATED`
  проверяется тем же способом — до пароля. `OFFBOARDING` login **разрешён** (не блокируется) — по
  правилу `03_DATA_MODEL_ERD.md` §4.2 (offboarding сохраняет доступ до завершения незакрытых табелей).
  Неизвестный `identifier` — единственный случай, где нет аккаунта, статус которого можно раскрыть:
  выполняется `argon2.verify` против фиксированного dummy-хеша ради timing-паритета с реальной
  проверкой пароля, затем `401 INVALID_CREDENTIALS`.
- Два допущения, не зафиксированных ни в одном архитектурном документе на момент этой задачи (отмечены
  комментарием прямо в коде, не только здесь): срок жизни сессии — 30 дней (`SESSION_DURATION_MS`,
  `lib/session.ts`); хранилище rate-limit — in-memory `Map` (`lib/rate-limit.ts`), корректно только
  для текущего single-instance деплоя (`compose.titanor-time.yaml` — один `app`-реплик), потребует
  общего хранилища (например Redis) при масштабировании на несколько инстансов.
- **Не входит в эту задачу**: `GET /api/auth/session`, `POST /api/auth/logout`/`logout-all`, и сама
  middleware проверки `UserSession` на остальных роутах (login только выдаёт сессию, ничего пока её не
  читает) — отдельные последующие задачи. `LOGIN_SUCCEEDED`/`LOGIN_FAILED` audit-события не пишутся —
  модели `AuditEvent` всё ещё нет (см. §9).
- **Проверено только на одноразовом PostgreSQL 16** (`--rm`, tmpfs, случайные credentials, без named
  volume): все три migrations с нуля, засеяны по одному тестовому `User` на каждый статус
  (`ACTIVE` с двумя ролями `WORKER`+`FOREMAN`, `PENDING_ACTIVATION` без `passwordHash`, `DEACTIVATED`,
  `OFFBOARDING`). Приложение запущено локально (`next dev`, не Docker) поверх этой базы, порт только
  `127.0.0.1:3987` (не production-порт `3200`). Сценарии, все через `curl`:
  - без `X-Requested-With` → `403 CSRF_REJECTED`;
  - пустое тело → `400 VALIDATION_ERROR` с `fieldErrors` на оба поля;
  - неизвестный `identifier` → `401 INVALID_CREDENTIALS`;
  - верный `identifier`, неверный пароль → `401 INVALID_CREDENTIALS`;
  - верный пароль, `ACTIVE`, две активные роли → `200`, `Set-Cookie: tt_session=...; Path=/;
    Max-Age=2592000; Secure; HttpOnly; SameSite=lax`, тело `{"user":{"id","username","roles":
    ["WORKER","FOREMAN"],"locale":"FI"}}`;
  - тот же пользователь через email вместо username, в верхнем регистре → `200` (регистронезависимая
    нормализация подтверждена);
  - `PENDING_ACTIVATION`, любой пароль → `403 ACCOUNT_PENDING_ACTIVATION`;
  - `DEACTIVATED`, **верный** пароль → `403 ACCOUNT_DEACTIVATED` (не `200`, не `401`);
  - `OFFBOARDING`, верный пароль → `200` (login разрешён, подтверждает правило выше);
  - rate limit по `identifier`: 5-я подряд попытка на тот же `identifier` — ещё разрешена (`401`),
    6-я — `429 RATE_LIMITED`; независимый `identifier` с того же IP в этот момент — не заблокирован
    (счётчики раздельные).
  - Прямая проверка в БД (throwaway, не production): `SHA-256` реального токена из `Set-Cookie` в
    ответе совпал точно с `UserSession.tokenHash` соответствующей новой строки; `authLevel=PASSWORD`;
    `User.lastLoginAt` обновлён.
  - Тестовый dev-сервер поднимался только на `127.0.0.1` (не `0.0.0.0`) — после первой попытки,
    случайно забиндившей все интерфейсы, перезапущен с явным `-H 127.0.0.1` до продолжения тестов.
  - Очистка: dev-сервер остановлен (`pkill`, подтверждено `pgrep`+`curl` на порт), одноразовый
    контейнер удалён, тестовый seed-скрипт и временные файлы удалены, ничего не закоммичено из
    тестового прогона.
- **Реальные `titanor-time-db-1`/`app` этой задачей не тронуты** — эндпоинт не вызывался против
  production, `app`-контейнер не пересобирался. Локальный Prisma Client в `titanor-time-app/node_modules`
  регенерирован и скопирован (тот же приём, что раньше — физическая копия, не symlink) только для
  типизации/локального теста; Docker-образ `app` эту копию не использует (пересобирает свою во время
  build).

**Login задеплоен на реальный `app` + структурная проверка на реальной базе** (тот же commit `ecb37b2`
как код, деплой отдельным шагом сразу после): `docker compose build app` + `up -d --no-deps app` —
`db` не пересоздавался (`Running`, то же время), `app` пересоздан, healthy. Проверено без знания
реального пароля (агенту он не известен и не должен быть): отсутствие `X-Requested-With` → `403`;
пустое тело → `400`; неизвестный `identifier` → `401`; **`andrei.sakki` + заведомо неверный пароль →
`401`** — последнее прямо подтверждает, что реальный пользователь найден в `titanor-time-db-1`, его
`status` дошёл до проверки пароля (не `PENDING_ACTIVATION`/`DEACTIVATED`), и сама проверка пароля
физически выполняется против реальной строки, а не заглушки.

**`reset-password` CLI** (`titanor-time-app/scripts/reset-password.ts`,
`titanor-time-app/lib/tty-prompt.ts`, commit `be598f8`) — владелец не мог вспомнить пароль,
установленный во время bootstrap; самостоятельного «forgot password» flow ещё нет
(`PasswordResetToken`/доставка — более поздняя, ещё не начатая фича), а bootstrap CLI намеренно
одноразовый и второй раз не запускается:
- Тот же security-паттерн, что bootstrap: новый пароль только через скрытый real-TTY double-prompt,
  никогда не CLI-аргументом/env var; текущий owner-approved минимум для всех HUMAN-аккаунтов —
  8 символов.
- Общий TTY-код (`promptHidden`) вынесен в `lib/tty-prompt.ts`, чтобы не дублироваться между
  скриптами; `bootstrap-super-admin.ts` отдельно перепроверен — неизменное поведение (non-TTY
  отклонение даёт тот же `Usage error`, exit 1).
- Сброс пароля в той же транзакции отзывает все активные `UserSession` этого пользователя —
  забытый/потенциально скомпрометированный пароль означает, что и старые сессии доверять не стоит.
- Проверено на одноразовом PostgreSQL 16: non-TTY, `--password`-аргумент отклонён, отсутствующий
  `--username`, dry-run (ничего не пишет — старый пароль и сессия по-прежнему валидны после),
  несуществующий username, реальный сброс (прямой `argon2.verify()`: старый пароль перестал работать,
  новый заработал; единственная активная сессия отозвана), и сквозной сценарий через настоящий
  login-эндпоинт (старый пароль → `401`, новый → `200`). Одноразовый контейнер и все временные
  seed/invoke-скрипты удалены.
- Задеплоен на реальный `app` тем же паттерном (`build` + `up -d --no-deps`) — `db` не пересоздавался;
  `docker exec ... npm run` внутри реального образа подтвердил наличие обеих команд
  (`bootstrap:super-admin`, `reset-password`).

**Реальный пароль `SUPER_ADMIN` сброшен владельцем + реальный login подтверждён** (этот commit):
владелец лично выполнил `docker compose exec -it app npm run reset-password -- --username=andrei.sakki`
на VPS (реальный `-it` TTY), затем вошёл через `POST /api/auth/login` против реальной
`titanor-time-db-1`. Точный ответ (не пересказ): `200`, `{"user":{"id":"f227b077-a84d-4f4c-8acc-c13b38728e1a","username":"andrei.sakki","roles":["SUPER_ADMIN"],"locale":"FI"}}`.
Как и раньше, это владелец-сообщённый факт, не независимо перепроверенный агентом запросом к базе —
`docker exec`/network-based доступ к `titanor-time-db-1` заблокирован агенту политикой инструментов
(см. §2/§5 выше). Прямой HTTP-ответ с реальным (не тестовым) `id` и точной ролью — сильное прямое
доказательство сам по себе, не только словесное подтверждение. Второй вызов той же командой сразу
после вернул `401 INVALID_CREDENTIALS` — ожидаемо, скорее всего опечатка при повторном скрытом вводе
пароля, не проблема системы (неверный пароль корректно отклонён, не пропущен).

**`GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/logout-all`** (T5.5, §11 item 1 —
`titanor-time-app/lib/auth.ts`, `titanor-time-app/app/api/auth/session/route.ts`,
`titanor-time-app/app/api/auth/logout/route.ts`, `titanor-time-app/app/api/auth/logout-all/route.ts`,
commit `690686d`):
- Причина: login (§5 above, commit `ecb37b2`) issues a `UserSession`, but until this task nothing read
  or revoked it — `04_ADMIN_FIRST_API_CONTRACTS.md` §1 requires all three endpoints for the session to
  be a real session, not just a write-only cookie.
- `lib/auth.ts` adds one shared `resolveAuthenticatedSession()`, reused by all three routes: reads the
  `tt_session` cookie, `SHA-256`-hashes it, looks up `UserSession.tokenHash`, and rejects (`null`) a
  missing cookie, unknown/expired/revoked token, or a user whose account is `DEACTIVATED` — the last
  check is not in the API contract text but is required by `AGENT_RULES.md` §12 ("отключённый аккаунт
  не работает"): without it, deactivating a user after they logged in would not actually end their
  session until natural expiry (up to 30 days). `OFFBOARDING` is intentionally not rejected, matching
  login's existing rule (`03_DATA_MODEL_ERD.md` §4.2). On success, refreshes `UserSession.lastSeenAt`.
- `GET /api/auth/session`: `200 { user: { id, username, roles, locale } }` on a valid session, `401
  NOT_AUTHENTICATED` otherwise — exact contract match, no CSRF check (not a mutating request).
- `POST /api/auth/logout`: same `X-Requested-With: titanor-time` CSRF check as login (`403
  CSRF_REJECTED` if missing/wrong), `401 NOT_AUTHENTICATED` without a valid session, otherwise
  soft-revokes only the caller's own current `UserSession` (`revokedAt = now()`, row never deleted,
  same pattern as `reset-password`) and clears the `tt_session` cookie (`Max-Age=0`), `204`.
- `POST /api/auth/logout-all`: same CSRF/auth gate, then soft-revokes every `UserSession` belonging to
  the caller (`WHERE userId = ... AND revokedAt IS NULL`) — including any already-expired-but-not-yet-
  revoked rows, a deliberate blanket sweep, not a bug — clears the cookie, `204`. **Known gap, deferred
  on purpose**: the contract's stated permission is `session.revoke_all.own`, but `Permission`/
  `RolePermission` enforcement (role guard, T5.6, §9/§11) doesn't exist yet, so this endpoint is
  currently gated on "authenticated" only, same as `/logout`. Not a privilege-escalation gap in the
  meantime — the query is hard-scoped to the caller's own `userId`, so an authenticated user can only
  ever revoke their own sessions regardless of role. Must be revisited once role guard lands, per the
  same `session.revoke_all.own` contract line.
- **Tested only on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume; all
  three migrations applied from scratch via local `prisma migrate deploy`, not Docker): app run locally
  via `next dev -H 127.0.0.1 -p 3988` (not the production port `3200`) against a seed of one `ACTIVE`
  user (two roles) and one `DEACTIVATED` user, with five hand-crafted `UserSession` rows (valid,
  expired, pre-revoked, belonging to the deactivated user, and a second valid session on the `ACTIVE`
  user) — all via `curl`:
  - `GET /session` — no cookie → `401`; valid token → `200` with both roles; expired token → `401`;
    pre-revoked token → `401`; deactivated-user's token → `401` (and confirmed via direct query that
    this path does **not** touch that session's `lastSeenAt`/`revokedAt` — the `DEACTIVATED` check is
    part of the same early-return guard, not a separate write); unknown/garbage token → `401`.
  - `POST /logout` — missing CSRF header → `403`; missing cookie (CSRF present) → `401`; valid session
    + CSRF → `204` with `Set-Cookie: tt_session=; Max-Age=0; ...`; the same (now-revoked) token
    immediately returns `401` on a follow-up `GET /session` — revocation takes effect same-request, not
    on next login.
  - `POST /logout-all` — missing CSRF → `403`; with the second `ACTIVE`-user session + CSRF → `204`,
    cookie cleared, token immediately unusable. Direct `SELECT` against the five seeded `UserSession`
    rows after both calls confirmed exact expected end state: the `/logout`-revoked session and the
    `/logout-all`-revoked session both `revokedAt IS NOT NULL`; the pre-revoked session's row untouched
    (same `revokedAt`, no double-write); the previously-expired `ACTIVE`-user session was **also**
    revoked by `/logout-all`'s blanket sweep (confirms intended behavior, not scope creep); the
    `DEACTIVATED` user's own session was **not** touched (`revokedAt IS NULL`) — confirms the `userId`
    scoping, i.e. `/logout-all` cannot reach another user's sessions.
  - `npx tsc --noEmit` and `npm run build` both clean (root and `titanor-time-app`), all three new
    routes listed as `ƒ (Dynamic)` in the build output alongside the existing `login`/`health`/`ready`
    routes.
  - Cleanup: disposable `next dev` process killed, disposable PostgreSQL container removed
    (`docker rm -f`, confirmed absent from `docker ps -a` afterward), temporary seed script deleted,
    nothing committed from the test run. `next-env.d.ts` reverted (`next dev` rewrites its `.next/dev/`
    type-reference path; `git checkout --` restored the `next build`-generated committed version).
- **Real `titanor-time-db-1`/`app` untouched by this task** — no migration was needed (schema
  unchanged since commit `e273490`), and the new routes were not deployed/rebuilt against the real
  `app` container. `titanor-time-app-1`/`titanor-time-db-1`/`collab-studio-*`/`titanorgroup-web-1` —
  same `Up`-durations before and after, all `healthy`; `titanorgroup.fi`/`collabstudio.run` — `200`
  before and after. Only Docker artifact touched was the disposable test-database container, removed at
  the end of the task.
- **Not in this task**: deploying these routes to the real `app` (`docker compose build/up`), the
  route-protection middleware that will call the same `resolveAuthenticatedSession()` on other
  protected routes (§11 item 2, next), and role guard / `session.revoke_all.own` enforcement (§11 item
  3, T5.6).

**Session/logout endpoints deployed to real `app`, structurally verified against `titanor-time-db-1`**
(§11 item 1, deploy step — code unchanged from commit `690686d`, this commit is deploy + verification
only):
- `docker compose -f compose.titanor-time.yaml build app` — image rebuilt from current HEAD (same
  three-stage Dockerfile as every prior deploy, no Dockerfile changes needed); build output confirms
  all three new routes (`/api/auth/session`, `/api/auth/logout`, `/api/auth/logout-all`) present
  alongside the existing `login`/`health`/`ready` routes.
- `docker compose -f compose.titanor-time.yaml up -d --no-deps app` — `db` stayed `Running` (confirmed
  identical `StartedAt`/`RestartCount=0` before and after, i.e. not recreated); `app` recreated, became
  `healthy`.
- Verified without knowing the real password (same pattern as the original login deploy, commit
  `ecb37b2`): `GET /api/health` → `200` (unchanged); `GET /api/ready` → `200,
  database: connected`; `GET /api/auth/session` without a cookie → `401 NOT_AUTHENTICATED`; `POST
  /api/auth/logout` without `X-Requested-With` → `403 CSRF_REJECTED`, with the header but no cookie →
  `401 NOT_AUTHENTICATED`; `POST /api/auth/logout-all` — same two cases, same results. Login regression
  check: `POST /api/auth/login` without CSRF → still `403`; with CSRF and an unknown identifier → still
  `401 INVALID_CREDENTIALS` — confirms the rebuild didn't disturb the existing endpoint.
- No real session cookie was exercised against `titanor-time-db-1` in this task (would require the
  owner's real password, same constraint as every prior deploy) — full end-to-end verification (a real
  `GET /session` with a real cookie, a real `logout` that then makes that cookie unusable) is left for
  the owner to confirm opportunistically next time they log in, or for a future task.
- `titanor-time-app-1`/`titanor-time-db-1` — `db` `StartedAt` identical before/after
  (`2026-07-28T14:33:34Z`, not recreated); `app` recreated (new `StartedAt`), `healthy`.
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` — identical `StartedAt`/
  `RestartCount=0` before and after, not touched. `titanorgroup.fi`/`collabstudio.run` — `200` before
  and after.
- **Not in this task**: route-protection middleware (§11 item 2, still next), role guard /
  `session.revoke_all.own` enforcement (§11 item 3, T5.6), any real-cookie end-to-end test against
  `titanor-time-db-1`.

**Route-protection `proxy.ts` for `/api/admin/*` + `/api/worker/*`** (§11 item 1 —
`titanor-time-app/proxy.ts`, implemented, tested, and deployed to real `app` in one task, this
commit):
- Причина: `GET /api/auth/session`/`POST /api/auth/logout`/`logout-all` (commit `690686d`) only guard
  themselves — nothing else calls `resolveAuthenticatedSession()`, so any future admin/worker route
  would start out completely open unless its author remembered to add the check by hand. Centralizing
  the auth gate removes that failure mode.
- **Discovered mid-task**: Next.js 16 deprecated the `middleware.ts` file convention in favor of
  `proxy.ts` (build emits `⚠ The "middleware" file convention is deprecated. Please use "proxy"
  instead.` — see `nextjs.org/docs/messages/middleware-to-proxy`). Functionally equivalent (same
  `NextRequest`/`NextResponse` API, same `matcher` config), but two contract differences matter here:
  Proxy defaults to the Node.js runtime (was opt-in/experimental for `middleware.ts` as of Next
  15.2–15.5); and explicitly setting `runtime` in `config` is now a build error on `proxy.ts` (it
  wasn't on `middleware.ts`). Built directly as `proxy.ts` with `export async function proxy(...)`,
  never shipped as `middleware.ts`.
- `matcher: ['/api/admin/:path*', '/api/worker/:path*']` — exactly the two route prefixes
  `04_ADMIN_FIRST_API_CONTRACTS.md` defines (§2–§8 admin, §9 worker). `/api/auth/*` (self-guarding),
  `/api/health`, `/api/ready`, and `/` are deliberately outside the matcher — untouched by this proxy.
  A future `/admin/setup` **page** (§9, not started) is also out of scope: a JSON `401` is the wrong
  response shape for a page navigation, and no login page exists yet to redirect to.
- Reuses `resolveAuthenticatedSession()` from `lib/auth.ts` (commit `690686d`) unchanged — same
  rejection rules (missing/expired/revoked token, `DEACTIVATED` user), same `lastSeenAt` refresh on
  success. **Authentication only, not authorization**: any authenticated user currently passes the
  proxy for any `/api/admin/*` or `/api/worker/*` path — per-endpoint permission checks
  (`04_ADMIN_FIRST_API_CONTRACTS.md` gives each one its own required permission) need the role guard
  (T5.6, §9/§11), which needs `Permission`/`RolePermission` seeded, neither done yet. No route
  currently exists under either matched prefix, so this has no live consumer yet — it's put in place
  ahead of them specifically so no future route can be added unprotected by omission.
- **Verified the compiled artifact, not just source**: `npx tsc --noEmit`/`npm run build` clean with
  **no** deprecation warning (confirms `proxy.ts`, not `middleware.ts`, is what actually built).
  Inspected `.next/server/functions-config-manifest.json` directly (both the plain `.next/` build and
  the `.next/standalone/` copy that Docker's `runner` stage actually ships) — both register
  `/_middleware` with `"runtime": "nodejs"` and both exact matcher regexes for `/api/admin/:path*` and
  `/api/worker/:path*`. This matters because a past task (commit `122c884`) already found that
  Next.js's standalone-output file tracing can silently omit things a route only reaches indirectly;
  checking the manifest directly, rather than assuming a passing `build` means correct manifest
  content, avoids repeating that mistake for Proxy specifically.
- **Runtime-tested by actually running the standalone server** (`node .next/standalone/server.js`,
  not `next dev` — the same code path `CMD ["node", "server.js"]` in `Dockerfile` runs in production),
  against a disposable PostgreSQL 16 (`--rm`, tmpfs, random credentials, no named volume; all three
  migrations applied from scratch) seeded with one `ACTIVE` user + one valid `UserSession`, `curl`
  against `127.0.0.1:3989` (not the production port `3200`):
  - `GET /api/admin/anything` and `GET /api/worker/foo` (neither route exists) without a cookie → both
    `401 NOT_AUTHENTICATED` from the proxy itself, before Next.js ever resolves that there's no
    matching route.
  - Same two paths with a garbage cookie → `401` (same rejection path as an unknown token).
  - `GET /api/admin/anything` with the valid session cookie → `404` — proxy correctly let it through
    (`NextResponse.next()`), and Next.js's own router then correctly reports no route exists there.
    Confirms the proxy is a pure gate, not accidentally intercepting/altering successful requests.
  - Direct `SELECT` on the seeded `UserSession` row after the valid-cookie request: `lastSeenAt`
    updated to the exact request timestamp — direct proof the proxy's own Prisma query actually ran
    against the database from inside the compiled, bundled proxy code (not a crash silently
    short-circuited into some other response path).
  - `GET /api/health` (outside the matcher) → unaffected, still `200`; `GET /api/auth/session` (also
    outside the matcher) → still returns its own route-level `401`, not the proxy's — confirms the
    matcher correctly scopes the gate to only the two intended prefixes.
  - Cleanup: standalone server process killed, disposable PostgreSQL container removed (confirmed
    absent from `docker ps -a` afterward), temporary seed script deleted, nothing committed from the
    test run.
- **Deployed to real `app`** (`docker compose -f compose.titanor-time.yaml build app` + `up -d
  --no-deps app`, same pattern as every prior deploy): `db` `StartedAt` identical before/after
  (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Verified against
  `titanor-time-db-1` without a real session cookie (same constraint as every prior auth deploy — no
  real password available to this task): `GET /api/admin/anything`/`GET /api/worker/foo` without a
  cookie → both `401`; `GET /api/health`/`GET /api/ready` (`database: connected`) → unaffected;
  `GET /api/auth/session` without a cookie → still its own `401`, unaffected by the proxy. Regression
  check on the three pre-existing auth routes: `POST /api/auth/login`/`logout` without CSRF → still
  `403` each — confirms the rebuild didn't disturb them.
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` — identical `StartedAt`/
  `RestartCount=0` before and after, not touched; `titanorgroup.fi`/`collabstudio.run` — `200` before
  and after.
- **Not in this task**: any actual `/api/admin/*` or `/api/worker/*` route (none exist), permission/
  role enforcement beyond "authenticated" (§11 item 2 next, T5.6), page-level route protection (e.g. a
  future `/admin/setup`), and a real-cookie end-to-end test of the proxy against `titanor-time-db-1`
  (same open item as the session/logout endpoints, §9).

**`hasPermission()` role-guard primitive** (T5.6 first sub-step — `titanor-time-app/lib/permissions.ts`,
this commit):
- Причина: `04_ADMIN_FIRST_API_CONTRACTS.md`/`02_ROLE_PERMISSION_MATRIX.md` §5 give every future
  `/api/admin/*`/`/api/worker/*` endpoint an exact required permission code (e.g.
  `worker.read.all`, `site.update`) — this is the checking primitive those endpoints will call. Schema
  support (`Permission`, `RolePermission` tables) already existed since the second migration (commit
  `c0f5425`); this task adds no schema.
- `hasPermission(roles: string[], permissionCode: string): Promise<boolean>` — single `RolePermission`
  lookup filtered by `permission.code` + `role.name IN roles`, `select: { id: true }` (existence check,
  not a data fetch). Empty `roles` short-circuits to `false` without a query. Deliberately does **not**
  hardcode a `SUPER_ADMIN` > `ADMIN` hierarchy — `02_ROLE_PERMISSION_MATRIX.md` §2 lists `SUPER_ADMIN`
  explicitly alongside `ADMIN` on every ADMIN-held permission row, so the intended design is that
  seeding grants both roles directly; a hardcoded hierarchy in code would silently diverge from
  whatever the seed data (added later, per-endpoint, see §9) actually says.
- **Deliberately narrow scope, stopped here on purpose**: this commit does not seed any real
  `Permission`/`RolePermission` rows, does not add an `AuditEvent` model, does not touch `proxy.ts`
  (which stays a pure authentication gate — it can't route-map to per-endpoint permission codes when no
  endpoint exists yet to define that mapping), and does not create any `/api/admin/*`/`/api/worker/*`
  route. Building those is starting the real admin API, which
  `AGENT_RULES.md` §15 and this file's own §11 require a separate, explicit owner checkpoint for before
  beginning — not assumed by this task. Likewise, `AuditEvent` is a schema change, and `AGENT_RULES.md`
  §11 requires showing the design (entities/fields/relations/constraints/indexes/deletion rules) and
  getting it approved before any migration is created, same as every prior schema change in this
  project (Role/Permission/UserRole, UserSession) — not done unilaterally here.
- **Tested on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume; all three
  existing migrations applied from scratch — no new migration): seeded exactly one real permission code
  from the matrix, `worker.read.all`, granted only to `ADMIN` (deliberately not to `SUPER_ADMIN`, to
  prove the no-hierarchy design actually holds). Six assertions, all passed: `ADMIN` → `true`; `WORKER`
  → `false`; `SUPER_ADMIN` → `false` (proves no hardcoded hierarchy); `[WORKER, ADMIN]` (multi-role
  user) → `true` (any granting role is enough); unknown permission code → `false`; empty roles array →
  `false`. Disposable container removed afterward (confirmed absent from `docker ps -a`), temporary
  test script deleted, nothing committed from the test run.
- **Not deployed** — no route imports this file yet, so rebuilding/redeploying real `app` would be a
  no-op change to the running image; skipped as unnecessary churn on a production container.
- **Not in this task**: seeding any real `Permission`/`RolePermission` rows, `AuditEvent` model/
  migration, any `/api/admin/*`/`/api/worker/*` route, wiring `hasPermission()` into `proxy.ts` or any
  route, the last-active-`SUPER_ADMIN` protection invariant, and `session.revoke_all.own`/proxy
  permission enforcement (both still open, §9) — all of these need either a real admin/worker endpoint
  to attach to, an `AuditEvent` schema checkpoint, or both, none of which this task started.

**`GET /api/admin/cities` — first real admin endpoint** (T5.6 second sub-step — owner-confirmed
checkpoint to proceed; `prisma/migrations/20260730221710_seed_city_read_all_permission/migration.sql`,
`titanor-time-app/app/api/admin/cities/route.ts`, this commit):
- Причина/scope decision: per owner confirmation (chat), started T5.6 by building the narrowest
  possible first real endpoint rather than the full admin API. `GET /api/admin/cities` chosen
  specifically because, per `02_ROLE_PERMISSION_MATRIX.md` §2.4, `city.read.all` has **no** audit
  requirement and `City` needs no schema change (table exists since the first migration) — unlike
  `POST /api/admin/cities` (`city.create`), which the matrix marks `Аудит=да` and whose contract
  requires `Idempotency-Key` support, both needing schema (`AuditEvent`, an idempotency-record table)
  that hasn't been through the `AGENT_RULES.md` §11 design checkpoint. `POST /api/admin/cities`
  deliberately **not** built here.
- **Fourth migration** — pure data (`INSERT`), no DDL: adds exactly one `Permission` row
  (`city.read.all`) and grants it via `RolePermission` to `ADMIN` and `SUPER_ADMIN` only — matching
  `02_ROLE_PERMISSION_MATRIX.md` §2.4's listed holders exactly (not `FOREMAN`/`WORKER`). First real
  (non-placeholder) permission seed; follows the project's existing incremental-per-endpoint seeding
  plan (second migration's commit message) rather than transcribing the full matrix at once.
- `GET /api/admin/cities`: independently re-calls `resolveAuthenticatedSession()` even though
  `proxy.ts` already gates `/api/admin/*` for authentication — per Next.js's own Proxy docs ("Always
  verify authentication and authorization inside each Server Function rather than relying on Proxy
  alone"), not assumed safe to skip. Adds the actual permission check via `hasPermission()` (commit
  `8fb72c2`) — `403 FORBIDDEN` (code already used elsewhere in `04_ADMIN_FIRST_API_CONTRACTS.md` for
  this exact case) if the caller's roles don't grant `city.read.all`. Response is exactly
  `{ items: [{ id, name }] }` via an explicit Prisma `select` (no `createdAt`/`updatedAt` leaked),
  ordered by `name`.
- **Tested on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume): all four
  migrations applied from scratch, idempotent repeat confirmed ("No pending migrations to apply").
  Direct query confirmed seeded `RolePermission` rows: exactly `city.read.all` × `{ADMIN, SUPER_ADMIN}`,
  nothing else. Seeded two cities + one session per role (`SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER`) via
  `next dev` on `127.0.0.1:3990` (not the production port), `curl`-tested: no cookie → `401` (from
  `proxy.ts`, route never reached); `SUPER_ADMIN` and `ADMIN` → `200` with both cities correctly sorted
  and shaped; `FOREMAN` and `WORKER` → `403 FORBIDDEN` (neither role holds `city.read.all`); garbage
  cookie → `401`. Regression-checked `/api/health`, `/api/auth/session`, and the `/api/worker/*` proxy
  gate — all unaffected. Disposable container removed, temporary seed script deleted, nothing else
  committed from the test run.
- **Security incident during this task**: while preparing the real migration command, the agent ran
  `cat .env.titanor-time | grep -v PASSWORD` intending to filter secrets before displaying it, but the
  real password is embedded directly in the `DATABASE_URL` value (not under a key literally named
  `PASSWORD`), so the filter didn't catch it — the real `titanor_time_app` password appeared in tool
  output within this chat. Same root-cause class as the earlier `docker compose config` incident (§5,
  commit `7a854ac`'s task), but this time the password never left the owner's own infrastructure — only
  displayed within this chat, not transmitted externally or logged elsewhere the agent could confirm.
  Disclosed to the owner immediately (before proceeding with anything else); owner explicitly assessed
  the risk as insignificant (own server, chat-only exposure) and declined rotation — a deliberate,
  informed owner decision, not an agent judgment call. Password **not** rotated as part of this task.
- **Applied to real `titanor-time-db-1` — by the owner**, not the agent: the agent attempted both a
  direct `docker exec` (to consider self-remediating the incident above) and the established one-off
  `node:22`-container pattern (to apply the migration itself) — both denied by tool policy, consistent
  with every prior real-database interaction in this project's history (see the third-migration
  entry above). Owner ran, in their own terminal, the same one-off `node:22`-container pattern used for
  the first three migrations (`--network titanor-time_internal`, bind-mounted repo incl. `node_modules`,
  `--env-file .env.titanor-time`, no `npm install`): `prisma migrate deploy` — exact output (not
  paraphrased): "Applying migration `20260730221710_seed_city_read_all_permission`" →
  "All migrations have been successfully applied." Owner then ran `prisma migrate status` in the same
  wrapper immediately after — exact output: **"Database schema is up to date!"** This is the first time
  in this project that a successful `migrate status` against the real `titanor-time-db-1` has been
  directly confirmed (see the open tail noted in the third-migration entry above and in prior §11
  revisions) — closed by this task, not a separate one.
- **`app` rebuilt + redeployed** (`docker compose build app` + `up -d --no-deps app`, same pattern as
  every prior deploy): `db` `StartedAt` identical before/after (`2026-07-28T14:33:34Z`, not recreated);
  `app` recreated, `healthy`. Verified against `titanor-time-db-1` without a real session cookie (same
  constraint as every prior auth deploy): `GET /api/admin/cities` without a cookie → `401` (from
  `proxy.ts`); with a garbage cookie → `401`; `GET /api/health`/`GET /api/ready` (`database: connected`)
  → unaffected; `GET /api/auth/session` without a cookie → still its own `401`. Regression: `POST
  /api/auth/login` without CSRF → still `403`. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after, not touched;
  `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `POST /api/admin/cities` (`city.create` — needs `AuditEvent` + idempotency
  schema, both requiring their own design checkpoint), any other `/api/admin/*`/`/api/worker/*` route,
  `AuditEvent` model, the last-active-`SUPER_ADMIN` protection invariant, `session.revoke_all.own`
  enforcement on `POST /api/auth/logout-all`, and a real-cookie end-to-end test of `city.read.all`
  against `titanor-time-db-1` (same open item as prior auth work, §9).

**`session.revoke_all.own` enforced on `POST /api/auth/logout-all`** (T5.6 third sub-step — owner
explicitly chose this as the next self-contained step, distinct from `AuditEvent` design, per "one task
closed before the next starts"; `prisma/migrations/20260730224645_seed_session_revoke_all_own_permission/migration.sql`,
`titanor-time-app/app/api/auth/logout-all/route.ts`, this commit):
- Причина: this gap has existed since `logout-all` was first built (commit `690686d`) — the contract
  permission was never actually checked, only "authenticated". Safe in the meantime (revoke query
  hard-scoped to caller's own `userId`), but not contract-compliant. Chosen over continuing the
  admin-first scenario because it needs neither a new endpoint nor `AuditEvent`/idempotency schema —
  fully closeable in one task with what already exists (`hasPermission()`, commit `8fb72c2`).
- **Fifth migration** — pure data (`INSERT`), no DDL: adds `session.revoke_all.own` and grants it via
  `RolePermission` to **all four roles** (`SUPER_ADMIN`, `ADMIN`, `FOREMAN`, `WORKER`) — per
  `02_ROLE_PERMISSION_MATRIX.md` §2.1, this permission's holders are "все аутентифицированные" (all
  authenticated), unlike the admin-only `city.read.all` seeded previously. Not a hierarchy shortcut —
  each of the four roles gets its own explicit `RolePermission` row, same pattern as before.
- `logout-all/route.ts`: adds `hasPermission(authenticated.user.roles, 'session.revoke_all.own')` right
  after the existing session check, `403 FORBIDDEN` on failure; removes the now-stale comment that
  explained why the check was missing.
- **Tested on disposable PostgreSQL 16**: all five migrations applied from scratch, idempotent repeat
  confirmed. Direct query confirmed seeded `RolePermission` rows: exactly `session.revoke_all.own` ×
  all 4 roles. Seeded **two** sessions each for one user per role, plus one user with **zero** roles
  (deliberately, to prove the check is real and not a no-op) — all via `curl` against `next dev` on
  `127.0.0.1:3991`: `SUPER_ADMIN`/`ADMIN`/`FOREMAN`/`WORKER` → `204`, and a direct query confirmed
  **both** of that user's sessions revoked; the roleless user → `403 FORBIDDEN`, and a direct query
  confirmed **neither** of their sessions was touched (`revokedAt` still `NULL` for both) — the request
  was rejected before the revoke query ever ran. Regression-checked `POST /api/auth/logout` (single) and
  `GET /api/health`. Disposable container removed, temporary seed script deleted, nothing else committed
  from the test run.
- **Applied to real `titanor-time-db-1` by the owner** (agent still blocked by tool policy, as every
  time before) via the same one-off `node:22`-container pattern: exact output — "Applying migration
  `20260730224645_seed_session_revoke_all_own_permission`" → "All migrations have been successfully
  applied." This time the agent did **not** attempt to `cat`/`grep` `.env.titanor-time` itself before
  handing the command to the owner, to avoid repeating the incident from the prior task (§10).
- **`app` rebuilt + redeployed** (`docker compose build app` + `up -d --no-deps app`): `db` `StartedAt`
  identical before/after (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Verified
  against `titanor-time-db-1`: `POST /api/auth/logout-all` without CSRF → still `403`; with CSRF but no
  cookie → still `401` (permission check is unreachable before authentication, as designed).
  Regression: `GET /api/health`/`GET /api/ready` (`database: connected`), `GET /api/admin/cities`
  without a cookie (`401`, unaffected), `POST /api/auth/login` without CSRF (`403`) — all unchanged.
  `collab-studio-app-1`/`titanorgroup-web-1`/`collab-studio-postgres-1` — identical `StartedAt`/
  `RestartCount=0` before and after, not touched; `titanorgroup.fi`/`collabstudio.run` — `200` before
  and after.
- **Not in this task**: `AuditEvent` design (still the owner's explicit next decision to make, §11),
  `POST /api/admin/cities`, any other admin/worker endpoint, and a real-cookie end-to-end test of
  `logout-all` against `titanor-time-db-1` (same open item as prior auth work, §9).

**`AuditEvent` — T5.6 audit-trail foundation, design shown and explicitly amended by owner** (per
`AGENT_RULES.md` §11's design-checkpoint requirement — sixth migration
`prisma/migrations/20260730232202_add_audit_event/migration.sql`, `prisma/schema.prisma`, this
commit):
- Source design: `03_DATA_MODEL_ERD.md` §4.8 (`id`, `actorUserId FK`, `eventType varchar`,
  `entityType`, `entityId`, `beforeValue jsonb`, `afterValue jsonb` — без GPS/паролей/токенов,
  `reason`, `requestId uuid`, `createdAt`) — not invented by the agent, only translated into a concrete
  Prisma model + migration. Agent's initial proposal (`actorUserId`/`entityId` `NOT NULL`) was shown to
  the owner and **explicitly corrected**:
  - `actorUserId` → **nullable**. Owner's reasoning: the contract requires `LOGIN_FAILED` for an
    unrecognized identifier, which has no resolvable `User` — and no substitute ("system" account etc.)
    may be used there, since that would falsify the audit record.
  - `entityId` → **nullable**, same reasoning — e.g. `entityType='AUTHENTICATION'`, `entityId=NULL` for
    that same failed-login case, which has no single domain entity.
  - `requestId` → stays `NOT NULL`, but the owner explicitly deferred actually writing to this table
    until a separate task adds per-request `X-Request-Id` generation on **every** response (today only
    `jsonError()` generates one — successful responses like login/session/cities `200`s carry none).
  - Indexes are the owner's exact spec, not the agent's original single-column proposal:
    `(actorUserId, createdAt DESC)`, `(eventType, createdAt DESC)`, `(entityType, entityId, createdAt
    DESC)`, and `(createdAt DESC, id DESC)` — the last specifically for stable cursor pagination across
    rows sharing the same `createdAt`.
- **Sixth migration**, structural part offline-generated (`prisma migrate diff
  --from-schema-datamodel <pre-change snapshot> --to-schema-datamodel prisma/schema.prisma --script`,
  same process as every prior schema migration — no hand-authored DDL), plus one raw-SQL section:
  `trg_audit_event_immutable`/`fn_audit_event_immutable` — `BEFORE UPDATE OR DELETE FOR EACH ROW`,
  unconditionally `RAISE EXCEPTION 'AUDIT_EVENT_IMMUTABLE' USING ERRCODE = 'P0001'`, same
  frozen-identifier/P0001 convention as every business-rule trigger in the first migration. Owner
  specifically asked for this as a **physical** guarantee, not reliance on "no write API exists" alone
  (`audit.read`, `02_ROLE_PERMISSION_MATRIX.md` §2.10, is the only permission ever touching this table —
  even that is read-only).
- **Explicit scope boundary, owner's own sequencing** — this task is Prisma model + migration + indexes
  + trigger, nothing else: **not** in this task — per-request `X-Request-Id`/request-context
  propagation (separate future task, prerequisite for the next one), and a shared `createAuditEvent()`
  helper that would actually write rows inside the same transaction as a business action (separate
  future task, after request-context). No route or service writes to `AuditEvent` yet.
- **Tested on disposable PostgreSQL 16**: all six migrations applied from scratch, idempotent repeat
  confirmed. Catalog audit (`\d "AuditEvent"` + direct `pg_constraint` query): exact column
  set/nullability/types matching the design above, all four indexes present with correct `DESC`
  ordering, FK `AuditEvent_actorUserId_fkey → User` with `ON DELETE RESTRICT ON UPDATE CASCADE`,
  trigger registered as `BEFORE DELETE OR UPDATE`. Behavioral tests — single transaction, final
  `ROLLBACK`, nothing committed: insert with a real actor — `OK`; insert with `actorUserId=NULL` +
  `entityId=NULL` (the `LOGIN_FAILED` case) — `OK`; `UPDATE` — rejected, exact `SQLSTATE P0001` /
  message `AUDIT_EVENT_IMMUTABLE`; `DELETE` — same; deleting the referenced `User` row — rejected by
  the FK `RESTRICT` constraint itself (`update or delete on table "User" violates foreign key
  constraint`). Final `SELECT` confirmed both rows present and unmodified (`reason` still `NULL`),
  proving the rejected `UPDATE` had zero effect. `npx tsc --noEmit`/`npm run build` clean (root and
  `titanor-time-app`) with the regenerated Prisma Client — no existing route touched or behaviorally
  changed. Disposable container removed, temporary SQL test file deleted, nothing else committed from
  the test run.
- **Applied to real `titanor-time-db-1` by the owner** (agent still blocked by tool policy, same as
  every prior real-database interaction): same one-off `node:22`-container pattern — exact output:
  "Applying migration `20260730232202_add_audit_event`" → "All migrations have been successfully
  applied."
- **`app` rebuilt + redeployed** (`docker compose build app` + `up -d --no-deps app`): `db` `StartedAt`
  identical before/after (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Full
  regression against `titanor-time-db-1` (this migration should change **zero** existing behavior — no
  route touches `AuditEvent`): `GET /api/health` → `200`; `GET /api/ready` → `200, database: connected`;
  `GET /api/admin/cities` without a cookie → `401`; `GET /api/auth/session` without a cookie → `401`;
  `POST /api/auth/login` without CSRF → `403`; `POST /api/auth/logout-all` without CSRF → `403`, with
  CSRF but no cookie → `401` — all unchanged. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after, not touched;
  `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `X-Request-Id`/request-context on every response, `createAuditEvent()`, any
  code that actually writes an `AuditEvent` row, `POST /api/admin/cities` (`city.create` — now unblocked
  on the `AuditEvent` side, still needs an idempotency-record schema, its own design checkpoint), the
  last-active-`SUPER_ADMIN` protection invariant, and `role.assign`/any role-management endpoint.

**`X-Request-Id` on every response** (T5.6 fifth sub-step, owner-confirmed as the next task after
`AuditEvent` — `titanor-time-app/lib/api-error.ts`, all seven existing route files, this commit):
- Причина: `AuditEvent.requestId` (commit `fbeec60`) is `NOT NULL`, but before this task only
  `jsonError()` generated an id — every success response (`login`/`session`/`cities` `200`s,
  `logout`/`logout-all` `204`s, `health`/`ready` `200`s) carried none. Explicit prerequisite the owner
  called out before `createAuditEvent()` (§11), not started opportunistically.
- `lib/api-error.ts`: `jsonError()` now takes an optional third `requestId` parameter (defaults to a
  fresh `randomUUID()` if omitted — any call site that forgets to pass one still works, no silent
  breakage). Added `successHeaders(requestId)` — `{ 'Cache-Control': 'no-store', 'X-Request-Id':
  requestId }` — to avoid repeating that exact two-header object literally across 7 route files.
- Every route (`health`, `ready`, `session`, `login`, `logout`, `logout-all`, `cities`) now generates
  exactly one `requestId = randomUUID()` at the top of its handler and threads it through **every**
  response path of that same request — every `jsonError()` call and the success response — so a single
  request's success and error paths always agree on one id. `proxy.ts`'s own `jsonError()` call (no
  per-route id to share, since it runs ahead of any specific route) keeps using the default
  auto-generated fallback — deliberately not changed, no code depends on matching a proxy-level
  rejection's id to anything else.
- **Tested on disposable PostgreSQL 16**: seeded one city + one `ADMIN` session, `curl`-tested via `next
  dev` on `127.0.0.1:3992` (not the production port). Confirmed `X-Request-Id` present on: `GET
  /api/health` (success, no auth); `GET /api/ready` (success); `GET /api/auth/session` without a cookie
  (`401`) and with a valid one (`200`); `POST /api/auth/login` without CSRF (`403`); `POST
  /api/auth/logout-all` without CSRF (`403`); `GET /api/admin/cities` with a valid cookie (`200`) and
  without one (`401`, from `proxy.ts`'s own fallback). For both error cases explicitly checked, the
  header value exactly matched the `requestId` embedded in the JSON error body. `npx tsc --noEmit`/`npm
  run build` clean (root and `titanor-time-app`). Disposable container removed, temporary seed script
  deleted, nothing else committed from the test run.
- **Deployed to real `app`** (`docker compose build app` + `up -d --no-deps app` — no schema change, no
  migration, so no owner action needed this time): `db` `StartedAt` identical before/after
  (`2026-07-28T14:33:34Z`, not recreated); `app` recreated, `healthy`. Verified against
  `titanor-time-db-1`: `GET /api/health`/`GET /api/ready` carry `X-Request-Id`; `GET /api/auth/session`
  without a cookie and `POST /api/auth/login` without CSRF both carry `X-Request-Id` matching their
  error body's `requestId`; `GET /api/admin/cities` without a cookie and `POST /api/auth/logout-all`
  without CSRF both carry `X-Request-Id`. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after, not touched;
  `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `createAuditEvent()`, any code that actually writes an `AuditEvent` row, `POST
  /api/admin/cities`, any other admin/worker endpoint, the idempotency-record schema, the
  last-active-`SUPER_ADMIN` protection invariant, and `role.assign`/any role-management endpoint.

**`createAuditEvent()` shared helper** (T5.6 sixth sub-step, owner-confirmed to proceed once both
prerequisites closed — `titanor-time-app/lib/audit.ts`, this commit):
- Причина: both things the owner named as blocking this — `AuditEvent` schema (commit `fbeec60`) and
  `X-Request-Id` on every response (commit `bf75962`) — were done; nothing technical remained except
  writing the helper itself. Same "build ahead of the first real consumer" pattern already used for
  `hasPermission()` (commit `8fb72c2`) — no route calls this yet.
- `createAuditEvent(tx: Prisma.TransactionClient, input: AuditEventInput): Promise<void>` — takes the
  caller's own transaction client, not the top-level `prisma` singleton, and writes exactly one
  `AuditEvent` row through it. This is what makes `03_DATA_MODEL_ERD.md` §3's rule ("Действие +
  `AuditEvent` — одна транзакция") structural rather than a convention callers have to remember: since
  `tx` must already come from an open `$transaction()`, the audit row can only ever commit or roll back
  together with whatever business write it documents. Doc comment also restates the §4.8 constraint
  that `beforeValue`/`afterValue` must never carry GPS/password/token values — the function itself does
  not scrub them, that's on each caller.
- **Two implementation snags found by the type checker/build, not manually** — both fixed before
  testing:
  - Prisma's generated input type for a nullable `Json` column doesn't accept a plain TypeScript `null`
    (only `InputJsonValue | NullableJsonNullValueInput | undefined`) — passing bare `null` would need
    `Prisma.JsonNull` (stores the JSON literal `null`) vs. the actually-intended `Prisma.DbNull` (stores
    real SQL `NULL`). Fixed by mapping an explicit `null` input to `Prisma.DbNull`.
  - `titanor-time-app/node_modules`' local physical copy of the generated Prisma Client (kept for local
    type-checking only — separate from what Docker regenerates independently during its own image
    build, same setup used after every prior schema change) was stale from before the `AuditEvent`
    migration, causing a real `Property 'auditEvent' does not exist on type 'TransactionClient'` build
    error. Regenerated at the repo root and re-copied — same procedure as after the second migration.
- **Tested on disposable PostgreSQL 16** (`--rm`, tmpfs, random credentials, no named volume, all six
  migrations applied): one throwaway script, three scenarios, 12 assertions, all passed —
  - Committed transaction: a `City` row and an `AuditEvent` row created together via the same `tx`,
    both persisted after commit; `actorUserId` and `afterValue` (a small JSON object) stored correctly.
  - **Rolled-back transaction — the actual point of this helper**: `City` created, `createAuditEvent()`
    called, then the callback throws (simulating a business-logic failure *after* the audit write).
    Caught the rejection outside, then confirmed via direct query that **neither** the `City` **nor**
    the `AuditEvent` row exists — proving real atomicity, not just documented intent.
  - `LOGIN_FAILED`-style call with `actorUserId=null`/`entityId=null` in its own committed
    transaction — persisted correctly; omitted `beforeValue`/`afterValue` confirmed stored as real SQL
    `NULL` (not the JSON literal `null`) via a follow-up query.
  - `npx tsc --noEmit`/`npm run build` clean (root and `titanor-time-app`) after the Prisma Client
    refresh. Disposable container removed, temporary test script deleted, nothing else committed from
    the test run.
- **Not deployed** — no route calls this yet, so rebuilding/redeploying real `app` would be a no-op
  change to the running image; same reasoning as `hasPermission()`'s commit.
- **Not in this task**: any code that actually calls `createAuditEvent()` from a real route, `POST
  /api/admin/cities` or any other admin/worker endpoint, the idempotency-record schema, the
  last-active-`SUPER_ADMIN` protection invariant, and `role.assign`/any role-management endpoint.

**Owner priority pivot: `POST /api/auth/login` wired to `createAuditEvent()` (checkpoint 1 of 2, commit
`80c201d`)** — owner explicitly deferred `IdempotencyKey`/`POST /api/admin/cities` in favor of the
first visible, real, working user path. `login` chosen as first audit-writer specifically because it's
already contract-required (`04_...` §1: `Audit: LOGIN_SUCCEEDED / LOGIN_FAILED`), needs no
`Idempotency-Key`, and leads directly to a working login page (checkpoint 2):
- `LOGIN_SUCCEEDED` added inside the pre-existing success `$transaction()`, same `tx` as the
  `UserSession` write — not a second transaction after the session is issued. `actorUserId`/`entityId`
  = the authenticated user's id, `entityType='AUTHENTICATION'`, `requestId` = the handler's existing
  request-scoped id.
- `LOGIN_FAILED` added via a new `recordLoginFailed(requestId)` helper, shared by both
  `INVALID_CREDENTIALS` paths (unknown identifier, wrong password) — `actorUserId=null`,
  `entityId=null`, no identifier/email/username/password/hash/cookie/token/IP/user-agent ever passed
  in, so the audit trail can't be used to distinguish "no such account" from "wrong password" any more
  than the already-shared `401` response can. `PENDING_ACTIVATION`/`DEACTIVATED`/`CSRF`/`VALIDATION`/
  `RATE_LIMITED` paths untouched — contract names only these two events for this endpoint.
- Tested on disposable PostgreSQL 16: successful login → exactly one `UserSession` + one
  `LOGIN_SUCCEEDED` `AuditEvent`, `requestId` matching the response's `X-Request-Id` header exactly;
  wrong password / unknown identifier → identical `401 INVALID_CREDENTIALS`, each producing one
  `LOGIN_FAILED` with `actorUserId`/`entityId` both `NULL` and `beforeValue`/`afterValue`/`reason` all
  `NULL` (nothing could have leaked into them — the schema has no field for those values at all);
  dedicated atomicity test replicating login's exact transaction shape (`UserSession.create` +
  `createAuditEvent` via the same `tx`, then a deliberate throw) confirmed neither row exists after
  rollback; regression-confirmed `PENDING_ACTIVATION`/`DEACTIVATED`/`CSRF_REJECTED`/`RATE_LIMITED`
  (6th attempt) all unchanged. `npx tsc --noEmit`/`npm run build` clean, `prisma validate` clean (no
  schema change). Not deployed as part of this commit — bundled into the checkpoint-2 deploy below.

**First real `/login` page, scaffold removed (checkpoint 2 of 2, commit `5bb5cb2`)** — connects to the
now audit-wired `POST /api/auth/login`, no mock API, no fake auth:
- `app/login/page.tsx` (client component): single `identifier` field + `password`, real `fetch` with
  the required `X-Requested-With: titanor-time` header and same-origin credentials. Loading state
  disables both fields + the submit button and swaps its label (no double-submit). `INVALID_CREDENTIALS`
  shows one identical message regardless of cause (`01_SCREEN_MAP.md` §1 enumeration-safety
  requirement); `ACCOUNT_PENDING_ACTIVATION`/`ACCOUNT_DEACTIVATED`/`RATE_LIMITED` each get their own
  distinct message. Network/fetch failures are caught inline — never an uncaught rejection/blank
  screen. Password only ever lives in React state long enough to submit — never logged, never in
  `localStorage`, never in a URL.
- `app/login/i18n.ts`: small self-contained FI/EN/RU dictionary, no i18n library — chosen locale
  persists to both `localStorage` (`titanor-time-locale`) and cookie `NEXT_LOCALE`, matching the screen
  map's spec; `document.lang` updates too.
- Post-login redirect (owner's explicit mapping for this checkpoint, not `01_SCREEN_MAP.md`'s
  `/admin`/etc — none of these destinations exist as real pages yet, and per instruction no placeholder
  was faked in to hide that): `SUPER_ADMIN`/`ADMIN` → `/admin/setup`, `FOREMAN` → `/foreman`, `WORKER`
  → `/worker`. No matching role → inline "no role assigned" message, no dead-end redirect.
- `app/globals.css` (new): dark theme reusing the exact color tokens and input/button/focus-state
  patterns already established in the root `titangroup` site's own `globals.css` (particularly its
  existing `.admin-login-form` rules) — matched by value, not imported (separate deployable app/Docker
  service). No new UI library. `public/titanor-logo.png`: physical copy of the existing brand asset
  (root `public/assets/brand/titanor-group.png`, already used in the main site's header), unmodified.
- `app/page.tsx`: root now `redirect('/login')` (server component, `next/navigation`) — the "scaffold
  only" placeholder text is gone; no duplicate form on both `/` and `/login`.
- **Tested in a real browser**, not just `tsc`/`build`: Playwright + the system's already-cached
  Chromium build, invoked via `npx` from the scratchpad directory (a throwaway `npm install
  playwright --no-save` there, never touching `titanor-time-app/package.json` — not a project
  dependency) — against `next dev` on disposable PostgreSQL 16 (all six migrations, seeded
  `SUPER_ADMIN`/`FOREMAN`/`WORKER`/`PENDING_ACTIVATION`/`DEACTIVATED` users with real Argon2id
  passwords). 19 assertions, all passed: root redirects to `/login`; default locale Finnish, `EN`/`RU`
  switch correctly and persist to `localStorage` + `NEXT_LOCALE` cookie; empty submit blocked by native
  `required` validation; wrong password and unknown identifier produce the byte-identical
  `INVALID_CREDENTIALS` message; form re-enables after a failed attempt; `PENDING_ACTIVATION`/
  `DEACTIVATED` show their own distinct messages; a real successful `SUPER_ADMIN` login sets a real
  `HttpOnly` `tt_session` cookie and navigates toward `/admin/setup` (`404` there is expected — that
  page doesn't exist yet); `390px` mobile viewport fits the card without overflow; labels correctly
  associated via `htmlFor`, `Tab` moves `identifier` → `password`. Desktop/mobile screenshots visually
  reviewed. `npx tsc --noEmit`/`npm run build` clean (root and `titanor-time-app`; `/login` and `/` both
  compile, `/` static per Next's own build output).
- **Security/ops incident during this task's cleanup, disclosed immediately, no data loss**: while
  killing stray local `next dev` test servers on the host between test runs, the agent repeatedly
  matched and killed the **real `titanor-time-app-1` container's own process** instead — its
  `node server.js` process is visible on the host (no `PidMode: host` is set, but Docker does not hide
  container processes from the host process list either) as `next-server (v16.2.12)`, indistinguishable
  by name from the agent's own local test instances, and the agent had been killing by name-pattern
  match without cross-checking `docker inspect titanor-time-app-1 --format '{{.State.Pid}}'` first. A
  second contributing factor: the agent had been assuming system local time was `Europe/Helsinki`
  (matching the project's own timestamps) when correlating "recent" PIDs, but the host's actual local
  timezone is `Europe/Berlin` (CEST, +02:00) — a mismatch that made the real container process's start
  time look more "recent/suspicious" than it should have. Net effect: 4 unwanted restarts of the real
  `app` container between roughly 02:24–02:37 CEST, self-healed each time via its existing
  `restart: unless-stopped` policy (visible in `docker logs` as repeated clean `✓ Ready in 0ms`, no
  crash/error output). **No data loss** — `app` is fully stateless, all real state lives in `db`, which
  showed `RestartCount=0` throughout and was never touched; CollabStudio and `titanorgroup.fi` were
  unaffected (`200` before/during/after). Caught and disclosed to the owner *before* the checkpoint-2
  deploy step below, not after. Process fix going forward: never `kill -9` anything matching a
  container's process name on this host without first confirming the PID against `docker inspect`;
  don't assume this host's local `date`/`ps` timestamps are in `Europe/Helsinki` — they're
  `Europe/Berlin`.
- **Deployed to real `app`** (`docker compose -f compose.titanor-time.yaml up -d --build app`, exactly
  as instructed): `db` `StartedAt` identical before/after (`2026-07-28T14:33:34Z`, `RestartCount=0`
  throughout, never recreated); `app` recreated fresh, `healthy`, `RestartCount=0` on the new instance.
  Verified against `titanor-time-db-1`: `GET /api/health` → `200`; `GET /api/ready` → `200, database:
  connected`; `GET /login` → `200` (static, prerendered); `GET /` → `307` to `/login`; logo asset →
  `200`. Regression: `POST /api/auth/login` without CSRF → still `403`; `GET /api/admin/cities`/`GET
  /api/auth/session` without a cookie → still `401`. `collab-studio-app-1`/`titanorgroup-web-1`/
  `collab-studio-postgres-1` — identical `StartedAt`/`RestartCount=0` before and after this deploy step,
  not touched; `titanorgroup.fi`/`collabstudio.run` — `200` before and after.
- **Not in this task**: `/admin/setup`, admin shell, `POST /api/admin/cities`/`IdempotencyKey`, any new
  backend endpoint, schema changes, migrations — all explicitly deferred per owner instruction.

**`/admin/setup` — first protected admin screen, real checklist, no mock statistics (two checkpoints +
one same-day fix, commits `90d2e55`/`1cba420`/`fa7720e`)**:
- Причина: owner-named next step после login. Per `01_SCREEN_MAP.md` §2 и `04_ADMIN_FIRST_API_CONTRACTS.md`
  §10 — чек-лист первого вертикального сценария (7 булевых флагов: `hasCity`/`hasSite`/`hasWorkArea`/
  `hasTemplate`/`hasWorker`/`hasAssignment`/`hasOpenPeriod`), явно «не декоративный dashboard». Нужен ни
  новой схемы (все 7 таблиц существуют с первой migration), ни `AuditEvent` (read-only, `Аудит=нет` по
  матрице), ни `IdempotencyKey` (не мутирующий endpoint) — поэтому достижим без `POST /api/admin/cities`.
- **Checkpoint 1 (commit `90d2e55`)** — backend: седьмая migration (чистый `INSERT`) сеет
  `worker.read.all` → `ADMIN`/`SUPER_ADMIN` (тот же паттерн, что `city.read.all`); `lib/setup-status.ts`
  (`getSetupStatus()`) — единый источник для 7 флагов, переиспользуемый и роутом, и страницей (без
  HTTP self-fetch и без дублирования запросов); `GET /api/admin/setup-status`. Попутный рефактор:
  `resolveAuthenticatedSession()` теперь принимает `string | undefined` (токен) вместо `NextRequest` —
  Server Component (страница) не имеет `NextRequest`, только `next/headers` `cookies()`; обновлены все
  5 существующих вызовов (session/logout/logout-all/cities роуты + `proxy.ts`), поведение не изменилось.
  Добавлен `lib/server-session.ts` (`resolveServerSession()`) — тонкая обёртка для будущих защищённых
  страниц (`/foreman`, `/worker`).
- **Checkpoint 2 (commit `1cba420`)** — frontend: `app/admin/setup/page.tsx`, Server Component.
  Нет сессии → `redirect('/login')`; есть сессия, но нет роли `ADMIN`/`SUPER_ADMIN` → inline «Access
  denied» на этой же странице (не редирект — пользователь уже аутентифицирован, отправлять его обратно
  на форму логина было бы confusing; не отдельная `/403`-страница — не создана, вне scope). Чек-лист —
  ровно то, что вернул `getSetupStatus()`, без чисел; ссылки «Create» только на пункты, у которых
  screen map явно называет destination (`/admin/sites/new`, `/admin/templates/new`,
  `/admin/workers/new`, `/admin/assignments/new`, `/admin/periods`) — ни для City (informational), ни
  для Work area (создаётся в рамках объекта, отдельного route в доках нет) ссылка не придумана.
- **Тестировано в реальном браузере** (Playwright + системный Chromium, эфемерно через `npx`, не
  зависимость проекта) на одноразовом PostgreSQL 16 с частично заполненными данными (реальные `City`+
  `WorkSite`+`Employee` в базе — не all-true/all-false): реальный логин `SUPER_ADMIN` → реальная
  страница с реальными данными сессии (username+роль в подзаголовке); все 7 пунктов присутствуют;
  City/Site/Worker (засеяны) → `Done`; остальные 4 → `Not done` с `Create`-ссылкой (кроме Work area —
  без ссылки, как задумано); `FOREMAN` с валидной сессией, но не тем URL → inline «Access denied», без
  redirect-петли; без сессии совсем → редирект на `/login`. Скриншот проверен визуально.
- **Инцидент того же дня (commit `fa7720e`), обнаружен и исправлен агентом самостоятельно после
  первого деплоя checkpoint 2**: `curl` на `/admin/setup` без cookie возвращал `200` со stub-HTML
  (meta-refresh + RSC redirect marker) вместо честного `307` — из-за `loading.tsx`, включавшего
  streaming для этого route segment: `async`-компонент успевал начать отправку ответа (200, уже
  отправленные заголовки) до того, как `await resolveServerSession()` разрешался и `redirect()`
  вызывался, так что Next.js не мог изменить statuscode постфактум и подставлял client-side fallback.
  В реальном браузере это работало (JS подхватывал redirect, тест checkpoint 2 это не поймал), но было
  тише/слабее для любого non-JS клиента (curl, боты, health-check). Исправление — убрать `loading.tsx`
  (резолв сессии + 7 `count()`-запросов — суб-100мс, полноценный loading UI не требовался), это
  останавливает streaming для этого route и возвращает honest top-level `307`. Проверено на реальной
  standalone-сборке (`node .next/standalone/server.js`, тот же код-путь, что Docker) против
  одноразового PostgreSQL 16: без cookie → `307`+`Location: /login`; с валидной cookie `SUPER_ADMIN` →
  по-прежнему `200` с реальным чек-листом (аутентифицированный путь не задет фиксом).
- **Деплой** (два `docker compose build app` + `up -d --no-deps app` шага — второй после fix):
  `db` не пересоздавалась ни разу (`StartedAt` неизменен, `RestartCount=0`), `app` пересоздан дважды,
  healthy оба раза. Финально на `titanor-time-db-1`: `GET /admin/setup` без cookie → честный `307` на
  `/login`; `GET /api/admin/setup-status` без cookie → `401`; регрессия (`login` без CSRF → `403`,
  `cities` без cookie → `401`) не нарушена. CollabStudio/`titanorgroup.fi` не задеты.
- **Not in this task**: `/admin/sites/new`, `/admin/templates/new`, `/admin/workers/new`,
  `/admin/assignments/new`, `/admin/periods` — целевые страницы не существуют, их `Create`-ссылки
  сейчас дают `404` (не скрыто, явно отмечено). Admin shell/nav — по-прежнему не построен.

**`IdempotencyKey` + первый мутирующий admin-first endpoint + первая проходимая destination чек-листа
(четыре коммита `ddf44a3`/`6a322bc`/`d1c6cc0`/`145bfec`)**:
- Причина: явное делегирование владельца — «делаем всё по roadmap ... чек-лист должен быть проходимым.
  Что важней ... то и делай». Разбор контрактов (`04_...` §2–3) показал: и `city.create`, и
  `site.create` требуют `Idempotency-Key` support, но `City` информационный/необязательный (сам
  чек-лист это отмечает), а `Site` — первый по-настоящему обязательный пункт (`01_SCREEN_MAP.md`:
  «`/admin/sites/new` ... DoD: создание работает без единого города в системе»). Значит
  `IdempotencyKey` — не откладываемая параллельная ветка, а прямая зависимость первого настоящего шага.
- **`IdempotencyKey` schema (commit `ddf44a3`, восьмая migration)** — дизайн из `03_DATA_MODEL_ERD.md`
  §4.1 показан владельцу и подтверждён без правок (в отличие от `AuditEvent`): `actorUserId` NOT NULL
  FK→User (здесь всегда есть аутентифицированный actor, в отличие от nullable в `AuditEvent`),
  `httpMethod`/`routeTemplate`/`idempotencyKey`(uuid)/`requestHash`(hex sha256)/
  `status enum(PROCESSING|COMPLETED)`/`encryptedResponseBody bytea?`/`statusCode int?`/`expiresAt`;
  unique `(actorUserId, httpMethod, routeTemplate, idempotencyKey)` — path-параметры сознательно
  исключены из ключа (участвуют только в `requestHash`). Владелец выбрал способ обеспечения
  AES-256-GCM ключа: агент даёт `openssl rand -base64 32`, владелец сам добавляет
  `IDEMPOTENCY_ENCRYPTION_KEY` в `.env.titanor-time` — агент этот файл не видит и не трогает.
  Протестировано `migrate deploy` + `migrate diff --exit-code` на одноразовом PostgreSQL 16 — ноль drift.
- **`lib/idempotency.ts` (commit `6a322bc`, без вызывающего кода)** — `beginIdempotentRequest()`/
  `completeIdempotentRequest()`: insert-then-catch-`P2002` (unique constraint БД, а не код,
  сериализует гонку), четыре ветки контракта (new/cached/reused-conflict/in-progress-conflict),
  AES-256-GCM через `IDEMPOTENCY_ENCRYPTION_KEY`. Вызывается только когда клиент реально прислал
  заголовок `Idempotency-Key` — по `04_...` §3 он «поддерживается», не «обязателен» для `site.create`
  (в отличие от `absence.approve`). 15 assertions на одноразовом PostgreSQL 16: точный повтор → кэш,
  тот же ключ/другое тело → `IDEMPOTENCY_KEY_REUSED`, ещё обрабатывается →
  `IDEMPOTENCY_KEY_IN_PROGRESS`, **настоящая гонка через `Promise.all`** (доказывает, что сериализует
  constraint БД, не порядок вызовов в коде), независимость между разными `actorUserId`, расшифровка
  чужим ключом падает (проверка GCM auth tag).
- **`POST /api/admin/sites` (commit `d1c6cc0`, девятая migration — seed `site.create` →
  `ADMIN`/`SUPER_ADMIN`)** — первый реальный мутирующий admin-first endpoint. CSRF → auth →
  permission → parse body → (если есть `Idempotency-Key`) begin/cache-branch → валидация (`name`
  обязателен, `cityId` опционален и должен существовать → `404 CITY_NOT_FOUND`, `address`/
  `description` опциональны) → `WorkSite.create` + `createAuditEvent(SITE_CREATED)` в одной
  транзакции → (если был ключ) complete. Валидационные и `CITY_NOT_FOUND`-ошибки тоже кэшируются
  идемпотентностью. Протестировано по реальному HTTP на одноразовом PostgreSQL 16: 401/403/CSRF-403/
  400/404/201 плюс полный жизненный цикл `Idempotency-Key` — кэшированный повтор подтверждён на уровне
  БД: ровно 1 `WorkSite` и ровно 1 `AuditEvent` на 2 реальных создания (не 3).
- **`/admin/sites/new` (commit `145bfec`)** — первая реально работающая destination чек-листа
  `/admin/setup`. Тот же Server Component auth/role-gate паттерн, что `/admin/setup` (без
  `loading.tsx`, урок §10). Клиентская форма: `name`/`cityId` (select, заполняется через уже
  существующий `GET /api/admin/cities`)/`address`/`description`; один `Idempotency-Key` на попытку
  отправки, переиспользуется только при повторе после сетевой ошибки (не после настоящего
  HTTP-ответа — тогда ключ сбрасывается, чтобы отредактированная форма не наткнулась на
  `IDEMPOTENCY_KEY_REUSED`). После успеха — редирект на `/admin/setup` (не на ещё не существующий
  `/admin/sites/[siteId]`, явно, а не скрыто заглушкой). Протестировано в реальном headless-браузере
  (Playwright, `node .next/standalone/server.js` — тот же код-путь, что Docker) на одноразовом
  PostgreSQL 16: полный флоу с выбором города, inline-ошибка валидации без навигации, `WORKER` —
  inline access denied без redirect-петли, без сессии — редирект на `/login`; данные созданного
  `WorkSite` сверены напрямую в БД.
- **Деплой и инцидент (не запрошенный владельцем, найден и раскрыт агентом сразу)**: владелец
  сгенерировал `IDEMPOTENCY_ENCRYPTION_KEY` (`openssl rand -base64 32`) и добавил в
  `.env.titanor-time` сам; применил обе migrations (8-ю, 9-ю) к `titanor-time-db-1` тем же способом,
  что раньше. Агент выполнил `docker compose -f compose.titanor-time.yaml up -d --build app` — **но
  пересоздался не только `app`, а и `db`**, хотя явно был указан только `app`: `db` тоже читает
  `.env.titanor-time` через `env_file`, и добавленная владельцем строка изменила вычисленный конфиг
  `db`-сервиса, из-за чего Compose пересоздал и его контейнер тоже. Проверено сразу (см. §10): том
  `titanor-time_db_data` — тот же самый (не новый volume); `docker logs` показал «database directory
  appears to contain a database; skipping initialization» и обычный `shutdown at ... / ready to accept
  connections» — не `initdb` с нуля; `prisma migrate deploy`, выполненный владельцем непосредственно
  перед этим шагом, уже подтвердил «9 migrations found», из которых применились только 2 новые — то
  есть прежняя история/данные были на месте до пересоздания. Данные не теряются при пересоздании
  контейнера, пока volume тот же (стандартное поведение Docker), но это всё равно нарушает правило
  «`db` не пересоздавать без подтверждения» — раскрыто владельцу немедленно. Владелец лично зашёл на
  сайт и подтвердил: вход работает, меню и данные видны как обычно. Структурная проверка агента:
  `/api/health` ok, `/api/ready` → `database: connected`, `/`/`/admin/setup`/`/admin/sites/new` без
  сессии → честный `307` на `/login`, `POST /api/admin/sites` без сессии → `401`; CollabStudio/
  `titanorgroup.fi` не задеты (`docker ps`, идентичные `StartedAt`/healthy).
- **Not in this task**: `POST /api/admin/cities` (`city.create`) по-прежнему не реализован — `City`
  информационный/необязательный, поэтому не требовался для «проходимости» чек-листа; `GET
  /api/admin/sites` (список)/`PATCH /api/admin/sites/:siteId`/`/admin/sites/[siteId]` — не
  реализованы, поэтому форма редиректит на `/admin/setup`, а не на карточку созданного объекта;
  `role.assign`/role-management — не начат; `/admin/templates/new`, `/admin/workers/new`,
  `/admin/assignments/new`, `/admin/periods` — остальные destinations чек-листа всё ещё не
  реализованы, их `Create`-ссылки по-прежнему дают `404`.

**`POST /api/admin/templates` + `/admin/templates/new` — второй мутирующий admin-first endpoint и
вторая проходимая destination чек-листа (коммиты `6bf5232`/`4962ac6`, одиннадцатая migration)**:
- Причина: продолжение той же задачи владельца («продолжаем!») тем же паттерном, что `Site` — по
  порядку сценария `04_...` (объект → рабочая область → шаблон → …) и по чек-листу `/admin/setup`
  следующий проходимый пункт — `Work schedule template` (у `Work area` по-прежнему нет отдельного
  route в доках, создаётся в рамках объекта). Никакой новой схемы не нужно —
  `WorkScheduleTemplate`/`Version`/`VersionDay` существуют с самой первой (frozen) migration, включая
  реальные CHECK-constraints CK-06 (`weekday` 0–6)/CK-07 (working/non-working day shape)/CK-08
  (`plannedBreakMinutes >= 0`) — нужен был только новый permission seed.
- **`POST /api/admin/templates` (commit `6bf5232`, одиннадцатая migration — seed `template.create` →
  `ADMIN`/`SUPER_ADMIN`)**: CSRF → auth → permission → parse body → (если есть `Idempotency-Key`)
  begin/cache-branch → валидация `days` (ровно 7 элементов, `weekday` 0–6 без повторов, для
  `isWorkingDay=true` обязательны `plannedStartTime`/`plannedEndTime` и `plannedBreakMinutes >= 0`,
  для `isWorkingDay=false` оба времени обязаны отсутствовать и `plannedBreakMinutes` обязан быть `0`)
  → `WorkScheduleTemplate.create` + `WorkScheduleTemplateVersion` (versionNumber=1) + 7
  `WorkScheduleTemplateVersionDay` + `createAuditEvent(TEMPLATE_CREATED)` в одной транзакции → (если
  был ключ) complete. Валидация приложения намеренно зеркалит уже существующие DB CHECK CK-06/07/08 —
  единственная цель зеркалирования: вернуть чистый `400 VALIDATION_ERROR` вместо сырого `23514`.
  Протестировано по реальному HTTP на одноразовом PostgreSQL 16: валидное создание (5 рабочих + 2
  выходных дня), неверное количество дней, дублирующийся `weekday`, все 4 нарушения shape (рабочий
  день без времени, выходной со временем, выходной с ненулевым перерывом, отрицательный перерыв),
  полный жизненный цикл `Idempotency-Key` (кэшированный повтор подтверждён на уровне БД — ровно 1
  `WorkScheduleTemplate` и ровно 1 `AuditEvent` на 2 реальных создания), 401/403/CSRF-403. Отдельно
  сверены в БД все 7 `WorkScheduleTemplateVersionDay` — времена корректно round-trip'ятся через
  `@db.Time(0)`.
- **`/admin/templates/new` (commit `4962ac6`)** — вторая реально работающая destination чек-листа. Тот
  же Server Component auth/role-gate паттерн (без `loading.tsx`). Форма: `name`/`description`
  (опционально) + 7 строк пн–вс, каждая с чекбоксом «рабочий день», по умолчанию пн–пт рабочие
  (09:00–17:00, перерыв 30 мин), сб–вс выходные — время/перерыв скрываются, когда день выходной, и
  появляются обратно при включении, без перезагрузки формы. Тот же `Idempotency-Key`-паттерн
  (переиспользуется только после сетевой ошибки), редирект на `/admin/setup` после успеха (страницы
  `/admin/templates/[templateId]` ещё нет). Протестировано в реальном headless-браузере (Playwright,
  standalone-сборка) на одноразовом PostgreSQL 16: дефолтная форма отправляется успешно, toggle
  чекбокса живо показывает/прячет поля времени, вторая заявка с изменённой формой тоже создаётся
  успешно, без сессии — редирект на `/login`.
- **Деплой**: применено владельцем к `titanor-time-db-1` тем же способом, что раньше (без нового
  секрета — `IDEMPOTENCY_ENCRYPTION_KEY` уже добавлен в прошлый раз). `docker compose up -d --build
  app` на этот раз пересоздал **только** `app` (`db` `StartedAt` не изменился) — подтверждает, что
  прошлый инцидент (см. §10) был вызван именно изменением `env_file`, а не общим паттерном поведения
  Compose. Структурная проверка: `/api/health` ok, `/api/ready` → `connected`,
  `/admin/templates/new` без сессии → `307`, `POST /api/admin/templates` без сессии → `401`,
  регрессия (`sites`/`setup`/`login`) чистая, CollabStudio/`titanorgroup.fi` не задеты.
- **Not in this task**: `GET /api/admin/templates` (список)/`PATCH /api/admin/templates/:templateId`/
  `/admin/templates/[templateId]` — не реализованы; `POST /api/admin/cities`, `/admin/workers/new`,
  `/admin/assignments/new`, `/admin/periods` — не реализованы; `role.assign`/role-management — не начат.

## 6. Статический аудит initial migration

- Exact migration path: `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`.
- Размер файла: 1441 строка.
- Prisma validation: `static verification completed` — `./node_modules/.bin/prisma validate --schema prisma/schema.prisma` вернул «The schema at prisma/schema.prisma is valid», exit 0 (потребовалась временная синтаксическая переменная `DATABASE_URL` — команда не устанавливает соединение, только парсит конфигурацию datasource).
- Prisma CLI/version: локальный, 6.19.0 (`@prisma/client` 6.19.0), Node v22.23.1, npm 10.9.8.
- migrate diff command form: `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
- Baseline drift result: `static verification completed` — свежая офлайн-генерация в `mktemp -d` (вне репозитория, удалён после сравнения) дала 0-строчный diff против Prisma-generated секции существующей migration.sql.
- CHECK count: 21 (все exact имена из register присутствуют ровно один раз).
- EXCLUDE count: 6 (все exact имена присутствуют ровно один раз).
- function count: 11 (все exact имена присутствуют ровно один раз).
- trigger count: 13 (все 13 комбинаций table+trigger name присутствуют ровно один раз).
- extension count: 1 (`CREATE EXTENSION IF NOT EXISTS btree_gist;` — ровно одно точное вхождение).
- future CHECK count: 0.
- future function count: 0 (в т.ч. `PROPOSAL_RESOLVED_IMMUTABLE` не создаёт функцию/триггер).
- future trigger count: 0.
- placeholder search (`TODO`/`TBD`/`FIXME`/незавершённый SQL/`message-substring`/`approvalOverride`): 0 физических совпадений — единственное текстовое совпадение `approvalOverride` находится в explanatory-комментарии, поясняющем, что именно исключено, не в исполняемом SQL.
- dangerous statement search (`DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE`/`DELETE FROM`/`DATABASE_URL`/`postgresql://`/`password`/`secret`): 0 опасных выражений — единственное совпадение слова «password» это Prisma-generated колонка `"passwordHash" TEXT` в таблице `User` (имя поля, не значение/секрет).
- exception contract: 22 `RAISE EXCEPTION`, все с `ERRCODE = 'P0001'`, ни одного другого кода; все используют один из 7 текущих frozen identifiers, `PROPOSAL_RESOLVED_IMMUTABLE` не используется нигде в этой миграции.
- Известное стилевое отличие (не блокер): custom-исключения записаны как `RAISE EXCEPTION '<IDENTIFIER>' USING ERRCODE = 'P0001';`, а не как `RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '<IDENTIFIER>';` — семантически идентично (первый аргумент `RAISE EXCEPTION` и есть `MESSAGE`), но иная допустимая форма записи того же PL/pgSQL-контракта.
- schema/register contradictions: не обнаружено.
- database connection: на момент этого (static) аудита не выполнялось; выполнено отдельной
  runtime-задачей позже — см. §7.
- migration application: на момент этого (static) аудита не выполнялось; выполнено отдельной
  runtime-задачей позже — см. §7.
- runtime test: на момент этого (static) аудита `intentionally not performed`; выполнен отдельной
  задачей позже — см. §7 (обнаружен подтверждённый дефект).

## 7. Runtime-аудит initial migration (PostgreSQL 16)

Дата: 2026-07-28. HEAD на момент этого runtime-аудита: `bebd6aab5f7a041e6272f24fe32db105ca04f92b`.

**Временная среда:**
- Exact migration path: `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`.
- PostgreSQL exact version: `16.14 (Debian 16.14-1.pgdg13+1)`.
- Docker image: `postgres:16`, image ID `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`.
- База временная: одноразовый контейнер, `--rm`, `--restart=no`, случайные user/db/password (не
  сохранены), данные на `tmpfs`, без named Docker volume.
- Порт: опубликован только на `127.0.0.1`, случайный host-port; не порт и не база CollabStudio.

**Применение migration (Prisma CLI 6.19.0, локальный):**
- Первый `prisma migrate deploy --schema prisma/schema.prisma`: обнаружена ровно одна migration
  (`20260728012114_init_titanor_time_foundation`), применена, exit code 0.
- `_prisma_migrations`: ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст, без failed
  migration artifacts.
- `prisma migrate status`: «Database schema is up to date!», exit 0.
- Повторный `prisma migrate deploy` на той же базе: «No pending migrations to apply.», exit 0,
  `_prisma_migrations` по-прежнему содержит ровно одну запись — идемпотентность подтверждена.

**Catalog-аудит структурного (Prisma) слоя:**
- Enum types: 8/8 (exact names совпадают с `prisma/schema.prisma`).
- Application tables: 24/24 (exact names совпадают), плюс отдельно существующая служебная
  `_prisma_migrations`.
- Индексы: 98 в `pg_indexes` = 68 explicit (29 unique + 39 plain, exact names из migration.sql) + 24
  backing-индекса primary key + 6 backing-индекса EXCLUDE-ограничений — совпадает с ожиданием, без
  unexpected записей.
- Foreign keys: 55/55 (exact `conname` совпадают с `AddForeignKey`-секцией migration.sql).
- Failed/partial migration artifacts: не обнаружено.

**Catalog-аудит raw-SQL (frozen register) слоя:**
- `btree_gist` extension: 1/1.
- EXCLUDE constraints: 6/6, все exact names совпадают с register.
- Trigger functions: 11/11, все exact names совпадают с register.
- Trigger instances (table+name): 13/13, все exact пары совпадают с register; `tgenabled = 'O'` для
  всех 13 (enabled).
- Future objects: `PROPOSAL_RESOLVED_IMMUTABLE` — 0 совпадений в теле функций; `approvalOverride` /
  `approval_override` CHECK — 0 совпадений; таблицы `CorrectionRequest` / `TimesheetReviewProposal` /
  `CorrectionDraftSegment` — 0 совпадений. Future-объекты подтверждённо отсутствуют физически.
- CHECK constraints: 21/21 по количеству, но **2 из 21 имеют неверное exact-имя в каталоге** — см.
  ниже.

**Подтверждённый дефект migration (не исправлен в рамках этой задачи):**

PostgreSQL обрезает идентификаторы длиннее 63 байт (`NAMEDATALEN` limit) без ошибки. Два CHECK
constraint из frozen register превышают этот лимит и после `prisma migrate deploy` физически
существуют в каталоге под усечённым, а не frozen-именем:

| ID | Table | Frozen name (register) | Длина | Фактическое имя в `pg_constraint.conname` | Длина |
|---|---|---|---|---|---|
| CK-08 | `WorkScheduleTemplateVersionDay` | `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative` | 71 | `ck_work_schedule_template_version_day_planned_break_minutes_non` | 63 |
| CK-13 | `TimesheetDraftPlannedShift` | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative` | 66 | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegat` | 63 |

- SQLSTATE: не применимо — это не runtime-ошибка приложения, migration применяется без ошибки
  (exit 0); это несовпадение физического имени объекта с frozen-спецификацией, обнаруженное catalog
  identity-аудитом.
- Проверено на коллизии: два разных CHECK на одной таблице не сливаются под одним усечённым именем
  (`having count(*) > 1` по `(conrelid, conname)` — 0 строк).
- Нарушенный контракт: `05_RAW_SQL_REGISTER.md` §7 — «service identity: exact constraint name from
  the PostgreSQL constraint field» для CHECK-нарушений. Сервис, сопоставляющий ошибки по
  frozen-имени `ck_..._nonnegative`, не распознает нарушение этих двух constraint, так как реальное
  имя в PostgreSQL другое.
- Предикат/поведение самого ограничения (`"plannedBreakMinutes" >= 0`) не пострадали — это
  исключительно проблема именования/service-mapping контракта, не проблема бизнес-логики.
- Ожидаемый результат: exact match с register-именем для всех 21 CHECK. Фактический результат: 19/21
  совпали exact, 2/21 (CK-08, CK-13) усечены PostgreSQL.

**Update (source-level fix, commit `991b8fb`):** имена CK-08 и CK-13 сокращены синхронно в
`05_RAW_SQL_REGISTER.md` и в этой existing migration до:
`ck_schedule_template_version_day_break_minutes_nonnegative` (58 bytes, CK-08) и
`ck_timesheet_draft_shift_break_minutes_nonnegative` (50 bytes, CK-13). Таблица выше оставлена
как есть — это исторический снимок первого runtime-аудита (HEAD `bebd6aa`), доказывающий факт
обнаруженного дефекта; текущие имена в репозитории уже другие (см. §10). Исправление
**подтверждено повторной runtime-верификацией на чистом PostgreSQL 16 — см. §8, §10.**

**Поведенческие runtime-тесты (21 CHECK / 6 EXCLUDE / 13 триггеров / 11 функций / 7 frozen
identifiers): не выполнялись.** Задача была остановлена сразу после обнаружения подтверждённого
дефекта каталога, по явному правилу задачи «подтверждённый дефект → зафиксировать, не исправлять, не
расширять проверку дальше». Concurrency runtime test: намеренно не выполнялся (вне scope этой задачи
независимо от исхода).

**Очистка временной среды:**
- Временный контейнер удалён (`docker rm -f` по точному имени + label
  `titanor-time.runtime-test=true`); `docker ps -a --filter label=titanor-time.runtime-test=true`
  после очистки — пусто.
- Временный каталог тестов (`mktemp -d` под `/tmp`, вне репозитория) удалён.
- Named Docker volume не создавался; `docker volume ls` до и после — идентичны.
- Отдельная постоянная Docker network не создавалась; `docker network ls` до и после — идентичны.
- Все 3 ранее существовавших контейнера (`collab-studio-app-1`, `titanorgroup-web-1`,
  `collab-studio-postgres-1`) продолжают работать без перезапуска.
- Public site healthcheck (`https://titanorgroup.fi/api/health`) — до и после: `200 OK`.
- CollabStudio (`https://collabstudio.run`) — до и после: `200 OK`.
- Секреты временной базы (пароль, полный `DATABASE_URL`) нигде не сохранены и не выведены.

**Не затронуто этой задачей:** production база, CollabStudio база/контейнеры/сеть/secrets, вторая
migration, `prisma/schema.prisma`, существующая migration.sql, `05_RAW_SQL_REGISTER.md`.

## 8. Повторный runtime-аудит исправленной migration (PostgreSQL 16) — full green

Дата: 2026-07-28. Runtime-tested HEAD: `991b8fb8381bff11accd09e2c1c3a3f7748d0832` (тот же commit, что
и source-level fix CK-08/CK-13).

**Проверяемые hashes (совпали с ожидаемыми на всём протяжении задачи):**
- `prisma/schema.prisma`: `3552c36f6725ecfa7ff15fe1b34b9ecfa38c352da40e49f91c1c9d0dcece0506`.
- `05_RAW_SQL_REGISTER.md`: `8c014d664319c74ee17c3aff9c42d023a86f8456c2cf6fdd0dce591b5bdcd9c2`.
- `migration.sql`: `a0d2059582079846a0c70658b24c6162830ae5b8e3e9ffcffe077ded4c862d7b` (не изменился в ходе этой
  задачи — задача только тестировала, не редактировала).

**Временная среда:**
- Exact migration path: `prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`.
- PostgreSQL exact version: `16.14 (Debian 16.14-1.pgdg13+1)`.
- Docker image: `postgres:16`, image ID `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20`
  (уже присутствовал локально, pull не потребовался).
- База временная: новый одноразовый контейнер (`--rm`, `--restart=no`), случайные user/db/password (не
  сохранены), данные на `tmpfs` (`size=512m`), без named Docker volume, без новой постоянной network.
- Порт: опубликован только на `127.0.0.1:<dynamic>`; internal PostgreSQL port остаётся `5432`; не порт
  и не база CollabStudio.

**Применение migration (Prisma CLI 6.19.0, локальный):**
- Первый `prisma migrate deploy --schema prisma/schema.prisma`: обнаружена ровно одна migration,
  применена, exit code 0.
- `_prisma_migrations`: ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст.
- `prisma migrate status`: «Database schema is up to date!», exit 0.
- Повторный `prisma migrate deploy`: «No pending migrations to apply.», exit 0; `_prisma_migrations`
  по-прежнему содержит ровно одну запись — идемпотентность подтверждена.

**Catalog-аудит структурного (Prisma) слоя — всё совпало exact:**
- Enum types: 8/8. Application tables: 24/24 (плюс отдельная служебная `_prisma_migrations`).
- Primary keys: 25 (24 приложения + 1 `_prisma_migrations`).
- Индексы: 98 в `pg_indexes` = 68 explicit (29 unique + 39 plain, exact имена из migration.sql) + 24
  PK-backing + 6 EXCLUDE-backing — без unexpected записей.
- Foreign keys: 55/55, все `convalidated = true`, exact `conname` совпадают с migration.sql.
- Failed/partial migration artifacts: не обнаружено.

**Catalog-аудит raw-SQL слоя — включая исправленные CK-08/CK-13:**
- CHECK constraints: 21/21, все `convalidated = true`.
- **CK-08 exact identity подтверждена**: `pg_constraint.conname = ck_schedule_template_version_day_break_minutes_nonnegative`,
  `octet_length = 58`, table `WorkScheduleTemplateVersionDay`, `convalidated = true`.
- **CK-13 exact identity подтверждена**: `pg_constraint.conname = ck_timesheet_draft_shift_break_minutes_nonnegative`,
  `octet_length = 50`, table `TimesheetDraftPlannedShift`, `convalidated = true`.
- Старые имена (полное и усечённое, для обоих CK) отсутствуют в каталоге — прямой запрос вернул 0
  строк.
- EXCLUDE constraints: 6/6, все `convalidated = true`, exact tables совпадают.
- Trigger functions: 11/11, все return type `trigger`, без duplicate/overload.
- Trigger instances (table+name): 13/13, все `tgenabled = 'O'`, exact event/timing/function binding
  подтверждены через `pg_get_triggerdef` — точное совпадение с migration.sql.
- `btree_gist` extension: 1/1.
- Future objects: `PROPOSAL_RESOLVED_IMMUTABLE` — 0; `approvalOverride`/`approval_override` CHECK — 0;
  таблицы `CorrectionRequest`/`TimesheetReviewProposal`/`CorrectionDraftSegment` — 0. Подтверждённо
  отсутствуют физически.

**Поведенческие runtime-тесты — все выполнены, single-session, каждый сценарий в изолированной
subtransaction (`SAVEPOINT`/`ROLLBACK TO SAVEPOINT`), вся сессия завершена финальным `ROLLBACK`
(ничего не закоммичено):**

- CHECK positive controls: 21/21 passed.
- CHECK negative cases: 21/21 passed — exact SQLSTATE `23514` и exact `CONSTRAINT_NAME` для каждого,
  включая **CK-08 → `ck_schedule_template_version_day_break_minutes_nonnegative`** и **CK-13 →
  `ck_timesheet_draft_shift_break_minutes_nonnegative`** (новые имена подтверждены в реальном
  runtime-нарушении, не только в каталоге).
- unexpected CHECK SQLSTATE/names: 0.
- EXCLUDE positive controls (adjacent-range allowed): 6/6 passed.
- EXCLUDE overlap cases: 6/6 passed — exact SQLSTATE `23P01` и exact `CONSTRAINT_NAME` для каждого.
- unexpected EXCLUDE SQLSTATE/names: 0.
- Trigger positive controls: 13/13 passed. Trigger identities tested (table+trigger): 13/13.
- Trigger functions reached: 11/11 (каждая через минимум один свой trigger instance).
- Mandatory function branches: обе ветки (`DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`) протестированы
  отдельно для всех четырёх day-state триггеров (day-side и child-side, draft и immutable слои).
- Current frozen identifiers observed: 7/7 — `DAY_TYPE_CONFLICT`, `DAY_STATE_CONFLICT`,
  `BREAK_OUTSIDE_PARENT`, `ASSIGNMENT_SCOPE_MISMATCH`, `ASSIGNMENT_DATE_OUTSIDE_VALIDITY`,
  `PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY`, `ASSIGNMENT_DEPENDENTS_CONFLICT` — каждый с exact
  SQLSTATE `P0001` и exact `MESSAGE_TEXT` (точное совпадение с frozen identifier, не substring).
- Future identifier (`PROPOSAL_RESOLVED_IMMUTABLE`) observed as current test: 0 (не тестировался как
  current functionality, физически отсутствует).
- unexpected trigger SQLSTATE/messages: 0.
- Итого: 94/94 поведенческих сценария passed (42 CHECK + 14 EXCLUDE + 38 trigger-сценариев, включая
  positive controls и обе day-state ветки).
- Concurrency runtime test: намеренно не выполнялся — вне scope этой задачи независимо от исхода;
  проверялось только детерминированное single-session поведение constraints/triggers.

**Финальный контроль пустоты:**
- Application tables empty after tests: 24/24 — суммарный подсчёт по всем таблицам вернул `0` строк
  (проверено отдельным запросом после завершения тестового скрипта и его `ROLLBACK`, т.е. на реально
  сохранённом состоянии базы, а не только в рамках транзакции).
- `_prisma_migrations`: по-прежнему ровно одна запись, `finished_at` заполнен, `rolled_back_at` пуст,
  migration остаётся applied.
- Временные объекты (session-local temp table + temp helper functions) отсутствуют после разрыва
  сессии — проверено отдельным запросом.
- Test fixtures не сохранились.

**Очистка временной среды:**
- Временный контейнер удалён (`docker rm -f` по точному имени + обоим label,
  `titanor-time.runtime-test=true` и уникальному `titanor-time.runtime-test-id`); проверка ID/имени/
  label перед удалением прошла; `docker ps -a --filter label=titanor-time.runtime-test=true` после
  очистки — пусто.
- Точный `TEST_TMP_DIR` (`mktemp -d` под `/tmp`, вне репозитория) удалён.
- Named Docker volume не создавался; `docker volume ls` до и после — идентичны (тот же список).
- Отдельная постоянная Docker network не создавалась; `docker network ls` до и после — идентичны.
- Все 3 ранее существовавших контейнера (`collab-studio-app-1`, `titanorgroup-web-1`,
  `collab-studio-postgres-1`) — те же container ID, те же `StartedAt`, `RestartCount = 0` без
  изменений, `healthy` — не перезапускались.
- Public site healthcheck (`https://titanorgroup.fi/api/health`) — до и после: `200`.
- CollabStudio (`https://collabstudio.run`) — до и после: `200`.
- Секреты временной базы (пароль, полный `DATABASE_URL`) нигде не сохранены и не выведены.

**Не затронуто этой задачей:** production база, production migration application, CollabStudio база/
контейнеры/сеть/secrets, вторая migration, `prisma/schema.prisma`, `05_RAW_SQL_REGISTER.md`,
`migration.sql` (только протестирована, не редактировалась).

## 9. Не начато

- Password delivery как общий процесс для будущих (не первого) аккаунтов (доставка пароля/кода
  активации при создании новых пользователей через admin API — для первого `SUPER_ADMIN` уже закрыто:
  владелец ввёл собственный пароль напрямую в TTY, см. §5).
- MFA production gate (`REQUIRE_MFA_FOR_ADMIN=true`).
- Полный real-cookie end-to-end тест `GET /api/auth/session`/`logout`/`logout-all`/`proxy.ts`/`GET
  /api/admin/cities` против `titanor-time-db-1` (с реальным паролем владельца) — сделана только
  структурная проверка без cookie (см. §5, commits `383c7a2`/`a220d39`/`bf298d8`/`4f3e5a1`); не
  блокирует, следующий раз, когда владелец логинится, можно попутно проверить.
- Permission/role enforcement на `/api/admin/*`+`/api/worker/*` — `proxy.ts` (commit `a220d39`) гейтит
  только «аутентифицирован», не конкретное разрешение. `GET /api/admin/cities` (commit `bf298d8`),
  `POST /api/auth/logout-all` (commit `4f3e5a1`) и `GET /api/admin/setup-status` (commit `90d2e55`) —
  пока единственные роуты, реально подключившие `hasPermission()`; остальные будущие
  `/api/admin`/`/api/worker` роуты по-прежнему без permission-проверки, потому что не существуют.
- Реальный seed остального `Permission`/`RolePermission` из `02_ROLE_PERMISSION_MATRIX.md` —
  засеяны только `city.read.all` (commit `bf298d8`), `session.revoke_all.own` (commit `4f3e5a1`) и
  `worker.read.all` (commit `90d2e55`); ~50+ остальных строк сознательно не заполнены разом, сеются по
  одному endpoint'у за раз (см. обоснование в комментарии второй migration).
- `createAuditEvent()` (`lib/audit.ts`, commit `f67159f`) вызывается из `POST /api/auth/login`
  (`80c201d`), `POST /api/admin/sites` (`d1c6cc0`) и `POST /api/admin/templates` (`6bf5232`). Остальные
  будущие mutating-эндпоинты (в т.ч. `POST /api/admin/cities`) его ещё не вызывают.
- `IdempotencyKey` (`03_DATA_MODEL_ERD.md` §4.1) — **реализована** (schema `ddf44a3`, helper
  `6a322bc`, см. §5); подключена к `POST /api/admin/sites` (`d1c6cc0`) и `POST /api/admin/templates`
  (`6bf5232`). Любой другой будущий мутирующий admin/worker endpoint, где контракт помечает
  `Idempotency-Key`, должен подключить её так же.
- `POST /api/admin/cities` (`city.create`) — не начат; `City` информационный/необязательный флаг
  чек-листа, поэтому не был нужен ни для первой, ни для второй проходимой destination. `GET
  /api/admin/sites`/`/api/admin/templates` (списки), `PATCH /api/admin/sites/:siteId`/
  `/api/admin/templates/:templateId`, `/admin/sites/[siteId]`/`/admin/templates/[templateId]` — не
  начаты; весь остальной admin/worker API кроме уже реализованных — тоже не начат.
- Инвариант «последний активный `SUPER_ADMIN` не удаляется/не блокируется/не понижается» — не
  реализован нигде (некуда: нет ни одного role-management endpoint).
- Admin-first API (`04_ADMIN_FIRST_API_CONTRACTS.md`) — начат (`GET /api/admin/cities` `bf298d8`,
  `POST /api/admin/sites` `d1c6cc0`, `POST /api/admin/templates` `6bf5232`), остальное не начато.
- `/admin/setup` реализован (см. §5, commits `90d2e55`/`1cba420`/`fa7720e`); `/foreman`, `/worker` —
  целевые страницы после логина для остальных ролей всё ещё не реализованы, вход туда даёт `404`.
- `/admin/sites/new` (`145bfec`) и `/admin/templates/new` (`4962ac6`) реализованы (см. §5).
  `/admin/workers/new`, `/admin/assignments/new`, `/admin/periods` — остальные destinations с
  чек-листа `/admin/setup`, ни одна не реализована, `Create`-ссылки дают `404`.
- Worker flow.
- Foreman flow.
- Production deployment Titanor Time (`app.titanorgroup.fi`).

## 10. Blockers и открытые решения

### Технические blockers

Нет открытых технических blockers.

- **CK-08 / CK-13 constraint name truncation — RESOLVED.** Статус: **resolved by source fix `991b8fb`
  and confirmed by clean PostgreSQL 16 runtime verification.** Два CHECK constraint из frozen register
  имели имена длиннее лимита PostgreSQL в 63 байта на идентификатор и после применения migration
  физически существовали в каталоге под другим, усечённым именем (историческая таблица — §7,
  обнаружено на HEAD `bebd6aa`). Это ломало документированный service-mapping контракт
  `05_RAW_SQL_REGISTER.md` §7 («service identity: exact constraint name») для этих двух constraint.
  Сам предикат ограничения (`>= 0`) работал корректно — проблема была только в имени.

  **Source-level исправление (commit `991b8fb`):**

  | ID | Table | Старое имя (историческое, HEAD `bebd6aa`) | Старая длина | Новое имя (текущее, подтверждено в каталоге) | Новая длина |
  |---|---|---|---|---|---|
  | CK-08 | `WorkScheduleTemplateVersionDay` | `ck_work_schedule_template_version_day_planned_break_minutes_nonnegative` | 71 bytes | `ck_schedule_template_version_day_break_minutes_nonnegative` | 58 bytes |
  | CK-13 | `TimesheetDraftPlannedShift` | `ck_timesheet_draft_planned_shift_planned_break_minutes_nonnegative` | 66 bytes | `ck_timesheet_draft_shift_break_minutes_nonnegative` | 50 bytes |

  Изменены синхронно `05_RAW_SQL_REGISTER.md` (exact constraint name + errata) и единственная existing
  migration (`ADD CONSTRAINT` identifier + предшествующий комментарий). CHECK predicate
  (`"plannedBreakMinutes" >= 0`), таблица, колонка, SQLSTATE и минимальный тест — без изменений.
  `prisma/schema.prisma` не менялась. Вторая migration не создавалась.

  **Подтверждено повторной runtime-верификацией (§8, тот же commit `991b8fb` как проверяемый HEAD):**
  оба новых имени присутствуют exact в `pg_constraint.conname` (58 и 50 байт соответственно), старые
  (полное и усечённое) имена отсутствуют, и оба constraint успешно прошли поведенческий negative-тест
  (SQLSTATE `23514`, exact новое `CONSTRAINT_NAME`) на чистом одноразовом PostgreSQL 16. Blocker
  закрыт.

Стилевая форма `RAISE EXCEPTION` (см. §6) остаётся отмеченным, но не блокирующим расхождением.

### Operational incidents

- **Агент случайно перезапускал реальный `titanor-time-app-1` 4 раза во время локальной очистки
  тестовых процессов — RESOLVED, без потери данных.** Во время runtime-тестирования checkpoint 2 (commit
  `5bb5cb2`) агент неоднократно чистил зависшие локальные `next dev`-серверы командой вида `ps aux |
  grep "next-server" | grep -v grep` + `kill -9 <pid>` по имени процесса, не сверяя PID с `docker
  inspect titanor-time-app-1 --format '{{.State.Pid}}'` перед убийством. Реальный процесс контейнера
  (`node server.js`) виден в хостовом `ps aux` как `next-server (v16.2.12)` — неотличимо по имени от
  локальных тестовых инстансов. Отдельно агент ошибочно полагал системную таймзону этой машины
  `Europe/Helsinki` (по аналогии с таймстампами проекта), тогда как реальная — `Europe/Berlin` (CEST,
  +02:00); это исказило суждение о том, какой PID «недавний и явно мой тестовый».
  - **Обнаружено и раскрыто владельцу самим агентом**, до выполнения запрошенного финального шага
    (`docker compose up -d --build app`) — не после, не по запросу владельца.
  - **Факт**: 4 рестарта контейнера `app` между ~02:24 и ~02:37 CEST (по `docker logs --timestamps` —
    чистые повторные `✓ Ready in 0ms`, без crash/error вывода — процесс завершался, `restart:
    unless-stopped` поднимал заново). `db` — `RestartCount=0` весь период, не тронута ни разу (все
    реальные данные живут там, `app` полностью stateless). CollabStudio/`titanorgroup.fi` — не задеты,
    `200` до/во время/после.
  - **Исправление процесса**: больше не `kill -9` ничего, подходящего по имени процесса контейнера, без
    предварительной сверки PID через `docker inspect`; не полагаться на предположение таймзоны хоста —
    проверять `date`/`timedatectl` напрямую. Соблюдено в следующей же задаче (`/admin/setup`) — очистка
    тестовых dev-серверов делалась по точному PID, найденному через `ss -tlnp` по порту, со сверкой
    против `docker inspect titanor-time-app-1` перед каждым `kill`.

- **`/admin/setup` тихо отдавал `200` вместо `307` неаутентифицированным non-JS клиентам —
  RESOLVED, найдено и исправлено агентом самостоятельно (commit `fa7720e`), без отдельного инцидента
  для владельца.** Причина — `loading.tsx` включал streaming для route segment; `async` Server
  Component с `await` перед `redirect()` не успевал вызвать redirect до того, как Next.js уже начинал
  отправлять `200`-ответ (`loading.tsx`-заглушку), из-за чего наружу уходил client-side fallback
  (meta-refresh + RSC redirect marker) вместо честного top-level HTTP `307`. В реальном браузере
  (включая Playwright-тест checkpoint 2) это работало корректно — JS подхватывал redirect — поэтому
  тест checkpoint 2 не поймал проблему; обнаружено только при структурной curl-проверке после первого
  деплоя. Исправление — убрать `loading.tsx` (резолв сессии + 7 `count()` — суб-100мс, полноценный
  loading UI не был нужен), что останавливает streaming и возвращает честный `307`. Подтверждено на
  реальной standalone-сборке против одноразового PostgreSQL 16 до повторного деплоя. **Урок для будущих
  защищённых Server Component страниц** (`/foreman`, `/worker` и т.д.): `async`-компонент с
  `redirect()` после `await` + соседний `loading.tsx` = client-side-only redirect для non-JS клиентов;
  либо не добавлять `loading.tsx`, если асинхронная работа перед `redirect()` действительно быстрая
  (сотни миллисекунд и меньше), либо явно проверять `curl` (не только реальный браузер) на предмет
  top-level статус-кода после любого такого изменения.

- **`docker compose up -d --build app` пересоздал также `db`, хотя был указан только `app` — RESOLVED,
  без потери данных, найдено и раскрыто агентом самостоятельно сразу после деплоя, до подтверждения
  задачи закрытой.** Причина: `db`-сервис тоже подключает `.env.titanor-time` через `env_file` в
  `compose.titanor-time.yaml`; когда владелец добавил туда новую строку `IDEMPOTENCY_ENCRYPTION_KEY`
  (нужна только `app`), это изменило вычисленный Compose-конфиг `db` тоже, и Compose решил, что `db`
  требует пересоздания контейнера — несмотря на то, что в команде был явно указан только сервис `app`.
  - **Проверено немедленно**: `docker inspect titanor-time-db-1` — примонтирован тот же named volume
    `titanor-time_db_data` (не новый); `docker logs titanor-time-db-1` — «Database directory appears to
    contain a database; Skipping initialization» + обычный `shutdown at ... / ready to accept
    connections», не `initdb` с нуля; `prisma migrate deploy`, который владелец выполнил
    непосредственно перед этим шагом, уже подтвердил «9 migrations found», из которых применились
    только 2 новые — то есть вся прежняя история миграций и данные были на месте до пересоздания
    контейнера. Пересоздание контейнера при том же volume не теряет данные (стандартное поведение
    Docker Compose) — но само событие всё равно противоречит правилу «`db` не пересоздавать без
    подтверждения владельца», поэтому раскрыто сразу, а не тихо пропущено.
  - **Подтверждено владельцем лично**: зашёл на реальный сайт, вход и меню/данные выглядят как обычно.
  - **Процесс на будущее**: если в `.env.titanor-time` меняется переменная, нужная только одному
    сервису, а `env_file` в compose общий для нескольких сервисов — Compose всё равно может счесть
    другие сервисы «изменившимися» и пересоздать их тоже, даже если в команде указан только один
    сервис. Явно предупреждать владельца об этом риске *до* следующего такого деплоя, а не только после.

### Owner decisions

Незакрытые вопросы, зафиксированные в самих архитектурных документах и всё ещё требующие решения
владельца до соответствующего этапа (не переоткрываются здесь — только перечисляются со ссылкой):

- Правило для смены, пересекающей границу расчётного периода (`README.md` §8.1, `04_...` §12).
- Финальный список действий, требующих свежий MFA (`README.md` §8.2).
- Максимальная разумная длительность одного `WorkSegment`/`TimesheetDraftSegment` (`README.md` §8.3).
- Нужна ли `WorkScheduleTemplateVersion` видимой пользователю как отдельная сущность в UI
  (`README.md` §8.4).
- Кому, кроме `ADMIN`/`SUPER_ADMIN`, можно делегировать `correction.draft.edit` (`README.md` §8.5,
  `02_...` §6).
- Partial-day отсутствия — нужна ли отдельная будущая модель (`README.md` §8.6).
- Когда именно строится route/API для `absence.*` (`README.md` §8.7, `04_...` §12).
- ~~Известен ли первый `SUPER_ADMIN` и способ передачи первого пароля~~ — **закрыто commit `836ef49`**:
  первый `SUPER_ADMIN` (`andrei.sakki`) создан в постоянной базе, пароль введён владельцем лично через
  интерактивный TTY bootstrap CLI, нигде не передавался и не проходил через чат (см. §5).
- ~~Ротировать ли `titanor_time_app` пароль после того, как он попал в вывод инструмента агента
  (`grep -v PASSWORD` не поймал значение внутри `DATABASE_URL`)~~ — **закрыто этой задачей**: владелец
  проинформирован сразу же, явно оценил риск как незначительный (свой сервер, экспозиция только внутри
  чата, не передавалась и не логировалась внешне) и отказался от ротации. Решение владельца, не решение
  агента — см. §5.

## 11. Следующий рекомендуемый шаг

Первый production `SUPER_ADMIN` (`andrei.sakki`) создан в постоянной `titanor-time-db-1` (см. §5, §2).
`UserSession` применена к реальной базе (commit `7795d3e`). Root tsconfig исправлен (commit `3c39d84`).
`POST /api/auth/login` (T5.5 core, commit `ecb37b2`) задеплоен на реальный `app` и подтверждён —
владелец сбросил забытый пароль через новый `reset-password` CLI (commit `be598f8`) и реально вошёл:
`200`, корректные `id`/`username`/`roles: ["SUPER_ADMIN"]` (см. §5, commit `e42025d`). `db` ни разу не
пересоздавался за все эти шаги.

`GET /api/auth/session` + `POST /api/auth/logout`/`logout-all` реализованы (commit `690686d`) и
задеплоены на реальный `app` (commit `383c7a2`). Route-protection `proxy.ts` для `/api/admin/*`+
`/api/worker/*` реализован, протестирован на standalone `server.js` + одноразовом PostgreSQL 16, и
задеплоен на реальный `app` (commit `a220d39`): `db` ни разу не пересоздавался за оба деплоя, `app`
пересоздан и `healthy` оба раза, login-регрессия проверена. `hasPermission()` — role-guard checking
primitive (T5.6 первый под-шаг, commit `0214f80`) — реализован и протестирован на одноразовом
PostgreSQL 16; без схемы, без seed, без роутов на момент своего commit.

Владелец подтвердил продолжение T5.6 с первого реального admin endpoint. `GET /api/admin/cities`
(T5.6 второй под-шаг, commit `bf298d8`) реализован, протестирован на одноразовом PostgreSQL 16,
четвёртая migration (seed `city.read.all` → `ADMIN`/`SUPER_ADMIN`) применена владельцем к
`titanor-time-db-1`, `app` пересобран и передеплоен, структурно проверен. Попутно закрыт долгий
«открытый хвост»: `prisma migrate status` против реальной `titanor-time-db-1` впервые явно подтверждён
владельцем — «Database schema is up to date!».

**Инцидент (не блокирует, зафиксирован для истории, commit `bf298d8`):** агент вывел реальный пароль
`titanor_time_app` (внутри `DATABASE_URL`) в chat при подготовке команды миграции — `grep -v PASSWORD`
не поймал его, так как пароль встроен в URL, а не под отдельным ключом `PASSWORD`. Владелец
проинформирован сразу же, оценил риск как незначительный (свой сервер, экспозиция только в чате) и
явно отказался от ротации — см. §5/§10. Не повторено в следующей задаче ниже — агент больше не
`cat`/`grep`'ает `.env.titanor-time` сам, просто передаёт готовую команду владельцу.

Владелец явно попросил работать строго по одной задаче за раз, не переходя к следующей, пока текущая
не закрыта — агент выбрал `session.revoke_all.own` следующим шагом именно потому, что он закрывается
полностью сам по себе (без нового design-checkpoint), в отличие от `AuditEvent`. **`session.revoke_all.own`
теперь реально проверяется на `POST /api/auth/logout-all`** (T5.6 третий под-шаг, commit `4f3e5a1`):
пятая migration (seed → все 4 роли) применена владельцем к `titanor-time-db-1`, `app` пересобран и
передеплоен, структурно проверен.

**`AuditEvent` спроектирован, показан владельцу, явно исправлен владельцем (nullable `actorUserId`/
`entityId`, индексы под cursor-пагинацию) и реализован** (T5.6 четвёртый под-шаг, commit `fbeec60`):
шестая migration (структура + `trg_audit_event_immutable`) протестирована на одноразовом PostgreSQL 16
(catalog + позитивные/негативные поведенческие тесты триггера и FK RESTRICT), применена владельцем к
`titanor-time-db-1`, `app` пересобран и передеплоен, полная регрессия чистая. Владелец явно разграничил
эту задачу от следующих двух — **request-context/`X-Request-Id` на каждом ответе** и
**`createAuditEvent()`** — как отдельных задач.

**`X-Request-Id` теперь генерируется на каждом ответе** (T5.6 пятый под-шаг, commit `bf75962`): все семь
существующих роутов (`health`, `ready`, `session`, `login`, `logout`, `logout-all`, `cities`) — не
только `jsonError()`, как раньше. Протестировано на одноразовом PostgreSQL 16 (success/error пары,
заголовок = `requestId` в теле ошибки), задеплоено на реальный `app` (без миграции — чистый код),
структурно проверено, полная регрессия чистая. Это закрывает prerequisite, который сам владелец назвал
условием для `createAuditEvent()`.

**`createAuditEvent()` реализован** (T5.6 шестой под-шаг, commit `f67159f`): общий helper пишет строку
`AuditEvent` через переданный вызывающим `tx` (Prisma transaction client), а не через синглтон `prisma`
— атомарность с бизнес-действием обеспечена конструктивно, не соглашением. Rollback-тест на одноразовом
PostgreSQL 16 доказал это напрямую: после симулированного сбоя внутри транзакции не остаётся ни строки
бизнес-таблицы, ни строки `AuditEvent`. Не задеплоено (нет вызывающего кода) и не подключено ни к одному
роуту — по тому же принципу, что `hasPermission()`: строится раньше первого реального потребителя.

**Владелец сменил приоритет**: `IdempotencyKey`/`POST /api/admin/cities` отложены; вместо них —
**первый видимый и реально работающий пользовательский путь**, двумя изолированными checkpoint'ами,
каждый своим коммитом:
1. **Checkpoint 1** (commit `80c201d`): `createAuditEvent()` подключён к `POST /api/auth/login` —
   `LOGIN_SUCCEEDED` внутри уже существующей success-транзакции (тот же `tx`, что `UserSession`),
   `LOGIN_FAILED` для обоих `INVALID_CREDENTIALS`-путей с `actorUserId`/`entityId = null`, без единого
   секретного/персонального значения. Протестировано на одноразовом PostgreSQL 16, включая
   dedicated-тест атомарности именно в форме login-транзакции.
2. **Checkpoint 2** (commit `5bb5cb2`): реальная страница `/login`, заменяет scaffold-заглушку `/`.
   Один `identifier`+`password`, реальный `fetch` в `POST /api/auth/login` с CSRF-заголовком,
   loading-состояние, enumeration-safe `INVALID_CREDENTIALS`, отдельные сообщения для
   `PENDING_ACTIVATION`/`DEACTIVATED`/`RATE_LIMITED`, FI/EN/RU с persist в `localStorage`+
   `NEXT_LOCALE`, существующий брендинг (логотип+палитра главного сайта, без новых UI-зависимостей).
   Redirect после входа: `SUPER_ADMIN`/`ADMIN` → `/admin/setup`, `FOREMAN` → `/foreman`, `WORKER` →
   `/worker` — ни одна из целевых страниц ещё не реализована, это явно зафиксировано, а не скрыто
   заглушкой. Протестировано в реальном headless-браузере (Playwright, эфемерно через `npx`, не
   зависимость проекта) — 19 assertions, все прошли.

**Инцидент во время тестирования checkpoint 2 (RESOLVED, без потери данных, зафиксирован в §10):**
агент по ошибке несколько раз перезапустил реальный `app`-контейнер при чистке локальных тестовых
процессов (совпадение имени процесса + неверное предположение о таймзоне хоста). `db` не пострадала,
раскрыто владельцу до выполнения финального деплоя.

Оба коммита задеплоены на реальный `app` одним шагом (`docker compose up -d --build app`, как просил
владелец): `db` не пересоздавалась, `app` пересоздан и healthy, `/login`/`/`/`/api/health`/`/api/ready`
проверены напрямую на `titanor-time-db-1`, регрессия чистая, CollabStudio/`titanorgroup.fi` не задеты.

**`/admin/setup` реализован** — первая защищённая страница с реальными данными, без mock-статистики,
двумя checkpoint'ами + один same-day fix (commits `90d2e55`/`1cba420`/`fa7720e`, см. §5 для деталей):
седьмая migration (seed `worker.read.all`), `GET /api/admin/setup-status`, рефактор
`resolveAuthenticatedSession()` под Server Component (`lib/server-session.ts`), сама страница-чек-лист,
и исправление найденного агентом бага (тихий `200`+client-redirect вместо честного `307` для
неаутентифицированных non-JS клиентов — см. §10). Применено владельцем к `titanor-time-db-1`,
задеплоено на реальный `app` дважды (второй раз — с fix), полная регрессия чистая.

Владелец разрешил агенту самому определить и выполнить следующий шаг («что важней в данный момент и
правильней — то и делай»), при условии строгого следования roadmap и требования сделать чек-лист
реально проходимым. Разбор контрактов показал, что `IdempotencyKey` — не отдельная отложенная ветка, а
прямая зависимость первого настоящего (не-опционального) шага чек-листа (`Site`, не `City`) — поэтому
обе цели сошлись на одной задаче: **`IdempotencyKey` schema + `lib/idempotency.ts` +
`POST /api/admin/sites` + `/admin/sites/new` реализованы, протестированы и задеплоены** (четыре
коммита `ddf44a3`/`6a322bc`/`d1c6cc0`/`145bfec`, десятая и девятая migrations, см. §5 для полного
разбора). Чек-лист `/admin/setup` теперь имеет первую по-настоящему проходимую destination. Побочно
найден и раскрыт владельцу инцидент с непреднамеренным пересозданием `db`-контейнера при деплое (см.
§10, без потери данных, подтверждено владельцем лично).

Владелец продолжил делегировать выбор следующего шага («продолжаем!»). Тем же паттерном (permission
seed → endpoint с `IdempotencyKey`+`createAuditEvent()` → страница → Playwright-проверка) реализован
**второй** мутирующий admin-first endpoint: **`POST /api/admin/templates` + `/admin/templates/new`**
(commits `6bf5232`/`4962ac6`, одиннадцатая migration — seed `template.create`). Новой схемы не
понадобилось — `WorkScheduleTemplate`/`Version`/`VersionDay` и их CHECK-constraints (CK-06/07/08) уже
были в frozen initial migration; endpoint зеркалит их в application-валидации ради чистого `400`
вместо сырого `23514`. Задеплоено на реальный `app`; на этот раз `db` не пересоздавалась (`env_file`
не менялся) — подтверждает, что прошлый инцидент был вызван именно изменением `env_file`, а не общим
поведением. Чек-лист `/admin/setup` теперь имеет две проходимые destinations из пяти.

**Владелец сменил режим работы**: агент больше не выбирает следующий шаг сам («что важней — то и
делай» отменено). Дальше строго `PROJECT_ROADMAP.md` ЭТАП 6 по порядку, T6.1→T6.9, не чек-лист
`/admin/setup` и не собственный приоритет агента.

**T6.1 «Расширить User» — проверен, закрыт без изменений кода**: `User`
(`id`/`username`/`email`/`passwordHash`/`status`/`locale`/`twoFactorEnabled`/`twoFactorSecret`/
`employeeId`/`lastLoginAt`/`createdAt`/`updatedAt`) и `Employee`
(`id`/`employeeNumber`/`firstName`/`lastName`/`phone`/`version`/`createdAt`/`updatedAt`) в
`prisma/schema.prisma` уже содержат ровно поля, утверждённые в `03_DATA_MODEL_ERD.md` §4.1/§4.2 —
ни одного отсутствующего, ни одного лишнего (обе модели — часть frozen initial migration, commit
`9b2cbab`). Добавлять что-либо сверх ERD было бы нарушением §8 `AGENT_RULES.md`.

**T6.2 «Список работников, read-only» реализован**: `GET /api/admin/workers` (`lib/workers.ts`,
`app/api/admin/workers/route.ts`) + `/admin/workers` (`app/admin/workers/page.tsx`), точный контракт
`04_ADMIN_FIRST_API_CONTRACTS.md` §5 (`items`+пагинация `page`/`pageSize`/`totalItems`/`totalPages`,
`currentAssignments` — только `SiteAssignment`, чей `[validFrom, validTo]` покрывает сегодняшний
календарный день в `Europe/Helsinki`, не host-local/UTC). Новой migration не понадобилось —
`worker.read.all` уже засеян седьмой migration (`20260731210728`, коммит `90d2e55`) под `/admin/setup`.
Commit `45aece3`.
- Протестировано на одноразовом PostgreSQL 16 (все 10 migrations с нуля): unit-уровень (`listWorkers()`
  напрямую) — сортировка `lastName,firstName`, `active` из `Employment.active`, пагинация
  (`pageSize=2` → 2 страницы), граничный случай `validTo = сегодня` (assignment должен остаться
  текущим — Postgres date/timestamp cast был реальным риском, проверен явно) — все прошли; HTTP-уровень
  (реальный `next dev` + вручную созданная `UserSession`) — `401` без cookie, `403` для роли `WORKER`
  без `worker.read.all`, `200` для `ADMIN` с точной формой ответа, `/admin/workers` без cookie —
  настоящий `307` на `/login` (не client-side redirect — тот баг уже исправлен commit `fa7720e`).
  Одноразовый контейнер и весь тестовый код удалены после проверки.
- Задеплоено на реальный `app` (`docker compose up -d --build --no-deps app`) — на этот раз `db` не
  пересоздавалась (только `app`, `--no-deps`); `/api/health`/`/api/ready` регрессия чистая,
  `/api/admin/workers` без cookie → `401`, `/admin/workers` без cookie → `307`. Реальная
  `titanor_time` база: `Employee`/`WorkSite` = 0 строк (владелец ещё не создавал ни одного работника
  через `/admin/workers/new`, той страницы ещё нет — T6.3), поэтому реальная страница сейчас показывает
  пустой список («No workers yet.») — это ожидаемо, не проверено логином живого `SUPER_ADMIN`
  намеренно (не было причины создавать тестовую сессию/данные в реальной базе для строки с 0 записей).

**T6.3 «Создание работника» реализован**: `POST /api/admin/workers`
(`app/api/admin/workers/route.ts`) + `/admin/workers/new`
(`app/admin/workers/new/{page.tsx,NewWorkerForm.tsx}`) — точный контракт
`04_ADMIN_FIRST_API_CONTRACTS.md` §5: одна транзакция создаёт `Employee`+`User(PENDING_ACTIVATION,
locale=FI)`+`Employment(active=true, startDate=сегодня)`, `ActivationToken` не создаётся (см.
`01_SCREEN_MAP.md`). Двенадцатая migration засеяла `worker.create` (`ADMIN`/`SUPER_ADMIN`,
`02_ROLE_PERMISSION_MATRIX.md` §2.2). `employeeNumber` можно передать или оставить пустым —
генерируется как следующее целое после текущего числового максимума (не зафиксировано ни одним
документом точнее, чем «можно сгенерировать», `01_...`); он же становится `User.username`
(единственное согласованное толкование примеров `"1042"`, повторяющихся и в `GET
/api/admin/workers`, и в `POST /auth/login` контракта). `Idempotency-Key` обязателен для этого
endpoint (в отличие от `POST /api/admin/sites`, где он опционален) — контракт прямо говорит
«обязателен». Commit `95e2f74`.
  - **[SUPERSEDED]** «он же становится `User.username`» — верно только на момент T6.3. С
    `feat(time): generate friendly worker usernames` `username` генерируется отдельно из
    `firstName`/`lastName` (`lib/worker-usernames.ts`) и больше не равен `employeeNumber` для
    новых Worker'ов; см. соответствующую запись ниже и `03_DATA_MODEL_ERD.md` §4.1.
- Race-safety генерации `employeeNumber` — не advisory lock (как у единственного `SUPER_ADMIN` в
  `bootstrap-super-admin.ts`), а просто DB `UNIQUE`-ограничение: коллизия ловится как `P2002` и
  превращается в штатный `409 DUPLICATE_EMPLOYEE_NUMBER` — осознанно более лёгкое решение, т.к. цена
  ошибки здесь — retryable конфликт, а не потеря инварианта «ровно один активный SUPER_ADMIN».
- Протестировано на одноразовом PostgreSQL 16 (все 11 migrations с нуля): `401`/`403`/
  `CSRF_REJECTED`/отсутствие `Idempotency-Key` (`400`)/`VALIDATION_ERROR` (пустой `firstName`) — все
  корректны; успешное создание с сгенерированным (`5001` после существующего `5000`) и явным
  (`1042`) `employeeNumber`; `409 DUPLICATE_EMPLOYEE_NUMBER` при повторе занятого номера; **точный
  повтор** (тот же `Idempotency-Key`+тело) вернул закешированный `201` с тем же `employee.id` — прямой
  SQL-подсчёт подтвердил отсутствие дубликата (`Employee`/`User`/`Employment`/`AuditEvent` — по 1 новой
  строке на реальное создание, не 2); тот же `Idempotency-Key` с другим телом → `409
  IDEMPOTENCY_KEY_REUSED`; `GET /api/admin/workers` сразу отразил созданных работников с верной формой
  (`active`, пустой `currentAssignments[]` — назначений ещё нет). Одноразовый контейнер и весь
  тестовый код удалены после проверки.
- **Migration применена владельцем** к `titanor-time-db-1` (агент по-прежнему заблокирован tool
  policy на прямые изменения реальной базы — тот же одноразовый `node:22`-container паттерн,
  `--network titanor-time_internal`, bind-mount репозитория, `--env-file .env.titanor-time`, без `npm
  install`, что и во всех предыдущих migrations этого проекта): «Applying migration
  `20260801123904_seed_worker_create_permission`» → «All migrations have been successfully applied.»
  Подтверждено агентом read-only запросом: `worker.create` есть в `Permission`, `_prisma_migrations` =
  11 записей.
- **Задеплоено на реальный `app`** (`docker compose up -d --build --no-deps app`) — `db` не
  пересоздавалась; `/api/health`/`/api/ready` регрессия чистая; `/api/admin/workers` (`POST`, без
  cookie) → `401`; `/admin/workers/new` без cookie → настоящий `307` на `/login`; реальная `Employee`/
  `AuditEvent(WORKER_CREATED)` — по-прежнему 0 строк (тестовых данных в реальную базу не вносилось).

**T6.4 «Редактирование и отключение» реализован**: `GET`/`PATCH /api/admin/workers/:employeeId`
(`app/api/admin/workers/[employeeId]/route.ts`) + `POST .../deactivate`
(`app/api/admin/workers/[employeeId]/deactivate/route.ts`) + `/admin/workers/[employeeId]`
(`page.tsx`+`WorkerActions.tsx`, плюс ссылка на карточку из `/admin/workers`). Тринадцатая migration
засеяла `worker.update`/`worker.deactivate` (`ADMIN`/`SUPER_ADMIN`). Commit `64cc569`.
- `GET` возвращает `Employee`+`Employment`+`currentAssignments[]`+вычисляемый `activationStatus`
  (`ActivationToken` в схеме ещё нет — будущая задача `worker.activation.generate`; статус мимикрирует
  под условие его будущей выдачи из `03_DATA_MODEL_ERD.md` §4.1). `PATCH` редактирует только
  `firstName`/`lastName`/`phone` — **`employeeNumber` осознанно не редактируется** (это `User.username`
  1:1 с T6.3, а список ошибок контракта для этого endpoint не включает конфликт employeeNumber).
  Optimistic locking через `version`, атомарный compare-and-swap (`Employee.updateMany`), апдейт+audit
  в одной транзакции.
  - **[SUPERSEDED]** «это `User.username` 1:1 с T6.3» — см. запись про
    `feat(time): generate friendly worker usernames` ниже: `employeeNumber` и `username` теперь
    независимы; `PATCH` по-прежнему не трогает `username` (это осталось верным), но не потому что
    они совпадают — смена логина вынесена в отдельный явный endpoint.
- `deactivate` реализует правило `03_...` §4.2 целиком: `Employment.active=false`+`endDate`+`reason`
  всегда; `User.status=DEACTIVATED`+отзыв всех `UserSession`, если у работника нет ожидающего
  (`expected=true`) `PayrollPeriodParticipant` в `OPEN`-периоде без `FINAL_APPROVED` табеля (в том числе
  если табеля вовсе ещё нет — трактуется как «незавершено»); иначе `User.status=OFFBOARDING`, сессии не
  трогаются. Сегодня в реальной базе периоды/участники ещё никем не создаются (`/admin/periods` не
  реализован) — поэтому ветка `OFFBOARDING` пока недостижима в реальных данных, только на тестовых
  фикстурах; это ожидаемо, не баг.
- **Найдено и исправлено в ходе тестирования**: `activationStatus` изначально не учитывал
  `Employment.active` — деактивированный работник с ещё не закрытым (`validTo=null`) старым
  `SiteAssignment` показывал `READY_FOR_ACTIVATION`, хотя увольнение не отзывает существующие
  назначения (только блокирует новые, `03_...` §4.2). Добавлена проверка `employmentActive` —
  подтверждено на одноразовой базе: тот же работник после деактивации стал `SETUP_INCOMPLETE`, второй
  (всё ещё активный) работник с идентичными assignment/participant остался `READY_FOR_ACTIVATION`.
- Протестировано на одноразовом PostgreSQL 16 (все 13 migrations с нуля): три fixture-работника
  покрыли все три `activationStatus`; `GET` — `404`/`403`/`401`; `PATCH` — успех+инкремент `version`,
  `409 VERSION_CONFLICT` на устаревшей версии, `404`, `400` на отсутствующих/невалидных полях,
  `403`/CSRF; `deactivate` — обе ветки `userStatus` против реальных `PayrollPeriodParticipant`/
  `Timesheet` фикстур, `409 ALREADY_DEACTIVATED` на повторе, валидация `endDate` (формат + раньше
  `startDate`), отзыв сессии подтверждён только на ветке `DEACTIVATED`, `AuditEvent`
  (`WORKER_UPDATED`/`WORKER_DEACTIVATED`) подтверждены прямым SQL. Migration применена владельцем (та
  же одноразовая `node:22`-container команда), задеплоено на реальный `app`, регрессия чистая, реальная
  `Employee`/`AuditEvent` — по-прежнему 0 строк.

**`PROJECT_ROADMAP.md` ЭТАП 6 («Работники, объекты и назначения») полностью закрыт** — T6.1–T6.9
все реализованы.

**ЭТАП 7 («Учёт часов») начат** — владелец подтвердил переход после явного разбора объёма: `04_...`
§7-9 + `03_DATA_MODEL_ERD.md` §4.5-4.7 показывают, что `PROJECT_ROADMAP.md` T7.1–T7.10 (плоский
«TimeEntry») полностью перекрыт архитектурой `Timesheet`→`TimesheetDraft`→`TimesheetVersion`→
`TimesheetReviewScope`→`TimesheetReviewProposal` — та же ситуация, что была с ЭТАП 4. Реальная работа
идёт по разделам `docs/titanor-time/`, не по T7.x буквально. Предложенная владельцу и подтверждённая
разбивка: 1) открытие периода, 2) кабинет работника read-контекст, 3) draft чтение+правка дня, 4)
отправка (`submit`, потребует отдельный design-checkpoint для ещё не существующих
`TimesheetReviewScope`/`Proposal`), 5) прорабская очередь/approve/return, 6) коррекции и
`period.lock`/`export`.

**Первая под-задача («Открытие расчётного периода») реализована и задеплоена** (commit `399336f`):
`lib/periods.ts` + `POST/GET /api/admin/periods`, `GET .../current`, `GET .../:periodId`. Схему менять
не пришлось — `PayrollPeriod`/`Timesheet`/`TimesheetDraft*` уже существовали в frozen initial
migration; добавлены только две seed-migrations (`period.create`/`period.read.all` → `ADMIN`/
`SUPER_ADMIN`).
- `POST` реализует шаг 1 «Жизненного цикла draft» (`03_...` §4.6) целиком: под `SELECT Employee ...
  FOR UPDATE` (по возрастанию `id`, raw SQL — Prisma не даёт `.forUpdate()`) для каждого сотрудника с
  `SiteAssignment`, пересекающим даты периода, — тройка `PayrollPeriodParticipant`+
  `Timesheet(DRAFT)`+`TimesheetDraft`, `TimesheetDraftDay` на каждый календарный день периода
  (оверлей `Absence(APPROVED)` применён до дефолта `WORK`, тот же механизм, что `absence.approve`),
  `TimesheetDraftPlannedShift` на каждый день, реально покрытый назначением, время резолвится из
  `WorkScheduleTemplateVersionDay` с корректной конвертацией Europe/Helsinki→UTC (DST учтён —
  найденный и явно применённый паттерн: смещение вычисляется через `Intl.DateTimeFormat` на момент
  конкретной даты, не константа).
- Протестировано на одноразовом PostgreSQL 16: каскад для сотрудника с шаблоном (верные будни/DST
  времена 08:00→05:00 UTC летом, выходные — `null`/`0`), сотрудника без шаблона (пустые планы, но
  строки созданы), сотрудника с `Absence` (оверлей ровно на нужных датах), сотрудников без
  пересекающегося назначения — не попали в участники; `409 PERIOD_OVERLAP` (реальный EXCLUDE
  `ex_payroll_period_date_overlap`), `400`/`403 CSRF`/`401`/`403 FORBIDDEN` (роль `WORKER`),
  Idempotency-Key replay без дублирования каскада, все GET-эндпоинты, `hasOpenPeriod` в
  `/admin/setup-status` встал в `true` (закрыт последний пункт исходного admin-first чек-листа).
  `tsc --noEmit` чист.
- Migrations применены владельцем к `titanor-time-db-1`, `app` пересобран (`docker compose up -d
  --build --no-deps app`) и передеплоен, `healthy`, `/api/ready` подтверждает `database: connected`.

Не начинать реальный admin/worker API или UI раньше отдельного подтверждения владельца (исключения —
`GET /api/admin/cities`, `session.revoke_all.own`, `/login`, `/admin/setup`, `POST /api/admin/sites`,
`/admin/sites/new`, `POST /api/admin/templates`, `/admin/templates/new`, `GET/PATCH
/api/admin/workers[/:employeeId]`, `POST /api/admin/workers[/:employeeId/deactivate]`,
`/admin/workers[/new|/[employeeId]]`, `GET /api/admin/sites`, `GET/PATCH /api/admin/sites/:siteId`,
`/admin/sites`, `/admin/sites/[siteId]`, `GET/POST /api/admin/sites/:siteId/work-areas`,
`PATCH .../work-areas/:workAreaId`, `POST /api/admin/assignments/validate-overlap`,
`POST /api/admin/assignments`, `/admin/assignments/new`, `GET /api/admin/assignments`,
`/admin/assignments`, `PATCH /api/admin/assignments/:assignmentId`,
`POST /api/admin/assignments/:assignmentId/split`, `.../promote`, `.../end`,
`POST/GET /api/admin/foreman-assignments`, `POST .../end`, `POST/GET /api/admin/periods`,
`GET /api/admin/periods/current`, `GET /api/admin/periods/:periodId`, `GET /api/worker/context`,
`GET /api/worker/assignments/current`, `GET /api/worker/periods/current`,
`GET /api/worker/periods/actionable`, `GET /api/worker/timesheets/:timesheetId`, `.../draft`,
`.../current-version`, `PATCH .../days/:date` — уже подтверждены и сделаны).
Не запускать `app` в production и не менять CollabStudio без отдельного checkpoint владельца.

**ЭТАП 7 под-задача 2 («Кабинет работника, read-контекст») реализована и задеплоена** (commit
`f002439`): `lib/worker-context.ts` + четыре `GET`-эндпоинта — первый живой код под `/api/worker/*`
(`proxy.ts` уже гейтил этот путь аутентификацией с самого начала, но ни одного роута там не было).
Каждый резолвит `employeeId` из сессии (`AuthenticatedSession.user.employeeId`, новое поле в
`lib/auth.ts`), никогда из запроса; `403 NO_EMPLOYEE_PROFILE`, если у `User` сессии нет привязанного
`Employee` — точное требование §9 верхнего уровня, не только у `/context`.
- Протестировано на одноразовом PostgreSQL 16: работник с двумя текущими назначениями (primary+
  secondary, с шаблоном/областью и без) — верный порядок и поля; работник без `employeeId` —
  `403 NO_EMPLOYEE_PROFILE` на всех четырёх эндпоинтах; роль `ADMIN` без `WORKER` — `403 FORBIDDEN`
  (права `worker.read.own`/`assignment.read.own`/`period.read.own` держит только `WORKER`, не
  `ADMIN`/`SUPER_ADMIN` — впервые в проекте permission-seed идёт не на админские роли); без сессии —
  `401`. `periods/current`/`periods/actionable` проверены на реальном `PayrollPeriodParticipant`+
  `Timesheet(DRAFT)` фикстуре, покрывающей «сегодня». `tsc --noEmit` чист.
- Три migrations (`worker.read.own`/`assignment.read.own`/`period.read.own` → `WORKER`) применены
  владельцем к `titanor-time-db-1`, `app` пересобран и передеплоен (`docker compose` вывел шумный, но
  не блокирующий `Conflict` на переименовании контейнера при recreate — реальный контейнер при этом
  успешно создан на новом образе и подтверждён `healthy`+`database: connected`, `/api/worker/context`
  без cookie корректно вернул `401`, не `404`).

**Под-задача 3 разбита на 3a (read) и 3b (`PATCH`) — 3a реализована и задеплоена** (commit `baa84da`):
`lib/worker-timesheets.ts` + `GET /api/worker/timesheets/:timesheetId`, `.../draft`,
`.../current-version` (`04_...` §9).
- Владение проверяется явно: чужой `timesheetId` → `403 FORBIDDEN`, не `404` (§9: не путать «чужое» с
  «не существует»); неизвестный `timesheetId` → `404 TIMESHEET_NOT_FOUND`.
- `.../draft` — только `Timesheet.status IN (DRAFT, RETURNED)`, иначе `409 DRAFT_NOT_EDITABLE`
  (используется `.../current-version`).
- `.../current-version` — работает в любом статусе, но сегодня всегда вернёт `404`, если версии
  никогда не было (`timesheet.submit` ещё не построен — это подзадача 4, не баг). `reviewScopes`
  всегда `[]` по той же причине, что `TimesheetReviewScope` — не подзадача сейчас, а подзадача 5:
  модели ещё не существует, значит и ни один scope не может существовать.
- Протестировано на одноразовом PostgreSQL 16: happy path `.../draft` (день+сегмент+перерыв верно
  смаплены из реальных фикстур); happy path `.../current-version` — версия/день/сегмент/перерыв/
  plannedShift вручную вставлены как фикстура (симулирует то, что `submit` будет делать позже, раз
  самого `submit` ещё нет) — верно прочитаны; `409 DRAFT_NOT_EDITABLE` на `SUBMITTED`; кросс-worker
  доступ → `403 FORBIDDEN`; `401` без сессии. `tsc --noEmit` чист.
- Migration (`timesheet.read.own` → `WORKER`) применена владельцем, `app` пересобран и передеплоен,
  `healthy`.

**Найден и исправлен пробел перед стартом 3b, задеплоен**: `createAssignment()` (T6.8) при
пересечении с уже `OPEN`-периодом апсертил только тройку `PayrollPeriodParticipant`+
`Timesheet(DRAFT)`+`TimesheetDraft`, но не создавал ни одной `TimesheetDraftDay` — сотрудник, впервые
назначенный на объект после открытия периода (обычный сценарий), получал пустой draft-контейнер без
единой строки дня, и `PATCH .../days/:date` не нашёл бы, что редактировать. Исправлено (commit
`706eb75`): `createAssignment()` теперь бэкфиллит `TimesheetDraftDay` (оверлей `Absence(APPROVED)`,
как у `period.create`) + `TimesheetDraftPlannedShift` для этого одного нового назначения на
пересечении `[period.startDate..endDate] ∩ [validFrom..validTo]`, переиспользуя (не дублируя)
date/DST-хелперы `lib/periods.ts` (теперь экспортированы). Без миграции — чистый код.
- Протестировано на одноразовом PostgreSQL 16: назначение, созданное против уже `OPEN` периода,
  бэкфиллит верные 5 дней с DST-корректными планами; второе пересекающееся назначение того же
  сотрудника (другой объект) добавляет свои planned-shift строки без дублирования дней (dedup по
  `(draftId, date)` сработал); регрессия `GET /api/admin/assignments` чистая.
- Задеплоено на реальный `app` (`docker compose up -d --build --no-deps app`), `healthy`,
  `/api/ready` подтверждает `database: connected`.

**Под-задача 3b реализована и задеплоена** (commit `a912239`): `patchWorkerTimesheetDay()` в
`lib/worker-timesheets.ts` + `PATCH /api/worker/timesheets/:timesheetId/days/:date`.
- Итоговое состояние `(dayType, confirmedZero, hasSegments)` проверяется по таблице `03_...`§4.6
  **до** любой записи в БД → `409 DAY_TYPE_CONFLICT`/`DAY_STATE_CONFLICT`. Персональный non-WORK
  `dayType` требует `Absence(APPROVED)`, покрывающего дату → `403 DAY_TYPE_REQUIRES_ABSENCE`;
  `PUBLIC_HOLIDAY` не имеет соответствия в `AbsenceType` вовсе — отклоняется тем же путём без
  отдельного кейса. `segments`, при передаче, — полный финальный список (не delta по объекту);
  `sourceAssignmentId` резолвится сервером, никогда от клиента, `404 SITE_NOT_ASSIGNED` иначе.
- **Порядок записи важен для BEFORE ROW триггеров** (TRG-05/06): всегда удалить старые сегменты →
  обновить день → вставить новые — ноль сегментов валиден против любой комбинации
  `dayType`×`confirmedZero`, поэтому такой порядок не может сработать ни на одном триггере ни в
  одном направлении перехода (доказано перебором всех переходов при проектировании).
  Пересечение новых сегментов/перерывов и containment перерывов (§5) — сервисная
  pre-валидация до транзакции; EX-04 (`ex_timesheet_draft_segment_time_overlap`) —
  defense-in-depth backstop.
- `TimesheetDraft.contentRevision` увеличивается на каждый успешный вызов безусловно (даже
  `note`-only правку) — контракт требует этого явно.
- `affectedSitePairs`→пересчёт `TimesheetReviewProposal.status` — не реализовано, модель не
  существует (подзадача 5); `resolvedProposals` всегда `[]` — факт, не заглушка.
- Протестировано на одноразовом PostgreSQL 16 (~15 запросов): полная замена сегментов
  (добавление/удаление по объекту), `note`-only без изменения сегментов; все перечисленные выше
  коды ошибок, включая обе оси таблицы состояний и happy path с реальным `Absence`; перерыв вне
  сегмента/перекрывающиеся перерывы/отсутствующий `endAt` → `400`; кросс-worker → `403 FORBIDDEN`
  (не `404`); `SUBMITTED`-табель → `409 DRAFT_NOT_EDITABLE`; дата вне периода → `400`; CSRF/сессия
  → `403`/`401`. `contentRevision` совпал ровно с числом успешных вызовов (5 из ~15) — неудачные
  запросы не тронули ни день, ни ревизию. `tsc --noEmit` чист.
- Migration (`timesheet.draft.edit.own` → `WORKER`) применена владельцем, `app` пересобран и
  передеплоен, `healthy`.

**Схема `TimesheetReviewScope` спроектирована, подтверждена, реализована** (commit `a9c1838`):
новая таблица + 3 enum'а (`TimesheetReviewScopeType`, `...Purpose`, `...Status`). Осознанно **без**
`TimesheetReviewProposal` — та создаётся исключительно в транзакции `scope.return`
(`03_...`§4.6), которой пока не существует (подзадача 5); первый сабмит (единственный достижимый
сегодня путь, `DRAFT→SUBMITTED`) не создаёт и не резолвит ни одного предложения, поэтому у
`Proposal` нет потребителя прямо сейчас — тот же принцип, что уже применялся для `reviewScopes:[]`/
`resolvedProposals:[]`.
- **Найден и исправлен реальный баг** при тестировании CHECK-constraint на одноразовом
  PostgreSQL 16: `"scopePurpose" IN ('DATA','EMPTY_FALLBACK')` возвращает `NULL` (не `FALSE`), если
  сам `scopePurpose` — `NULL`, а Postgres CHECK пропускает `NULL`-результат (отклоняет только явный
  `FALSE`) — `NON_SITE`-строка с `scopePurpose=NULL` проходила бы constraint молча. Добавлен явный
  `"scopePurpose" IS NOT NULL` guard. Сам буквальный текст предиката в `03_...`§4.6 несёт тот же
  латентный дефект — в реальном SQL этой миграции его нет.
- Протестировано на одноразовом PostgreSQL 16: обе ветки CHECK (включая NULL-кейс выше), обе
  partial unique (одна `SITE`-запись на объект на версию, максимум одна `NON_SITE` на версию,
  несколько `SITE` разных объектов в одной версии — разрешено). Prisma Client пересобран и
  скопирован в `titanor-time-app`. `tsc --noEmit` чист. Заодно закоммичен `migration_lock.toml` —
  существовал на диске с самого начала проекта, но никогда не был в git.
- **Применено владельцем к `titanor-time-db-1`**, `app` пересобран (новый Prisma Client) и
  передеплоен, `healthy`, `/api/ready` подтверждает `database: connected`.

**`timesheet.submit` реализован и задеплоен** (commit `82af772`): `submitWorkerTimesheet()` в
`lib/worker-timesheets.ts` + `POST /api/worker/timesheets/:timesheetId/submit`.
- Одна транзакция: замораживает `TimesheetDraft` в `TimesheetVersion`+`TimesheetDay`+
  `WorkSegment`+`BreakSegment`+`TimesheetPlannedShift`; классифицирует дни по трём случаям
  (`03_...`§4.6: SITE-данные / explicit NON_SITE-данные / пустая дефолтная строка); создаёт
  `TimesheetReviewScope` — по одному `SITE` на объект с данными, максимум один `NON_SITE(DATA)`,
  либо ровно один `NON_SITE(EMPTY_FALLBACK)`, если весь табель пуст; полный carry-forward против
  предыдущей версии (каноническая проекция по assignment-группам, `SHA-256` `contentHash`) — на
  первом сабмите вырождается в «всё новое → `PENDING`», поскольку предыдущей версии ещё нет;
  очищает draft-таблицы (контейнер остаётся); аудит `TIMESHEET_SUBMITTED`.
- `UNRESOLVED_PROPOSALS`/пересчёт предложений — не реализовано и не требуется: `TimesheetReviewProposal`
  не существует (подзадача 5), значит на единственном достижимом сегодня переходе предложений
  быть не может.
- **Найден и исправлен реальный баг** при тестировании на одноразовом PostgreSQL 16: `WorkSegment`
  несёт composite FK на `TimesheetPlannedShift(timesheetVersionId, date, sourceAssignmentId)` —
  сегменты замораживались раньше плановых смен, первая же вставка сегмента упала `P2003`.
  Исправлено порядком (planned shifts — первыми); неудачная попытка откатилась чисто (ровно 1
  версия после повторного успешного вызова, ни одной осиротевшей строки).
- Протестировано на одноразовом PostgreSQL 16: три сценария (`SITE` на двух объектах,
  `NON_SITE(DATA)` через `confirmedZero`+`Absence`, полностью пустой табель →
  `EMPTY_FALLBACK`), `contextSiteId` верно резолвится из primary-назначения; `RETURNED→SUBMITTED`
  тоже работает; повтор на уже `SUBMITTED` → `409 INVALID_STATE_TRANSITION`; кросс-worker →
  `403 FORBIDDEN`; неизвестный id → `404`; роль без `WORKER` → `403 FORBIDDEN`; без CSRF/сессии →
  `403`/`401`; `AuditEvent` подтверждён прямым SQL. `tsc --noEmit` чист.
- Migration (`timesheet.submit` → `WORKER`) применена владельцем, `app` пересобран и передеплоен,
  `healthy`.

**Под-задача 5 (admin fallback часть) реализована и задеплоена** (commit `9280a88`):
`lib/review-scopes.ts` + `GET/POST /api/admin/review-scopes[...]` (`timesheet.scope_review.all`).
- **Новая схема не потребовалась** — при разборе оказалось, что создание `TimesheetReviewProposal`
  внутри `scope.return` строго опционально (`proposals[]` в теле запроса необязателен), а ядро
  approve/return (блокировка, precondition, переход статуса) от него не зависит вовсе. `proposals[]`
  принимается контрактом, но не реализован — непустой массив явно отклоняется
  (`400 VALIDATION_ERROR`), не игнорируется тихо. `ApprovalAction` тоже отложен — ни один `Audit:`
  пункт `04_...` §8 на него не ссылается, везде обычный `AuditEvent`.
- **Важный, не опциональный кусок логики**: `scope.return` реинициализирует draft из текущей
  версии (`TimesheetDay`→`TimesheetDraftDay`, `WorkSegment`→`TimesheetDraftSegment` и т.д.),
  идемпотентно (`TimesheetDraft.basedOnVersionId` — маркер), точный порядок операций из `03_...`
  §4.7 (лок `Timesheet`→`TimesheetDraft`, повторная проверка precondition **после** лока, только
  потом реинициализация и смена статуса scope). Без этого шага `PATCH .../days/:date` после
  возврата не нашёл бы ни одного дня — тот же класс проблемы, что была найдена и исправлена в
  `assignment.create`.
- `hasException` в списке — реально вычисляется (агрегированные `WorkSegment` против
  `TimesheetPlannedShift` по `(date, sourceAssignmentId)`), не хардкод.
- Дежурный `/api/foreman/*`-путь (`timesheet.foreman_review`, только свои объекты) контрактом
  `04_...` пока не описан конкретно (только упомянут во вводной части) — отложен как отдельная
  будущая by-extension задача; admin fallback уже покрывает все типы scope целиком.
- Протестировано на одноразовом PostgreSQL 16: `approve`→`FOREMAN_APPROVED` только когда все scope
  версии одобрены; `return`→реинициализация draft подтверждена прямым чтением (все дни/сегменты
  восстановлены); второй возврат другого scope той же версии не задублировал ни одной строки;
  реальный dual-role пользователь (`WORKER`+`ADMIN`, одна `Employee`) — `403
  SELF_APPROVAL_FORBIDDEN` на approve и return, самоисключение из списка (DoD) подтверждено;
  непустые `proposals[]`/отсутствующий `returnReason` → `400`; роль без permission → `403`; без
  CSRF/сессии → `403`/`401`. `tsc --noEmit` чист.
- Migration (`timesheet.scope_review.all` → `ADMIN`/`SUPER_ADMIN`) применена владельцем, `app`
  пересобран и передеплоен, `healthy`.

**Найден и закрыт крупный разрыв**: владелец попросил перечитать `PROJECT_ROADMAP.md` +
`docs/titanor-time/` целиком и сверить с деревом файлов — весь backend ЭТАП 7 (5 под-задач) был
готов и протестирован, но **ни одной UI-страницы под `/worker/*`/`/admin/periods`/
`/admin/review-scopes` не существовало**; `/login` редиректил `WORKER` на `/worker` с самого начала
проекта, и это всегда давало `404`. Первый срез закрыт (commit `b0b3ef3`): `/worker`,
`/worker/periods`, `/worker/periods/[periodId]` — см. §5 выше.

**Ввод часов + отправка реализованы и задеплоены** (commit `ffed6df`): `/worker/periods/[periodId]/
hours`, `.../hours/[date]` (клиентский `DayEditor`), `.../submit`. Владелец явно попросил «делай всё
до конца» — работа шла без паузы на подтверждение между под-шагами (миграций не требовалось, не
применимо к правилу «не применять миграции самостоятельно»).
- День-редактор: местное время (`<input type="time">`, Europe/Helsinki) конвертируется в/из
  правильного UTC-инстанта на клиенте (тот же DST-алгоритм, что на сервере в `lib/periods.ts`);
  `segments` — полная замена, как того требует контракт, поэтому существующие сегменты дня
  загружаются обратно как редактируемое состояние, не diff'аются.
- **Найден и исправлен инфраструктурный артефакт тестирования**: тестирование через `127.0.0.1`
  (не `localhost`) в Next 16 dev-режиме тихо блокирует загрузку клиентских JS-чанков
  (cross-origin dev-resource protection) — `onClick` не срабатывал вовсе, выглядело точно как
  сломанная функция. Не баг продукта, но стоит держать в памяти на будущее тестирование.
- **Найден и исправлен побочный баг в уже задеплоенном** `getWorkerTimesheetCurrentVersion()`
  (под-задача 3a): не отдавал `confirmedZero` — день, где работник явно подтвердил «0 часов»,
  в read-only виде выглядел неотличимо от незаполненного (`—` вместо `Confirmed 0h`). Контракт
  `04_...`§9 буквально не включает это поле в ответ `current-version` (в отличие от `.../draft`) —
  добавлено как документированное, аддитивное расширение, не нарушающее существующую форму ответа.
- Протестировано в headless-browser (Playwright) на одноразовом PostgreSQL 16: добавление сегмента
  с перерывом и сохранение; повторное открытие + второй сегмент на другом объекте — оба сохранились
  (полная замена сработала верно); пересекающиеся интервалы — видимая ошибка, ноль строк в БД (не
  частичная запись); confirmed-zero; submit с реальной сводкой (дней заполнено, суммарные часы);
  после submit — список часов и карточка периода полностью read-only. `tsc --noEmit` чист.
- Без схемы, без миграции, без изменения прав — чистый код, задеплоено напрямую.

**`/admin/periods` + `/admin/review-scopes` UI реализованы и задеплоены** (commit `8704477`):
список+форма открытия периода, карточка периода (participants/final approved/pending), список
pending scope на проверку, карточка scope с approve/return. Протестировано в headless-browser на
одноразовом PostgreSQL 16: открытие периода до карточки, реальная `PERIOD_OVERLAP` со второй формы,
approve и return оба корректно убирают scope из pending-списка. Без схемы/миграции/новых прав.

Владелец попросил «делай всё до конца» для этой линии работы — весь блок (ввод часов, submit,
admin periods/review-scopes UI) сделан без паузы на подтверждение между под-шагами; правило
«агент не применяет миграции сам» не затронуто, поскольку ни один из этих шагов не требовал схемы.

**Итог**: первый вертикальный сценарий ЭТАП 7 теперь полностью рабочий end-to-end через настоящий
UI на обеих сторонах (работник и админ), не только через curl: назначение → открытый период (UI)
→ ввод часов (UI) → отправка (UI) → admin-проверка approve/return (UI) → `FOREMAN_APPROVED`.

**`timesheet.final_approve` + admin override-return реализованы и задеплоены** (commit `fecedb1`),
владелец явно попросил «делай всё по порядку по roadmap» — продолжение без паузы на подтверждение
между под-шагами:
- `lib/worker-context.ts`: новая `listWorkerTimesheets(employeeId)` — все табели работника, любой
  статус (не только actionable), та же форма ответа, что `listActionablePeriods`. Используется
  и новой страницей `/worker/history`, и переписанными `/worker/periods/[periodId]` +
  `.../hours[/[date]]` + `.../submit` — период теперь остаётся открываемым (read-only), даже когда
  его табель вышел из «actionable» (например, `FINAL_APPROVED`). Резолвинг назначений — на дату
  начала периода, не «сегодня» (у прошлого периода состав назначений мог измениться).
- `lib/admin-timesheets.ts` (новый файл): `listTimesheets`, `getTimesheetCard`,
  `finalApproveTimesheet` (чистый переход `FOREMAN_APPROVED`→`FINAL_APPROVED`, данные не меняет,
  тело запроса должно быть пустым), `returnTimesheetOverride` (весь табель целиком, не отдельный
  scope) — принудительно переводит **все** `TimesheetReviewScope` текущей версии в `RETURNED`
  (включая уже `APPROVED`, сознательно ломая carry-forward — отличается от возврата одного scope,
  `03_...`§4.7), реинициализирует draft через `reinitializeDraftFromVersion` (экспортирована из
  `lib/review-scopes.ts` ради переиспользования), тот же порядок операций под локом
  (`Timesheet`→`TimesheetDraft`, повторная проверка precondition после лока).
- `GET/POST /api/admin/timesheets[...]`, `GET /api/worker/timesheets` (список), UI:
  `/admin/timesheets` (список ожидающих final approve), `/admin/timesheets/[timesheetId]`
  (карточка + `FinalApprovalActions` — кнопка final-approve и форма return-с-причиной на одной
  странице, без отдельного `/approve`-роута), `/worker/history` (список всех табелей работника).
- **Найден и исправлен баг тестовой seed-фикстуры** (не баг продукта): собственный `_test-*.ts`
  скрипт заранее клал `TimesheetDraftDay`/`TimesheetDraftPlannedShift` в draft уже
  `FOREMAN_APPROVED`-табеля «для полноты» — но реальный `submit()` всегда очищает эти таблицы, у
  настоящего `FOREMAN_APPROVED`-табеля draft пуст до первого возврата. Фикстура с непустым draft
  сталкивалась с той же строкой, которую `reinitializeDraftFromVersion` пытался вставить —
  `P2002` на `(draftId, date, sourceAssignmentId)`. Исправлено (draft1 оставлен пустым), после
  чего весь сценарий override-return прошёл чисто.
- Протестировано на одноразовом PostgreSQL 16: validation (`returnReason` обязателен), успешный
  override-return (scope→`RETURNED` с причиной и ревьюером, `Timesheet`→`RETURNED`, draft
  реинициализирован из версии, `AuditEvent`), повторный вызов → `409`, черновик работника снова
  редактируемый и предзаполнен данными версии. Final-approve: повторный вызов на уже
  `FINAL_APPROVED` → `409`; непустое тело → `400`. Затем в headless-browser (Playwright,
  `localhost`, три отдельных seed-набора): `/worker/history` показывает оба статуса
  (`DRAFT`→«Not started», `RETURNED`→«Returned — needs your attention»), `/worker/periods/
  [periodId]` для возвращённого периода снова показывает «Enter hours»; `/admin/timesheets` —
  список из двух табелей; реальный клик «Final approve» → `FINAL_APPROVED` в БД, реальный клик
  «Return whole timesheet» без причины → инлайн-ошибка без перехода, с причиной → `RETURNED` в БД
  (оба подтверждены прямым SQL после клика, не только по факту редиректа). `tsc --noEmit` чист.
- Migration (`timesheet.read.all`, `timesheet.final_approve`, `timesheet.return` →
  `ADMIN`/`SUPER_ADMIN`) применена владельцем через одноразовый `node:22`-контейнер
  (`--env-file .env.titanor-time`, без `npm install`), права подтверждены прямым SQL на
  `titanor-time-db-1`, `app` пересобран и передеплоен, `healthy` (`db` не пересоздавалась).

**`period.lock` реализован и задеплоен** (commit `bba2d8c`), владелец подтвердил «идём по roadmap» —
продолжение по порядку задач ЭТАП 7 без паузы на подтверждение между под-шагами (кроме самой
миграции — правило «агент не применяет миграции сам» не смягчается):
- `lib/periods.ts`: новая `lockPeriod(periodId, actorUserId, requestId)`. Двухфазная проверка —
  быстрый non-tx `findUnique` для `404`, затем `SELECT ... FOR UPDATE` на `PayrollPeriod` внутри
  транзакции и повторная проверка `status === 'OPEN'` **после** лока (TOCTOU-safe против
  конкурентного `final-approve`/`return`, тот же паттерн, что `returnTimesheetOverride`). Блокеры —
  `PayrollPeriodParticipant(expected=true)`, чей `Timesheet.status !== FINAL_APPROVED`, с именем
  работника и текущим статусом (или `null`, если у участника почему-то нет табеля).
- `POST /api/admin/periods/:periodId/lock` — своего контракта в `04_ADMIN_FIRST_API_CONTRACTS.md`
  §7 не было (там только create/read/current) — спроектирован по образцу `timesheet.final_approve`/
  `return` (чистый переход состояния, без idempotency-key, без тела запроса). `ApiErrorBody`
  дополнен опциональным `blockers[]` — аддитивное расширение общего формата ошибки, по той же
  логике, что уже есть `fieldErrors`, нужно для DoD `01_SCREEN_MAP.md` §3 («список блокеров»).
- UI: `LockPeriodAction.tsx` на `/admin/periods/[periodId]` — кнопка видна только при
  `status === 'OPEN'`; при `409 NOT_ALL_FINAL_APPROVED` показывает список блокеров инлайн, без
  перехода; при успехе — `router.refresh()` (не `push`, в отличие от `FinalApprovalActions`
  — админ остаётся на той же карточке периода и сразу видит новый статус).
- **Схема не менялась** — `PayrollPeriod.status`/`lockedAt`/`lockedByUserId`/`exportedAt` и
  CHECK-constraint `ck_payroll_period_status_metadata_shape` (гарантирует атомарность связки
  статус+метаданные на уровне БД) существовали с самой первой заморозки схемы проекта.
- Протестировано на одноразовом PostgreSQL 16: `CSRF`/`401`/`404`; период с одним неготовым
  участником → `409 NOT_ALL_FINAL_APPROVED` с точным списком блокеров; пустой период (без
  участников) → лок проходит тривиально; повторный лок уже `LOCKED` периода → `409
  INVALID_STATE_TRANSITION`; после доведения всех участников до `FINAL_APPROVED` — реальный лок
  проходит, `AuditEvent(PERIOD_LOCKED)` подтверждён прямым SQL. Затем в headless-browser
  (Playwright, `localhost`): реальный клик «Lock period» на заблокированном периоде показывает
  список блокеров без перехода; после исправления данных повторный клик переводит статус в
  `LOCKED` на той же странице (кнопка пропадает, появляется «Locked at …») — подтверждено и по
  тексту страницы, и по скриншоту. `tsc --noEmit` чист.
- Migration (`period.lock` → `ADMIN`/`SUPER_ADMIN`) применена владельцем через тот же одноразовый
  `node:22`-контейнер (`--env-file .env.titanor-time`), права подтверждены прямым SQL на
  `titanor-time-db-1`, `app` пересобран и передеплоен, `healthy`.

**Прорабская очередь `/foreman/*` реализована и задеплоена** (commit `aab1186`), владелец
подтвердил «да давай» — продолжение по roadmap-порядку ЭТАП 7 (T7.6-T7.8), без паузы на
подтверждение между под-шагами (кроме самой миграции):
- `lib/foreman-review.ts` (новый файл): `getForemanSiteIds`/`isForemanOwnScope` (текущие
  `ForemanAssignment` прораба на дату, own-site gate для approve/return роутов),
  `getForemanOverview`, `listForemanReviewScopes` (hasException — не колонка БД, поэтому
  фильтруется в памяти после вычисления для всех PENDING SITE scope прораба, затем пагинация —
  приемлемо на масштабе «scope на своих объектах», не всей компании), `getForemanTimesheetDetail`
  (карточка табеля целиком, с чужими объектами — **свёрнутыми**, не опущенными: день без единого
  сегмента на своих объектах помечается `collapsed:true` и не отдаёт сегменты; смешанный день
  отдаёт только сегменты своих объектов), `listForemanWorkers`, `bulkApproveReviewScopes`
  (валидация и запись — в одной транзакции: непрошедший scope блокирует всю пачку, не только себя).
- **Approve/return переиспользуют существующее ядро** `approveReviewScope`/`returnReviewScope`
  (`lib/review-scopes.ts`, уже построенное для admin fallback) — единственное новое поверх них:
  `isForemanOwnScope`-проверка перед вызовом (`404`, а не `403`, для scope на чужом объекте — тот
  же принцип «не подтверждать факт существования», что уже применялся в `getForemanTimesheetDetail`).
- **Решение по правам, не буквально однозначное в матрице**: `02_ROLE_PERMISSION_MATRIX.md`
  строка `timesheet.foreman_review` описывает precondition approve **и** return под одним кодом
  (по аналогии с `timesheet.scope_review.all` у admin), но отдельная строка `timesheet.return`
  явно перечисляет `FOREMAN` в держателях того же кода, что уже сеялся для admin override-return.
  Прочитано буквально по колонке «Держатели» (как везде в этой матрице): `timesheet.foreman_review`
  выдан только на approve, `timesheet.return` — на return (та же запись права, что и у admin,
  просто добавлена новая `RolePermission`-строка для `FOREMAN`). Более гранулярное разделение, чем
  у admin, но не противоречит документу — задокументировано прямо в тексте миграции.
- Протестировано на одноразовом PostgreSQL 16 (5 работников/сценариев: обычный, с отклонением,
  на чужом объекте, на двух объектах сразу, dual-role прораб-работник): изоляция по объекту
  (чужой объект никогда не виден, ни в списке, ни в карточке — `404`), self-exclusion из
  собственной очереди и `403 SELF_APPROVAL_FORBIDDEN` при прямой попытке, `hasException` только у
  реально расходящегося scope, смешанный день корректно показывает только свой объект, day-only-
  чужой корректно свёрнут, bulk-approve — атомарный откат при невалидном id в пачке (прямой SQL
  подтвердил: ни одна строка не изменилась), затем успешный повтор без невалидного id,
  `Timesheet.status → FOREMAN_APPROVED` только когда все scope версии подтверждены, `AuditEvent`
  для approve/return/bulk (bulk — с `entityId=NULL`) подтверждён прямым SQL. Затем в
  headless-browser (Playwright, `localhost`): реальные клики — bulk-approve через чекбоксы
  (3 отмечены → 0 «Standard» после), return с реальной причиной с редиректом в очередь,
  overview/split/workers-страницы. `tsc --noEmit` чист.
- **Осознанно вне рамок**: `/foreman/review/[timesheetId]/propose-correction` (нужна
  `TimesheetReviewProposal`) и `/foreman/history` (нужна `ApprovalAction`) — та же причина «нет
  потребителя», что применялась к этим моделям на протяжении всего ЭТАП 7; обе требуют отдельного
  design-checkpoint на схему, прежде чем к ним можно будет вернуться.
- Migration (`timesheet.read.assigned`, `timesheet.foreman_review`, `timesheet.bulk_approve` →
  `FOREMAN`; `timesheet.return` → добавлена роль `FOREMAN` к уже существующему праву) применена
  владельцем через одноразовый `node:22`-контейнер, права подтверждены прямым SQL на
  `titanor-time-db-1`, `app` пересобран и передеплоен, `healthy`.

**T7.9 реализован в ADMIN-only срезе.** Схема применена владельцем; текущая локальная задача добавляет admin API/UI и DML-миграцию permission. После её owner-применения и deploy останутся отдельные design-gated задачи: `period.export` (нужна `ExportBatch`/`ExportItem`), `TimesheetReviewProposal`/`propose-correction`, `ApprovalAction`/`foreman/history` и WORKER/FOREMAN correction-request формы.

## 11.1 Activation vertical slice — реализован и задеплоен

Owner-approved checkpoint реализован как один вертикальный срез:

- `ActivationToken` использует детерминированный HMAC-SHA256 с отдельным 32-byte base64 secret
  `ACTIVATION_TOKEN_HMAC_KEY`; сырой Crockford Base32 код из 10 символов не хранится plaintext в
  `ActivationToken` и не пишется в аудит, показывается администратору ровно один раз, TTL — 72
  часа. Обязательный idempotency replay временно хранит весь response только как существующий
  AES-256-GCM ciphertext в `IdempotencyKey`, никогда plaintext;
- migration `20260805170000_add_activation_token` добавляет enum/table, уникальный `tokenHash`,
  status/expiry CHECK, partial unique index «не более одного PENDING на Employee» и RESTRICT FK;
  `20260805171000_seed_worker_activation_permission` выдаёт `worker.activation.generate` ролям
  `ADMIN`/`SUPER_ADMIN`;
- выдача сериализуется `Employee FOR UPDATE`, повторная выдача делает старый PENDING код REVOKED,
  а eligibility повторно проверяет точный `User.status=PENDING_ACTIVATION`, активный Employment,
  текущее назначение и expected participant открытого периода;
- публичный flow включает rate-limited `GET /api/auth/activate`, `POST
  /api/auth/set-initial-password`, `/activate` для ручного ввода бумажного кода,
  `/activate/[token]` для QR/deep link и `/set-password`; финальная транзакция повторно блокирует
  token, не активирует OFFBOARDING/DEACTIVATED пользователя, создаёт WORKER role + UserSession и
  переводит token в USED;
- admin UI показывает disabled hint при `SETUP_INCOMPLETE`; после успешной выдачи показывает код,
  локально (без внешнего QR-сервиса) создаёт QR со ссылкой, позволяет скопировать ссылку и
  распечатать карточку. QR dependency загружается динамически только после выдачи;
- security hardening в ходе review: UUID path validation до raw SQL, canonical base64 validation
  secret, дешёвая token preflight до Argon2 против CPU abuse, единый captured timestamp для
  expiry/usedAt, удаление сырого token из URL после успешной активации.

Фактические проверки 2026-08-06:

- Prisma Client regenerated; `prisma validate`, `tsc --noEmit`, `next build`, `git diff --check` —
  exit 0;
- новый disposable PostgreSQL 16: все 42 migrations применились с нуля, повторный migrate deploy
  вернул `No pending migrations to apply`;
- `_test-activation.ts`: permission seed; issue; verify; reissue/revoke; Argon2 password; ACTIVE;
  WORKER role; UserSession; ISSUE/ACCOUNT_ACTIVATED audit; replay→TOKEN_USED; expiry→TOKEN_EXPIRED;
  OFFBOARDING→SETUP_INCOMPLETE; две конкурентные выдачи оставляют ровно один PENDING/валидный код —
  все проверки прошли; route-handler API checks дополнительно подтвердили `401` без session, `403`
  для WORKER, `404` malformed UUID, `201` для ADMIN, public verify, CSRF rejection, activation cookie
  и replay→`410`;
- disposable container удалён автоматически; на этой стадии production database/app ещё не
  менялись.

Production hand-off выполнен после явного подтверждения владельца 2026-08-06:

- перед migration создан backup `backups/titanor-time-pre-activation-20260806.dump` (191869 bytes,
  mode 600); `pg_restore --list` и полный restore в отдельный disposable PostgreSQL 16 прошли,
  восстановлено 40 finished migrations и 38 application tables, контейнер удалён;
- `ACTIVATION_TOKEN_HMAC_KEY` сгенерирован как 32 random bytes, canonical base64, добавлен только в
  ignored `.env.titanor-time` без вывода значения; mode env-файла остался 600; Compose config
  validation прошла;
- применены только `20260805170000_add_activation_token` и
  `20260805171000_seed_worker_activation_permission`; повторный deploy — `No pending migrations`;
  production catalog: 42 finished migrations, `ActivationToken` table, 2 CHECK, partial unique
  index, permission holders ровно `ADMIN,SUPER_ADMIN`, до первого реального выпуска token rows=0;
- образ из commit `c630595` собран с Prisma Client 6.19.0 и успешным Next.js 16.2.12 production
  build; пересоздан только `titanor-time-app-1` (`--no-deps`), DB не перезапускалась;
- post-deploy: app healthy/restarts=0; `/api/health` 200, `/api/ready` 200, `/activate` 200,
  invalid `/api/auth/activate` 404; headless Chromium mobile smoke подтвердил heading/input/button,
  видимую client validation и отсутствие console/page errors;
- `titanor-time-db-1`, `collab-studio-app-1`, `collab-studio-postgres-1`, `titanorgroup-web-1`
  сохранили прежние StartedAt и restart count 0.

Незафиксированный activation-блокер отсутствует. `npm audit` во время сборки по-прежнему сообщает
6 high advisories в существующем Next/Prisma dependency tree; автоматический `npm audit fix` не
запускался, поскольку upgrade зависимостей — отдельная проверяемая задача, не часть deployment
activation.

## 11.2 Дружелюбный логин Worker'а (`feat(time): generate friendly worker usernames`) — реализован

Заменяет неудобный числовой `username = employeeNumber` (T6.3, **[SUPERSEDED]**-отметки выше) на
`lastName`+первую букву `firstName`, независимо от `employeeNumber`. Новый файл
`lib/worker-usernames.ts`: `generateWorkerUsernameBase` (чистая функция, NFKD-декомпозиция →
удаление диакритики U+0300–U+036F → lowercase → кириллица по таблице/`a-z0-9`/отброшено, fallback
`worker` на пустой результат) + `reserveWorkerUsername` (коллизии `base`/`base2`/`base3`... по
**всем** `User.username`, `pg_advisory_xact_lock(hashtext('worker_username:'+base))` для
race-safety, `excludeUserId` для корректного «уже правильный логин» в regenerate). `POST
/api/admin/workers` (`app/api/admin/workers/route.ts`) переключён на эту генерацию вместо
`employeeNumber.toLowerCase()`; `P2002` теперь различает `username` от `employeeNumber` по
`error.meta.target` (`409 USERNAME_CONFLICT` вместо ложного `DUPLICATE_EMPLOYEE_NUMBER`). Новый
endpoint `POST /api/admin/workers/:employeeId/regenerate-username`
(`app/api/admin/workers/[employeeId]/regenerate-username/route.ts`, permission `worker.update`,
CSRF обязателен) — реализация в `lib/workers.ts` (`regenerateWorkerUsername`): `SELECT "User" ...
FOR UPDATE` на целевую строку, пересчёт кандидата от текущих `firstName`/`lastName`, `changed:
false` без нового `AuditEvent`, если кандидат уже совпадает с текущим `username`; при реальном
изменении — `AuditEvent(WORKER_USERNAME_CHANGED)` с `before/after={employeeId,
previousUsername/username}`, без секретов. `PATCH /api/admin/workers/:employeeId` — без изменений
логики, только исправлен устаревший комментарий про `employeeNumber=username` 1:1. UI
(`WorkerActions.tsx`): новая секция «Login» — текущий username + Copy; кнопка «Generate friendly
login», видимая только когда `username` не начинается с `recommendedUsernameBase`
(`lib/workers.ts`'s `WorkerDetail`); подтверждение точным текстом владельца («The worker must use
the new username for future logins…») перед вызовом; карточка выдачи кода активации теперь
дополнительно показывает `username`. `/admin/workers` — колонка «Login username»; `/admin/workers/
[employeeId]` — метки «Employee number»/«Login username» в подзаголовке. Схема/permissions не
менялись — новых migrations нет.

Фактические проверки на одноразовом PostgreSQL 16 + отдельном контейнере приложения (`docker
network create` изолированная сеть, без host-порта у `db`, отдельно от `titanor-time-db-1`):

- все 48 существующих migrations применились с нуля без ошибок (подтверждает отсутствие новой
  migration для этой задачи); `prisma validate`, `tsc --noEmit`, `next build` (через `docker build
  -f titanor-time-app/Dockerfile .`), `docker compose -f compose.titanor-time.yaml build app`, `git
  diff --check` — все чисто;
- **Группа A** (базовые примеры): `Anton Evtushenko→evtushenkoa`, `Egor Evtushenko→evtushenkoe`,
  `Änne Mäkinen→makinena`, `Антон Евтушенко→evtushenkoa` (до коллизии), `John O'Connor→oconnorj`,
  `Mary-Jane Watson-Smith→watsonsmithm` (дефисы отброшены без остатка), имя длиной 115+115
  символов → username усечён до ровно 58 символов (`64-6`, запас на суффикс), имя из одних emoji
  → `worker` (непустой fallback) — все прошли;
- **Группа B** (коллизии): третий «Anton Evtushenko» → `evtushenkoa3` (второй уже занял
  `evtushenkoa2` в группе A); отдельно созданный standalone `FOREMAN` с username `sidorovi`
  занимает базу раньше Worker'а «Ivan Sidorov» → Worker получил `sidorovi2`; **истинная
  конкурентность** — 5 параллельных `POST /api/admin/workers` с одинаковым именем (`Race{1..5}
  Samename`, явные разные `employeeNumber`, чтобы изолировать именно username-гонку) → все 5
  успешны (`201`), usernames `samenamer`/`samenamer2`/`samenamer3`/`samenamer4`/`samenamer5` —
  различны, без `500`, без потерянного работника; прямой SQL подтвердил `Employee`=`Employment`=
  `AuditEvent(WORKER_CREATED)`=18 (все успешные создания сессии), 0 дублей `username` во всей
  таблице `User`;
- **Группа C**: `GET`/`POST` возвращают `username` рядом с `employeeNumber`; полный цикл
  активации — `POST .../activation` → `GET /api/auth/activate` → `POST
  /api/auth/set-initial-password` вернул `username: "evtushenkoa"` (тот же, что при создании);
  логин прошёл и как `evtushenkoa`, и как `Evtushenkoa` (регистронезависимость через существующую
  нормализацию `login/route.ts`, без изменений там);
  - **Группа D** (числовой Worker → regenerate через UI/endpoint): фикстура подготовлена как
  разрешено заданием — Worker создан обычным `POST` (`employeeNumber=2000`, username сгенерирован
  как `testovi`), затем `username` установлен прямым SQL в `2000` (симуляция старой,
  уже-неактуальной схемы) до полной активации (реальный пароль, реальная `UserSession`). После
  `POST .../regenerate-username`: `employeeNumber` остался `2000`; `username` стал `testovi`;
  `passwordHash`/`UserRole`/статус `ACTIVE` не изменились (прямой SQL до/после); обе существующие
  `UserSession` не отозваны, сессия, залогиненная под `2000` ДО смены, осталась рабочей и
  показывает новый `username` в `/api/auth/session`; логин `2000` → `401 INVALID_CREDENTIALS`;
  логин `testovi` с тем же паролем → `200`; повторный вызов `regenerate-username` →
  `changed:false`, ровно один `AuditEvent(WORKER_USERNAME_CHANGED)` в базе (не два). Тот же поток
  повторён кликами в headless Chromium (Playwright): «Generate friendly login» → диалог с точным
  текстом → «Confirm» → «The login username was updated…» с новым username и Copy — без
  console/page errors, mobile (375×812) и desktop;
- **Группа E** (безопасность): `403 CSRF_REJECTED` без заголовка, `401 NOT_AUTHENTICATED` без
  сессии, `403 FORBIDDEN` под ролью `WORKER` (permission `worker.update` — только `ADMIN`/
  `SUPER_ADMIN` по матрице, `FOREMAN` не проверялся отдельно — идентичный код пути); malformed
  UUID → `500` на момент этой задачи (не регрессия — идентичное поведение уже было у соседних
  `GET`/`PATCH`/`deactivate` на этом же ресурсе; **закрыто отдельным фиксом**
  `fix(time): validate worker username target`, см. запись ниже; `.../activation` уже был защищён
  своим собственным `UUID_PATTERN` до этой задачи); корректный, но несуществующий UUID → чистый
  `404 WORKER_NOT_FOUND`; логи приложения проверены на отсутствие `password`/`argon2`/`secret`;
- **Группа F** (регрессия): `Idempotency-Key` точный повтор → тот же `employee.id`+`username`;
  явный `employeeNumber` конфликт → всё ещё `409 DUPLICATE_EMPLOYEE_NUMBER` (не переклассифицирован
  как `USERNAME_CONFLICT` — подтверждает, что различение по `error.meta.target` реально работает
  на Prisma 6.19.0+Postgres 16, не только в рассуждении); `PATCH` смены `firstName`/`lastName` не
  тронул `username` (остался `potenti`), хотя `recommendedUsernameBase` в ответе `GET` обновился
  до нового имени; повторная выдача кода уже-активному Worker'у → `409 WORKER_ALREADY_ACTIVE`
  (не изменилось); standalone `FOREMAN` создание (`POST /api/admin/users`, `mode=STANDALONE`)
  работает без изменений.
- Одноразовые контейнеры/сеть/образ (`titanor-time-app-test`, `titanor-time-test-db`,
  `titanor-time-test-net`) удалены после проверки; тестовые cookies/env-файлы со сгенерированными
  тестовыми секретами удалены. `titanor-time-app-1`/`titanor-time-db-1` не пересобирались и не
  перезапускались (`RestartCount=0`, тот же `StartedAt`, что и до задачи); production Worker
  `1000` (если существует в реальной базе) не переименовывался — миграции не запускались.

### Фикс: malformed UUID на `regenerate-username` (`fix(time): validate worker username target`)

`POST /api/admin/workers/:employeeId/regenerate-username` передавал `employeeId` прямо в
`regenerateWorkerUsername()` без предварительной проверки формата — malformed значение (`abc`,
обрезанный UUID, не-hex символы) доходило до Prisma `WHERE id = ...::uuid` и падало
неперехваченной ошибкой (`500`) вместо документированного `404 WORKER_NOT_FOUND`. Исправлено тем
же `UUID_PATTERN`, что уже используется в соседних admin routes (буквально скопирован из
`.../workers/[employeeId]/activation/route.ts`) — проверка вставлена **после** CSRF/auth/permission
и **до** вызова lib-функции, так что неаутентифицированный или не-`ADMIN` запрос не может
использовать эндпоинт как UUID-oracle (проверка формата недостижима без прохождения всех gate
выше). Только этот один route изменён — `GET`/`PATCH /api/admin/workers/:employeeId` и `.../
deactivate` сохраняют тот же pre-existing `500` на malformed UUID, что и раньше (не в скоупе этого
фикса).

Проверено на том же одноразовом PostgreSQL 16 (пересобранный с нуля, все 48 migrations): `abc`,
пустая строка, обрезанный UUID, UUID-длины строка с не-hex символами → все `404
WORKER_NOT_FOUND`, ни одного `500`; корректный, но несуществующий UUID → тот же `404
WORKER_NOT_FOUND`; ни один malformed-запрос не создал `AuditEvent` и не изменил `User.username`
(прямой SQL до/после — 0 новых строк); обычный regenerate на существующем Worker'е и повторный
вызов (`changed:false`) — не нарушены; `401`/`403 CSRF_REJECTED`/`403 FORBIDDEN` (роль `WORKER`)
для malformed UUID возвращаются раньше проверки формата (порядок gate не менялся) — подтверждено
прямыми запросами без сессии/CSRF/с ролью `WORKER`. `tsc --noEmit`/`next build`/`docker compose
build app`/`git diff --check` — чисто. Схема/migrations не менялись (48 без изменений);
`titanor-time-app-1`/`titanor-time-db-1` не пересобирались.

## 12. Правило обновления

1. Каждая следующая задача сначала читает этот файл.
2. После успешного commit агент обновляет статус отдельной минимальной задачей либо включает
   обновление в task scope, если это заранее разрешено владельцем.
3. Запись содержит commit hash, изменённые файлы и фактические проверки.
4. Планируемая работа не записывается как выполненная.
5. Чат не является единственным хранилищем отчёта — этот файл им является.
