import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { patchCorrectionDraftDay, type PatchDayInput, type PatchSegmentInput, type PatchBreakInput } from '@/lib/corrections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Mirrors PATCH /api/worker/timesheets/:timesheetId/days/:date's body shape/validation exactly
// (lib/corrections.ts's patchCorrectionDraftDay has the same day-state rules) — just targets a
// CorrectionDraft instead of a TimesheetDraft.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_TYPES = new Set(['WORK', 'SICK_LEAVE', 'VACATION', 'UNPAID_LEAVE', 'PUBLIC_HOLIDAY', 'OTHER']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

function parseDateTime(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type RouteParams = { params: Promise<{ correctionRequestId: string; date: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'correction.draft.edit'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { correctionRequestId, date: dateParam } = await params;
  if (!DATE_PATTERN.test(dateParam)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid date in URL.' }, requestId);
  }
  const date = new Date(`${dateParam}T00:00:00.000Z`);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { dayType, confirmedZero, note, segments: rawSegments } = bodyObject as {
    dayType?: unknown;
    confirmedZero?: unknown;
    note?: unknown;
    segments?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  const input: PatchDayInput = {};

  if (dayType !== undefined) {
    if (typeof dayType !== 'string' || !DAY_TYPES.has(dayType)) {
      fieldErrors.dayType = ['invalid'];
    } else {
      input.dayType = dayType;
    }
  }
  if (confirmedZero !== undefined) {
    if (typeof confirmedZero !== 'boolean') {
      fieldErrors.confirmedZero = ['invalid'];
    } else {
      input.confirmedZero = confirmedZero;
    }
  }
  if (note !== undefined) {
    if (note !== null && typeof note !== 'string') {
      fieldErrors.note = ['invalid'];
    } else {
      input.note = note;
    }
  }

  if (rawSegments !== undefined) {
    if (!Array.isArray(rawSegments)) {
      fieldErrors.segments = ['must be an array'];
    } else {
      const parsedSegments: PatchSegmentInput[] = [];
      rawSegments.forEach((rawSegment, index) => {
        if (!rawSegment || typeof rawSegment !== 'object') {
          fieldErrors[`segments.${index}`] = ['must be an object'];
          return;
        }
        const { startAt, endAt, siteId, workAreaId, breaks: rawBreaks, originClockShiftFragmentId } = rawSegment as Record<string, unknown>;
        const startAtDate = parseDateTime(startAt);
        const endAtDate = parseDateTime(endAt);
        if (!startAtDate) {
          fieldErrors[`segments.${index}.startAt`] = ['required'];
        }
        if (!endAtDate) {
          fieldErrors[`segments.${index}.endAt`] = ['required'];
        }
        if (typeof siteId !== 'string' || !UUID_PATTERN.test(siteId)) {
          fieldErrors[`segments.${index}.siteId`] = ['required'];
        }
        let normalizedWorkAreaId: string | null = null;
        if (workAreaId !== undefined && workAreaId !== null) {
          if (typeof workAreaId !== 'string' || !UUID_PATTERN.test(workAreaId)) {
            fieldErrors[`segments.${index}.workAreaId`] = ['invalid'];
          } else {
            normalizedWorkAreaId = workAreaId;
          }
        }
        let normalizedOriginId: string | null = null;
        if (originClockShiftFragmentId !== undefined && originClockShiftFragmentId !== null) {
          if (typeof originClockShiftFragmentId !== 'string' || !UUID_PATTERN.test(originClockShiftFragmentId)) {
            fieldErrors[`segments.${index}.originClockShiftFragmentId`] = ['invalid'];
          } else {
            normalizedOriginId = originClockShiftFragmentId;
          }
        }
        if (startAtDate && endAtDate && endAtDate <= startAtDate) {
          fieldErrors[`segments.${index}`] = ['endAt must be after startAt'];
        }

        const parsedBreaks: PatchBreakInput[] = [];
        if (rawBreaks !== undefined) {
          if (!Array.isArray(rawBreaks)) {
            fieldErrors[`segments.${index}.breaks`] = ['must be an array'];
          } else {
            rawBreaks.forEach((rawBreak, breakIndex) => {
              if (!rawBreak || typeof rawBreak !== 'object') {
                fieldErrors[`segments.${index}.breaks.${breakIndex}`] = ['must be an object'];
                return;
              }
              const { startAt: bStartAt, endAt: bEndAt, paid } = rawBreak as Record<string, unknown>;
              const bStartAtDate = parseDateTime(bStartAt);
              const bEndAtDate = parseDateTime(bEndAt);
              if (!bStartAtDate) {
                fieldErrors[`segments.${index}.breaks.${breakIndex}.startAt`] = ['required'];
              }
              if (!bEndAtDate) {
                fieldErrors[`segments.${index}.breaks.${breakIndex}.endAt`] = ['required'];
              }
              if (typeof paid !== 'boolean') {
                fieldErrors[`segments.${index}.breaks.${breakIndex}.paid`] = ['required'];
              }
              if (bStartAtDate && bEndAtDate && bEndAtDate <= bStartAtDate) {
                fieldErrors[`segments.${index}.breaks.${breakIndex}`] = ['endAt must be after startAt'];
              }
              if (bStartAtDate && bEndAtDate && typeof paid === 'boolean') {
                parsedBreaks.push({ startAt: bStartAtDate, endAt: bEndAtDate, paid });
              }
            });
          }
        }

        if (startAtDate && endAtDate && typeof siteId === 'string' && UUID_PATTERN.test(siteId)) {
          parsedSegments.push({ startAt: startAtDate, endAt: endAtDate, siteId, workAreaId: normalizedWorkAreaId, breaks: parsedBreaks, originClockShiftFragmentId: normalizedOriginId });
        }
      });

      if (Object.keys(fieldErrors).length === 0) {
        input.segments = parsedSegments;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  // Task C — actorUserId lets patchCorrectionDraftDay auto-record a one-day APPROVED Absence when
  // the admin marks a non-WORK day type and none exists yet.
  const result = await patchCorrectionDraftDay(correctionRequestId, date, input, authenticated.user.id);

  if ('code' in result) {
    switch (result.code) {
      case 'NOT_FOUND':
        return jsonError(404, { code: 'CORRECTION_NOT_FOUND', message: 'No correction request with this id.' }, requestId);
      case 'FORBIDDEN':
        return jsonError(403, { code: 'FORBIDDEN', message: 'This clock-origin fragment is not part of this correction draft.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Correction draft is not open for editing.' }, requestId);
      case 'VALIDATION_ERROR':
        return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
      case 'DAY_TYPE_REQUIRES_ABSENCE':
        return jsonError(403, { code: 'DAY_TYPE_REQUIRES_ABSENCE', message: 'This dayType requires a matching APPROVED Absence covering this date.' }, requestId);
      case 'DAY_TYPE_CONFLICT':
        return jsonError(409, { code: 'DAY_TYPE_CONFLICT', message: 'Segments conflict with the resulting dayType.' }, requestId);
      case 'DAY_STATE_CONFLICT':
        return jsonError(409, { code: 'DAY_STATE_CONFLICT', message: 'confirmedZero conflicts with segments or dayType.' }, requestId);
      case 'SITE_NOT_ASSIGNED':
        return jsonError(404, { code: 'SITE_NOT_ASSIGNED', message: 'No active SiteAssignment for this employee/site/workArea on this date.' }, requestId);
      case 'WORK_SEGMENT_OVERLAP':
        return jsonError(409, { code: 'WORK_SEGMENT_OVERLAP', message: 'Segments overlap.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
