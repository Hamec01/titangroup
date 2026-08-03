import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { getSiteDetail } from '@/lib/sites';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
// Same bounds as POST /api/admin/sites/route.ts — not specified by the contract.
const MAX_NAME_LENGTH = 255;
const MAX_ADDRESS_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ siteId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'site.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId } = await params;
  const detail = await getSiteDetail(siteId);
  if (!detail) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'site.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { version, name, cityId, address, description, active } = bodyObject as {
    version?: unknown;
    name?: unknown;
    cityId?: unknown;
    address?: unknown;
    description?: unknown;
    active?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fieldErrors.version = ['required'];
  }

  // Partial update: only fields present in the body are validated/written.
  // defaultForemanUserId is deliberately not editable here — assigning a
  // foreman is its own workflow (T6.9), not a generic field edit.
  const data: { name?: string; cityId?: string | null; address?: string | null; description?: string | null; active?: boolean } = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > MAX_NAME_LENGTH) {
      fieldErrors.name = ['invalid'];
    } else {
      data.name = name.trim();
    }
  }

  let cityIdToCheck: string | undefined;
  if (cityId !== undefined) {
    if (cityId === null) {
      data.cityId = null;
    } else if (typeof cityId !== 'string' || !UUID_PATTERN.test(cityId)) {
      fieldErrors.cityId = ['invalid'];
    } else {
      cityIdToCheck = cityId;
    }
  }

  if (address !== undefined) {
    if (address !== null && (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH)) {
      fieldErrors.address = ['invalid'];
    } else {
      data.address = address as string | null;
    }
  }

  if (description !== undefined) {
    if (description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
      fieldErrors.description = ['invalid'];
    } else {
      data.description = description as string | null;
    }
  }

  if (active !== undefined) {
    if (typeof active !== 'boolean') {
      fieldErrors.active = ['invalid'];
    } else {
      data.active = active;
    }
  }

  if (Object.keys(fieldErrors).length === 0 && cityIdToCheck !== undefined) {
    const city = await prisma.city.findUnique({ where: { id: cityIdToCheck }, select: { id: true } });
    if (!city) {
      // Not in this endpoint's documented error list (only 404/409 VERSION_CONFLICT/400) —
      // treated as a validation failure rather than inventing an undocumented 404, mirroring
      // how PATCH /api/admin/workers/:employeeId handles an out-of-contract case.
      fieldErrors.cityId = ['not found'];
    } else {
      data.cityId = cityIdToCheck;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.workSite.updateMany({
      where: { id: siteId, version: version as number },
      data: { ...data, version: { increment: 1 } }
    });

    if (result.count === 0) {
      return null;
    }

    const site = await tx.workSite.findUniqueOrThrow({ where: { id: siteId } });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'SITE_UPDATED',
      entityType: 'WORK_SITE',
      entityId: siteId,
      requestId,
      beforeValue: null,
      afterValue: {
        id: site.id,
        name: site.name,
        cityId: site.cityId,
        address: site.address,
        description: site.description,
        active: site.active,
        version: site.version
      }
    });

    return site;
  });

  if (!updated) {
    const stillExists = await prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!stillExists) {
      return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
    }
    return jsonError(
      409,
      { code: 'VERSION_CONFLICT', message: 'The site was modified by someone else — reload and try again.' },
      requestId
    );
  }

  return NextResponse.json(
    {
      id: updated.id,
      name: updated.name,
      cityId: updated.cityId,
      address: updated.address,
      description: updated.description,
      active: updated.active,
      version: updated.version,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
