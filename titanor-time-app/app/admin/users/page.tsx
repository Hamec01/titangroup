import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listUsers } from '@/lib/users';
import { ActivationCodeIssuer } from './ActivationCodeIssuer';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

function statusBadge(status: string): ReactNode {
  const done = status === 'ACTIVE';
  return <span className={`setup-status ${done ? 'setup-status-done' : 'setup-status-pending'}`}>{status}</span>;
}

// docs/titanor-time/01_SCREEN_MAP.md — /admin/users. System users (FOREMAN/ADMIN/SUPER_ADMIN,
// including dual-role FOREMAN+WORKER) — not the worker roster (that's /admin/workers). Page 1
// only, no pager UI — same simplicity as /admin/workers.
export default async function AdminUsersPage() {
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

  const { items, totalItems } = await listUsers({ page: 1, pageSize: PAGE_SIZE });

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Users</h1>
        <p className="setup-subtitle">
          {totalItems} system user{totalItems === 1 ? '' : 's'} ·{' '}
          <Link href="/admin/users/new">Add foreman</Link>
        </p>
        {items.length === 0 ? (
          <p>No system users yet.</p>
        ) : (
          <table className="worker-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Status</th>
                <th>Roles</th>
                <th>Employee</th>
                <th>Activation</th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>{user.email ?? '—'}</td>
                  <td>{statusBadge(user.status)}</td>
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
                      <span>Uses worker activation / existing password</span>
                    ) : user.status === 'PENDING_ACTIVATION' ? (
                      <ActivationCodeIssuer userId={user.id} />
                    ) : user.status === 'ACTIVE' ? (
                      <span>Activated</span>
                    ) : (
                      <span>{user.status}</span>
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
