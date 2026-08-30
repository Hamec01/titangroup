import type { AppLocale } from '@/lib/i18n/locale';

// R09.2 — short, human "why you can't see this" text, keyed by area (not by permission code). The
// underlying permission code is never shown in the body — it goes on the element's `title`/
// `data-permission` for support only. RU/EN, no jargon, one sentence + one next step.

export type AccessDeniedArea =
  | 'overview'
  | 'reports'
  | 'exports'
  | 'attendance-issues'
  | 'attendance-policy'
  | 'workforce'
  | 'setup'
  | 'admin';

const TEXT: Record<AccessDeniedArea, { en: string; ru: string }> = {
  overview: {
    en: 'This overview is for administrators who can see every timesheet and attendance record. Ask a SUPER_ADMIN if you need access.',
    ru: 'Этот обзор — для администраторов, которые видят все табели и записи учёта. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  },
  reports: {
    en: 'Reports are for administrators with reporting access. Ask a SUPER_ADMIN if you need it.',
    ru: 'Отчёты — для администраторов с доступом к отчётности. Если он вам нужен, обратитесь к SUPER_ADMIN.'
  },
  exports: {
    en: 'Exports are for administrators who can create data exports. Ask a SUPER_ADMIN if you need access.',
    ru: 'Экспорт — для администраторов, которым разрешено создавать выгрузки. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  },
  'attendance-issues': {
    en: 'Attendance issues are for administrators who review time tracking. Ask a SUPER_ADMIN if you need access.',
    ru: 'Проблемы учёта — для администраторов, которые проверяют учёт времени. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  },
  'attendance-policy': {
    en: 'Attendance rules are for administrators who manage company policy. Ask a SUPER_ADMIN if you need access.',
    ru: 'Правила учёта — для администраторов, которые управляют политикой компании. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  },
  workforce: {
    en: 'The workforce view is for administrators who can see worker profiles. Ask a SUPER_ADMIN if you need access.',
    ru: 'Раздел «Персонал» — для администраторов, которые видят профили работников. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  },
  setup: {
    en: 'Setup is for administrators. Ask a SUPER_ADMIN if you need access.',
    ru: 'Настройка — для администраторов. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  },
  admin: {
    en: 'This section is for administrators. Ask a SUPER_ADMIN if you need access.',
    ru: 'Этот раздел — для администраторов. Если вам нужен доступ, обратитесь к SUPER_ADMIN.'
  }
};

export function accessDeniedText(area: AccessDeniedArea, locale: AppLocale): string {
  const entry = TEXT[area] ?? TEXT.admin;
  return locale === 'RU' ? entry.ru : entry.en;
}

export const ACCESS_DENIED_AREAS = Object.keys(TEXT) as AccessDeniedArea[];
