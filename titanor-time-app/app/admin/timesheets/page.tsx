import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { isTimesheetsLedgerUiEnabled } from '@/lib/timesheets-ledger-flag';
import { LegacyTimesheetsView } from './LegacyTimesheetsView';
import { TimesheetsLedgerPage } from './TimesheetsLedgerPage';

export const dynamic = 'force-dynamic';

// UT4-B — /admin/timesheets is one route, two bodies, picked by TIMESHEETS_LEDGER_UI_ENABLED
// (lib/timesheets-ledger-flag.ts). Auth/locale/role-gate is shared and byte-identical to what the
// pre-redesign page did, so flipping the flag off reproduces the old page exactly — see
// LegacyTimesheetsView.tsx (the old page's body, moved here unchanged).
type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminTimesheetsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const s = adminDailyStrings(locale);

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {s.accessDenied}
        </p>
      </main>
    );
  }

  const sp = await searchParams;

  if (!isTimesheetsLedgerUiEnabled()) {
    const statusParam = typeof sp.status === 'string' ? sp.status : undefined;
    return <LegacyTimesheetsView locale={locale} statusParam={statusParam} />;
  }

  return <TimesheetsLedgerPage locale={locale} actor={{ userId: session.user.id, employeeId: session.user.employeeId }} searchParams={sp} />;
}
