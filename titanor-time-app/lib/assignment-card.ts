import { prisma } from '@/lib/prisma';
import {
  helsinkiToday,
  liveAssignmentWhere,
  assignmentUiState,
  type AssignmentUiState
} from '@/lib/assignment-lifecycle';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.3 / §3 / §4 — everything the redesigned
// worker card (Deploy B) needs about a worker's workplace lifecycle, computed from real rows:
//   • "Место работы сейчас"  — currentAssignments (live) with a UI state + open-shift flag
//   • "Запланированные изменения" — scheduledAssignments (validFrom > today) + their transition
//   • "Прошлые назначения"  — pastAssignments (removed or calendar-closed)
//   • recentTransitions     — the structured AssignmentTransition history for the card
// Kept out of lib/workers.ts so getWorkerDetail() stays about identity/activation.

const ASSIGNMENT_SELECT = {
  id: true,
  isPrimary: true,
  validFrom: true,
  validTo: true,
  clockInDisabledAt: true,
  endedReason: true,
  site: { select: { id: true, name: true, finishedAt: true } },
  workArea: { select: { id: true, name: true, active: true } },
  templateVersion: { select: { versionNumber: true, template: { select: { id: true, name: true } } } }
} as const;

export interface CardAssignment {
  assignmentId: string;
  siteId: string;
  siteName: string;
  siteFinished: boolean;
  workAreaId: string | null;
  workAreaName: string | null;
  templateId: string | null;
  templateName: string | null;
  templateVersionNumber: number | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  clockInDisabledAt: string | null;
  endedReason: string | null;
  state: AssignmentUiState;
  /** true when the worker is on an open shift attributed to THIS assignment right now. */
  hasOpenShift: boolean;
  /** true when this assignment covers `today` by date range (so it is "the workplace now" for the
   *  worker) — even if a future transfer is already scheduled from a later date. */
  isCurrentByDate: boolean;
}

export type TransitionKind = 'CHANGE' | 'REMOVE' | 'SITE_FINISH' | 'CUSTOMER_DISABLE' | 'GROUP_CHANGE';
export type TransitionOpenShift = 'AFTER_CHECK_OUT' | 'MOVED_TO_NEW' | 'NONE';

export interface CardTransition {
  id: string;
  kind: TransitionKind;
  actedAt: string;
  effectiveFrom: string;
  openShiftHandling: TransitionOpenShift | null;
  actorName: string | null;
  reasonCode: string;
  reasonText: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  fromAssignmentId: string | null;
  toAssignmentId: string | null;
}

export interface ScheduledChange {
  /** The future assignment row that will become effective. */
  assignment: CardAssignment;
  /** The transition that scheduled it (the "→ B on <date>" record), if we could match one. */
  transition: CardTransition | null;
  /** true when nothing has been recorded against the future assignment yet, so "cancel the planned
   *  change" is safe (design §3.3). */
  cancellable: boolean;
}

export interface WorkerAssignmentCard {
  currentAssignments: CardAssignment[];
  scheduledChanges: ScheduledChange[];
  pastAssignments: CardAssignment[];
  recentTransitions: CardTransition[];
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function labelFor(a: {
  site: { name: string };
  workArea: { name: string } | null;
} | null): string | null {
  if (!a) {
    return null;
  }
  return a.workArea ? `${a.site.name} — ${a.workArea.name}` : a.site.name;
}

function mapAssignment(
  row: {
    id: string;
    isPrimary: boolean;
    validFrom: Date;
    validTo: Date | null;
    clockInDisabledAt: Date | null;
    endedReason: string | null;
    site: { id: string; name: string; finishedAt: Date | null };
    workArea: { id: string; name: string; active: boolean } | null;
    templateVersion: { versionNumber: number; template: { id: string; name: string } } | null;
  },
  now: Date,
  today: Date,
  openShiftAssignmentId: string | null
): CardAssignment {
  const hasOpenShift = openShiftAssignmentId !== null && openShiftAssignmentId === row.id;
  return {
    assignmentId: row.id,
    siteId: row.site.id,
    siteName: row.site.name,
    siteFinished: row.site.finishedAt !== null,
    workAreaId: row.workArea?.id ?? null,
    workAreaName: row.workArea?.name ?? null,
    templateId: row.templateVersion?.template.id ?? null,
    templateName: row.templateVersion?.template.name ?? null,
    templateVersionNumber: row.templateVersion?.versionNumber ?? null,
    isPrimary: row.isPrimary,
    validFrom: iso(row.validFrom),
    validTo: row.validTo ? iso(row.validTo) : null,
    clockInDisabledAt: row.clockInDisabledAt ? row.clockInDisabledAt.toISOString() : null,
    endedReason: row.endedReason,
    state: assignmentUiState(row, { hasOpenShift }, now, today),
    hasOpenShift,
    isCurrentByDate:
      row.validFrom <= today &&
      (row.validTo === null || row.validTo >= today) &&
      (row.clockInDisabledAt === null || row.clockInDisabledAt > now)
  };
}

/** Recent structured lifecycle history for the worker card + the "cancel a planned change" check. */
export async function getWorkerTransitions(employeeId: string, take = 12): Promise<CardTransition[]> {
  const rows = await prisma.assignmentTransition.findMany({
    where: { employeeId },
    orderBy: { actedAt: 'desc' },
    take,
    select: {
      id: true,
      kind: true,
      actedAt: true,
      effectiveFrom: true,
      openShiftHandling: true,
      reasonCode: true,
      reasonText: true,
      fromAssignmentId: true,
      toAssignmentId: true,
      actor: { select: { username: true, employee: { select: { firstName: true, lastName: true } } } },
      fromAssignment: { select: { site: { select: { name: true } }, workArea: { select: { name: true } } } },
      toAssignment: { select: { site: { select: { name: true } }, workArea: { select: { name: true } } } }
    }
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as TransitionKind,
    actedAt: r.actedAt.toISOString(),
    effectiveFrom: iso(r.effectiveFrom),
    openShiftHandling: (r.openShiftHandling as TransitionOpenShift | null) ?? null,
    actorName: r.actor.employee
      ? `${r.actor.employee.firstName} ${r.actor.employee.lastName}`.trim()
      : r.actor.username,
    reasonCode: r.reasonCode,
    reasonText: r.reasonText,
    fromLabel: labelFor(r.fromAssignment),
    toLabel: labelFor(r.toAssignment),
    fromAssignmentId: r.fromAssignmentId,
    toAssignmentId: r.toAssignmentId
  }));
}

/** True when NO recorded / planned time exists against this assignment yet — a scheduled change can
 *  still be cancelled cleanly (design §3.3). */
async function hasNoRecordedTime(assignmentId: string): Promise<boolean> {
  const [seg, frag, ws, tps] = await Promise.all([
    prisma.timesheetDraftSegment.count({ where: { sourceAssignmentId: assignmentId } }),
    prisma.clockShiftFragment.count({ where: { sourceAssignmentId: assignmentId } }),
    prisma.workSegment.count({ where: { sourceAssignmentId: assignmentId } }),
    prisma.timesheetPlannedShift.count({ where: { sourceAssignmentId: assignmentId } })
  ]);
  return seg + frag + ws + tps === 0;
}

export async function getWorkerAssignmentCard(employeeId: string): Promise<WorkerAssignmentCard> {
  const now = new Date();
  const today = helsinkiToday();

  const [openShift, liveRows, scheduledRows, pastRows, transitions] = await Promise.all([
    prisma.employeeOpenShift.findUnique({ where: { employeeId }, select: { sourceAssignmentId: true } }),
    prisma.siteAssignment.findMany({
      where: { employeeId, ...liveAssignmentWhere(now, today) },
      orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
      select: ASSIGNMENT_SELECT
    }),
    // "Запланировано" = starts in the future OR its Check-In gate flips in the future (§2.3).
    prisma.siteAssignment.findMany({
      where: {
        employeeId,
        OR: [{ validFrom: { gt: today } }, { clockInDisabledAt: { gt: now } }],
        // …but not one that is already live now (a future clockInDisabledAt still counts as scheduled)
        NOT: { AND: [{ validFrom: { lte: today } }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }, { clockInDisabledAt: null }] }
      },
      orderBy: { validFrom: 'asc' },
      select: ASSIGNMENT_SELECT
    }),
    prisma.siteAssignment.findMany({
      where: {
        employeeId,
        validFrom: { lte: today },
        OR: [{ validTo: { lt: today } }, { clockInDisabledAt: { lte: now } }]
      },
      orderBy: [{ clockInDisabledAt: 'desc' }, { validTo: 'desc' }],
      take: 20,
      select: ASSIGNMENT_SELECT
    }),
    getWorkerTransitions(employeeId)
  ]);

  const openShiftId = openShift?.sourceAssignmentId ?? null;

  const currentAssignments = liveRows.map((r) => mapAssignment(r, now, today, openShiftId));

  // A scheduled future assignment whose date range does NOT include today (so it is genuinely
  // "coming up", not "live now"). The one exception already excluded by the query NOT clause.
  const scheduledChanges: ScheduledChange[] = await Promise.all(
    scheduledRows
      .filter((r) => !(r.validFrom <= today && (r.validTo === null || r.validTo >= today) && r.clockInDisabledAt === null))
      .map(async (r) => {
        const assignment = mapAssignment(r, now, today, openShiftId);
        const transition = transitions.find((t) => t.toAssignmentId === r.id) ?? null;
        const cancellable = await hasNoRecordedTime(r.id);
        return { assignment, transition, cancellable };
      })
  );

  const pastAssignments = pastRows
    // don't repeat a row that is also shown as "scheduled" (a future clockInDisabledAt)
    .filter((r) => !scheduledChanges.some((s) => s.assignment.assignmentId === r.id))
    .map((r) => mapAssignment(r, now, today, openShiftId));

  return { currentAssignments, scheduledChanges, pastAssignments, recentTransitions: transitions };
}
