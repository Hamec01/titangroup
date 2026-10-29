import { NextRequest, NextResponse } from 'next/server';
import { guardApiRequest, isUuid } from '@/lib/api-guard';
import { jsonError } from '@/lib/api-error';
import { createAuditEvent } from '@/lib/audit';
import { prisma } from '@/lib/prisma';
import { customerKeyOf, isValidMonth } from '@/lib/reporting/monthly-matrix';

export const dynamic = 'force-dynamic';

const MAX_DISPLAY_NAME_LENGTH = 128;
const ACTIONS = ['TRASH', 'RESTORE', 'DELETE', 'RENAME'] as const;
type CardAction = (typeof ACTIONS)[number];
const AUDIT_ACTIONS: Record<CardAction, string> = {
  TRASH: 'TRASHED',
  RESTORE: 'RESTORED',
  DELETE: 'DELETED',
  RENAME: 'RENAMED'
};

export async function POST(request: NextRequest) {
  const guard = await guardApiRequest(request, { csrf: true });
  if (!guard.ok) return guard.response;
  const { session, requestId } = guard;
  if (!session.user.roles.includes('ADMIN') && !session.user.roles.includes('SUPER_ADMIN')) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Admins only.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid JSON.' }, requestId);
  }
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'A JSON object is required.' }, requestId);
  }
  const body = rawBody as Record<string, unknown>;
  const action = body.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action as CardAction)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid card action.' }, requestId);
  }
  if (!isUuid(body.siteId) || (body.workArea !== 'none' && !isUuid(body.workArea)) || typeof body.month !== 'string' || !isValidMonth(body.month)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'siteId, workArea and a valid month are required.' }, requestId);
  }

  const siteId = body.siteId.toLowerCase();
  const workAreaId = body.workArea === 'none' ? null : body.workArea.toLowerCase();
  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site || (workAreaId && !(await prisma.workArea.findFirst({ where: { id: workAreaId, siteId }, select: { id: true } })))) {
    return jsonError(404, { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' }, requestId);
  }

  const month = body.month;
  const customerKey = customerKeyOf(siteId, workAreaId);
  const cardAction = action as CardAction;
  let displayName: string | undefined;
  if (cardAction === 'RENAME') {
    if (typeof body.displayName !== 'string') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'A display name is required.' }, requestId);
    }
    displayName = body.displayName.trim();
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'The display name must be between 1 and 128 characters.' }, requestId);
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const where = { month_customerKey: { month, customerKey } };
      const before = await tx.timesheetV2CardState.findUnique({ where });
      if (cardAction === 'RESTORE' || cardAction === 'DELETE') {
        if (before?.status !== 'TRASHED') {
          return { error: 'CARD_NOT_IN_TRASH' as const };
        }
      } else if (cardAction === 'RENAME' && before && before.status !== 'ACTIVE') {
        return { error: 'CARD_NOT_ACTIVE' as const };
      } else if (cardAction === 'TRASH' && before?.status === 'DELETED') {
        return { error: 'CARD_DELETED' as const };
      }
      if (cardAction === 'TRASH' && before?.status === 'TRASHED') {
        return { state: before, changed: false };
      }
      if (cardAction === 'RENAME' && before && before.displayName === displayName) {
        return { state: before, changed: false };
      }

      const status = cardAction === 'TRASH' ? 'TRASHED' : cardAction === 'RESTORE' ? 'ACTIVE' : cardAction === 'DELETE' ? 'DELETED' : 'ACTIVE';
      const state = await tx.timesheetV2CardState.upsert({
        where,
        create: {
          month,
          customerKey,
          siteId,
          workAreaId,
          displayName: displayName ?? null,
          status,
          updatedByUserId: session.user.id
        },
        update: {
          ...(cardAction === 'RENAME' ? { displayName } : {}),
          status,
          updatedByUserId: session.user.id
        }
      });

      await createAuditEvent(tx, {
        actorUserId: session.user.id,
        eventType: `TIMESHEET_V2_CARD_${AUDIT_ACTIONS[cardAction]}`,
        entityType: 'TIMESHEET_V2_CARD',
        entityId: state.id,
        requestId,
        beforeValue: before ? { month, customerKey, displayName: before.displayName, status: before.status } : null,
        afterValue: { month, customerKey, displayName: state.displayName, status: state.status }
      });

      return { state, changed: true };
    });

    if ('error' in result) {
      if (result.error === 'CARD_NOT_IN_TRASH') return jsonError(409, { code: result.error, message: 'Only cards in the trash can be restored or permanently removed.' }, requestId);
      if (result.error === 'CARD_NOT_ACTIVE') return jsonError(409, { code: result.error, message: 'A card in the trash cannot be renamed.' }, requestId);
      return jsonError(409, { code: 'CARD_DELETED', message: 'This card has already been permanently removed from the monthly list.' }, requestId);
    }

    return NextResponse.json(
      { ok: true, changed: result.changed, status: result.state.status, displayName: result.state.displayName },
      { headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': requestId } }
    );
  } catch (error) {
    console.error('[timesheets-v2] card management failed', requestId, error);
    return jsonError(500, { code: 'CARD_ACTION_FAILED', message: 'Could not update the timesheet card.' }, requestId);
  }
}
