import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewWorkerForm } from './NewWorkerForm';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/workers/new). Same auth/role
// gate shape as app/admin/sites/new/page.tsx — deliberately no sibling
// loading.tsx (see IMPLEMENTATION_STATUS.md §10).
export default async function NewWorkerPage() {
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
        <h1>New worker</h1>
        <p className="setup-subtitle">
          Creates the worker record only — no login is possible yet. Assign a site and open a payroll
          period first, then issue an activation code from the worker&apos;s profile.
        </p>
        <NewWorkerForm />
      </div>
    </main>
  );
}
