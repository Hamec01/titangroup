import { prisma } from '@/lib/prisma';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §9 — read-only timesheet/draft/version views
// (ЭТАП 7 sub-task 3a). §9's ownership rule: "сервер проверяет, что этот Timesheet.employeeId
// принадлежит вызывающему (403 FORBIDDEN иначе, не 404, чтобы не спутать «чужой» с «не существует»)".

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type TimesheetAccessError = { code: 'NOT_FOUND' } | { code: 'FORBIDDEN' };

async function loadOwnTimesheet(
  employeeId: string,
  timesheetId: string
): Promise<{ timesheet: { id: string; employeeId: string; periodId: string; status: string; currentVersionId: string | null } } | { error: TimesheetAccessError }> {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId } });
  if (!timesheet) {
    return { error: { code: 'NOT_FOUND' } };
  }
  if (timesheet.employeeId !== employeeId) {
    return { error: { code: 'FORBIDDEN' } };
  }
  return { timesheet };
}

export interface TimesheetSummary {
  timesheetId: string;
  periodId: string;
  status: string;
  currentVersionId: string | null;
}

export async function getWorkerTimesheetSummary(employeeId: string, timesheetId: string): Promise<TimesheetSummary | TimesheetAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  const t = result.timesheet;
  return { timesheetId: t.id, periodId: t.periodId, status: t.status, currentVersionId: t.currentVersionId };
}

export interface BreakView {
  id: string;
  startAt: string;
  endAt: string;
  paid: boolean;
}

export interface SegmentView {
  id: string;
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  breaks: BreakView[];
}

export interface PlannedShiftView {
  date: string;
  siteId: string;
  sourceAssignmentId: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  plannedBreakMinutes: number;
}

export interface DraftDayView {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  segments: SegmentView[];
}

export interface TimesheetDraftView {
  days: DraftDayView[];
  plannedShifts: PlannedShiftView[];
}

export type DraftAccessError = TimesheetAccessError | { code: 'DRAFT_NOT_EDITABLE' };

/** Only when Timesheet.status IN (DRAFT, RETURNED) — draft content is physically emptied on submit (03_...§4.6). */
export async function getWorkerTimesheetDraft(employeeId: string, timesheetId: string): Promise<TimesheetDraftView | DraftAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  if (result.timesheet.status !== 'DRAFT' && result.timesheet.status !== 'RETURNED') {
    return { code: 'DRAFT_NOT_EDITABLE' };
  }

  const draft = await prisma.timesheetDraft.findUnique({
    where: { timesheetId },
    select: {
      days: {
        orderBy: { date: 'asc' },
        select: {
          date: true,
          dayType: true,
          confirmedZero: true,
          segments: {
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              startAt: true,
              endAt: true,
              siteId: true,
              workAreaId: true,
              sourceAssignmentId: true,
              breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
            }
          }
        }
      },
      plannedShifts: {
        orderBy: { date: 'asc' },
        select: { date: true, siteId: true, sourceAssignmentId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
      }
    }
  });

  // TimesheetDraft is created in the same triple as Timesheet itself (03_...§4.6) — always exists; this is defensive only.
  if (!draft) {
    return { days: [], plannedShifts: [] };
  }

  return {
    days: draft.days.map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      segments: d.segments.map((s) => ({
        id: s.id,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        sourceAssignmentId: s.sourceAssignmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    })),
    plannedShifts: draft.plannedShifts.map((p) => ({
      date: formatDate(p.date),
      siteId: p.siteId,
      sourceAssignmentId: p.sourceAssignmentId,
      plannedStartAt: p.plannedStartAt ? p.plannedStartAt.toISOString() : null,
      plannedEndAt: p.plannedEndAt ? p.plannedEndAt.toISOString() : null,
      plannedBreakMinutes: p.plannedBreakMinutes
    }))
  };
}

export interface VersionDayView {
  date: string;
  dayType: string;
  segments: SegmentView[];
}

export interface TimesheetCurrentVersionView {
  versionId: string;
  versionNumber: number;
  days: VersionDayView[];
  plannedShifts: PlannedShiftView[];
  reviewScopes: { scopeType: string; siteId: string | null; status: string }[];
}

/**
 * Available in ANY Timesheet status, unlike .../draft — but currentVersionId is only ever set
 * once timesheet.submit runs (not built yet, a later ЭТАП 7 sub-task), so this always returns
 * 404 TIMESHEET_NOT_FOUND today; that's the contract's own documented behavior for "table de
 * table has never been submitted", not a bug. `reviewScopes` is always `[]` for the same
 * reason TimesheetReviewScope doesn't exist as a model yet — no scope can exist before the
 * review subsystem does.
 */
export async function getWorkerTimesheetCurrentVersion(employeeId: string, timesheetId: string): Promise<TimesheetCurrentVersionView | TimesheetAccessError> {
  const result = await loadOwnTimesheet(employeeId, timesheetId);
  if ('error' in result) {
    return result.error;
  }
  if (!result.timesheet.currentVersionId) {
    return { code: 'NOT_FOUND' };
  }

  const version = await prisma.timesheetVersion.findUnique({
    where: { id: result.timesheet.currentVersionId },
    select: {
      id: true,
      versionNumber: true,
      days: {
        orderBy: { date: 'asc' },
        select: {
          date: true,
          dayType: true,
          segments: {
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              startAt: true,
              endAt: true,
              siteId: true,
              workAreaId: true,
              sourceAssignmentId: true,
              breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
            }
          }
        }
      },
      plannedShifts: {
        orderBy: { date: 'asc' },
        select: { date: true, siteId: true, sourceAssignmentId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
      }
    }
  });

  if (!version) {
    return { code: 'NOT_FOUND' };
  }

  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    days: version.days.map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      segments: d.segments.map((s) => ({
        id: s.id,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        sourceAssignmentId: s.sourceAssignmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    })),
    plannedShifts: version.plannedShifts.map((p) => ({
      date: formatDate(p.date),
      siteId: p.siteId,
      sourceAssignmentId: p.sourceAssignmentId,
      plannedStartAt: p.plannedStartAt ? p.plannedStartAt.toISOString() : null,
      plannedEndAt: p.plannedEndAt ? p.plannedEndAt.toISOString() : null,
      plannedBreakMinutes: p.plannedBreakMinutes
    })),
    reviewScopes: []
  };
}
