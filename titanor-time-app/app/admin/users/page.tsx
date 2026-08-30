import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listUsers } from '@/lib/users';
import { ActivationCodeIssuer } from './ActivationCodeIssuer';
import { RecoveryCodeIssuer } from '@/components/account/RecoveryCodeIssuer';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

const USER_STATUS_LABELS: Record<string, { en: string; ru: string }> = {
  PENDING_ACTIVATION: { en: 'PENDING_ACTIVATION', ru: 'Ожидает активации' },
  ACTIVE: { en: 'ACTIVE', ru: 'Активен' },
  OFFBOARDING: { en: 'OFFBOARDING', ru: 'Увольнение' },
  DEACTIVATED: { en: 'DEACTIVATED', ru: 'Деактивирован' }
};

function userStatusLabel(status: string, locale: AppLocale): string {
  const entry = USER_STATUS_LABELS[status];
  if (!entry) return status;
  return locale === 'RU' ? entry.ru : entry.en;
}

function statusBadge(status: string, locale: AppLocale): ReactNode {
  const done = status === 'ACTIVE';
  return <span className={`setup-status ${done ? 'setup-status-done' : 'setup-status-pending'}`}>{userStatusLabel(status, locale)}</span>;
}

// docs/titanor-time/01_SCREEN_MAP.md — /admin/users. System users (FOREMAN/ADMIN/SUPER_ADMIN,
// including dual-role FOREMAN+WORKER) — not the worker roster (that's /admin/workers). Page 1
// only, no pager UI — same simplicity as /admin/workers.
export default async function AdminUsersPage() {
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

  const { items, totalItems } = await listUsers({ page: 1, pageSize: PAGE_SIZE });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Users', 'Пользователи')}</h1>
        <p className="setup-subtitle">
          {localeText(locale, `${totalItems} system user${totalItems === 1 ? '' : 's'}`, `Системных пользователей: ${totalItems}`)} ·{' '}
          <Link href="/admin/users/new">{localeText(locale, 'Add foreman', 'Добавить прораба')}</Link>
        </p>
        {items.length === 0 ? (
          <p>{localeText(locale, 'No system users yet.', 'Системных пользователей пока нет.')}</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>{localeText(locale, 'Username', 'Логин')}</th>
                <th>{localeText(locale, 'Email', 'Email')}</th>
                <th>{s.common.status}</th>
                <th>{localeText(locale, 'Roles', 'Роли')}</th>
                <th>{localeText(locale, 'Employee', 'Работник')}</th>
                <th>{localeText(locale, 'Activation', 'Активация')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>{user.email ?? '—'}</td>
                  <td>{statusBadge(user.status, locale)}</td>
                  <td>{user.roles.join(', ')}</td>
                  <td>
                    {user.employee ? (
                      <Link href={`/admin/workers/${user.employee.id}`}>
                        {user.employee.firstName} {user.employee.lastName} (#{user.employee.employeeNumber})
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {user.employee ? (
                      <span>{localeText(locale, 'Uses worker activation / existing password', 'Использует активацию работника / существующий пароль')}</span>
                    ) : user.status === 'PENDING_ACTIVATION' ? (
                      <ActivationCodeIssuer userId={user.id} />
                    ) : user.status === 'ACTIVE' || user.status === 'OFFBOARDING' ? (
                      <>
                        <span>{localeText(locale, 'Activated', 'Активирован')}</span>
                        <RecoveryCodeIssuer kind="user" id={user.id} />
                      </>
                    ) : (
                      <span>{userStatusLabel(user.status, locale)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
