import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { getForemanOverview } from '@/lib/foreman-review';
import { getForemanOperationalOverview, parseOverviewQuery } from '@/lib/attendance-overview';
import { listPeriodOptions, listSiteOptionsForForeman } from '@/lib/attendance-overview-lookups';
import { OverviewView, type OverviewOutcome } from '@/components/overview/OverviewView';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/foreman';
const REQUIRED_PERMISSIONS = ['timesheet.read.assigned', 'attendance.exception.read.assigned'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) {
    return null;
  }
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/01_SCREEN_MAP.md `/foreman` (T7A.9B) — scoped operational overview, replacing
// the pendingCount-only landing page. Preserves its pre-existing review-queue/exceptions shortcut
// (ForemanLegacySection in OverviewView). Reuses getForemanOperationalOverview (lib/attendance-
// overview.ts) — the exact same server-only wrapper GET /api/foreman/overview calls.
export default async function ForemanOverviewPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  const locale = await resolveAppLocale();

  // Permission-checked, not role-checked (task §3) — WORKER (no matter its roles array) and a
  // dual-role FOREMAN+WORKER whose FOREMAN permissions were revoked must not see this page, and the
  // overview service is never called in that case.
  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            {localeText(locale, `Access denied — this page requires the ${permissionCode} permission.`, `Доступ запрещён — для этой страницы требуется право ${permissionCode}.`)}
          </p>
        </main>
      );
    }
  }

  const sp = await searchParams;
  const rawQuery = {
    q: one(sp.q),
    periodId: one(sp.periodId),
    siteId: one(sp.siteId),
    state: one(sp.state),
    employeeId: null, // not a supported filter on this endpoint
    page: one(sp.page),
    pageSize: one(sp.pageSize)
  };
  const parsed = parseOverviewQuery(rawQuery, { allowEmployeeId: false });

  let outcome: OverviewOutcome;
  let legacy: { pendingCount: number; exceptionCount: number };
  const today = helsinkiToday();

  if (!parsed.ok) {
    outcome = { kind: 'invalid', fieldErrors: parsed.fieldErrors };
    // The pre-existing review-queue shortcut (task §11) is independent of the new overview filters
    // (period/site/state/page/pageSize) — an invalid overview filter must not also break it.
    legacy = await getForemanOverview(session.user.id, session.user.employeeId, today);
  } else {
    const result = await getForemanOperationalOverview(session.user.id, session.user.employeeId, parsed.filters, today);
    if (result.code === 'PERIOD_NOT_FOUND') {
      outcome = { kind: 'period-not-found' };
      legacy = await getForemanOverview(session.user.id, session.user.employeeId, today);
    } else {
      legacy = { pendingCount: result.legacy.pendingCount, exceptionCount: result.legacy.exceptionCount };
      outcome = { kind: 'ok', result: result.result };
    }
  }

  const [periodOptions, siteOptions] = await Promise.all([listPeriodOptions(), listSiteOptionsForForeman(session.user.id, today)]);

  return (
    <main className="wk-page">
      <OverviewView role="foreman" basePath={BASE_PATH} rawQuery={rawQuery} outcome={outcome} periodOptions={periodOptions} siteOptions={siteOptions} legacy={legacy} />
    </main>
  );
}
