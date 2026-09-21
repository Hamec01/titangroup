// UT3 (Titanor Time — единый табель и подтверждение часов по заказчику, checkpoint UT3-B) —
// the ONE case that genuinely cannot be discovered by iterating Timesheet rows: an expected
// PayrollPeriodParticipant that has no Timesheet at all.
//
// UT3-A-R2 §1/§13 — a DRAFT/RETURNED Timesheet with zero real weekly-customer-slices is handled
// INLINE by lib/reporting/time-ledger.ts's own Timesheet cursor (every Timesheet, including
// DRAFT/RETURNED ones, is already visited exactly once there — no separate pass needed, no
// duplication risk). This module covers only the participant-without-Timesheet case, which by
// definition can never appear in a Timesheet-keyed cursor at all and therefore needs its own,
// separately-chunkable, period-keyed read.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface MissingTimesheetParticipant {
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  employeeNumber: string;
  periodId: string;
  periodStartDate: string;
  periodEndDate: string;
}

export interface MissingTimesheetParticipantFilters {
  periodIds: string[];
  employeeSearch?: string | null;
  /** WorkSite id — matched against the employee's SiteAssignment history intersecting THIS
   *  participant's own period dates (UT3-A-R1 §8: "authoritative", never the latest/current
   *  assignment). Applied as a second, in-memory pass (see loadMissingTimesheetParticipants'
   *  own comment) — Prisma cannot correlate a relation's date columns against a sibling
   *  relation's own per-row dates in one declarative `where`. */
  siteId?: string | null;
}

/**
 * PayrollPeriodParticipant(expected=true) rows in the given periods that have NO Timesheet row
 * at all (`timesheets: { none: {} }` — Prisma's native "no related row exists" filter, one SQL
 * query, not N+1). Chunk this by `periodIds` (a bounded slice of periods) from the caller — each
 * period is visited by exactly one chunk of the caller's own period cursor, so calling this once
 * per period-chunk can never duplicate a participant and can never miss one (UT3-A-R2 §1).
 */
export async function loadMissingTimesheetParticipants(filters: MissingTimesheetParticipantFilters, db: Db = prisma): Promise<MissingTimesheetParticipant[]> {
  if (filters.periodIds.length === 0) return [];

  const employeeWhere: Prisma.EmployeeWhereInput = {};
  if (filters.employeeSearch) {
    const q = filters.employeeSearch;
    employeeWhere.OR = [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { employeeNumber: { contains: q, mode: 'insensitive' } }];
  }

  const rows = await db.payrollPeriodParticipant.findMany({
    where: {
      periodId: { in: filters.periodIds },
      expected: true,
      timesheets: { none: {} },
      ...(Object.keys(employeeWhere).length > 0 ? { employee: employeeWhere } : {})
    },
    select: {
      employeeId: true,
      periodId: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      period: { select: { startDate: true, endDate: true } }
    }
  });

  const candidates = rows.map((r) => ({
    employeeId: r.employeeId,
    employeeFirstName: r.employee.firstName,
    employeeLastName: r.employee.lastName,
    employeeNumber: r.employee.employeeNumber,
    periodId: r.periodId,
    periodStartDate: formatDate(r.period.startDate),
    periodEndDate: formatDate(r.period.endDate)
  }));

  if (!filters.siteId || candidates.length === 0) {
    return candidates;
  }

  // siteId filter: one batch query for every candidate employee's SiteAssignment history at this
  // site, then an in-memory intersection check against each candidate's OWN period dates — never
  // "current/latest assignment", always the assignment that was actually live during that period
  // (UT3-A-R1 §8, UT3-A-R2 §13).
  const employeeIds = [...new Set(candidates.map((c) => c.employeeId))];
  const assignments = await db.siteAssignment.findMany({
    where: { employeeId: { in: employeeIds }, siteId: filters.siteId },
    select: { employeeId: true, validFrom: true, validTo: true }
  });
  const byEmployee = new Map<string, { validFrom: Date; validTo: Date | null }[]>();
  for (const a of assignments) {
    const list = byEmployee.get(a.employeeId) ?? [];
    list.push({ validFrom: a.validFrom, validTo: a.validTo });
    byEmployee.set(a.employeeId, list);
  }

  return candidates.filter((c) => {
    const list = byEmployee.get(c.employeeId);
    if (!list) return false;
    const periodStart = new Date(`${c.periodStartDate}T00:00:00.000Z`);
    const periodEnd = new Date(`${c.periodEndDate}T00:00:00.000Z`);
    return list.some((a) => a.validFrom <= periodEnd && (a.validTo === null || a.validTo >= periodStart));
  });
}
