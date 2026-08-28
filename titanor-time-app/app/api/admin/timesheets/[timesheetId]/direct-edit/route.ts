import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { requestCorrection, openCorrectionDraft } from '@/lib/corrections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T12 §1b (2026-08-28) — one-click "Изменить часы" on a SUBMITTED / FOREMAN_APPROVED timesheet:
// requestCorrection({ directEdit: true }) + openCorrectionDraft, then the admin edits days on the
// shared /admin/corrections/[id] page and hits "Применить изменения". No reason is asked for and
// the applied version is source=ADMIN_EDIT, so the worker gets NO "Часы исправил администратор"
// notice — the change is still fully in AuditEvent. Mirrors ./correction/route.ts otherwise.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteParams = { params: Promise<{ timesheetId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'correction.request')) || !(await hasPermission(authenticated.user.roles, 'correction.draft.edit'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { timesheetId } = await params;
  if (!UUID_PATTERN.test(timesheetId)) {
    return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
  }

  const requested = await requestCorrection(timesheetId, authenticated.user.id, '', requestId, { directEdit: true });
  if ('code' in requested) {
    switch (requested.code) {
      case 'TIMESHEET_NOT_FOUND':
        return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'This timesheet cannot be edited in its current status.' }, requestId);
      case 'CORRECTION_ALREADY_OPEN':
        return jsonError(409, { code: 'CORRECTION_ALREADY_OPEN', message: 'A correction is already open for this timesheet.' }, requestId);
    }
  }

  const opened = await openCorrectionDraft(requested.id, authenticated.user.id, requestId);
  if ('code' in opened) {
    if (opened.code === 'NOT_FOUND') {
      return jsonError(404, { code: 'CORRECTION_NOT_FOUND', message: 'Correction request vanished.' }, requestId);
    }
    return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Correction request could not be opened.' }, requestId);
  }

  return NextResponse.json({ correctionRequestId: opened.correctionRequestId, draftId: opened.draftId }, { status: 201, headers: successHeaders(requestId) });
}
