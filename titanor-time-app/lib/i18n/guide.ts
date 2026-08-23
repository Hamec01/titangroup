import type { AppLocale } from './locale';

// Content for the public /guide page (app/guide/page.tsx + components/guide/GuideView.tsx).
// A plain-language reference for the whole system, not just this admin panel — written so the
// person reading it understands what every screen is for, what order to set things up in, and
// what the mobile worker app and foreman review step look like, even though they don't touch
// those directly. Kept as a data module (not JSX) so the content itself stays easy to review/edit
// without touching component code.

export interface GuideItem {
  title: string;
  text: string;
}

export interface GuideGroup {
  title: string;
  items: GuideItem[];
}

export interface GuideStep {
  title: string;
  text: string;
}

export interface GuideContent {
  pageTitle: string;
  tagline: string;
  intro: string[];
  rolesTitle: string;
  roles: GuideItem[];
  startTitle: string;
  startIntro: string;
  steps: GuideStep[];
  todayTitle: string;
  today: string[];
  referenceTitle: string;
  referenceIntro: string;
  groups: GuideGroup[];
  workerAppTitle: string;
  workerApp: string[];
  tipsTitle: string;
  tips: string[];
  backToLogin: string;
}

export const GUIDE_CONTENT: Record<AppLocale, GuideContent> = {
  RU: {
    pageTitle: 'Инструкция по работе с Titanor Time',
    tagline: 'Как устроена система и с чего начать',
    intro: [
      'Titanor Time — система учёта рабочего времени: работники отмечают приход и уход через мобильное приложение, система собирает это в табели, руководитель или прораб проверяет и одобряет их, а из одобренных данных можно выгрузить отчёты и файлы для расчёта зарплаты.',
      'Эта страница — общая инструкция по всей системе: что означает каждый раздел, в каком порядке лучше всё заполнять и как избежать типичных ошибок. Прочитать её можно один раз перед началом работы, а потом возвращаться к нужному разделу по мере необходимости.'
    ],
    rolesTitle: 'Кто чем пользуется',
    roles: [
      {
        title: 'Панель администратора',
        text: 'Полный доступ: настройка объектов и графиков, работники, назначения, проверка табелей, отчёты и выгрузки. Именно этой панели посвящена основная часть инструкции ниже.'
      },
      {
        title: 'Панель прораба',
        text: 'Упрощённая версия панели — только по своим объектам: список работников, проверка их табелей, проблемы учёта и отчёт по объекту. Прораб не настраивает объекты, шаблоны и назначения — это делает администратор.'
      },
      {
        title: 'Мобильное приложение работника',
        text: 'Отдельное приложение (не эта панель) — работник в нём отмечает приход и уход по кнопке с проверкой геолокации, видит свои часы за период и отправляет табель. Ссылку и QR-код для установки выдаёт администратор при добавлении работника.'
      }
    ],
    startTitle: 'С чего начать: порядок первоначальной настройки',
    startIntro: 'Разделы нужно заполнять примерно в этом порядке — каждый следующий шаг опирается на предыдущий. Необязательные шаги отмечены отдельно, их можно пропустить и вернуться позже.',
    steps: [
      {
        title: '1. Объект',
        text: 'Создайте хотя бы один объект (рабочую площадку) в разделе «Настройка → Объекты»: название, адрес. По адресу можно настроить геозону — границу, по которой система проверяет, что работник действительно был на месте при отметке прихода/ухода. Без хотя бы одного объекта работника некуда назначить.'
      },
      {
        title: '2. Город (необязательно)',
        text: 'Если объектов много и они в разных городах, можно сначала завести список городов в «Настройка → Города» — тогда объекты можно будет группировать по городу. Если объект один или все в одном городе, этот шаг можно пропустить.'
      },
      {
        title: '3. Рабочая зона (необязательно)',
        text: 'Если внутри объекта удобно делить работников по участкам (например, по этажам или цехам), рабочие зоны добавляются прямо на странице конкретного объекта. Если весь объект — это одна зона, шаг можно пропустить.'
      },
      {
        title: '4. Шаблон рабочего графика',
        text: 'В разделе «Настройка → Шаблоны графика» создайте типовой график: какие дни недели рабочие и сколько часов ожидается в эти дни. Шаблон — это то, с чем сравнивается фактически отработанное время; он понадобится на следующем шаге.'
      },
      {
        title: '5. Работник',
        text: 'Добавьте сотрудника в разделе «Работники → Работники»: имя, фамилия, при необходимости телефон. Табельный номер система может присвоить автоматически. Сразу после создания можно выдать код или QR-код активации — по нему работник установит и войдёт в мобильное приложение.'
      },
      {
        title: '6. Назначение',
        text: 'В разделе «Работники → Назначения» свяжите работника с объектом и шаблоном графика на определённый период (можно без даты окончания). Именно назначение делает работника «активным» на объекте — до этого шага работник существует в системе, но нигде не числится работающим.'
      },
      {
        title: '7. Цикл отправки табеля',
        text: 'В разделе «Настройка → Циклы отправки табеля» укажите для работника, как часто он отправляет табель — раз в неделю или раз в две недели. После сохранения система сама создаёт текущий и следующий расчётные периоды — вручную их заводить не нужно.'
      },
      {
        title: '8. Пользователь-прораб (необязательно)',
        text: 'Если по объекту должен проверять табели не сам администратор, а отдельный человек — прораб, — создайте для него учётную запись в разделе «Работники → Пользователи» и привяжите его к объекту (это делается на странице объекта). Если работник уже есть в системе и должен стать ещё и прорабом, ему просто добавляется роль — новый логин заводить не нужно.'
      }
    ],
    todayTitle: 'Экран «Сегодня» — основной рабочий экран',
    today: [
      '«Сегодня» открывается сразу после входа — это главный экран для повседневной работы. В таблице по каждому работнику видно: статус (работает / закончил / не начинал), объект, время прихода и ухода, сколько отработано сегодня, есть ли проблемы.',
      'Строка разбита на отдельные кликабельные ячейки: клик по имени открывает редактирование профиля, по статусу — быструю проверку, по объекту — назначения этого работника, по приходу/уходу/сегодня — историю по дням за последние недели, по проблемам — список проблем этого работника. Кнопка «Открыть →» открывает полную карточку работника целиком.',
      'Сверху есть поиск по имени/объекту и сводные показатели (сколько работников активны, сколько сейчас на смене, сколько требуют внимания). Ниже, в раскрывающихся блоках — сведения по табелям и техническим конфликтам, если они есть.'
    ],
    referenceTitle: 'Разделы меню — что где находится',
    referenceIntro: 'Меню администратора сгруппировано по смыслу — каждая группа открывается по клику и содержит связанные разделы.',
    groups: [
      {
        title: 'Настройка',
        items: [
          { title: 'Чек-лист настройки', text: 'Показывает, какие из обязательных шагов (объект, шаблон, работник, назначение, цикл отправки) уже выполнены, а какие ещё нет, с прямыми ссылками на нужный раздел.' },
          { title: 'Города', text: 'Необязательный справочник городов для группировки объектов по местоположению. Город с привязанными объектами удалить нельзя.' },
          { title: 'Объекты', text: 'Список и создание объектов: название, город (если используется), адрес, геозона, статус «активен/закрыт». На странице конкретного объекта также добавляются его рабочие зоны и назначается прораб по умолчанию.' },
          { title: 'Рабочие зоны', text: 'Общий список всех рабочих зон по всем объектам. Саму зону нужно создавать не здесь, а на странице соответствующего объекта. Зону нельзя удалить полностью — только отключить, чтобы сохранить историю по уже отработанному в ней времени.' },
          { title: 'Шаблоны графика', text: 'Типовые рабочие графики (рабочие дни недели и ожидаемые часы), на которые ссылаются назначения работников. Шаблон, который используется, можно только деактивировать, а не удалить.' },
          { title: 'Циклы отправки табеля', text: 'Для каждого активного работника — как часто он отправляет табель: раз в неделю или раз в две недели. Здесь же виден текущий расчётный период по каждому работнику; настроить его можно прямо со страницы работника.' }
        ]
      },
      {
        title: 'Работники',
        items: [
          { title: 'Работники', text: 'Полный список сотрудников с их статусом трудоустройства, текущим назначением и статусом активации мобильного приложения. Отсюда же можно выдать или перевыдать код/QR-код активации.' },
          { title: 'Назначения', text: 'Связь «работник + объект (+ рабочая зона) + шаблон графика» на период времени. У работника может быть одно основное назначение и несколько дополнительных; завершённое назначение не удаляется, а остаётся в истории.' },
          { title: 'Пользователи', text: 'Учётные записи для входа в систему помимо мобильного приложения работника — в первую очередь прорабы, а также дополнительные администраторы. Отсюда же выдаются коды активации для новых учётных записей.' }
        ]
      },
      {
        title: 'Учёт времени',
        items: [
          { title: 'Расчётные периоды', text: 'Периоды (обычно неделя или две недели), создаются автоматически на основе циклов отправки табеля. В рамках периода отработанное время собирается в табель, который затем проходит проверку.' },
          { title: 'Табели', text: 'Табели, готовые к окончательному одобрению после проверки прорабом, а также уже окончательно одобренные — с карточки одобренного табеля можно запросить исправление.' },
          { title: 'Проблемы учёта', text: 'Автоматически обнаруженные несоответствия в отметках прихода/ухода — например, не подтверждён GPS, нет отметки ухода, пересекаются две смены. Каждую проблему нужно решить: отклонить как несущественную, подтвердить данные как верные либо исправить конкретное время или объект.' },
          { title: 'Правила учёта', text: 'Общие настройки компании: через сколько дней после окончания периода и в какое время неотправленный табель отправляется автоматически, сколько ждать перед повторным открытием табеля при поздней синхронизации, максимально допустимая длительность одной смены.' }
        ]
      },
      {
        title: 'Проверка',
        items: [
          { title: 'Табели на проверку', text: 'Очередь отправленных табелей (по объектам и не привязанным к объекту данным), ожидающих, чтобы прораб или администратор их одобрил либо вернул работнику с указанием причины.' },
          { title: 'Исправления', text: 'Процесс изменения табеля, который уже прошёл окончательное одобрение. Запускается с карточки такого табеля, требует указания причины и проходит отдельное одобрение, прежде чем измененные данные станут окончательными.' }
        ]
      },
      {
        title: 'Отчёты',
        items: [
          { title: 'Отчёты', text: 'Суммарные отработанные часы по работнику, по расчётному периоду в целом или по конкретному объекту. Показывается только рабочее время — расчёт зарплаты система не выполняет.' },
          { title: 'Выгрузка CSV', text: 'Формирование скачиваемого CSV-файла с отработанными часами за период — для передачи во внешнюю систему расчёта зарплаты. Каждая выгрузка сохраняется как отдельная неизменяемая запись; если после выгрузки была одобрена корректировка, создаётся новый файл, а не редактируется старый.' }
        ]
      }
    ],
    workerAppTitle: 'Мобильное приложение работника (кратко)',
    workerApp: [
      'Работник получает ссылку или QR-код активации от администратора (раздел «Работники → Работники»), переходит по ней и устанавливает приложение на телефон.',
      'В приложении одна главная кнопка «Приход» / «Уход» — при нажатии проверяется геолокация, чтобы подтвердить, что работник действительно на объекте. Приложение продолжает работать и без интернета — данные отправятся на сервер, как только связь появится.',
      'Работник видит список часов по дням за текущий период и в конце периода отправляет табель на проверку. Если табель не отправлен вовремя, система может отправить его автоматически — это настраивается в разделе «Правила учёта».'
    ],
    tipsTitle: 'На что обратить внимание',
    tips: [
      'Без хотя бы одного объекта, шаблона графика, работника и назначения экран «Сегодня» останется пустым — эти четыре шага обязательны.',
      'Без настроенной геозоны на объекте отметки прихода/ухода не будут проверяться по местоположению.',
      '«Исправление» можно запросить только для уже окончательно одобренного табеля. Если табель ещё не одобрен, его нужно просто вернуть работнику через раздел «Проверка» — с указанием причины возврата.',
      'Рабочую зону и шаблон графика, которые уже используются, нельзя удалить — только отключить: так сохраняется история по уже отработанному времени, но их больше нельзя выбрать для новых назначений.',
      'Изменение цикла отправки табеля задним числом ограничено, если по текущему периоду уже есть данные — такие изменения обычно применяются с ближайшей будущей границы периода.'
    ],
    backToLogin: '← Назад ко входу'
  },
  EN: {
    pageTitle: 'Titanor Time — User Guide',
    tagline: 'How the system works and where to start',
    intro: [
      'Titanor Time is a work-time tracking system: workers check in and out through a mobile app, the system collects that into timesheets, a manager or foreman reviews and approves them, and approved data can be exported as reports or files for payroll.',
      'This page is a general guide to the whole system: what each section means, what order to fill things in, and how to avoid common mistakes. Read it once before you start, then come back to the relevant section whenever you need it.'
    ],
    rolesTitle: 'Who uses what',
    roles: [
      {
        title: 'Admin panel',
        text: 'Full access: setting up sites and schedules, workers, assignments, timesheet review, reports and exports. Most of the guide below is about this panel.'
      },
      {
        title: 'Foreman panel',
        text: 'A simplified version of the panel, scoped to their own sites only: a worker list, reviewing their timesheets, attendance issues, and a site report. A foreman doesn\'t set up sites, templates, or assignments — that\'s the administrator\'s job.'
      },
      {
        title: 'Worker mobile app',
        text: 'A separate app (not this panel) — the worker uses one button to check in and out with a location check, sees their hours for the current period, and submits their timesheet. The administrator issues the install link/QR code when adding the worker.'
      }
    ],
    startTitle: 'Where to start: initial setup order',
    startIntro: 'Fill in sections roughly in this order — each step builds on the one before it. Optional steps are marked separately; you can skip them and come back later.',
    steps: [
      {
        title: '1. Site',
        text: 'Create at least one site (a work location) under Setup → Sites: name, address. From the address you can set up a geofence — the boundary the system uses to check that a worker was actually on-site when they checked in or out. Without at least one site, there is nowhere to assign a worker.'
      },
      {
        title: '2. City (optional)',
        text: 'If you have many sites across different cities, you can first build a city list under Setup → Cities so sites can be grouped by location. If you have one site, or all sites are in the same city, skip this step.'
      },
      {
        title: '3. Work area (optional)',
        text: 'If it\'s useful to split workers within a site by section (e.g. by floor or workshop), work areas are added directly from a specific site\'s own page. If the whole site is a single area, skip this step.'
      },
      {
        title: '4. Schedule template',
        text: 'Under Setup → Schedule templates, create a standard schedule: which days of the week are working days and how many hours are expected on those days. The template is what actual worked time is compared against, and it\'s needed for the next step.'
      },
      {
        title: '5. Worker',
        text: 'Add an employee under People → Workers: first name, last name, phone if needed. The system can assign an employee number automatically. Right after creation you can issue an activation code or QR code — the worker uses it to install and log into the mobile app.'
      },
      {
        title: '6. Assignment',
        text: 'Under People → Assignments, link the worker to a site and a schedule template for a date range (an end date is optional). The assignment is what makes a worker "active" at a site — before this step, the worker exists in the system but isn\'t recorded as working anywhere.'
      },
      {
        title: '7. Timesheet submission cycle',
        text: 'Under Setup → Submission cycles, set how often the worker submits a timesheet — weekly or every two weeks. Once saved, the system automatically creates the current and next payroll periods — you never create them by hand.'
      },
      {
        title: '8. Foreman user (optional)',
        text: 'If a site\'s timesheets should be reviewed by a dedicated person rather than the administrator, create a user account for them under People → Users and link them to the site (done from the site\'s own page). If that person is already a worker in the system, they just get an added role — no separate login is created.'
      }
    ],
    todayTitle: 'The "Today" screen — the main working screen',
    today: [
      '"Today" opens right after sign-in — it\'s the main screen for day-to-day work. For each worker, the table shows: status (working / finished / not started), site, check-in and check-out time, hours worked today, and whether there are issues.',
      'Each row is split into separate clickable cells: clicking the name opens profile editing, the status cell opens a quick status check, the site cell opens that worker\'s assignments, check-in/check-out/today open a day-by-day history for recent weeks, and the issues cell opens that worker\'s issue list. The "Open →" button opens the worker\'s full profile.',
      'At the top there\'s a search box (by name/site) and summary counters (active workers, currently working, needing attention). Below, in expandable panels, are timesheet details and any technical conflicts, if there are any.'
    ],
    referenceTitle: 'Menu sections — what\'s where',
    referenceIntro: 'The admin menu is grouped by purpose — each group opens on click and contains related sections.',
    groups: [
      {
        title: 'Setup',
        items: [
          { title: 'Setup checklist', text: 'Shows which required steps (site, template, worker, assignment, submission cycle) are already done and which aren\'t yet, with direct links to the relevant section.' },
          { title: 'Cities', text: 'An optional city directory for grouping sites by location. A city with sites linked to it cannot be deleted.' },
          { title: 'Sites', text: 'List and creation of sites: name, city (if used), address, geofence, active/closed status. A site\'s own page is also where its work areas are added and its default foreman is assigned.' },
          { title: 'Work areas', text: 'A combined list of every work area across every site. The area itself is created from its site\'s own page, not here. A work area can\'t be fully deleted — only deactivated, to keep the history of time already logged in it.' },
          { title: 'Schedule templates', text: 'Standard work schedules (working days of the week and expected hours) that worker assignments reference. A template that\'s in use can only be deactivated, not deleted.' },
          { title: 'Submission cycles', text: 'For each active worker — how often they submit a timesheet: weekly or every two weeks. The current payroll period for each worker is also shown here; it can be configured directly from the worker\'s own page.' }
        ]
      },
      {
        title: 'People',
        items: [
          { title: 'Workers', text: 'The full employee list with employment status, current assignment, and mobile-app activation status. Activation codes/QR codes can be issued or reissued from here.' },
          { title: 'Assignments', text: 'The link between "worker + site (+ work area) + schedule template" for a date range. A worker can have one primary assignment and several secondary ones; a finished assignment isn\'t deleted, it stays in history.' },
          { title: 'Users', text: 'System accounts for signing in besides the worker mobile app — mainly foremen, plus additional administrators. Activation codes for new accounts are also issued from here.' }
        ]
      },
      {
        title: 'Time & attendance',
        items: [
          { title: 'Payroll periods', text: 'Periods (usually a week or two weeks), created automatically from submission cycles. Worked time within a period is collected into a timesheet, which then goes through review.' },
          { title: 'Timesheets', text: 'Timesheets ready for final approval after foreman review, plus already-finalized ones — a correction can be requested from an already-approved timesheet\'s own card.' },
          { title: 'Attendance issues', text: 'Automatically detected inconsistencies in check-in/check-out — for example, GPS not verified, a missing checkout, two overlapping shifts. Each issue needs to be resolved: dismissed as not significant, acknowledged as valid data, or corrected (a specific time or site fixed).' },
          { title: 'Attendance policy', text: 'Company-wide settings: how many days after a period ends, and at what time, an unsubmitted timesheet is submitted automatically; how long to wait before reopening a timesheet after a late sync; the maximum allowed length of a single shift.' }
        ]
      },
      {
        title: 'Review',
        items: [
          { title: 'Timesheet review', text: 'The queue of submitted timesheets (by site, and non-site-scoped data), waiting for a foreman or admin to approve them or return them to the worker with a reason.' },
          { title: 'Corrections', text: 'The process of changing a timesheet that\'s already been finally approved. Started from that timesheet\'s own card, requires a reason, and goes through its own approval before the changed data becomes final.' }
        ]
      },
      {
        title: 'Reports',
        items: [
          { title: 'Reports', text: 'Total worked hours by worker, by payroll period as a whole, or by a specific site. Only worked time is shown — the system doesn\'t calculate pay.' },
          { title: 'CSV exports', text: 'Generates a downloadable CSV file of worked hours for a period, for use in an external payroll system. Each export is saved as a separate, immutable record; if a correction is approved after an export, a new file is created rather than editing the old one.' }
        ]
      }
    ],
    workerAppTitle: 'The worker mobile app (brief overview)',
    workerApp: [
      'The worker gets an activation link or QR code from the administrator (People → Workers), opens it, and installs the app on their phone.',
      'The app has one main Check In / Check Out button — pressing it checks location to confirm the worker is actually at the site. The app keeps working without internet too; data is sent to the server as soon as a connection is available.',
      'The worker sees a day-by-day list of hours for the current period and submits their timesheet at the end of the period. If it isn\'t submitted in time, the system can submit it automatically — configurable under Attendance policy.'
    ],
    tipsTitle: 'Worth knowing',
    tips: [
      'Without at least one site, one schedule template, one worker, and one assignment, the "Today" screen will stay empty — those four steps are required.',
      'Without a configured geofence on a site, check-in/check-out won\'t be verified by location.',
      'A "correction" can only be requested for an already finally-approved timesheet. If a timesheet isn\'t approved yet, just return it to the worker from Review — with a reason.',
      'A work area or schedule template that\'s already in use can\'t be deleted — only deactivated: this keeps the history of time already logged, while removing it from future assignment choices.',
      'Changing a submission cycle retroactively is limited if the current period already has data — such changes are usually applied from the nearest future period boundary.'
    ],
    backToLogin: '← Back to sign in'
  }
};
