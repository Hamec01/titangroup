import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { guardApiRequest } from '@/lib/api-guard';
import { customerHoursApprovalEnabled } from '@/lib/customer-hours-approval-flag';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, isValidIdempotencyKeyFormat, type IdempotencyIdentity } from '@/lib/idempotency';
import { verifyMassConfirmationToken } from '@/lib/customer-hours-confirmation-token';
import { resolveCanonicalSource, type CanonicalSourceTimesheetInput } from '@/lib/reporting/canonical-source';
import {
  prepareWeeklyCustomerApprovalsBatch,
  validateMassSelection,
  computeSelectionHash,
  sortSelectionCanonically,
  buildSelectionSnapshotV1,
  buildApprovalItemSnapshotV1,
  classifyMassApprovalItemProblem,
  type ValidatedApprovalRequestBody,
  type WeeklyApprovalBatchItemResult,
  type MassSelectionScope
} from '@/lib/reporting/weekly-approval';
import { attemptTimesheetFinalization } from '@/lib/reporting/customer-hours-finalization';
import type { ConfirmationItemKey } from '@/lib/customer-hours-confirmation-token';

// UT6-B — POST /api/admin/time-ledger/mass-approvals. Same overall shape as UT5-B's single-item
// commit (CSRF -> auth -> permission -> mandatory Idempotency-Key -> strict body parse/validation ->
// request hash -> beginIdempotentRequest -> cached/conflict handling -> confirmation-token
// verification -> business transaction -> completeIdempotentRequest for every normal result after
// PROCEED), generalized to an explicit `selection` array (UT6-A-R1): one atomic transaction, a
// single deterministic Employee -> Timesheet -> TimesheetDraft -> CustomerHoursApprovalItem lock
// order with every tier locked as ONE multi-row `ORDER BY id FOR UPDATE` statement, and a genuinely
// technical blocker or a stale item on ANY selected slice aborts the WHOLE transaction — nothing is
// ever partially approved.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ROUTE_TEMPLATE = '/api/admin/time-ledger/mass-approvals';
const ALLOWED_BODY_KEYS = ['selection', 'confirmationToken', 'scope'];

interface ResponseBody {
  status: number;
  body: unknown;
}

function errorBody(requestId: string, code: string, message: string, extra?: Record<string, unknown>): { error: ApiErrorBody & { requestId: string } & Record<string, unknown> } {
  return { error: { code, message, requestId, ...extra } };
}

interface ItemResultDto {
  itemKey: ConfirmationItemKey & { employeeId: string };
  result: 'APPROVED' | 'ALREADY_APPROVED';
  itemId: string;
  fingerprint: string;
  workedMinutes: number;
  supersededItemId: string | null;
}

type MassCommitOutcome =
  | { kind: 'ERROR'; status: number; code: string; message: string; failedItemKey?: ConfirmationItemKey }
  | { kind: 'COMMITTED'; batchId: string | null; results: ItemResultDto[]; finalizedTimesheetIds: string[] };

const APPROVAL_ITEM_UNIQUE_INDEX_MARKERS = ['ux_customer_hours_approval_item_active_with_customer', 'ux_customer_hours_approval_item_active_no_customer'];

function isApprovalItemUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const haystack = `${err.message} ${JSON.stringify(err.meta ?? {})}`;
  return APPROVAL_ITEM_UNIQUE_INDEX_MARKERS.some((marker) => haystack.includes(marker));
}

const REASON_STATUS: Record<string, number> = { INVALID_WORK_AREA_SITE: 400, TIMESHEET_NOT_FOUND: 404, SOURCE_ERROR: 409, SLICE_NOT_FOUND: 409, INVARIANT_FAILURE: 409 };

/**
 * UT6-B-fixup #3/#2 — the first prepared item that "cannot proceed": a genuinely technical failure
 * (`!ok`), a stale fingerprint, or a real blocker (`blockers.length > 0`). Delegates entirely to
 * lib/reporting/weekly-approval.ts's classifyMassApprovalItemProblem — the SAME function the mass
 * preview route calls per item — so commit's "abort the whole batch" decision and preview's
 * per-item outcome/technicalBlocker/token-eligibility decision can never diverge again (UT6-B-fixup
 * #2 was exactly that divergence: preview issued a token and outcome=WILL_APPROVE for an item this
 * function already correctly rejected). Exported so it stays directly unit-testable against a
 * hand-built WeeklyApprovalBatchItemResult[] without needing a real blocker fixture through the full
 * pipeline. Pure — no I/O, no lock, no transaction awareness.
 */
export function findFirstMassApprovalProblem(prepared: WeeklyApprovalBatchItemResult[]): WeeklyApprovalBatchItemResult | undefined {
  return prepared.find((r) => classifyMassApprovalItemProblem(r) !== null);
}

async function runMassCommitAttempt(
  originalSelection: ValidatedApprovalRequestBody[],
  scope: MassSelectionScope,
  actorUserId: string,
  actorEmployeeId: string | null,
  actorRoles: string[],
  requestId: string,
  idempotencyKey: string
): Promise<MassCommitOutcome> {
  const timesheetIds = [...new Set(originalSelection.map((s) => s.itemKey.timesheetId))];

  // Pre-transaction routing lookup only (UT5-A-R1 §3's convention, generalized to N timesheets) —
  // never trusted afterward. The transaction re-reads every Timesheet fresh under lock below and
  // re-verifies employeeId did not change before doing anything else.
  const routingRows = await prisma.timesheet.findMany({ where: { id: { in: timesheetIds } }, select: { id: true, employeeId: true } });
  if (routingRows.length !== timesheetIds.length) {
    return { kind: 'ERROR', status: 404, code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with one of these ids.' };
  }
  const routingByTimesheetId = new Map(routingRows.map((r) => [r.id, r.employeeId]));
  const employeeIds = [...new Set(routingRows.map((r) => r.employeeId))];

  return prisma.$transaction(async (tx): Promise<MassCommitOutcome> => {
    // Deterministic lock order (UT6-A-R1 §15): Employees -> Timesheets -> TimesheetDrafts ->
    // CURRENT CustomerHoursApprovalItems, each tier ONE multi-row statement with its own
    // `ORDER BY id` (the actual determinism comes from this SQL ORDER BY, not from the order the ids
    // are passed in) — never one lock per selection item, never in the client array's own order.
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ANY(${employeeIds}::uuid[]) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ANY(${timesheetIds}::uuid[]) ORDER BY id FOR UPDATE`;

    const freshTimesheets = await tx.timesheet.findMany({
      where: { id: { in: timesheetIds } },
      select: { id: true, employeeId: true, status: true, currentVersionId: true, draft: { select: { id: true } }, currentVersion: { select: { versionNumber: true, submissionSource: true } } }
    });
    const freshById = new Map(freshTimesheets.map((t) => [t.id, t]));
    for (const id of timesheetIds) {
      const fresh = freshById.get(id);
      if (!fresh || fresh.employeeId !== routingByTimesheetId.get(id)) {
        // Timesheet.employeeId is never reassigned by any code path in this app — defensive TOCTOU
        // guard, same convention as the single-item route, not a reachable real-world state.
        return { kind: 'ERROR', status: 409, code: 'TIMESHEET_ROUTING_CHANGED', message: 'One of the selected timesheets changed ownership while the request was in flight — refresh and retry.' };
      }
    }

    const draftTimesheetIds: string[] = [];
    for (const t of freshTimesheets) {
      const input: CanonicalSourceTimesheetInput = { id: t.id, status: t.status, currentVersionId: t.currentVersionId, draft: t.draft, currentVersion: t.currentVersion };
      try {
        if (resolveCanonicalSource(input).dataSource === 'DRAFT') draftTimesheetIds.push(t.id);
      } catch {
        // No draft/currentVersion despite the status implying one should exist — SOURCE_ERROR,
        // surfaced identically by prepareWeeklyCustomerApprovalsBatch below; no TimesheetDraft lock
        // needed for a source that cannot be read at all.
      }
    }
    if (draftTimesheetIds.length > 0) {
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ANY(${draftTimesheetIds}::uuid[]) ORDER BY id FOR UPDATE`;
    }

    // Lock every CURRENT CustomerHoursApprovalItem this selection's logical keys could match, ONE
    // statement via UNNEST(timesheetIds, weekStarts). For scope='CUSTOMER', validateMassSelection
    // already guarantees the whole selection shares one (siteId, workAreaId) customer, so the extra
    // siteId/workAreaId filter keeps this tuple-IN from also locking some OTHER customer's row that
    // happens to share a (timesheetId, weekStart) with the selection (over-locking would silently
    // reduce concurrency for unrelated customers). For scope='WEEK', validateMassSelection instead
    // guarantees one (timesheetId, weekStart) with site/workArea free to vary — the whole point is
    // locking every customer row for that one worker's one week, so the siteId/workAreaId filter is
    // dropped entirely and the tuple-IN alone is the correct, exact scope.
    const lockTimesheetIds = originalSelection.map((s) => s.itemKey.timesheetId);
    const lockWeekStarts = originalSelection.map((s) => s.itemKey.weekStart);
    if (scope === 'WEEK') {
      await tx.$queryRaw`
        SELECT id FROM "CustomerHoursApprovalItem"
        WHERE "approvalState" = 'CURRENT'
          AND ("timesheetId", "weekStart") IN (SELECT * FROM UNNEST(${lockTimesheetIds}::uuid[], ${lockWeekStarts}::date[]))
        ORDER BY id
        FOR UPDATE
      `;
    } else {
      const contextSiteId = originalSelection[0].itemKey.siteId;
      const contextWorkAreaId = originalSelection[0].itemKey.workAreaId;
      await tx.$queryRaw`
        SELECT id FROM "CustomerHoursApprovalItem"
        WHERE "approvalState" = 'CURRENT'
          AND "siteId" = ${contextSiteId}::uuid
          AND "workAreaId" IS NOT DISTINCT FROM ${contextWorkAreaId}::uuid
          AND ("timesheetId", "weekStart") IN (SELECT * FROM UNNEST(${lockTimesheetIds}::uuid[], ${lockWeekStarts}::date[]))
        ORDER BY id
        FOR UPDATE
      `;
    }

    const prepared = await prepareWeeklyCustomerApprovalsBatch({ selection: originalSelection, actor: { userId: actorUserId, employeeId: actorEmployeeId }, mode: 'COMMIT', db: tx });

    // UT6-A-R1 §6/§13 — one technical blocker or one stale item anywhere in the selection aborts the
    // WHOLE transaction; nothing is written for any item.
    const firstProblem = findFirstMassApprovalProblem(prepared);
    if (firstProblem) {
      if (!firstProblem.ok) {
        return {
          kind: 'ERROR',
          status: REASON_STATUS[firstProblem.reason] ?? 409,
          code: firstProblem.reason,
          message: `${firstProblem.reason} on one of the selected items — the whole selection was not approved.`,
          failedItemKey: firstProblem.itemKey
        };
      }
      if (!firstProblem.matchesExpectedFingerprint) {
        return {
          kind: 'ERROR',
          status: 409,
          code: 'APPROVAL_SELECTION_STALE',
          message: 'The hours for one of the selected items changed since you last saw them — refresh and try again.',
          failedItemKey: firstProblem.itemKey
        };
      }
      // UT6-B-fixup #3 — defensive: classifyIssues() never returns a non-empty blockers array as of
      // UT6-A-R1 §1's reclassification (self-approval/open-shift/open-correction all moved to
      // warnings), but this mass commit must never silently ignore a genuine future blocker type just
      // because today's blockers array happens to always be empty. A real blocker aborts the whole
      // batch exactly like a technical/stale problem — never partially, never silently. Business
      // warnings (whatever is currently in `warnings`) never reach this branch and never block.
      const firstBlocker = firstProblem.blockers[0];
      return { kind: 'ERROR', status: 409, code: firstBlocker.code, message: firstBlocker.message, failedItemKey: firstProblem.itemKey };
    }

    const okItems = prepared.filter((r): r is Extract<WeeklyApprovalBatchItemResult, { ok: true }> => r.ok);
    const alreadyApproved = okItems.filter((r) => r.existingCurrentItem && r.existingCurrentItem.fingerprint === r.slice.fingerprint);
    const toWrite = okItems.filter((r) => !r.existingCurrentItem || r.existingCurrentItem.fingerprint !== r.slice.fingerprint);

    const results: ItemResultDto[] = alreadyApproved.map((r) => ({
      // UT6-A-R1 §3 (final decision) — mass already-approved, unchanged items create NO audit event
      // and NO write, unlike the single-item RECONFIRMED fact; only counted, never noise in history.
      itemKey: { ...r.itemKey, employeeId: r.employeeId },
      result: 'ALREADY_APPROVED',
      itemId: r.existingCurrentItem!.id,
      fingerprint: r.existingCurrentItem!.fingerprint,
      workedMinutes: r.slice.workedMinutes,
      supersededItemId: null
    }));

    let batchId: string | null = null;
    if (toWrite.length > 0) {
      const totalWorkedMinutes = toWrite.reduce((sum, r) => sum + r.slice.workedMinutes, 0);
      const selectionSnapshot = buildSelectionSnapshotV1(
        originalSelection.map((s) => s.itemKey),
        'MASS'
      );
      const batch = await tx.customerHoursApprovalBatch.create({
        data: {
          approvedByUserId: actorUserId,
          requestId,
          idempotencyKey,
          selectionSnapshot: selectionSnapshot as unknown as Prisma.InputJsonValue,
          itemCount: toWrite.length,
          workedMinutes: totalWorkedMinutes
        }
      });
      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'CUSTOMER_HOURS_APPROVAL_BATCH_CREATED',
        entityType: 'CUSTOMER_HOURS_APPROVAL_BATCH',
        entityId: batch.id,
        requestId,
        afterValue: { itemCount: toWrite.length, workedMinutes: totalWorkedMinutes }
      });

      for (const r of toWrite) {
        const existing = r.existingCurrentItem;
        let supersededItemId: string | null = null;
        if (existing) {
          await tx.customerHoursApprovalItem.update({
            where: { id: existing.id },
            data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: r.canonicalSource.sourceId }
          });
          await createAuditEvent(tx, {
            actorUserId,
            eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED',
            entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM',
            entityId: existing.id,
            requestId,
            beforeValue: { approvalState: 'CURRENT', fingerprint: existing.fingerprint },
            afterValue: { approvalState: 'SUPERSEDED', supersededBySourceId: r.canonicalSource.sourceId }
          });
          supersededItemId = existing.id;
        }

        const itemSnapshot = buildApprovalItemSnapshotV1(r);
        const item = await tx.customerHoursApprovalItem.create({
          data: {
            batchId: batch.id,
            timesheetId: r.itemKey.timesheetId,
            employeeId: r.employeeId,
            siteId: r.itemKey.siteId,
            workAreaId: r.itemKey.workAreaId,
            weekStart: new Date(`${r.itemKey.weekStart}T00:00:00.000Z`),
            weekEnd: new Date(`${r.slice.logicalKey.weekEnd}T00:00:00.000Z`),
            sourceKind: r.canonicalSource.sourceKind,
            sourceId: r.canonicalSource.sourceId,
            sourceRevision: r.canonicalSource.sourceRevision !== null ? BigInt(r.canonicalSource.sourceRevision) : null,
            fingerprint: r.slice.fingerprint,
            workedMinutes: r.slice.workedMinutes,
            grossMinutes: r.slice.grossMinutes,
            breakMinutes: r.slice.breakMinutes,
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
            itemKey: { employeeId: r.employeeId, timesheetId: r.itemKey.timesheetId, siteId: r.itemKey.siteId, workAreaId: r.itemKey.workAreaId, weekStart: r.itemKey.weekStart },
            fingerprint: r.slice.fingerprint,
            workedMinutes: r.slice.workedMinutes,
            sourceKind: r.canonicalSource.sourceKind,
            sourceId: r.canonicalSource.sourceId
          }
        });

        results.push({ itemKey: { ...r.itemKey, employeeId: r.employeeId }, result: 'APPROVED', itemId: item.id, fingerprint: r.slice.fingerprint, workedMinutes: r.slice.workedMinutes, supersededItemId });
      }
      batchId = batch.id;
    }

    // UT9-B — every DISTINCT timesheet this selection touched (both freshly written AND
    // already-approved no-op items — a no-op reconfirm can be the LAST missing piece if every other
    // customer of that same timesheet was already confirmed by a separate, earlier action), checked
    // once each. "Принять все"/"Принять всю неделю" both flow through here: whichever of the
    // touched timesheets reaches full coverage gets finalized, the rest are simply left as they are
    // — never a partial/best-effort finalization of an incompletely-covered one.
    const finalizedTimesheetIds: string[] = [];
    for (const timesheetId of new Set(okItems.map((r) => r.itemKey.timesheetId))) {
      const finalization = await attemptTimesheetFinalization(tx, timesheetId, actorUserId, actorRoles, requestId);
      if (finalization.finalized) finalizedTimesheetIds.push(timesheetId);
    }

    return { kind: 'COMMITTED', batchId, results, finalizedTimesheetIds };
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
  if (rawBody === null || typeof rawBody !== 'object' || Object.keys(rawBody as Record<string, unknown>).some((k) => !ALLOWED_BODY_KEYS.includes(k))) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, requestId);
  }
  const bodyRecord = rawBody as Record<string, unknown>;

  const scopeRaw = bodyRecord.scope;
  if (scopeRaw !== undefined && scopeRaw !== 'CUSTOMER' && scopeRaw !== 'WEEK') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { scope: ["must be 'CUSTOMER' or 'WEEK'"] } }, requestId);
  }
  const scope: MassSelectionScope = scopeRaw === 'WEEK' ? 'WEEK' : 'CUSTOMER';

  const validated = validateMassSelection(bodyRecord.selection, scope);
  if (!validated.ok) {
    return jsonError(400, { code: validated.error.code, message: validated.error.message, fieldErrors: validated.error.fieldErrors }, requestId);
  }
  const confirmationTokenRaw = bodyRecord.confirmationToken;
  if (typeof confirmationTokenRaw !== 'string' || confirmationTokenRaw.length === 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { confirmationToken: ['must be a non-empty string'] } }, requestId);
  }
  const selection = validated.value;
  const confirmationToken = confirmationTokenRaw;

  const identity: IdempotencyIdentity = { actorUserId: session.user.id, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: idempotencyKeyHeader };
  // UT6-A-R1 §18 — the request hash is built from the CANONICALLY SORTED selection, never the
  // client's raw array order, so a genuine retry that happens to serialize the same logical
  // selection in a different order still hits the SAME cached response instead of a spurious
  // IDEMPOTENCY_KEY_REUSED conflict.
  const normalizedSelection = sortSelectionCanonically(selection).map((s) => ({ itemKey: s.itemKey, expectedFingerprint: s.expectedFingerprint }));
  const requestHash = computeRequestHash({ body: { selection: normalizedSelection, confirmationToken, scope } });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(409, { code: begin.code, message: 'This Idempotency-Key cannot be used for this request.' }, requestId);
  }

  const respond = async ({ status, body }: ResponseBody): Promise<NextResponse> => {
    // Same accepted limitation as the single-item route (UT5-A-R1 §7): this write is a SEPARATE
    // transaction from the business commit above. If it fails after the business transaction already
    // committed, the approval itself stays durably correct; only this HTTP-level replay cache can end
    // up stuck.
    await completeIdempotentRequest(identity, { statusCode: status, body });
    return NextResponse.json(body, { status, headers: successHeaders(requestId) });
  };

  const verified = verifyMassConfirmationToken(confirmationToken);
  if (!verified.ok) {
    if (verified.reason === 'EXPIRED') {
      return respond({ status: 409, body: errorBody(requestId, 'CONFIRMATION_TOKEN_EXPIRED', 'This confirmation expired — reload and try again.') });
    }
    return respond({ status: 403, body: errorBody(requestId, 'CONFIRMATION_TOKEN_INVALID', 'This confirmation is not valid for this request.') });
  }
  const { payload } = verified;
  const selectionHash = computeSelectionHash(selection);
  if (payload.actorUserId !== session.user.id || payload.selectionHash !== selectionHash || payload.itemCount !== selection.length) {
    return respond({ status: 403, body: errorBody(requestId, 'CONFIRMATION_TOKEN_INVALID', 'This confirmation is not valid for this request.') });
  }

  let outcome: MassCommitOutcome;
  try {
    outcome = await runMassCommitAttempt(selection, scope, session.user.id, session.user.employeeId, session.user.roles, requestId, idempotencyKeyHeader);
  } catch (err) {
    if (isApprovalItemUniqueViolation(err)) {
      // At most one bounded retry, entirely outside the aborted transaction (UT5-A-R1 §3/§15) — the
      // whole multi-item attempt re-runs from scratch, never a per-item catch-and-continue inside an
      // already-aborted transaction.
      try {
        outcome = await runMassCommitAttempt(selection, scope, session.user.id, session.user.employeeId, session.user.roles, requestId, idempotencyKeyHeader);
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
    return respond({ status: outcome.status, body: errorBody(requestId, outcome.code, outcome.message, outcome.failedItemKey ? { failedItemKey: outcome.failedItemKey } : undefined) });
  }

  const itemCount = outcome.results.filter((r) => r.result === 'APPROVED').length;
  const alreadyApprovedCount = outcome.results.filter((r) => r.result === 'ALREADY_APPROVED').length;

  return respond({
    status: 200,
    body: { requestId, batchId: outcome.batchId, itemCount, alreadyApprovedCount, results: outcome.results, finalizedTimesheetIds: outcome.finalizedTimesheetIds }
  });
}
