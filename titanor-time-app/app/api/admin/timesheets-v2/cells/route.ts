import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { guardApiRequest, isUuid } from '@/lib/api-guard';
import { jsonError } from '@/lib/api-error';
import { prisma } from '@/lib/prisma';
import { isValidMonth } from '@/lib/reporting/monthly-matrix';
import { resetTimesheetV2Cells, saveTimesheetV2Cells, TimesheetV2CellError, type CellChange } from '@/lib/timesheet-v2-cells';

export const dynamic = 'force-dynamic';

// Табель v2 → "Редактировать табель".
//   POST   { siteId, workArea: <workAreaId|none>, month, changes: [{ employeeId, date, value }] } → { saved }
//   DELETE ?siteId&workArea&month → { removed }   ("Вернуть автоматические значения")
// ADMIN / SUPER_ADMIN, same as the Табель v2 pages.

async function authorize(request: NextRequest) {
  const guard = await guardApiRequest(request, { csrf: true });
  if (!guard.ok) return guard;
  const roles = guard.session.user.roles;
  if (!roles.includes('ADMIN') && !roles.includes('SUPER_ADMIN')) return { ok: false as const, response: jsonError(403, { code: 'FORBIDDEN', message: 'Admins only.' }, guard.requestId) };
  return guard;
}

async function resolveCustomer(siteId: unknown, workArea: unknown): Promise<{ siteId: string; workAreaId: string | null } | null> {
  if (!isUuid(siteId) || (workArea !== 'none' && !isUuid(workArea))) return null;
  const workAreaId = workArea === 'none' ? null : (workArea as string);
  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) return null;
  if (workAreaId && !(await prisma.workArea.findFirst({ where: { id: workAreaId, siteId }, select: { id: true } }))) return null;
  return { siteId, workAreaId };
}

function errorResponse(error: unknown, requestId: string) {
  if (error instanceof TimesheetV2CellError) return jsonError(error.status, { code: error.code, message: error.code }, requestId);
  // Two admins saved the same new cell at the same moment: nothing of this request was written.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return jsonError(409, { code: 'CONCURRENT_EDIT', message: 'Someone saved the same cells just now.' }, requestId);
  console.error('[timesheets-v2] cell save failed', requestId, error);
  return jsonError(500, { code: 'SAVE_FAILED', message: 'Could not save the timesheet.' }, requestId);
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  let body: { siteId?: unknown; workArea?: unknown; month?: unknown; changes?: unknown };
  try { body = await request.json(); } catch { return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid JSON.' }, auth.requestId); }
  const customer = await resolveCustomer(body.siteId, body.workArea);
  if (!customer) return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' }, auth.requestId);
  if (typeof body.month !== 'string' || !isValidMonth(body.month) || !Array.isArray(body.changes)) return jsonError(400, { code: 'VALIDATION_ERROR', message: 'month and changes are required.' }, auth.requestId);
  const changes: CellChange[] = [];
  for (const c of body.changes as Array<Record<string, unknown>>) {
    if (!c || !isUuid(c.employeeId) || typeof c.date !== 'string' || typeof c.value !== 'string') return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Each change needs employeeId, date and value.' }, auth.requestId);
    changes.push({ employeeId: c.employeeId, date: c.date, value: c.value });
  }
  try {
    const result = await saveTimesheetV2Cells({ ...customer, month: body.month, changes, actorUserId: auth.session.user.id, requestId: auth.requestId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error, auth.requestId);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const sp = request.nextUrl.searchParams;
  const customer = await resolveCustomer(sp.get('siteId'), sp.get('workArea'));
  const month = sp.get('month');
  if (!customer) return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' }, auth.requestId);
  if (!month || !isValidMonth(month)) return jsonError(400, { code: 'VALIDATION_ERROR', message: 'month is required.' }, auth.requestId);
  try {
    const result = await resetTimesheetV2Cells({ ...customer, month, actorUserId: auth.session.user.id, requestId: auth.requestId });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error, auth.requestId);
  }
}
