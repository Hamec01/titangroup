import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { requestCorrection, listCorrections } from '@/lib/corrections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 / 02_ROLE_PERMISSION_MATRIX.md §2.9 — T7.9,
// ADMIN-only first slice. No dedicated correction.read permission exists in the matrix — gated on
// correction.request itself (the baseline "can see/interact with corrections" grant for this slice).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'correction.request'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get('status');
  const status = statusParam && ['PENDING', 'DRAFT_OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED'].includes(statusParam) ? statusParam : undefined;

  const items = await listCorrections(status);
  return NextResponse.json({ items }, { status: 200, headers: successHeaders(requestId) });
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
  if (!(await hasPermission(authenticated.user.roles, 'correction.request'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { timesheetId, reason } = bodyObject as { timesheetId?: unknown; reason?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof timesheetId !== 'string' || !UUID_PATTERN.test(timesheetId)) {
    fieldErrors.timesheetId = ['required, must be a UUID'];
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    fieldErrors.reason = ['required'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId);
  }

  const result = await requestCorrection(timesheetId as string, authenticated.user.id, (reason as string).trim(), requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'TIMESHEET_NOT_FOUND':
        return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Only a FINAL_APPROVED timesheet can be corrected.' }, requestId);
      case 'CORRECTION_ALREADY_OPEN':
        return jsonError(409, { code: 'CORRECTION_ALREADY_OPEN', message: 'A correction is already open for this timesheet.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 201, headers: successHeaders(requestId) });
}
