import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { checkOverlap } from '@/lib/assignments';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
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
  const { employeeId, siteId, workAreaId, validFrom, validTo } = bodyObject as {
    employeeId?: unknown;
    siteId?: unknown;
    workAreaId?: unknown;
    validFrom?: unknown;
    validTo?: unknown;
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

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const result = await checkOverlap({
    employeeId: employeeId as string,
    siteId: siteId as string,
    workAreaId: normalizedWorkAreaId,
    validFrom: new Date(`${validFrom as string}T00:00:00.000Z`),
    validTo: normalizedValidTo
  });

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
