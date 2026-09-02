import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';
import { createAssignment, isExclusionViolation, listAssignments } from '@/lib/assignments';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/assignments';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'assignment.read.all'))) {
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

  const result = await listAssignments(page, pageSize);
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

  if (!(await hasPermission(authenticated.user.roles, 'assignment.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is mandatory for this endpoint (§6: "Idempotency: обязателен").
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

  const { employeeId, siteId, workAreaId, templateId, validFrom, validTo, isPrimary, primaryConflictResolution } = bodyObject as {
    employeeId?: unknown;
    siteId?: unknown;
    workAreaId?: unknown;
    templateId?: unknown;
    validFrom?: unknown;
    validTo?: unknown;
    isPrimary?: unknown;
    primaryConflictResolution?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof employeeId !== 'string' || !UUID_PATTERN.test(employeeId)) {
    fieldErrors.employeeId = ['required'];
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
  if (typeof validFrom !== 'string' || !DATE_PATTERN.test(validFrom)) {
    fieldErrors.validFrom = ['required'];
  }
  let normalizedValidTo: Date | null = null;
  if (validTo !== undefined && validTo !== null) {
    if (typeof validTo !== 'string' || !DATE_PATTERN.test(validTo)) {
      fieldErrors.validTo = ['invalid'];
    } else {
      normalizedValidTo = new Date(`${validTo}T00:00:00.000Z`);
    }
  }
  let normalizedIsPrimary = false;
  if (isPrimary !== undefined) {
    if (typeof isPrimary !== 'boolean') {
      fieldErrors.isPrimary = ['invalid'];
    } else {
      normalizedIsPrimary = isPrimary;
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

  if (
    typeof validFrom === 'string' &&
    DATE_PATTERN.test(validFrom) &&
    normalizedValidTo !== null &&
    normalizedValidTo < new Date(`${validFrom}T00:00:00.000Z`)
  ) {
    fieldErrors.validTo = ['before validFrom'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  let result;
  try {
    result = await createAssignment({
      employeeId: employeeId as string,
      siteId: siteId as string,
      workAreaId: normalizedWorkAreaId,
      templateId: normalizedTemplateId,
      validFrom: new Date(`${validFrom as string}T00:00:00.000Z`),
      validTo: normalizedValidTo,
      isPrimary: normalizedIsPrimary,
      assignedByUserId: authenticated.user.id,
      requestId,
      primaryConflictResolution: normalizedPrimaryResolution
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      return respond(409, errorBody({ code: 'ASSIGNMENT_OVERLAP', message: 'Employee already has an active assignment for this site and work area.' }, requestId));
    }
    throw error;
  }

  if ('code' in result) {
    switch (result.code) {
      case 'EMPLOYEE_NOT_FOUND':
        return respond(404, errorBody({ code: 'EMPLOYEE_NOT_FOUND', message: 'employeeId does not reference an existing employee.' }, requestId));
      case 'SITE_NOT_FOUND':
        return respond(404, errorBody({ code: 'SITE_NOT_FOUND', message: 'siteId does not reference an existing site.' }, requestId));
      case 'WORK_AREA_NOT_FOUND':
        return respond(404, errorBody({ code: 'WORK_AREA_NOT_FOUND', message: 'workAreaId does not reference an existing work area on this site.' }, requestId));
      case 'TEMPLATE_NOT_FOUND':
        return respond(404, errorBody({ code: 'TEMPLATE_NOT_FOUND', message: 'templateId does not reference an existing template.' }, requestId));
      case 'EMPLOYEE_NOT_ACTIVE':
        return respond(409, errorBody({ code: 'EMPLOYEE_NOT_ACTIVE', message: 'This employee’s employment is not active.' }, requestId));
      case 'ASSIGNMENT_OVERLAP':
        return respond(
          409,
          errorBody(
            {
              code: 'ASSIGNMENT_OVERLAP',
              message: 'Employee already has an active assignment for this site and work area',
              fieldErrors: { validFrom: ['Assignment overlaps an existing assignment on the same site'] }
            },
            requestId
          )
        );
      case 'PRIMARY_PERIOD_CONFLICT':
        return respond(
          409,
          errorBody(
            { code: 'PRIMARY_PERIOD_CONFLICT', message: 'This worker already has a primary assignment covering that period. Refresh and try again.' },
            requestId
          )
        );
      case 'SCHEDULED_PRIMARY_CONFLICT':
        return respond(
          409,
          errorBody(
            {
              code: 'SCHEDULED_PRIMARY_CONFLICT',
              message: `This worker has a primary transfer scheduled to start on ${result.scheduledValidFrom}. Re-send with primaryConflictResolution: "KEEP_SCHEDULED" (this assignment is created non-primary) or "REPLACE_SCHEDULED" (the scheduled transfer keeps its assignment but loses primary status).`,
              scheduledAssignmentId: result.scheduledAssignmentId,
              scheduledValidFrom: result.scheduledValidFrom
            },
            requestId
          )
        );
    }
  }

  const assignment = result as Exclude<typeof result, { code: string }>;

  return respond(201, assignment);
}
