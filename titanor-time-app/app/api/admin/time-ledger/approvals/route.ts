import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { guardApiRequest } from '@/lib/api-guard';
import { customerHoursApprovalEnabled } from '@/lib/customer-hours-approval-flag';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, isValidIdempotencyKeyFormat, type IdempotencyIdentity } from '@/lib/idempotency';
import { verifyConfirmationToken, confirmationItemKeyEquals, type ConfirmationItemKey } from '@/lib/customer-hours-confirmation-token';
import { prepareWeeklyCustomerApproval, validateApprovalRequestBody, buildSelectionSnapshotV1, buildApprovalItemSnapshotV1, type WeeklyApprovalPreparationOk } from '@/lib/reporting/weekly-approval';
import { resolveCanonicalSource, type CanonicalSourceTimesheetInput } from '@/lib/reporting/canonical-source';
import { attemptTimesheetFinalization } from '@/lib/reporting/customer-hours-finalization';

// UT5-B — POST /api/admin/time-ledger/approvals. Exactly one explicit item (arrays/mass mode are
// UT6). Full order per UT5-A-R1: CSRF -> auth -> permission -> mandatory Idempotency-Key -> strict
// body parse/validation -> request hash -> beginIdempotentRequest -> cached/conflict handling ->
// confirmation-token verification -> business transaction -> completeIdempotentRequest for every
// normal result after PROCEED.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ROUTE_TEMPLATE = '/api/admin/time-ledger/approvals';

interface ResponseBody {
  status: number;
  body: unknown;
}

function errorBody(requestId: string, code: string, message: string, fieldErrors?: Record<string, string[]>): { error: ApiErrorBody & { requestId: string } } {
  return { error: { code, message, fieldErrors, requestId } };
}

// =================================================================================================
// The business transaction outcome — a discriminated result the transaction callback RETURNS
// (never throws) for every expected business case (stale/blocker/self-approval/already-approved/
// success). Throwing is reserved for genuinely unexpected DB errors (the P2002 backstop below),
// which must actually roll back the transaction rather than be swallowed.
// =================================================================================================

type CommitOutcome =
  | { kind: 'APPROVED'; batchId: string; itemId: string; fingerprint: string; workedMinutes: number; supersededItemId: string | null; finalized: boolean }
  | { kind: 'ALREADY_APPROVED'; itemId: string; fingerprint: string; workedMinutes: number; finalized: boolean }
  | { kind: 'ERROR'; status: number; code: string; message: string };

const APPROVAL_ITEM_UNIQUE_INDEX_MARKERS = ['ux_customer_hours_approval_item_active_with_customer', 'ux_customer_hours_approval_item_active_no_customer'];

function isApprovalItemUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const haystack = `${err.message} ${JSON.stringify(err.meta ?? {})}`;
  return APPROVAL_ITEM_UNIQUE_INDEX_MARKERS.some((marker) => haystack.includes(marker));
}

async function runCommitAttempt(
  itemKey: ConfirmationItemKey,
  expectedFingerprint: string,
  actorUserId: string,
  actorEmployeeId: string | null,
  actorRoles: string[],
  requestId: string,
  idempotencyKey: string,
  tokenEmployeeId: string
): Promise<CommitOutcome> {
  // Only a lookup, per UT5-A-R1 §3: which Employee row to lock first. Never trusted for anything
  // security-relevant afterward — the transaction re-reads Timesheet fresh under lock (step below)
  // and re-verifies employeeId did not change before doing anything else.
  const routing = await prisma.timesheet.findUnique({ where: { id: itemKey.timesheetId }, select: { employeeId: true } });
  if (!routing) {
    return { kind: 'ERROR', status: 404, code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' };
  }

  return prisma.$transaction(async (tx): Promise<CommitOutcome> => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${routing.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${itemKey.timesheetId}::uuid FOR UPDATE`;

    const freshTimesheet = await tx.timesheet.findUniqueOrThrow({
      where: { id: itemKey.timesheetId },
      select: { id: true, employeeId: true, status: true, currentVersionId: true, draft: { select: { id: true } }, currentVersion: { select: { versionNumber: true, submissionSource: true } } }
    });
    if (freshTimesheet.employeeId !== routing.employeeId) {
      // Timesheet.employeeId is never reassigned by any code path in this app — this is a defensive
      // TOCTOU guard (UT5-A-R1 §3's explicit requirement), not a reachable real-world state.
      return { kind: 'ERROR', status: 409, code: 'TIMESHEET_ROUTING_CHANGED', message: 'This timesheet changed ownership while the request was in flight — refresh and retry.' };
    }
    // UT5-B-fixup #1 — the confirmation token was issued for a specific employeeId (resolved by
    // preview at the time it ran); re-check it against the FRESH, now-locked Timesheet row rather
    // than ever trusting the token's own claim on its own. A mismatch means the token no longer
    // describes this timesheet's real owner (e.g. the employee changed between preview and commit)
    // and must never be honored, regardless of how the fingerprint/blockers/item-key checks below
    // would otherwise resolve.
    if (freshTimesheet.employeeId !== tokenEmployeeId) {
      return { kind: 'ERROR', status: 403, code: 'CONFIRMATION_TOKEN_INVALID', message: 'This confirmation is not valid for this request.' };
    }

    // Determine DRAFT vs VERSION from the now-locked, fresh Timesheet row (same pure function
    // prepareWeeklyCustomerApproval will call again below — a cheap, dependency-free re-derivation
    // from already-loaded fields, never a second FORMULA, just the one function called twice).
    const sourceInput: CanonicalSourceTimesheetInput = {
      id: freshTimesheet.id,
      status: freshTimesheet.status,
      currentVersionId: freshTimesheet.currentVersionId,
      draft: freshTimesheet.draft,
      currentVersion: freshTimesheet.currentVersion
    };
    let isDraftSourced: boolean;
    try {
      isDraftSourced = resolveCanonicalSource(sourceInput).dataSource === 'DRAFT';
    } catch {
      // No draft/currentVersion despite the status implying one should exist -- SOURCE_ERROR,
      // surfaced identically by prepareWeeklyCustomerApproval below; no TimesheetDraft lock needed
      // for a source that cannot be read at all.
      isDraftSourced = false;
    }
    if (isDraftSourced) {
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${itemKey.timesheetId}::uuid FOR UPDATE`;
    }

    // Lock the CURRENT CustomerHoursApprovalItem for this exact logical key, if one exists (0 rows
    // otherwise — safe, since the Timesheet lock above already serializes every concurrent commit
    // attempt for this timesheet, UT5-A-R1 §3/§4). NULL-safe workAreaId comparison via IS NOT
    // DISTINCT FROM (plain `=` never matches NULL to NULL in SQL).
    await tx.$queryRaw`
      SELECT id FROM "CustomerHoursApprovalItem"
      WHERE "employeeId" = ${freshTimesheet.employeeId}::uuid
        AND "timesheetId" = ${itemKey.timesheetId}::uuid
        AND "siteId" = ${itemKey.siteId}::uuid
        AND "workAreaId" IS NOT DISTINCT FROM ${itemKey.workAreaId}::uuid
        AND "weekStart" = ${itemKey.weekStart}::date
        AND "approvalState" = 'CURRENT'
      FOR UPDATE
    `;

    const prepared = await prepareWeeklyCustomerApproval({ itemKey, actor: { userId: actorUserId, employeeId: actorEmployeeId }, mode: 'COMMIT', db: tx });

    if (!prepared.ok) {
      switch (prepared.reason) {
        case 'INVALID_WORK_AREA_SITE':
          return { kind: 'ERROR', status: 400, code: 'INVALID_WORK_AREA_SITE', message: 'workAreaId does not belong to siteId.' };
        case 'TIMESHEET_NOT_FOUND':
          return { kind: 'ERROR', status: 404, code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' };
        case 'SOURCE_ERROR':
          return { kind: 'ERROR', status: 409, code: 'SOURCE_ERROR', message: 'This timesheet has no readable canonical source.' };
        case 'SLICE_NOT_FOUND':
          return { kind: 'ERROR', status: 409, code: 'SLICE_NOT_FOUND', message: 'No hours found for this customer/week.' };
        case 'INVARIANT_FAILURE':
          return { kind: 'ERROR', status: 409, code: 'INVARIANT_FAILURE', message: "Could not compute this week's hours." };
        default: {
          const exhaustive: never = prepared;
          throw new Error(`unreachable prepareWeeklyCustomerApproval reason: ${JSON.stringify(exhaustive)}`);
        }
      }
    }

    if (prepared.slice.fingerprint !== expectedFingerprint) {
      return { kind: 'ERROR', status: 409, code: 'APPROVAL_SELECTION_STALE', message: 'The hours for this week changed since you last saw them — refresh and try again.' };
    }

    if (prepared.blockers.length > 0) {
      const first = prepared.blockers[0];
      return { kind: 'ERROR', status: 409, code: first.code, message: first.message };
    }

    const existing = prepared.existingCurrentItem;

    // ALREADY_APPROVED — existing CURRENT item already carries the exact fingerprint being
    // approved. Never write to Batch/Item (the trigger forbids a no-op CURRENT->CURRENT update
    // anyway); only an AuditEvent-only "reconfirmed" fact (UT5-A-R1 §6).
    if (existing && existing.fingerprint === prepared.slice.fingerprint) {
      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'CUSTOMER_HOURS_APPROVAL_RECONFIRMED',
        entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM',
        entityId: existing.id,
        requestId,
        afterValue: {
          itemKey: { employeeId: prepared.employeeId, timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: itemKey.weekStart },
          fingerprint: prepared.slice.fingerprint,
          workedMinutes: prepared.slice.workedMinutes
        }
      });
      // UT9-B — even a no-op reconfirm can be the LAST missing piece of coverage if every other
      // customer of this timesheet was already confirmed by a separate, earlier action.
      const finalization = await attemptTimesheetFinalization(tx, itemKey.timesheetId, actorUserId, actorRoles, requestId);
      return { kind: 'ALREADY_APPROVED', itemId: existing.id, fingerprint: prepared.slice.fingerprint, workedMinutes: prepared.slice.workedMinutes, finalized: finalization.finalized };
    }

    // Supersede the old CURRENT item first (UT5-A-R1 §7 — only these 3 columns, the trigger rejects
    // any other change alongside the transition), THEN insert the new one — both inside this one
    // transaction, so the partial unique index is never violated by the insert below.
    let supersededItemId: string | null = null;
    if (existing) {
      await tx.customerHoursApprovalItem.update({
        where: { id: existing.id },
        data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: prepared.canonicalSource.sourceId }
      });
      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED',
        entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM',
        entityId: existing.id,
        requestId,
        beforeValue: { approvalState: 'CURRENT', fingerprint: existing.fingerprint },
        afterValue: { approvalState: 'SUPERSEDED', supersededBySourceId: prepared.canonicalSource.sourceId }
      });
      supersededItemId = existing.id;
    }

    const selectionSnapshot = buildSelectionSnapshotV1([itemKey]);
    const batch = await tx.customerHoursApprovalBatch.create({
      data: {
        approvedByUserId: actorUserId,
        requestId,
        idempotencyKey,
        selectionSnapshot: selectionSnapshot as unknown as Prisma.InputJsonValue,
        itemCount: 1,
        workedMinutes: prepared.slice.workedMinutes
      }
    });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CUSTOMER_HOURS_APPROVAL_BATCH_CREATED',
      entityType: 'CUSTOMER_HOURS_APPROVAL_BATCH',
      entityId: batch.id,
      requestId,
      afterValue: { itemCount: 1, workedMinutes: prepared.slice.workedMinutes }
    });

    const itemSnapshot = buildApprovalItemSnapshotV1(prepared as WeeklyApprovalPreparationOk);
    const item = await tx.customerHoursApprovalItem.create({
      data: {
        batchId: batch.id,
        timesheetId: itemKey.timesheetId,
        employeeId: prepared.employeeId,
        siteId: itemKey.siteId,
        workAreaId: itemKey.workAreaId,
        weekStart: new Date(`${itemKey.weekStart}T00:00:00.000Z`),
        weekEnd: new Date(`${prepared.slice.logicalKey.weekEnd}T00:00:00.000Z`),
        sourceKind: prepared.canonicalSource.sourceKind,
        sourceId: prepared.canonicalSource.sourceId,
        sourceRevision: prepared.canonicalSource.sourceRevision !== null ? BigInt(prepared.canonicalSource.sourceRevision) : null,
        fingerprint: prepared.slice.fingerprint,
        workedMinutes: prepared.slice.workedMinutes,
        grossMinutes: prepared.slice.grossMinutes,
        breakMinutes: prepared.slice.breakMinutes,
        snapshot: itemSnapshot as unknown as Prisma.InputJsonValue,
        approvalState: 'CURRENT'
      }
    });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CUSTOMER_HOURS_APPROVED',
      entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM',
      entityId: item.id,
      requestId,
      afterValue: {
        itemKey: { employeeId: prepared.employeeId, timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: itemKey.weekStart },
        fingerprint: prepared.slice.fingerprint,
        workedMinutes: prepared.slice.workedMinutes,
        sourceKind: prepared.canonicalSource.sourceKind,
        sourceId: prepared.canonicalSource.sourceId
      }
    });

    const finalization = await attemptTimesheetFinalization(tx, itemKey.timesheetId, actorUserId, actorRoles, requestId);
    return { kind: 'APPROVED', batchId: batch.id, itemId: item.id, fingerprint: prepared.slice.fingerprint, workedMinutes: prepared.slice.workedMinutes, supersededItemId, finalized: finalization.finalized };
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardApiRequest(request, { csrf: true, permission: 'timesheet.customer_hours_approve.all' });
  if (!guard.ok) return guard.response;
  const { session, requestId } = guard;
  if (!customerHoursApprovalEnabled()) return jsonError(409, { code: 'FEATURE_DISABLED', message: 'Customer hours approval is disabled.' }, requestId);

  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (!idempotencyKeyHeader || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' }, requestId);
  }

  const validated = validateApprovalRequestBody(rawBody);
  const bodyRecord = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const confirmationTokenRaw = bodyRecord.confirmationToken;
  const fieldErrors: Record<string, string[]> = validated.ok ? {} : { ...validated.fieldErrors };
  if (typeof confirmationTokenRaw !== 'string' || confirmationTokenRaw.length === 0) {
    fieldErrors.confirmationToken = ['must be a non-empty string'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId);
  }
  const { itemKey, expectedFingerprint } = (validated as { ok: true; value: { itemKey: ConfirmationItemKey; expectedFingerprint: string } }).value;
  const confirmationToken = confirmationTokenRaw as string;

  const identity: IdempotencyIdentity = { actorUserId: session.user.id, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: idempotencyKeyHeader };
  // Request hash includes the FULL normalized body (itemKey + expectedFingerprint +
  // confirmationToken) — UT5-A-R1 §7 explicit requirement, even though this means a retry with the
  // same Idempotency-Key but a freshly re-issued token (e.g. because the first token expired)
  // reads as a "different body" (409 IDEMPOTENCY_KEY_REUSED) rather than a cache hit. A genuine
  // retry of the same click, within the token's own short TTL, is unaffected.
  const requestHash = computeRequestHash({ body: { itemKey, expectedFingerprint, confirmationToken } });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(409, { code: begin.code, message: 'This Idempotency-Key cannot be used for this request.' }, requestId);
  }

  const respond = async ({ status, body }: ResponseBody): Promise<NextResponse> => {
    // UT5-A-R1 §7 — this write is a SEPARATE transaction from the business commit above. If it
    // fails after the business transaction already committed, the approval itself stays durably
    // correct (domain uniqueness + the Timesheet lock already prevented any duplicate); only this
    // HTTP-level replay cache can end up stuck, a known, accepted limitation of the shared
    // lib/idempotency.ts helper — not something this route papers over by writing to IdempotencyKey
    // itself outside that module.
    await completeIdempotentRequest(identity, { statusCode: status, body });
    return NextResponse.json(body, { status, headers: successHeaders(requestId) });
  };

  const verified = verifyConfirmationToken(confirmationToken);
  if (!verified.ok) {
    if (verified.reason === 'EXPIRED') {
      return respond({ status: 409, body: errorBody(requestId, 'CONFIRMATION_TOKEN_EXPIRED', 'This confirmation expired — reload and try again.') });
    }
    return respond({ status: 403, body: errorBody(requestId, 'CONFIRMATION_TOKEN_INVALID', 'This confirmation is not valid for this request.') });
  }
  const { payload } = verified;
  if (payload.actorUserId !== session.user.id || !confirmationItemKeyEquals(payload.itemKey, itemKey) || payload.expectedFingerprint !== expectedFingerprint) {
    return respond({ status: 403, body: errorBody(requestId, 'CONFIRMATION_TOKEN_INVALID', 'This confirmation is not valid for this request.') });
  }

  let outcome: CommitOutcome;
  try {
    outcome = await runCommitAttempt(itemKey, expectedFingerprint, session.user.id, session.user.employeeId, session.user.roles, requestId, idempotencyKeyHeader, payload.employeeId);
  } catch (err) {
    if (isApprovalItemUniqueViolation(err)) {
      try {
        outcome = await runCommitAttempt(itemKey, expectedFingerprint, session.user.id, session.user.employeeId, session.user.roles, requestId, idempotencyKeyHeader, payload.employeeId);
      } catch (err2) {
        if (isApprovalItemUniqueViolation(err2)) {
          outcome = { kind: 'ERROR', status: 409, code: 'APPROVAL_CONFLICT', message: 'Could not complete this approval due to a conflicting concurrent write — please retry.' };
        } else {
          throw err2;
        }
      }
    } else {
      throw err;
    }
  }

  if (outcome.kind === 'ERROR') {
    return respond({ status: outcome.status, body: errorBody(requestId, outcome.code, outcome.message) });
  }

  const responseBody = {
    requestId,
    result: outcome.kind,
    batchId: outcome.kind === 'APPROVED' ? outcome.batchId : null,
    itemId: outcome.itemId,
    itemKey: { ...itemKey, employeeId: payload.employeeId },
    fingerprint: outcome.fingerprint,
    workedMinutes: outcome.workedMinutes,
    supersededItemId: outcome.kind === 'APPROVED' ? outcome.supersededItemId : null,
    // UT9-B — real now: this timesheet's id iff attemptTimesheetFinalization actually flipped it to
    // FINAL_APPROVED as a direct, atomic consequence of this exact confirmation reaching full
    // coverage. Empty whenever it did not (partial coverage, ineligible status, missing
    // timesheet.final_approve, or already final) — never a partial/best-effort finalization.
    finalizedTimesheetIds: outcome.finalized ? [itemKey.timesheetId] : ([] as string[])
  };
  return respond({ status: 200, body: responseBody });
}
