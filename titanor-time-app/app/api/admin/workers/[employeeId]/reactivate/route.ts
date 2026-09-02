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

// Inverse of POST /api/admin/workers/[employeeId]/deactivate — brings a worker whose employment
// was ended back to a working state. Same shape and guards as the sibling deactivate route:
// same CSRF header, same malformed-id → 404 (no oracle), no Idempotency-Key (a bare retry against
// an already-active worker is safe on its own → 409 ALREADY_ACTIVE). Reuses the worker.deactivate
// permission — the same ADMIN/SUPER_ADMIN roles own the whole employment lifecycle.
//
// Undoes exactly what deactivate changed: Employment.active/endDate/deactivationReason and
// User.status. It does NOT touch SiteAssignment rows (deactivate leaves them; contract in
// _test-t9-setup-lifecycle.ts step 16) and does NOT resurrect revoked sessions — the worker
// signs in again, which is the normal path.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const MAX_REASON_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ employeeId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'worker.deactivate'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  }

  // Body is optional; only an optional free-text reason is read.
  let trimmedReason: string | null = null;
  const rawText = await request.text();
  if (rawText.trim().length > 0) {
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(rawText);
    } catch {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
    }
    const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
    const { reason } = bodyObject as { reason?: unknown };
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== 'string' || reason.trim().length > MAX_REASON_LENGTH) {
        return NextResponse.json(
          errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { reason: ['invalid'] } }, requestId),
          { status: 400, headers: successHeaders(requestId) }
        );
      }
      trimmedReason = reason.trim() || null;
    }
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employments: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, active: true } },
      user: { select: { id: true, status: true } }
    }
  });

  if (!employee) {
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  }

  const employment = employee.employments[0];
  if (!employment) {
    // No Employment row at all — nothing to reactivate; the admin-first create flow always makes one.
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'This worker has no employment record.' }, requestId);
  }
  if (employment.active) {
    return jsonError(409, { code: 'ALREADY_ACTIVE', message: 'This worker is already active.' }, requestId);
  }

  // Same data-integrity invariant as the deactivate route.
  if (!employee.user) {
    throw new Error(`Employee ${employeeId} has no linked User — data integrity invariant violated.`);
  }
  const user = employee.user;
  const previousUserStatus = user.status;

  await prisma.$transaction(async (tx) => {
    await tx.employment.update({
      where: { id: employment.id },
      data: { active: true, endDate: null, deactivationReason: null }
    });

    await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'WORKER_REACTIVATED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      requestId,
      beforeValue: { employeeId, employmentActive: false, userStatus: previousUserStatus },
      afterValue: {
        employeeId,
        employmentActive: true,
        userStatus: 'ACTIVE',
        ...(trimmedReason ? { reason: trimmedReason } : {})
      }
    });
  });

  return NextResponse.json(
    { employeeId, employmentActive: true, userStatus: 'ACTIVE' },
    { status: 200, headers: successHeaders(requestId) }
  );
}
