// Read-only report week detail — pure grouping/filtering/sorting coverage. The source rows use the
// exact TimeLedgerResult DTO; no database and no duplicated hours calculation are involved here.

import { buildReportWeekDetail, parseReportWeekQuery } from '../lib/reporting/report-week-detail';
import type { CustomerGroup, TimeLedgerResult, WeeklyCustomerSliceRow } from '../lib/reporting/time-ledger';
import { ReportWeekDetailView } from '../components/reports/ReportWeekDetailView';
import { renderToStaticMarkup } from 'react-dom/server';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 700));
  }
}

function row(overrides: Partial<WeeklyCustomerSliceRow> & { employeeId: string; employeeName: string; employeeNumber: string; workedMinutes: number; day: string }): WeeklyCustomerSliceRow {
  const { employeeId, employeeName, employeeNumber, workedMinutes, day, ...rest } = overrides;
  return {
    kind: 'WEEKLY_CUSTOMER_SLICE',
    logicalKey: { employeeId, timesheetId: `ts-${employeeId}`, siteId: 'site-a', workAreaId: 'customer-a', weekStart: '2026-09-14', weekEnd: '2026-09-20' },
    employeeName,
    employeeNumber,
    submissionState: 'SUBMITTED',
    approvalState: 'APPROVED',
    workedMinutes,
    grossMinutes: workedMinutes + 30,
    breakMinutes: 30,
    currentFingerprint: 'f'.repeat(64),
    canonicalSource: { dataSource: 'CURRENT_VERSION', sourceId: 'version-a', sourceKind: 'VERSION', sourceRevision: null, versionNumber: 1, submissionSource: 'MANUAL' },
    currentApprovalItem: { id: 'approval-a', fingerprint: 'f'.repeat(64), approvedAt: '2026-09-20T12:00:00.000Z', approvedByUserName: 'Admin' },
    lastHistoricalApproval: null,
    supersededFingerprintMatch: false,
    selfApprovalBlocked: false,
    eligibility: { canApprove: true },
    blockers: [],
    warnings: [],
    info: [],
    displayDays: [
      {
        date: day,
        dayType: 'WORK',
        confirmedZero: false,
        segments: [{ startAt: `${day}T06:00:00.000Z`, endAt: `${day}T14:00:00.000Z`, breaks: [] }],
        autoUnpaidBreakMinutes: 30,
        grossMinutes: workedMinutes + 30,
        breakMinutes: 30,
        workedMinutes
      }
    ],
    ...rest
  };
}

function group(siteId: string, siteName: string, customerId: string | null, customerName: string | null, rows: WeeklyCustomerSliceRow[]): CustomerGroup {
  return {
    siteId,
    siteName,
    workAreaId: customerId,
    workAreaName: customerName,
    rows: rows.map((item) => ({ ...item, logicalKey: { ...item.logicalKey, siteId, workAreaId: customerId } }))
  };
}

const alexA = row({ employeeId: 'emp-a', employeeName: 'Иванов Алексей', employeeNumber: '1042', workedMinutes: 450, day: '2026-09-14' });
const alexB = row({ employeeId: 'emp-a', employeeName: 'Иванов Алексей', employeeNumber: '1042', workedMinutes: 240, day: '2026-09-15', approvalState: 'NEEDS_ATTENTION', warnings: [{ code: 'TEST', message: 'attention' }] });
const boris = row({ employeeId: 'emp-b', employeeName: 'Белов Борис', employeeNumber: '1088', workedMinutes: 480, day: '2026-09-14' });

const ledger: TimeLedgerResult = {
  requestedRange: { startDate: '2026-09-14', endDate: '2026-09-20' },
  effectiveWeekRange: { startDate: '2026-09-14', endDate: '2026-09-20' },
  dataRange: null,
  allTime: false,
  summary: { workerCount: 4, entryCount: 5, sliceCount: 3, workedMinutes: 1170, readyCount: 0, needsAttentionCount: 1, approvedCount: 2, changedAfterApprovalCount: 0, notSubmittedEntryCount: 1, notSubmittedWorkerCount: 1, sourceErrorCount: 1 },
  customerGroups: [
    group('site-a', 'Meyer Turku Shipyard', 'customer-a', 'Meyer', [alexA, boris]),
    group('site-b', 'Pipe Site', 'customer-b', 'Pipe and Co', [alexB])
  ],
  notSubmitted: [{ kind: 'NOT_SUBMITTED', employeeId: 'emp-c', employeeName: 'Сидоров Семён', employeeNumber: '1103', periodId: 'period-a', periodStartDate: '2026-09-14', periodEndDate: '2026-09-20', timesheetId: null, timesheetStatus: null, weeksCovered: ['2026-09-14'] }],
  sourceErrors: [{ kind: 'SOURCE_ERROR', employeeId: 'emp-d', employeeName: 'Ошибкин Олег', employeeNumber: '1199', timesheetId: 'ts-error', periodId: 'period-a', periodStartDate: '2026-09-14', periodEndDate: '2026-09-20', reason: 'Fixture source error', workedMinutes: null, approvable: false }],
  pagination: { page: 1, pageSize: 5000, totalItems: 4, totalPages: 1 }
};

const defaults = parseReportWeekQuery({});
check('parser defaults to customer grouping and alphabetical sort', defaults.groupBy === 'customer' && defaults.sort === 'name_asc' && defaults.status === 'all', defaults);
const parsed = parseReportWeekQuery({ groupBy: 'worker', sort: 'hours_desc', customerId: '00000000-0000-4000-8000-000000000001', reportSiteId: 'bad', reportStatus: 'attention', onlyIssues: 'true', employeeSearch: '  Ivanov  ' });
check('parser accepts supported presentation values and trims search', parsed.groupBy === 'worker' && parsed.sort === 'hours_desc' && parsed.status === 'attention' && parsed.onlyIssues && parsed.employeeSearch === 'Ivanov', parsed);
check('parser ignores a malformed site id', parsed.siteId === null, parsed);

const byCustomer = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', defaults);
check('customer grouping creates two separate groups', byCustomer.groups.length === 2, byCustomer.groups.map((g) => g.title));
check('full selected week always has seven date columns', byCustomer.dates.length === 7 && byCustomer.dates[0] === '2026-09-14' && byCustomer.dates[6] === '2026-09-20', byCustomer.dates);
const fortnight = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-27', defaults);
check('a two-week payroll period shows every one of its fourteen dates', fortnight.dates.length === 14 && fortnight.dates[13] === '2026-09-27', fortnight.dates);
check('customer options and site options come from the unfiltered source', byCustomer.customerOptions.length === 2 && byCustomer.siteOptions.length === 2, { customers: byCustomer.customerOptions, sites: byCustomer.siteOptions });

const all = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, groupBy: 'all' });
const alexAll = all.groups[0].rows.find((item) => item.employeeId === 'emp-a');
check('all grouping merges one worker across customers', all.groups.length === 1 && all.groups[0].rows.length === 2 && alexAll?.workedMinutes === 690, alexAll);
check('merged row keeps daily values on their exact dates', alexAll?.days[0].workedMinutes === 450 && alexAll.days[1].workedMinutes === 240, alexAll?.days);
check('worst status wins when merged', alexAll?.status === 'attention' && alexAll.issueCount === 1, alexAll);

const byWorker = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, groupBy: 'worker' });
const alexGroup = byWorker.groups.find((item) => item.key === 'worker:emp-a');
check('worker grouping keeps customer/site rows under the employee', alexGroup?.rows.length === 2 && alexGroup.rows.every((item) => item.subjectLabel?.includes('·')), alexGroup);

const hours = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, groupBy: 'all', sort: 'hours_desc' });
check('hours-desc sorting orders aggregated workers', hours.groups[0].rows.map((item) => item.employeeId).join(',') === 'emp-a,emp-b', hours.groups[0].rows.map((item) => item.workedMinutes));

const onlyPipe = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, customerId: 'customer-b' });
check('customer filter keeps only matching slices', onlyPipe.groups.length === 1 && onlyPipe.groups[0].title === 'Pipe and Co' && onlyPipe.groups[0].workedMinutes === 240, onlyPipe.groups);

const attention = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, status: 'attention' });
check('status filter keeps attention rows', attention.visibleRowCount === 1 && attention.groups[0].rows[0].status === 'attention', attention.groups);

const missing = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, status: 'not_submitted' });
check('not-submitted mode hides worked groups and shows missing workers', missing.groups.length === 0 && missing.missing.length === 1 && missing.visibleRowCount === 1, missing);

const sourceError = buildReportWeekDetail(ledger, '2026-09-14', '2026-09-20', { ...defaults, status: 'source_error' });
check('source-error mode excludes worked and not-submitted rows', sourceError.groups.length === 0 && sourceError.missing.length === 0 && sourceError.sourceErrors.length === 1 && sourceError.visibleRowCount === 1, sourceError);

const html = renderToStaticMarkup(ReportWeekDetailView({ locale: 'RU', periodId: 'period-a', detail: byCustomer, query: defaults, truncated: false }));
check('rendered report shows all seven day headings and worker data', /Пн 14\.09/i.test(html) && /Вс 20\.09/i.test(html) && html.includes('Иванов Алексей'), html.slice(0, 500));
check('rendered report is read-only', !/Подтвердить|Внести изменения|ledger-row-checkbox|method="post"/i.test(html), html.slice(0, 500));

const zero = row({ employeeId: 'emp-zero', employeeName: 'Нулевая Смена', employeeNumber: '1200', workedMinutes: 0, day: '2026-09-16' });
zero.grossMinutes = 0;
zero.breakMinutes = 0;
zero.displayDays[0] = { ...zero.displayDays[0], confirmedZero: true, grossMinutes: 0, breakMinutes: 0, workedMinutes: 0, segments: [] };
const zeroDetail = buildReportWeekDetail({ ...ledger, customerGroups: [group('site-a', 'Meyer Turku Shipyard', 'customer-a', 'Meyer', [zero])], notSubmitted: [], sourceErrors: [] }, '2026-09-14', '2026-09-20', defaults);
const zeroHtml = renderToStaticMarkup(ReportWeekDetailView({ locale: 'RU', periodId: 'period-a', detail: zeroDetail, query: defaults, truncated: false }));
check('confirmed zero is distinct from an empty day', zeroHtml.includes('>0:00<') && zeroHtml.includes('>—<'), zeroHtml.slice(0, 700));

console.log(`report-week-detail: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
