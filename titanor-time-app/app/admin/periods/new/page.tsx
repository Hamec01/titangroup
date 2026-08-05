import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewPeriodForm } from './NewPeriodForm';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/periods/new). Same auth/role gate shape as
// /admin/sites/new — deliberately no sibling loading.tsx (IMPLEMENTATION_STATUS.md §10).
export default async function NewPeriodPage() {
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

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>Open new period</h1>
        <p className="setup-subtitle">
          Generates draft timesheets for every employee with a site assignment intersecting these dates.
        </p>
        <NewPeriodForm />
      </div>
    </main>
  );
}
