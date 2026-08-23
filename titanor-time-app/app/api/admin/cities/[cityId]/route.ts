import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A City is reference data only. It may be removed exclusively while no WorkSite references it;
// the row lock also prevents a concurrent Site creation from attaching it during this check.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ cityId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const { cityId } = await params;

  if (!UUID_PATTERN.test(cityId)) {
    return jsonError(404, { code: 'CITY_NOT_FOUND', message: 'No city found with this id.' }, requestId);
  }
  if (request.headers.get('x-requested-with') !== CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'city.delete'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const result = await prisma.$transaction(async (tx) => {
    const cities = await tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM "City" WHERE id = ${cityId}::uuid FOR UPDATE`;
    const city = cities[0];
    if (!city) return { kind: 'not-found' } as const;

    const siteCount = await tx.workSite.count({ where: { cityId } });
    if (siteCount > 0) return { kind: 'in-use', siteCount } as const;

    await tx.city.delete({ where: { id: cityId } });
    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'CITY_DELETED',
      entityType: 'CITY',
      entityId: cityId,
      requestId,
      beforeValue: { id: city.id, name: city.name },
      afterValue: null
    });
    return { kind: 'deleted' } as const;
  });

  if (result.kind === 'not-found') {
    return jsonError(404, { code: 'CITY_NOT_FOUND', message: 'No city found with this id.' }, requestId);
  }
  if (result.kind === 'in-use') {
    return jsonError(409, { code: 'CITY_IN_USE', message: 'This city is still used by one or more sites.' }, requestId);
  }
  return NextResponse.json({ deleted: true }, { status: 200, headers: successHeaders(requestId) });
}