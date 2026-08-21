import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewWorkerForm } from './NewWorkerForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/workers/new). Same auth/role
// gate shape as app/admin/sites/new/page.tsx — deliberately no sibling
// loading.tsx (see IMPLEMENTATION_STATUS.md §10).
export default async function NewWorkerPage() {
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

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{s.workers.newTitle}</h1>
        <p className="setup-subtitle">{s.workers.newHelp}</p>
        <NewWorkerForm />
      </div>
    </main>
  );
}
