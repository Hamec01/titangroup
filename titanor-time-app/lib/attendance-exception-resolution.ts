import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { actorDisplayName, UUID_PATTERN, type ExceptionTypeFilter } from '@/lib/attendance-exceptions';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5 (resolver pattern) / §9.8 (PAIR_ORPHAN_EVENTS
// full validation) / §11 (action matrix) / §12.1/§12.3 — T7A.8B.1 shipped DISMISS/
// ACKNOWLEDGE_AS_VALID; T7A.8B.2 adds PAIR_ORPHAN_EVENTS. The remaining three actions
// (CONFIRM_SOURCE_ASSIGNMENT, REASON_EDIT, FORCE_CLOSE_OPEN_SHIFT) are deliberately not
// implemented here — see IMPLEMENTED_RESOLUTION_ACTIONS below. Kept in a separate file from
// lib/attendance-exceptions.ts on purpose: that module is read-only (owns scope enforcement,
// filtering, pagination, DTO/redaction for GET); this one owns the mutating transactions, with a
// materially different lock-order/concurrency contract.

export type SimpleResolutionAction = 'DISMISS' | 'ACKNOWLEDGE_AS_VALID';
export type ResolutionAction = SimpleResolutionAction | 'PAIR_ORPHAN_EVENTS';
export const IMPLEMENTED_RESOLUTION_ACTIONS: ResolutionAction[] = ['DISMISS', 'ACKNOWLEDGE_AS_VALID', 'PAIR_ORPHAN_EVENTS'];

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

export type ParsedResolveRequest =
  | { ok: true; action: SimpleResolutionAction; resolutionNote: string | null }
  | { ok: true; action: 'PAIR_ORPHAN_EVENTS'; checkInEventId: string; checkOutEventId: string; resolutionNote: string | null }
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
    if (Object.keys(fieldErrors).length > 0 || !checkInEventId || !checkOutEventId) {
      return { ok: false, fieldErrors };
    }
    return { ok: true, action: 'PAIR_ORPHAN_EVENTS', checkInEventId, checkOutEventId, resolutionNote };
  }

  if (action === 'DISMISS' || action === 'ACKNOWLEDGE_AS_VALID') {
    if (body.checkInEventId !== undefined) {
      fieldErrors.checkInEventId = ['not allowed for this action'];
    }
    if (body.checkOutEventId !== undefined) {
      fieldErrors.checkOutEventId = ['not allowed for this action'];
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
