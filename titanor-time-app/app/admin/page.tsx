import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { getAdminOperationalOverview, parseOverviewQuery } from '@/lib/attendance-overview';
import { listPeriodOptions, listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { OverviewView, type OverviewOutcome } from '@/components/overview/OverviewView';
import { resolveAppLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin';
const REQUIRED_PERMISSIONS = ['timesheet.read.all', 'attendance.exception.read.all', 'attendance.conflict.read'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) {
    return null;
  }
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/01_SCREEN_MAP.md `/admin` (T7A.9B) — full operational overview, no longer an
// unconditional redirect to /admin/setup. Reuses getAdminOperationalOverview (lib/attendance-
// overview.ts) — the exact same server-only wrapper GET /api/admin/overview calls — no HTTP
// self-fetch, no second transaction-wrapping copy of the REPEATABLE READ contract.
export default async function AdminOverviewPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  const locale = await resolveAppLocale();

  // Permission-checked, not role-checked (task §3) — a role membership without all three
  // underlying grants must not see this page, and the overview service is never called in that case.
  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <AccessDeniedNotice area="overview" locale={locale} permission={permissionCode} />
      );
    }
  }

  const sp = await searchParams;
  const rawQuery = {
    q: one(sp.q),
    periodId: one(sp.periodId),
    siteId: one(sp.siteId),
    state: one(sp.state),
    employeeId: one(sp.employeeId),
    page: one(sp.page),
    pageSize: one(sp.pageSize)
  };
  const parsed = parseOverviewQuery(rawQuery, { allowEmployeeId: true });

  let outcome: OverviewOutcome;
  if (!parsed.ok) {
    outcome = { kind: 'invalid', fieldErrors: parsed.fieldErrors };
  } else {
    const today = helsinkiToday();
    const result = await getAdminOperationalOverview(parsed.filters, today);
    outcome = result.code === 'PERIOD_NOT_FOUND' ? { kind: 'period-not-found' } : { kind: 'ok', result: result.result };
  }

  const [periodOptions, siteOptions] = await Promise.all([listPeriodOptions(), listSiteOptionsForAdmin()]);

  return (
    <main className="setup-page">
      <OverviewView role="admin" basePath={BASE_PATH} rawQuery={rawQuery} outcome={outcome} periodOptions={periodOptions} siteOptions={siteOptions} />
    </main>
  );
}
