import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getForemanOverview } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review` — split into standard (no exception,
// bulk-approvable) vs exceptions (individual review only).
export default async function ForemanReviewPage() {
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

  const overview = await getForemanOverview(session.user.id, session.user.employeeId, helsinkiToday());
  const standardCount = overview.pendingCount - overview.exceptionCount;

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>Review queue</h1>
        {overview.pendingCount === 0 ? (
          <p className="wk-empty">Nothing waiting for review on your sites.</p>
        ) : (
          <ul className="setup-list">
            <li className="setup-item">
              <Link href="/foreman/review/standard">Standard ({standardCount})</Link>
            </li>
            <li className="setup-item">
              <Link href="/foreman/review/exceptions">With exceptions ({overview.exceptionCount})</Link>
            </li>
          </ul>
        )}
        <p>
          <Link href="/foreman">Back to overview</Link>
        </p>
      </div>
    </main>
  );
}
