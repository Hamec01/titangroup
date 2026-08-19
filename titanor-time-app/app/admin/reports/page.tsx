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

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            Access denied — this page requires the {permissionCode} permission.
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

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>Worker time report</h1>
        <AdminReportTabs active="worker" />
        <p className="setup-subtitle">Select a worker and a payroll period to see their timesheet status, hours by site, and total.</p>

        {employeeOptions.length === 0 ? (
          <p role="status">No workers exist yet.</p>
        ) : periodOptions.length === 0 ? (
          <p role="status">No payroll periods exist yet.</p>
        ) : (
          <form method="GET" action="/admin/reports" className="ov-filters" aria-label="Select worker and period">
            <div className="ov-filter-field">
              <label htmlFor="report-filter-employee">Worker</label>
              <select id="report-filter-employee" name="employeeId" defaultValue={employeeId ?? ''}>
                <option value="">Select a worker…</option>
                {employeeOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.lastName} {e.firstName} ({e.employeeNumber})
                  </option>
                ))}
              </select>
            </div>
            <div className="ov-filter-field">
              <label htmlFor="report-filter-period">Payroll period</label>
              <select id="report-filter-period" name="periodId" defaultValue={periodId ?? ''}>
                <option value="">Select a period…</option>
                {periodOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="ov-filter-actions">
              <button type="submit" className="exc-apply-button">
                Show report
              </button>
              <Link href="/admin/reports" className="exc-reset-link">
                Reset
              </Link>
            </div>
          </form>
        )}

        <ReportBody outcome={outcome} />
      </div>
    </main>
  );
}

function ReportBody({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === 'prompt') {
    return (
      <p role="status" className="setup-subtitle">
        Choose a worker and a payroll period above to see their report.
      </p>
    );
  }
  if (outcome.kind === 'worker-not-found') {
    return (
      <p className="login-error" role="alert">
        No worker with this id.
      </p>
    );
  }
  if (outcome.kind === 'period-not-found') {
    return (
      <p className="login-error" role="alert">
        No payroll period with this id.
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
        Period {report.period.startDate} – {report.period.endDate} · {report.period.status}
      </p>
      {report.participant && !report.participant.expected && (
        <p role="status" className="setup-subtitle">
          This worker was excluded from this payroll period.
        </p>
      )}

      {!report.timesheet ? (
        <p role="status" className="setup-subtitle">
          No timesheet exists for this worker in this period.
        </p>
      ) : (
        <p className="setup-subtitle">
          Timesheet status: <strong>{timesheetStatusLabel(report.timesheet.status)}</strong> · {dataSourceLabel(report.timesheet.dataSource, report.timesheet.versionNumber)}
        </p>
      )}

      {report.sites.length === 0 ? (
        <p role="status">No worked segments in this period.</p>
      ) : (
        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>Site</th>
                <th>Gross</th>
                <th>Paid break</th>
                <th>Unpaid break</th>
                <th>Worked</th>
                <th>Segments</th>
                <th>Days</th>
              </tr>
            </thead>
            <tbody>
              {report.sites.map((s) => (
                <tr key={s.siteId}>
                  <td>{s.siteName}</td>
                  <td>{formatWorkedDuration(s.grossMinutes)}</td>
                  <td>{formatWorkedDuration(s.paidBreakMinutes)}</td>
                  <td>{formatWorkedDuration(s.unpaidBreakMinutes)}</td>
                  <td>{formatWorkedDuration(s.workedMinutes)}</td>
                  <td>{s.segmentCount}</td>
                  <td>{s.workedDayCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total ({report.total.siteCount} site{report.total.siteCount === 1 ? '' : 's'})</th>
                <th>{formatWorkedDuration(report.total.grossMinutes)}</th>
                <th>{formatWorkedDuration(report.total.paidBreakMinutes)}</th>
                <th>{formatWorkedDuration(report.total.unpaidBreakMinutes)}</th>
                <th>{formatWorkedDuration(report.total.workedMinutes)}</th>
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
