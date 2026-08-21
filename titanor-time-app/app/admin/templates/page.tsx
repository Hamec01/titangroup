import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listTemplates } from '@/lib/templates';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

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
  const s = adminDailyStrings(await resolveAppLocale());

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

  const { items, totalItems } = await listTemplates(1, PAGE_SIZE);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{s.templates.title}</h1>
        <p className="setup-subtitle">
          {totalItems} {totalItems === 1 ? s.templates.singular : s.templates.plural} · <Link href="/admin/templates/new">{s.templates.create}</Link>
        </p>
        {items.length === 0 ? (
          <p>{s.templates.empty}</p>
        ) : (
          <div className="worker-table-scroll">
            <table className="worker-table">
              <thead>
                <tr>
                  <th>{s.common.name}</th>
                  <th>{s.common.status}</th>
                  <th>{s.templates.currentVersion}</th>
                  <th>{s.templates.workingDays}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((template) => (
                  <tr key={template.id}>
                    <td>
                      <Link href={`/admin/templates/${template.id}`}>{template.name}</Link>
                    </td>
                    <td>{template.active ? s.common.active : s.common.inactive}</td>
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
