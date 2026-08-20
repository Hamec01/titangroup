import Link from 'next/link';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3B" (extended by "T8.4C" §BT) — single shared
// tab switcher for every ADMIN report/export screen. T8.1 (/admin/reports), T8.2's admin view
// (/admin/reports/sites, inside SiteTimeReportView for role="admin"), T8.3 (/admin/reports/periods),
// and T8.4C (/admin/export) all render this same component instead of near-identical inline <nav>
// blocks. FOREMAN's site report (SiteTimeReportView for role="foreman") never renders this — it has
// exactly one report type and zero admin URLs.

export type AdminReportTab = 'worker' | 'site' | 'period' | 'export';

const TABS: { key: AdminReportTab; href: string; label: string }[] = [
  { key: 'worker', href: '/admin/reports', label: 'By worker' },
  { key: 'site', href: '/admin/reports/sites', label: 'By site' },
  { key: 'period', href: '/admin/reports/periods', label: 'By period' },
  { key: 'export', href: '/admin/export', label: 'CSV exports' }
];

export function AdminReportTabs({ active }: { active: AdminReportTab }) {
  return (
    <nav className="ov-legacy" aria-label="Report type">
      {TABS.map((tab, i) => (
        <span key={tab.key}>
          {i > 0 && ' · '}
          {tab.key === active ? (
            <span aria-current="page">{tab.label}</span>
          ) : (
            <Link href={tab.href} className="wk-back-link">
              {tab.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
