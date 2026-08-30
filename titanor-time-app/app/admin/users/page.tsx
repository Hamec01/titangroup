import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import {
  listUsers,
  parseUserListQuery,
  USER_LIST_ROLE_VALUES,
  USER_LIST_STATUS_VALUES,
  type UserListStatus
} from '@/lib/users';
import { ActivationCodeIssuer } from './ActivationCodeIssuer';
import { RecoveryCodeIssuer } from '@/components/account/RecoveryCodeIssuer';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

const USER_STATUS_LABELS: Record<string, { en: string; ru: string }> = {
  PENDING_ACTIVATION: { en: 'Pending activation', ru: 'Ожидает активации' },
  ACTIVE: { en: 'Active', ru: 'Активен' },
  OFFBOARDING: { en: 'Offboarding', ru: 'Увольнение' },
  DEACTIVATED: { en: 'Deactivated', ru: 'Деактивирован' }
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
// including dual-role FOREMAN+WORKER) — not the worker roster (that's /admin/workers).
// R09.1 — search (username/email), role + status filters, and paging, all URL-persisted so a
// filtered view can be bookmarked/shared. A bad URL param is ignored, never a 400.
export default async function AdminUsersPage({ searchParams }: RouteParams) {
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

  const sp = await searchParams;
  const query = parseUserListQuery({
    page: one(sp.page),
    pageSize: one(sp.pageSize),
    q: one(sp.q),
    role: one(sp.role),
    status: one(sp.status)
  });

  const { items, totalItems, page, totalPages } = await listUsers({
    page: query.page,
    pageSize: query.pageSize,
    q: query.q || undefined,
    role: query.role ?? undefined,
    status: query.status ?? undefined
  });

  const hasFilter = query.q !== '' || query.role !== null || query.status !== null;

  function pageHref(target: number): string {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.role) params.set('role', query.role);
    if (query.status) params.set('status', query.status);
    if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
    if (target > 1) params.set('page', String(target));
    const qs = params.toString();
    return qs ? `/admin/users?${qs}` : '/admin/users';
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Users', 'Пользователи')}</h1>
        <p className="setup-subtitle">
          {localeText(
            locale,
            `${totalItems} system user${totalItems === 1 ? '' : 's'}${hasFilter ? ' (filtered)' : ''}`,
            `Системных пользователей: ${totalItems}${hasFilter ? ' (с фильтром)' : ''}`
          )}{' '}
          · <Link href="/admin/users/new">{localeText(locale, 'Add foreman', 'Добавить прораба')}</Link>
        </p>

        <form method="GET" action="/admin/users" className="ov-filters" aria-label={localeText(locale, 'Filter users', 'Фильтр пользователей')}>
          <div className="ov-filter-field">
            <label htmlFor="users-q">{localeText(locale, 'Search', 'Поиск')}</label>
            <input
              id="users-q"
              name="q"
              type="search"
              maxLength={200}
              defaultValue={query.q}
              placeholder={localeText(locale, 'Username or email', 'Логин или email')}
            />
          </div>
          <div className="ov-filter-field">
            <label htmlFor="users-role">{localeText(locale, 'Role', 'Роль')}</label>
            <select id="users-role" name="role" defaultValue={query.role ?? ''}>
              <option value="">{localeText(locale, 'Any role', 'Любая роль')}</option>
              {USER_LIST_ROLE_VALUES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="users-status">{s.common.status}</label>
            <select id="users-status" name="status" defaultValue={query.status ?? ''}>
              <option value="">{localeText(locale, 'Any status', 'Любой статус')}</option>
              {USER_LIST_STATUS_VALUES.map((st) => (
                <option key={st} value={st}>
                  {userStatusLabel(st, locale)}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="users-pagesize">{localeText(locale, 'Per page', 'На странице')}</label>
            <select id="users-pagesize" name="pageSize" defaultValue={String(query.pageSize)}>
              {['25', '50', '100'].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-actions">
            <button type="submit" className="exc-apply-button">
              {localeText(locale, 'Apply', 'Применить')}
            </button>
            {hasFilter ? (
              <Link href="/admin/users" className="exc-reset-link">
                {localeText(locale, 'Reset', 'Сбросить')}
              </Link>
            ) : null}
          </div>
        </form>

        {items.length === 0 ? (
          <p className="wk-empty">
            {hasFilter
              ? localeText(locale, 'No users match these filters.', 'Нет пользователей по этим фильтрам.')
              : localeText(locale, 'No system users yet.', 'Системных пользователей пока нет.')}
          </p>
        ) : (
          <div className="worker-table-scroll">
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
                        <span>{userStatusLabel(user.status as UserListStatus, locale)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 ? (
          <nav className="exc-pagination" aria-label={localeText(locale, 'Pagination', 'Постраничная навигация')}>
            {page > 1 ? (
              <Link href={pageHref(page - 1)}>{localeText(locale, 'Previous', 'Назад')}</Link>
            ) : (
              <span className="exc-pagination-disabled">{localeText(locale, 'Previous', 'Назад')}</span>
            )}
            <span>{localeText(locale, `Page ${page} of ${totalPages}`, `Страница ${page} из ${totalPages}`)}</span>
            {page < totalPages ? (
              <Link href={pageHref(page + 1)}>{localeText(locale, 'Next', 'Далее')}</Link>
            ) : (
              <span className="exc-pagination-disabled">{localeText(locale, 'Next', 'Далее')}</span>
            )}
          </nav>
        ) : null}
      </div>
    </main>
  );
}
