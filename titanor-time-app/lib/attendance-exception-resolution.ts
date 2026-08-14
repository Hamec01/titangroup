import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { helsinkiCalendarDateAsUtcMidnight } from '@/lib/attendance-clock';
import { actorDisplayName, UUID_PATTERN, type ExceptionTypeFilter } from '@/lib/attendance-exceptions';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5 (resolver pattern) / §9.7
// (CONFIRM_SOURCE_ASSIGNMENT, full algorithm) / §9.8 (PAIR_ORPHAN_EVENTS full validation) / §9.9
// (FORCE_CLOSE_OPEN_SHIFT, full algorithm) / §11 (action matrix) / §12.1/§12.3 — T7A.8B.1 shipped
// DISMISS/ACKNOWLEDGE_AS_VALID; T7A.8B.2 added PAIR_ORPHAN_EVENTS; T7A.8B.3 added
// CONFIRM_SOURCE_ASSIGNMENT; T7A.8B.4A adds FORCE_CLOSE_OPEN_SHIFT (ADMIN/SUPER_ADMIN only —
// FOREMAN is rejected at the route layer, before this module is ever reached for this action,
// same pattern as CONFIRM_SOURCE_ASSIGNMENT). The one remaining action (REASON_EDIT) is
// deliberately not implemented here — see IMPLEMENTED_RESOLUTION_ACTIONS below. Kept in a
// separate file from lib/attendance-exceptions.ts on purpose: that module is read-only (owns
// scope enforcement, filtering, pagination, DTO/redaction for GET); this one owns the mutating
// transactions, with a materially different lock-order/concurrency contract.

export type SimpleResolutionAction = 'DISMISS' | 'ACKNOWLEDGE_AS_VALID';
export type ResolutionAction = SimpleResolutionAction | 'PAIR_ORPHAN_EVENTS' | 'CONFIRM_SOURCE_ASSIGNMENT' | 'FORCE_CLOSE_OPEN_SHIFT';
export const IMPLEMENTED_RESOLUTION_ACTIONS: ResolutionAction[] = ['DISMISS', 'ACKNOWLEDGE_AS_VALID', 'PAIR_ORPHAN_EVENTS', 'CONFIRM_SOURCE_ASSIGNMENT', 'FORCE_CLOSE_OPEN_SHIFT'];

const MAX_RESOLUTION_NOTE_LENGTH = 2000;

// ---------------------------------------------------------------------------------------------
// §11 domain matrix — ALL six actions, including the four not implemented by this endpoint yet.
// Used only to answer ACTION_NOT_APPLICABLE's informational `allowedActions` — never to decide
// whether THIS endpoint accepts a request (IMPLEMENTED_RESOLUTION_ACTIONS/applicability below is
// the sole gate for that, checked earlier in validateResolveRequestBody).
// ---------------------------------------------------------------------------------------------
const DOMAIN_ALLOWED_ACTIONS: Record<ExceptionTypeFilter, string[]> = {
  GPS_NOT_VERIFIED: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  OUTSIDE_GEOFENCE_CHECKOUT: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  SITE_MISMATCH_CHECKOUT: ['ACKNOWLEDGE_AS_VALID', 'DISMISS', 'REASON_EDIT'],
  DOUBLE_CHECK_IN: ['PAIR_ORPHAN_EVENTS', 'DISMISS'],
  CHECKOUT_WITHOUT_OPEN_SHIFT: ['PAIR_ORPHAN_EVENTS', 'DISMISS'],
  STALE_ASSIGNMENT: ['CONFIRM_SOURCE_ASSIGNMENT'],
  GEOFENCE_VERSION_MISMATCH: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  LATE_SYNC_AFTER_SUBMIT: [],
  MISSING_CHECKOUT_AT_CUTOFF: ['FORCE_CLOSE_OPEN_SHIFT', 'DISMISS'],
  EXCESSIVE_CLOCK_SKEW: ['ACKNOWLEDGE_AS_VALID', 'DISMISS', 'REASON_EDIT'],
  CHECKOUT_CHRONOLOGY_ANOMALY: ['REASON_EDIT', 'DISMISS'],
  EXCESSIVE_SHIFT_DURATION: ['ACKNOWLEDGE_AS_VALID', 'DISMISS', 'REASON_EDIT'],
  PERIOD_BOUNDARY_SPAN: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  OVERLAPPING_SHIFT: ['DISMISS', 'REASON_EDIT']
};

const DISMISS_ALLOWED_TYPES = new Set<ExceptionTypeFilter>([
  'GPS_NOT_VERIFIED',
  'OUTSIDE_GEOFENCE_CHECKOUT',
  'SITE_MISMATCH_CHECKOUT',
  'DOUBLE_CHECK_IN',
  'CHECKOUT_WITHOUT_OPEN_SHIFT',
  'GEOFENCE_VERSION_MISMATCH',
  'MISSING_CHECKOUT_AT_CUTOFF', // additionally gated dynamically by EmployeeOpenShift below
  'EXCESSIVE_CLOCK_SKEW',
  'CHECKOUT_CHRONOLOGY_ANOMALY', // additionally requires a non-empty resolutionNote below
  'EXCESSIVE_SHIFT_DURATION',
  'PERIOD_BOUNDARY_SPAN',
  'OVERLAPPING_SHIFT'
]);

const ACKNOWLEDGE_ALLOWED_TYPES = new Set<ExceptionTypeFilter>(['GPS_NOT_VERIFIED', 'OUTSIDE_GEOFENCE_CHECKOUT', 'SITE_MISMATCH_CHECKOUT', 'GEOFENCE_VERSION_MISMATCH', 'EXCESSIVE_CLOCK_SKEW', 'EXCESSIVE_SHIFT_DURATION', 'PERIOD_BOUNDARY_SPAN']);

// §9.8 — PAIR_ORPHAN_EVENTS is applicable only to these two OPEN types (the two "orphan" shapes:
// a second CHECK_IN with no matching CHECK_OUT yet, or a CHECK_OUT with no open shift to close).
const PAIR_ALLOWED_TYPES = new Set<ExceptionTypeFilter>(['DOUBLE_CHECK_IN', 'CHECKOUT_WITHOUT_OPEN_SHIFT']);

function isActionStaticallyApplicable(type: string, action: SimpleResolutionAction): boolean {
  return action === 'DISMISS' ? DISMISS_ALLOWED_TYPES.has(type as ExceptionTypeFilter) : ACKNOWLEDGE_ALLOWED_TYPES.has(type as ExceptionTypeFilter);
}

function isPairApplicable(type: string): boolean {
  return PAIR_ALLOWED_TYPES.has(type as ExceptionTypeFilter);
}

function allowedActionsFor(type: string): string[] {
  return DOMAIN_ALLOWED_ACTIONS[type as ExceptionTypeFilter] ?? [];
}

// ---------------------------------------------------------------------------------------------
// Request body validation — pure, no DB access. Type-dependent rules (chronology note, dynamic
// missing-checkout guard, event/link/scope validation for PAIR) are NOT decidable here (they need
// fetched DB rows) and are re-checked both before opening the transaction and again inside it —
// see resolveAttendanceException / pairOrphanEvents. checkInEventId/checkOutEventId are only
// meaningful for PAIR_ORPHAN_EVENTS — present-but-not-PAIR is a 400, not a silently-ignored field,
// so a stale UI can never send an ambiguous body.
// ---------------------------------------------------------------------------------------------

// Strict ISO-8601 datetime with a MANDATORY explicit UTC designator (`Z` or `+HH:MM`/`-HH:MM`) —
// deliberately stricter than lib/attendance-clock.ts's parseIsoInstant (which feeds `new Date()`
// directly and so silently accepts date-only and timezone-less strings, interpreting the latter as
// local time). FORCE_CLOSE_OPEN_SHIFT needs the stricter form because `explicitEndAt` is a
// human-typed administrative timestamp with real payroll consequences — an ambiguous local-time
// value must be rejected outright, not silently reinterpreted. Not reused/exported elsewhere;
// parseIsoInstant's existing (looser) behavior is left untouched for its existing callers.
const STRICT_ISO_UTC_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function parseStrictIsoInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !STRICT_ISO_UTC_OFFSET_PATTERN.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type ParsedResolveRequest =
  | { ok: true; action: SimpleResolutionAction; resolutionNote: string | null }
  | { ok: true; action: 'PAIR_ORPHAN_EVENTS'; checkInEventId: string; checkOutEventId: string; resolutionNote: string | null }
  | { ok: true; action: 'CONFIRM_SOURCE_ASSIGNMENT'; chosenAssignmentId: string; resolutionNote: string | null }
  | { ok: true; action: 'FORCE_CLOSE_OPEN_SHIFT'; explicitEndAt: Date; reason: string }
  | { ok: false; fieldErrors: Record<string, string[]> };

export function validateResolveRequestBody(raw: unknown): ParsedResolveRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, fieldErrors: { '': ['must be a JSON object'] } };
  }
  const body = raw as Record<string, unknown>;
  const fieldErrors: Record<string, string[]> = {};

  let action: ResolutionAction | null = null;
  if (typeof body.action !== 'string' || body.action.length === 0) {
    fieldErrors.action = ['required'];
  } else if (!IMPLEMENTED_RESOLUTION_ACTIONS.includes(body.action as ResolutionAction)) {
    fieldErrors.action = [`must be one of ${IMPLEMENTED_RESOLUTION_ACTIONS.join(', ')}`];
  } else {
    action = body.action as ResolutionAction;
  }

  let resolutionNote: string | null = null;
  if (body.resolutionNote !== undefined && body.resolutionNote !== null) {
    if (typeof body.resolutionNote !== 'string') {
      fieldErrors.resolutionNote = ['must be a string'];
    } else {
      const trimmed = body.resolutionNote.trim();
      if (trimmed.length > MAX_RESOLUTION_NOTE_LENGTH) {
        fieldErrors.resolutionNote = [`must be at most ${MAX_RESOLUTION_NOTE_LENGTH} characters`];
      } else {
        resolutionNote = trimmed.length > 0 ? trimmed : null; // empty-after-trim counts as absent.
      }
    }
  }

  if (action === 'PAIR_ORPHAN_EVENTS') {
    let checkInEventId: string | null = null;
    let checkOutEventId: string | null = null;
    if (typeof body.checkInEventId !== 'string' || !UUID_PATTERN.test(body.checkInEventId)) {
      fieldErrors.checkInEventId = ['required, must be a UUID'];
    } else {
      checkInEventId = body.checkInEventId;
    }
    if (typeof body.checkOutEventId !== 'string' || !UUID_PATTERN.test(body.checkOutEventId)) {
      fieldErrors.checkOutEventId = ['required, must be a UUID'];
    } else {
      checkOutEventId = body.checkOutEventId;
    }
    if (checkInEventId && checkOutEventId && checkInEventId === checkOutEventId) {
      fieldErrors.checkOutEventId = ['must differ from checkInEventId'];
    }
    if (body.chosenAssignmentId !== undefined) {
      fieldErrors.chosenAssignmentId = ['not allowed for this action'];
    }
    if (body.explicitEndAt !== undefined) {
      fieldErrors.explicitEndAt = ['not allowed for this action'];
    }
    if (body.reason !== undefined) {
      fieldErrors.reason = ['not allowed for this action'];
    }
    if (Object.keys(fieldErrors).length > 0 || !checkInEventId || !checkOutEventId) {
      return { ok: false, fieldErrors };
    }
    return { ok: true, action: 'PAIR_ORPHAN_EVENTS', checkInEventId, checkOutEventId, resolutionNote };
  }

  if (action === 'CONFIRM_SOURCE_ASSIGNMENT') {
    let chosenAssignmentId: string | null = null;
    if (typeof body.chosenAssignmentId !== 'string' || !UUID_PATTERN.test(body.chosenAssignmentId)) {
      fieldErrors.chosenAssignmentId = ['required, must be a UUID'];
    } else {
      chosenAssignmentId = body.chosenAssignmentId;
    }
    if (body.checkInEventId !== undefined) {
      fieldErrors.checkInEventId = ['not allowed for this action'];
    }
    if (body.checkOutEventId !== undefined) {
      fieldErrors.checkOutEventId = ['not allowed for this action'];
    }
    if (body.explicitEndAt !== undefined) {
      fieldErrors.explicitEndAt = ['not allowed for this action'];
    }
    if (body.reason !== undefined) {
      fieldErrors.reason = ['not allowed for this action'];
    }
    if (Object.keys(fieldErrors).length > 0 || !chosenAssignmentId) {
      return { ok: false, fieldErrors };
    }
    return { ok: true, action: 'CONFIRM_SOURCE_ASSIGNMENT', chosenAssignmentId, resolutionNote };
  }

  if (action === 'FORCE_CLOSE_OPEN_SHIFT') {
    // resolutionNote is explicitly FORBIDDEN for this action (not just ignored) — `reason` is the
    // single source of truth for why the shift was force-closed, written to
    // ClockShift.forceClosedReason / AttendanceException.resolutionNote / the audit event alike; a
    // second, independent resolutionNote field would create two possibly-conflicting reasons.
    if (body.resolutionNote !== undefined) {
      fieldErrors.resolutionNote = ['not allowed for this action — use reason instead'];
    }
    if (body.chosenAssignmentId !== undefined) {
      fieldErrors.chosenAssignmentId = ['not allowed for this action'];
    }
    if (body.checkInEventId !== undefined) {
      fieldErrors.checkInEventId = ['not allowed for this action'];
    }
    if (body.checkOutEventId !== undefined) {
      fieldErrors.checkOutEventId = ['not allowed for this action'];
    }

    let explicitEndAt: Date | null = null;
    if (typeof body.explicitEndAt !== 'string') {
      fieldErrors.explicitEndAt = ['required, must be a string'];
    } else {
      explicitEndAt = parseStrictIsoInstant(body.explicitEndAt);
      if (!explicitEndAt) {
        fieldErrors.explicitEndAt = ['must be a strict ISO-8601 timestamp with an explicit UTC offset (Z or +HH:MM/-HH:MM) — date-only and timezone-less values are rejected'];
      }
    }

    let reason: string | null = null;
    if (typeof body.reason !== 'string') {
      fieldErrors.reason = ['required'];
    } else {
      const trimmedReason = body.reason.trim();
      if (trimmedReason.length === 0) {
        fieldErrors.reason = ['required'];
      } else if (trimmedReason.length > MAX_RESOLUTION_NOTE_LENGTH) {
        fieldErrors.reason = [`must be at most ${MAX_RESOLUTION_NOTE_LENGTH} characters`];
      } else {
        reason = trimmedReason;
      }
    }

    if (Object.keys(fieldErrors).length > 0 || !explicitEndAt || !reason) {
      return { ok: false, fieldErrors };
    }
    return { ok: true, action: 'FORCE_CLOSE_OPEN_SHIFT', explicitEndAt, reason };
  }

  if (action === 'DISMISS' || action === 'ACKNOWLEDGE_AS_VALID') {
    if (body.checkInEventId !== undefined) {
      fieldErrors.checkInEventId = ['not allowed for this action'];
    }
    if (body.checkOutEventId !== undefined) {
      fieldErrors.checkOutEventId = ['not allowed for this action'];
    }
    if (body.chosenAssignmentId !== undefined) {
      fieldErrors.chosenAssignmentId = ['not allowed for this action'];
    }
    if (body.explicitEndAt !== undefined) {
      fieldErrors.explicitEndAt = ['not allowed for this action'];
    }
    if (body.reason !== undefined) {
      fieldErrors.reason = ['not allowed for this action'];
    }
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, fieldErrors };
    }
    return { ok: true, action, resolutionNote };
  }

  // action is null (missing/unrecognized) — report whatever field errors were already collected.
  return { ok: false, fieldErrors };
}

// ---------------------------------------------------------------------------------------------
// Foreman mutation scope — stricter than GET's read scope (intersection is enough to SEE a
// sanitized row; mutation requires every provable site to be the caller's own current site).
// ---------------------------------------------------------------------------------------------

export interface ForemanMutationScope {
  foremanUserId: string;
  today: Date;
  excludeEmployeeId: string | null;
}

interface ScopeCarrier {
  employeeId: string;
  siteId: string | null;
  clockEvent: { siteId: string } | null;
  clockShift: { siteId: string } | null;
  clockShiftFragment: { siteId: string } | null;
  relatedClockShift: { siteId: string } | null;
}

function collectScopeSiteIds(row: ScopeCarrier): string[] {
  return [row.siteId, row.clockEvent?.siteId, row.clockShift?.siteId, row.clockShiftFragment?.siteId, row.relatedClockShift?.siteId].filter((id): id is string => !!id);
}

type ScopeCheckOutcome = { kind: 'OK' } | { kind: 'NOT_FOUND' } | { kind: 'FOREMAN_SCOPE_INCOMPLETE' };

/** Core anyOwn/allOwn decision, factored out so PAIR_ORPHAN_EVENTS can reuse it against a UNION of
 * site ids (named exception's own five relations + both selected ClockEvent sites) instead of
 * duplicating the visibility/completeness logic. */
function checkForemanScopeForSiteIds(scopeSiteIds: string[], employeeId: string, ownSiteIds: string[], excludeEmployeeId: string | null): ScopeCheckOutcome {
  if (excludeEmployeeId && employeeId === excludeEmployeeId) {
    return { kind: 'NOT_FOUND' };
  }
  if (scopeSiteIds.length === 0) {
    return { kind: 'NOT_FOUND' }; // no provable site scope at all -- ADMIN only, same as GET.
  }
  const anyOwn = scopeSiteIds.some((id) => ownSiteIds.includes(id));
  if (!anyOwn) {
    return { kind: 'NOT_FOUND' }; // wasn't even visible via GET -- no oracle for foreign exceptions.
  }
  const allOwn = scopeSiteIds.every((id) => ownSiteIds.includes(id));
  if (!allOwn) {
    return { kind: 'FOREMAN_SCOPE_INCOMPLETE' }; // visible via GET, but part of it is a foreign site.
  }
  return { kind: 'OK' };
}

function checkForemanScope(row: ScopeCarrier, ownSiteIds: string[], excludeEmployeeId: string | null): ScopeCheckOutcome {
  return checkForemanScopeForSiteIds(collectScopeSiteIds(row), row.employeeId, ownSiteIds, excludeEmployeeId);
}

/** §6 (task brief) — PAIR's scope is the union of the named exception's own five-relation scope
 * with BOTH selected ClockEvent sites: visibility (anyOwn) is unaffected in a well-formed request
 * (the named exception is already linked to one of the two events, so its own scope already
 * contains at least one of these two site ids), but completeness (allOwn) now additionally
 * requires the OTHER event's site to be the caller's own current site too. */
function checkForemanScopeForPair(namedRow: ScopeCarrier, checkInSiteId: string, checkOutSiteId: string, ownSiteIds: string[], excludeEmployeeId: string | null): ScopeCheckOutcome {
  const scopeSiteIds = [...collectScopeSiteIds(namedRow), checkInSiteId, checkOutSiteId];
  return checkForemanScopeForSiteIds(scopeSiteIds, namedRow.employeeId, ownSiteIds, excludeEmployeeId);
}

// ---------------------------------------------------------------------------------------------
// The mutation
// ---------------------------------------------------------------------------------------------

const PRE_READ_SELECT = {
  employeeId: true,
  type: true,
  status: true,
  siteId: true,
  clockEventId: true,
  clockEvent: { select: { siteId: true } },
  clockShift: { select: { siteId: true } },
  clockShiftFragment: { select: { siteId: true } },
  relatedClockShift: { select: { siteId: true } }
} satisfies Prisma.AttendanceExceptionSelect;

export interface ResolveResult {
  id: string;
  type: string;
  status: 'DISMISSED' | 'RESOLVED';
  resolutionAction: SimpleResolutionAction;
  resolvedAt: string;
  resolvedBy: { id: string; name: string };
  resolutionNote: string | null;
}

export type ResolveOutcome =
  | { kind: 'OK'; result: ResolveResult }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_RESOLVED' }
  | { kind: 'ACTION_NOT_APPLICABLE'; allowedActions: string[] }
  | { kind: 'FOREMAN_SCOPE_INCOMPLETE' }
  | { kind: 'OPEN_SHIFT_STILL_PENDING' }
  | { kind: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

/** §11 CHECKOUT_CHRONOLOGY_ANOMALY: DISMISS requires a non-empty resolutionNote that explicitly
 * records acceptance of the provisional end time. */
function chronologyNoteError(type: string, action: SimpleResolutionAction, resolutionNote: string | null): ResolveOutcome | null {
  if (action === 'DISMISS' && type === 'CHECKOUT_CHRONOLOGY_ANOMALY' && !resolutionNote) {
    return { kind: 'VALIDATION_ERROR', fieldErrors: { resolutionNote: ['required when dismissing CHECKOUT_CHRONOLOGY_ANOMALY'] } };
  }
  return null;
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5 resolver pattern, literally:
 *   Read-only: exceptionId -> employeeId, no lock.
 *   Transaction: Employee FOR UPDATE -> AttendanceException FOR UPDATE -> re-check status/type/
 *   scope -> single UPDATE -> one AuditEvent -> COMMIT.
 * `scope === null` means ADMIN/SUPER_ADMIN (no site restriction). Any outcome other than 'OK'
 * that is discovered INSIDE the transaction still lets the transaction commit normally (nothing
 * was ever written, so there is nothing to roll back) rather than throwing.
 */
export async function resolveAttendanceException(exceptionId: string, action: SimpleResolutionAction, resolutionNote: string | null, actorUserId: string, scope: ForemanMutationScope | null, requestId: string): Promise<ResolveOutcome> {
  const pre = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: PRE_READ_SELECT });
  if (!pre) {
    return { kind: 'NOT_FOUND' };
  }

  if (scope) {
    const preOwnSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today);
    const scopeCheck = checkForemanScope(pre, preOwnSiteIds, scope.excludeEmployeeId);
    if (scopeCheck.kind !== 'OK') {
      return scopeCheck;
    }
  }

  if (pre.status !== 'OPEN') {
    return { kind: 'ALREADY_RESOLVED' };
  }
  if (!isActionStaticallyApplicable(pre.type, action)) {
    return { kind: 'ACTION_NOT_APPLICABLE', allowedActions: allowedActionsFor(pre.type) };
  }
  const preNoteError = chronologyNoteError(pre.type, action, resolutionNote);
  if (preNoteError) {
    return preNoteError;
  }

  return prisma.$transaction(async (tx) => {
    // Canonical order (§8.1): Employee(1) before AttendanceException(7) — never the reverse.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${pre.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AttendanceException" WHERE id = ${exceptionId}::uuid FOR UPDATE`;

    const fresh = await tx.attendanceException.findUnique({ where: { id: exceptionId }, select: PRE_READ_SELECT });
    if (!fresh) {
      return { kind: 'NOT_FOUND' as const };
    }

    if (scope) {
      // Re-derived from the SAME tx client, not the pre-read's snapshot — an expired/added
      // ForemanAssignment between pre-read and here must change the outcome (§10 concurrency #3).
      const freshOwnSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today, tx);
      const scopeCheck = checkForemanScope(fresh, freshOwnSiteIds, scope.excludeEmployeeId);
      if (scopeCheck.kind !== 'OK') {
        return scopeCheck;
      }
    }

    if (fresh.status !== 'OPEN') {
      return { kind: 'ALREADY_RESOLVED' as const };
    }
    if (!isActionStaticallyApplicable(fresh.type, action)) {
      return { kind: 'ACTION_NOT_APPLICABLE' as const, allowedActions: allowedActionsFor(fresh.type) };
    }
    const noteError = chronologyNoteError(fresh.type, action, resolutionNote);
    if (noteError) {
      return noteError;
    }

    if (action === 'DISMISS' && fresh.type === 'MISSING_CHECKOUT_AT_CUTOFF' && fresh.clockEventId) {
      // §11 MISSING_CHECKOUT_AT_CUTOFF: DISMISS only if THIS exception's originating shift (the
      // one whose CHECK_IN is fresh.clockEventId) is not still the employee's open shift — a
      // later, unrelated Check In would create a NEW EmployeeOpenShift row that must not block
      // dismissal of an exception about a DIFFERENT, already-closed shift.
      const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId: fresh.employeeId }, select: { openedByClockEventId: true } });
      if (openShift && openShift.openedByClockEventId === fresh.clockEventId) {
        return { kind: 'OPEN_SHIFT_STILL_PENDING' as const };
      }
    }

    const newStatus: 'DISMISSED' | 'RESOLVED' = action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED';
    const resolvedAt = new Date();

    // §11 OVERLAPPING_SHIFT DISMISS: only status/resolvedBy/resolvedAt/resolutionNote change —
    // overlapEndedAt is left untouched (still NULL), never written by this action. The existing
    // resolveOverlapTransition (lib/attendance-reported-projection.ts) already handles filling it
    // in later without touching these human-authored fields (docs §11, test #106).
    await tx.attendanceException.update({
      where: { id: exceptionId },
      data: { status: newStatus, resolvedByUserId: actorUserId, resolvedAt, resolutionNote }
    });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: action === 'DISMISS' ? 'ATTENDANCE_EXCEPTION_DISMISSED' : 'ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID',
      entityType: 'ATTENDANCE_EXCEPTION',
      entityId: exceptionId,
      requestId,
      beforeValue: { status: fresh.status, type: fresh.type },
      afterValue: { status: newStatus, resolutionAction: action },
      reason: resolutionNote
    });

    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorUserId }, select: { username: true, employee: { select: { firstName: true, lastName: true } } } });

    return {
      kind: 'OK' as const,
      result: {
        id: exceptionId,
        type: fresh.type,
        status: newStatus,
        resolutionAction: action,
        resolvedAt: resolvedAt.toISOString(),
        resolvedBy: { id: actorUserId, name: actorDisplayName(actor) },
        resolutionNote
      }
    };
  });
}

// ---------------------------------------------------------------------------------------------
// PAIR_ORPHAN_EVENTS (§9.8) — a materially different mutation from DISMISS/ACK: it creates a new
// ClockShift from two already-existing, immutable ClockEvent rows instead of only flipping the
// named exception's own status. Kept as its own function/outcome type rather than folded into
// resolveAttendanceException above, since the request/response contract, applicability set, and
// transaction steps are all genuinely different — sharing would mean threading PAIR-only branches
// through code whose DISMISS/ACK behavior is already tested and must not regress.
// ---------------------------------------------------------------------------------------------

const CLOCK_EVENT_SELECT = {
  id: true,
  operationType: true,
  employeeId: true,
  siteId: true,
  workAreaId: true,
  sourceAssignmentId: true,
  effectiveAt: true
} satisfies Prisma.ClockEventSelect;

type ClockEventRow = Prisma.ClockEventGetPayload<{ select: typeof CLOCK_EVENT_SELECT }>;

export interface PairClockShiftResult {
  id: string;
  employeeId: string;
  checkInEventId: string;
  checkOutEventId: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string | null;
  recordedStartAt: string;
  recordedEndAt: string;
  materializationState: string;
}

export interface PairResolvedExceptionSummary {
  id: string;
  type: string;
  status: 'RESOLVED';
}

export interface PairResult {
  resolutionAction: 'PAIR_ORPHAN_EVENTS';
  clockShift: PairClockShiftResult;
  resolvedExceptions: PairResolvedExceptionSummary[];
  resolvedAt: string;
  resolvedBy: { id: string; name: string };
  resolutionNote: string | null;
}

export type PairOutcome =
  | { kind: 'CREATED'; result: PairResult }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_RESOLVED' }
  | { kind: 'ACTION_NOT_APPLICABLE'; allowedActions: string[] }
  | { kind: 'FOREMAN_SCOPE_INCOMPLETE' }
  | { kind: 'CLOCK_EVENT_NOT_FOUND' }
  | { kind: 'EVENT_ALREADY_PAIRED' }
  | { kind: 'PAIRED_SHIFT_OVERLAP' }
  | { kind: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

/** §9.8 steps a-d, re-run verbatim both pre-transaction and inside it. ClockEvent rows are
 * immutable (never updated after creation, enforced by trg_clock_shift's own design and simply by
 * there being no UPDATE code path for ClockEvent anywhere in this codebase) — the SAME already-
 * fetched row objects are reused for the in-transaction re-check rather than re-querying, since
 * re-querying could only ever return byte-identical values. What CAN change between the two calls
 * is the named exception's status (checked separately by the caller) — this function only re-runs
 * the parts that depend on the (invariant) event data plus the (mutable) named exception's type.
 */
function validateEventPair(checkInEvent: ClockEventRow, checkOutEvent: ClockEventRow, named: { type: string; employeeId: string; clockEventId: string | null }): { fieldErrors: Record<string, string[]> } | null {
  const fieldErrors: Record<string, string[]> = {};
  if (checkInEvent.operationType !== 'CHECK_IN') {
    fieldErrors.checkInEventId = ['must reference a CHECK_IN event'];
  }
  if (checkOutEvent.operationType !== 'CHECK_OUT') {
    fieldErrors.checkOutEventId = ['must reference a CHECK_OUT event'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  if (checkInEvent.employeeId !== checkOutEvent.employeeId) {
    return { fieldErrors: { checkInEventId: ['does not belong to the same employee as checkOutEventId'], checkOutEventId: ['does not belong to the same employee as checkInEventId'] } };
  }
  if (checkInEvent.employeeId !== named.employeeId) {
    // §9.8 / task §3 "нельзя использовать видимое orphan exception как authorization anchor для
    // произвольной пары другого работника" — the events must belong to the SAME employee this
    // exception belongs to, not just to each other.
    return { fieldErrors: { checkInEventId: ['does not belong to the same employee as this exception'], checkOutEventId: ['does not belong to the same employee as this exception'] } };
  }
  if (!(checkOutEvent.effectiveAt.getTime() > checkInEvent.effectiveAt.getTime())) {
    // No chronology clamp here (§9.2's clamp is for automatic Check Out only) — a manual pair with
    // broken chronology is rejected outright; the resolver must pick a plausible pair.
    return { fieldErrors: { checkOutEventId: ['must be chronologically after checkInEventId'] } };
  }
  if (named.type === 'DOUBLE_CHECK_IN' && named.clockEventId !== checkInEvent.id) {
    return { fieldErrors: { checkInEventId: ['does not match this exception'] } };
  }
  if (named.type === 'CHECKOUT_WITHOUT_OPEN_SHIFT' && named.clockEventId !== checkOutEvent.id) {
    return { fieldErrors: { checkOutEventId: ['does not match this exception'] } };
  }
  return null;
}

function complementaryTypeAndEventId(namedType: string, checkInEventId: string, checkOutEventId: string): { type: 'DOUBLE_CHECK_IN' | 'CHECKOUT_WITHOUT_OPEN_SHIFT'; clockEventId: string } | null {
  if (namedType === 'DOUBLE_CHECK_IN') {
    return { type: 'CHECKOUT_WITHOUT_OPEN_SHIFT', clockEventId: checkOutEventId };
  }
  if (namedType === 'CHECKOUT_WITHOUT_OPEN_SHIFT') {
    return { type: 'DOUBLE_CHECK_IN', clockEventId: checkInEventId };
  }
  return null;
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.8, literally. Read-only pre-checks (a-e in
 * the design doc) run unlocked for fast rejection, then the transaction re-verifies everything
 * that could have changed since (named exception status/scope — ClockEvent rows cannot change at
 * all, so they are not re-queried, only re-validated against the fresh named exception).
 *
 * Lock order: Employee FOR UPDATE first (both events' shared employeeId), THEN the named
 * AttendanceException FOR UPDATE, THEN — queried fresh only after Employee is held, so the result
 * is race-free for the rest of this transaction — the complementary OPEN exception (if any) is
 * located and locked too. No second transaction touching either row can be concurrently in-flight
 * at that point: AttendanceException rows are single-employee-owned, and every resolver-form
 * transaction in this codebase locks that SAME Employee row before touching any of its exceptions,
 * so holding it here already fully serializes every other resolution attempt for this employee —
 * the two exception locks never need a separate canonical sub-order between themselves.
 */
export async function pairOrphanEvents(exceptionId: string, checkInEventId: string, checkOutEventId: string, resolutionNote: string | null, actorUserId: string, scope: ForemanMutationScope | null, requestId: string): Promise<PairOutcome> {
  const named = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: PRE_READ_SELECT });
  if (!named) {
    return { kind: 'NOT_FOUND' };
  }

  // Base visibility (named exception's OWN scope only) must be checked before touching event data
  // at all — an invisible exception must never differentiate its error response based on whatever
  // event ids happen to be supplied.
  if (scope) {
    const preOwnSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today);
    const baseVisibility = checkForemanScope(named, preOwnSiteIds, scope.excludeEmployeeId);
    if (baseVisibility.kind !== 'OK' && baseVisibility.kind !== 'FOREMAN_SCOPE_INCOMPLETE') {
      return baseVisibility; // NOT_FOUND
    }
  }

  if (named.status !== 'OPEN') {
    return { kind: 'ALREADY_RESOLVED' };
  }
  if (!isPairApplicable(named.type)) {
    return { kind: 'ACTION_NOT_APPLICABLE', allowedActions: allowedActionsFor(named.type) };
  }

  const [checkInEvent, checkOutEvent] = await Promise.all([
    prisma.clockEvent.findUnique({ where: { id: checkInEventId }, select: CLOCK_EVENT_SELECT }),
    prisma.clockEvent.findUnique({ where: { id: checkOutEventId }, select: CLOCK_EVENT_SELECT })
  ]);
  if (!checkInEvent || !checkOutEvent) {
    return { kind: 'CLOCK_EVENT_NOT_FOUND' };
  }

  const eventError = validateEventPair(checkInEvent, checkOutEvent, named);
  if (eventError) {
    return { kind: 'VALIDATION_ERROR', fieldErrors: eventError.fieldErrors };
  }

  if (scope) {
    const preOwnSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today);
    const fullScope = checkForemanScopeForPair(named, checkInEvent.siteId, checkOutEvent.siteId, preOwnSiteIds, scope.excludeEmployeeId);
    if (fullScope.kind !== 'OK') {
      return fullScope; // NOT_FOUND (shouldn't recur here) or FOREMAN_SCOPE_INCOMPLETE
    }
  }

  const complementary = complementaryTypeAndEventId(named.type, checkInEventId, checkOutEventId);

  return prisma.$transaction(async (tx) => {
    // Canonical order (§8.1): Employee(1) before AttendanceException(7) — never the reverse.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${checkInEvent.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AttendanceException" WHERE id = ${exceptionId}::uuid FOR UPDATE`;

    const fresh = await tx.attendanceException.findUnique({ where: { id: exceptionId }, select: PRE_READ_SELECT });
    if (!fresh) {
      return { kind: 'NOT_FOUND' as const };
    }

    if (scope) {
      const freshOwnSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today, tx);
      const scopeCheck = checkForemanScopeForPair(fresh, checkInEvent.siteId, checkOutEvent.siteId, freshOwnSiteIds, scope.excludeEmployeeId);
      if (scopeCheck.kind !== 'OK') {
        return scopeCheck;
      }
    }

    if (fresh.status !== 'OPEN') {
      return { kind: 'ALREADY_RESOLVED' as const };
    }
    if (!isPairApplicable(fresh.type)) {
      return { kind: 'ACTION_NOT_APPLICABLE' as const, allowedActions: allowedActionsFor(fresh.type) };
    }
    const revalidation = validateEventPair(checkInEvent, checkOutEvent, fresh);
    if (revalidation) {
      return { kind: 'VALIDATION_ERROR' as const, fieldErrors: revalidation.fieldErrors };
    }

    // Employee is now held — a fresh lookup for the complementary OPEN exception is race-free for
    // the remainder of this transaction (nothing else touching this employee's exceptions can be
    // concurrently in flight). Lock it too, if found, before doing any further reads/writes.
    let complementaryRow: { id: string; type: string } | null = null;
    if (complementary) {
      const candidate = await tx.attendanceException.findFirst({
        where: { type: complementary.type, clockEventId: complementary.clockEventId, status: 'OPEN' },
        select: { id: true, type: true }
      });
      if (candidate) {
        await tx.$queryRaw`SELECT id FROM "AttendanceException" WHERE id = ${candidate.id}::uuid FOR UPDATE`;
        complementaryRow = candidate;
      }
    }

    // §9.8 step 3 / task §5 — explicit precheck before INSERT, not relying only on the UNIQUE
    // constraint (defense-in-depth for races/future bugs, but the real, stable error code here).
    const reused = await tx.clockShift.findFirst({
      where: { OR: [{ checkInEventId: { in: [checkInEventId, checkOutEventId] } }, { checkOutEventId: { in: [checkInEventId, checkOutEventId] } }] },
      select: { id: true }
    });
    if (reused) {
      return { kind: 'EVENT_ALREADY_PAIRED' as const };
    }

    // §9.8 step 4 — tstzrange's default bounds are '[)' (inclusive-start/exclusive-end), so `&&`
    // already treats an exact end===start touch as NON-overlapping, matching the half-open
    // requirement without any bound override.
    const overlap = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ClockShift"
      WHERE "employeeId" = ${checkInEvent.employeeId}::uuid
        AND tstzrange("recordedStartAt", "recordedEndAt") && tstzrange(${checkInEvent.effectiveAt}::timestamptz, ${checkOutEvent.effectiveAt}::timestamptz)
      LIMIT 1
    `;
    if (overlap.length > 0) {
      return { kind: 'PAIRED_SHIFT_OVERLAP' as const };
    }

    const newShift = await tx.clockShift.create({
      data: {
        employeeId: checkInEvent.employeeId,
        checkInEventId,
        checkOutEventId,
        siteId: checkInEvent.siteId,
        workAreaId: checkInEvent.workAreaId,
        sourceAssignmentId: checkInEvent.sourceAssignmentId,
        recordedStartAt: checkInEvent.effectiveAt,
        recordedEndAt: checkOutEvent.effectiveAt,
        endAtProvisional: false,
        materializationState: 'PENDING'
      }
    });

    const resolvedAt = new Date();
    const toResolve: { id: string; type: string }[] = [{ id: exceptionId, type: fresh.type }];
    if (complementaryRow) {
      toResolve.push(complementaryRow);
    }
    toResolve.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const row of toResolve) {
      await tx.attendanceException.update({
        where: { id: row.id },
        data: { status: 'RESOLVED', resolvedByUserId: actorUserId, resolvedAt, resolutionNote, clockShiftId: newShift.id }
      });
    }

    const resolvedExceptionIds = toResolve.map((r) => r.id);
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'ATTENDANCE_EXCEPTION_PAIRED',
      entityType: 'ATTENDANCE_EXCEPTION',
      entityId: exceptionId,
      requestId,
      beforeValue: { status: 'OPEN', type: fresh.type },
      afterValue: { status: 'RESOLVED', resolutionAction: 'PAIR_ORPHAN_EVENTS', clockShiftId: newShift.id, resolvedExceptionIds },
      reason: resolutionNote
    });

    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorUserId }, select: { username: true, employee: { select: { firstName: true, lastName: true } } } });

    return {
      kind: 'CREATED' as const,
      result: {
        resolutionAction: 'PAIR_ORPHAN_EVENTS' as const,
        clockShift: {
          id: newShift.id,
          employeeId: newShift.employeeId,
          checkInEventId: newShift.checkInEventId,
          checkOutEventId: newShift.checkOutEventId as string,
          siteId: newShift.siteId,
          workAreaId: newShift.workAreaId,
          sourceAssignmentId: newShift.sourceAssignmentId,
          recordedStartAt: newShift.recordedStartAt.toISOString(),
          recordedEndAt: newShift.recordedEndAt.toISOString(),
          materializationState: newShift.materializationState
        },
        resolvedExceptions: toResolve.map((r) => ({ id: r.id, type: r.type, status: 'RESOLVED' as const })),
        resolvedAt: resolvedAt.toISOString(),
        resolvedBy: { id: actorUserId, name: actorDisplayName(actor) },
        resolutionNote
      }
    };
  });
}

// ---------------------------------------------------------------------------------------------
// CONFIRM_SOURCE_ASSIGNMENT (§9.7) — ADMIN/SUPER_ADMIN only (enforced at the route layer; this
// function never receives a foreman scope and is never called by the foreman route at all, so it
// carries no scope parameter). Applicable only to STALE_ASSIGNMENT, which has no other allowed
// action (§11) — leaving one permanently un-materializable would strand the shift forever.
// Materialization is intentionally NOT triggered inline here (§9.7 step 9): the next periodic
// materializer catch-up pass (§8.4) picks up the now-resolvable fragment/shift on its own.
// ---------------------------------------------------------------------------------------------

export type ConfirmTargetType = 'EMPLOYEE_OPEN_SHIFT' | 'CLOCK_SHIFT' | 'CLOCK_SHIFT_FRAGMENT';

export interface ConfirmResult {
  resolutionAction: 'CONFIRM_SOURCE_ASSIGNMENT';
  target: { type: ConfirmTargetType; id: string; sourceAssignmentId: string };
  resolvedAt: string;
  resolvedBy: { id: string; name: string };
  resolutionNote: string | null;
}

export type ConfirmOutcome =
  | { kind: 'OK'; result: ConfirmResult }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_RESOLVED' }
  | { kind: 'ACTION_NOT_APPLICABLE'; allowedActions: string[] }
  | { kind: 'TARGET_NOT_FOUND' }
  | { kind: 'TARGET_ALREADY_RESOLVED' }
  | { kind: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

const CONFIRM_PRE_READ_SELECT = {
  employeeId: true,
  type: true,
  status: true,
  clockEventId: true,
  clockShiftId: true,
  clockShiftFragmentId: true
} satisfies Prisma.AttendanceExceptionSelect;

type ConfirmPreRead = Prisma.AttendanceExceptionGetPayload<{ select: typeof CONFIRM_PRE_READ_SELECT }>;

function isConfirmApplicable(type: string): boolean {
  return type === 'STALE_ASSIGNMENT';
}

interface LockedTarget {
  type: ConfirmTargetType;
  id: string;
  siteId: string;
  targetDate: Date;
  sourceAssignmentId: string | null;
}

/**
 * §9.7 step 4 — exactly one of the three FK columns on the exception determines the target,
 * mutually exclusively, checked in this fixed order. For the clockEventId branch: if the shift is
 * still open (EmployeeOpenShift row still points at this exact check-in event), that row IS the
 * target; otherwise the shift has since closed for real (a genuine Check Out raced ahead of this
 * resolution) and the graceful fallback is the resulting ClockShift, located by its checkInEventId
 * — the EmployeeOpenShift row itself is not kept as a long-lived pointer once a shift closes
 * (§2.1), so there is nothing further to look up if neither matches.
 */
async function lockConfirmTarget(tx: Prisma.TransactionClient, fresh: ConfirmPreRead): Promise<LockedTarget | null> {
  if (fresh.clockShiftFragmentId) {
    const rows = await tx.$queryRaw<{ id: string; siteId: string; date: Date; sourceAssignmentId: string | null }[]>`
      SELECT id, "siteId", date, "sourceAssignmentId" FROM "ClockShiftFragment" WHERE id = ${fresh.clockShiftFragmentId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { type: 'CLOCK_SHIFT_FRAGMENT', id: row.id, siteId: row.siteId, targetDate: row.date, sourceAssignmentId: row.sourceAssignmentId };
  }

  if (fresh.clockShiftId) {
    const rows = await tx.$queryRaw<{ id: string; siteId: string; recordedStartAt: Date; sourceAssignmentId: string | null }[]>`
      SELECT id, "siteId", "recordedStartAt", "sourceAssignmentId" FROM "ClockShift" WHERE id = ${fresh.clockShiftId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return { type: 'CLOCK_SHIFT', id: row.id, siteId: row.siteId, targetDate: helsinkiCalendarDateAsUtcMidnight(row.recordedStartAt), sourceAssignmentId: row.sourceAssignmentId };
  }

  if (fresh.clockEventId) {
    const openRows = await tx.$queryRaw<{ id: string; siteId: string; openedAt: Date; sourceAssignmentId: string | null }[]>`
      SELECT id, "siteId", "openedAt", "sourceAssignmentId" FROM "EmployeeOpenShift"
      WHERE "employeeId" = ${fresh.employeeId}::uuid AND "openedByClockEventId" = ${fresh.clockEventId}::uuid
      FOR UPDATE
    `;
    const openRow = openRows[0];
    if (openRow) {
      return { type: 'EMPLOYEE_OPEN_SHIFT', id: openRow.id, siteId: openRow.siteId, targetDate: helsinkiCalendarDateAsUtcMidnight(openRow.openedAt), sourceAssignmentId: openRow.sourceAssignmentId };
    }

    const shiftRows = await tx.$queryRaw<{ id: string; siteId: string; recordedStartAt: Date; sourceAssignmentId: string | null }[]>`
      SELECT id, "siteId", "recordedStartAt", "sourceAssignmentId" FROM "ClockShift" WHERE "checkInEventId" = ${fresh.clockEventId}::uuid FOR UPDATE
    `;
    const shiftRow = shiftRows[0];
    if (shiftRow) {
      return { type: 'CLOCK_SHIFT', id: shiftRow.id, siteId: shiftRow.siteId, targetDate: helsinkiCalendarDateAsUtcMidnight(shiftRow.recordedStartAt), sourceAssignmentId: shiftRow.sourceAssignmentId };
    }
    return null;
  }

  return null;
}

/**
 * §9.7 step 5 — server-side re-check inside the transaction, never trusted from the client
 * beyond its UUID shape (already checked in validateResolveRequestBody). No workAreaId filter —
 * §9.7 does not gate on it, unlike the online check-in path's resolveActiveSiteAssignment.
 *
 * `FOR SHARE`, not a plain `SELECT` (T7A.8B.3 follow-up fix, review-found race): without a lock,
 * a concurrent `POST /api/admin/assignments/:assignmentId/end` (`app/api/admin/assignments/
 * [assignmentId]/end/route.ts`) could shrink this exact row's `validTo` between this read and this
 * transaction's `COMMIT`, letting CONFIRM durably attach a `sourceAssignmentId` that is already
 * stale by the time anyone can observe the result. `FOR SHARE` (not `FOR UPDATE`) because this
 * transaction only ever READS the assignment — it never writes to `SiteAssignment` itself — so a
 * shared lock is the minimal strength that still conflicts with `end`'s implicit row-level `UPDATE`
 * lock: whichever transaction reaches this row first is serialized ahead of the other, and the
 * loser re-reads the row's actual post-commit values once granted (not a stale snapshot — plain
 * `SELECT`/`UPDATE` under READ COMMITTED, this codebase's default, always re-reads after a lock
 * wait). Deadlock-freedom: `SiteAssignment` has no position in the §8.1 canonical order table at
 * all, and none of `end`/the plain `PATCH`/`split`/`promote` assignment-mutation routes ever touch
 * `Employee`/`AttendanceException`/any clock-shift table — each of those transactions only ever
 * locks `SiteAssignment` row(s) (verified directly in all four route files). This lock is therefore
 * acquired strictly AFTER Employee(1)/AttendanceException(7)/target in THIS transaction and is
 * never waited on BY a transaction that could in turn be held up by something CONFIRM already
 * holds — a one-directional edge, not a cycle.
 */
async function isChosenAssignmentValid(tx: Prisma.TransactionClient, employeeId: string, chosenAssignmentId: string, targetSiteId: string, targetDate: Date): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string; employeeId: string; siteId: string; validFrom: Date; validTo: Date | null }[]>`
    SELECT id, "employeeId", "siteId", "validFrom", "validTo" FROM "SiteAssignment"
    WHERE id = ${chosenAssignmentId}::uuid
    FOR SHARE
  `;
  const row = rows[0];
  if (!row) {
    return false;
  }
  if (row.employeeId !== employeeId || row.siteId !== targetSiteId) {
    return false;
  }
  if (row.validFrom.getTime() > targetDate.getTime()) {
    return false;
  }
  if (row.validTo !== null && row.validTo.getTime() < targetDate.getTime()) {
    return false;
  }
  return true;
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.7, literally:
 *   Read-only: exceptionId -> employeeId, no lock.
 *   Transaction: Employee FOR UPDATE -> AttendanceException FOR UPDATE -> re-check status/type ->
 *   lock target (EmployeeOpenShift/ClockShift/ClockShiftFragment, exactly one, by FK) -> validate
 *   chosenAssignmentId against target's siteId/date -> UPDATE target.sourceAssignmentId (NULL ->
 *   value only; a target whose sourceAssignmentId is already set is rejected by a service-level
 *   precheck before any UPDATE is attempted, not left to the DB trigger alone) -> RESOLVE
 *   exception -> one AuditEvent -> COMMIT. No FOREMAN_SCOPE_INCOMPLETE case exists here (unlike
 *   resolveAttendanceException/pairOrphanEvents) — this action is never reachable with a foreman
 *   scope at all, since the foreman route rejects it with 403 before calling this function.
 */
export async function confirmSourceAssignment(exceptionId: string, chosenAssignmentId: string, resolutionNote: string | null, actorUserId: string, requestId: string): Promise<ConfirmOutcome> {
  const pre = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: CONFIRM_PRE_READ_SELECT });
  if (!pre) {
    return { kind: 'NOT_FOUND' };
  }
  if (pre.status !== 'OPEN') {
    return { kind: 'ALREADY_RESOLVED' };
  }
  if (!isConfirmApplicable(pre.type)) {
    return { kind: 'ACTION_NOT_APPLICABLE', allowedActions: allowedActionsFor(pre.type) };
  }

  return prisma.$transaction(async (tx) => {
    // Canonical order (§8.1): Employee(1) before AttendanceException(7) — never the reverse. The
    // target lock that follows (EmployeeOpenShift/ClockShift/ClockShiftFragment, positions 3/4)
    // comes AFTER AttendanceException here — the one documented exception to strict ascending
    // order for resolver-form transactions (§8.5: "no more than one additional row at position 3"
    // for actions other than REASON_EDIT), proven safe there, not re-derived here.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${pre.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AttendanceException" WHERE id = ${exceptionId}::uuid FOR UPDATE`;

    const fresh = await tx.attendanceException.findUnique({ where: { id: exceptionId }, select: CONFIRM_PRE_READ_SELECT });
    if (!fresh) {
      return { kind: 'NOT_FOUND' as const };
    }
    if (fresh.status !== 'OPEN') {
      return { kind: 'ALREADY_RESOLVED' as const };
    }
    if (!isConfirmApplicable(fresh.type)) {
      return { kind: 'ACTION_NOT_APPLICABLE' as const, allowedActions: allowedActionsFor(fresh.type) };
    }

    const target = await lockConfirmTarget(tx, fresh);
    if (!target) {
      return { kind: 'TARGET_NOT_FOUND' as const };
    }
    if (target.sourceAssignmentId !== null) {
      return { kind: 'TARGET_ALREADY_RESOLVED' as const };
    }

    const assignmentValid = await isChosenAssignmentValid(tx, fresh.employeeId, chosenAssignmentId, target.siteId, target.targetDate);
    if (!assignmentValid) {
      // Deliberately generic — never distinguishes "wrong employee" from "wrong site" from
      // "out-of-date-range" from "doesn't exist at all" (§4 "не раскрывать данные чужого
      // employee/site").
      return { kind: 'VALIDATION_ERROR' as const, fieldErrors: { chosenAssignmentId: ['must reference an active SiteAssignment for this employee, site, and date'] } };
    }

    if (target.type === 'CLOCK_SHIFT_FRAGMENT') {
      await tx.clockShiftFragment.update({ where: { id: target.id }, data: { sourceAssignmentId: chosenAssignmentId } });
    } else if (target.type === 'CLOCK_SHIFT') {
      await tx.clockShift.update({ where: { id: target.id }, data: { sourceAssignmentId: chosenAssignmentId } });
    } else {
      await tx.employeeOpenShift.update({ where: { employeeId: fresh.employeeId }, data: { sourceAssignmentId: chosenAssignmentId } });
    }

    const resolvedAt = new Date();
    await tx.attendanceException.update({
      where: { id: exceptionId },
      data: { status: 'RESOLVED', resolvedByUserId: actorUserId, resolvedAt, resolutionNote }
    });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CLOCK_SHIFT_ASSIGNMENT_RESOLVED',
      entityType: 'ATTENDANCE_EXCEPTION',
      entityId: exceptionId,
      requestId,
      beforeValue: { status: 'OPEN', type: fresh.type, targetType: target.type, targetId: target.id },
      afterValue: { status: 'RESOLVED', resolutionAction: 'CONFIRM_SOURCE_ASSIGNMENT', targetType: target.type, targetId: target.id, chosenAssignmentId },
      reason: resolutionNote
    });

    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorUserId }, select: { username: true, employee: { select: { firstName: true, lastName: true } } } });

    return {
      kind: 'OK' as const,
      result: {
        resolutionAction: 'CONFIRM_SOURCE_ASSIGNMENT' as const,
        target: { type: target.type, id: target.id, sourceAssignmentId: chosenAssignmentId },
        resolvedAt: resolvedAt.toISOString(),
        resolvedBy: { id: actorUserId, name: actorDisplayName(actor) },
        resolutionNote
      }
    };
  });
}

// ---------------------------------------------------------------------------------------------
// FORCE_CLOSE_OPEN_SHIFT (§9.9) — ADMIN/SUPER_ADMIN only (enforced at the route layer, same
// pattern as CONFIRM_SOURCE_ASSIGNMENT; this function carries no scope parameter and is never
// called by the foreman route). Applicable only to MISSING_CHECKOUT_AT_CUTOFF. Unlike
// CONFIRM_SOURCE_ASSIGNMENT (which resolves one of three possible target shapes), the target here
// is always exactly the EmployeeOpenShift that this exception's own clockEventId opened — never a
// newer, unrelated open shift, and never a fallback to an already-closed ClockShift (there is
// nothing to "gracefully fall back" to: if the originating shift already closed for real, this
// action simply no longer applies — the client is told to DISMISS instead, per §11/§9.9). No
// ClockEvent is created by this action — the raw device-fact table stays honest; the fact that no
// real Check Out ever arrived, and that a human administratively supplied a time instead, lives
// only on ClockShift.forceClosed* (§9.9 prose, verbatim).
// ---------------------------------------------------------------------------------------------

export interface ForceCloseClockShiftResult {
  id: string;
  employeeId: string;
  checkInEventId: string;
  checkOutEventId: null;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string | null;
  recordedStartAt: string;
  recordedEndAt: string;
  endAtProvisional: false;
  forceClosedByUserId: string;
  forceClosedReason: string;
  forceClosedAt: string;
  materializationState: string;
}

export interface ForceCloseResult {
  resolutionAction: 'FORCE_CLOSE_OPEN_SHIFT';
  clockShift: ForceCloseClockShiftResult;
  resolvedAt: string;
  resolvedBy: { id: string; name: string };
  resolutionNote: string;
}

export type ForceCloseOutcome =
  | { kind: 'CREATED'; result: ForceCloseResult }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_RESOLVED' }
  | { kind: 'ACTION_NOT_APPLICABLE'; allowedActions: string[] }
  | { kind: 'OPEN_SHIFT_ALREADY_CLOSED' }
  | { kind: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

const FORCE_CLOSE_PRE_READ_SELECT = {
  employeeId: true,
  type: true,
  status: true,
  clockEventId: true
} satisfies Prisma.AttendanceExceptionSelect;

type ForceClosePreRead = Prisma.AttendanceExceptionGetPayload<{ select: typeof FORCE_CLOSE_PRE_READ_SELECT }>;

function isForceCloseApplicable(type: string): boolean {
  return type === 'MISSING_CHECKOUT_AT_CUTOFF';
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.9, literally:
 *   Read-only: exceptionId -> employeeId. type must be MISSING_CHECKOUT_AT_CUTOFF.
 *   Transaction: Employee FOR UPDATE -> AttendanceException FOR UPDATE -> re-check status/type ->
 *   EmployeeOpenShift FOR UPDATE by employeeId, then verified to be the SAME shift this exception
 *   was raised about (openedByClockEventId === exception.clockEventId) -> re-check
 *   explicitEndAt > openedAt under lock -> INSERT ClockShift(force-closed shape) -> DELETE
 *   EmployeeOpenShift -> RESOLVE exception -> one AuditEvent -> COMMIT.
 *
 * Target identity (task brief §3, a refinement of §9.9's literal "SELECT EmployeeOpenShift WHERE
 * employeeId FOR UPDATE" that the design doc's own prose leaves under-specified): a bare
 * employeeId lookup would find ANY open shift for this employee, including one opened by an
 * unrelated, later Check In that has nothing to do with this exception. Verifying
 * openedByClockEventId === exception.clockEventId before proceeding is the same target-identity
 * discipline §9.7 already applies to CONFIRM_SOURCE_ASSIGNMENT's EmployeeOpenShift branch,
 * applied here for the same reason: never act on the wrong shift just because SOME shift happens
 * to be open. A mismatch (or no open shift at all) uniformly means the originating shift is no
 * longer the live one, standing in for both "already closed for real" and "not this shift" ->
 * 409 OPEN_SHIFT_ALREADY_CLOSED either way (§9.9: "резолверу предлагается DISMISS вместо этого").
 */
export async function forceCloseOpenShift(exceptionId: string, explicitEndAt: Date, reason: string, actorUserId: string, requestId: string): Promise<ForceCloseOutcome> {
  const pre = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: FORCE_CLOSE_PRE_READ_SELECT });
  if (!pre) {
    return { kind: 'NOT_FOUND' };
  }
  if (pre.status !== 'OPEN') {
    return { kind: 'ALREADY_RESOLVED' };
  }
  if (!isForceCloseApplicable(pre.type)) {
    return { kind: 'ACTION_NOT_APPLICABLE', allowedActions: allowedActionsFor(pre.type) };
  }

  return prisma.$transaction(async (tx) => {
    // Canonical order (§8.1): Employee(1) before AttendanceException(7) — never the reverse. The
    // EmployeeOpenShift lock (position 3) that follows comes AFTER AttendanceException here, the
    // same documented exception to strict ascending order already used by CONFIRM_SOURCE_ASSIGNMENT
    // (§8.5: "no more than one additional row at position 3" for resolver-form actions other than
    // REASON_EDIT) — not re-derived here, applied as already proven safe.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${pre.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "AttendanceException" WHERE id = ${exceptionId}::uuid FOR UPDATE`;

    const fresh: ForceClosePreRead | null = await tx.attendanceException.findUnique({ where: { id: exceptionId }, select: FORCE_CLOSE_PRE_READ_SELECT });
    if (!fresh) {
      return { kind: 'NOT_FOUND' as const };
    }
    if (fresh.status !== 'OPEN') {
      return { kind: 'ALREADY_RESOLVED' as const };
    }
    if (!isForceCloseApplicable(fresh.type)) {
      return { kind: 'ACTION_NOT_APPLICABLE' as const, allowedActions: allowedActionsFor(fresh.type) };
    }
    if (!fresh.clockEventId) {
      // No consistent originating clockEventId to identify a target with at all — treat the same
      // as "the shift this exception was about is not identifiable/no longer live".
      return { kind: 'OPEN_SHIFT_ALREADY_CLOSED' as const };
    }

    const openRows = await tx.$queryRaw<{ id: string; siteId: string; workAreaId: string | null; sourceAssignmentId: string | null; openedAt: Date; openedByClockEventId: string }[]>`
      SELECT id, "siteId", "workAreaId", "sourceAssignmentId", "openedAt", "openedByClockEventId"
      FROM "EmployeeOpenShift" WHERE "employeeId" = ${fresh.employeeId}::uuid
      FOR UPDATE
    `;
    const openShift = openRows[0];
    if (!openShift || openShift.openedByClockEventId !== fresh.clockEventId) {
      return { kind: 'OPEN_SHIFT_ALREADY_CLOSED' as const };
    }

    // Re-checked HERE, under lock, against the just-locked row — not the pre-read snapshot. Even
    // an administrative force-close cannot violate basic chronology; no clamp, a plain rejection
    // (§9.9: "человек обязан ввести правдоподобное значение").
    if (!(explicitEndAt.getTime() > openShift.openedAt.getTime())) {
      return { kind: 'VALIDATION_ERROR' as const, fieldErrors: { explicitEndAt: ['must be strictly after the open shift\'s openedAt'] } };
    }

    const now = new Date();

    const clockShift = await tx.clockShift.create({
      data: {
        employeeId: fresh.employeeId,
        checkInEventId: openShift.openedByClockEventId,
        checkOutEventId: null,
        siteId: openShift.siteId,
        workAreaId: openShift.workAreaId,
        sourceAssignmentId: openShift.sourceAssignmentId,
        recordedStartAt: openShift.openedAt,
        recordedEndAt: explicitEndAt,
        endAtProvisional: false,
        forceClosedByUserId: actorUserId,
        forceClosedReason: reason,
        forceClosedAt: now,
        materializationState: 'PENDING'
      }
    });

    // Same employeeId already locked above — a plain delete-by-PK, not a race (§9.9 step 6).
    await tx.employeeOpenShift.delete({ where: { employeeId: fresh.employeeId } });

    await tx.attendanceException.update({
      where: { id: exceptionId },
      data: { status: 'RESOLVED', resolvedByUserId: actorUserId, resolvedAt: now, resolutionNote: reason }
    });

    // Sanitized: only ids, site/workArea/assignment ids, recorded interval, and reason — never GPS,
    // accuracy, payloadHash, raw request body, deviceInstallationId/deviceSequence, or any
    // exception.detail passthrough.
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CLOCK_SHIFT_FORCE_CLOSED',
      entityType: 'ATTENDANCE_EXCEPTION',
      entityId: exceptionId,
      requestId,
      beforeValue: { status: 'OPEN', type: fresh.type },
      afterValue: {
        status: 'RESOLVED',
        resolutionAction: 'FORCE_CLOSE_OPEN_SHIFT',
        clockShiftId: clockShift.id,
        employeeId: fresh.employeeId,
        checkInEventId: clockShift.checkInEventId,
        siteId: clockShift.siteId,
        workAreaId: clockShift.workAreaId,
        sourceAssignmentId: clockShift.sourceAssignmentId,
        recordedStartAt: clockShift.recordedStartAt.toISOString(),
        recordedEndAt: clockShift.recordedEndAt.toISOString()
      },
      reason
    });

    const actor = await tx.user.findUniqueOrThrow({ where: { id: actorUserId }, select: { username: true, employee: { select: { firstName: true, lastName: true } } } });

    return {
      kind: 'CREATED' as const,
      result: {
        resolutionAction: 'FORCE_CLOSE_OPEN_SHIFT' as const,
        clockShift: {
          id: clockShift.id,
          employeeId: clockShift.employeeId,
          checkInEventId: clockShift.checkInEventId,
          checkOutEventId: null,
          siteId: clockShift.siteId,
          workAreaId: clockShift.workAreaId,
          sourceAssignmentId: clockShift.sourceAssignmentId,
          recordedStartAt: clockShift.recordedStartAt.toISOString(),
          recordedEndAt: clockShift.recordedEndAt.toISOString(),
          endAtProvisional: false as const,
          forceClosedByUserId: clockShift.forceClosedByUserId as string,
          forceClosedReason: clockShift.forceClosedReason as string,
          forceClosedAt: (clockShift.forceClosedAt as Date).toISOString(),
          materializationState: clockShift.materializationState
        },
        resolvedAt: now.toISOString(),
        resolvedBy: { id: actorUserId, name: actorDisplayName(actor) },
        resolutionNote: reason
      }
    };
  });
}
