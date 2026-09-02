import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { checkOverlap } from '@/lib/assignments';
import { helsinkiToday } from '@/lib/workers';
import { changeWorkplace } from '@/lib/assignment-lifecycle-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — "Изменить объект / зону" on the worker
// card. This route does HTTP/auth/validation; lib/assignment-lifecycle-service.ts's
// changeWorkplace() (the single writer, §2.4) closes the current assignment the day before
// `effectiveFrom`, opens a fully-materialised replacement, sets clockInDisabledAt on the old row
// when the change is immediate, re-points the open shift when asked, and writes the
// AssignmentTransition + AuditEvent — all in one transaction under a per-employee advisory lock.
// Backdating is forbidden; a submitted timesheet or recorded time on/after the date blocks with 409.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 2000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type TodayShiftHandling = 'KEEP_ON_OLD' | 'MOVE_TO_NEW';

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'assignment.split'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { assignmentId } = await params;
  if (!UUID_PATTERN.test(assignmentId)) {
    return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
  }

  const existing = await prisma.siteAssignment.findUnique({ where: { id: assignmentId } });
  if (!existing) {
    return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { effectiveFrom, siteId, workAreaId, templateId, isPrimary, todayShiftHandling, reason, primaryConflictResolution } = bodyObject as {
    effectiveFrom?: unknown;
    siteId?: unknown;
    workAreaId?: unknown;
    templateId?: unknown;
    isPrimary?: unknown;
    todayShiftHandling?: unknown;
    reason?: unknown;
    primaryConflictResolution?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof effectiveFrom !== 'string' || !DATE_PATTERN.test(effectiveFrom)) {
    fieldErrors.effectiveFrom = ['required'];
  }
  if (typeof siteId !== 'string' || !UUID_PATTERN.test(siteId)) {
    fieldErrors.siteId = ['required'];
  }
  let normalizedWorkAreaId: string | null = null;
  if (workAreaId !== undefined && workAreaId !== null && workAreaId !== '') {
    if (typeof workAreaId !== 'string' || !UUID_PATTERN.test(workAreaId)) {
      fieldErrors.workAreaId = ['invalid'];
    } else {
      normalizedWorkAreaId = workAreaId;
    }
  }
  let normalizedTemplateId: string | null = null;
  if (templateId !== undefined && templateId !== null && templateId !== '') {
    if (typeof templateId !== 'string' || !UUID_PATTERN.test(templateId)) {
      fieldErrors.templateId = ['invalid'];
    } else {
      normalizedTemplateId = templateId;
    }
  }
  let normalizedIsPrimary = existing.isPrimary;
  if (isPrimary !== undefined) {
    if (typeof isPrimary !== 'boolean') {
      fieldErrors.isPrimary = ['invalid'];
    } else {
      normalizedIsPrimary = isPrimary;
    }
  }
  let normalizedHandling: TodayShiftHandling | null = null;
  if (todayShiftHandling !== undefined && todayShiftHandling !== null) {
    if (todayShiftHandling !== 'KEEP_ON_OLD' && todayShiftHandling !== 'MOVE_TO_NEW') {
      fieldErrors.todayShiftHandling = ['invalid'];
    } else {
      normalizedHandling = todayShiftHandling;
    }
  }
  let trimmedReason: string | null = null;
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH) {
      fieldErrors.reason = ['invalid'];
    } else {
      trimmedReason = reason.trim();
    }
  }
  let normalizedPrimaryResolution: 'KEEP_SCHEDULED' | 'REPLACE_SCHEDULED' | undefined;
  if (primaryConflictResolution !== undefined && primaryConflictResolution !== null) {
    if (primaryConflictResolution !== 'KEEP_SCHEDULED' && primaryConflictResolution !== 'REPLACE_SCHEDULED') {
      fieldErrors.primaryConflictResolution = ['invalid'];
    } else {
      normalizedPrimaryResolution = primaryConflictResolution;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), {
      status: 400,
      headers: successHeaders(requestId)
    });
  }

  const today = helsinkiToday();
  let effectiveFromDate = new Date(`${effectiveFrom as string}T00:00:00.000Z`);

  if (effectiveFromDate < today) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { effectiveFrom: ['must not be in the past'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }
  if (effectiveFromDate <= existing.validFrom) {
    return jsonError(
      400,
      {
        code: 'EFFECTIVE_ON_OR_BEFORE_START',
        message: 'The change must take effect after the assignment started. If it started today, change it from tomorrow.',
        fieldErrors: { effectiveFrom: ['must be after the assignment’s start date'] }
      },
      requestId
    );
  }
  if (existing.validTo !== null && effectiveFromDate > existing.validTo) {
    return NextResponse.json(
      errorBody(
        { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { effectiveFrom: ['the assignment already ends before this date'] } },
        requestId
      ),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const site = await prisma.workSite.findUnique({ where: { id: siteId as string }, select: { id: true, active: true } });
  if (!site) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'siteId does not reference an existing site.' }, requestId);
  }
  if (normalizedWorkAreaId !== null) {
    const workArea = await prisma.workArea.findFirst({ where: { id: normalizedWorkAreaId, siteId: siteId as string }, select: { id: true } });
    if (!workArea) {
      return jsonError(404, { code: 'WORK_AREA_NOT_FOUND', message: 'workAreaId does not reference an existing work area on this site.' }, requestId);
    }
  }
  let templateVersionId: string | null = null;
  if (normalizedTemplateId !== null) {
    const latestVersion = await prisma.workScheduleTemplateVersion.findFirst({
      where: { templateId: normalizedTemplateId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true }
    });
    if (!latestVersion) {
      return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'templateId does not reference an existing template.' }, requestId);
    }
    templateVersionId = latestVersion.id;
  }

  const sameSite = (siteId as string) === existing.siteId;
  const sameArea = normalizedWorkAreaId === existing.workAreaId;
  const sameTemplate = templateVersionId === existing.templateVersionId;
  const samePrimary = normalizedIsPrimary === existing.isPrimary;
  if (sameSite && sameArea && sameTemplate && samePrimary) {
    return jsonError(400, { code: 'NOTHING_TO_CHANGE', message: 'The new site, customer, template and primary flag all match the current assignment.' }, requestId);
  }

  // An open shift on/before `effectiveFrom` needs an explicit decision from the admin.
  const openShift = await prisma.employeeOpenShift.findUnique({ where: { employeeId: existing.employeeId }, select: { id: true, openedAt: true } });
  if (openShift && effectiveFromDate <= today) {
    if (normalizedHandling === null) {
      return jsonError(
        409,
        {
          code: 'OPEN_SHIFT_CHOICE_REQUIRED',
          message: 'The worker is on an open shift right now — choose whether today stays on the current site or moves to the new one.'
        },
        requestId
      );
    }
    if (normalizedHandling === 'KEEP_ON_OLD') {
      // Today's shift finishes on the current assignment; the change starts tomorrow.
      effectiveFromDate = new Date(today.getTime() + ONE_DAY_MS);
      if (existing.validTo !== null && effectiveFromDate > existing.validTo) {
        return jsonError(
          409,
          { code: 'ASSIGNMENT_ENDS_TOMORROW', message: 'The current assignment already ends today, so it cannot be changed from tomorrow.' },
          requestId
        );
      }
    }
  }
  const movesOpenShift = Boolean(openShift) && normalizedHandling === 'MOVE_TO_NEW' && effectiveFromDate <= today;

  const newValidTo = existing.validTo;

  // Overlap against *other* assignments (the one being changed is about to be closed to
  // effectiveFrom - 1, so exclude it from this check).
  const overlap = await checkOverlap({
    employeeId: existing.employeeId,
    siteId: siteId as string,
    workAreaId: normalizedWorkAreaId,
    validFrom: effectiveFromDate,
    validTo: newValidTo,
    excludeAssignmentId: existing.id
  });
  if (overlap.hasOverlap) {
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_OVERLAP',
        message: 'The worker already has another assignment on this site and customer covering that date range.',
        fieldErrors: { effectiveFrom: ['overlaps an existing assignment'] }
      },
      requestId
    );
  }

  // Submitted / recorded time STRICTLY AFTER the day the old assignment will end can't be
  // restructured here. For a future change that day is effectiveFrom − 1 (so time on/after
  // effectiveFrom blocks, as before). For an immediate change the old assignment keeps `today`
  // whenever the worker already worked it (§P5), so only time dated after today blocks — today's
  // own completed interval stays on the old site and the transfer proceeds.
  const isImmediateChange = effectiveFromDate.getTime() <= today.getTime();
  const oldAssignmentLastDay = isImmediateChange ? today : new Date(effectiveFromDate.getTime() - ONE_DAY_MS);
  const [submittedSegments, submittedShifts, recordedDraftSegments, recordedFragments] = await Promise.all([
    prisma.workSegment.count({ where: { sourceAssignmentId: existing.id, date: { gt: oldAssignmentLastDay } } }),
    prisma.timesheetPlannedShift.count({ where: { sourceAssignmentId: existing.id, date: { gt: oldAssignmentLastDay } } }),
    prisma.timesheetDraftSegment.count({ where: { sourceAssignmentId: existing.id, date: { gt: oldAssignmentLastDay } } }),
    prisma.clockShiftFragment.count({ where: { sourceAssignmentId: existing.id, date: { gt: oldAssignmentLastDay } } })
  ]);
  if (submittedSegments > 0 || submittedShifts > 0) {
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_HAS_SUBMITTED_TIME',
        message: 'This assignment has hours in a submitted timesheet on or after that date. Set the change date after the current period, or adjust the timesheet first.'
      },
      requestId
    );
  }
  if (recordedDraftSegments > 0 || recordedFragments > 0) {
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_HAS_RECORDED_TIME',
        message: 'The worker has already recorded hours on this assignment on or after that date. Change from tomorrow, or fix the site on the day in the timesheet.'
      },
      requestId
    );
  }

  // R15-D7 — the single writer (§2.4): close the old assignment + open the replacement + re-point
  // the open shift + write the AssignmentTransition + AuditEvent, one transaction, advisory lock.
  const result = await changeWorkplace({
    existing,
    effectiveFrom: effectiveFromDate,
    siteId: siteId as string,
    workAreaId: normalizedWorkAreaId,
    templateVersionId,
    isPrimary: normalizedIsPrimary,
    newValidTo,
    movesOpenShift,
    openShiftPresent: Boolean(openShift),
    reasonText: trimmedReason,
    actorUserId: authenticated.user.id,
    requestId,
    primaryConflictResolution: normalizedPrimaryResolution
  });

  if ('code' in result) {
    if (result.code === 'ASSIGNMENT_OVERLAP') {
      return jsonError(
        409,
        {
          code: 'ASSIGNMENT_OVERLAP',
          message: 'The worker already has another assignment on this site and customer covering that date range.',
          fieldErrors: { effectiveFrom: ['overlaps an existing assignment'] }
        },
        requestId
      );
    }
    if (result.code === 'SCHEDULED_PRIMARY_CONFLICT') {
      return jsonError(
        409,
        {
          code: 'SCHEDULED_PRIMARY_CONFLICT',
          message: `This worker already has a primary transfer scheduled to start on ${result.scheduledValidFrom}. Choose to keep that scheduled transfer (this move is made non-primary) or replace it (the scheduled transfer stays but loses its primary status). Re-send with primaryConflictResolution.`,
          scheduledAssignmentId: result.scheduledAssignmentId,
          scheduledValidFrom: result.scheduledValidFrom
        },
        requestId
      );
    }
    if (result.code === 'PRIMARY_PERIOD_CONFLICT') {
      return jsonError(
        409,
        { code: 'PRIMARY_PERIOD_CONFLICT', message: 'The worker already has a primary assignment covering that period — refresh the card and try again.' },
        requestId
      );
    }
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_HAS_RECORDED_TIME',
        message: 'The worker has already recorded hours on this assignment on or after that date. Change from tomorrow, or fix the site on the day in the timesheet.'
      },
      requestId
    );
  }

  return NextResponse.json(
    {
      closedAssignmentId: existing.id,
      closedValidTo: formatDate(result.closedValidTo),
      effectiveFrom: formatDate(result.effectiveFrom),
      openShiftHandling: result.openShiftHandling,
      newAssignment: {
        id: result.newAssignment.id,
        employeeId: result.newAssignment.employeeId,
        siteId: result.newAssignment.siteId,
        workAreaId: result.newAssignment.workAreaId,
        templateVersionId: result.newAssignment.templateVersionId,
        isPrimary: result.newAssignment.isPrimary,
        validFrom: formatDate(result.newAssignment.validFrom),
        validTo: result.newAssignment.validTo ? formatDate(result.newAssignment.validTo) : null,
        version: result.newAssignment.version,
        createdAt: result.newAssignment.createdAt.toISOString(),
        updatedAt: result.newAssignment.updatedAt.toISOString()
      }
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
