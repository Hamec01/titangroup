import Link from 'next/link';
import type { SiteTimeReport } from '@/lib/site-time-report';
import { formatWorkedDuration, timesheetStatusLabel, dataSourceLabel, submissionSourceLabel } from '@/lib/reporting/report-format';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.2B" §J — the ONLY place the site time report
// is rendered. app/admin/reports/sites/page.tsx and app/foreman/reports/sites/page.tsx are thin
// Server Component wrappers that resolve session/permissions/scope, call getSiteTimeReport()
// directly (no HTTP self-fetch), and pass everything here as props. This component makes zero
// database/API calls of its own and never recomputes/re-sums a single minute — it only formats
// numbers the backend already produced.

export interface SiteOption {
  id: string;
  name: string;
}

export interface PeriodOption {
  id: string;
  label: string;
  status: string;
}

export interface RawSiteReportFilters {
  siteId: string | null;
  periodId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type SiteReportOutcome =
  | { kind: 'prompt' }
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  | { kind: 'site-not-found' }
  | { kind: 'period-not-found' }
  | { kind: 'ok'; report: SiteTimeReport };

export interface SiteTimeReportViewProps {
  role: 'admin' | 'foreman';
  basePath: string;
  rawFilters: RawSiteReportFilters;
  siteOptions: SiteOption[];
  periodOptions: PeriodOption[];
  outcome: SiteReportOutcome;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function SiteTimeReportView({ role, basePath, rawFilters, siteOptions, periodOptions, outcome }: SiteTimeReportViewProps) {
  return (
    <div>
      <h1>Site time report</h1>
      <ReportTypeTabs role={role} />

      {siteOptions.length === 0 ? (
        <p role="status" className="setup-subtitle">
          {role === 'foreman' ? 'You have no currently assigned sites.' : 'No work sites exist yet.'}
        </p>
      ) : periodOptions.length === 0 ? (
        <p role="status" className="setup-subtitle">
          No payroll periods exist yet.
        </p>
      ) : (
        <form method="GET" action={basePath} className="ov-filters" aria-label="Select site and period">
          <div className="ov-filter-field">
            <label htmlFor="site-report-filter-site">Site</label>
            <select id="site-report-filter-site" name="siteId" defaultValue={rawFilters.siteId ?? ''}>
              <option value="">Select a site…</option>
              {siteOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="site-report-filter-period">Payroll period</label>
            <select id="site-report-filter-period" name="periodId" defaultValue={rawFilters.periodId ?? ''}>
              <option value="">Select a period…</option>
              {periodOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="site-report-filter-pagesize">Per page</label>
            <select id="site-report-filter-pagesize" name="pageSize" defaultValue={rawFilters.pageSize ?? '20'}>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-actions">
            <button type="submit" className="exc-apply-button">
              Show report
            </button>
            <Link href={basePath} className="exc-reset-link">
              Reset
            </Link>
          </div>
        </form>
      )}

      <ReportBody role={role} basePath={basePath} rawFilters={rawFilters} outcome={outcome} />
    </div>
  );
}

function ReportTypeTabs({ role }: { role: 'admin' | 'foreman' }) {
  if (role === 'foreman') {
    return null; // FOREMAN has exactly one report type, zero admin URLs — no switcher to show.
  }
  return <AdminReportTabs active="site" />;
}

function ReportBody({ role, basePath, rawFilters, outcome }: { role: 'admin' | 'foreman'; basePath: string; rawFilters: RawSiteReportFilters; outcome: SiteReportOutcome }) {
  if (outcome.kind === 'prompt') {
    return (
      <p role="status" className="setup-subtitle">
        Choose a site and a payroll period above to see the report.
      </p>
    );
  }

  if (outcome.kind === 'invalid') {
    const messages = Object.entries(outcome.fieldErrors).map(([field, errors]) => `${field}: ${errors.join(', ')}`);
    return (
      <div className="login-error" role="alert">
        <p>Some filters are invalid:</p>
        <ul>
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (outcome.kind === 'site-not-found') {
    return (
      <p className="login-error" role="alert">
        {role === 'admin' ? 'No work site with this id.' : 'No site report available for this id.'}
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
  const baseQuery = { siteId: rawFilters.siteId, periodId: rawFilters.periodId, pageSize: rawFilters.pageSize };

  return (
    <div aria-live="polite">
      <h2>
        {report.site.name} <span className="setup-subtitle">({report.site.active ? 'Active' : 'Closed'})</span>
      </h2>
      <p className="setup-subtitle">
        Period {report.period.startDate} – {report.period.endDate} · {report.period.status}
      </p>
      <p className="ov-muted">As of {report.asOf}</p>

      <SummaryPanel summary={report.summary} />

      {report.items.length === 0 ? (
        report.totalItems === 0 ? (
          <p role="status">No workers in this site report for this period.</p>
        ) : (
          <div role="status">
            <p>This page has no workers ({report.totalItems} total, {report.totalPages} pages).</p>
            <Link href={`${basePath}${buildOverviewQueryString({ ...baseQuery, page: 1 })}`}>Back to page 1</Link>
          </div>
        )
      ) : (
        <ul className="ov-worker-list">
          {report.items.map((item) => (
            <WorkerCard key={item.employee.id} item={item} />
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} baseQuery={baseQuery} page={report.page} totalPages={report.totalPages} totalItems={report.totalItems} />
    </div>
  );
}

function SummaryPanel({ summary }: { summary: SiteTimeReport['summary'] }) {
  return (
    <section aria-labelledby="site-report-summary-heading">
      <h3 id="site-report-summary-heading">Summary</h3>
      <dl className="ov-worker-grid">
        <div>
          <dt>Workers</dt>
          <dd>{summary.workerCount}</dd>
        </div>
        <div>
          <dt>Without timesheet</dt>
          <dd>{summary.withoutTimesheetCount}</dd>
        </div>
        <div>
          <dt>Worked days</dt>
          <dd>{summary.workedDayCount}</dd>
        </div>
        <div>
          <dt>Gross</dt>
          <dd>{formatWorkedDuration(summary.grossMinutes)}</dd>
        </div>
        <div>
          <dt>Paid breaks</dt>
          <dd>{formatWorkedDuration(summary.paidBreakMinutes)}</dd>
        </div>
        <div>
          <dt>Unpaid breaks</dt>
          <dd>{formatWorkedDuration(summary.unpaidBreakMinutes)}</dd>
        </div>
        <div>
          <dt>Worked total</dt>
          <dd>{formatWorkedDuration(summary.workedMinutes)}</dd>
        </div>
        <div>
          <dt>Segments</dt>
          <dd>{summary.segmentCount}</dd>
        </div>
      </dl>
      <h4>Timesheet status counts</h4>
      <ul className="ov-state-badges">
        {(Object.entries(summary.timesheetStatusCounts) as [keyof SiteTimeReport['summary']['timesheetStatusCounts'], number][]).map(([status, count]) => (
          <li key={status} className="ov-badge ov-badge-neutral">
            {timesheetStatusLabel(status)}: {count}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkerCard({ item }: { item: SiteTimeReport['items'][number] }) {
  return (
    <li className="ov-worker-card">
      <div className="ov-worker-head">
        <h4 className="ov-worker-name">
          {item.employee.lastName} {item.employee.firstName} <span className="ov-muted">({item.employee.employeeNumber})</span>
        </h4>
        <div className="ov-state-badges">
          {item.assignmentInPeriod && <span className="ov-badge ov-badge-neutral">Assigned in period</span>}
          {item.participantExpected === false && <span className="ov-badge ov-badge-issue">Excluded participant</span>}
        </div>
      </div>

      {!item.timesheet ? (
        <p role="status" className="setup-subtitle">
          No timesheet for this worker in this period.
        </p>
      ) : (
        <p className="setup-subtitle">
          Timesheet status: <strong>{timesheetStatusLabel(item.timesheet.status)}</strong> · {dataSourceLabel(item.timesheet.dataSource, item.timesheet.versionNumber)}
          {submissionSourceLabel(item.timesheet.submissionSource) && ` · ${submissionSourceLabel(item.timesheet.submissionSource)}`}
        </p>
      )}

      {item.days.length === 0 ? (
        <p role="status">Zero hours at this site in this period.</p>
      ) : (
        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Gross</th>
                <th>Paid break</th>
                <th>Unpaid break</th>
                <th>Worked</th>
                <th>Segments</th>
              </tr>
            </thead>
            <tbody>
              {item.days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{formatWorkedDuration(d.grossMinutes)}</td>
                  <td>{formatWorkedDuration(d.paidBreakMinutes)}</td>
                  <td>{formatWorkedDuration(d.unpaidBreakMinutes)}</td>
                  <td>{formatWorkedDuration(d.workedMinutes)}</td>
                  <td>{d.segmentCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total ({item.total.workedDayCount} day{item.total.workedDayCount === 1 ? '' : 's'})</th>
                <th>{formatWorkedDuration(item.total.grossMinutes)}</th>
                <th>{formatWorkedDuration(item.total.paidBreakMinutes)}</th>
                <th>{formatWorkedDuration(item.total.unpaidBreakMinutes)}</th>
                <th>{formatWorkedDuration(item.total.workedMinutes)}</th>
                <th>{item.total.segmentCount}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </li>
  );
}

function Pagination({
  basePath,
  baseQuery,
  page,
  totalPages,
  totalItems
}: {
  basePath: string;
  baseQuery: Record<string, string | number | null | undefined>;
  page: number;
  totalPages: number;
  totalItems: number;
}) {
  if (totalItems === 0) {
    return null;
  }
  const pageHref = (p: number) => `${basePath}${buildOverviewQueryString({ ...baseQuery, page: p })}`;
  return (
    <nav className="exc-pagination" aria-label="Pagination">
      {page > 1 ? <Link href={pageHref(page - 1)}>Previous</Link> : <span className="exc-pagination-disabled">Previous</span>}
      <span>
        {totalItems} worker{totalItems === 1 ? '' : 's'} · page {page} of {totalPages}
      </span>
      {page < totalPages ? <Link href={pageHref(page + 1)}>Next</Link> : <span className="exc-pagination-disabled">Next</span>}
    </nav>
  );
}
