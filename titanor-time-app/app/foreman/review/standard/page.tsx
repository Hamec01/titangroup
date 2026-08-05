import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listForemanReviewScopes } from '@/lib/foreman-review';
import { helsinkiToday } from '@/lib/workers';
import { BulkApproveList } from './BulkApproveList';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/standard` — hasException=false,
// candidates for POST /api/foreman/review-scopes/bulk-approve.
export default async function ForemanReviewStandardPage() {
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

  const { items, totalItems } = await listForemanReviewScopes({
    foremanUserId: session.user.id,
    foremanEmployeeId: session.user.employeeId,
    today: helsinkiToday(),
    hasException: false,
    page: 1,
    pageSize: PAGE_SIZE
  });

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>Standard</h1>
        <p className="setup-subtitle">{totalItems} without exceptions</p>
        {items.length === 0 ? <p className="wk-empty">Nothing here.</p> : <BulkApproveList items={items} />}
        <p>
          <Link href="/foreman/review">Back to review queue</Link>
        </p>
      </div>
    </main>
  );
}
