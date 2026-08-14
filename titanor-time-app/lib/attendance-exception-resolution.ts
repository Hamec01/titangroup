import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { actorDisplayName, type ExceptionTypeFilter } from '@/lib/attendance-exceptions';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5 (resolver pattern) / §11 (action matrix)
// / §12.1/§12.3 — T7A.8B.1: only DISMISS and ACKNOWLEDGE_AS_VALID. The other four resolution
// actions (PAIR_ORPHAN_EVENTS, CONFIRM_SOURCE_ASSIGNMENT, REASON_EDIT, FORCE_CLOSE_OPEN_SHIFT) are
// deliberately not implemented here — see IMPLEMENTED_RESOLUTION_ACTIONS below. Kept in a separate
// file from lib/attendance-exceptions.ts on purpose: that module is read-only (owns scope
// enforcement, filtering, pagination, DTO/redaction for GET); this one owns the single mutating
// transaction, with a materially different lock-order/concurrency contract.

export type ResolutionAction = 'DISMISS' | 'ACKNOWLEDGE_AS_VALID';
export const IMPLEMENTED_RESOLUTION_ACTIONS: ResolutionAction[] = ['DISMISS', 'ACKNOWLEDGE_AS_VALID'];

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

function isActionStaticallyApplicable(type: string, action: ResolutionAction): boolean {
  return action === 'DISMISS' ? DISMISS_ALLOWED_TYPES.has(type as ExceptionTypeFilter) : ACKNOWLEDGE_ALLOWED_TYPES.has(type as ExceptionTypeFilter);
}

function allowedActionsFor(type: string): string[] {
  return DOMAIN_ALLOWED_ACTIONS[type as ExceptionTypeFilter] ?? [];
}

// ---------------------------------------------------------------------------------------------
// Request body validation — pure, no DB access. Type-dependent rules (chronology note, dynamic
// missing-checkout guard) are NOT decidable here (they need the fetched exception) and are
// re-checked both before opening the transaction and again inside it — see resolveAttendanceException.
// ---------------------------------------------------------------------------------------------

export type ResolveBodyValidation = { ok: true; action: ResolutionAction; resolutionNote: string | null } | { ok: false; fieldErrors: Record<string, string[]> };

export function validateResolveRequestBody(raw: unknown): ResolveBodyValidation {
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

  if (Object.keys(fieldErrors).length > 0 || action === null) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, action, resolutionNote };
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

function checkForemanScope(row: ScopeCarrier, ownSiteIds: string[], excludeEmployeeId: string | null): ScopeCheckOutcome {
  if (excludeEmployeeId && row.employeeId === excludeEmployeeId) {
    return { kind: 'NOT_FOUND' };
  }
  const scopeSiteIds = collectScopeSiteIds(row);
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
  resolutionAction: ResolutionAction;
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
function chronologyNoteError(type: string, action: ResolutionAction, resolutionNote: string | null): ResolveOutcome | null {
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
export async function resolveAttendanceException(exceptionId: string, action: ResolutionAction, resolutionNote: string | null, actorUserId: string, scope: ForemanMutationScope | null, requestId: string): Promise<ResolveOutcome> {
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
