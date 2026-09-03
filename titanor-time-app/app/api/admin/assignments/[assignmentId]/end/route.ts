import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { removeFromSite } from '@/lib/assignment-lifecycle-service';
import { isAssignmentTransitionReason } from '@/lib/assignment-transitions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
// R15-D7: the actual work (close the payroll window, set clockInDisabledAt so the worker drops out
// of the Check-In options immediately, drop future draft planned shifts, write the
// AssignmentTransition + AuditEvent) is done by lib/assignment-lifecycle-service.ts's
// removeFromSite() — the single writer (§2.4). This route keeps only HTTP/auth/validation.
// POST /api/admin/assignments/:id/remove is the same operation under its D7 name.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REASON_LENGTH = 2000;
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle) — same pattern already used by
// this route family's own POST /api/admin/assignments/validate-overlap and .../split.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'assignment.end'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { assignmentId } = await params;
  if (!UUID_PATTERN.test(assignmentId)) {
    return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
  }

  const existing = await prisma.siteAssignment.findUnique({ where: { id: assignmentId } });
  if (!existing) {
    return jsonError(404, { code: 'ASSIGNMENT_NOT_FOUND', message: 'No assignment with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  // `reason` (free text) is the legacy /end field; `reasonCode` + `reasonText` are Deploy B's
  // structured presets from the worker card. `reasonText` on its own is treated like `reason`.
  const { validTo, reason, reasonCode, reasonText } = bodyObject as {
    validTo?: unknown;
    reason?: unknown;
    reasonCode?: unknown;
    reasonText?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof validTo !== 'string' || !DATE_PATTERN.test(validTo)) {
    fieldErrors.validTo = ['required'];
  }
  let normalizedReasonCode: 'PROJECT_DONE' | 'TRANSFER' | 'ASSIGNED_BY_MISTAKE' | 'OTHER' | null = null;
  if (reasonCode !== undefined && reasonCode !== null) {
    if (!isAssignmentTransitionReason(reasonCode)) {
      fieldErrors.reasonCode = ['invalid'];
    } else {
      normalizedReasonCode = reasonCode;
    }
  }
  const rawFreeText = typeof reasonText === 'string' ? reasonText : typeof reason === 'string' ? reason : null;
  let trimmedReason: string | null = null;
  if (rawFreeText !== null) {
    if (rawFreeText.trim().length === 0 || rawFreeText.length > MAX_REASON_LENGTH) {
      fieldErrors.reason = ['invalid'];
    } else {
      trimmedReason = rawFreeText.trim();
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const newValidTo = new Date(`${validTo as string}T00:00:00.000Z`);

  if (newValidTo < existing.validFrom) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { validTo: ['before validFrom'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }
  // "end" only ever shrinks — 02_ROLE_PERMISSION_MATRIX.md's assignment.end
  // row is entirely about ending early; extending validTo would risk
  // newly overlapping another assignment (the EXCLUDE constraint only
  // protects against that on INSERT of a different row, not on widening this
  // one), and isn't what this endpoint's name implies. Not a documented
  // error code, so this maps to the generic VALIDATION_ERROR too.
  if (existing.validTo !== null && newValidTo > existing.validTo) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { validTo: ['must not be later than the current validTo'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  // 02_ROLE_PERMISSION_MATRIX.md: "Причина: да, если раньше плана" — required
  // only when ending earlier than whatever was previously planned (a null
  // validTo counts as "never", so any concrete date here is earlier than that).
  const isEarlierThanPlanned = existing.validTo === null || newValidTo.getTime() < existing.validTo.getTime();
  // A preset code (PROJECT_DONE / TRANSFER / ASSIGNED_BY_MISTAKE) satisfies "reason required"; OTHER
  // still needs the free text.
  const hasReason = (normalizedReasonCode !== null && normalizedReasonCode !== 'OTHER') || trimmedReason !== null;
  if (isEarlierThanPlanned && !hasReason) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { reason: ['required when ending earlier than planned'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const outcome = await removeFromSite({
    existing,
    validTo: newValidTo,
    reasonText: trimmedReason,
    reasonCode: normalizedReasonCode,
    actorUserId: authenticated.user.id,
    requestId
  });

  if ('code' in outcome) {
    // Recorded / submitted (or guard-detected) hours on a day after the chosen end date — the admin
    // adjusts the timesheet first, or ends on/after that day.
    return jsonError(
      409,
      {
        code: 'ASSIGNMENT_HAS_RECORDED_TIME',
        message:
          'The worker has recorded or submitted hours on this assignment after the chosen end date. End it on or after that day, or adjust the timesheet first.',
        fieldErrors: { validTo: ['must not be earlier than the last recorded or submitted day'] },
        ...(outcome.earliestValidTo ? { earliestValidTo: outcome.earliestValidTo } : {})
      },
      requestId
    );
  }

  const updated = outcome.assignment;
  return NextResponse.json(
    {
      id: updated.id,
      employeeId: updated.employeeId,
      siteId: updated.siteId,
      workAreaId: updated.workAreaId,
      templateVersionId: updated.templateVersionId,
      isPrimary: updated.isPrimary,
      validFrom: formatDate(updated.validFrom),
      validTo: updated.validTo ? formatDate(updated.validTo) : null,
      endedReason: updated.endedReason,
      version: updated.version,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
