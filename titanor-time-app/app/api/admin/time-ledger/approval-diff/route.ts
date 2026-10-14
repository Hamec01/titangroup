import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { buildCustomerHoursApprovalDiff } from '@/lib/reporting/customer-hours-diff';
import { customerHoursApprovalEnabled } from '@/lib/customer-hours-approval-flag';

// UT7-B — GET /api/admin/time-ledger/approval-diff. Read-only, lazy (fetched by the UI only when an
// admin expands a row whose approvalState is CHANGED_AFTER_APPROVAL / NEEDS_ATTENTION with
// supersededFingerprintMatch) — never embedded in the paginated GET /api/admin/time-ledger response,
// so an ordinary ledger page load never pays for loading any ApprovalItem.snapshot JSONB. Same
// auth/permission convention as the sibling GET /api/admin/time-ledger route in this directory
// (manual resolveAuthenticatedSession + hasPermission, not guardApiRequest — that helper's csrf
// option is for mutating routes; this is a plain read). No mutation of any kind. Every field in the
// response is server-resolved (lib/reporting/customer-hours-diff.ts) — the query string carries only
// the logical key (timesheetId/siteId/workAreaId/weekStart), never a name or an hours value the
// client could otherwise try to smuggle through.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UT7-B-fixup #4 — "strict" means an unknown or repeated query parameter is rejected outright, not
// silently ignored/first-wins, mirroring lib/reporting/time-ledger-query.ts's parseTimeLedgerQuery
// convention for the sibling GET /api/admin/time-ledger route.
const SUPPORTED_PARAMS = ['timesheetId', 'siteId', 'workAreaId', 'weekStart'];

function isStrictMondayIso(value: string | null): value is string {
  if (!value) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) return false;
  return asDate.getUTCDay() === 1; // Monday, same 0=Sun..6=Sat getUTCDay() convention as elsewhere
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!customerHoursApprovalEnabled()) return jsonError(409, { code: 'FEATURE_DISABLED', message: 'Customer hours approval is disabled.' }, requestId);

  const params = request.nextUrl.searchParams;
  const fieldErrors: Record<string, string[]> = {};

  for (const key of new Set(params.keys())) {
    if (!SUPPORTED_PARAMS.includes(key)) fieldErrors[key] = ['unknown query parameter'];
  }
  for (const name of SUPPORTED_PARAMS) {
    if (params.getAll(name).length > 1) fieldErrors[name] = [...(fieldErrors[name] ?? []), 'must not be repeated'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors }, requestId);
  }

  const timesheetId = params.get('timesheetId');
  const siteId = params.get('siteId');
  const workAreaIdRaw = params.get('workAreaId');
  const weekStart = params.get('weekStart');

  if (!timesheetId || !UUID_PATTERN.test(timesheetId)) fieldErrors.timesheetId = ['must be a UUID'];
  if (!siteId || !UUID_PATTERN.test(siteId)) fieldErrors.siteId = ['must be a UUID'];
  if (workAreaIdRaw !== null && !UUID_PATTERN.test(workAreaIdRaw)) fieldErrors.workAreaId = ['must be a UUID when present'];
  if (!isStrictMondayIso(weekStart)) fieldErrors.weekStart = ['must be a real calendar date, YYYY-MM-DD, and a Monday'];
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors }, requestId);
  }

  const itemKey = { timesheetId: timesheetId as string, siteId: siteId as string, workAreaId: workAreaIdRaw, weekStart: weekStart as string };
  const result = await buildCustomerHoursApprovalDiff({
    itemKey,
    actor: { userId: authenticated.user.id, employeeId: authenticated.user.employeeId },
    db: prisma
  });

  if (!result.ok) {
    return jsonError(404, { code: result.reason, message: 'No approval history for this customer/week.' }, requestId);
  }

  return NextResponse.json({ requestId, ...result }, { status: 200, headers: successHeaders(requestId) });
}
