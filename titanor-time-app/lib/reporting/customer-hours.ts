import { prisma } from '@/lib/prisma';

// T13.7 / T13.11 — the Customer Project Working Hours report.
//
// It is a document for the customer: confirmed (FINAL_APPROVED) hours by site, for a date range.
// It does NOT depend on the customer's TES, does NOT show internal TES rules, shows NO money.
//
// resolveCustomerReadiness looks at every timesheet that COVERS the requested (workers x sites x
// dates) and reports whether a final customer export is allowed. Driven by segments/timesheets,
// not by current assignments — a worker who has since moved sites still shows their historical
// hours, and a timesheet still in review is a blocker with a link.

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CustomerReadinessParams {
  dateFrom: Date;
  dateTo: Date;
  employeeIds: string[] | null;
  /** @deprecated Deploy F — kept for the legacy /export path; prefer workAreaIds. */
  siteIds?: string[] | null;
  /** R15-D7 Deploy F — readiness is scoped to the selected customer(s): a covering timesheet is
   *  only a blocker when it has a segment with one of these workAreaIds (or NULL when
   *  includeNoCustomer). null = not customer-scoped (legacy behaviour). */
  workAreaIds?: string[] | null;
  includeNoCustomer?: boolean;
}

export interface ReadinessBlocker {
  employeeName: string;
  employeeNumber: string;
  periodLabel: string;
  timesheetId: string;
  status: string;
  link: string;
}

export interface CustomerReadiness {
  /** CUSTOMER_FINAL — every covering timesheet is FINAL_APPROVED, the final export is allowed.
   *  INTERNAL_PREVIEW_ONLY — at least one covering timesheet is still in review / a draft. */
  level: 'CUSTOMER_FINAL' | 'INTERNAL_PREVIEW_ONLY';
  blockers: ReadinessBlocker[];
  /** Workers in scope whose timesheet is an empty draft or not submitted — shown, not a hard blocker. */
  noData: { employeeName: string; employeeNumber: string; periodLabel: string }[];
  coveredTimesheetCount: number;
}

const IN_REVIEW_STATUSES = ['DRAFT', 'RETURNED', 'SUBMITTED', 'FOREMAN_APPROVED'];

export async function resolveCustomerReadiness(params: CustomerReadinessParams): Promise<CustomerReadiness> {
  const periods = await prisma.payrollPeriod.findMany({
    where: { startDate: { lte: params.dateTo }, endDate: { gte: params.dateFrom } },
    select: { id: true, startDate: true, endDate: true }
  });
  if (periods.length === 0) {
    return { level: 'CUSTOMER_FINAL', blockers: [], noData: [], coveredTimesheetCount: 0 };
  }
  const periodLabelById = new Map(periods.map((p) => [p.id, `${formatDate(p.startDate)} – ${formatDate(p.endDate)}`]));

  // R15-D7 Deploy F — customer scope. A covering timesheet is only "relevant" (a possible blocker)
  // when it has at least one segment for one of the selected workAreas, in the selected date range.
  const waFilter = params.workAreaIds && params.workAreaIds.length > 0 ? new Set(params.workAreaIds) : null;
  const noCustomer = params.includeNoCustomer === true;
  const dateWindow = { date: { gte: params.dateFrom, lte: params.dateTo } } as const;
  const segMatchesScope = (workAreaId: string | null): boolean => {
    if (workAreaId === null) return noCustomer;
    return waFilter ? waFilter.has(workAreaId) : true;
  };

  const timesheets = await prisma.timesheet.findMany({
    where: {
      periodId: { in: periods.map((p) => p.id) },
      ...(params.employeeIds ? { employeeId: { in: params.employeeIds } } : {})
    },
    select: {
      id: true,
      status: true,
      periodId: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      currentVersion: {
        select: {
          // Do not cap this relation: readiness must see every segment in the customer scope.
          // A cap could hide a selected customer's later segment in a highly fragmented timesheet
          // and incorrectly allow a FINAL export while that timesheet is still in review.
          workSegments: { where: dateWindow, select: { siteId: true, workAreaId: true } },
          days: { select: { id: true }, take: 1 }
        }
      },
      draft: { select: { timesheetDraftSegments: { where: dateWindow, select: { siteId: true, workAreaId: true } } } }
    }
  });

  const legacySiteFilter = !waFilter && !noCustomer && params.siteIds ? new Set(params.siteIds) : null;
  const relevant = timesheets.filter((t) => {
    const versionSegs = t.currentVersion?.workSegments ?? [];
    const draftSegs = t.draft?.timesheetDraftSegments ?? [];
    const allSegs = [...versionSegs, ...draftSegs];
    // A timesheet with no segments yet can't be scope-filtered — keep it so it shows as noData.
    if (allSegs.length === 0) return true;
    if (waFilter || noCustomer) return allSegs.some((s) => segMatchesScope(s.workAreaId));
    if (legacySiteFilter) return allSegs.some((s) => legacySiteFilter.has(s.siteId));
    return true;
  });

  const blockers: ReadinessBlocker[] = [];
  const noData: CustomerReadiness['noData'] = [];
  for (const t of relevant) {
    const name = t.employee ? `${t.employee.lastName} ${t.employee.firstName}` : '';
    const number = t.employee?.employeeNumber ?? '';
    const periodLabel = periodLabelById.get(t.periodId) ?? '';
    if (t.status === 'FINAL_APPROVED') continue;
    if (IN_REVIEW_STATUSES.includes(t.status)) {
      const hasContent = (t.currentVersion?.days.length ?? 0) > 0 || (t.draft?.timesheetDraftSegments.length ?? 0) > 0;
      if ((t.status === 'DRAFT' || t.status === 'RETURNED') && !hasContent) {
        noData.push({ employeeName: name, employeeNumber: number, periodLabel });
      } else {
        blockers.push({ employeeName: name, employeeNumber: number, periodLabel, timesheetId: t.id, status: t.status, link: `/admin/timesheets/${t.id}` });
      }
    }
  }

  return {
    level: blockers.length === 0 ? 'CUSTOMER_FINAL' : 'INTERNAL_PREVIEW_ONLY',
    blockers: blockers.sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    noData: noData.sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    coveredTimesheetCount: relevant.length
  };
}
