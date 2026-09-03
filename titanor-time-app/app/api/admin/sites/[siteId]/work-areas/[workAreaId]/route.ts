import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const MAX_NAME_LENGTH = 128;
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ siteId: string; workAreaId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'workarea.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId, workAreaId } = await params;
  if (!UUID_PATTERN.test(siteId) || !UUID_PATTERN.test(workAreaId)) {
    return jsonError(404, { code: 'WORK_AREA_NOT_FOUND', message: 'No work area with this id on this site.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { version, name, active } = bodyObject as { version?: unknown; name?: unknown; active?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fieldErrors.version = ['required'];
  }

  const data: { name?: string; active?: boolean } = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > MAX_NAME_LENGTH) {
      fieldErrors.name = ['invalid'];
    } else {
      data.name = name.trim();
    }
  }
  if (active !== undefined) {
    if (typeof active !== 'boolean') {
      fieldErrors.active = ['invalid'];
    } else {
      data.active = active;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  // R15-D7 Deploy C (§3.9 / §3.13 L) — a customer with operationally-live or future assignments is
  // never silently deactivated. The admin must make an explicit decision via
  // POST /api/admin/sites/:siteId/work-areas/:workAreaId/disable.
  if (data.active === false) {
    const today = helsinkiToday();
    const blocking = await prisma.siteAssignment.count({
      where: {
        workAreaId,
        clockInDisabledAt: null,
        OR: [
          { validFrom: { gt: today } },
          { AND: [{ validFrom: { lte: today } }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }] }
        ]
      }
    });
    if (blocking > 0) {
      return jsonError(
        409,
        {
          code: 'CUSTOMER_HAS_WORKERS',
          message: `This customer has ${blocking} assigned or scheduled worker(s). Open the customer and choose what happens to them (leave on the site with no customer, or remove).`
        },
        requestId
      );
    }
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      // (id, siteId) together — a composite scope, not just id — so a
      // workAreaId that exists but belongs to a different site is correctly
      // treated as "not found" here, same as SITE_NOT_FOUND/WORKER_NOT_FOUND
      // scoping elsewhere.
      const result = await tx.workArea.updateMany({
        where: { id: workAreaId, siteId, version: version as number },
        data: { ...data, version: { increment: 1 } }
      });

      if (result.count === 0) {
        return null;
      }

      const area = await tx.workArea.findUniqueOrThrow({ where: { id: workAreaId } });

      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'WORK_AREA_UPDATED',
        entityType: 'WORK_AREA',
        entityId: workAreaId,
        requestId,
        beforeValue: null,
        afterValue: { id: area.id, siteId: area.siteId, name: area.name, active: area.active, version: area.version }
      });

      return area;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return jsonError(
        409,
        { code: 'DUPLICATE_WORK_AREA_NAME', message: 'A work area with this name already exists on this site.' },
        requestId
      );
    }
    throw error;
  }

  if (!updated) {
    const stillExists = await prisma.workArea.findFirst({ where: { id: workAreaId, siteId }, select: { id: true } });
    if (!stillExists) {
      return jsonError(404, { code: 'WORK_AREA_NOT_FOUND', message: 'No work area with this id on this site.' }, requestId);
    }
    return jsonError(
      409,
      { code: 'VERSION_CONFLICT', message: 'The work area was modified by someone else — reload and try again.' },
      requestId
    );
  }

  return NextResponse.json(
    {
      id: updated.id,
      siteId: updated.siteId,
      name: updated.name,
      active: updated.active,
      version: updated.version,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
