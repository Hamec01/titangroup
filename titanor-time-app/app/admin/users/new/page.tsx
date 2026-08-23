import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listEmployeesForForemanSelect } from '@/lib/users';
import { hasPermission } from '@/lib/permissions';
import { NewUserForm } from './NewUserForm';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md — /admin/users/new. Same auth/role gate shape as
// app/admin/workers/new/page.tsx.
export default async function NewUserPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const s = adminDailyStrings(locale);

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

  const [employees, canCreateAdmin] = await Promise.all([
    listEmployeesForForemanSelect(),
    hasPermission(session.user.roles, 'user.create.admin')
  ]);

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>{canCreateAdmin ? localeText(locale, 'Add user', 'Добавить пользователя') : localeText(locale, 'Add foreman', 'Добавить прораба')}</h1>
        <p className="setup-subtitle">
          {canCreateAdmin
            ? localeText(
                locale,
                'Create a standalone FOREMAN or ADMIN account, or grant the FOREMAN role to an existing worker (dual-role).',
                'Создайте отдельную учётную запись прораба или администратора, либо предоставьте роль прораба существующему работнику (двойная роль).'
              )
            : localeText(locale, 'Create a standalone FOREMAN account, or grant the FOREMAN role to an existing worker (dual-role).', 'Создайте отдельную учётную запись прораба или предоставьте роль прораба существующему работнику (двойная роль).')}
        </p>
        <NewUserForm employees={employees} canCreateAdmin={canCreateAdmin} />
      </div>
    </main>
  );
}
