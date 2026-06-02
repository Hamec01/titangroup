import { cookies } from 'next/headers';
import { AdminImageManager } from '../components/admin-image-manager';
import { AdminLoginForm } from '../components/admin-login-form';
import { isAdminCookiesAuthenticated } from '../../lib/admin-auth';

export const dynamic = 'force-dynamic';

export default async function ShipAdminPortalPage() {
  const authenticated = isAdminCookiesAuthenticated(await cookies());

  return (
    <main className="page-shell admin-shell">
      <section className="content-section admin-frame">
        <div className="section-inner">
          {authenticated ? <AdminImageManager /> : <AdminLoginForm />}
        </div>
      </section>
    </main>
  );
}
