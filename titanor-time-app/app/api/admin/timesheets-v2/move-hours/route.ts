import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { guardApiRequest, isUuid } from '@/lib/api-guard';
import { jsonError } from '@/lib/api-error';
import { MAX_MOVE_DATES, MoveHoursError, moveHoursToCustomer, previewMoveHours } from '@/lib/move-hours-to-customer';

export const dynamic = 'force-dynamic';

// Табель v2 → "Перенести часы другому заказчику" (lib/move-hours-to-customer.ts).
//   POST { employeeId, siteId, fromWorkArea, toWorkArea, dates[], preview?: true }
//   preview → { segmentCount, grossMinutes, dates, submittedDates } (read-only)
//   otherwise → { movedSegments, movedMinutes, dates, createdAssignmentIds }
// fromWorkArea / toWorkArea: a work area id on the site, or "none" for "без заказчика".
// ADMIN / SUPER_ADMIN, CSRF header required.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function workAreaParam(value: unknown): string | null | undefined {
  if (value === 'none') return null;
  return isUuid(value) ? value : undefined;
}

export async function POST(request: NextRequest) {
  const guard = await guardApiRequest(request, { csrf: true });
  if (!guard.ok) return guard.response;
  const { session, requestId } = guard;
  if (!session.user.roles.includes('ADMIN') && !session.user.roles.includes('SUPER_ADMIN')) return jsonError(403, { code: 'FORBIDDEN', message: 'Admins only.' }, requestId);

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid JSON.' }, requestId); }
  const from = workAreaParam(body.fromWorkArea);
  const to = workAreaParam(body.toWorkArea);
  const dates = Array.isArray(body.dates) ? body.dates : null;
  if (!isUuid(body.employeeId) || !isUuid(body.siteId) || from === undefined || to === undefined || !dates || dates.length === 0 || dates.length > MAX_MOVE_DATES || !dates.every((d) => typeof d === 'string' && DATE.test(d))) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'employeeId, siteId, fromWorkArea, toWorkArea and dates are required.' }, requestId);
  }
  const input = { employeeId: body.employeeId, siteId: body.siteId, fromWorkAreaId: from, toWorkAreaId: to, dates: dates as string[] };
  const headers = { 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId };

  if (body.preview === true) return NextResponse.json(await previewMoveHours(input), { headers });

  try {
    const result = await moveHoursToCustomer({ ...input, actorUserId: session.user.id, requestId });
    return NextResponse.json(result, { headers });
  } catch (error) {
    if (error instanceof MoveHoursError) {
      const status = error.code === 'SITE_NOT_FOUND' || error.code === 'CUSTOMER_NOT_FOUND' ? 404 : error.code === 'VALIDATION_ERROR' || error.code === 'SAME_CUSTOMER' ? 400 : 409;
      return jsonError(status, { code: error.code, message: error.code, ...(error.dates.length ? { dates: error.dates } : {}) }, requestId);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error('[timesheets-v2] move hours failed', requestId, error.code, error.meta);
      return jsonError(409, { code: 'MOVE_FAILED', message: 'The hours could not be moved — reload and try again.' }, requestId);
    }
    console.error('[timesheets-v2] move hours failed', requestId, error);
    return jsonError(500, { code: 'MOVE_FAILED', message: 'The hours could not be moved.' }, requestId);
  }
}
