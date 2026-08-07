import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { listTemplates } from '@/lib/templates';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4 — exact contract for this endpoint.
// docs/titanor-time/03_DATA_MODEL_ERD.md §4.5 + 05_RAW_SQL_REGISTER.md CK-06/07/08 — the shape rules
// below (working day needs both times + non-negative break; non-working day needs neither time and a
// zero break) are enforced by real DB CHECK constraints on WorkScheduleTemplateVersionDay, already
// live since the frozen initial migration. This route re-validates the same shape up front purely to
// return a clean 400 VALIDATION_ERROR instead of surfacing a raw 23514 constraint violation.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/templates';
const MAX_NAME_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
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

function parseTimeToDate(value: string): Date {
  const normalized = value.length === 5 ? `${value}:00` : value;
  return new Date(`1970-01-01T${normalized}Z`);
}

interface DayInput {
  weekday: number;
  isWorkingDay: boolean;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  plannedBreakMinutes: number;
}

function validateDays(rawDays: unknown): { days: DayInput[] } | { error: string } {
  if (!Array.isArray(rawDays) || rawDays.length !== 7) {
    return { error: 'must be an array of exactly 7 entries' };
  }

  const days: DayInput[] = [];
  const seenWeekdays = new Set<number>();

  for (const raw of rawDays) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'each entry must be an object' };
    }
    const { weekday, isWorkingDay, plannedStartTime, plannedEndTime, plannedBreakMinutes } = raw as Record<string, unknown>;

    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: 'weekday must be an integer 0-6 (0=Mon..6=Sun)' };
    }
    if (seenWeekdays.has(weekday)) {
      return { error: `duplicate weekday ${weekday}` };
    }
    seenWeekdays.add(weekday);

    if (typeof isWorkingDay !== 'boolean') {
      return { error: 'isWorkingDay must be a boolean' };
    }
    if (typeof plannedBreakMinutes !== 'number' || !Number.isInteger(plannedBreakMinutes) || plannedBreakMinutes < 0) {
      return { error: 'plannedBreakMinutes must be a non-negative integer' };
    }

    if (isWorkingDay) {
      if (typeof plannedStartTime !== 'string' || !TIME_PATTERN.test(plannedStartTime)) {
        return { error: `weekday ${weekday}: plannedStartTime required (HH:MM) for a working day` };
      }
      if (typeof plannedEndTime !== 'string' || !TIME_PATTERN.test(plannedEndTime)) {
        return { error: `weekday ${weekday}: plannedEndTime required (HH:MM) for a working day` };
      }
      days.push({ weekday, isWorkingDay: true, plannedStartTime, plannedEndTime, plannedBreakMinutes });
    } else {
      if (plannedStartTime !== undefined && plannedStartTime !== null) {
        return { error: `weekday ${weekday}: plannedStartTime must be empty for a non-working day` };
      }
      if (plannedEndTime !== undefined && plannedEndTime !== null) {
        return { error: `weekday ${weekday}: plannedEndTime must be empty for a non-working day` };
      }
      if (plannedBreakMinutes !== 0) {
        return { error: `weekday ${weekday}: plannedBreakMinutes must be 0 for a non-working day` };
      }
      days.push({ weekday, isWorkingDay: false, plannedStartTime: null, plannedEndTime: null, plannedBreakMinutes: 0 });
    }
  }

  if (seenWeekdays.size !== 7) {
    return { error: 'days must cover weekday 0-6 exactly once each' };
  }

  return { days };
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
  } else if (name.trim().length > MAX_NAME_LENGTH) {
    fieldErrors.name = ['too long'];
  } else {
    trimmedName = name.trim();
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) {
      fieldErrors.description = ['invalid'];
    }
  }

  const daysResult = validateDays(rawDays);
  if ('error' in daysResult) {
    fieldErrors.days = [daysResult.error];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const days = (daysResult as { days: DayInput[] }).days;

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
        plannedStartTime: day.plannedStartTime ? parseTimeToDate(day.plannedStartTime) : null,
        plannedEndTime: day.plannedEndTime ? parseTimeToDate(day.plannedEndTime) : null,
        plannedBreakMinutes: day.plannedBreakMinutes
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
        plannedBreakMinutes: day.plannedBreakMinutes
      }))
  });
}
