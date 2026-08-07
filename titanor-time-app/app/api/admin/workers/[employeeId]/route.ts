import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { getWorkerDetail } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
// Same bounds as POST /api/admin/workers/route.ts — not specified by the
// contract, kept consistent with the fields' original validation.
const MAX_NAME_LENGTH = 128;
const MAX_PHONE_LENGTH = 32;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ employeeId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'worker.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;
  const detail = await getWorkerDetail(employeeId);
  if (!detail) {
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'worker.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { version, firstName, lastName, phone } = bodyObject as {
    version?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    phone?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fieldErrors.version = ['required'];
  }

  // Partial update: only fields actually present in the body are validated
  // and written. employeeNumber is not editable here — it's a separate HR
  // identifier from User.username (lib/worker-usernames.ts), and this
  // endpoint's own error list (404/409 VERSION_CONFLICT/400) has no
  // DUPLICATE_EMPLOYEE_NUMBER case, unlike creation. Editing firstName/lastName here
  // deliberately does NOT touch User.username — renaming the login is a separate,
  // explicit action (POST .../regenerate-username), never an automatic side effect
  // of correcting a name.
  const data: Prisma.EmployeeUpdateInput = {};

  if (firstName !== undefined) {
    if (typeof firstName !== 'string' || firstName.trim().length === 0 || firstName.trim().length > MAX_NAME_LENGTH) {
      fieldErrors.firstName = ['invalid'];
    } else {
      data.firstName = firstName.trim();
    }
  }
  if (lastName !== undefined) {
    if (typeof lastName !== 'string' || lastName.trim().length === 0 || lastName.trim().length > MAX_NAME_LENGTH) {
      fieldErrors.lastName = ['invalid'];
    } else {
      data.lastName = lastName.trim();
    }
  }
  if (phone !== undefined) {
    if (phone !== null && (typeof phone !== 'string' || phone.trim().length === 0 || phone.trim().length > MAX_PHONE_LENGTH)) {
      fieldErrors.phone = ['invalid'];
    } else {
      data.phone = phone === null ? null : (phone as string).trim();
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  data.version = { increment: 1 };

  // Atomic compare-and-swap on version (avoids a read-then-write race between
  // checking the version and applying the update) + the audit write, in one
  // transaction — lib/audit.ts's invariant ("Действие + AuditEvent — одна
  // транзакция") requires the update and its audit row to commit/roll back
  // together, not as two separate round trips.
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.employee.updateMany({
      where: { id: employeeId, version: version as number },
      data
    });

    if (result.count === 0) {
      return null;
    }

    const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'WORKER_UPDATED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      requestId,
      beforeValue: null,
      afterValue: {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        phone: employee.phone,
        version: employee.version
      }
    });

    return employee;
  });

  if (!updated) {
    const stillExists = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
    if (!stillExists) {
      return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
    }
    return jsonError(
      409,
      { code: 'VERSION_CONFLICT', message: 'The worker was modified by someone else — reload and try again.' },
      requestId
    );
  }

  return NextResponse.json(
    {
      id: updated.id,
      employeeNumber: updated.employeeNumber,
      firstName: updated.firstName,
      lastName: updated.lastName,
      phone: updated.phone,
      version: updated.version,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
