import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewSiteForm } from './NewSiteForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/sites/new). Same auth/role
// gate shape as app/admin/setup/page.tsx — deliberately no sibling
// loading.tsx (see IMPLEMENTATION_STATUS.md §10: pairing an async Server
// Component redirect() with a loading.tsx made Next.js stream a 200 before
// the redirect resolved, downgrading it to a client-only redirect for
// non-JS clients).
export default async function NewSitePage() {
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
        <h1>{s.sites.newTitle}</h1>
        <p className="setup-subtitle">{s.sites.newHelp}</p>
        <NewSiteForm />
      </div>
    </main>
  );
}
