import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3B" (extended by "T8.4C" §BT) — single shared
// tab switcher for every ADMIN report/export screen. T8.1 (/admin/reports), T8.2's admin view
// (/admin/reports/sites, inside SiteTimeReportView for role="admin"), T8.3 (/admin/reports/periods),
// and T8.4C (/admin/export) all render this same component instead of near-identical inline <nav>
// blocks. FOREMAN's site report (SiteTimeReportView for role="foreman") never renders this — it has
// exactly one report type and zero admin URLs.

export type AdminReportTab = 'worker' | 'site' | 'period' | 'export' | 'custom';

const TABS: { key: AdminReportTab; href: string; label: { en: string; ru: string } }[] = [
  { key: 'worker', href: '/admin/reports', label: { en: 'By worker', ru: 'По работнику' } },
  { key: 'site', href: '/admin/reports/sites', label: { en: 'By site', ru: 'По объекту' } },
  { key: 'period', href: '/admin/reports/periods', label: { en: 'By period', ru: 'По периоду' } },
  { key: 'export', href: '/admin/export', label: { en: 'CSV exports', ru: 'Выгрузки CSV' } },
  { key: 'custom', href: '/admin/reports/custom', label: { en: 'Custom report', ru: 'Произвольный отчёт' } }
];

export function AdminReportTabs({ active, locale }: { active: AdminReportTab; locale: AppLocale }) {
  const ru = locale === 'RU';
  return (
    <nav className="ov-legacy" aria-label={ru ? 'Тип отчёта' : 'Report type'}>
      {TABS.map((tab, i) => (
        <span key={tab.key}>
          {i > 0 && ' · '}
          {tab.key === active ? (
            <span aria-current="page">{ru ? tab.label.ru : tab.label.en}</span>
          ) : (
            <Link href={tab.href} className="wk-back-link">
              {ru ? tab.label.ru : tab.label.en}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
