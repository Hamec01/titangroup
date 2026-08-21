import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listAssignments } from '@/lib/assignments';
import { AssignmentPrimaryToggle } from './AssignmentPrimaryToggle';
import { EndAssignmentAction } from './EndAssignmentAction';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md — read-only assignment list
// (PROJECT_ROADMAP.md T6.8 continuation, GET /api/admin/assignments).
// Page 1 only, no search/filter/sort UI — not called out for this specific
// endpoint's contract (unlike GET /api/admin/sites), same scope call as
// /admin/workers's list page.
export default async function AdminAssignmentsPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const s = adminDailyStrings(await resolveAppLocale());

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

  const { items, totalItems } = await listAssignments(1, PAGE_SIZE);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.assignments.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.assignments.singular : s.assignments.plural} ·{' '}
          <Link href="/admin/assignments/new">{s.common.createNew}</Link>
        </p>
        {items.length === 0 ? (
          <p>{s.assignments.empty}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.assignments.worker}</th>
                <th>{s.assignments.site}</th>
                <th>{s.assignments.workArea}</th>
                <th>{s.assignments.template}</th>
                <th>{s.assignments.validFrom}</th>
                <th>{s.assignments.validTo}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((assignment) => (
                <tr key={assignment.id}>
                  <td>
                    <Link href={`/admin/workers/${assignment.employeeId}`}>{assignment.employeeName}</Link>
                    {assignment.isPrimary ? ` (${s.common.primary})` : ''}
                  </td>
                  <td>
                    <Link href={`/admin/sites/${assignment.siteId}`}>{assignment.siteName}</Link>
                  </td>
                  <td>{assignment.workAreaName ?? '—'}</td>
                  <td>{assignment.templateName ?? '—'}</td>
                  <td>{assignment.validFrom}</td>
                  <td>{assignment.validTo ?? s.common.indefinite}</td>
                  <td>
                    <AssignmentPrimaryToggle assignment={assignment} />
                    <EndAssignmentAction assignment={assignment} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
