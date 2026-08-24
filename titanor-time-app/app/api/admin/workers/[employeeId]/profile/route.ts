import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeProfileView, updateEmployeeProfileFields, validateProfileFields } from '@/lib/employee-profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }
  const view = await getEmployeeProfileView(employeeId, true);
  if (!view) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }
  return NextResponse.json(view, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.update.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { version, dateOfBirth, specialty, skills } = bodyObject as {
    version?: unknown;
    dateOfBirth?: unknown;
    specialty?: unknown;
    skills?: unknown;
  };

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'version is required.', fieldErrors: { version: ['required'] } }, requestId);
  }

  const fields: { dateOfBirth?: Date | null; specialty?: string | null; skills?: string | null } = {};
  if (dateOfBirth !== undefined) {
    if (dateOfBirth === null) {
      fields.dateOfBirth = null;
    } else if (typeof dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid dateOfBirth.', fieldErrors: { dateOfBirth: ['invalid'] } }, requestId);
    } else {
      fields.dateOfBirth = new Date(`${dateOfBirth}T00:00:00.000Z`);
    }
  }
  if (specialty !== undefined) {
    if (specialty !== null && typeof specialty !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid specialty.', fieldErrors: { specialty: ['invalid'] } }, requestId);
    }
    fields.specialty = specialty;
  }
  if (skills !== undefined) {
    if (skills !== null && typeof skills !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid skills.', fieldErrors: { skills: ['invalid'] } }, requestId);
    }
    fields.skills = skills;
  }

  const fieldErrors = validateProfileFields(fields);
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId);
  }

  const result = await updateEmployeeProfileFields({ employeeId, version, actorUserId: authenticated.user.id, requestId, fields });
  if (!result.ok) {
    if (result.code === 'EMPLOYEE_NOT_FOUND') {
      return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
    }
    return jsonError(409, { code: 'VERSION_CONFLICT', message: 'This profile was changed elsewhere. Reload and try again.' }, requestId);
  }
  return NextResponse.json({ version: result.version }, { status: 200, headers: successHeaders(requestId) });
}
