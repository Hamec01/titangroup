import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getAccountSettings } from '@/lib/account';
import { AccountSettingsForm } from '@/components/account/AccountSettingsForm';
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm';
import { SessionsPanel } from '@/components/account/SessionsPanel';

export const dynamic = 'force-dynamic';

export default async function AdminProfilePage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) redirect('/login');
  const account = await getAccountSettings(session.user.id);
  if (!account) redirect('/login');

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{session.user.locale === 'RU' ? 'Профиль администратора' : 'Administrator profile'}</h1>
        <AccountSettingsForm initialEmail={account.email} username={account.username} roles={account.roles} />
        <ChangePasswordForm />
        <SessionsPanel />
      </div>
    </main>
  );
}
