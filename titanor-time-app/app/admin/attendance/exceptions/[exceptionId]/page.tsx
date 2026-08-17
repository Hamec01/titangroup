import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getAttendanceExceptionDetail, UUID_PATTERN } from '@/lib/attendance-exceptions';
import { ExceptionDetailView } from '@/components/attendance-exceptions/ExceptionDetailView';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/attendance/exceptions';

type RouteParams = { params: Promise<{ exceptionId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md `/admin/attendance/exceptions/[exceptionId]` (T7A.8C.1).
// Malformed/missing exceptionId renders the same safe "not found" card — no UUID-shape oracle.
export default async function AdminAttendanceExceptionDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!(await hasPermission(session.user.roles, 'attendance.exception.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the attendance.exception.read.all permission.
        </p>
      </main>
    );
  }

  const { exceptionId } = await params;
  const detail = UUID_PATTERN.test(exceptionId) ? await getAttendanceExceptionDetail(exceptionId, null) : null;

  if (!detail) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            No attendance exception with this id.
          </p>
          <Link href={BASE_PATH}>Back to exceptions</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <ExceptionDetailView basePath={BASE_PATH} detail={detail} timesheetHref={detail.timesheet ? `/admin/timesheets/${detail.timesheet.id}` : null} />
    </main>
  );
}
