import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
// Per-employee, not a single global key (unlike bootstrap-super-admin.ts's
// ADVISORY_LOCK_KEY_NAME) — promoting one employee's assignment must not
// block a concurrent promote for a different employee. hashtext() over a
// composed name, same pattern as bootstrap-super-admin.ts, keeps the key
// readable without picking a magic number; Prisma's tagged template
// parameterizes the interpolated employeeId, so this isn't string-built SQL.
function advisoryLockKeyName(employeeId: string): string {
  return `titanor_time:assignment_promote:${employeeId}`;
}
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle) — same pattern already used by
// this route family's own POST /api/admin/assignments/validate-overlap and .../split.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (!(await hasPermission(authenticated.user.roles, 'assignment.update'))) {
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

  const today = helsinkiToday();
  const isCurrentlyActive = existing.validFrom <= today && (existing.validTo === null || existing.validTo >= today);
  if (!isCurrentlyActive) {
    return jsonError(409, { code: 'ASSIGNMENT_NOT_ACTIVE', message: 'This assignment is not currently active.' }, requestId);
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockKeyName(existing.employeeId)})::bigint)`;

    // Demote whichever other currently-active assignment(s) of this same
    // employee currently hold isPrimary — 03_DATA_MODEL_ERD.md's invariant
    // ("не более одного среди пересекающихся"). Scoped to "active today",
    // not the full historical set, since promote is about making this
    // assignment THE primary one right now.
    const demoted = await tx.siteAssignment.findMany({
      where: {
        employeeId: existing.employeeId,
        id: { not: existing.id },
        isPrimary: true,
        validFrom: { lte: today },
        OR: [{ validTo: null }, { validTo: { gte: today } }]
      },
      select: { id: true }
    });

    if (demoted.length > 0) {
      await tx.siteAssignment.updateMany({
        where: { id: { in: demoted.map((assignment) => assignment.id) } },
        data: { isPrimary: false, version: { increment: 1 } }
      });
    }

    await tx.siteAssignment.update({
      where: { id: existing.id },
      data: { isPrimary: true, version: { increment: 1 } }
    });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'ASSIGNMENT_PROMOTED',
      entityType: 'SITE_ASSIGNMENT',
      entityId: existing.id,
      requestId,
      beforeValue: null,
      afterValue: {
        assignmentId: existing.id,
        employeeId: existing.employeeId,
        demotedAssignmentIds: demoted.map((assignment) => assignment.id)
      }
    });
  });

  return NextResponse.json(
    { assignmentId: existing.id, isPrimary: true },
    { status: 200, headers: successHeaders(requestId) }
  );
}
