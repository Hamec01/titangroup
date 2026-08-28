import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { listTemplates, validateTemplateDays, parseTemplateTimeToDate, TEMPLATE_MAX_NAME_LENGTH, TEMPLATE_MAX_DESCRIPTION_LENGTH, type TemplateDayInput } from '@/lib/templates';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 — exact contract for this endpoint. Day/time
// shape validation (validateTemplateDays/parseTemplateTimeToDate) lives in lib/templates.ts,
// shared with PATCH /api/admin/templates/:templateId/route.ts — never duplicated between the two.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/templates';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'template.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE ? pageSizeParam : DEFAULT_PAGE_SIZE;

  const result = await listTemplates(page, pageSize);
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}

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

  if (!(await hasPermission(authenticated.user.roles, 'template.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  let identity: IdempotencyIdentity | null = null;
  if (idempotencyKeyHeader !== null) {
    if (!isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID.' }, requestId);
    }
    identity = {
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
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    if (identity) {
      await completeIdempotentRequest(identity, { statusCode, body });
    }
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const { name, description, days: rawDays } = bodyObject as { name?: unknown; description?: unknown; days?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  let trimmedName = '';
  if (typeof name !== 'string' || name.trim().length === 0) {
    fieldErrors.name = ['required'];
  } else if (name.trim().length > TEMPLATE_MAX_NAME_LENGTH) {
    fieldErrors.name = ['too long'];
  } else {
    trimmedName = name.trim();
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > TEMPLATE_MAX_DESCRIPTION_LENGTH) {
      fieldErrors.description = ['invalid'];
    }
  }

  const daysResult = validateTemplateDays(rawDays);
  if ('error' in daysResult) {
    fieldErrors.days = [daysResult.error];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const days = (daysResult as { days: TemplateDayInput[] }).days;

  const { template, version } = await prisma.$transaction(async (tx) => {
    const template = await tx.workScheduleTemplate.create({
      data: { name: trimmedName, description: typeof description === 'string' ? description : null }
    });
    const version = await tx.workScheduleTemplateVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 1,
        createdByUserId: authenticated.user.id,
        effectiveFrom: new Date()
      }
    });
    await tx.workScheduleTemplateVersionDay.createMany({
      data: days.map((day) => ({
        templateVersionId: version.id,
        weekday: day.weekday,
        isWorkingDay: day.isWorkingDay,
        plannedStartTime: day.plannedStartTime ? parseTemplateTimeToDate(day.plannedStartTime) : null,
        plannedEndTime: day.plannedEndTime ? parseTemplateTimeToDate(day.plannedEndTime) : null,
        plannedBreakMinutes: day.plannedBreakMinutes,
        plannedBreakPaid: day.plannedBreakPaid
      }))
    });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'TEMPLATE_CREATED',
      entityType: 'WORK_SCHEDULE_TEMPLATE',
      entityId: template.id,
      requestId,
      beforeValue: null,
      afterValue: {
        id: template.id,
        name: template.name,
        currentVersionId: version.id,
        currentVersionNumber: version.versionNumber
      }
    });

    return { template, version };
  });

  return respond(201, {
    id: template.id,
    name: template.name,
    currentVersionId: version.id,
    currentVersionNumber: version.versionNumber,
    days: days
      .slice()
      .sort((a, b) => a.weekday - b.weekday)
      .map((day) => ({
        weekday: day.weekday,
        isWorkingDay: day.isWorkingDay,
        plannedStartTime: day.plannedStartTime,
        plannedEndTime: day.plannedEndTime,
        plannedBreakMinutes: day.plannedBreakMinutes,
        plannedBreakPaid: day.plannedBreakPaid
      }))
  });
}
