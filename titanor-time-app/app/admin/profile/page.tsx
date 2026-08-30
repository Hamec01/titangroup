import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getAccountSettings } from '@/lib/account';
import { AccountSettingsForm } from '@/components/account/AccountSettingsForm';
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm';
import { SessionsPanel } from '@/components/account/SessionsPanel';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';

export const dynamic = 'force-dynamic';

export default async function AdminProfilePage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) redirect('/login');
  const account = await getAccountSettings(session.user.id);
  if (!account) redirect('/login');

  const ru = session.user.locale === 'RU';

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{ru ? 'Профиль администратора' : 'Administrator profile'}</h1>
        <AccountSettingsForm
          initialEmail={account.email}
          username={account.username}
          roles={account.roles}
          lastLoginAt={account.lastLoginAt}
        />
        <section className="account-settings" aria-labelledby="admin-profile-lang-title">
          <h2 id="admin-profile-lang-title">{ru ? 'Язык интерфейса' : 'Interface language'}</h2>
          <LanguageSwitcher />
          <p className="setup-subtitle" style={{ marginTop: 12 }}>
            <Link href="/guide">{ru ? 'Открыть инструкцию' : 'Open the user guide'}</Link>
          </p>
        </section>
        <ChangePasswordForm />
        <SessionsPanel />
      </div>
    </main>
  );
}
