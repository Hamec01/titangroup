import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { NewCityForm } from './NewCityForm';

export const dynamic = 'force-dynamic';

export default async function NewCityPage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');

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
        <h1>New city</h1>
        <p className="setup-subtitle">Create a city, then select it when creating or editing a site.</p>
        <NewCityForm />
      </div>
    </main>
  );
}
