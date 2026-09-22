// UT1 (Titanor Time — единый табель и подтверждение часов по заказчику, UT0-R2 checkpoint) —
// pure builder for "weekly customer slices": one worker's hours at one (siteId, workAreaId) pair
// within one Helsinki calendar week (Mon-Sun), plus a stable SHA-256 fingerprint of that content.
//
// Zero Prisma/HTTP/UI dependencies, same discipline as lib/reporting/worked-time.ts and
// lib/reporting/canonical-source.ts — callers load whatever rows they already need (one
// TimesheetVersion's WorkSegment/TimesheetDay, or one TimesheetDraft's segments/days) and pass them
// in already shaped as RawDay[]. This module never touches the database and never decides which
// canonical source (draft vs frozen version) to read — that decision stays
// lib/reporting/canonical-source.ts's job, unchanged.
//
// Architecture reference: this file implements exactly the contract fixed across the UT0 / UT0-R1 /
// UT0-R2 checkpoints for TITANOR_TIME_UNIFIED_TIMESHEET_UPDATE_TZ_RU.md — no UI, no database, no
// approval endpoint. Only the pure calculation.

import { createHash } from 'node:crypto';
import { computeDayWorkedMs, computeSegmentMs, msToMinutes, sumWorkedTimeMs, type WorkedTimeBreakInput, type WorkedTimeSegmentInput } from '@/lib/reporting/worked-time';

// ---------------------------------------------------------------------------------------------
// Input types — what the caller already loaded (Prisma-independent shape).
// ---------------------------------------------------------------------------------------------

export interface RawBreak {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}

export interface RawSegment {
  /** Stable id (WorkSegment.id / TimesheetDraftSegment.id). Used ONLY as the last tie-break when
   *  sorting segments that share both startAt and endAt — never serialized into
   *  CanonicalSlicePayload and never part of the fingerprint (UT0-R2 §4). */
  id: string;
  startAt: Date;
  endAt: Date;
  siteId: string;
  workAreaId: string | null;
  breaks: RawBreak[];
}

export interface RawDay {
  /** Helsinki calendar day, UTC-midnight Date — same project-wide convention as
   *  TimesheetDay.date / TimesheetDraftDay.date (see lib/periods.ts's own header comment). */
  date: Date;
  dayType: string;
  confirmedZero: boolean;
  /** ALL segments of this day, across every (siteId, workAreaId) pair — the builder itself groups
   *  them (UT0-R2 §3, Phase 2). The caller does not pre-filter by customer. */
  segments: RawSegment[];
}

export interface BuildSlicesInput {
  employeeId: string;
  timesheetId: string;
  /** versionId or draftId — the single canonical source this call's days/segments came from. Used
   *  as the source half of the `${sourceId}:${date}` auto-break lookup key. */
  sourceId: string;
  days: RawDay[];
  /** Planned UNPAID break minutes, keyed `${sourceId}:${YYYY-MM-DD}` — the exact shape
   *  lib/reporting/auto-break.ts's loadPlannedUnpaidBreakBySourceAndDate already returns. */
  plannedUnpaidBreakBySourceAndDate: Map<string, number>;
  autoBreakThresholdMinutes: number;
}

// ---------------------------------------------------------------------------------------------
// Output types — the canonical, hashable payload plus the slice wrapper around it.
// ---------------------------------------------------------------------------------------------

export interface CanonicalSliceBreak {
  startAt: string; // ISO 8601 UTC
  endAt: string; // ISO 8601 UTC
  paid: boolean;
}

export interface CanonicalSliceSegment {
  startAt: string; // ISO 8601 UTC
  endAt: string; // ISO 8601 UTC
  breaks: CanonicalSliceBreak[]; // sorted startAt, then endAt
}

export interface CanonicalSliceDay {
  date: string; // YYYY-MM-DD
  dayType: string;
  confirmedZero: boolean;
  /** Sorted startAt, then endAt, then id (id itself never appears in the output). */
  segments: CanonicalSliceSegment[];
  /** This slice's own share of the day's single auto-unpaid-break decision (UT0-R2 §1) — never
   *  the whole day's total when more than one customer shares the day. */
  autoUnpaidBreakMinutes: number;
}

export interface CanonicalSlicePayload {
  schemaVersion: 1;
  employeeId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: string; // YYYY-MM-DD, Monday
  weekEnd: string; // YYYY-MM-DD, Sunday = weekStart + 6
  /**
   * ONLY the days where this (siteId, workAreaId) pair has at least one segment — length 1..7, not
   * always 7 (UT0-R2 §2). A day with segments only for a DIFFERENT pair of the same week is simply
   * absent here, not present as an empty placeholder.
   */
  days: CanonicalSliceDay[];
}

export interface WeeklyCustomerSliceLogicalKey {
  employeeId: string;
  timesheetId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: string;
  weekEnd: string;
}

/** One day's totals within a slice, captured from the SAME applyPreallocatedBreak() call that
 *  already produces the slice-level sums below (UT4-B-fixup #3) — never a second, independent
 *  computation. `date` matches payload.days[i].date 1:1, same order. `grossMinutes =
 *  workedMinutes + breakMinutes` holds by the same construction as the slice-level totals (see
 *  applyPreallocatedBreak's own comment). Deliberately kept OUTSIDE CanonicalSlicePayload — like
 *  workedMinutes/grossMinutes/breakMinutes below, it is a derived display convenience, not part of
 *  the hashed canonical content. */
export interface WeeklyCustomerSliceDayTotal {
  date: string; // YYYY-MM-DD
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
  /** This slice's own share of the day's auto-unpaid-break — same value as the matching
   *  payload.days[i].autoUnpaidBreakMinutes, duplicated here so UI code needs only dayTotals. */
  autoUnpaidBreakMinutes: number;
}

export interface WeeklyCustomerSlice {
  logicalKey: WeeklyCustomerSliceLogicalKey;
  payload: CanonicalSlicePayload;
  fingerprint: string; // sha256 hex, 64 lowercase chars
  workedMinutes: number;
  grossMinutes: number;
  breakMinutes: number;
  dayTotals: WeeklyCustomerSliceDayTotal[];
}

// ---------------------------------------------------------------------------------------------
// Helsinki Monday-Sunday week boundaries.
//
// `date` is already a UTC-midnight Date representing a Helsinki calendar day (the project-wide
// convention — see lib/periods.ts's toTemplateWeekday comment). Week-boundary arithmetic is
// therefore plain calendar-day arithmetic with no timezone conversion at all, which is also why it
// needs no special-casing around a DST transition: DST only matters when converting a Helsinki
// wall-clock time into a UTC instant (lib/periods.ts's helsinkiWallClockToUtc), never when adding
// whole days to an already-resolved calendar date.
// ---------------------------------------------------------------------------------------------

function formatDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseIsoDateUtc(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/** 0=Mon..6=Sun — same convention as lib/periods.ts's toTemplateWeekday. */
function mondayOffset(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

export function helsinkiWeekBounds(date: Date): { weekStart: string; weekEnd: string } {
  const monday = addUtcDays(date, -mondayOffset(date));
  const sunday = addUtcDays(monday, 6);
  return { weekStart: formatDateIso(monday), weekEnd: formatDateIso(sunday) };
}

/** Every Monday-Sunday week whose range intersects [startDateIso, endDateIso], regardless of
 *  whether startDateIso/endDateIso themselves fall on week boundaries. */
export function enumerateHelsinkiWeeks(startDateIso: string, endDateIso: string): { weekStart: string; weekEnd: string }[] {
  const weeks: { weekStart: string; weekEnd: string }[] = [];
  const firstMonday = parseIsoDateUtc(helsinkiWeekBounds(parseIsoDateUtc(startDateIso)).weekStart);
  const end = parseIsoDateUtc(endDateIso);
  let cursor = firstMonday;
  while (cursor <= end) {
    weeks.push(helsinkiWeekBounds(cursor));
    cursor = addUtcDays(cursor, 7);
  }
  return weeks;
}

// ---------------------------------------------------------------------------------------------
// Canonical fingerprint — same stable-JSON-then-sha256 recipe as
// lib/worker-timesheets.ts's computeContentHash / lib/idempotency.ts's computeRequestHash, kept as
// its own small local copy (that helper is private to worker-timesheets.ts, and this module is
// meant to have zero dependency on it) rather than a shared util neither of those needs to expose.
// ---------------------------------------------------------------------------------------------

function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeSliceFingerprint(payload: CanonicalSlicePayload): string {
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Grouping by (siteId, workAreaId) — the customer-slice key within one day.
// ---------------------------------------------------------------------------------------------

/** Fixed, stable string representation for the "Без заказчика" (workAreaId = null) case — the
 *  empty string sorts lexicographically before any UUID hex string, so tie-breaks involving a
 *  null-workArea group are as deterministic as any other. */
function canonicalGroupKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

interface CustomerGroup {
  siteId: string;
  workAreaId: string | null;
  segments: RawSegment[];
}

function groupSegmentsByCustomer(segments: RawSegment[]): CustomerGroup[] {
  const byKey = new Map<string, CustomerGroup>();
  for (const segment of segments) {
    const key = canonicalGroupKey(segment.siteId, segment.workAreaId);
    const existing = byKey.get(key);
    if (existing) {
      existing.segments.push(segment);
    } else {
      byKey.set(key, { siteId: segment.siteId, workAreaId: segment.workAreaId, segments: [segment] });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------------------------
// Largest-remainder allocation of one day's single auto-unpaid-break decision across the
// customer groups present that day (UT0-R2 §1). Eligibility (hasLoggedBreak / gross threshold) is
// decided exactly once, at the whole-day level, by computeDayWorkedMs itself — this function only
// ever divides an already-decided integer number of minutes; it never re-derives eligibility.
// ---------------------------------------------------------------------------------------------

interface AllocationWeight {
  key: string;
  grossMs: number;
  /** A group can never be allocated more than its own gross minutes (UT0-R2 §1). */
  capMinutes: number;
}

/** Thrown by largestRemainderAllocate / applyPreallocatedBreak when the auto-break allocation
 *  cannot keep every invariant (per-group cap respected AND the exact total distributed AND
 *  workedMinutes never negative) at the same time. UT1-fixup: an earlier version of this function
 *  resolved that conflict by handing the unavoidable remainder to one group anyway, which could
 *  make that group's breakMinutes exceed its own grossMinutes and produce a negative
 *  workedMinutes — a fabricated, silently wrong number is worse than a loud, named failure here. */
export const WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE = 'WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE';

/**
 * Largest-remainder method, capped per group at its own gross minutes — never exceeded, no
 * exceptions.
 *
 * 1. exact_g = totalMinutes * grossMs_g / totalGrossMs, computed once over the full pool (never
 *    renormalized over a shrinking pool — renormalizing after capping a group is what silently
 *    lost whole minutes in an earlier draft of this function, verified against a 300k-case
 *    randomized fixture search before landing this version).
 * 2. Each group's floor is clamped at its own capMinutes up front.
 * 3. The minutes still unassigned after that clamp are handed out one at a time, in descending
 *    remainder order (ties broken by ascending canonical key), skipping any group already at its
 *    cap — so a bump never itself creates an overflow.
 * 4. In the rare case where the day-level total (itself already rounded once) exceeds the sum of
 *    every group's individually-rounded cap — a pure double-rounding artifact, only reachable with
 *    non-minute-aligned (sub-minute) segment timestamps — there is genuinely no assignment that
 *    both respects every cap AND sums to totalMinutes. This function does NOT paper over that by
 *    exceeding a cap anyway (an earlier version did — see the exported error constant's comment):
 *    it throws WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE instead.
 */
function largestRemainderAllocate(weights: AllocationWeight[], totalMinutes: number): Map<string, number> {
  const alloc = new Map<string, number>();
  const pool = weights.filter((w) => w.grossMs > 0);
  if (totalMinutes <= 0 || pool.length === 0) {
    for (const w of weights) alloc.set(w.key, 0);
    return alloc;
  }

  const totalGrossMs = pool.reduce((sum, w) => sum + w.grossMs, 0);
  const withExact = pool.map((w) => {
    const exact = (totalMinutes * w.grossMs) / totalGrossMs;
    const floor = Math.floor(exact);
    return { ...w, remainder: exact - floor, cappedFloor: Math.min(floor, w.capMinutes) };
  });
  for (const w of withExact) alloc.set(w.key, w.cappedFloor);

  let remaining = totalMinutes - withExact.reduce((sum, w) => sum + w.cappedFloor, 0);
  const priorityOrder = [...withExact].sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));

  while (remaining > 0) {
    let progressed = false;
    for (const w of priorityOrder) {
      if (remaining <= 0) break;
      const current = alloc.get(w.key) ?? 0;
      if (current < w.capMinutes) {
        alloc.set(w.key, current + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break; // every group is already at its cap — checked below, never forced past it
  }

  for (const w of weights) {
    if (!alloc.has(w.key)) alloc.set(w.key, 0);
  }

  // Hard invariants, checked unconditionally: every group's allocation must respect its own cap,
  // and the total distributed must equal exactly totalMinutes. Neither is ever relaxed.
  const sumAllocated = [...alloc.values()].reduce((sum, v) => sum + v, 0);
  const overCap = weights.find((w) => (alloc.get(w.key) ?? 0) > w.capMinutes);
  if (sumAllocated !== totalMinutes || overCap) {
    throw new Error(
      `${WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE}: cannot distribute ${totalMinutes} auto-break minute(s) across ${weights.length} customer group(s) without exceeding a group's own gross minutes (distributed=${sumAllocated}${overCap ? `, group ${overCap.key} would exceed its cap of ${overCap.capMinutes}` : ''})`
    );
  }
  return alloc;
}

function toWorkedTimeSegment(segment: RawSegment): WorkedTimeSegmentInput {
  return { startAt: segment.startAt, endAt: segment.endAt, breaks: segment.breaks.map((b) => toWorkedTimeBreak(b)) };
}

function toWorkedTimeBreak(b: RawBreak): WorkedTimeBreakInput {
  return { startAt: b.startAt, endAt: b.endAt, paid: b.paid };
}

/** Applies an already-allocated integer number of auto-unpaid-break minutes to one customer
 *  group's own segments. Pure arithmetic on top of computeSegmentMs/sumWorkedTimeMs — never calls
 *  computeDayWorkedMs again (that would re-derive eligibility per group, which is wrong: eligibility
 *  is a whole-day decision, see the module header).
 *
 *  grossMinutes and breakMinutes are each rounded to minutes independently (msToMinutes), then
 *  workedMinutes is DEFINED as grossMinutes - breakMinutes — never computed as a separate
 *  msToMinutes(workedMs) that could, in principle, disagree with the other two by a rounding unit.
 *  This makes `grossMinutes = workedMinutes + breakMinutes` true by construction, not just by
 *  coincidence, and turns "workedMinutes negative" into exactly the same failure as "breakMinutes
 *  exceeds grossMinutes" — checked here unconditionally, right before the subtraction. Explicit
 *  (logged) breaks can never trigger this on their own (a break is a sub-interval of its own
 *  segment, so breakMinutes from explicit breaks alone can never exceed that segment's gross); the
 *  only realistic source is a caller passing an allocatedAutoUnpaidBreakMinutes that
 *  largestRemainderAllocate did not itself produce — largestRemainderAllocate already enforces the
 *  same cap and throws the identical error if it cannot be satisfied, so in the normal call path
 *  this check is defense in depth, not the primary guard. */
function applyPreallocatedBreak(segments: RawSegment[], allocatedAutoUnpaidBreakMinutes: number): { workedMinutes: number; grossMinutes: number; breakMinutes: number } {
  const base = sumWorkedTimeMs(segments.map((s) => computeSegmentMs(toWorkedTimeSegment(s))));
  const grossMinutes = msToMinutes(base.grossMs);
  const breakMinutes = msToMinutes(base.unpaidBreakMs) + allocatedAutoUnpaidBreakMinutes;

  if (breakMinutes < 0 || breakMinutes > grossMinutes) {
    throw new Error(
      `${WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE}: breakMinutes=${breakMinutes} outside [0, grossMinutes=${grossMinutes}]`
    );
  }

  return { workedMinutes: grossMinutes - breakMinutes, grossMinutes, breakMinutes };
}

// ---------------------------------------------------------------------------------------------
// Sorting — stable, content-first. id is the LAST tie-break, after every content field including
// each segment's own breaks — otherwise two segments that share startAt/endAt but carry different
// break facts (e.g. a resubmit that rebuilds the same segment under a fresh UUID, with its breaks
// getting fresh UUIDs too) could swap canonical order purely because of new random ids, changing
// the fingerprint even though nothing about the actual hours changed. Ordering by full canonical
// break content first (never by break id, which does not exist on RawBreak/CanonicalSliceBreak at
// all) makes the order — and therefore the fingerprint — depend only on facts, never on identity.
// ---------------------------------------------------------------------------------------------

function compareCanonicalBreaks(a: RawBreak[], b: RawBreak[]): number {
  const sa = sortBreaks(a);
  const sb = sortBreaks(b);
  const len = Math.min(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const byStart = sa[i].startAt.getTime() - sb[i].startAt.getTime();
    if (byStart !== 0) return byStart;
    const byEnd = sa[i].endAt.getTime() - sb[i].endAt.getTime();
    if (byEnd !== 0) return byEnd;
    const byPaid = Number(sa[i].paid) - Number(sb[i].paid);
    if (byPaid !== 0) return byPaid;
  }
  return sa.length - sb.length;
}

function sortSegments(segments: RawSegment[]): RawSegment[] {
  return [...segments].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime() || compareCanonicalBreaks(a.breaks, b.breaks) || a.id.localeCompare(b.id)
  );
}

function sortBreaks(breaks: RawBreak[]): RawBreak[] {
  return [...breaks].sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime());
}

// ---------------------------------------------------------------------------------------------
// The builder itself — two phases exactly as fixed in UT0-R2 §3.
// ---------------------------------------------------------------------------------------------

interface DayCustomerAllocation {
  siteId: string;
  workAreaId: string | null;
  segments: RawSegment[];
  autoUnpaidBreakMinutes: number;
}

interface DayAllocation {
  dateIso: string;
  dayType: string;
  confirmedZero: boolean;
  weekStart: string;
  weekEnd: string;
  groups: DayCustomerAllocation[];
}

/**
 * Phase 1 — per calendar date, decide the day's SINGLE auto-unpaid-break outcome across ALL of the
 * day's segments (any customer), exactly like the existing review queue / reports already do via
 * computeDayWorkedMs, then split that one integer of minutes across the day's customer groups by
 * largest-remainder (UT0-R2 §1). Phase 2 — group the day-level allocations by
 * (siteId, workAreaId, weekStart) across the whole requested range, keep only the days where that
 * pair actually has a segment (UT0-R2 §2), and build+hash the canonical payload per slice.
 */
export function buildWeeklyCustomerSlices(input: BuildSlicesInput): WeeklyCustomerSlice[] {
  const dayAllocations: DayAllocation[] = input.days.map((day) => {
    const dateIso = formatDateIso(day.date);
    const { weekStart, weekEnd } = helsinkiWeekBounds(day.date);
    const lookupKey = `${input.sourceId}:${dateIso}`;
    const plannedUnpaidBreakMinutes = input.plannedUnpaidBreakBySourceAndDate.get(lookupKey) ?? 0;

    const dayResult = computeDayWorkedMs(
      day.segments.map((s) => toWorkedTimeSegment(s)),
      { plannedUnpaidBreakMinutes, grossThresholdMinutes: input.autoBreakThresholdMinutes }
    );
    const autoUnpaidBreakMinutesDay = msToMinutes(dayResult.autoUnpaidBreakMs);

    const customerGroups = groupSegmentsByCustomer(day.segments);
    const weights: AllocationWeight[] = customerGroups.map((g) => {
      const grossMs = sumWorkedTimeMs(g.segments.map((s) => computeSegmentMs(toWorkedTimeSegment(s)))).grossMs;
      return { key: canonicalGroupKey(g.siteId, g.workAreaId), grossMs, capMinutes: msToMinutes(grossMs) };
    });
    const allocation = largestRemainderAllocate(weights, autoUnpaidBreakMinutesDay);

    const groups: DayCustomerAllocation[] = customerGroups.map((g) => ({
      siteId: g.siteId,
      workAreaId: g.workAreaId,
      segments: g.segments,
      autoUnpaidBreakMinutes: allocation.get(canonicalGroupKey(g.siteId, g.workAreaId)) ?? 0
    }));

    return { dateIso, dayType: day.dayType, confirmedZero: day.confirmedZero, weekStart, weekEnd, groups };
  });

  interface SliceBuilder {
    siteId: string;
    workAreaId: string | null;
    weekStart: string;
    weekEnd: string;
    days: { dateIso: string; dayType: string; confirmedZero: boolean; group: DayCustomerAllocation }[];
  }
  const sliceByKey = new Map<string, SliceBuilder>();

  for (const day of dayAllocations) {
    for (const group of day.groups) {
      const sliceKey = `${canonicalGroupKey(group.siteId, group.workAreaId)}::${day.weekStart}`;
      let builder = sliceByKey.get(sliceKey);
      if (!builder) {
        builder = { siteId: group.siteId, workAreaId: group.workAreaId, weekStart: day.weekStart, weekEnd: day.weekEnd, days: [] };
        sliceByKey.set(sliceKey, builder);
      }
      builder.days.push({ dateIso: day.dateIso, dayType: day.dayType, confirmedZero: day.confirmedZero, group });
    }
  }

  const slices: WeeklyCustomerSlice[] = [];
  for (const builder of sliceByKey.values()) {
    const sortedDays = [...builder.days].sort((a, b) => a.dateIso.localeCompare(b.dateIso));

    const canonicalDays: CanonicalSliceDay[] = sortedDays.map((d) => ({
      date: d.dateIso,
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      segments: sortSegments(d.group.segments).map((segment) => ({
        startAt: segment.startAt.toISOString(),
        endAt: segment.endAt.toISOString(),
        breaks: sortBreaks(segment.breaks).map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      })),
      autoUnpaidBreakMinutes: d.group.autoUnpaidBreakMinutes
    }));

    const payload: CanonicalSlicePayload = {
      schemaVersion: 1,
      employeeId: input.employeeId,
      siteId: builder.siteId,
      workAreaId: builder.workAreaId,
      weekStart: builder.weekStart,
      weekEnd: builder.weekEnd,
      days: canonicalDays
    };

    let workedMinutes = 0;
    let grossMinutes = 0;
    let breakMinutes = 0;
    const dayTotals: WeeklyCustomerSliceDayTotal[] = [];
    for (const d of sortedDays) {
      const applied = applyPreallocatedBreak(d.group.segments, d.group.autoUnpaidBreakMinutes);
      workedMinutes += applied.workedMinutes;
      grossMinutes += applied.grossMinutes;
      breakMinutes += applied.breakMinutes;
      dayTotals.push({
        date: d.dateIso,
        grossMinutes: applied.grossMinutes,
        breakMinutes: applied.breakMinutes,
        workedMinutes: applied.workedMinutes,
        autoUnpaidBreakMinutes: d.group.autoUnpaidBreakMinutes
      });
    }

    slices.push({
      logicalKey: {
        employeeId: input.employeeId,
        timesheetId: input.timesheetId,
        siteId: builder.siteId,
        workAreaId: builder.workAreaId,
        weekStart: builder.weekStart,
        weekEnd: builder.weekEnd
      },
      payload,
      fingerprint: computeSliceFingerprint(payload),
      workedMinutes,
      grossMinutes,
      breakMinutes,
      dayTotals
    });
  }

  return slices.sort(
    (a, b) =>
      a.logicalKey.siteId.localeCompare(b.logicalKey.siteId) ||
      (a.logicalKey.workAreaId ?? '').localeCompare(b.logicalKey.workAreaId ?? '') ||
      a.logicalKey.weekStart.localeCompare(b.logicalKey.weekStart)
  );
}
