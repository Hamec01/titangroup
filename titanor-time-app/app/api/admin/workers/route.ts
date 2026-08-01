import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';
import { listWorkers } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/workers';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// Not specified by the contract — pragmatic bounds, same style as
// MAX_NAME_LENGTH in app/api/admin/sites/route.ts. employeeNumber is capped
// at 64 to fit User.username (@db.VarChar(64)), since it becomes the
// worker's login username 1:1 (see below).
const MAX_NAME_LENGTH = 128;
const MAX_PHONE_LENGTH = 32;
const MAX_EMPLOYEE_NUMBER_LENGTH = 64;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'worker.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize =
    Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE
      ? pageSizeParam
      : DEFAULT_PAGE_SIZE;

  const result = await listWorkers(page, pageSize);

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'worker.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is mandatory for this endpoint (§0: "Idempotency: обязателен").
  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(
      400,
      { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' },
      requestId
    );
  }
  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  const requestHash = computeRequestHash({ body: bodyObject });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(
      409,
      {
        code: begin.code,
        message:
          begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS'
            ? 'A request with this Idempotency-Key is still being processed.'
            : 'This Idempotency-Key was already used for a different request.'
      },
      requestId
    );
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const { firstName, lastName, phone, employeeNumber } = bodyObject as {
    firstName?: unknown;
    lastName?: unknown;
    phone?: unknown;
    employeeNumber?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  let trimmedFirstName = '';
  let trimmedLastName = '';
  if (typeof firstName !== 'string' || firstName.trim().length === 0) {
    fieldErrors.firstName = ['required'];
  } else if (firstName.trim().length > MAX_NAME_LENGTH) {
    fieldErrors.firstName = ['too long'];
  } else {
    trimmedFirstName = firstName.trim();
  }

  if (typeof lastName !== 'string' || lastName.trim().length === 0) {
    fieldErrors.lastName = ['required'];
  } else if (lastName.trim().length > MAX_NAME_LENGTH) {
    fieldErrors.lastName = ['too long'];
  } else {
    trimmedLastName = lastName.trim();
  }

  let normalizedPhone: string | null = null;
  if (phone !== undefined && phone !== null) {
    if (typeof phone !== 'string' || phone.trim().length === 0 || phone.trim().length > MAX_PHONE_LENGTH) {
      fieldErrors.phone = ['invalid'];
    } else {
      normalizedPhone = phone.trim();
    }
  }

  let requestedEmployeeNumber: string | null = null;
  if (employeeNumber !== undefined && employeeNumber !== null) {
    if (
      typeof employeeNumber !== 'string' ||
      employeeNumber.trim().length === 0 ||
      employeeNumber.trim().length > MAX_EMPLOYEE_NUMBER_LENGTH
    ) {
      fieldErrors.employeeNumber = ['invalid'];
    } else {
      requestedEmployeeNumber = employeeNumber.trim();
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // employeeNumber can be supplied or generated
      // (01_SCREEN_MAP.md /admin/workers/new: "employee number — можно
      // сгенерировать"). Not specified further by any doc — this task's own
      // pragmatic choice: next integer after the current numeric max,
      // starting at 1000. Race-safety relies on Employee.employeeNumber's
      // DB-level UNIQUE constraint (caught below as DUPLICATE_EMPLOYEE_NUMBER),
      // not an advisory lock — a collision here is a rare, cleanly retryable
      // 409, unlike the single-SUPER_ADMIN invariant that bootstrap-super-admin.ts
      // guards with pg_advisory_xact_lock.
      let finalEmployeeNumber = requestedEmployeeNumber;
      if (finalEmployeeNumber === null) {
        const rows = await tx.$queryRaw<{ next: number }[]>(
          Prisma.sql`SELECT COALESCE(MAX(("employeeNumber")::int), 999) + 1 AS next FROM "Employee" WHERE "employeeNumber" ~ '^[0-9]+$'`
        );
        finalEmployeeNumber = String(rows[0].next);
      }

      // Worker logs in with employeeNumber as username (matches the
      // GET /api/admin/workers and POST /auth/login examples in
      // 04_ADMIN_FIRST_API_CONTRACTS.md, both using "1042"). Normalized the
      // same way login's identifier is (lowercase) for consistency, even
      // though employeeNumber is usually digits-only.
      const username = finalEmployeeNumber.toLowerCase();

      const employee = await tx.employee.create({
        data: {
          employeeNumber: finalEmployeeNumber,
          firstName: trimmedFirstName,
          lastName: trimmedLastName,
          phone: normalizedPhone
        }
      });

      const user = await tx.user.create({
        data: {
          username,
          status: 'PENDING_ACTIVATION',
          locale: 'FI',
          employeeId: employee.id
        }
      });

      await tx.employment.create({
        data: {
          employeeId: employee.id,
          active: true,
          startDate: new Date(new Date().toISOString().slice(0, 10))
        }
      });

      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'WORKER_CREATED',
        entityType: 'EMPLOYEE',
        entityId: employee.id,
        requestId,
        beforeValue: null,
        afterValue: {
          id: employee.id,
          employeeNumber: employee.employeeNumber,
          firstName: employee.firstName,
          lastName: employee.lastName,
          userId: user.id,
          userStatus: user.status
        }
      });

      return { employee, userId: user.id, userStatus: user.status };
    });

    return respond(201, {
      employee: {
        id: created.employee.id,
        employeeNumber: created.employee.employeeNumber,
        firstName: created.employee.firstName,
        lastName: created.employee.lastName,
        phone: created.employee.phone,
        version: created.employee.version,
        createdAt: created.employee.createdAt.toISOString(),
        updatedAt: created.employee.updatedAt.toISOString()
      },
      userId: created.userId,
      userStatus: created.userStatus
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return respond(
        409,
        errorBody(
          { code: 'DUPLICATE_EMPLOYEE_NUMBER', message: 'employeeNumber (or the username derived from it) is already in use.' },
          requestId
        )
      );
    }
    throw error;
  }
}
