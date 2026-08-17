import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { listAttendanceExceptions, parseExceptionListQuery } from '@/lib/attendance-exceptions';
import { ExceptionsListView, type ExceptionsListOutcome } from '@/components/attendance-exceptions/ExceptionsListView';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/foreman/attendance/exceptions';

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) {
    return null;
  }
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/01_SCREEN_MAP.md `/foreman/attendance/exceptions` (T7A.8C.1) — AttendanceException
// queue, distinct from the pre-existing `/foreman/review/exceptions` (TimesheetReviewScope with
// hasException=true — a different entity, see that page's own comment). Scope reuses
// getForemanSiteIds (same function/pattern as the read API route) recomputed on every request —
// never cached — plus excludeEmployeeId for dual-role FOREMAN+WORKER self-exclusion.
export default async function ForemanAttendanceExceptionsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!(await hasPermission(session.user.roles, 'attendance.exception.read.assigned'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the attendance.exception.read.assigned permission.
        </p>
      </main>
    );
  }

  const sp = await searchParams;
  // siteId/payrollPeriodId have no picker UI this slice but remain supported filters — a direct
  // URL (or a paged/re-submitted link carrying one forward) must still apply it, not silently
  // ignore it. employeeId stays hardcoded null: this route never accepts it (allowEmployeeId:
  // false below), matching the admin-only employeeId filter contract.
  const rawQuery = {
    status: one(sp.status),
    type: one(sp.type),
    from: one(sp.from),
    to: one(sp.to),
    siteId: one(sp.siteId),
    employeeId: null,
    payrollPeriodId: one(sp.payrollPeriodId)
  };
  const parsed = parseExceptionListQuery(
    {
      page: one(sp.page),
      pageSize: one(sp.pageSize),
      status: rawQuery.status,
      type: rawQuery.type,
      siteId: rawQuery.siteId,
      employeeId: null,
      payrollPeriodId: rawQuery.payrollPeriodId,
      from: rawQuery.from,
      to: rawQuery.to
    },
    { allowEmployeeId: false }
  );

  let outcome: ExceptionsListOutcome;
  if (!parsed.ok) {
    outcome = { kind: 'invalid', fieldErrors: parsed.fieldErrors };
  } else {
    const ownSiteIds = await getForemanSiteIds(session.user.id, helsinkiToday());
    const result = await listAttendanceExceptions(parsed.filters, { ownSiteIds, excludeEmployeeId: session.user.employeeId });
    outcome = { kind: 'ok', result, emptyNoAssignedSites: ownSiteIds.length === 0 };
  }

  return (
    <main className="setup-page">
      <ExceptionsListView basePath={BASE_PATH} title="Attendance exceptions" rawQuery={rawQuery} outcome={outcome} />
    </main>
  );
}
