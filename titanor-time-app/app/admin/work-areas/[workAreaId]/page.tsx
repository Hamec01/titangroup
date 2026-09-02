import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getWorkAreaDetail } from '@/lib/work-areas';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { WorkAreaToggle } from './WorkAreaToggle';

export const dynamic = 'force-dynamic';

// "Click a customer → who's on it". Reached from the customers list and from a site's own
// "Customers" section. Read-only apart from the deactivate/reactivate toggle.
export default async function WorkAreaDetailPage({ params }: { params: Promise<{ workAreaId: string }> }) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';

  if (!(await hasPermission(session.user.roles, 'workarea.read.all'))) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {localeText(locale, 'Access denied — this page requires workarea.read.all.', 'Доступ запрещён — для этой страницы нужно право workarea.read.all.')}
        </p>
      </main>
    );
  }

  const { workAreaId } = await params;
  const [area, canManage] = await Promise.all([
    getWorkAreaDetail(workAreaId),
    hasPermission(session.user.roles, 'workarea.update')
  ]);

  if (!area) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">{ru ? 'Заказчик с таким идентификатором не найден.' : 'No customer found with this id.'}</p>
        </div>
      </main>
    );
  }

  const renderWorker = (w: (typeof area.currentWorkers)[number], past: boolean) => (
    <li key={`${w.employeeId}-${w.validFrom}`} className="setup-item">
      <span className="setup-label">
        <Link href={`/admin/workers/${w.employeeId}`}>
          #{w.employeeNumber} {w.name}
        </Link>
        {w.isPrimary ? ` (${ru ? 'основной' : 'primary'})` : ''}
        {w.templateName ? ` — ${w.templateName}` : ''}
      </span>
      {past ? (
        <span className="setup-subtitle">
          {w.validFrom} → {w.validTo}
        </span>
      ) : null}
    </li>
  );

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{area.name}</h1>
        <p className="setup-subtitle">
          {ru ? 'Заказчик' : 'Customer'} · {ru ? 'объект' : 'site'}:{' '}
          <Link href={`/admin/sites/${area.site.id}`}>{area.site.name}</Link> ·{' '}
          {area.active ? (ru ? 'активен' : 'active') : ru ? 'отключён' : 'inactive'} ·{' '}
          <Link href="/admin/work-areas">{ru ? 'все заказчики' : 'all customers'}</Link>
        </p>

        <h2>{ru ? 'Текущие работники' : 'Current workers'}</h2>
        {area.currentWorkers.length === 0 ? (
          <div className="worker-setup-callout">
            <p>{ru ? 'На этого заказчика сейчас никто не назначен.' : 'No worker is currently assigned to this customer.'}</p>
          </div>
        ) : (
          <ul className="setup-list">{area.currentWorkers.map((w) => renderWorker(w, false))}</ul>
        )}

        {area.pastWorkers.length > 0 ? (
          <details className="worker-past-assignments">
            <summary>
              {ru ? 'Работали раньше' : 'Worked here before'} ({area.pastWorkers.length})
            </summary>
            <ul className="setup-list">{area.pastWorkers.map((w) => renderWorker(w, true))}</ul>
          </details>
        ) : null}

        {canManage ? (
          <section className="worker-work-setup" aria-label={ru ? 'Статус заказчика' : 'Customer status'}>
            <h2>{ru ? 'Статус заказчика' : 'Customer status'}</h2>
            <p className="setup-subtitle">
              {area.active
                ? ru
                  ? 'Когда работа для этого заказчика закончена — отключите его. Ничего не удаляется, он просто пропадает из выбора при назначении.'
                  : 'When the work for this customer is done, deactivate it. Nothing is deleted — it just disappears from the assignment picker.'
                : ru
                  ? 'Заказчик отключён — его нельзя выбрать для новых назначений. Включите, чтобы снова им пользоваться.'
                  : 'This customer is inactive — it can\'t be chosen for new assignments. Reactivate it to use it again.'}
            </p>
            <WorkAreaToggle workArea={{ id: area.id, siteId: area.site.id, name: area.name, active: area.active, version: area.version }} />
          </section>
        ) : null}
      </div>
    </main>
  );
}
