import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { allowedActionsFor, checkForemanScope, type ForemanMutationScope, type ScopeCarrier } from '@/lib/attendance-exception-resolution';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11-§12.4 — T7A.8C.2's read-only
// presentation/service layer. This module NEVER writes anything (no AuditEvent, no mutation of any
// kind) and is called directly by the two admin/foreman detail Server Component pages, exactly the
// same way lib/attendance-exceptions.ts's getAttendanceExceptionDetail already is — no new public
// API endpoint. It exists purely so the client-side action forms can offer real, human-labelled
// choices (a candidate ClockEvent, a candidate SiteAssignment, a candidate ClockShiftFragment)
// instead of asking anyone to type a UUID. Every candidate list here is advisory: the real POST
// endpoints (lib/attendance-exception-resolution.ts / lib/attendance-exception-edit.ts) re-derive
// and re-validate everything inside their own transactions and are the sole final authority — this
// module changes nothing about what those endpoints accept or reject.
//
// Deliberately reuses (never re-declares) the backend's own pure helpers: allowedActionsFor (the
// §11 domain action matrix) and checkForemanScope (the anyOwn/allOwn foreman mutation-scope rule) —
// both now exported from lib/attendance-exception-resolution.ts for exactly this reuse.

export type ResolutionActionName = 'DISMISS' | 'ACKNOWLEDGE_AS_VALID' | 'PAIR_ORPHAN_EVENTS' | 'CONFIRM_SOURCE_ASSIGNMENT' | 'FORCE_CLOSE_OPEN_SHIFT' | 'REASON_EDIT';

// FOREMAN never gets these three, regardless of what the domain matrix says for a given type
// (task §1) — enforced here at the presentation layer AND already independently enforced by the
// two POST routes (the foreman .../resolve route 403s CONFIRM_SOURCE_ASSIGNMENT/FORCE_CLOSE_OPEN_SHIFT
// before reading the body; the foreman .../edit route 403s unconditionally). Two independent gates,
// neither trusting the other.
const FOREMAN_ALLOWED_ACTIONS = new Set<ResolutionActionName>(['DISMISS', 'ACKNOWLEDGE_AS_VALID', 'PAIR_ORPHAN_EVENTS']);

const PAIR_CANDIDATE_LIMIT = 20;

export interface ResolutionContextParams {
  /** null => ADMIN/SUPER_ADMIN (no site restriction). Non-null => FOREMAN, same shape the two
   * mutation endpoints already take. */
  scope: ForemanMutationScope | null;
  /** Whether the caller holds timesheet.draft.edit.exception — irrelevant when scope is non-null
   * (FOREMAN never gets REASON_EDIT no matter what). */
  canReasonEdit: boolean;
}

export interface PairCandidateEvent {
  id: string;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  effectiveAt: string;
  siteName: string;
  channel: string;
}

export interface PairContext {
  namedEvent: PairCandidateEvent;
  /** Same employee, opposite operationType, chronologically valid relative to namedEvent, not
   * already part of any ClockShift, stably sorted, capped at a reasonable size. For FOREMAN,
   * further restricted to candidates whose site is one of the caller's current sites — pairing
   * with a foreign-site candidate would always fail FOREMAN_SCOPE_INCOMPLETE at POST time, so it is
   * never offered as a choice in the first place. An empty list is a normal, explained state (task
   * §4), not an error. */
  candidates: PairCandidateEvent[];
}

export interface AssignmentCandidate {
  id: string;
  siteName: string;
  workAreaName: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface AssignmentContext {
  /** null only in the rare race where the exception's own target row (EmployeeOpenShift /
   * ClockShift / ClockShiftFragment) can no longer be located read-only — the form then explains
   * there is nothing to confirm rather than rendering a picker for a target that no longer exists. */
  target: { siteName: string; date: string } | null;
  /** true if the target was found but already carries a sourceAssignmentId (someone else already
   * confirmed it) — the exception itself just hasn't caught up to RESOLVED yet. */
  alreadyResolved: boolean;
  candidates: AssignmentCandidate[];
}

export interface ForceCloseContext {
  /** null when no open shift matches this exception's own originating clockEventId anymore (it
   * already closed for real via a normal Check Out) — mirrors the backend's own
   * OPEN_SHIFT_ALREADY_CLOSED target-identity check (task §6), read-only. */
  openShift: { openedAt: string; siteName: string; workAreaName: string | null } | null;
}

export interface EditFragmentCandidate {
  id: string;
  date: string;
  siteName: string;
  workAreaName: string | null;
  recordedStartAt: string;
  recordedEndAt: string;
  reportedProjectionState: string;
  currentReported: {
    startAt: string;
    endAt: string;
    siteId: string;
    siteName: string;
    workAreaId: string | null;
    workAreaName: string | null;
  };
  breaks: { startAt: string; endAt: string; paid: boolean }[];
  /** Assignment-backed (site, workArea) options valid for this employee on this fragment's own
   * date — the site/work-area picker only ever offers combinations that would actually pass the
   * backend's own SITE_NOT_ASSIGNED check, never a free-typed id. */
  assignmentOptions: { siteId: string; siteName: string; workAreaId: string | null; workAreaName: string | null }[];
}

export interface EditContext {
  /** Only fragments that are SETTLED and have a live editable segment — a PENDING fragment or one
   * with no live segment is never offered as a choice (task §7: "только допустимые target
   * fragments"). Can be empty — the form then explains there is nothing editable yet. */
  fragments: EditFragmentCandidate[];
  requiresEndAt: boolean;
  isOverlappingShift: boolean;
}

export type ReadOnlyReason = 'SCOPE_INCOMPLETE' | 'NO_APPLICABLE_ACTIONS' | null;

export interface ResolutionContext {
  exceptionId: string;
  type: string;
  status: string;
  allowedActions: ResolutionActionName[];
  readOnlyReason: ReadOnlyReason;
  chronologyNoteRequired: boolean;
  pairContext: PairContext | null;
  assignmentContext: AssignmentContext | null;
  forceCloseContext: ForceCloseContext | null;
  editContext: EditContext | null;
}

const CONTEXT_SELECT = {
  employeeId: true,
  type: true,
  status: true,
  siteId: true,
  clockEventId: true,
  clockShiftId: true,
  relatedClockShiftId: true,
  clockShiftFragmentId: true,
  timesheetId: true,
  payrollPeriodId: true,
  clockEvent: { select: { siteId: true, operationType: true, effectiveAt: true, channel: true, site: { select: { name: true } } } },
  clockShift: { select: { siteId: true } },
  relatedClockShift: { select: { siteId: true } },
  clockShiftFragment: { select: { siteId: true } }
} satisfies Prisma.AttendanceExceptionSelect;

type ContextRow = Prisma.AttendanceExceptionGetPayload<{ select: typeof CONTEXT_SELECT }>;

function asScopeCarrier(row: ContextRow): ScopeCarrier {
  return {
    employeeId: row.employeeId,
    siteId: row.siteId,
    clockEvent: row.clockEvent ? { siteId: row.clockEvent.siteId } : null,
    clockShift: row.clockShift ? { siteId: row.clockShift.siteId } : null,
    clockShiftFragment: row.clockShiftFragment ? { siteId: row.clockShiftFragment.siteId } : null,
    relatedClockShift: row.relatedClockShift ? { siteId: row.relatedClockShift.siteId } : null
  };
}

/**
 * Read-only, no locks, no AuditEvent, recomputed fresh on every call (a Server Component calling
 * this on every render/`router.refresh()` gets a live picture, never a cached one — task §3). Mirrors
 * getAttendanceExceptionDetail's own null-for-invisible contract: malformed/missing/out-of-scope/
 * dual-role-self all return null uniformly, so this can never become a UUID/scope oracle any more
 * than the existing read endpoint already is.
 */
export async function getResolutionContext(exceptionId: string, params: ResolutionContextParams): Promise<ResolutionContext | null> {
  const { scope, canReasonEdit } = params;

  const row = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: CONTEXT_SELECT });
  if (!row) {
    return null;
  }

  let scopeComplete = true;
  let ownSiteIds: string[] = [];
  if (scope) {
    if (scope.excludeEmployeeId && row.employeeId === scope.excludeEmployeeId) {
      return null;
    }
    ownSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today);
    const visibility = checkForemanScope(asScopeCarrier(row), ownSiteIds, scope.excludeEmployeeId);
    if (visibility.kind === 'NOT_FOUND') {
      return null;
    }
    scopeComplete = visibility.kind === 'OK';
  }

  if (row.status !== 'OPEN') {
    return {
      exceptionId,
      type: row.type,
      status: row.status,
      allowedActions: [],
      readOnlyReason: null,
      chronologyNoteRequired: false,
      pairContext: null,
      assignmentContext: null,
      forceCloseContext: null,
      editContext: null
    };
  }

  const domainActions = allowedActionsFor(row.type) as ResolutionActionName[];
  let allowedActions: ResolutionActionName[];
  if (!scopeComplete) {
    allowedActions = [];
  } else if (scope) {
    allowedActions = domainActions.filter((a) => FOREMAN_ALLOWED_ACTIONS.has(a));
  } else {
    allowedActions = canReasonEdit ? domainActions : domainActions.filter((a) => a !== 'REASON_EDIT');
  }

  let readOnlyReason: ReadOnlyReason = null;
  if (allowedActions.length === 0) {
    readOnlyReason = !scopeComplete ? 'SCOPE_INCOMPLETE' : 'NO_APPLICABLE_ACTIONS';
  }

  const [pairContext, assignmentContext, forceCloseContext, editContext] = await Promise.all([
    allowedActions.includes('PAIR_ORPHAN_EVENTS') ? buildPairContext(row, scope, ownSiteIds) : Promise.resolve(null),
    allowedActions.includes('CONFIRM_SOURCE_ASSIGNMENT') ? buildAssignmentContext(row) : Promise.resolve(null),
    allowedActions.includes('FORCE_CLOSE_OPEN_SHIFT') ? buildForceCloseContext(row) : Promise.resolve(null),
    allowedActions.includes('REASON_EDIT') ? buildEditContext(row) : Promise.resolve(null)
  ]);

  return {
    exceptionId,
    type: row.type,
    status: row.status,
    allowedActions,
    readOnlyReason,
    chronologyNoteRequired: row.type === 'CHECKOUT_CHRONOLOGY_ANOMALY',
    pairContext,
    assignmentContext,
    forceCloseContext,
    editContext
  };
}

// ---------------------------------------------------------------------------------------------
// PAIR_ORPHAN_EVENTS
// ---------------------------------------------------------------------------------------------

async function buildPairContext(row: ContextRow, scope: ForemanMutationScope | null, ownSiteIds: string[]): Promise<PairContext | null> {
  if (!row.clockEventId || !row.clockEvent) {
    return null;
  }
  const namedEvent: PairCandidateEvent = {
    id: row.clockEventId,
    operationType: row.clockEvent.operationType as 'CHECK_IN' | 'CHECK_OUT',
    effectiveAt: row.clockEvent.effectiveAt.toISOString(),
    siteName: row.clockEvent.site.name,
    channel: row.clockEvent.channel
  };

  const siteFilter = scope ? ownSiteIds : null;
  type CandidateRow = { id: string; operationType: string; effectiveAt: Date; channel: string; siteName: string };

  let candidates: CandidateRow[];
  if (row.type === 'DOUBLE_CHECK_IN') {
    // named event is the CHECK_IN — candidates are later CHECK_OUT events.
    candidates = siteFilter
      ? await prisma.$queryRaw<CandidateRow[]>`
          SELECT ce.id, ce."operationType", ce."effectiveAt", ce.channel, s.name AS "siteName"
          FROM "ClockEvent" ce JOIN "WorkSite" s ON s.id = ce."siteId"
          WHERE ce."employeeId" = ${row.employeeId}::uuid AND ce."operationType" = 'CHECK_OUT'
            AND ce."effectiveAt" > ${row.clockEvent.effectiveAt}::timestamptz
            AND ce."siteId" = ANY(${siteFilter}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM "ClockShift" cs WHERE cs."checkInEventId" = ce.id OR cs."checkOutEventId" = ce.id)
          ORDER BY ce."effectiveAt" ASC, ce.id ASC LIMIT ${PAIR_CANDIDATE_LIMIT}
        `
      : await prisma.$queryRaw<CandidateRow[]>`
          SELECT ce.id, ce."operationType", ce."effectiveAt", ce.channel, s.name AS "siteName"
          FROM "ClockEvent" ce JOIN "WorkSite" s ON s.id = ce."siteId"
          WHERE ce."employeeId" = ${row.employeeId}::uuid AND ce."operationType" = 'CHECK_OUT'
            AND ce."effectiveAt" > ${row.clockEvent.effectiveAt}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM "ClockShift" cs WHERE cs."checkInEventId" = ce.id OR cs."checkOutEventId" = ce.id)
          ORDER BY ce."effectiveAt" ASC, ce.id ASC LIMIT ${PAIR_CANDIDATE_LIMIT}
        `;
  } else if (row.type === 'CHECKOUT_WITHOUT_OPEN_SHIFT') {
    // named event is the CHECK_OUT — candidates are earlier CHECK_IN events.
    candidates = siteFilter
      ? await prisma.$queryRaw<CandidateRow[]>`
          SELECT ce.id, ce."operationType", ce."effectiveAt", ce.channel, s.name AS "siteName"
          FROM "ClockEvent" ce JOIN "WorkSite" s ON s.id = ce."siteId"
          WHERE ce."employeeId" = ${row.employeeId}::uuid AND ce."operationType" = 'CHECK_IN'
            AND ce."effectiveAt" < ${row.clockEvent.effectiveAt}::timestamptz
            AND ce."siteId" = ANY(${siteFilter}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM "ClockShift" cs WHERE cs."checkInEventId" = ce.id OR cs."checkOutEventId" = ce.id)
          ORDER BY ce."effectiveAt" DESC, ce.id ASC LIMIT ${PAIR_CANDIDATE_LIMIT}
        `
      : await prisma.$queryRaw<CandidateRow[]>`
          SELECT ce.id, ce."operationType", ce."effectiveAt", ce.channel, s.name AS "siteName"
          FROM "ClockEvent" ce JOIN "WorkSite" s ON s.id = ce."siteId"
          WHERE ce."employeeId" = ${row.employeeId}::uuid AND ce."operationType" = 'CHECK_IN'
            AND ce."effectiveAt" < ${row.clockEvent.effectiveAt}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM "ClockShift" cs WHERE cs."checkInEventId" = ce.id OR cs."checkOutEventId" = ce.id)
          ORDER BY ce."effectiveAt" DESC, ce.id ASC LIMIT ${PAIR_CANDIDATE_LIMIT}
        `;
  } else {
    candidates = [];
  }

  return {
    namedEvent,
    candidates: candidates.map((c) => ({ id: c.id, operationType: c.operationType as 'CHECK_IN' | 'CHECK_OUT', effectiveAt: c.effectiveAt.toISOString(), siteName: c.siteName, channel: c.channel }))
  };
}

// ---------------------------------------------------------------------------------------------
// CONFIRM_SOURCE_ASSIGNMENT
// ---------------------------------------------------------------------------------------------

/** Read-only mirror of lib/attendance-exception-resolution.ts's lockConfirmTarget — same three-FK
 * dispatch (fragment > shift > open-shift/closed-shift-fallback via clockEventId), deliberately
 * without any `FOR UPDATE`/transaction: this is a preview only, the real POST re-locks and
 * re-derives the target itself inside its own transaction regardless of what this returns. */
async function findConfirmTargetReadOnly(row: ContextRow): Promise<{ siteId: string; siteName: string; targetDate: Date; sourceAssignmentId: string | null } | null> {
  if (row.clockShiftFragmentId) {
    const fragment = await prisma.clockShiftFragment.findUnique({
      where: { id: row.clockShiftFragmentId },
      select: { siteId: true, date: true, sourceAssignmentId: true, site: { select: { name: true } } }
    });
    return fragment ? { siteId: fragment.siteId, siteName: fragment.site.name, targetDate: fragment.date, sourceAssignmentId: fragment.sourceAssignmentId } : null;
  }
  if (row.clockShiftId) {
    const shift = await prisma.clockShift.findUnique({
      where: { id: row.clockShiftId },
      select: { siteId: true, recordedStartAt: true, sourceAssignmentId: true, site: { select: { name: true } } }
    });
    if (!shift) {
      return null;
    }
    const dateRows = await prisma.$queryRaw<{ date: Date }[]>`SELECT (${shift.recordedStartAt}::timestamptz AT TIME ZONE 'Europe/Helsinki')::date AS date`;
    return { siteId: shift.siteId, siteName: shift.site.name, targetDate: dateRows[0].date, sourceAssignmentId: shift.sourceAssignmentId };
  }
  if (row.clockEventId) {
    const openShift = await prisma.employeeOpenShift.findUnique({
      where: { employeeId: row.employeeId },
      select: { openedByClockEventId: true, siteId: true, openedAt: true, sourceAssignmentId: true, site: { select: { name: true } } }
    });
    if (openShift && openShift.openedByClockEventId === row.clockEventId) {
      const dateRows = await prisma.$queryRaw<{ date: Date }[]>`SELECT (${openShift.openedAt}::timestamptz AT TIME ZONE 'Europe/Helsinki')::date AS date`;
      return { siteId: openShift.siteId, siteName: openShift.site.name, targetDate: dateRows[0].date, sourceAssignmentId: openShift.sourceAssignmentId };
    }
    const shift = await prisma.clockShift.findFirst({
      where: { checkInEventId: row.clockEventId },
      select: { siteId: true, recordedStartAt: true, sourceAssignmentId: true, site: { select: { name: true } } }
    });
    if (shift) {
      const dateRows = await prisma.$queryRaw<{ date: Date }[]>`SELECT (${shift.recordedStartAt}::timestamptz AT TIME ZONE 'Europe/Helsinki')::date AS date`;
      return { siteId: shift.siteId, siteName: shift.site.name, targetDate: dateRows[0].date, sourceAssignmentId: shift.sourceAssignmentId };
    }
    return null;
  }
  return null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function buildAssignmentContext(row: ContextRow): Promise<AssignmentContext> {
  const target = await findConfirmTargetReadOnly(row);
  if (!target) {
    return { target: null, alreadyResolved: false, candidates: [] };
  }
  if (target.sourceAssignmentId !== null) {
    return { target: { siteName: target.siteName, date: formatDate(target.targetDate) }, alreadyResolved: true, candidates: [] };
  }

  const candidates = await prisma.$queryRaw<
    { id: string; workAreaName: string | null; isPrimary: boolean; validFrom: Date; validTo: Date | null; siteName: string }[]
  >`
    SELECT sa.id, wa.name AS "workAreaName", sa."isPrimary", sa."validFrom", sa."validTo", s.name AS "siteName"
    FROM "SiteAssignment" sa
    JOIN "WorkSite" s ON s.id = sa."siteId"
    LEFT JOIN "WorkArea" wa ON wa.id = sa."workAreaId"
    WHERE sa."employeeId" = ${row.employeeId}::uuid
      AND sa."siteId" = ${target.siteId}::uuid
      AND sa."validFrom" <= ${target.targetDate}::date
      AND (sa."validTo" IS NULL OR sa."validTo" >= ${target.targetDate}::date)
    ORDER BY sa."validFrom" DESC, sa.id ASC
  `;

  return {
    target: { siteName: target.siteName, date: formatDate(target.targetDate) },
    alreadyResolved: false,
    candidates: candidates.map((c) => ({ id: c.id, siteName: c.siteName, workAreaName: c.workAreaName, isPrimary: c.isPrimary, validFrom: formatDate(c.validFrom), validTo: c.validTo ? formatDate(c.validTo) : null }))
  };
}

// ---------------------------------------------------------------------------------------------
// FORCE_CLOSE_OPEN_SHIFT
// ---------------------------------------------------------------------------------------------

async function buildForceCloseContext(row: ContextRow): Promise<ForceCloseContext> {
  if (!row.clockEventId) {
    return { openShift: null };
  }
  const openShift = await prisma.employeeOpenShift.findUnique({
    where: { employeeId: row.employeeId },
    select: { openedByClockEventId: true, openedAt: true, site: { select: { name: true } }, workArea: { select: { name: true } } }
  });
  if (!openShift || openShift.openedByClockEventId !== row.clockEventId) {
    return { openShift: null };
  }
  return { openShift: { openedAt: openShift.openedAt.toISOString(), siteName: openShift.site.name, workAreaName: openShift.workArea?.name ?? null } };
}

// ---------------------------------------------------------------------------------------------
// REASON_EDIT
// ---------------------------------------------------------------------------------------------

async function candidateShiftIdsForEdit(row: ContextRow): Promise<string[]> {
  if (row.type === 'OVERLAPPING_SHIFT') {
    return [row.clockShiftId, row.relatedClockShiftId].filter((id): id is string => !!id);
  }
  if (row.clockShiftId) {
    return [row.clockShiftId];
  }
  if (row.clockEventId) {
    const shift = await prisma.clockShift.findFirst({
      where: { OR: [{ checkInEventId: row.clockEventId }, { checkOutEventId: row.clockEventId }] },
      select: { id: true }
    });
    return shift ? [shift.id] : [];
  }
  return [];
}

async function buildEditContext(row: ContextRow): Promise<EditContext> {
  const isOverlappingShift = row.type === 'OVERLAPPING_SHIFT';

  let candidateFragmentIds: string[] | null = null;
  if (row.clockShiftFragmentId && !isOverlappingShift) {
    // §1 rule 1 (mirrored from resolveTargetFragmentId) — an exception with a direct fragment link
    // requires an EXACT match, never a broader shift-based search.
    candidateFragmentIds = [row.clockShiftFragmentId];
  }

  const fragments = await prisma.clockShiftFragment.findMany({
    where: candidateFragmentIds ? { id: { in: candidateFragmentIds } } : { clockShiftId: { in: await candidateShiftIdsForEdit(row) } },
    select: {
      id: true,
      date: true,
      siteId: true,
      workAreaId: true,
      recordedStartAt: true,
      recordedEndAt: true,
      reportedProjectionState: true,
      site: { select: { name: true } },
      workArea: { select: { name: true } }
    },
    orderBy: [{ date: 'asc' }, { fragmentIndex: 'asc' }]
  });

  const settled = fragments.filter((f) => f.reportedProjectionState === 'SETTLED');
  if (settled.length === 0) {
    return { fragments: [], requiresEndAt: row.type === 'CHECKOUT_CHRONOLOGY_ANOMALY', isOverlappingShift };
  }

  const segments = await prisma.timesheetDraftSegment.findMany({
    where: { originClockShiftFragmentId: { in: settled.map((f) => f.id) }, employeeId: row.employeeId },
    select: {
      originClockShiftFragmentId: true,
      startAt: true,
      endAt: true,
      siteId: true,
      workAreaId: true,
      site: { select: { name: true } },
      workArea: { select: { name: true } },
      breaks: { select: { startAt: true, endAt: true, paid: true }, orderBy: { startAt: 'asc' } }
    }
  });
  const segmentByFragmentId = new Map(segments.map((s) => [s.originClockShiftFragmentId as string, s]));

  const dates = [...new Set(settled.map((f) => formatDate(f.date)))];
  const assignmentsByDate = new Map<string, { siteId: string; siteName: string; workAreaId: string | null; workAreaName: string | null }[]>();
  await Promise.all(
    dates.map(async (dateStr) => {
      const rows = await prisma.$queryRaw<{ siteId: string; workAreaId: string | null; siteName: string; workAreaName: string | null }[]>`
        SELECT DISTINCT sa."siteId", sa."workAreaId", s.name AS "siteName", wa.name AS "workAreaName"
        FROM "SiteAssignment" sa
        JOIN "WorkSite" s ON s.id = sa."siteId"
        LEFT JOIN "WorkArea" wa ON wa.id = sa."workAreaId"
        WHERE sa."employeeId" = ${row.employeeId}::uuid
          AND sa."validFrom" <= ${dateStr}::date
          AND (sa."validTo" IS NULL OR sa."validTo" >= ${dateStr}::date)
        ORDER BY s.name, wa.name NULLS FIRST
      `;
      assignmentsByDate.set(dateStr, rows);
    })
  );

  const result: EditFragmentCandidate[] = [];
  for (const f of settled) {
    const segment = segmentByFragmentId.get(f.id);
    if (!segment) {
      continue; // NO_LIVE_SEGMENT — never offered as a choice (task §7).
    }
    result.push({
      id: f.id,
      date: formatDate(f.date),
      siteName: f.site.name,
      workAreaName: f.workArea?.name ?? null,
      recordedStartAt: f.recordedStartAt.toISOString(),
      recordedEndAt: f.recordedEndAt.toISOString(),
      reportedProjectionState: f.reportedProjectionState,
      currentReported: {
        startAt: segment.startAt.toISOString(),
        endAt: segment.endAt.toISOString(),
        siteId: segment.siteId,
        siteName: segment.site.name,
        workAreaId: segment.workAreaId,
        workAreaName: segment.workArea?.name ?? null
      },
      breaks: segment.breaks.map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid })),
      assignmentOptions: assignmentsByDate.get(formatDate(f.date)) ?? []
    });
  }

  return { fragments: result, requiresEndAt: row.type === 'CHECKOUT_CHRONOLOGY_ANOMALY', isOverlappingShift };
}
