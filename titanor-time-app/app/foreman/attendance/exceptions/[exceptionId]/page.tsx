import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { getAttendanceExceptionDetail, UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getResolutionContext } from '@/lib/attendance-exception-resolution-context';
import { ExceptionDetailView } from '@/components/attendance-exceptions/ExceptionDetailView';
import { ExceptionActionPanel } from '@/components/attendance-exceptions/ExceptionActionPanel';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/foreman/attendance/exceptions';
const API_BASE_PATH = '/api/foreman/attendance/exceptions';

type RouteParams = { params: Promise<{ exceptionId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md `/foreman/attendance/exceptions/[exceptionId]` (T7A.8C.1 list/
// detail foundation, T7A.8C.2 adds the resolution action panel below — DISMISS/ACKNOWLEDGE_AS_VALID/
// PAIR_ORPHAN_EVENTS only, never CONFIRM_SOURCE_ASSIGNMENT/FORCE_CLOSE_OPEN_SHIFT/REASON_EDIT, which
// getResolutionContext itself already role-filters out — this page never even asks for those three
// admin-only contexts). Scope recomputed fresh on every request (never cached) — an expired/added
// ForemanAssignment between the list and this detail view changes visibility immediately. Malformed
// id, missing exception, and existing-but-out-of-scope exception all render the identical safe "not
// found" card — no oracle. FOREMAN never gets a clickable timesheet link (ADMIN-only per the DTO
// contract) and the own<->foreign OVERLAPPING_SHIFT redaction is whatever
// getAttendanceExceptionDetail already returned — this page never second-guesses a null.
export default async function ForemanAttendanceExceptionDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  if (!(await hasPermission(session.user.roles, 'attendance.exception.read.assigned'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires the attendance.exception.read.assigned permission.', 'Доступ запрещён — для этой страницы требуется право attendance.exception.read.assigned.')}
        </p>
      </main>
    );
  }

  const { exceptionId } = await params;
  let detail = null;
  const today = helsinkiToday();
  if (UUID_PATTERN.test(exceptionId)) {
    const ownSiteIds = await getForemanSiteIds(session.user.id, today);
    detail = await getAttendanceExceptionDetail(exceptionId, { ownSiteIds, excludeEmployeeId: session.user.employeeId });
  }

  if (!detail) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            {localeText(locale, 'No attendance exception with this id.', 'Исключение учёта с таким идентификатором не найдено.')}
          </p>
          <Link href={BASE_PATH}>{localeText(locale, 'Back to exceptions', 'К списку исключений')}</Link>
        </div>
      </main>
    );
  }

  let resolutionPanel = null;
  if (detail.status === 'OPEN') {
    const canResolve = await hasPermission(session.user.roles, 'attendance.exception.resolve.assigned');
    const context = canResolve
      ? await getResolutionContext(exceptionId, { scope: { foremanUserId: session.user.id, today, excludeEmployeeId: session.user.employeeId }, canReasonEdit: false })
      : null;
    resolutionPanel = <ExceptionActionPanel apiBasePath={API_BASE_PATH} exceptionId={exceptionId} context={context} />;
  }

  return (
    <main className="setup-page">
      <ExceptionDetailView basePath={BASE_PATH} detail={detail} timesheetHref={null} resolutionPanel={resolutionPanel} locale={locale} />
    </main>
  );
}
