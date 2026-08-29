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
  siteIds: string[] | null;
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
          workSegments: { select: { siteId: true, date: true }, take: 1 },
          days: { select: { id: true }, take: 1 }
        }
      },
      draft: { select: { timesheetDraftSegments: { select: { siteId: true }, take: 1 } } }
    }
  });

  // Keep only timesheets that actually intersect the selected sites (when a site filter is set).
  const siteFilter = params.siteIds ? new Set(params.siteIds) : null;
  const relevant = timesheets.filter((t) => {
    if (!siteFilter) return true;
    const versionSites = t.currentVersion?.workSegments.map((s) => s.siteId) ?? [];
    const draftSites = t.draft?.timesheetDraftSegments.map((s) => s.siteId) ?? [];
    // A timesheet with no segments yet can't be filtered by site — keep it so it shows as noData.
    if (versionSites.length === 0 && draftSites.length === 0) return true;
    return [...versionSites, ...draftSites].some((id) => siteFilter.has(id));
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
