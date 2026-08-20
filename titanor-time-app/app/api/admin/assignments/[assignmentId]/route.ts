import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const MAX_ENDED_REASON_LENGTH = 2000;
// Fields the contract's own Request line for this endpoint never lists
// ({ "version", "isPrimary"?, "endedReason"? } only) — 02_ROLE_PERMISSION_MATRIX.md's
// assignment.update row explains why: changing them on an assignment that has
// already started needs assignment.split's atomic close+recreate, not a plain
// field edit. Detected here as an explicit reject rather than silently
// ignored, so a client attempting it gets a clear, actionable error.
const IMMUTABLE_AFTER_START_FIELDS = ['siteId', 'workAreaId', 'templateId', 'templateVersionId'] as const;
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle) — same pattern already used by
// this route family's own POST /api/admin/assignments/validate-overlap and .../split (for its
// siteId body field).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'assignment.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { assignmentId } = await params;
  if (!UUID_PATTERN.test(assignmentId)) {
    return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { version, isPrimary, endedReason } = bodyObject as {
    version?: unknown;
    isPrimary?: unknown;
    endedReason?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fieldErrors.version = ['required'];
  }

  const data: { isPrimary?: boolean; endedReason?: string | null } = {};
  if (isPrimary !== undefined) {
    if (typeof isPrimary !== 'boolean') {
      fieldErrors.isPrimary = ['invalid'];
    } else {
      data.isPrimary = isPrimary;
    }
  }
  if (endedReason !== undefined) {
    if (
      endedReason !== null &&
      (typeof endedReason !== 'string' || endedReason.trim().length === 0 || endedReason.length > MAX_ENDED_REASON_LENGTH)
    ) {
      fieldErrors.endedReason = ['invalid'];
    } else {
      data.endedReason = endedReason === null ? null : (endedReason as string).trim();
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const attemptedImmutableField = IMMUTABLE_AFTER_START_FIELDS.some((field) => field in bodyObject);
  if (attemptedImmutableField) {
    const existing = await prisma.siteAssignment.findUnique({ where: { id: assignmentId }, select: { validFrom: true } });
    if (!existing) {
      return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
    }
    if (existing.validFrom <= helsinkiToday()) {
      return jsonError(
        400,
        { code: 'ASSIGNMENT_ALREADY_STARTED', message: 'This assignment has already started — use assignment.split to change its site/work area/template.' },
        requestId
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.siteAssignment.updateMany({
      where: { id: assignmentId, version: version as number },
      data: { ...data, version: { increment: 1 } }
    });

    if (result.count === 0) {
      return null;
    }

    const assignment = await tx.siteAssignment.findUniqueOrThrow({ where: { id: assignmentId } });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'ASSIGNMENT_UPDATED',
      entityType: 'SITE_ASSIGNMENT',
      entityId: assignmentId,
      requestId,
      beforeValue: null,
      afterValue: {
        id: assignment.id,
        isPrimary: assignment.isPrimary,
        endedReason: assignment.endedReason,
        version: assignment.version
      }
    });

    return assignment;
  });

  if (!updated) {
    const stillExists = await prisma.siteAssignment.findUnique({ where: { id: assignmentId }, select: { id: true } });
    if (!stillExists) {
      return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
    }
    return jsonError(
      409,
      { code: 'VERSION_CONFLICT', message: 'The assignment was modified by someone else — reload and try again.' },
      requestId
    );
  }

  return NextResponse.json(
    {
      id: updated.id,
      employeeId: updated.employeeId,
      siteId: updated.siteId,
      workAreaId: updated.workAreaId,
      templateVersionId: updated.templateVersionId,
      isPrimary: updated.isPrimary,
      validFrom: updated.validFrom.toISOString().slice(0, 10),
      validTo: updated.validTo ? updated.validTo.toISOString().slice(0, 10) : null,
      endedReason: updated.endedReason,
      version: updated.version,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
