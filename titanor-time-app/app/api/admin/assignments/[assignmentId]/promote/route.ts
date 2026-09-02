import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { promoteToPrimary } from '@/lib/assignment-lifecycle-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — exact contract for this endpoint.
// R15-D7: the "≤1 operationally-live primary" invariant (§3.6) is enforced by
// lib/assignment-lifecycle-service.ts's promoteToPrimary() — one transaction under the shared
// per-employee advisory lock, demoting every other live primary and writing an
// AssignmentTransition + AuditEvent. This route keeps only HTTP/auth.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
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

  const result = await promoteToPrimary({ existing, actorUserId: authenticated.user.id, requestId });
  if ('code' in result) {
    if (result.code === 'LIVE_PRIMARY_CONFLICT') {
      return jsonError(409, { code: 'LIVE_PRIMARY_CONFLICT', message: 'Another primary assignment change is in flight — refresh and try again.' }, requestId);
    }
    return jsonError(409, { code: 'ASSIGNMENT_NOT_ACTIVE', message: 'This assignment is not currently active.' }, requestId);
  }

  return NextResponse.json(
    { assignmentId: existing.id, isPrimary: true },
    { status: 200, headers: successHeaders(requestId) }
  );
}
