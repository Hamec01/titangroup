import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewSiteForm } from './NewSiteForm';

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
        <h1>New site</h1>
        <p className="setup-subtitle">City is optional — you can create a site before any city exists.</p>
        <NewSiteForm />
      </div>
    </main>
  );
}
