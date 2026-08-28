// T12 (owner model, 2026-08-28) — "the week belongs to the worker until the cutoff, then to the
// boss". The worker can freely add/edit hours (with or without check-in/out) for the whole cycle
// PLUS a grace day; exactly at the cutoff the timesheet auto-submits and locks. The cutoff is the
// SAME instant attendance-auto-submit uses for a generation-0 candidate — one source of truth.
//
//   weekly cycle (Mon–Sun): cutoff = the following Monday 23:59  -> 8 editable days
//   biweekly cycle (14 d):  cutoff = day 15, 23:59               -> 15 editable days
//
// It is one number in CompanyAttendancePolicy: cutoffDaysAfterPeriodEnd (default 1) + cutoffTime
// (default 23:59). This module has zero Prisma/HTTP deps so both the worker pages and the
// auto-submit scheduler can share it.

import { helsinkiWallClockToUtc } from '@/lib/periods';

export interface EditCutoffPolicy {
  cutoffDaysAfterPeriodEnd: number;
  cutoffTime: Date;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** The instant a period's timesheet stops being the worker's and becomes the boss's. */
export function computeTimesheetEditCutoff(periodEndDate: Date, policy: EditCutoffPolicy): Date {
  return helsinkiWallClockToUtc(addDays(periodEndDate, policy.cutoffDaysAfterPeriodEnd), policy.cutoffTime);
}

/**
 * Can the WORKER still touch this timesheet right now? True while the period is OPEN and now is
 * before the cutoff — regardless of whether the worker already tapped "Отправить" (that is a soft,
 * reversible signal, not a lock). A DRAFT/RETURNED timesheet edits inline; a SUBMITTED/
 * FOREMAN_APPROVED/FINAL_APPROVED one needs a one-tap reopen first (needsReopen below).
 */
export function isWorkerWithinEditWindow(periodStatus: string, periodEndDate: Date, policy: EditCutoffPolicy, now: Date = new Date()): boolean {
  if (periodStatus !== 'OPEN') {
    return false;
  }
  return now.getTime() < computeTimesheetEditCutoff(periodEndDate, policy).getTime();
}

const INLINE_EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);

/** Within the edit window, a non-draft timesheet (SUBMITTED / FOREMAN_APPROVED / FINAL_APPROVED)
 *  must be reopened to a draft before the worker can edit day rows. */
export function workerNeedsReopen(timesheetStatus: string): boolean {
  return !INLINE_EDITABLE_STATUSES.has(timesheetStatus);
}
