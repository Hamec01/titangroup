import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listPeriods } from '@/lib/periods';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §7 — GET /api/admin/periods list UI. Closes
// the last unchecked /admin/setup checklist destination that still only had curl access.
export default async function AdminPeriodsPage() {
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

  const periods = await listPeriods();

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.periods.title}</h1>
        <p className="setup-subtitle">
          {periods.length} {periods.length === 1 ? s.periods.singular : s.periods.plural}
        </p>
        <div className="worker-setup-callout">
          <p>
            {s.periods.help1}
          </p>
          <p>{s.periods.help2}</p>
        </div>
        {periods.length === 0 ? (
          <p>{s.periods.empty}</p>
        ) : (
          <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.common.start}</th>
                <th>{s.common.end}</th>
                <th>{s.common.status}</th>
                <th>{s.periods.cycle}</th>
                <th>{s.periods.workers}</th>
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
                  <td>{period.submissionSchedule?.name ?? s.periods.legacy}</td>
                  <td>{period.participantsCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </main>
  );
}
