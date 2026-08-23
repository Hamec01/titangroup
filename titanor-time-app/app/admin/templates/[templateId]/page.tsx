import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getTemplateDetail } from '@/lib/templates';
import { WEEKDAY_LABELS } from '../TemplateDaysEditor';
import { EditTemplateForm } from './EditTemplateForm';
import { TemplateActivationAction } from './TemplateActivationAction';
import { resolveAppLocale } from '@/lib/i18n/server';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';

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

  const { templateId } = await params;
  const template = await getTemplateDetail(templateId);

  if (!template) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            {s.templates.notFound}
          </p>
          <Link href="/admin/templates">{s.templates.back}</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{template.name}</h1>
        <p className="setup-subtitle">
          {template.active ? s.common.active : s.common.inactive} · {s.common.version} {template.currentVersionNumber}
        </p>
        {template.description ? <p>{template.description}</p> : null}

        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{s.templates.day}</th>
                <th>{s.templates.workingDay}</th>
                <th>{s.common.start}</th>
                <th>{s.common.end}</th>
                <th>{s.templates.break}</th>
              </tr>
            </thead>
            <tbody>
              {template.days.map((day) => (
                <tr key={day.weekday}>
                  <td>{locale === 'RU' ? ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'][day.weekday - 1] : WEEKDAY_LABELS[day.weekday]}</td>
                  <td>{day.isWorkingDay ? s.common.yes : s.common.off}</td>
                  <td>{day.plannedStartTime ?? '—'}</td>
                  <td>{day.plannedEndTime ?? '—'}</td>
                  <td>{day.isWorkingDay ? `${day.plannedBreakMinutes} ${s.templates.minutes}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TemplateActivationAction template={template} />
        <EditTemplateForm template={template} />

        <p>
          <Link href="/admin/templates">{s.templates.back}</Link>
        </p>
      </div>
    </main>
  );
}
