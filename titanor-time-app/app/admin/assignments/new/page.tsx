import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewAssignmentForm } from './NewAssignmentForm';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/assignments/new). Same
// auth/role gate shape as the other /admin/*/new pages — deliberately no
// sibling loading.tsx (IMPLEMENTATION_STATUS.md §10).
export default async function NewAssignmentPage() {
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
        <h1>New assignment</h1>
        <p className="setup-subtitle">Assigns a worker to a site (and optionally a work area).</p>
        <NewAssignmentForm />
      </div>
    </main>
  );
}
