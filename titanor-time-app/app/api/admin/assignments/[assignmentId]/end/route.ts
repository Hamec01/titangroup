import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { earliestAssignmentEndDate } from '@/lib/workers';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REASON_LENGTH = 2000;
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle) — same pattern already used by
// this route family's own POST /api/admin/assignments/validate-overlap and .../split.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// fn_site_assignment_dependents_guard (05_RAW_SQL_REGISTER.md, TRG-11) raises this — as a plain
// P0001, not a typed Prisma code — when a validTo shrink would leave a WorkSegment /
// TimesheetPlannedShift / TimesheetDraftSegment / TimesheetDraftPlannedShift row for this
// assignment stranded outside its own window. Match the stable identifier text only.
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

  if (!(await hasPermission(authenticated.user.roles, 'assignment.end'))) {
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
  const { validTo, reason } = bodyObject as { validTo?: unknown; reason?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof validTo !== 'string' || !DATE_PATTERN.test(validTo)) {
    fieldErrors.validTo = ['required'];
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
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const newValidTo = new Date(`${validTo as string}T00:00:00.000Z`);

  if (newValidTo < existing.validFrom) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { validTo: ['before validFrom'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }
  // "end" only ever shrinks — 02_ROLE_PERMISSION_MATRIX.md's assignment.end
  // row is entirely about ending early; extending validTo would risk
  // newly overlapping another assignment (the EXCLUDE constraint only
  // protects against that on INSERT of a different row, not on widening this
  // one), and isn't what this endpoint's name implies. Not a documented
  // error code, so this maps to the generic VALIDATION_ERROR too.
  if (existing.validTo !== null && newValidTo > existing.validTo) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { validTo: ['must not be later than the current validTo'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  // 02_ROLE_PERMISSION_MATRIX.md: "Причина: да, если раньше плана" — required
  // only when ending earlier than whatever was previously planned (a null
  // validTo counts as "never", so any concrete date here is earlier than that).
  const isEarlierThanPlanned = existing.validTo === null || newValidTo.getTime() < existing.validTo.getTime();
  if (isEarlierThanPlanned && trimmedReason === null) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { reason: ['required when ending earlier than planned'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  // Real recorded / submitted time on a day after the new end date can't be dropped here — those
  // block the end with an actionable 409 (the admin adjusts the timesheet, or ends later). But an
  // assignment's own *draft planned shifts* after the end date are just "the schedule expects
  // work here" — auto-materialised across the whole open period at assignment.create time. When
  // the worker is being removed they carry no information, so they are deleted below so that
  // "end today" actually works instead of being pushed to the end of the period.
  const [recordedSegments, submittedShifts, recordedDraftSegments, recordedFragments] = await Promise.all([
    prisma.workSegment.count({ where: { sourceAssignmentId: existing.id, date: { gt: newValidTo } } }),
    prisma.timesheetPlannedShift.count({ where: { sourceAssignmentId: existing.id, date: { gt: newValidTo } } }),
    prisma.timesheetDraftSegment.count({ where: { sourceAssignmentId: existing.id, date: { gt: newValidTo } } }),
    prisma.clockShiftFragment.count({ where: { sourceAssignmentId: existing.id, date: { gt: newValidTo } } })
  ]);
  if (recordedSegments > 0 || submittedShifts > 0 || recordedDraftSegments > 0 || recordedFragments > 0) {
    const earliest = await earliestAssignmentEndDate(existing.id);
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_HAS_RECORDED_TIME',
        message: 'The worker has recorded or submitted hours on this assignment after the chosen end date. End it on or after that day, or adjust the timesheet first.',
        fieldErrors: { validTo: ['must not be earlier than the last recorded or submitted day'] },
        ...(earliest ? { earliestValidTo: earliest } : {})
      },
      requestId
    );
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.timesheetDraftPlannedShift.deleteMany({
        where: { sourceAssignmentId: existing.id, date: { gt: newValidTo } }
      });

      const assignment = await tx.siteAssignment.update({
        where: { id: existing.id },
        data: {
          validTo: newValidTo,
          ...(trimmedReason !== null ? { endedReason: trimmedReason } : {}),
          version: { increment: 1 }
        }
      });

      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'ASSIGNMENT_ENDED',
        entityType: 'SITE_ASSIGNMENT',
        entityId: assignment.id,
        requestId,
        beforeValue: { validTo: existing.validTo ? formatDate(existing.validTo) : null },
        afterValue: { validTo: formatDate(assignment.validTo!), reason: trimmedReason }
      });

      return assignment;
    });
  } catch (error) {
    // Last-resort safety net — the prechecks above should have caught every real case.
    if (isAssignmentDependentsConflict(error)) {
      const earliest = await earliestAssignmentEndDate(existing.id);
      return jsonError(
        409,
        {
          code: 'ASSIGNMENT_HAS_RECORDED_TIME',
          message: 'The worker has recorded or submitted hours on this assignment after the chosen end date.',
          fieldErrors: { validTo: ['must not be earlier than the last recorded or submitted day'] },
          ...(earliest ? { earliestValidTo: earliest } : {})
        },
        requestId
      );
    }
    throw error;
  }

  return NextResponse.json(
    {
      id: updated.id,
      employeeId: updated.employeeId,
      siteId: updated.siteId,
      workAreaId: updated.workAreaId,
      templateVersionId: updated.templateVersionId,
      isPrimary: updated.isPrimary,
      validFrom: formatDate(updated.validFrom),
      validTo: updated.validTo ? formatDate(updated.validTo) : null,
      endedReason: updated.endedReason,
      version: updated.version,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
