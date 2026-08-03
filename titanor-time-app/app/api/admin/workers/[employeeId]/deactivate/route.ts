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

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 — exact contract for
// this endpoint. No Idempotency-Key handling here — unlike POST
// /api/admin/workers ("обязателен") and POST /api/admin/sites
// ("поддерживается"), this endpoint's contract entry has no Idempotency
// line at all; a bare retry is already safe on its own, since a second call
// against an already-deactivated worker just gets 409 ALREADY_DEACTIVATED.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const MAX_REASON_LENGTH = 2000;

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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { reason, endDate } = bodyObject as { reason?: unknown; endDate?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  let trimmedReason = '';
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    fieldErrors.reason = ['required'];
  } else if (reason.trim().length > MAX_REASON_LENGTH) {
    fieldErrors.reason = ['too long'];
  } else {
    trimmedReason = reason.trim();
  }

  const today = helsinkiToday();
  let effectiveEndDate = today;
  if (endDate !== undefined && endDate !== null) {
    if (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      fieldErrors.endDate = ['invalid'];
    } else {
      const parsed = new Date(`${endDate}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) {
        fieldErrors.endDate = ['invalid'];
      } else {
        effectiveEndDate = parsed;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employments: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, active: true, startDate: true } },
      user: { select: { id: true, status: true } }
    }
  });

  if (!employee) {
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  }

  const employment = employee.employments[0];
  if (!employment || !employment.active) {
    return jsonError(409, { code: 'ALREADY_DEACTIVATED', message: 'This worker is already deactivated.' }, requestId);
  }

  // Every Employee reachable through this admin-first flow has exactly one
  // linked User, created atomically alongside it by POST /api/admin/workers
  // — there is no other path that creates an Employee. Not a client-facing
  // error case (the contract's userStatus is a non-nullable union), so a
  // violation here throws (500) rather than being modeled as a handled state.
  if (!employee.user) {
    throw new Error(`Employee ${employeeId} has no linked User — data integrity invariant violated.`);
  }
  const user = employee.user;

  if (effectiveEndDate < employment.startDate) {
    return NextResponse.json(
      errorBody(
        { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { endDate: ['before employment start'] } },
        requestId
      ),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.employment.update({
      where: { id: employment.id },
      data: { active: false, endDate: effectiveEndDate, deactivationReason: trimmedReason }
    });

    // 03_DATA_MODEL_ERD.md §4.2 "Offboarding": DEACTIVATED immediately unless
    // the worker still has expected, unfinished payroll data in an OPEN
    // period intersecting dates <= endDate — "unfinished" includes a
    // participant with no Timesheet row yet at all, not only one that
    // exists but isn't FINAL_APPROVED yet.
    const hasUnfinishedPayrollData =
      (await tx.payrollPeriodParticipant.findFirst({
        where: {
          employeeId,
          expected: true,
          period: { status: 'OPEN', startDate: { lte: effectiveEndDate } },
          timesheets: { none: { status: 'FINAL_APPROVED' } }
        },
        select: { id: true }
      })) !== null;

    const userStatus = hasUnfinishedPayrollData ? 'OFFBOARDING' : 'DEACTIVATED';

    await tx.user.update({ where: { id: user.id }, data: { status: userStatus } });
    if (!hasUnfinishedPayrollData) {
      await tx.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'WORKER_DEACTIVATED',
      entityType: 'EMPLOYEE',
      entityId: employeeId,
      requestId,
      beforeValue: null,
      afterValue: {
        employeeId,
        employmentActive: false,
        endDate: effectiveEndDate.toISOString().slice(0, 10),
        reason: trimmedReason,
        userStatus
      }
    });

    return { userStatus };
  });

  return NextResponse.json(
    { employeeId, employmentActive: false, userStatus: result.userStatus },
    { status: 200, headers: successHeaders(requestId) }
  );
}
