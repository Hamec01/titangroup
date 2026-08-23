import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getWorkerTimeReport, type WorkerTimeReport } from '@/lib/worker-time-report';
import { listEmployeesForReportSelect } from '@/lib/users';
import { listPeriodOptions } from '@/lib/attendance-overview-lookups';
import { formatWorkedDuration, timesheetStatusLabel, dataSourceLabel } from '@/lib/reporting/report-format';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const REQUIRED_PERMISSIONS = ['worker.read.all', 'period.read.all', 'timesheet.read.all'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

type Outcome = { kind: 'prompt' } | { kind: 'worker-not-found' } | { kind: 'period-not-found' } | { kind: 'ok'; report: WorkerTimeReport };

// docs/titanor-time/T8_REPORTS_DESIGN.md + 01_SCREEN_MAP.md `/admin/reports` — Server Component,
// filters live in the URL (employeeId/periodId), submit is a plain GET navigation, no client-side
// fetch. Calls getWorkerTimeReport() directly — the exact same function the API route calls, no
// HTTP self-fetch, one shared REPEATABLE READ transaction contract.
export default async function AdminReportsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            {localeText(locale, `Access denied — this page requires the ${permissionCode} permission.`, `Доступ запрещён — для этой страницы требуется право ${permissionCode}.`)}
          </p>
        </main>
      );
    }
  }

  const sp = await searchParams;
  const employeeId = one(sp.employeeId);
  const periodId = one(sp.periodId);
  const hasBothFilters = !!employeeId && !!periodId && UUID_PATTERN.test(employeeId) && UUID_PATTERN.test(periodId);

  let outcome: Outcome = { kind: 'prompt' };
  if (hasBothFilters) {
    const result = await getWorkerTimeReport(employeeId as string, periodId as string);
    if (result.code === 'WORKER_NOT_FOUND') {
      outcome = { kind: 'worker-not-found' };
    } else if (result.code === 'PERIOD_NOT_FOUND') {
      outcome = { kind: 'period-not-found' };
    } else {
      outcome = { kind: 'ok', report: result.report };
    }
  }

  const [employeeOptions, periodOptions] = await Promise.all([listEmployeesForReportSelect(), listPeriodOptions()]);
  const ru = locale === 'RU';

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Отчёт по времени работника' : 'Worker time report'}</h1>
        <AdminReportTabs active="worker" locale={locale} />
        <p className="setup-subtitle">{ru ? 'Выберите работника и расчётный период, чтобы увидеть статус табеля, часы по объектам и итог.' : 'Select a worker and a payroll period to see their timesheet status, hours by site, and total.'}</p>

        {employeeOptions.length === 0 ? (
          <p role="status">{ru ? 'Работников пока нет.' : 'No workers exist yet.'}</p>
        ) : periodOptions.length === 0 ? (
          <p role="status">{ru ? 'Расчётных периодов пока нет.' : 'No payroll periods exist yet.'}</p>
        ) : (
          <form method="GET" action="/admin/reports" className="ov-filters" aria-label={ru ? 'Выбор работника и периода' : 'Select worker and period'}>
            <div className="ov-filter-field">
              <label htmlFor="report-filter-employee">{ru ? 'Работник' : 'Worker'}</label>
              <select id="report-filter-employee" name="employeeId" defaultValue={employeeId ?? ''}>
                <option value="">{ru ? 'Выберите работника…' : 'Select a worker…'}</option>
                {employeeOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.lastName} {e.firstName} ({e.employeeNumber})
                  </option>
                ))}
              </select>
            </div>
            <div className="ov-filter-field">
              <label htmlFor="report-filter-period">{ru ? 'Расчётный период' : 'Payroll period'}</label>
              <select id="report-filter-period" name="periodId" defaultValue={periodId ?? ''}>
                <option value="">{ru ? 'Выберите период…' : 'Select a period…'}</option>
                {periodOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="ov-filter-actions">
              <button type="submit" className="exc-apply-button">
                {ru ? 'Показать отчёт' : 'Show report'}
              </button>
              <Link href="/admin/reports" className="exc-reset-link">
                {ru ? 'Сбросить' : 'Reset'}
              </Link>
            </div>
          </form>
        )}

        <ReportBody outcome={outcome} locale={locale} />
      </div>
    </main>
  );
}

function ReportBody({ outcome, locale }: { outcome: Outcome; locale: AppLocale }) {
  const ru = locale === 'RU';
  if (outcome.kind === 'prompt') {
    return (
      <p role="status" className="setup-subtitle">
        {ru ? 'Выберите работника и расчётный период выше, чтобы увидеть отчёт.' : 'Choose a worker and a payroll period above to see their report.'}
      </p>
    );
  }
  if (outcome.kind === 'worker-not-found') {
    return (
      <p className="login-error" role="alert">
        {ru ? 'Работник с таким идентификатором не найден.' : 'No worker with this id.'}
      </p>
    );
  }
  if (outcome.kind === 'period-not-found') {
    return (
      <p className="login-error" role="alert">
        {ru ? 'Расчётный период с таким идентификатором не найден.' : 'No payroll period with this id.'}
      </p>
    );
  }

  const { report } = outcome;

  return (
    <div aria-live="polite">
      <h2>
        {report.employee.lastName} {report.employee.firstName} <span className="setup-subtitle">({report.employee.employeeNumber})</span>
      </h2>
      <p className="setup-subtitle">
        {ru ? 'Период' : 'Period'} {report.period.startDate} – {report.period.endDate} · {report.period.status}
      </p>
      {report.participant && !report.participant.expected && (
        <p role="status" className="setup-subtitle">
          {ru ? 'Этот работник был исключён из этого расчётного периода.' : 'This worker was excluded from this payroll period.'}
        </p>
      )}

      {!report.timesheet ? (
        <p role="status" className="setup-subtitle">
          {ru ? 'Табель для этого работника за этот период не существует.' : 'No timesheet exists for this worker in this period.'}
        </p>
      ) : (
        <p className="setup-subtitle">
          {ru ? 'Статус табеля:' : 'Timesheet status:'} <strong>{timesheetStatusLabel(report.timesheet.status, locale)}</strong> · {dataSourceLabel(report.timesheet.dataSource, report.timesheet.versionNumber, locale)}
        </p>
      )}

      {report.sites.length === 0 ? (
        <p role="status">{ru ? 'В этом периоде нет отработанных интервалов.' : 'No worked segments in this period.'}</p>
      ) : (
        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{ru ? 'Объект' : 'Site'}</th>
                <th>{ru ? 'Всего' : 'Gross'}</th>
                <th>{ru ? 'Оплач. перерыв' : 'Paid break'}</th>
                <th>{ru ? 'Неоплач. перерыв' : 'Unpaid break'}</th>
                <th>{ru ? 'Отработано' : 'Worked'}</th>
                <th>{ru ? 'Интервалы' : 'Segments'}</th>
                <th>{ru ? 'Дни' : 'Days'}</th>
              </tr>
            </thead>
            <tbody>
              {report.sites.map((s) => (
                <tr key={s.siteId}>
                  <td>{s.siteName}</td>
                  <td>{formatWorkedDuration(s.grossMinutes, locale)}</td>
                  <td>{formatWorkedDuration(s.paidBreakMinutes, locale)}</td>
                  <td>{formatWorkedDuration(s.unpaidBreakMinutes, locale)}</td>
                  <td>{formatWorkedDuration(s.workedMinutes, locale)}</td>
                  <td>{s.segmentCount}</td>
                  <td>{s.workedDayCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{ru ? `Итого (объектов: ${report.total.siteCount})` : `Total (${report.total.siteCount} site${report.total.siteCount === 1 ? '' : 's'})`}</th>
                <th>{formatWorkedDuration(report.total.grossMinutes, locale)}</th>
                <th>{formatWorkedDuration(report.total.paidBreakMinutes, locale)}</th>
                <th>{formatWorkedDuration(report.total.unpaidBreakMinutes, locale)}</th>
                <th>{formatWorkedDuration(report.total.workedMinutes, locale)}</th>
                <th>{report.total.segmentCount}</th>
                <th>{report.total.workedDayCount}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
