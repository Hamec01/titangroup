import type { Prisma } from '@prisma/client';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.2 — the ONE definition of an
// "operationally live" assignment. Every "current assignment" consumer (the worker app, the
// Check-In resolver, the admin worker card + list, the site page, the "Today" dashboard, the
// qualification matrix, the customer page) MUST use this — no more per-file gt/gte on validTo.
//
//   live = validFrom <= todayHelsinki
//          AND (validTo IS NULL OR validTo >= todayHelsinki)          -- payroll/calendar window
//          AND (clockInDisabledAt IS NULL OR clockInDisabledAt > now) -- operational Check-In gate
//
// validFrom/validTo (dates) stay the payroll boundary; clockInDisabledAt (an exact instant) is the
// single operational lever set by a "снять / перевести" action. The materializer and historical
// reports deliberately do NOT use this — they attribute time by calendar date.

/** Calendar "today" in Europe/Helsinki as a UTC-midnight Date (same convention as
 *  lib/workers.ts helsinkiToday — kept local here to avoid an import cycle). */
export function helsinkiToday(): Date {
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/** Prisma `where` fragment for an operationally-live SiteAssignment. Pass `now` (defaults to the
 *  real current instant) and `today` (defaults to `helsinkiToday()`). */
export function liveAssignmentWhere(now: Date = new Date(), today: Date = helsinkiToday()): Prisma.SiteAssignmentWhereInput {
  return {
    validFrom: { lte: today },
    AND: [
      { OR: [{ validTo: null }, { validTo: { gte: today } }] },
      { OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] }
    ]
  };
}

interface AssignmentWindow {
  validFrom: Date;
  validTo: Date | null;
  clockInDisabledAt: Date | null;
}

/** In-memory predicate matching `liveAssignmentWhere`. */
export function isAssignmentLiveNow(a: AssignmentWindow, now: Date = new Date(), today: Date = helsinkiToday()): boolean {
  if (a.validFrom > today) {
    return false;
  }
  if (a.validTo !== null && a.validTo < today) {
    return false;
  }
  if (a.clockInDisabledAt !== null && a.clockInDisabledAt <= now) {
    return false;
  }
  return true;
}

export type AssignmentUiState = 'ACTIVE' | 'SHIFT_OPEN' | 'SCHEDULED' | 'ENDED' | 'NEEDS_ATTENTION';

/**
 * The status shown on the worker card (design §2.3). `hasOpenShift` = there is an EmployeeOpenShift
 * for this employee whose sourceAssignmentId is this assignment; `needsAttention` = a
 * STALE_ASSIGNMENT / unresolved-open-shift / double-primary flag the caller already computed.
 */
export function assignmentUiState(
  a: AssignmentWindow,
  opts: { hasOpenShift?: boolean; needsAttention?: boolean } = {},
  now: Date = new Date(),
  today: Date = helsinkiToday()
): AssignmentUiState {
  if (opts.needsAttention) {
    return 'NEEDS_ATTENTION';
  }
  const disabled = a.clockInDisabledAt !== null && a.clockInDisabledAt <= now;
  if (disabled) {
    return opts.hasOpenShift ? 'SHIFT_OPEN' : 'ENDED';
  }
  if (a.validFrom > today || (a.clockInDisabledAt !== null && a.clockInDisabledAt > now)) {
    return 'SCHEDULED';
  }
  if (a.validTo !== null && a.validTo < today) {
    return 'ENDED';
  }
  return opts.hasOpenShift ? 'SHIFT_OPEN' : 'ACTIVE';
}
