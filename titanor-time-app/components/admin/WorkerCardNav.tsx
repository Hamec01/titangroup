import Link from 'next/link';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

// R09.8 — one shared header for the four worker-card pages that stay separate
// (/admin/workers/[employeeId] and its /profile, /timeline, /locations siblings):
// a "Workers › <name>" breadcrumb plus a link row between the four. Not a JS tab
// widget — every entry is a plain <Link> to its own page; the current one renders
// as text with aria-current="page".

export type WorkerCardTab = 'overview' | 'profile' | 'timeline' | 'locations';

interface WorkerCardNavProps {
  employeeId: string;
  employeeName: string | null;
  current: WorkerCardTab;
  locale: AppLocale;
}

export function WorkerCardNav({ employeeId, employeeName, current, locale }: WorkerCardNavProps) {
  const base = `/admin/workers/${employeeId}`;
  const tabs: { key: WorkerCardTab; href: string; label: string }[] = [
    { key: 'overview', href: base, label: localeText(locale, 'Overview', 'Обзор') },
    { key: 'profile', href: `${base}/profile`, label: localeText(locale, 'Profile & documents', 'Профиль и документы') },
    { key: 'timeline', href: `${base}/timeline`, label: localeText(locale, 'Check In/Out history', 'История Check In/Out') },
    { key: 'locations', href: `${base}/locations`, label: localeText(locale, 'Check In/Out locations', 'Места Check In/Out') }
  ];

  return (
    <nav className="worker-card-nav" aria-label={localeText(locale, 'Worker', 'Работник')}>
      <p className="worker-card-breadcrumb setup-subtitle">
        <Link href="/admin/workers">{localeText(locale, 'Workers', 'Работники')}</Link>
        {employeeName ? (
          <>
            {' '}
            <span aria-hidden="true">›</span>{' '}
            {current === 'overview' ? <span>{employeeName}</span> : <Link href={base}>{employeeName}</Link>}
          </>
        ) : null}
      </p>
      <ul className="worker-card-tabs">
        {tabs.map((tab) => (
          <li key={tab.key}>
            {tab.key === current ? (
              <span className="worker-card-tab is-current" aria-current="page">
                {tab.label}
              </span>
            ) : (
              <Link href={tab.href} className="worker-card-tab">
                {tab.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
