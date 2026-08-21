import Link from 'next/link';
import type { OverviewResult, OverviewSummary, OverviewWorkerItem, OverviewConflicts, OperationalState } from '@/lib/attendance-overview';
import { OPERATIONAL_STATE_VALUES } from '@/lib/attendance-overview';
import type { PeriodOption, SiteOption } from '@/lib/attendance-overview-lookups';
import {
  operationalStateLabel,
  operationalStateBadgeClass,
  finalApprovalBlockedReasonLabel,
  submissionSourceLabel,
  correctionStatusLabel,
  formatSignedMinutes,
  formatMinutes,
  buildOverviewQueryString
} from '@/lib/attendance-overview-ui';
import { exceptionTypeLabel, channelLabel, timesheetStatusLabel, formatDateTime } from '@/lib/attendance-exceptions-ui';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { LiveShiftDuration, LiveWorkedToday, OverviewAutoRefresh } from '@/components/overview/OverviewLiveStatus';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.9A" + PROJECT_ROADMAP.md T7A.9 —
// T7A.9B. Pure presentation: given an already-fetched OverviewResult (or a validation/not-found
// outcome) and already-resolved filter options, render the page. All scope/aggregation/diff logic
// stays exclusively in lib/attendance-overview.ts — this component never queries the database.
// Shared verbatim by /admin and /foreman, which differ only in role/basePath/links/conflicts.

export interface OverviewRawQuery {
  q: string | null;
  periodId: string | null;
  siteId: string | null;
  state: string | null;
  /** Admin-only — carried forward as a hidden field, never a user-typed input (task §6). */
  employeeId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type OverviewOutcome =
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  | { kind: 'period-not-found' }
  | { kind: 'ok'; result: OverviewResult };

interface Props {
  role: 'admin' | 'foreman';
  basePath: string;
  rawQuery: OverviewRawQuery;
  outcome: OverviewOutcome;
  periodOptions: PeriodOption[];
  siteOptions: SiteOption[];
  /** Foreman-only legacy fields (task §11 — pre-existing pendingCount/exceptionCount + review-queue
   * links, unchanged in meaning, kept alongside the new scoped summary/items/filters). */
  legacy?: { pendingCount: number; exceptionCount: number };
}

export function OverviewView({ role, basePath, rawQuery, outcome, periodOptions, siteOptions, legacy }: Props) {
  const isAdmin = role === 'admin';

  return (
    <div className="setup-card worker-card ov-card">
      <h1>{isAdmin ? 'Today' : 'Overview'}</h1>

      {legacy && <ForemanLegacySection legacy={legacy} />}

      {outcome.kind === 'invalid' && (
        <p className="login-error" role="alert">
          These filters aren&apos;t valid: {Object.entries(outcome.fieldErrors).map(([field, msgs]) => `${field} ${msgs.join(', ')}`).join('; ')}
        </p>
      )}

      {outcome.kind === 'period-not-found' && (
        <p className="login-error" role="alert">
          That payroll period could not be found. <Link href={basePath}>Clear the period filter</Link>.
        </p>
      )}

      {outcome.kind === 'ok' && (
        <OverviewBody role={role} basePath={basePath} rawQuery={rawQuery} result={outcome.result} periodOptions={periodOptions} siteOptions={siteOptions} />
      )}
    </div>
  );
}

function ForemanLegacySection({ legacy }: { legacy: { pendingCount: number; exceptionCount: number } }) {
  return (
    <div className="ov-legacy">
      {legacy.pendingCount === 0 ? (
        <p className="wk-empty">Nothing waiting for review on your sites.</p>
      ) : (
        <>
          <p className="setup-subtitle">
            {legacy.pendingCount} pending{legacy.exceptionCount > 0 ? `, ${legacy.exceptionCount} with an exception` : ''}
          </p>
          <Link href="/foreman/review" className="wk-action-button">
            Go to review queue
          </Link>
        </>
      )}
      <p className="ov-legacy-note">
        The review queue above is <em>TimesheetReviewScope</em> — a plan-vs-actual flag on submitted timesheets. The scoped worker list and clock-event
        exceptions below are a separate signal (<em>AttendanceException</em> — GPS/geofence/switch-site/overlap anomalies from Check In/Out itself).
      </p>
      <Link href="/foreman/attendance/exceptions" className="wk-action-button">
        Go to attendance exceptions
      </Link>
      <Link href="/foreman/reports/sites" className="wk-action-button">
        Site reports
      </Link>
    </div>
  );
}

function currentFilterBase(rawQuery: OverviewRawQuery) {
  return { q: rawQuery.q, periodId: rawQuery.periodId, siteId: rawQuery.siteId, employeeId: rawQuery.employeeId, pageSize: rawQuery.pageSize };
}

function OverviewBody({
  role,
  basePath,
  rawQuery,
  result,
  periodOptions,
  siteOptions
}: {
  role: 'admin' | 'foreman';
  basePath: string;
  rawQuery: OverviewRawQuery;
  result: OverviewResult;
  periodOptions: PeriodOption[];
  siteOptions: SiteOption[];
}) {
  const isAdmin = role === 'admin';

  if (isAdmin) {
    return <AdminTodayBody basePath={basePath} rawQuery={rawQuery} result={result} periodOptions={periodOptions} siteOptions={siteOptions} />;
  }

  return (
    <>
      <OverviewAutoRefresh />
      <PeriodBanner basePath={basePath} isAdmin={isAdmin} period={result.period} asOf={result.asOf} />

      <FilterForm basePath={basePath} rawQuery={rawQuery} periodOptions={periodOptions} siteOptions={siteOptions} />

      <SummaryCards basePath={basePath} rawQuery={rawQuery} summary={result.summary} />

      {isAdmin && result.conflicts && <ConflictsSection conflicts={result.conflicts} />}

      <WorkerList role={role} items={result.items} totalWorkers={result.summary.totalWorkers} asOf={result.asOf} />

      <Pagination basePath={basePath} rawQuery={rawQuery} page={result.page} totalPages={result.totalPages} totalItems={result.totalItems} />
    </>
  );
}

function AdminTodayBody({
  basePath,
  rawQuery,
  result,
  periodOptions,
  siteOptions
}: {
  basePath: string;
  rawQuery: OverviewRawQuery;
  result: OverviewResult;
  periodOptions: PeriodOption[];
  siteOptions: SiteOption[];
}) {
  const todayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(result.asOf));
  return (
    <>
      <OverviewAutoRefresh />
      <div className="owner-today-head">
        <div>
          <p className="owner-today-date">{todayLabel}</p>
          <p className="ov-asof">Updated {formatHelsinkiDateTime(result.asOf)} · refreshes every 30 minutes · <Link href={basePath}>Refresh now</Link></p>
        </div>
        {result.period ? <span className="ov-badge ov-badge-neutral">{result.period.multipleCurrentCycles ? 'Multiple submission cycles' : `${result.period.startDate} – ${result.period.endDate}`}</span> : <span className="ov-badge ov-badge-issue">No current period</span>}
      </div>

      <OwnerSearchForm basePath={basePath} rawQuery={rawQuery} periodOptions={periodOptions} siteOptions={siteOptions} />
      <OwnerQuickSummary summary={result.summary} />
      <OwnerWorkerList items={result.items} totalItems={result.totalItems} asOf={result.asOf} />
      <Pagination basePath={basePath} rawQuery={rawQuery} page={result.page} totalPages={result.totalPages} totalItems={result.totalItems} />

      <details className="owner-secondary-panel">
        <summary>Timesheets and approval details</summary>
        <SummaryCards basePath={basePath} rawQuery={rawQuery} summary={result.summary} />
      </details>
      {result.conflicts ? (
        <details className="owner-secondary-panel" open={result.conflicts.totalOpenOrRecent > 0}>
          <summary>Technical conflicts {result.conflicts.totalOpenOrRecent > 0 ? `(${result.conflicts.totalOpenOrRecent})` : ''}</summary>
          <ConflictsSection conflicts={result.conflicts} />
        </details>
      ) : null}
    </>
  );
}

function OwnerSearchForm({ basePath, rawQuery, periodOptions, siteOptions }: { basePath: string; rawQuery: OverviewRawQuery; periodOptions: PeriodOption[]; siteOptions: SiteOption[] }) {
  return (
    <form method="GET" action={basePath} className="owner-search" aria-label="Search today's workers">
      <div className="owner-search-primary">
        <div className="ov-filter-field owner-search-query">
          <label htmlFor="owner-search-q">Worker or site</label>
          <input id="owner-search-q" name="q" type="search" maxLength={100} defaultValue={rawQuery.q ?? ''} placeholder="Name, employee number, site or work area" />
        </div>
        <div className="ov-filter-field">
          <label htmlFor="owner-search-site">Site</label>
          <select id="owner-search-site" name="siteId" defaultValue={rawQuery.siteId ?? ''}>
            <option value="">All sites</option>
            {siteOptions.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </div>
        <button type="submit" className="exc-apply-button">Search</button>
        <Link href={basePath} className="exc-reset-link">Reset</Link>
      </div>
      <details className="owner-more-filters">
        <summary>More filters</summary>
        <div className="owner-more-filter-grid">
          <div className="ov-filter-field">
            <label htmlFor="owner-filter-period">Period</label>
            <select id="owner-filter-period" name="periodId" defaultValue={rawQuery.periodId ?? ''}>
              <option value="">Current cycles</option>
              {periodOptions.map((period) => <option key={period.id} value={period.id}>{period.label}</option>)}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="owner-filter-state">Status or issue</label>
            <select id="owner-filter-state" name="state" defaultValue={rawQuery.state ?? ''}>
              <option value="">All</option>
              {OPERATIONAL_STATE_VALUES.map((state) => <option key={state} value={state}>{operationalStateLabel(state)}</option>)}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="owner-filter-pagesize">Workers per page</label>
            <select id="owner-filter-pagesize" name="pageSize" defaultValue={rawQuery.pageSize ?? '20'}>
              {[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
        </div>
      </details>
    </form>
  );
}

function OwnerQuickSummary({ summary }: { summary: OverviewSummary }) {
  const items = [
    { label: 'Active workers', value: summary.totalWorkers, className: 'owner-stat-neutral' },
    { label: 'Working now', value: summary.workingNow, className: 'owner-stat-working' },
    { label: 'Finished today', value: summary.finishedToday, className: 'owner-stat-finished' },
    { label: 'Not started', value: summary.notStartedToday, className: 'owner-stat-neutral' },
    { label: 'Need attention', value: summary.needsAttention, className: summary.needsAttention > 0 ? 'owner-stat-attention' : 'owner-stat-neutral' }
  ];
  return <ul className="owner-quick-stats" aria-label="Today's worker summary">{items.map((item) => <li key={item.label} className={item.className}><strong>{item.value}</strong><span>{item.label}</span></li>)}</ul>;
}

function formatTodayTime(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function OwnerWorkerList({ items, totalItems, asOf }: { items: OverviewWorkerItem[]; totalItems: number; asOf: string }) {
  if (totalItems === 0) return <p className="wk-empty" role="status">No workers match this search.</p>;
  return (
    <section className="owner-workers" aria-labelledby="owner-workers-title">
      <div className="owner-workers-heading"><h2 id="owner-workers-title">Workers today</h2><span>{totalItems}</span></div>
      <div className="owner-worker-columns" aria-hidden="true"><span>Worker</span><span>Status</span><span>Site</span><span>Check In</span><span>Check Out</span><span>Today</span><span>Issues</span><span /></div>
      <ul className="owner-worker-list">
        {items.map((item) => <OwnerWorkerRow key={item.employee.id} item={item} asOf={asOf} />)}
      </ul>
    </section>
  );
}

function OwnerWorkerRow({ item, asOf }: { item: OverviewWorkerItem; asOf: string }) {
  const assignment = item.openShift
    ? { site: item.openShift.site, workArea: item.openShift.workArea }
    : item.currentAssignments.find((current) => current.isPrimary) ?? item.currentAssignments[0] ?? (item.latestFinishedShiftToday ? { site: item.latestFinishedShiftToday.site, workArea: null } : null);
  const startedAt = item.openShift?.openedAt ?? item.latestFinishedShiftToday?.recordedStartAt ?? null;
  const endedAt = item.openShift ? null : item.latestFinishedShiftToday?.recordedEndAt ?? null;
  const statusLabel = item.todayStatus === 'WORKING' ? 'Working now' : item.todayStatus === 'FINISHED' ? 'Finished' : 'Not started';
  const statusClass = item.todayStatus === 'WORKING' ? 'owner-status-working' : item.todayStatus === 'FINISHED' ? 'owner-status-finished' : 'owner-status-not-started';
  const issueLabel = item.openExceptionCount > 0 ? `${item.openExceptionCount} issue${item.openExceptionCount === 1 ? '' : 's'}` : item.needsAttention ? 'Review needed' : 'No issues';
  return (
    <li>
      <Link href={`/admin/workers/${item.employee.id}`} className="owner-worker-row" aria-label={`Open ${item.employee.name}`}>
        <span className="owner-worker-identity"><strong>{item.employee.name}</strong><small>#{item.employee.employeeNumber}</small></span>
        <span><span className={`owner-status ${statusClass}`}>{statusLabel}</span>{item.timesheet ? <small>{timesheetStatusLabel(item.timesheet.status)}</small> : null}</span>
        <span className="owner-worker-site"><strong>{assignment?.site.name ?? 'No site assigned'}</strong>{assignment?.workArea ? <small>{assignment.workArea.name}</small> : null}</span>
        <span data-label="Check In">{formatTodayTime(startedAt)}</span>
        <span data-label="Check Out">{formatTodayTime(endedAt)}</span>
        <span data-label="Today"><LiveWorkedToday initialMinutes={item.todayWorkedMinutes} initialAsOf={asOf} running={item.todayStatus === 'WORKING'} /></span>
        <span data-label="Issues" className={item.needsAttention ? 'owner-issue' : 'owner-no-issue'}>{issueLabel}</span>
        <span className="owner-worker-open">View →</span>
      </Link>
    </li>
  );
}

function PeriodBanner({ basePath, isAdmin, period, asOf }: { basePath: string; isAdmin: boolean; period: OverviewResult['period']; asOf: string }) {
  const refreshHref = `${basePath}`;
  return (
    <div className="ov-period-banner">
      {period ? (
        <p className="ov-period-line">
          {period.multipleCurrentCycles ? (
            <>Current submission cycles: <strong>weekly and two-week groups</strong></>
          ) : (
            <>Period: <strong>{period.startDate} – {period.endDate}</strong> · {period.status}</>
          )}
          {isAdmin && !period.multipleCurrentCycles && (
            <>
              {' · '}
              <Link href={`/admin/periods/${period.id}`}>View period</Link>
            </>
          )}
        </p>
      ) : (
        <div className="ov-warning" role="status">
          <p>No open payroll period covers today. Clock-in/out data below is still live; timesheet/review figures are zero without a period.</p>
          {isAdmin && (
            <p className="ov-period-links">
              <Link href="/admin/periods">Go to periods</Link> · <Link href="/admin/setup">Go to setup</Link>
            </p>
          )}
        </div>
      )}
      <p className="ov-asof">
        As of {formatHelsinkiDateTime(asOf)} (Europe/Helsinki) · <Link href={refreshHref}>Refresh</Link>
      </p>
    </div>
  );
}

function FilterForm({
  basePath,
  rawQuery,
  periodOptions,
  siteOptions
}: {
  basePath: string;
  rawQuery: OverviewRawQuery;
  periodOptions: PeriodOption[];
  siteOptions: SiteOption[];
}) {
  return (
    <form method="GET" action={basePath} className="ov-filters" aria-label="Filter overview">
      {rawQuery.employeeId && <input type="hidden" name="employeeId" value={rawQuery.employeeId} />}
      <div className="ov-filter-field">
        <label htmlFor="ov-filter-q">Worker or site</label>
        <input id="ov-filter-q" name="q" type="search" maxLength={100} defaultValue={rawQuery.q ?? ''} placeholder="Name, number, site or work area" />
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ov-filter-period">Period</label>
        <select id="ov-filter-period" name="periodId" defaultValue={rawQuery.periodId ?? ''}>
          <option value="">Current open period</option>
          {periodOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ov-filter-site">Site</label>
        <select id="ov-filter-site" name="siteId" defaultValue={rawQuery.siteId ?? ''}>
          <option value="">All sites</option>
          {siteOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ov-filter-state">Operational state</label>
        <select id="ov-filter-state" name="state" defaultValue={rawQuery.state ?? ''}>
          <option value="">All</option>
          {OPERATIONAL_STATE_VALUES.map((s) => (
            <option key={s} value={s}>
              {operationalStateLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ov-filter-pagesize">Per page</label>
        <select id="ov-filter-pagesize" name="pageSize" defaultValue={rawQuery.pageSize ?? '20'}>
          {[10, 20, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="ov-filter-actions">
        <button type="submit" className="exc-apply-button">
          Apply filters
        </button>
        <Link href={basePath} className="exc-reset-link">
          Reset
        </Link>
      </div>
    </form>
  );
}

const SUMMARY_CARDS: { key: keyof OverviewSummary; label: string; state: OperationalState | null; clickable: boolean }[] = [
  { key: 'totalWorkers', label: 'Total workers', state: null, clickable: true },
  { key: 'workingNow', label: 'Working now', state: 'WORKING_NOW', clickable: true },
  { key: 'finishedToday', label: 'Finished today', state: 'FINISHED_TODAY', clickable: true },
  { key: 'missingCheckout', label: 'Missing checkout', state: 'MISSING_CHECKOUT', clickable: true },
  { key: 'gpsIssue', label: 'GPS issues', state: 'GPS_ISSUE', clickable: true },
  { key: 'syncIssue', label: 'Sync issues', state: 'SYNC_ISSUE', clickable: true },
  { key: 'draft', label: 'Draft', state: 'DRAFT', clickable: true },
  { key: 'submittedManual', label: 'Submitted manually', state: 'SUBMITTED_MANUAL', clickable: true },
  { key: 'submittedAuto', label: 'Submitted automatically', state: 'SUBMITTED_AUTO', clickable: true },
  { key: 'awaitingForeman', label: 'Awaiting foreman', state: 'AWAITING_FOREMAN', clickable: true },
  { key: 'returned', label: 'Returned', state: 'RETURNED', clickable: true },
  { key: 'readyForFinalApproval', label: 'Ready for final approval', state: 'READY_FOR_FINAL_APPROVAL', clickable: true },
  { key: 'finalApproved', label: 'Final approved', state: 'FINAL_APPROVED', clickable: true },
  { key: 'correctionOpen', label: 'Open corrections', state: 'CORRECTION_OPEN', clickable: true },
  // Not a per-item boolean state (a worker can carry more than one open exception) — informational
  // count only, never a `state=` filter target.
  { key: 'openAttendanceExceptions', label: 'Open attendance exceptions', state: null, clickable: false }
];

function SummaryCards({ basePath, rawQuery, summary }: { basePath: string; rawQuery: OverviewRawQuery; summary: OverviewSummary }) {
  const base = currentFilterBase(rawQuery);
  return (
    <ul className="ov-summary-grid" aria-label="Operational state filters">
      {SUMMARY_CARDS.map((card) => {
        const value = summary[card.key];
        if (!card.clickable) {
          return (
            <li key={card.key} className="ov-summary-card ov-summary-card-static">
              <span className="ov-summary-value">{value}</span>
              <span className="ov-summary-label">{card.label}</span>
            </li>
          );
        }
        const active = card.state === null ? rawQuery.state === null : rawQuery.state === card.state;
        const href = `${basePath}${buildOverviewQueryString({ ...base, state: card.state, page: 1 })}`;
        return (
          <li key={card.key}>
            <Link href={href} className={active ? 'ov-summary-card ov-summary-card-active' : 'ov-summary-card'} aria-current={active ? 'true' : undefined}>
              <span className="ov-summary-value">{value}</span>
              <span className="ov-summary-label">{card.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ConflictsSection({ conflicts }: { conflicts: OverviewConflicts }) {
  const empty = conflicts.clockEventIdConflicts.length === 0 && conflicts.rejectedTerminalReceipts.length === 0 && conflicts.fifoLedgerInconsistencies.length === 0;
  return (
    <section className="ov-conflicts">
      <h2 className="wk-section-title">Conflicts &amp; anomalies</h2>
      <p className="ov-muted">{conflicts.totalOpenOrRecent} total (most recent 20 per category shown)</p>
      {empty ? (
        <p className="wk-empty">No recent conflicts.</p>
      ) : (
        <>
          <ConflictList title="Clock event ID conflicts" items={conflicts.clockEventIdConflicts.map((c) => ({ id: c.id, tag: c.conflictType ?? '—', employeeName: c.employee?.name ?? '—', createdAt: c.createdAt }))} />
          <ConflictList title="Rejected terminal offline events" items={conflicts.rejectedTerminalReceipts.map((c) => ({ id: c.id, tag: c.rejectionCode ?? '—', employeeName: c.employee?.name ?? '—', createdAt: c.createdAt }))} />
          <ConflictList title="FIFO ledger inconsistencies" items={conflicts.fifoLedgerInconsistencies.map((c) => ({ id: c.id, tag: c.eventType ?? '—', employeeName: c.employee?.name ?? '—', createdAt: c.createdAt }))} />
        </>
      )}
    </section>
  );
}

function ConflictList({ title, items }: { title: string; items: { id: string; tag: string; employeeName: string; createdAt: string }[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="ov-conflict-group">
      <h3 className="ov-subsection-title">{title}</h3>
      <ul className="ov-conflict-list">
        {items.map((item) => (
          <li key={item.id}>
            <span className="ov-badge ov-badge-neutral">{item.tag}</span> {item.employeeName} — {formatDateTime(item.createdAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkerList({ role, items, totalWorkers, asOf }: { role: 'admin' | 'foreman'; items: OverviewWorkerItem[]; totalWorkers: number; asOf: string }) {
  if (totalWorkers === 0) {
    return (
      <p className="wk-empty" role="status" aria-live="polite">
        No workers in scope for this period/site.
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="wk-empty" role="status" aria-live="polite">
        No workers match this operational state filter.
      </p>
    );
  }

  return (
    <ul className="ov-worker-list">
      {items.map((item) => (
        <WorkerCard key={item.employee.id} role={role} item={item} asOf={asOf} />
      ))}
    </ul>
  );
}

function WorkerCard({ role, item, asOf }: { role: 'admin' | 'foreman'; item: OverviewWorkerItem; asOf: string }) {
  const isAdmin = role === 'admin';

  return (
    <li className="ov-worker-card">
      <header className="ov-worker-head">
        <div>
          <h3 className="ov-worker-name">
            {isAdmin ? <Link href={`/admin/workers/${item.employee.id}`}>{item.employee.name}</Link> : item.employee.name}
          </h3>
          <p className="ov-muted">{item.employee.employeeNumber}</p>
        </div>
        <div className="ov-state-badges">
          {item.states.length === 0 ? (
            <span className="ov-badge ov-badge-neutral">No active state</span>
          ) : (
            item.states.map((s) => (
              <span key={s} className={operationalStateBadgeClass(s)}>
                {operationalStateLabel(s)}
              </span>
            ))
          )}
        </div>
      </header>

      <dl className="ov-worker-grid">
        <div>
          <dt>Working now</dt>
          <dd>
            {item.openShift ? (
              <>
                {item.openShift.site.name}
                {item.openShift.workArea ? ` · ${item.openShift.workArea.name}` : ''} — since {formatDateTime(item.openShift.openedAt)} ({channelLabel(item.openShift.channel)})
                {' · '}
                <LiveShiftDuration openedAt={item.openShift.openedAt} initialAsOf={asOf} />
              </>
            ) : (
              'Not currently clocked in'
            )}
          </dd>
        </div>

        <div>
          <dt>Latest finished shift today</dt>
          <dd>
            {item.latestFinishedShiftToday ? (
              <>
                {item.latestFinishedShiftToday.site.name} — {formatDateTime(item.latestFinishedShiftToday.recordedStartAt)} – {formatDateTime(item.latestFinishedShiftToday.recordedEndAt)}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>

        <div>
          <dt>Timesheet</dt>
          <dd>
            {item.timesheet ? (
              isAdmin ? (
                <Link href={`/admin/timesheets/${item.timesheet.id}`}>{timesheetStatusLabel(item.timesheet.status)}</Link>
              ) : (
                <Link href={`/foreman/review/${item.timesheet.id}`}>{timesheetStatusLabel(item.timesheet.status)}</Link>
              )
            ) : (
              'No timesheet this period'
            )}
          </dd>
        </div>

        <div>
          <dt>Version</dt>
          <dd>
            {item.currentVersion ? (
              <>
                #{item.currentVersion.versionNumber} · {submissionSourceLabel(item.currentVersion.submissionSource)} · {formatDateTime(item.currentVersion.submittedAt)}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>

        <div>
          <dt>Open exceptions</dt>
          <dd>
            {item.openExceptionCount === 0 ? (
              'None'
            ) : (
              <>
                {item.openExceptionCount} ({item.openExceptionTypes.map(exceptionTypeLabel).join(', ')}){' '}
                {isAdmin ? <Link href={`/admin/attendance/exceptions?status=OPEN&employeeId=${item.employee.id}`}>View</Link> : <Link href="/foreman/attendance/exceptions">View</Link>}
              </>
            )}
          </dd>
        </div>

        <div>
          <dt>Review route</dt>
          <dd>
            {item.reviewRoute ? (
              <>
                {item.reviewRoute.pending} pending / {item.reviewRoute.approved} approved / {item.reviewRoute.returned} returned of {item.reviewRoute.total}
                {item.reviewRoute.scopes.length > 0 && (
                  <span className="ov-muted"> — {item.reviewRoute.scopes.map((s) => `${s.siteName ?? 'Non-site'}: ${s.status}`).join(', ')}</span>
                )}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>

        <div>
          <dt>Final approval blockers</dt>
          <dd>
            {item.finalApprovalBlockedReasons.length === 0 ? (
              'None'
            ) : (
              <ul className="ov-blocker-list">
                {item.finalApprovalBlockedReasons.map((r) => (
                  <li key={r}>{finalApprovalBlockedReasonLabel(r)}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>

        <div>
          <dt>Correction</dt>
          <dd>
            {item.correction ? (
              isAdmin ? (
                <Link href="/admin/corrections">{correctionStatusLabel(item.correction.status)}</Link>
              ) : (
                correctionStatusLabel(item.correction.status)
              )
            ) : (
              'None'
            )}
          </dd>
        </div>

        <div>
          <dt>Recorded vs reported</dt>
          <dd>
            {item.diff ? (
              <>
                Recorded {formatMinutes(item.diff.recordedMinutes)} · Reported {formatMinutes(item.diff.reportedMinutes)} ·{' '}
                <span className={deltaClass(item.diff.deltaMinutes)}>Delta {formatSignedMinutes(item.diff.deltaMinutes)}</span> · {item.diff.adjustmentCount} adjustment
                {item.diff.adjustmentCount === 1 ? '' : 's'}
              </>
            ) : (
              'Not available'
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}

function deltaClass(deltaMinutes: number): string {
  if (deltaMinutes > 0) return 'ov-delta ov-delta-positive';
  if (deltaMinutes < 0) return 'ov-delta ov-delta-negative';
  return 'ov-delta ov-delta-zero';
}

function Pagination({
  basePath,
  rawQuery,
  page,
  totalPages,
  totalItems
}: {
  basePath: string;
  rawQuery: OverviewRawQuery;
  page: number;
  totalPages: number;
  totalItems: number;
}) {
  if (totalItems === 0) {
    return null;
  }
  const base = { ...currentFilterBase(rawQuery), state: rawQuery.state };
  const pageHref = (p: number) => `${basePath}${buildOverviewQueryString({ ...base, page: p })}`;

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
