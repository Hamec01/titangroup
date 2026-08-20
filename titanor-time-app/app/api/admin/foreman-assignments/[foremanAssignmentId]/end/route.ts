import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Contract designed by this task (same as POST/GET /api/admin/foreman-assignments
// — 04_ADMIN_FIRST_API_CONTRACTS.md has no admin-facing foreman-assignment
// endpoints, see PROJECT_ROADMAP.md T6.9), confirmed by the owner. Simpler
// than POST /api/admin/assignments/:assignmentId/end: ForemanAssignment has
// no endedReason column at all (03_DATA_MODEL_ERD.md §4.4 never gave it
// one, unlike SiteAssignment), so there's no reason field here, and no
// shrink-only restriction either — ForemanAssignment has no EXCLUDE
// constraint (unlike SiteAssignment's EX-02), so widening validTo carries
// no DB-conflict risk this endpoint needs to guard against.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type RouteParams = { params: Promise<{ foremanAssignmentId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'foreman_assignment.end'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { foremanAssignmentId } = await params;
  if (!UUID_PATTERN.test(foremanAssignmentId)) {
    return jsonError(404, { code: 'FOREMAN_ASSIGNMENT_NOT_FOUND', message: 'No foreman assignment with this id.' }, requestId);
  }

  const existing = await prisma.foremanAssignment.findUnique({ where: { id: foremanAssignmentId } });
  if (!existing) {
    return jsonError(404, { code: 'FOREMAN_ASSIGNMENT_NOT_FOUND', message: 'No foreman assignment with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { validTo } = bodyObject as { validTo?: unknown };

  if (typeof validTo !== 'string' || !DATE_PATTERN.test(validTo)) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { validTo: ['required'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const newValidTo = new Date(`${validTo}T00:00:00.000Z`);
  if (newValidTo < existing.validFrom) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { validTo: ['before validFrom'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const assignment = await tx.foremanAssignment.update({
      where: { id: existing.id },
      data: { validTo: newValidTo }
    });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'FOREMAN_ASSIGNMENT_ENDED',
      entityType: 'FOREMAN_ASSIGNMENT',
      entityId: assignment.id,
      requestId,
      beforeValue: { validTo: existing.validTo ? formatDate(existing.validTo) : null },
      afterValue: { validTo: formatDate(assignment.validTo!) }
    });

    return assignment;
  });

  return NextResponse.json(
    {
      id: updated.id,
      foremanUserId: updated.foremanUserId,
      siteId: updated.siteId,
      isSubstitute: updated.isSubstitute,
      validFrom: formatDate(updated.validFrom),
      validTo: updated.validTo ? formatDate(updated.validTo) : null,
      assignedByUserId: updated.assignedByUserId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
