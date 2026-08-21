import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listPeriods } from '@/lib/periods';

export const dynamic = 'force-dynamic';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §7 — GET /api/admin/periods list UI. Closes
// the last unchecked /admin/setup checklist destination that still only had curl access.
export default async function AdminPeriodsPage() {
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

  const periods = await listPeriods();

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Payroll periods</h1>
        <p className="setup-subtitle">
          {periods.length} period{periods.length === 1 ? '' : 's'}
        </p>
        <div className="worker-setup-callout">
          <p>
            A payroll period is generated from each worker&apos;s Weekly or Every two weeks setting. Keep it <strong>OPEN</strong> while workers enter hours.
          </p>
          <p>Configure the cycle on the worker page. Manual period creation is retained only for legacy recovery.</p>
        </div>
        {periods.length === 0 ? (
          <p>No periods yet.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Start</th>
                <th>End</th>
                <th>Status</th>
                <th>Cycle</th>
                <th>Workers</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id}>
                  <td>
                    <Link href={`/admin/periods/${period.id}`}>{period.startDate}</Link>
                  </td>
                  <td>{period.endDate}</td>
                  <td>{period.status}</td>
                  <td>{period.submissionSchedule?.name ?? 'Legacy manual'}</td>
                  <td>{period.participantsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
