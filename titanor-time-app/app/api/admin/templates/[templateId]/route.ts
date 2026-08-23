import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import {
  getTemplateDetail,
  updateTemplate,
  validateTemplateDays,
  TEMPLATE_MAX_NAME_LENGTH,
  TEMPLATE_MAX_DESCRIPTION_LENGTH,
  type TemplateDayInput
} from '@/lib/templates';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 — GET/PATCH /api/admin/templates/:templateId.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ templateId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'template.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { templateId } = await params;
  // A malformed UUID would otherwise reach Postgres as a `uuid`-typed query parameter and throw
  // (22P02 invalid input syntax), surfacing as an unhandled 500 — checked before ever querying, same
  // as a genuinely unknown id, since neither case has a template to return.
  if (!UUID_PATTERN.test(templateId)) {
    return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'No template with this id.' }, requestId);
  }

  const detail = await getTemplateDetail(templateId);
  if (!detail) {
    return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'No template with this id.' }, requestId);
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

  if (!(await hasPermission(authenticated.user.roles, 'template.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { templateId } = await params;
  if (!UUID_PATTERN.test(templateId)) {
    return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'No template with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { expectedVersionNumber, name, description, active, days: rawDays } = bodyObject as {
    expectedVersionNumber?: unknown;
    name?: unknown;
    description?: unknown;
    active?: unknown;
    days?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};

  if (typeof expectedVersionNumber !== 'number' || !Number.isInteger(expectedVersionNumber) || expectedVersionNumber < 1) {
    fieldErrors.expectedVersionNumber = ['required'];
  }

  if (name === undefined && description === undefined && active === undefined && rawDays === undefined) {
    fieldErrors.fields = ['at least one of name, description, active, days is required'];
  }

  let normalizedName: string | undefined;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > TEMPLATE_MAX_NAME_LENGTH) {
      fieldErrors.name = ['invalid'];
    } else {
      normalizedName = name.trim();
    }
  }

  let normalizedDescription: string | null | undefined;
  if (description !== undefined) {
    if (description !== null && (typeof description !== 'string' || description.length > TEMPLATE_MAX_DESCRIPTION_LENGTH)) {
      fieldErrors.description = ['invalid'];
    } else {
      normalizedDescription = description as string | null;
    }
  }

  let normalizedActive: boolean | undefined;
  if (active !== undefined) {
    if (typeof active !== 'boolean') {
      fieldErrors.active = ['must be a boolean'];
    } else {
      normalizedActive = active;
    }
  }

  let normalizedDays: TemplateDayInput[] | undefined;
  if (rawDays !== undefined) {
    const daysResult = validateTemplateDays(rawDays);
    if ('error' in daysResult) {
      fieldErrors.days = [daysResult.error];
    } else {
      normalizedDays = daysResult.days;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), {
      status: 400,
      headers: successHeaders(requestId)
    });
  }

  const result = await updateTemplate({
    templateId,
    expectedVersionNumber: expectedVersionNumber as number,
    name: normalizedName,
    description: normalizedDescription,
    active: normalizedActive,
    days: normalizedDays,
    actorUserId: authenticated.user.id,
    requestId
  });

  if ('code' in result) {
    if (result.code === 'TEMPLATE_NOT_FOUND') {
      return jsonError(404, { code: 'TEMPLATE_NOT_FOUND', message: 'No template with this id.' }, requestId);
    }
    return jsonError(409, { code: 'VERSION_CONFLICT', message: 'This template was changed elsewhere — reload and try again.' }, requestId);
  }

  return NextResponse.json(result.detail, { status: 200, headers: successHeaders(requestId) });
}
