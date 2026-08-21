import type { AppLocale } from './locale';

export interface AdminStrings {
  accessDenied: string;
  nav: Record<string, string>;
  adminNavigation: string;
}

export const ADMIN_STRINGS: Record<AppLocale, AdminStrings> = {
  EN: {
    accessDenied: 'Access denied — this area requires the ADMIN or SUPER_ADMIN role.',
    adminNavigation: 'Admin navigation',
    nav: {
      Overview: 'Overview', Setup: 'Setup', Workers: 'Workers', Users: 'Users', Sites: 'Sites', Templates: 'Templates', Assignments: 'Assignments', Periods: 'Periods', Timesheets: 'Timesheets', Reports: 'Reports', Review: 'Review', Corrections: 'Corrections', Exports: 'Exports', 'Attendance exceptions': 'Attendance exceptions', 'Attendance policy': 'Attendance policy'
    }
  },
  RU: {
    accessDenied: 'Доступ запрещён — этот раздел доступен только администратору.',
    adminNavigation: 'Навигация администратора',
    nav: {
      Overview: 'Сегодня', Setup: 'Настройка', Workers: 'Работники', Users: 'Пользователи', Sites: 'Объекты', Templates: 'Шаблоны', Assignments: 'Назначения', Periods: 'Периоды', Timesheets: 'Табели', Reports: 'Отчёты', Review: 'Проверка', Corrections: 'Исправления', Exports: 'Экспорт', 'Attendance exceptions': 'Проблемы учёта', 'Attendance policy': 'Правила учёта'
    }
  }
};
