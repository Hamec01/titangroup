import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listForemanWorkers } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/workers` — workers currently assigned to this
// foreman's own sites.
export default async function ForemanWorkersPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!session.user.roles.includes('FOREMAN')) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the FOREMAN role.
        </p>
      </main>
    );
  }

  const workers = await listForemanWorkers(session.user.id, helsinkiToday());

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>Your workers</h1>
        {workers.length === 0 ? (
          <p className="wk-empty">No one is currently assigned to your sites.</p>
        ) : (
          <ul className="setup-list">
            {workers.map((w) => (
              <li key={`${w.employeeId}:${w.siteId}`} className="setup-item">
                <span className="setup-label">{w.employeeName}</span>
                <span className="setup-status setup-status-pending">{w.siteName}</span>
              </li>
            ))}
          </ul>
        )}
        <p>
          <Link href="/foreman">Back to overview</Link>
        </p>
      </div>
    </main>
  );
}
