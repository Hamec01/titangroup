import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getForemanOverview } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman` — overview, closes the 404 gap /login has
// redirected FOREMAN into since the very start of the project (same situation /worker was in
// before ЭТАП 7's UI slice, and /admin/setup before that).
export default async function ForemanOverviewPage() {
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

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>Review queue</h1>
        {overview.pendingCount === 0 ? (
          <p className="wk-empty">Nothing waiting for review on your sites.</p>
        ) : (
          <>
            <p className="setup-subtitle">
              {overview.pendingCount} pending{overview.exceptionCount > 0 ? `, ${overview.exceptionCount} with an exception` : ''}
            </p>
            <Link href="/foreman/review" className="wk-action-button">
              Go to review queue
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
