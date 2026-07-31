import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewTemplateForm } from './NewTemplateForm';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §? (/admin/templates/new). Same auth/role gate shape as
// /admin/setup and /admin/sites/new — deliberately no sibling loading.tsx (see
// IMPLEMENTATION_STATUS.md §10 for why that combination silently downgrades redirects for non-JS
// clients).
export default async function NewTemplatePage() {
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
        <h1>New work schedule template</h1>
        <p className="setup-subtitle">Set the planned working hours for each day of the week.</p>
        <NewTemplateForm />
      </div>
    </main>
  );
}
