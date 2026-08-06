import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listEmployeesForForemanSelect } from '@/lib/users';
import { NewUserForm } from './NewUserForm';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md — /admin/users/new. Same auth/role gate shape as
// app/admin/workers/new/page.tsx.
export default async function NewUserPage() {
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

  const employees = await listEmployeesForForemanSelect();

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>Add foreman</h1>
        <p className="setup-subtitle">
          Create a standalone FOREMAN account, or grant the FOREMAN role to an existing worker (dual-role).
        </p>
        <NewUserForm employees={employees} />
      </div>
    </main>
  );
}
