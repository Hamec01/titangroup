import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getTemplateDetail } from '@/lib/templates';
import { WEEKDAY_LABELS } from '../TemplateDaysEditor';
import { EditTemplateForm } from './EditTemplateForm';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ templateId: string }> };

// docs/titanor-time/01_SCREEN_MAP.md — /admin/templates/[templateId]. The read-only card of the
// current version's 7 days always renders (Server Component, no JS required); EditTemplateForm
// below it is the separate client-side mutation path — saving there creates a new immutable
// WorkScheduleTemplateVersion (docs/titanor-time/03_DATA_MODEL_ERD.md §4.5), never rewrites this
// one, so the read-only card above never needs to hide itself while editing.
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

        <EditTemplateForm template={template} />

        <p>
          <Link href="/admin/templates">Back to templates</Link>
        </p>
      </div>
    </main>
  );
}
