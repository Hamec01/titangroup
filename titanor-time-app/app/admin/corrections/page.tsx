import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listCorrections } from '@/lib/corrections';

export const dynamic = 'force-dynamic';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 T7.9 — admin-only corrections list. New requests are
// started from the FINAL_APPROVED timesheet's own card (/admin/timesheets/[timesheetId]), not a
// standalone form here — a timesheetId is meaningless to type in by hand.
export default async function AdminCorrectionsPage() {
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

  const items = await listCorrections();

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Corrections</h1>
        <p className="setup-subtitle">{items.length} total</p>
        {items.length === 0 ? (
          <p>No correction requests yet. Start one from a FINAL_APPROVED timesheet&apos;s card.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Status</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.employeeName}</td>
                  <td>
                    <Link href={`/admin/corrections/${item.id}`}>{item.status}</Link>
                  </td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
