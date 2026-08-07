import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getTemplateDetail } from '@/lib/templates';

export const dynamic = 'force-dynamic';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.5 — weekday 0=Mon..6=Sun, same convention as
// app/admin/templates/new/NewTemplateForm.tsx.
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type RouteParams = { params: Promise<{ templateId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md — /admin/templates/[templateId], read-only card of the
// current version's 7 days. Editing (creates a new version via PATCH) is a separate future slice.
export default async function AdminTemplateDetailPage({ params }: RouteParams) {
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

  const { templateId } = await params;
  const template = await getTemplateDetail(templateId);

  if (!template) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            No template with this id.
          </p>
          <Link href="/admin/templates">Back to templates</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{template.name}</h1>
        <p className="setup-subtitle">
          {template.active ? 'Active' : 'Inactive'} · version {template.currentVersionNumber}
        </p>
        {template.description ? <p>{template.description}</p> : null}

        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Working day</th>
                <th>Start</th>
                <th>End</th>
                <th>Break</th>
              </tr>
            </thead>
            <tbody>
              {template.days.map((day) => (
                <tr key={day.weekday}>
                  <td>{WEEKDAY_LABELS[day.weekday]}</td>
                  <td>{day.isWorkingDay ? 'Yes' : 'Off'}</td>
                  <td>{day.plannedStartTime ?? '—'}</td>
                  <td>{day.plannedEndTime ?? '—'}</td>
                  <td>{day.isWorkingDay ? `${day.plannedBreakMinutes} min` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p>
          <Link href="/admin/templates">Back to templates</Link>
        </p>
      </div>
    </main>
  );
}
