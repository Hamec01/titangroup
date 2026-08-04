import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { checkOverlap, isExclusionViolation } from '@/lib/assignments';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
  const { effectiveFrom, siteId, workAreaId, templateId, isPrimary } = bodyObject as {
    effectiveFrom?: unknown;
    siteId?: unknown;
    workAreaId?: unknown;
    templateId?: unknown;
    isPrimary?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof effectiveFrom !== 'string' || !DATE_PATTERN.test(effectiveFrom)) {
    fieldErrors.effectiveFrom = ['required'];
  }
  if (typeof siteId !== 'string' || !UUID_PATTERN.test(siteId)) {
    fieldErrors.siteId = ['required'];
  }
  let normalizedWorkAreaId: string | null = null;
  if (workAreaId !== undefined && workAreaId !== null) {
    if (typeof workAreaId !== 'string' || !UUID_PATTERN.test(workAreaId)) {
      fieldErrors.workAreaId = ['invalid'];
    } else {
      normalizedWorkAreaId = workAreaId;
    }
  }
  let normalizedTemplateId: string | null = null;
  if (templateId !== undefined && templateId !== null) {
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

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const effectiveFromDate = new Date(`${effectiveFrom as string}T00:00:00.000Z`);
  if (effectiveFromDate <= existing.validFrom) {
    return NextResponse.json(
      errorBody(
        { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { effectiveFrom: ['must be after the assignment’s validFrom'] } },
        requestId
      ),
      { status: 400, headers: successHeaders(requestId) }
    );
  }
  // Not explicitly in the contract's error list (only "effectiveFrom <=
  // assignment.validFrom" is documented) — a reasonable extension: splitting
  // after an assignment has already ended has nothing left to split.
  if (existing.validTo !== null && effectiveFromDate > existing.validTo) {
    return NextResponse.json(
      errorBody(
        { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { effectiveFrom: ['after the assignment already ended'] } },
        requestId
      ),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const site = await prisma.workSite.findUnique({ where: { id: siteId as string }, select: { id: true } });
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

  const overlap = await checkOverlap({
    employeeId: existing.employeeId,
    siteId: siteId as string,
    workAreaId: normalizedWorkAreaId,
    validFrom: effectiveFromDate,
    validTo: existing.validTo,
    excludeAssignmentId: existing.id
  });
  if (overlap.hasOverlap) {
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_OVERLAP',
        message: 'The new assignment would overlap an existing assignment for this employee on this site and work area.',
        fieldErrors: { effectiveFrom: ['Assignment overlaps an existing assignment on the same site'] }
      },
      requestId
    );
  }

  const closedValidTo = new Date(effectiveFromDate.getTime() - ONE_DAY_MS);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.siteAssignment.update({
        where: { id: existing.id },
        data: { validTo: closedValidTo, version: { increment: 1 } }
      });

      const created = await tx.siteAssignment.create({
        data: {
          employeeId: existing.employeeId,
          siteId: siteId as string,
          workAreaId: normalizedWorkAreaId,
          templateVersionId,
          isPrimary: normalizedIsPrimary,
          validFrom: effectiveFromDate,
          validTo: existing.validTo,
          assignedByUserId: authenticated.user.id
        }
      });

      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'ASSIGNMENT_SPLIT',
        entityType: 'SITE_ASSIGNMENT',
        entityId: existing.id,
        requestId,
        beforeValue: {
          id: existing.id,
          siteId: existing.siteId,
          workAreaId: existing.workAreaId,
          templateVersionId: existing.templateVersionId,
          validTo: existing.validTo ? formatDate(existing.validTo) : null
        },
        afterValue: {
          closedAssignmentId: closed.id,
          closedValidTo: formatDate(closedValidTo),
          newAssignmentId: created.id,
          newSiteId: created.siteId,
          newWorkAreaId: created.workAreaId,
          newTemplateVersionId: created.templateVersionId
        }
      });

      return { closed, created };
    });

    return NextResponse.json(
      {
        closedAssignmentId: result.closed.id,
        closedValidTo: formatDate(closedValidTo),
        newAssignment: {
          id: result.created.id,
          employeeId: result.created.employeeId,
          siteId: result.created.siteId,
          workAreaId: result.created.workAreaId,
          templateVersionId: result.created.templateVersionId,
          isPrimary: result.created.isPrimary,
          validFrom: formatDate(result.created.validFrom),
          validTo: result.created.validTo ? formatDate(result.created.validTo) : null,
          assignedByUserId: result.created.assignedByUserId,
          version: result.created.version,
          createdAt: result.created.createdAt.toISOString(),
          updatedAt: result.created.updatedAt.toISOString()
        }
      },
      { status: 200, headers: successHeaders(requestId) }
    );
  } catch (error) {
    if (isExclusionViolation(error)) {
      return jsonError(
        409,
        { code: 'ASSIGNMENT_OVERLAP', message: 'The new assignment would overlap an existing assignment for this employee on this site and work area.' },
        requestId
      );
    }
    throw error;
  }
}
