import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getAttendanceExceptionDetail, UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getResolutionContext } from '@/lib/attendance-exception-resolution-context';
import { ExceptionDetailView } from '@/components/attendance-exceptions/ExceptionDetailView';
import { ExceptionActionPanel } from '@/components/attendance-exceptions/ExceptionActionPanel';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/attendance/exceptions';
const API_BASE_PATH = '/api/admin/attendance/exceptions';

type RouteParams = { params: Promise<{ exceptionId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md `/admin/attendance/exceptions/[exceptionId]` (T7A.8C.1 list/
// detail foundation, T7A.8C.2 adds the resolution action panel below). Malformed/missing
// exceptionId renders the same safe "not found" card — no UUID-shape oracle.
export default async function AdminAttendanceExceptionDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  if (!(await hasPermission(session.user.roles, 'attendance.exception.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires the attendance.exception.read.all permission.', 'Доступ запрещён — для этой страницы требуется право attendance.exception.read.all.')}
        </p>
      </main>
    );
  }

  const { exceptionId } = await params;
  // GPS-1 — a viewer with attendance.gps.read.raw also gets the raw coordinates + the site geofence
  // for the "where was this" mini-map on GPS exceptions.
  const includeRawGps = await hasPermission(session.user.roles, 'attendance.gps.read.raw');
  const detail = UUID_PATTERN.test(exceptionId) ? await getAttendanceExceptionDetail(exceptionId, null, { includeRawGps }) : null;

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

  // Permission-checked independently of read.all (task §2) — a viewer with read but not resolve
  // gets a read-only card (ExceptionActionPanel itself renders that explanation for a null context).
  let resolutionPanel = null;
  if (detail.status === 'OPEN') {
    const canResolve = await hasPermission(session.user.roles, 'attendance.exception.resolve.all');
    const context = canResolve
      ? await getResolutionContext(exceptionId, { scope: null, canReasonEdit: await hasPermission(session.user.roles, 'timesheet.draft.edit.exception') })
      : null;
    resolutionPanel = <ExceptionActionPanel apiBasePath={API_BASE_PATH} exceptionId={exceptionId} context={context} />;
  }

  return (
    <main className="setup-page">
      <ExceptionDetailView basePath={BASE_PATH} detail={detail} timesheetHref={detail.timesheet ? `/admin/timesheets/${detail.timesheet.id}` : null} resolutionPanel={resolutionPanel} locale={locale} />
    </main>
  );
}
