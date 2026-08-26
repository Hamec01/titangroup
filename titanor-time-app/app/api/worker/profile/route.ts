import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeProfileView, updateEmployeeProfileFields, validateProfileFields, type UpdateEmployeeProfileFieldsInput } from '@/lib/employee-profile';
import { normalizePersonalIdentityCode } from '@/lib/personal-identity-code';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This account has no employee profile.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const view = await getEmployeeProfileView(authenticated.user.employeeId, false);
  if (!view) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }
  return NextResponse.json(view, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This account has no employee profile.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.update.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { version, dateOfBirth, specialty, skills, personalIdentityCode, contactEmail, addressStreet, addressPostalCode, addressCity, addressCountry } = bodyObject as {
    version?: unknown;
    dateOfBirth?: unknown;
    specialty?: unknown;
    skills?: unknown;
    personalIdentityCode?: unknown;
    contactEmail?: unknown;
    addressStreet?: unknown;
    addressPostalCode?: unknown;
    addressCity?: unknown;
    addressCountry?: unknown;
  };

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'version is required.', fieldErrors: { version: ['required'] } }, requestId);
  }

  const fields: UpdateEmployeeProfileFieldsInput = {};
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
  if (personalIdentityCode !== undefined) {
    if (personalIdentityCode !== null && typeof personalIdentityCode !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid personalIdentityCode.', fieldErrors: { personalIdentityCode: ['invalid'] } }, requestId);
    }
    fields.personalIdentityCode = personalIdentityCode === null ? null : normalizePersonalIdentityCode(personalIdentityCode);
  }
  if (contactEmail !== undefined) {
    if (contactEmail !== null && typeof contactEmail !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid contactEmail.', fieldErrors: { contactEmail: ['invalid'] } }, requestId);
    }
    fields.contactEmail = contactEmail;
  }
  if (addressStreet !== undefined) {
    if (addressStreet !== null && typeof addressStreet !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid addressStreet.', fieldErrors: { addressStreet: ['invalid'] } }, requestId);
    }
    fields.addressStreet = addressStreet;
  }
  if (addressPostalCode !== undefined) {
    if (addressPostalCode !== null && typeof addressPostalCode !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid addressPostalCode.', fieldErrors: { addressPostalCode: ['invalid'] } }, requestId);
    }
    fields.addressPostalCode = addressPostalCode;
  }
  if (addressCity !== undefined) {
    if (addressCity !== null && typeof addressCity !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid addressCity.', fieldErrors: { addressCity: ['invalid'] } }, requestId);
    }
    fields.addressCity = addressCity;
  }
  if (addressCountry !== undefined) {
    if (addressCountry !== null && typeof addressCountry !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid addressCountry.', fieldErrors: { addressCountry: ['invalid'] } }, requestId);
    }
    fields.addressCountry = addressCountry;
  }

  const fieldErrors = validateProfileFields(fields);
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId);
  }

  const result = await updateEmployeeProfileFields({
    employeeId: authenticated.user.employeeId,
    version,
    actorUserId: authenticated.user.id,
    requestId,
    fields
  });

  if (!result.ok) {
    if (result.code === 'EMPLOYEE_NOT_FOUND') {
      return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
    }
    return jsonError(409, { code: 'VERSION_CONFLICT', message: 'This profile was changed elsewhere. Reload and try again.' }, requestId);
  }

  return NextResponse.json({ version: result.version }, { status: 200, headers: successHeaders(requestId) });
}
