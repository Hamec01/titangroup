// T10-D — shared loaders for the automatic unpaid-lunch inputs (docs/titanor-time/T10_DEF_PLAN.md §D).
// The formula itself is in worked-time.ts (computeDayWorkedMs); the day-grouping is in
// canonical-daily-buckets.ts. This module only fetches: (a) the company threshold, (b) the planned
// UNPAID break per date, from the frozen / draft planned shifts (never joining back to the template
// — plannedBreakPaid is copied onto those rows at plan-materialization time).

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES } from '@/lib/reporting/canonical-daily-buckets';

type Db = Prisma.TransactionClient | typeof prisma;

export async function loadAutoUnpaidBreakThresholdMinutes(db: Db = prisma): Promise<number> {
  const policy = await db.companyAttendancePolicy.findFirst({ select: { autoUnpaidBreakThresholdMinutes: true } });
  return policy?.autoUnpaidBreakThresholdMinutes ?? DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** planned UNPAID break minutes keyed by "YYYY-MM-DD", for one or more frozen TimesheetVersions.
 *  A date with a paid planned break (or no plan) is absent from the map (→ 0). Multiple planned
 *  shifts on one date: the larger unpaid break wins. */
export async function loadVersionPlannedUnpaidBreakByDate(versionIds: string[], db: Db = prisma): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (versionIds.length === 0) return out;
  const shifts = await db.timesheetPlannedShift.findMany({
    where: { timesheetVersionId: { in: versionIds } },
    select: { date: true, plannedBreakMinutes: true, plannedBreakPaid: true }
  });
  for (const s of shifts) {
    const unpaid = s.plannedBreakPaid ? 0 : s.plannedBreakMinutes;
    if (unpaid <= 0) continue;
    const key = isoDate(s.date);
    out.set(key, Math.max(out.get(key) ?? 0, unpaid));
  }
  return out;
}

/** Same, but for the worker's TimesheetDrafts (TimesheetDraftPlannedShift). */
export async function loadDraftPlannedUnpaidBreakByDate(draftIds: string[], db: Db = prisma): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (draftIds.length === 0) return out;
  const shifts = await db.timesheetDraftPlannedShift.findMany({
    where: { draftId: { in: draftIds } },
    select: { date: true, plannedBreakMinutes: true, plannedBreakPaid: true }
  });
  for (const s of shifts) {
    const unpaid = s.plannedBreakPaid ? 0 : s.plannedBreakMinutes;
    if (unpaid <= 0) continue;
    const key = isoDate(s.date);
    out.set(key, Math.max(out.get(key) ?? 0, unpaid));
  }
  return out;
}

/** Per-(versionId or draftId, date) — the shape period-time-report / csv-export need when they mix
 *  draft- and version-sourced employees in one pass. Key: `${sourceId}:${YYYY-MM-DD}`. */
export async function loadPlannedUnpaidBreakBySourceAndDate(
  input: { versionIds: string[]; draftIds: string[] },
  db: Db = prisma
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (input.versionIds.length > 0) {
    const rows = await db.timesheetPlannedShift.findMany({
      where: { timesheetVersionId: { in: input.versionIds } },
      select: { timesheetVersionId: true, date: true, plannedBreakMinutes: true, plannedBreakPaid: true }
    });
    for (const s of rows) {
      const unpaid = s.plannedBreakPaid ? 0 : s.plannedBreakMinutes;
      if (unpaid <= 0) continue;
      const key = `${s.timesheetVersionId}:${isoDate(s.date)}`;
      out.set(key, Math.max(out.get(key) ?? 0, unpaid));
    }
  }
  if (input.draftIds.length > 0) {
    const rows = await db.timesheetDraftPlannedShift.findMany({
      where: { draftId: { in: input.draftIds } },
      select: { draftId: true, date: true, plannedBreakMinutes: true, plannedBreakPaid: true }
    });
    for (const s of rows) {
      const unpaid = s.plannedBreakPaid ? 0 : s.plannedBreakMinutes;
      if (unpaid <= 0) continue;
      const key = `${s.draftId}:${isoDate(s.date)}`;
      out.set(key, Math.max(out.get(key) ?? 0, unpaid));
    }
  }
  return out;
}
