import type { AppLocale } from './locale';

export interface AdminStrings {
  accessDenied: string;
  adminNavigation: string;
  guideLink: string;
}

export const ADMIN_STRINGS: Record<AppLocale, AdminStrings> = {
  EN: {
    accessDenied: 'Access denied — this area requires the ADMIN or SUPER_ADMIN role.',
    adminNavigation: 'Admin navigation',
    guideLink: 'User guide'
  },
  RU: {
    accessDenied: 'Доступ запрещён — этот раздел доступен только администратору.',
    adminNavigation: 'Навигация администратора',
    guideLink: 'Инструкция'
  }
};

export interface AdminNavItemStrings {
  href: string;
  label: string;
}

export interface AdminNavGroupStrings {
  key: string;
  label: string;
  items: AdminNavItemStrings[];
}

export interface AdminNavStrings {
  overview: AdminNavItemStrings;
  groups: AdminNavGroupStrings[];
}

// Grouped, dropdown-based admin nav (redesigned 2026-08 to replace a flat 15-link row that no
// longer fit intuitively on one line). Purely a presentation grouping — every href below is an
// existing, unchanged route; nothing here adds/removes/renames any page or API. Also surfaces three
// routes that existed but were previously unlinked from top nav (cities, work-areas,
// submission-cycles), reachable before only via /admin/setup's checklist or a site's own page.
export const ADMIN_NAV: Record<AppLocale, AdminNavStrings> = {
  EN: {
    overview: { href: '/admin', label: 'Today' },
    groups: [
      {
        key: 'setup',
        label: 'Setup',
        items: [
          { href: '/admin/setup', label: 'Setup checklist' },
          { href: '/admin/cities', label: 'Cities' },
          { href: '/admin/sites', label: 'Sites' },
          { href: '/admin/work-areas', label: 'Work areas' },
          { href: '/admin/templates', label: 'Schedule templates' },
          { href: '/admin/submission-cycles', label: 'Submission cycles' }
        ]
      },
      {
        key: 'people',
        label: 'People',
        items: [
          { href: '/admin/workers', label: 'Workers' },
          { href: '/admin/assignments', label: 'Assignments' },
          { href: '/admin/users', label: 'Users' }
        ]
      },
      {
        key: 'time',
        label: 'Time & attendance',
        items: [
          { href: '/admin/periods', label: 'Payroll periods' },
          { href: '/admin/timesheets', label: 'Timesheets' },
          { href: '/admin/attendance/exceptions', label: 'Attendance issues' },
          { href: '/admin/attendance/policy', label: 'Attendance policy' }
        ]
      },
      {
        key: 'review',
        label: 'Review',
        items: [
          { href: '/admin/review-scopes', label: 'Timesheet review' },
          { href: '/admin/corrections', label: 'Corrections' }
        ]
      },
      {
        key: 'reports',
        label: 'Reports',
        items: [
          { href: '/admin/reports', label: 'Reports' },
          { href: '/admin/export', label: 'CSV exports' }
        ]
      }
    ]
  },
  RU: {
    overview: { href: '/admin', label: 'Сегодня' },
    groups: [
      {
        key: 'setup',
        label: 'Настройка',
        items: [
          { href: '/admin/setup', label: 'Чек-лист настройки' },
          { href: '/admin/cities', label: 'Города' },
          { href: '/admin/sites', label: 'Объекты' },
          { href: '/admin/work-areas', label: 'Рабочие зоны' },
          { href: '/admin/templates', label: 'Шаблоны графика' },
          { href: '/admin/submission-cycles', label: 'Циклы отправки табеля' }
        ]
      },
      {
        key: 'people',
        label: 'Работники',
        items: [
          { href: '/admin/workers', label: 'Работники' },
          { href: '/admin/assignments', label: 'Назначения' },
          { href: '/admin/users', label: 'Пользователи' }
        ]
      },
      {
        key: 'time',
        label: 'Учёт времени',
        items: [
          { href: '/admin/periods', label: 'Расчётные периоды' },
          { href: '/admin/timesheets', label: 'Табели' },
          { href: '/admin/attendance/exceptions', label: 'Проблемы учёта' },
          { href: '/admin/attendance/policy', label: 'Правила учёта' }
        ]
      },
      {
        key: 'review',
        label: 'Проверка',
        items: [
          { href: '/admin/review-scopes', label: 'Табели на проверку' },
          { href: '/admin/corrections', label: 'Исправления' }
        ]
      },
      {
        key: 'reports',
        label: 'Отчёты',
        items: [
          { href: '/admin/reports', label: 'Отчёты' },
          { href: '/admin/export', label: 'Выгрузка CSV' }
        ]
      }
    ]
  }
};
