import Link from 'next/link';
import type { PeriodTimeReport, PeriodTimeReportSite, TimesheetStatusCounts } from '@/lib/period-time-report';
import { formatWorkedDuration, timesheetStatusLabel } from '@/lib/reporting/report-format';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3B" §AD — the ONLY place the payroll period
// report is rendered. app/admin/reports/periods/page.tsx is a thin Server Component wrapper that
// resolves session/permissions, parses searchParams, calls getPeriodTimeReport() directly (no
// HTTP self-fetch), gets the period lookup list, and passes everything here as props. This
// component makes zero database/API calls of its own and never recomputes/re-sums a single
// minute or status count — it only formats numbers the backend already produced.

export interface PeriodOption {
  id: string;
  label: string;
  status: string;
}

export interface RawPeriodReportFilters {
  periodId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type PeriodReportOutcome =
  | { kind: 'prompt' }
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  | { kind: 'period-not-found' }
  | { kind: 'ok'; report: PeriodTimeReport };

export interface PeriodTimeReportViewProps {
  basePath: string;
  rawFilters: RawPeriodReportFilters;
  periodOptions: PeriodOption[];
  outcome: PeriodReportOutcome;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const STATUS_ORDER: (keyof TimesheetStatusCounts)[] = ['DRAFT', 'SUBMITTED', 'RETURNED', 'FOREMAN_APPROVED', 'FINAL_APPROVED'];

export function PeriodTimeReportView({ basePath, rawFilters, periodOptions, outcome }: PeriodTimeReportViewProps) {
  return (
    <div>
      <h1>Payroll period report</h1>
      <AdminReportTabs active="period" />
      <p className="setup-subtitle">Hours only — no salary or payroll calculation.</p>

      {periodOptions.length === 0 ? (
        <p role="status" className="setup-subtitle">
          No payroll periods exist yet.
        </p>
      ) : (
        <form method="GET" action={basePath} className="ov-filters" aria-label="Select payroll period">
          <div className="ov-filter-field">
            <label htmlFor="period-report-filter-period">Payroll period</label>
            <select id="period-report-filter-period" name="periodId" defaultValue={rawFilters.periodId ?? ''}>
              <option value="">Select a period…</option>
              {periodOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="period-report-filter-pagesize">Per page</label>
            <select id="period-report-filter-pagesize" name="pageSize" defaultValue={rawFilters.pageSize ?? '20'}>
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

      <ReportBody basePath={basePath} rawFilters={rawFilters} outcome={outcome} />
    </div>
  );
}

function ReportBody({ basePath, rawFilters, outcome }: { basePath: string; rawFilters: RawPeriodReportFilters; outcome: PeriodReportOutcome }) {
  if (outcome.kind === 'prompt') {
    return (
      <p role="status" className="setup-subtitle">
        Choose a payroll period above to see the company report.
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

  if (outcome.kind === 'period-not-found') {
    return (
      <p className="login-error" role="alert">
        No payroll period with this id.
      </p>
    );
  }

  const { report } = outcome;
  const baseQuery = { periodId: rawFilters.periodId, pageSize: rawFilters.pageSize };

  return (
    <div aria-live="polite">
      <h2>
        {report.period.startDate} – {report.period.endDate} <span className="setup-subtitle">({report.period.status})</span>
      </h2>
      <p className="ov-muted">As of {report.asOf}</p>

      <SummaryPanel summary={report.summary} />

      {report.sites.length === 0 ? (
        report.totalItems === 0 ? (
          <p role="status">
            {report.summary.workerCount === 0 ? 'No workers in this payroll period.' : 'This period has workers, but none are connected to a work site yet.'}
          </p>
        ) : (
          <div role="status">
            <p>
              This page has no sites ({report.totalItems} total, {report.totalPages} pages).
            </p>
            <Link href={`${basePath}${buildOverviewQueryString({ ...baseQuery, page: 1 })}`}>Back to page 1</Link>
          </div>
        )
      ) : (
        <ul className="ov-worker-list">
          {report.sites.map((site) => (
            <SiteRow key={site.site.id} site={site} periodId={report.period.id} />
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} baseQuery={baseQuery} page={report.page} totalPages={report.totalPages} totalItems={report.totalItems} />
    </div>
  );
}

function SummaryPanel({ summary }: { summary: PeriodTimeReport['summary'] }) {
  return (
    <section aria-labelledby="period-report-summary-heading">
      <h3 id="period-report-summary-heading">Company summary</h3>
      <dl className="ov-worker-grid">
        <div>
          <dt>Workers</dt>
          <dd>{summary.workerCount}</dd>
        </div>
        <div>
          <dt>Participants</dt>
          <dd>{summary.participantCount}</dd>
        </div>
        <div>
          <dt>Expected</dt>
          <dd>{summary.expectedParticipantCount}</dd>
        </div>
        <div>
          <dt>Excluded</dt>
          <dd>{summary.excludedParticipantCount}</dd>
        </div>
        <div>
          <dt>Assigned workers</dt>
          <dd>{summary.assignedWorkerCount}</dd>
        </div>
        <div>
          <dt>Worked workers</dt>
          <dd>{summary.workedWorkerCount}</dd>
        </div>
        <div>
          <dt>Without timesheet</dt>
          <dd>{summary.withoutTimesheetCount}</dd>
        </div>
        <div>
          <dt>Without site</dt>
          <dd>{summary.withoutSiteCount}</dd>
        </div>
        <div>
          <dt>Sites</dt>
          <dd>{summary.siteCount}</dd>
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
      <StatusCountsList counts={summary.timesheetStatusCounts} headingId="period-report-status-heading" heading="Timesheet status counts" />
    </section>
  );
}

function StatusCountsList({ counts, headingId, heading }: { counts: TimesheetStatusCounts; headingId: string; heading: string }) {
  return (
    <>
      <h4 id={headingId}>{heading}</h4>
      <ul className="ov-state-badges" aria-labelledby={headingId}>
        {STATUS_ORDER.map((status) => (
          <li key={status} className="ov-badge ov-badge-neutral">
            {timesheetStatusLabel(status)}: {counts[status]}
          </li>
        ))}
      </ul>
    </>
  );
}

function SiteRow({ site, periodId }: { site: PeriodTimeReportSite; periodId: string }) {
  const drillDownHref = `/admin/reports/sites${buildOverviewQueryString({ siteId: site.site.id, periodId })}`;
  return (
    <li className="ov-worker-card">
      <div className="ov-worker-head">
        <h4 className="ov-worker-name">
          <Link href={drillDownHref}>{site.site.name}</Link> <span className="ov-muted">({site.site.active ? 'Active' : 'Closed'})</span>
        </h4>
      </div>

      <dl className="ov-worker-grid">
        <div>
          <dt>Assigned workers</dt>
          <dd>{site.assignedWorkerCount}</dd>
        </div>
        <div>
          <dt>Worked workers</dt>
          <dd>{site.workedWorkerCount}</dd>
        </div>
        <div>
          <dt>Without timesheet</dt>
          <dd>{site.withoutTimesheetCount}</dd>
        </div>
        <div>
          <dt>Worked days</dt>
          <dd>{site.workedDayCount}</dd>
        </div>
        <div>
          <dt>Gross</dt>
          <dd>{formatWorkedDuration(site.grossMinutes)}</dd>
        </div>
        <div>
          <dt>Paid breaks</dt>
          <dd>{formatWorkedDuration(site.paidBreakMinutes)}</dd>
        </div>
        <div>
          <dt>Unpaid breaks</dt>
          <dd>{formatWorkedDuration(site.unpaidBreakMinutes)}</dd>
        </div>
        <div>
          <dt>Worked</dt>
          <dd>{formatWorkedDuration(site.workedMinutes)}</dd>
        </div>
        <div>
          <dt>Segments</dt>
          <dd>{site.segmentCount}</dd>
        </div>
      </dl>
      <StatusCountsList counts={site.timesheetStatusCounts} headingId={`period-report-site-status-${site.site.id}`} heading="Status counts" />
      <p>
        <Link href={drillDownHref}>View this site&apos;s report</Link>
      </p>
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
        {totalItems} site{totalItems === 1 ? '' : 's'} · page {page} of {totalPages}
      </span>
      {page < totalPages ? <Link href={pageHref(page + 1)}>Next</Link> : <span className="exc-pagination-disabled">Next</span>}
    </nav>
  );
}
