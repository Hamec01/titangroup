import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { getAttendanceExceptionDetail, UUID_PATTERN } from '@/lib/attendance-exceptions';
import { ExceptionDetailView } from '@/components/attendance-exceptions/ExceptionDetailView';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/foreman/attendance/exceptions';

type RouteParams = { params: Promise<{ exceptionId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md `/foreman/attendance/exceptions/[exceptionId]` (T7A.8C.1).
// Scope recomputed fresh on every request (never cached) — an expired/added ForemanAssignment
// between the list and this detail view changes visibility immediately. Malformed id, missing
// exception, and existing-but-out-of-scope exception all render the identical safe "not found"
// card — no oracle. FOREMAN never gets a clickable timesheet link (ADMIN-only per the DTO
// contract) and the own<->foreign OVERLAPPING_SHIFT redaction is whatever
// getAttendanceExceptionDetail already returned — this page never second-guesses a null.
export default async function ForemanAttendanceExceptionDetailPage({ params }: RouteParams) {
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

  const { exceptionId } = await params;
  let detail = null;
  if (UUID_PATTERN.test(exceptionId)) {
    const ownSiteIds = await getForemanSiteIds(session.user.id, helsinkiToday());
    detail = await getAttendanceExceptionDetail(exceptionId, { ownSiteIds, excludeEmployeeId: session.user.employeeId });
  }

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
      <ExceptionDetailView basePath={BASE_PATH} detail={detail} timesheetHref={null} />
    </main>
  );
}
