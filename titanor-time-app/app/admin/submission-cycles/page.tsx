import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { listActiveWorkerSubmissionSchedules } from '@/lib/timesheet-submission-schedules';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

export default async function AdminSubmissionCyclesPage() {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const locale = await resolveAppLocale();
  if (!(await hasPermission(session.user.roles, 'timesheet.schedule.read'))) {
    return <main className="setup-page"><p className="login-error" role="alert">{localeText(locale, 'Access denied — this page requires timesheet.schedule.read.', 'Доступ запрещён — для этой страницы нужно право timesheet.schedule.read.')}</p></main>;
  }

  const [workers, canUpdate] = await Promise.all([listActiveWorkerSubmissionSchedules(), hasPermission(session.user.roles, 'timesheet.schedule.update')]);
  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{localeText(locale, 'Timesheet submission cycles', 'Циклы отправки табеля')}</h1>
        <p className="setup-subtitle">{localeText(locale, 'Each active worker submits weekly or every two weeks. The displayed current and next periods are prepared automatically after saving.', 'Каждый активный работник отправляет табель еженедельно или раз в две недели. После сохранения текущий и следующий периоды создаются автоматически.')}</p>
        {workers.length === 0 ? <p>{localeText(locale, 'No active workers yet.', 'Активных работников пока нет.')}</p> : (
          <div className="worker-table-scroll"><table className="worker-table"><thead><tr><th>{localeText(locale, 'Worker', 'Работник')}</th><th>{localeText(locale, 'Cycle', 'Цикл')}</th><th>{localeText(locale, 'Current period', 'Текущий период')}</th><th /></tr></thead><tbody>{workers.map((worker) => <tr key={worker.employeeId}><td><strong>{worker.employeeName}</strong><div className="setup-subtitle">#{worker.employeeNumber}</div></td><td>{worker.scheduleName ? <>{worker.scheduleName}{worker.inheritedCompanyDefault ? <><br /><span className="field-error">{localeText(locale, 'Not assigned yet — this is only a preview of the default', 'Не назначено — это только предпросмотр значения по умолчанию')}</span></> : ''}</> : localeText(locale, 'No active company default', 'Нет активного цикла по умолчанию')}</td><td>{worker.inheritedCompanyDefault ? <span className="field-error">{localeText(locale, 'Not created — worker sees no period', 'Не создан — работник его не видит')}</span> : (worker.currentPeriod ? `${worker.currentPeriod.startDate} - ${worker.currentPeriod.endDate}` : '—')}</td><td>{canUpdate ? <Link className="setup-action" href={`/admin/workers/${worker.employeeId}#worker-submission`}>{localeText(locale, 'Configure', 'Настроить')}</Link> : null}</td></tr>)}</tbody></table></div>
        )}
      </div>
    </main>
  );
}