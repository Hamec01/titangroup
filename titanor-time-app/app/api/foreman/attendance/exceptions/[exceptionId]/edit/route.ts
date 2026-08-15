import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.4 — "FOREMAN не получает
// timesheet.draft.edit.exception в первом релизе". This route exists only so the endpoint shape
// mirrors the admin one (and returns a clean 403 instead of a generic 404 for a role that will
// plausibly try it), but it fails closed unconditionally: no role currently holds
// timesheet.draft.edit.exception except ADMIN/SUPER_ADMIN
// (prisma/migrations/20260818000000_seed_timesheet_draft_edit_exception_permission), so this check
// always 403s in v1. Deliberately checked BEFORE any body parsing, UUID validation, or
// exception/fragment read — a malformed body or a fabricated exceptionId must never turn this into
// a 400 or 404 instead of the 403 a foreman was always going to get.
// POST /api/foreman/attendance/exceptions/:exceptionId/edit.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ exceptionId: string }> };

export async function POST(request: NextRequest, { params: _params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.draft.edit.exception'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  // Structurally unreachable in v1 (no role holds timesheet.draft.edit.exception besides
  // ADMIN/SUPER_ADMIN, and this route only ever serves FOREMAN sessions per its path) — kept only
  // so the handler has a defined, type-correct success path if that ever changes.
  return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
}
