import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { checkOverlap, createAssignmentInTx, isExclusionViolation } from '@/lib/assignments';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — "Изменить объект / зону" on the worker
// card. One transaction: close the current assignment the day before `effectiveFrom`, open a
// fully-materialised replacement from `effectiveFrom` (same remaining validTo). Reuses the
// createAssignment materialisation so the new site/zone gets its own planned shifts for the rest
// of the open period. Backdating is forbidden. Nothing is physically deleted except the old
// assignment's *own* future draft planned shifts (re-created for the new assignment); a submitted
// timesheet or already-recorded time on/after the date blocks with a clear 409.
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

// fn_site_assignment_dependents_guard (05_RAW_SQL_REGISTER.md, TRG-11) raises this as a plain
// P0001 when a validTo shrink would strand a dependent row. The pre-checks below should catch
// every real case first — this is the last-resort safety net.
function isAssignmentDependentsConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('P0001') &&
    error.message.includes('ASSIGNMENT_DEPENDENTS_CONFLICT')
  );
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
  const { effectiveFrom, siteId, workAreaId, templateId, isPrimary, todayShiftHandling, reason } = bodyObject as {
    effectiveFrom?: unknown;
    siteId?: unknown;
    workAreaId?: unknown;
    templateId?: unknown;
    isPrimary?: unknown;
    todayShiftHandling?: unknown;
    reason?: unknown;
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

  // Submitted / recorded time on or after the change date can't be restructured here.
  const [submittedSegments, submittedShifts, recordedDraftSegments, recordedFragments] = await Promise.all([
    prisma.workSegment.count({ where: { sourceAssignmentId: existing.id, date: { gte: effectiveFromDate } } }),
    prisma.timesheetPlannedShift.count({ where: { sourceAssignmentId: existing.id, date: { gte: effectiveFromDate } } }),
    prisma.timesheetDraftSegment.count({ where: { sourceAssignmentId: existing.id, date: { gte: effectiveFromDate } } }),
    prisma.clockShiftFragment.count({ where: { sourceAssignmentId: existing.id, date: { gte: effectiveFromDate } } })
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

  let result: { closedValidTo: Date; newAssignmentId: string; newAssignment: Awaited<ReturnType<typeof createAssignmentInTx>> };
  try {
    result = await prisma.$transaction(async (tx) => {
      const closedValidTo = new Date(effectiveFromDate.getTime() - ONE_DAY_MS);

      // The old assignment's own future draft planned shifts are re-created for the new
      // assignment by createAssignmentInTx below — remove them first so closing the old
      // assignment doesn't trip the dependents guard.
      await tx.timesheetDraftPlannedShift.deleteMany({
        where: { sourceAssignmentId: existing.id, date: { gte: effectiveFromDate } }
      });

      await tx.siteAssignment.update({
        where: { id: existing.id },
        data: {
          validTo: closedValidTo,
          endedReason: trimmedReason ?? 'Изменение объекта / заказчика',
          version: { increment: 1 }
        }
      });

      const newAssignment = await createAssignmentInTx(tx, {
        employeeId: existing.employeeId,
        siteId: siteId as string,
        workAreaId: normalizedWorkAreaId,
        templateVersionId,
        validFrom: effectiveFromDate,
        validTo: newValidTo,
        isPrimary: normalizedIsPrimary,
        assignedByUserId: authenticated.user.id
      });

      if (movesOpenShift) {
        await tx.employeeOpenShift.update({
          where: { employeeId: existing.employeeId },
          data: { siteId: siteId as string, workAreaId: normalizedWorkAreaId, sourceAssignmentId: newAssignment.id }
        });
      }

      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'ASSIGNMENT_CHANGED',
        entityType: 'SITE_ASSIGNMENT',
        entityId: existing.id,
        requestId,
        beforeValue: {
          id: existing.id,
          siteId: existing.siteId,
          workAreaId: existing.workAreaId,
          templateVersionId: existing.templateVersionId,
          isPrimary: existing.isPrimary,
          validFrom: formatDate(existing.validFrom),
          validTo: existing.validTo ? formatDate(existing.validTo) : null
        },
        afterValue: {
          closedAssignmentId: existing.id,
          closedValidTo: formatDate(closedValidTo),
          effectiveFrom: formatDate(effectiveFromDate),
          newAssignmentId: newAssignment.id,
          newSiteId: newAssignment.siteId,
          newWorkAreaId: newAssignment.workAreaId,
          newTemplateVersionId: newAssignment.templateVersionId,
          newIsPrimary: newAssignment.isPrimary,
          openShiftHandling: openShift ? (movesOpenShift ? 'MOVE_TO_NEW' : 'KEEP_ON_OLD') : null
        },
        reason: trimmedReason
      });

      return { closedValidTo, newAssignmentId: newAssignment.id, newAssignment };
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      return jsonError(
        409,
        { code: 'ASSIGNMENT_OVERLAP', message: 'The worker already has another assignment on this site and customer covering that date range.' },
        requestId
      );
    }
    if (isAssignmentDependentsConflict(error)) {
      return jsonError(
        409,
        {
          code: 'ASSIGNMENT_HAS_RECORDED_TIME',
          message: 'The worker has already recorded hours on this assignment on or after that date. Change from tomorrow, or fix the site on the day in the timesheet.'
        },
        requestId
      );
    }
    throw error;
  }

  return NextResponse.json(
    {
      closedAssignmentId: existing.id,
      closedValidTo: formatDate(result.closedValidTo),
      effectiveFrom: formatDate(effectiveFromDate),
      openShiftHandling: openShift ? (movesOpenShift ? 'MOVE_TO_NEW' : 'KEEP_ON_OLD') : null,
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
