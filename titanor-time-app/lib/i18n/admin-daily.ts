import type { AppLocale } from './locale';

const EN = {
  accessDenied: 'Access denied — this page requires the ADMIN or SUPER_ADMIN role.',
  common: {
    active: 'Active', inactive: 'Inactive', closed: 'Closed', status: 'Status', name: 'Name',
    createNew: 'create new', none: 'None.', primary: 'primary', yes: 'Yes', off: 'Off',
    start: 'Start', end: 'End', save: 'Save', saving: 'Saving…', creating: 'Creating…',
    back: 'Back', indefinite: 'Indefinite', version: 'version'
  },
  workers: {
    title: 'Workers', singular: 'worker', plural: 'workers', empty: 'No workers yet.',
    showArchived: 'Show archived', hideArchived: 'Hide archived',
    employeeNumber: 'Employee number', login: 'Login username', assignment: 'Current assignment',
    newTitle: 'New worker',
    newHelp: 'Create the worker first. You can assign a site and schedule on the next screen, then send the activation link or QR code.',
    firstName: 'First name', lastName: 'Last name', phone: 'Phone (optional)',
    numberOptional: 'Employee number (optional — generated automatically if left blank)',
    create: 'Create worker', notFound: 'No worker found with this id.',
    activeEmployment: 'Active employment', employmentEnded: 'Employment ended', report: 'View time report',
    currentAssignments: 'Current assignments',
    noAssignment: 'No site has been assigned yet. The worker can already activate and install the app; it will explain that the employer has not assigned a site.',
    addWork: 'Add a site and work schedule',
    addWorkHelp: "Choose the worker's site, optional work area, schedule template and start date here. You do not need to leave this page.",
    submission: 'Timesheet submission',
    submissionHelp: 'Choose whether this worker submits every week or every two weeks. Periods are prepared automatically.',
    activation: {
      ALREADY_ACTIVE: 'Already active', READY_FOR_ACTIVATION: 'Ready — activation code can be issued',
      SETUP_INCOMPLETE: 'Setup incomplete — follow the steps below'
    }
  },
  sites: {
    title: 'Sites', singular: 'site', plural: 'sites', empty: 'No sites yet.', assignments: 'Active assignments',
    newTitle: 'New site', newHelp: 'City is optional. Entering an address lets you find the site on the map and set its geofence.',
    city: 'City (optional)', noCity: 'No city', address: 'Address (optional)', description: 'Description (optional)',
    create: 'Create site', report: "View this site's time report", defaultForeman: 'default authorized site manager',
    notFound: 'No site found with this id.'
  },
  templates: {
    title: 'Work schedule templates', singular: 'template', plural: 'templates', empty: 'No templates yet.',
    create: 'Create template', newTitle: 'New work schedule template',
    newHelp: 'Set the planned working hours for each day of the week.', currentVersion: 'Current version',
    workingDays: 'Working days', notFound: 'No template with this id.', back: 'Back to templates',
    day: 'Day', workingDay: 'Working day', break: 'Break', minutes: 'min'
  },
  assignments: {
    title: 'Assignments', singular: 'assignment', plural: 'assignments', empty: 'No assignments yet.',
    newTitle: 'New assignment', newHelp: 'Assign a site, optional work area and schedule to the worker.',
    worker: 'Worker', site: 'Site', workArea: 'Work area', template: 'Template',
    validFrom: 'Valid from', validTo: 'Valid to'
  },
  periods: {
    title: 'Payroll periods', singular: 'period', plural: 'periods', empty: 'No periods yet.',
    help1: "Payroll periods are generated from each worker's Weekly or Every two weeks setting. Keep a period OPEN while workers enter hours.",
    help2: "Configure the cycle on the worker's page. Manual period creation is retained only for legacy recovery.",
    cycle: 'Cycle', workers: 'Workers', legacy: 'Legacy manual', newTitle: 'Open new period',
    newHelp: 'Generates draft timesheets for every employee with a site assignment intersecting these dates.',
    notFound: 'No period with this id.', back: 'Back to periods', whatNow: 'What to do now:',
    openHelp: 'leave this period open while workers enter and submit hours.',
    autoParticipants: 'New workers are added automatically when their assignment dates overlap this period.',
    participants: 'Participants', approved: 'Final approved', pending: 'Still pending', lockedAt: 'Locked at', exportedAt: 'Exported at',
    workerReport: "View a worker's time report for this period", siteReport: "View a site's time report for this period",
    fullReport: 'View full period report', csv: 'View CSV exports for this period'
  }
} as const;

const RU = {
  accessDenied: 'Доступ запрещён — эта страница доступна только администратору.',
  common: {
    active: 'Активен', inactive: 'Неактивен', closed: 'Закрыт', status: 'Статус', name: 'Название',
    createNew: 'создать', none: 'Нет.', primary: 'основной', yes: 'Да', off: 'Выходной',
    start: 'Начало', end: 'Окончание', save: 'Сохранить', saving: 'Сохранение…', creating: 'Создание…',
    back: 'Назад', indefinite: 'Бессрочно', version: 'версия'
  },
  workers: {
    title: 'Работники', singular: 'работник', plural: 'работников', empty: 'Работников пока нет.',
    showArchived: 'Показать архив', hideArchived: 'Скрыть архив',
    employeeNumber: 'Табельный номер', login: 'Логин', assignment: 'Текущее назначение',
    newTitle: 'Новый работник',
    newHelp: 'Сначала создайте работника. На следующем экране можно назначить объект и график, затем отправить ссылку активации или QR-код.',
    firstName: 'Имя', lastName: 'Фамилия', phone: 'Телефон (необязательно)',
    numberOptional: 'Табельный номер (необязательно — будет создан автоматически)',
    create: 'Создать работника', notFound: 'Работник с таким идентификатором не найден.',
    activeEmployment: 'Работает', employmentEnded: 'Работа завершена', report: 'Открыть отчёт по времени',
    currentAssignments: 'Текущие назначения',
    noAssignment: 'Объект ещё не назначен. Работник уже может активировать и установить приложение — оно сообщит, что начальник пока не назначил объект.',
    addWork: 'Добавить объект и рабочий график',
    addWorkHelp: 'Выберите для работника объект, при необходимости рабочую зону, шаблон графика и дату начала. Уходить с этой страницы не нужно.',
    submission: 'Отправка табеля',
    submissionHelp: 'Выберите, как часто этот работник отправляет табель: каждую неделю или раз в две недели. Периоды создаются автоматически.',
    activation: {
      ALREADY_ACTIVE: 'Уже активирован', READY_FOR_ACTIVATION: 'Готов — можно выдать код активации',
      SETUP_INCOMPLETE: 'Настройка не завершена — выполните шаги ниже'
    }
  },
  sites: {
    title: 'Объекты', singular: 'объект', plural: 'объектов', empty: 'Объектов пока нет.', assignments: 'Активные назначения',
    newTitle: 'Новый объект', newHelp: 'Город необязателен. Адрес позволяет найти объект на карте и настроить геозону.',
    city: 'Город (необязательно)', noCity: 'Без города', address: 'Адрес (необязательно)', description: 'Описание (необязательно)',
    create: 'Создать объект', report: 'Открыть отчёт по объекту', defaultForeman: 'уполномоченный по объекту по умолчанию',
    notFound: 'Объект с таким идентификатором не найден.'
  },
  templates: {
    title: 'Шаблоны рабочего графика', singular: 'шаблон', plural: 'шаблонов', empty: 'Шаблонов пока нет.',
    create: 'Создать шаблон', newTitle: 'Новый шаблон рабочего графика',
    newHelp: 'Укажите плановое рабочее время для каждого дня недели.', currentVersion: 'Текущая версия',
    workingDays: 'Рабочих дней', notFound: 'Шаблон с таким идентификатором не найден.', back: 'Назад к шаблонам',
    day: 'День', workingDay: 'Рабочий день', break: 'Перерыв', minutes: 'мин'
  },
  assignments: {
    title: 'Назначения', singular: 'назначение', plural: 'назначений', empty: 'Назначений пока нет.',
    newTitle: 'Новое назначение', newHelp: 'Назначьте работнику объект, при необходимости рабочую зону и график.',
    worker: 'Работник', site: 'Объект', workArea: 'Рабочая зона', template: 'Шаблон',
    validFrom: 'Действует с', validTo: 'Действует до'
  },
  periods: {
    title: 'Расчётные периоды', singular: 'период', plural: 'периодов', empty: 'Периодов пока нет.',
    help1: 'Расчётные периоды создаются из настройки работника «еженедельно» или «раз в две недели». Оставляйте период ОТКРЫТЫМ, пока работники вводят часы.',
    help2: 'Настройте цикл на странице работника. Ручное создание периода оставлено только для восстановления старых данных.',
    cycle: 'Цикл', workers: 'Работники', legacy: 'Старый ручной', newTitle: 'Открыть новый период',
    newHelp: 'Создаёт черновики табелей для работников, чьи назначения пересекаются с выбранными датами.',
    notFound: 'Период с таким идентификатором не найден.', back: 'Назад к периодам', whatNow: 'Что делать сейчас:',
    openHelp: 'оставьте период открытым, пока работники вводят и отправляют часы.',
    autoParticipants: 'Новые работники добавляются автоматически, если даты их назначения пересекаются с периодом.',
    participants: 'Участники', approved: 'Окончательно утверждено', pending: 'Ещё ожидают', lockedAt: 'Заблокирован', exportedAt: 'Экспортирован',
    workerReport: 'Отчёт работника за этот период', siteReport: 'Отчёт объекта за этот период',
    fullReport: 'Полный отчёт за период', csv: 'CSV-экспорт за этот период'
  }
};

export type AdminDailyStrings = typeof EN | typeof RU;

export function adminDailyStrings(locale: AppLocale): AdminDailyStrings {
  return locale === 'RU' ? RU : EN;
}
