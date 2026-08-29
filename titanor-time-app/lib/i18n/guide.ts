import type { AppLocale } from './locale';

// Content for the public /guide page (app/guide/page.tsx + components/guide/GuideView.tsx).
// A plain-language reference for the whole system, not just this admin panel — written so the
// person reading it understands what every screen is for, what order to set things up in, and
// what the mobile worker app and foreman review step look like, even though they don't touch
// those directly. Kept as a data module (not JSX) so the content itself stays easy to review/edit
// without touching component code.
//
// Last brought current: 2026-08-29 (T13.1–T13.11, T14). Covers: grouped admin nav, the notification
// bell + review-queue badge, the worker dossier, the workforce matrix (professions + qualification
// filters + PDF/CSV export), worker professions, the unified "Awaiting approval" screen, the three
// ways to change a timesheet, marking sick-leave/vacation from review, the configurable GPS
// accuracy threshold, the mid-shift presence check, the Customer working-hours report, and (T14)
// GPS offline resilience: the "wait for GPS / check in anyway" prompt, the approximate last-good
// location, the per-site "GPS often unavailable" flag, and the filter-scoped bulk-acknowledge.
// The iOS geolocation note (permission must be re-granted every launch) is in workerApp + the GPS
// changelog entry.
//
// The "What's new" section (changelog) at the bottom is written for the owner, in plain language,
// newest first, dated. When something user-visible ships, add a bullet under the right date — no
// commit hashes, no internal task codes, just what changed and why it matters.

export interface GuideItem {
  title: string;
  text: string;
}

export interface GuideChangeEntry {
  date: string;
  items: string[];
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
  changelogTitle: string;
  changelogIntro: string;
  changelog: GuideChangeEntry[];
  backToLogin: string;
  backToHome: string;
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
        text: 'Полный доступ: настройка объектов и графиков, работники и их допуски, назначения, проверка и утверждение табелей, отчёты и выгрузки. Именно этой панели посвящена основная часть инструкции ниже.'
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
        text: 'Добавьте сотрудника в разделе «Работники → Работники»: имя, фамилия, при необходимости телефон. Табельный номер система может присвоить автоматически. На карточке работника можно заполнить досье (дата рождения, личный код, контактный email, специальность, навыки, фото, договор). Сразу после создания можно выдать код или QR-код активации — по нему работник установит и войдёт в мобильное приложение. На iPhone приложение нужно устанавливать только через встроенный браузер Safari — через другие браузеры (например, Chrome на iOS) установка на iPhone не сработает.'
      },
      {
        title: '5б. Допуски и сертификаты (необязательно)',
        text: 'Если для работы нужны допуски или удостоверения с ограниченным сроком (электробезопасность, работа на высоте и т. п.), заведите их на карточке работника: тип допуска, срок действия, отметка о проверке. Общая картина по всем работникам — в разделе «Работники → Работники — матрица». Когда срок приближается или истёк, система заранее показывает уведомление в колокольчике в шапке.'
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
      'Сверху есть поиск по имени/объекту и сводные показатели (сколько работников активны, сколько сейчас на смене, сколько требуют внимания). Ниже, в раскрывающихся блоках — сведения по табелям и техническим конфликтам, если они есть.',
      'В шапке справа — две иконки со счётчиками. Колокольчик: уведомления, которые требуют внимания (истекающие допуски и сертификаты работников; «работник сдал табель за неделю — нужно утвердить»). Календарь: сколько табелей ждёт вашего утверждения, с разбивкой по неделям — клик открывает очередь «На утверждении». Рядом — переключатель языка RU/EN и ссылка «Инструкция» (эта страница).'
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
          { title: 'Работники', text: 'Полный список сотрудников с их статусом трудоустройства, текущим назначением и статусом активации мобильного приложения. Отсюда же можно выдать или перевыдать код/QR-код активации, а на карточке — заполнить досье работника.' },
          { title: 'Работники — матрица', text: 'Общая таблица по всем работникам: профессии, текущий объект, занятость (активен / неактивен), допуски и сертификаты со сроком и статусом (действует / истекает скоро / истёк / срок не указан). Фильтры по категории профессии, профессии, конкретному допуску и его статусу, объекту, подтверждению; сортировка. Всю отфильтрованную выборку можно выгрузить в PDF или CSV. Сами профессии и допуски заводятся на карточке работника. (Старый адрес «Допуски и сертификаты» ведёт сюда же.)' },
          { title: 'Назначения', text: 'Связь «работник + объект (+ рабочая зона) + шаблон графика» на период времени. У работника может быть одно основное назначение и несколько дополнительных; завершённое назначение не удаляется, а остаётся в истории.' },
          { title: 'Пользователи', text: 'Учётные записи для входа в систему помимо мобильного приложения работника — в первую очередь прорабы, а также дополнительные администраторы. Отсюда же выдаются коды активации для новых учётных записей.' }
        ]
      },
      {
        title: 'Учёт времени',
        items: [
          { title: 'Расчётные периоды', text: 'Периоды (обычно неделя или две недели), создаются автоматически на основе циклов отправки табеля. В рамках периода отработанное время собирается в табель, который затем проходит проверку.' },
          { title: 'Табели', text: 'Список всех табелей по статусам. С карточки табеля доступны действия в зависимости от статуса. У отправленного на проверку: утвердить часы; вернуть работнику с причиной; «Изменить часы» — быстрая правка администратором без причины, работник не получает уведомление; «Исправить часы / отметить больничный, отпуск» — правка с причиной, которую работник видит. У окончательно одобренного — запросить исправление.' },
          { title: 'Проблемы учёта', text: 'Автоматически обнаруженные несоответствия в отметках прихода/ухода — например, не подтверждён GPS, нет отметки ухода, пересекаются две смены. Для проблем с GPS в карточке показывается расстояние от точки работника до центра геозоны и мини-карта — видно, был ли работник рядом с объектом, даже если точность низкая. Каждую проблему нужно решить: отклонить как несущественную, подтвердить данные как верные либо исправить конкретное время или объект.' },
          { title: 'Правила учёта', text: 'Общие настройки компании: через сколько дней после окончания периода и в какое время неотправленный табель отправляется автоматически; сколько ждать перед повторным открытием табеля при поздней синхронизации; максимально допустимая длительность одной смены; максимальная точность GPS (в метрах), при которой система считает геозону подтверждённой — её можно поднять для объекта со слабым сигналом внутри помещений.' }
        ]
      },
      {
        title: 'Проверка',
        items: [
          { title: 'На утверждении', text: 'Один экран со всеми табелями, ожидающими вашего утверждения, по всем открытым периодам. Фильтр по объекту, сортировка, «только с замечаниями». По «чистым» табелям (без проблем и расхождений план ≠ факт) — кнопка утверждения в один клик; по остальным — «Открыть» ведёт на карточку. Отдельный раскрывающийся блок «Ещё не сдали» — кто пока не отправил табель.' },
          { title: 'Проверка по разделам', text: 'Детальная проверка табеля по частям — по каждому объекту отдельно и по данным вне объекта: каждый раздел можно одобрить или вернуть отдельно. Используется, когда по табелю нужно разобраться подробнее, чем в один клик.' },
          { title: 'Исправления', text: 'Изменение табеля, который уже прошёл окончательное одобрение. Запускается с карточки такого табеля, требует причины и проходит отдельное одобрение, прежде чем изменённые данные станут окончательными. Для табеля, который ещё на проверке, отдельное «исправление» не нужно — используйте «Изменить часы» или верните работнику.' }
        ]
      },
      {
        title: 'Отчёты',
        items: [
          { title: 'Отчёты', text: 'Суммарные отработанные часы по работнику, по расчётному периоду в целом или по конкретному объекту. Показывается только рабочее время — расчёт зарплаты система не выполняет.' },
          { title: 'Произвольный отчёт', text: 'Отработанные часы за любой период с выбором работников и объектов, в PDF или CSV. По дням или итогами, с подытогами по работнику и объекту. Только часы, без зарплаты.' },
          { title: 'Часы заказчику', text: 'Документ для заказчика: подтверждённые (окончательно одобренные) часы по объекту за период. Перед выгрузкой система проверяет готовность — если какой-то табель не утверждён, показывает список со ссылками и блокирует финальный PDF/CSV. PDF с логотипом Titanor и пометкой «FINAL APPROVED». Без зарплат, ставок, надбавок, TES и подписи.' },
          { title: 'Выгрузка CSV', text: 'Формирование скачиваемого CSV-файла с отработанными часами за период — для передачи во внешнюю систему расчёта зарплаты. Каждая выгрузка сохраняется как отдельная неизменяемая запись; если после выгрузки была одобрена корректировка, создаётся новый файл, а не редактируется старый.' }
        ]
      }
    ],
    workerAppTitle: 'Мобильное приложение работника (кратко)',
    workerApp: [
      'Работник получает ссылку или QR-код активации от администратора (раздел «Работники → Работники»), переходит по ней и устанавливает приложение на телефон. На iPhone — только через встроенный браузер Safari.',
      'Приложение просит разрешить геолокацию. На Android достаточно выбрать «Разрешить при использовании приложения» (не «Один раз») — дальше оно не переспрашивает. На iPhone и iPad из-за ограничений Apple разрешение приходится подтверждать при каждом запуске приложения — это нормально, обойти нельзя, просто нажмите «Разрешить» и продолжайте.',
      'В приложении одна главная кнопка «Приход» / «Уход» — при нажатии проверяется геолокация и показывается её точность. Приложение продолжает работать и без интернета — данные отправятся на сервер, как только связь появится.',
      'Если телефон не поймал GPS (внутри корпуса судна, в цеху, без интернета), после нажатия «Приход» появится сообщение «подождите ~15 секунд» и кнопка «Всё равно отметить». Отметка сохраняется в любом случае — приход и уход никогда не блокируются из-за GPS.',
      'Если смена длинная, приложение может ещё раз проверить местоположение в течение смены (когда работник его открывает) — эти точки видны администратору на карте работника. Отдельно закрывать и открывать смену для этого не нужно.',
      'Работник видит список часов по дням за текущий период и в конце периода отправляет табель на проверку. Если табель не отправлен вовремя, система может отправить его автоматически — это настраивается в разделе «Правила учёта».'
    ],
    tipsTitle: 'На что обратить внимание',
    tips: [
      'Без хотя бы одного объекта, шаблона графика, работника и назначения экран «Сегодня» останется пустым — эти четыре шага обязательны.',
      'Без настроенной геозоны на объекте отметки прихода/ухода не будут проверяться по местоположению.',
      'Табель на проверке можно поправить тремя способами: вернуть работнику с причиной (он переделает сам), «Изменить часы» (быстрая правка администратором без причины, работник не уведомляется) или «Исправить часы» с причиной, которую работник увидит. Отдельный процесс «Исправление» нужен только для уже окончательно одобренного табеля.',
      'Больничный, отпуск или неоплачиваемый день можно проставить прямо в редакторе табеля при проверке — отдельный одобренный запрос на отсутствие для этого больше не обязателен.',
      'Допуски и сертификаты с истекающим сроком система показывает в колокольчике заранее — не дожидаясь, пока они станут недействительны.',
      'Рабочую зону и шаблон графика, которые уже используются, нельзя удалить — только отключить: так сохраняется история по уже отработанному времени, но их больше нельзя выбрать для новых назначений.',
      'Изменение цикла отправки табеля задним числом ограничено, если по текущему периоду уже есть данные — такие изменения обычно применяются с ближайшей будущей границы периода.'
    ],
    changelogTitle: 'Что нового',
    changelogIntro: 'Коротко — что менялось в системе за последнее время. Самое свежее сверху.',
    changelog: [
      {
        date: 'GPS без сигнала, 29 августа 2026',
        items: [
          'Приход и уход без GPS. Если работник нажал «Приход», а телефон ещё не поймал спутники (внутри корпуса судна, в цеху, без интернета), появляется сообщение «подождите около 15 секунд» и кнопка «Всё равно отметить». Отметка и часы сохраняются в любом случае — GPS теперь никогда не мешает отметиться.',
          'Приблизительное местоположение. Когда свежего GPS нет, приложение прикладывает последнюю известную координату телефона (не старше 30 минут) с пометкой «приблизительно» и возрастом («≈ 8 мин назад»). В проблеме учёта такая точка показана на карте серой пунктирной меткой — это не проверка по геозоне, а просто ориентир, где примерно был человек.',
          'Галочка у объекта «Здесь часто нет сигнала GPS» (в карточке объекта). Для таких объектов офлайн-отметки без координат больше не попадают в список проблем — система принимает их сама, и это видно в журнале.',
          'Кнопка «Принять все „GPS не подтверждён" по фильтру» на экране проблем учёта: выберите объект (или работника, или период) и разом примите все накопившиеся отметки без координат.'
        ]
      },
      {
        date: '29 августа 2026',
        items: [
          'Профессии работника. У работника теперь можно указать одну или несколько рабочих специальностей (Сварщик, Трубопроводчик, Плотник и т.д.) — из готового каталога по двум категориям (судостроение и строительство) или своим текстом. Это отдельно от допусков и сертификатов и не даёт никакого доступа — просто специальность. Блок «Профессии» — на карточке работника, сверху. Профессии попадают в PDF-досье. Старое поле «Специальность» осталось для старых записей.',
          'Матрица работников (бывший экран «Допуски и сертификаты», теперь «Работники — матрица»). Добавились фильтры по категории профессии, профессии и по занятости (активен / неактивен), сортировка по профессии, табельному номеру и объекту. Всю отфильтрованную выборку можно выгрузить в PDF или CSV одной кнопкой — без личного кода, адреса, телефона и фото документов.',
          'Отчёт заказчику по часам. Новая вкладка «Часы заказчику» в разделе «Отчёты». Выбираете период, работников и объекты — система показывает готовность: если все табели окончательно одобрены, можно скачать PDF (с логотипом Titanor и пометкой «FINAL APPROVED») или CSV для заказчика. Если какой-то табель ещё не утверждён — покажет список со ссылками и заблокирует финальную выгрузку; отдельно есть «внутренний предпросмотр» на текущих данных. В отчёте только часы — без зарплат, ставок, надбавок и подписи.',
          'Исправлен подсчёт рабочих дней в произвольном отчёте: если работник за один день был на двух объектах, в итоге по работнику это теперь один рабочий день, а не два (в итоге по объекту — по-прежнему один на каждом).'
        ]
      },
      {
        date: '28 августа 2026',
        items: [
          'Обеденный перерыв вычитается сам. Если в графике стоит перерыв 30 минут, система убирает эти полчаса из рабочего времени автоматически — после того как работник закончил день. Одни и те же часы теперь видят и работник, и руководитель, и отчёты. Если работник сам отметил перерыв, второй раз ничего не вычтется. Для тех, кому обед оплачивают, в шаблоне графика есть галочка «обед оплачивается».',
          'Забытая смена закрывается сама. Работник ушёл и не нажал «Уход» — через 16 часов система закроет смену по плановому времени окончания из графика и покажет это руководителю отдельным сигналом, чтобы он проверил и при необходимости поправил часы.',
          'Неделя принадлежит работнику до конца следующего дня после закрытия периода (при недельном цикле — до понедельника, 23:59). До этого момента он спокойно правит свои дни, система не спрашивает «почему изменил». Потом табель уходит на проверку. Уже утверждённый табель можно вернуть работнику кнопкой «Внести правки».'
        ]
      },
      {
        date: '27 августа 2026',
        items: [
          'Появился один экран «На утверждении» — все табели, которые ждут вашей проверки, в одном списке, а не в трёх разных разделах. Простые табели (без замечаний) можно утвердить прямо из списка одной кнопкой. Рядом с колокольчиком появилась иконка календаря — на ней видно, сколько недель ждёт утверждения.',
          'Руководитель может поправить часы работника, не возвращая ему табель. «Изменить часы» — быстрая правка, работник её не видит и уведомления не получает. «Исправить часы» — правка с причиной, которую работник увидит.',
          'Больничный, отпуск и неоплачиваемый день ставятся прямо в табеле при проверке. Отдельная заявка на отсутствие для этого больше не нужна.',
          'Понятнее уведомления: на каждый сданный табель приходит отдельное «нужно утвердить неделю такую-то».',
          'Кнопка «Отклонить» у проблем учёта переименована в «Снять сигнал» — раньше её путали с отклонением часов. Часы, смена и отметки при этом не меняются, сигнал просто убирается из списка после проверки.'
        ]
      },
      {
        date: 'Геолокация (GPS), 27–28 августа 2026',
        items: [
          'Разрешение на геолокацию на Android спрашивается один раз: если работник выбрал «Разрешить при использовании приложения», приложение больше не переспрашивает. На iPhone и iPad из-за ограничений Apple разрешение приходится подтверждать при каждом запуске — обойти это нельзя, работнику нужно просто нажать «Разрешить».',
          'Точность стала выше. Приложение недолго «прогревает» геолокацию и берёт самую точную точку за последние секунды, а не первую попавшуюся. Работник видит текущую точность и может нажать «Уточнить».',
          'Видно, где был работник, даже когда GPS «не подтверждён». В проблеме учёта теперь показывается расстояние до объекта, попал ли работник в геозону, и мини-карта. Даже при плохой точности по карте понятно, был человек на месте или нет.',
          'Порог точности GPS можно настроить в «Правилах учёта» — для объектов со слабым сигналом внутри зданий его можно поднять.',
          'На долгой смене приложение может тихо отметить, что работник ещё на объекте (когда он открывает приложение). Эти точки руководитель видит на карте работника. Перезаходить в смену для этого не нужно.'
        ]
      },
      {
        date: '23–26 августа 2026',
        items: [
          'Досье работника: дата рождения, личный код, контактный email, специальность, навыки, фото, договор — всё на карточке работника.',
          'Допуски и сертификаты со сроком действия: общая таблица по всем работникам и напоминания в колокольчике заранее, до того как срок истёк.',
          'Меню администратора сгруппировано по смыслу — Настройка, Работники, Учёт времени, Проверка, Отчёты.',
          'Эта инструкция — на русском и английском, ссылка на неё есть на входе и в шапке.',
          'Отчёты и выгрузки всегда на английском, независимо от языка панели — чтобы файл для бухгалтерии выглядел одинаково.'
        ]
      }
    ],
    backToLogin: '← Назад ко входу',
    backToHome: '← На главную'
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
        text: 'Full access: setting up sites and schedules, workers and their qualifications, assignments, timesheet review and approval, reports and exports. Most of the guide below is about this panel.'
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
        text: 'Add an employee under People → Workers: first name, last name, phone if needed. The system can assign an employee number automatically. The worker\'s own card is where you fill in the dossier (date of birth, personal ID code, contact email, specialty, skills, photo, contract). Right after creation you can issue an activation code or QR code — the worker uses it to install and log into the mobile app. On iPhone, the app must be installed through the built-in Safari browser only — installing from another browser (e.g. Chrome on iOS) will not work on iPhone.'
      },
      {
        title: '5b. Qualifications and certificates (optional)',
        text: 'If the work requires permits or certificates with an expiry date (electrical safety, working at height, etc.), add them on the worker\'s card: qualification type, expiry date, a verified flag. The whole-team picture is under People → Workforce matrix. When an expiry date is approaching or has passed, the system shows a notification in the bell in the header ahead of time.'
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
      'At the top there\'s a search box (by name/site) and summary counters (active workers, currently working, needing attention). Below, in expandable panels, are timesheet details and any technical conflicts, if there are any.',
      'The header has two counter icons on the right. The bell: notifications that need attention (workers\' expiring qualifications and certificates; "a worker submitted the timesheet for a week — needs approval"). The calendar: how many timesheets are waiting for your approval, broken down by week — clicking it opens the "Awaiting approval" queue. Next to them is the RU/EN language switch and the "Guide" link (this page).'
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
          { title: 'Workers', text: 'The full employee list with employment status, current assignment, and mobile-app activation status. Activation codes/QR codes can be issued or reissued from here, and the worker\'s card is where the dossier is filled in.' },
          { title: 'Workforce matrix', text: 'A whole-team table: professions, current site, employment (active / inactive), and qualifications/certificates with expiry and status (valid / expiring soon / expired / expiry not set). Filter by profession category, profession, a specific qualification and its status, site, verification; sort. The whole filtered selection exports to PDF or CSV. Professions and qualifications themselves are added on the worker\'s card. (The old "Qualifications" URL leads here.)' },
          { title: 'Assignments', text: 'The link between "worker + site (+ work area) + schedule template" for a date range. A worker can have one primary assignment and several secondary ones; a finished assignment isn\'t deleted, it stays in history.' },
          { title: 'Users', text: 'System accounts for signing in besides the worker mobile app — mainly foremen, plus additional administrators. Activation codes for new accounts are also issued from here.' }
        ]
      },
      {
        title: 'Time & attendance',
        items: [
          { title: 'Payroll periods', text: 'Periods (usually a week or two weeks), created automatically from submission cycles. Worked time within a period is collected into a timesheet, which then goes through review.' },
          { title: 'Timesheets', text: 'The full list of timesheets by status. The actions on a timesheet\'s card depend on its status. For one submitted for review: approve hours; return it to the worker with a reason; "Edit hours" — a quick admin edit with no reason, the worker is not notified; "Edit hours / mark sick leave, vacation" — an edit with a reason the worker sees. For an already-finalized one — request a correction.' },
          { title: 'Attendance issues', text: 'Automatically detected inconsistencies in check-in/check-out — for example, GPS not verified, a missing checkout, two overlapping shifts. For GPS issues the card shows the distance from the worker\'s point to the geofence centre and a mini-map — you can see whether the worker was near the site even when accuracy is poor. Each issue needs to be resolved: dismissed as not significant, acknowledged as valid data, or corrected (a specific time or site fixed).' },
          { title: 'Attendance policy', text: 'Company-wide settings: how many days after a period ends, and at what time, an unsubmitted timesheet is submitted automatically; how long to wait before reopening a timesheet after a late sync; the maximum allowed length of a single shift; the maximum GPS accuracy (in metres) at which the system treats the geofence as confirmed — raise it for a site with a weak signal indoors.' }
        ]
      },
      {
        title: 'Review',
        items: [
          { title: 'Awaiting approval', text: 'One screen with every timesheet waiting for your approval, across all open periods. Filter by site, sort, "only with issues". Clean timesheets (no issues, no plan ≠ actual mismatch) get a one-click approve button; the rest have an "Open" link to the card. A separate expandable "Not submitted yet" panel shows who hasn\'t sent a timesheet.' },
          { title: 'By-scope review', text: 'Detailed review of a timesheet in parts — per site, and for non-site data: each part can be approved or returned separately. Used when a timesheet needs a closer look than a single click.' },
          { title: 'Corrections', text: 'Changing a timesheet that\'s already been finally approved. Started from that timesheet\'s own card, requires a reason, and goes through its own approval before the changed data becomes final. A timesheet still under review doesn\'t need a separate "correction" — use "Edit hours" or return it to the worker.' }
        ]
      },
      {
        title: 'Reports',
        items: [
          { title: 'Reports', text: 'Total worked hours by worker, by payroll period as a whole, or by a specific site. Only worked time is shown — the system doesn\'t calculate pay.' },
          { title: 'Custom report', text: 'Worked hours for any date range, with worker and site selection, as PDF or CSV. Daily or totals, with per-worker and per-site subtotals. Hours only, no pay.' },
          { title: 'Customer hours', text: 'A document for the customer: confirmed (final-approved) hours by site for a date range. The system checks readiness first — if a timesheet is not approved it shows a linked list and blocks the final PDF/CSV. PDF with the Titanor logo and a "FINAL APPROVED" mark. No salary, rates, premiums, TES or signature.' },
          { title: 'CSV exports', text: 'Generates a downloadable CSV file of worked hours for a period, for use in an external payroll system. Each export is saved as a separate, immutable record; if a correction is approved after an export, a new file is created rather than editing the old one.' }
        ]
      }
    ],
    workerAppTitle: 'The worker mobile app (brief overview)',
    workerApp: [
      'The worker gets an activation link or QR code from the administrator (People → Workers), opens it, and installs the app on their phone. On iPhone — through the built-in Safari browser only.',
      'The app asks for location permission. On Android, choosing "Allow while using the app" (not "Allow once") is enough — it won\'t ask again. On iPhone and iPad, Apple\'s restrictions mean the permission has to be granted every time the app is opened — this is normal and can\'t be avoided; the worker just taps "Allow" and continues.',
      'The app has one main Check In / Check Out button — pressing it checks location and shows its accuracy. The app keeps working without internet too; data is sent to the server as soon as a connection is available.',
      'If the phone has no GPS fix (inside a ship hull, a covered hall, offline), tapping "Check in" shows a "please wait ~15 seconds" message and a "Check in anyway" button. The check-in is saved either way — GPS never blocks clocking in or out.',
      'On a long shift the app may check location again during the shift (when the worker opens it) — those points are visible to the administrator on the worker\'s map. Nothing needs to be clocked out and back in for this.',
      'The worker sees a day-by-day list of hours for the current period and submits their timesheet at the end of the period. If it isn\'t submitted in time, the system can submit it automatically — configurable under Attendance policy.'
    ],
    tipsTitle: 'Worth knowing',
    tips: [
      'Without at least one site, one schedule template, one worker, and one assignment, the "Today" screen will stay empty — those four steps are required.',
      'Without a configured geofence on a site, check-in/check-out won\'t be verified by location.',
      'A timesheet under review can be changed three ways: return it to the worker with a reason (they redo it themselves), "Edit hours" (a quick admin edit with no reason, the worker isn\'t notified), or "Edit hours" with a reason the worker will see. The separate "Correction" process is only needed for an already finally-approved timesheet.',
      'Sick leave, vacation, or an unpaid day can be set right in the timesheet editor during review — a separate approved absence request is no longer required for that.',
      'The system shows expiring qualifications and certificates in the bell ahead of time — before they actually become invalid.',
      'A work area or schedule template that\'s already in use can\'t be deleted — only deactivated: this keeps the history of time already logged, while removing it from future assignment choices.',
      'Changing a submission cycle retroactively is limited if the current period already has data — such changes are usually applied from the nearest future period boundary.'
    ],
    changelogTitle: 'What\'s new',
    changelogIntro: 'A short list of what has changed in the system recently. Newest first.',
    changelog: [
      {
        date: 'GPS with no signal, 29 August 2026',
        items: [
          'Check in / out with no GPS. If the worker taps "Check in" while the phone still has no satellite fix (inside a ship hull, a covered hall, offline), a "please wait about 15 seconds" message appears with a "Check in anyway" button. The check-in and the hours are saved either way — GPS can no longer stop someone clocking in.',
          'Approximate location. When there is no fresh fix, the app attaches the phone\'s last known location (no older than 30 minutes) marked "approximate" with its age ("≈ 8 min old"). On an exception it shows on the map as a grey dashed marker — not a geofence check, just a rough "where the person was".',
          'A per-site "GPS is often unavailable here" checkbox (on the site card). For those sites, offline check-ins with no coordinate no longer land in the exception queue — the system accepts them itself, and it is recorded in the audit log.',
          'An "Acknowledge all GPS not verified in this filter" button on the exceptions screen: pick a site (or a worker, or a period) and clear the whole backlog of no-coordinate check-ins at once.'
        ]
      },
      {
        date: '29 August 2026',
        items: [
          'Worker professions. A worker can now have one or more trade specialities (Welder, Pipe fitter, Carpenter, …) — from a built-in catalog under two categories (shipbuilding and construction) or as free text. This is separate from qualifications and certificates and grants no access — it is just a speciality. The "Professions" block is at the top of the worker\'s card, and professions appear in the dossier PDF. The old "Specialty" field stays for old records.',
          'Workforce matrix (the former "Qualifications" screen, now "Workforce matrix"). New filters by profession category, profession and by employment (active / inactive), and sorts by profession, employee number and site. The whole filtered selection can be exported to PDF or CSV in one click — with no personal ID code, address, phone or document photos.',
          'Customer working-hours report. A new "Customer hours" tab under Reports. Pick a period, workers and sites — the system shows readiness: if every timesheet is final-approved you can download a PDF (with the Titanor logo and a "FINAL APPROVED" mark) or CSV for the customer. If a timesheet is not approved yet it shows a linked list and blocks the final export; a separate internal preview uses the current data. The report shows hours only — no salary, rates, premiums or signature.',
          'Fixed the worked-days count in the custom report: a worker who spent one day on two sites now counts as one worked day in the per-worker total, not two (the per-site total is still one at each site).'
        ]
      },
      {
        date: '28 August 2026',
        items: [
          'The lunch break is deducted automatically. If the schedule has a 30-minute break, the system takes those 30 minutes out of worked time on its own, once the worker has finished the day. The worker, the manager, and the reports now all see the same hours. If the worker logged their own break, nothing is deducted twice. For cases where lunch is paid, the schedule template has a "lunch is paid" checkbox.',
          'A forgotten shift closes itself. If a worker leaves without pressing "Check out", after 16 hours the system closes the shift at the planned end time from the schedule and flags it to the manager as an issue to review and adjust if needed.',
          'The week belongs to the worker until the end of the day after the period closes (for a weekly cycle — until Monday, 23:59). Until then they edit their days freely and the system doesn\'t ask "why did you change this". After that the timesheet goes for review. An already-approved timesheet can be sent back to the worker with the "Reopen for edits" button.'
        ]
      },
      {
        date: '27 August 2026',
        items: [
          'There is now one "Awaiting approval" screen — every timesheet waiting for your review in a single list instead of three separate sections. Clean timesheets (no issues) can be approved straight from the list with one button. A calendar icon next to the bell shows how many weeks are waiting for approval.',
          'The manager can fix a worker\'s hours without sending the timesheet back. "Edit hours" is a quick edit the worker doesn\'t see and isn\'t notified about. "Edit hours" with a reason shows that reason to the worker.',
          'Sick leave, vacation and unpaid days are set right in the timesheet during review. A separate absence request is no longer needed for that.',
          'Clearer notifications: each submitted timesheet gets its own "week X needs approval" alert.',
          'The "Dismiss" button on attendance issues is now "Clear alert" — it used to be mistaken for rejecting hours. Hours, the shift and the check-ins are not changed; the alert is just removed from the list after review.'
        ]
      },
      {
        date: 'Location (GPS), 27–28 August 2026',
        items: [
          'Location permission on Android is asked once: if the worker chose "Allow while using the app", the app no longer keeps asking. On iPhone and iPad, Apple\'s restrictions mean the permission must be granted on every launch — this can\'t be changed, the worker just taps "Allow".',
          'Accuracy is better. The app briefly "warms up" location and takes the most accurate point from the last few seconds rather than the first one. The worker sees the current accuracy and can tap "Refine".',
          'You can see where the worker was even when GPS is "not verified". The attendance issue now shows the distance to the site, whether the worker was inside the geofence, and a mini-map. Even with poor accuracy the map makes it clear whether the person was on-site.',
          'The GPS accuracy threshold is configurable in Attendance policy — raise it for sites with a weak signal indoors.',
          'On a long shift the app can quietly note that the worker is still on-site (when they open the app). Those points show on the worker\'s map for the manager. No need to check out and back in for this.'
        ]
      },
      {
        date: '23–26 August 2026',
        items: [
          'Worker dossier: date of birth, personal ID code, contact email, specialty, skills, photo, contract — all on the worker\'s card.',
          'Qualifications and certificates with expiry dates: a whole-team table and reminders in the bell ahead of time, before a date expires.',
          'The admin menu is grouped by purpose — Setup, People, Time & attendance, Review, Reports.',
          'This guide — in Russian and English, linked from the sign-in page and the header.',
          'Reports and exports are always in English, regardless of the panel language, so the payroll file looks the same every time.'
        ]
      }
    ],
    backToLogin: '← Back to sign in',
    backToHome: '← Back to dashboard'
  }
};
