import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listTemplates } from '@/lib/templates';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// docs/titanor-time/01_SCREEN_MAP.md — /admin/templates, read-only list (PATCH/edit is a separate
// future slice). Page 1 only, no search/filter/sort UI — same simplicity as /admin/workers's list
// page.
export default async function AdminTemplatesPage() {
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

  const { items, totalItems } = await listTemplates(1, PAGE_SIZE);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Work schedule templates</h1>
        <p className="setup-subtitle">
          {totalItems} template{totalItems === 1 ? '' : 's'} · <Link href="/admin/templates/new">Create template</Link>
        </p>
        {items.length === 0 ? (
          <p>No templates yet.</p>
        ) : (
          <div className="worker-table-scroll">
            <table className="worker-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Current version</th>
                  <th>Working days</th>
                </tr>
              </thead>
              <tbody>
                {items.map((template) => (
                  <tr key={template.id}>
                    <td>
                      <Link href={`/admin/templates/${template.id}`}>{template.name}</Link>
                    </td>
                    <td>{template.active ? 'Active' : 'Inactive'}</td>
                    <td>{template.currentVersionNumber ?? '—'}</td>
                    <td>{template.workingDaysCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
