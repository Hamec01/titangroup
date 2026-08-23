import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { listAttendanceExceptions, parseExceptionListQuery } from '@/lib/attendance-exceptions';
import { ExceptionsListView, type ExceptionsListOutcome } from '@/components/attendance-exceptions/ExceptionsListView';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/attendance/exceptions';

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) {
    return null;
  }
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/01_SCREEN_MAP.md `/admin/attendance/exceptions` (T7A.8C.1) — list foundation
// for AttendanceException, distinct from the pre-existing /admin/review-scopes queue
// (TimesheetReviewScope). Reuses listAttendanceExceptions/parseExceptionListQuery as-is —
// scope/filter/pagination logic lives exclusively in lib/attendance-exceptions.ts.
export default async function AdminAttendanceExceptionsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  // Permission-checked, not role-checked — a role membership without the underlying grant (e.g.
  // if attendance.exception.read.all were ever revoked from ADMIN) must not see this page.
  if (!(await hasPermission(session.user.roles, 'attendance.exception.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires the attendance.exception.read.all permission.', 'Доступ запрещён — для этой страницы требуется право attendance.exception.read.all.')}
        </p>
      </main>
    );
  }

  const sp = await searchParams;
  // siteId/employeeId/payrollPeriodId have no picker UI this slice but remain supported filters —
  // a direct URL (or a paged/re-submitted link carrying one forward) must still apply it, not
  // silently ignore it.
  const rawQuery = {
    status: one(sp.status),
    type: one(sp.type),
    from: one(sp.from),
    to: one(sp.to),
    siteId: one(sp.siteId),
    employeeId: one(sp.employeeId),
    payrollPeriodId: one(sp.payrollPeriodId)
  };
  const parsed = parseExceptionListQuery(
    {
      page: one(sp.page),
      pageSize: one(sp.pageSize),
      status: rawQuery.status,
      type: rawQuery.type,
      siteId: rawQuery.siteId,
      employeeId: rawQuery.employeeId,
      payrollPeriodId: rawQuery.payrollPeriodId,
      from: rawQuery.from,
      to: rawQuery.to
    },
    { allowEmployeeId: true }
  );

  let outcome: ExceptionsListOutcome;
  if (!parsed.ok) {
    outcome = { kind: 'invalid', fieldErrors: parsed.fieldErrors };
  } else {
    const result = await listAttendanceExceptions(parsed.filters, null);
    outcome = { kind: 'ok', result };
  }

  return (
    <main className="setup-page">
      <ExceptionsListView basePath={BASE_PATH} title={localeText(locale, 'Attendance exceptions', 'Исключения учёта')} rawQuery={rawQuery} outcome={outcome} locale={locale} />
    </main>
  );
}
