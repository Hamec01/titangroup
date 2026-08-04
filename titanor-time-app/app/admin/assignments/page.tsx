import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listAssignments } from '@/lib/assignments';
import { AssignmentPrimaryToggle } from './AssignmentPrimaryToggle';

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

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the ADMIN or SUPER_ADMIN role.
        </p>
      </main>
    );
  }

  const { items, totalItems } = await listAssignments(1, PAGE_SIZE);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Assignments</h1>
        <p className="setup-subtitle">
          {totalItems} assignment{totalItems === 1 ? '' : 's'} ·{' '}
          <Link href="/admin/assignments/new">create new</Link>
        </p>
        {items.length === 0 ? (
          <p>No assignments yet.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Site</th>
                <th>Work area</th>
                <th>Template</th>
                <th>Valid from</th>
                <th>Valid to</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((assignment) => (
                <tr key={assignment.id}>
                  <td>
                    <Link href={`/admin/workers/${assignment.employeeId}`}>{assignment.employeeName}</Link>
                    {assignment.isPrimary ? ' (primary)' : ''}
                  </td>
                  <td>
                    <Link href={`/admin/sites/${assignment.siteId}`}>{assignment.siteName}</Link>
                  </td>
                  <td>{assignment.workAreaName ?? '—'}</td>
                  <td>{assignment.templateName ?? '—'}</td>
                  <td>{assignment.validFrom}</td>
                  <td>{assignment.validTo ?? 'Indefinite'}</td>
                  <td>
                    <AssignmentPrimaryToggle assignment={assignment} />
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
