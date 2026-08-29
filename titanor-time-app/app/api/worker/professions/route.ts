import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { addEmployeeProfession, listEmployeeProfessions, listProfessionCatalog, isProfessionCategory } from '@/lib/professions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T15.2 — the worker manages their OWN professions from /worker/profile. Same lib functions as the
// admin route (lib/professions.ts); the only differences are: employeeId comes from the session
// (never a param), the permission is worker.profession.manage.own, and GET also returns the
// catalog so the worker screen needs one request. A profession is a trade/speciality — not a
// certificate, grants no access.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profession.manage.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }
  const [items, catalog] = await Promise.all([listEmployeeProfessions(authenticated.user.employeeId), listProfessionCatalog()]);
  return NextResponse.json({ items, catalog }, { status: 200, headers: successHeaders(requestId) });
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
  if (!(await hasPermission(authenticated.user.roles, 'worker.profession.manage.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const employeeId = authenticated.user.employeeId;
  if (!employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be JSON.' }, requestId);
  }

  const definitionId = typeof body.definitionId === 'string' && body.definitionId.length > 0 ? body.definitionId : null;
  const customName = typeof body.customName === 'string' && body.customName.trim().length > 0 ? body.customName : null;
  const customCategory = body.customCategory;

  if ((definitionId && customName) || (!definitionId && !customName)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Provide exactly one of definitionId or (customName + customCategory).', fieldErrors: { definitionId: ['exactly one of definitionId / customName required'] } }, requestId);
  }
  if (definitionId && !UUID_PATTERN.test(definitionId)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid definitionId.', fieldErrors: { definitionId: ['must be a UUID'] } }, requestId);
  }
  if (customName && !isProfessionCategory(customCategory)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid customCategory.', fieldErrors: { customCategory: ['must be SHIPBUILDING or CONSTRUCTION'] } }, requestId);
  }

  const result = definitionId
    ? await addEmployeeProfession({ employeeId, definitionId, actorUserId: authenticated.user.id, requestId })
    : await addEmployeeProfession({ employeeId, customName: customName as string, customCategory: customCategory as 'SHIPBUILDING' | 'CONSTRUCTION', actorUserId: authenticated.user.id, requestId });

  if (!result.ok) {
    if (result.code === 'ALREADY_ADDED') {
      return jsonError(409, { code: 'PROFESSION_ALREADY_ADDED', message: 'You already have that profession.' }, requestId);
    }
    if (result.code === 'DEFINITION_NOT_FOUND') {
      return jsonError(400, { code: 'DEFINITION_NOT_FOUND', message: 'Unknown or inactive profession.' }, requestId);
    }
    if (result.code === 'VALIDATION_ERROR') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId);
    }
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, requestId);
  }
  return NextResponse.json({ id: result.id }, { status: 201, headers: successHeaders(requestId) });
}
