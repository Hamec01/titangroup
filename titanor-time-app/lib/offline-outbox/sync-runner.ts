// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6/§7 — the sync runner: batch builder
// (bounded, never splits a Switch Site pair), POST /sync, backoff, response application. Browser-only.

import { broadcastOutboxChanged } from './broadcast';
import { applyGroupResult, applySingleEventResult, markSending, revertBatchToPending, type SyncEventResultWire } from './outbox';
import { getAllOutboxEvents, getDb, getDeviceState, txDone, STORE_DEVICE_STATE, SINGLETON_KEY, type OutboxEventRecord, type DevicePausedReason } from './db';

const CSRF_HEADER_VALUE = 'titanor-time';
const SYNC_FETCH_TIMEOUT_MS = 30000;
const CLOCK_STATE_FETCH_TIMEOUT_MS = 15000;
export const MAX_SYNC_BATCH_EVENTS = 100; // mirrors lib/attendance-sync.ts's MAX_SYNC_BATCH_EVENTS — server-enforced, documented here for the client's own chunking.

export interface ClockStateOpenShiftWire {
  openedAt: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  sourceAssignmentId: string | null;
  openedByClockEventId: string;
}
export interface ClockStateWire {
  serverNow: string;
  state: 'CLOCKED_OUT' | 'CLOCKED_IN';
  openShift: ClockStateOpenShiftWire | null;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toWireEvent(record: OutboxEventRecord) {
  return {
    clientEventId: record.clientEventId,
    deviceSequence: record.deviceSequence,
    groupId: record.groupId,
    operationType: record.operationType,
    siteId: record.siteId,
    assumedSiteId: record.assumedSiteId,
    workAreaId: record.workAreaId,
    clientCapturedAt: record.clientCapturedAt,
    capturedOffline: true as const,
    cachedGeofenceVersionId: record.cachedGeofenceVersionId,
    gps: record.gps,
    gpsUnavailableReason: record.gpsUnavailableReason
  };
}

async function getEligibleRecords(force: boolean): Promise<OutboxEventRecord[]> {
  const all = await getAllOutboxEvents();
  const nowIso = new Date().toISOString();
  return all.filter((r) => r.state === 'SENDING' || (r.state === 'PENDING' && (force || r.nextAttemptAt <= nowIso))).sort((a, b) => a.deviceSequence - b.deviceSequence);
}

/** §6 "Batch-builder не режет группу границей batch" — a cut that would land strictly between the
 * two (always sequence-adjacent) halves of a Switch Site pair backs off to exclude the orphaned
 * first half too, never sending a partial group. */
export function buildBatch(eligible: OutboxEventRecord[], maxBatch = MAX_SYNC_BATCH_EVENTS): OutboxEventRecord[] {
  if (eligible.length <= maxBatch) {
    return eligible;
  }
  let cut = maxBatch;
  while (cut > 0 && eligible[cut - 1].groupId !== null && eligible[cut] !== undefined && eligible[cut - 1].groupId === eligible[cut].groupId) {
    cut -= 1;
  }
  return eligible.slice(0, cut);
}

async function pauseDevice(reason: DevicePausedReason): Promise<void> {
  const deviceState = await getDeviceState();
  if (!deviceState) {
    return;
  }
  const db = await getDb();
  const tx = db.transaction([STORE_DEVICE_STATE], 'readwrite');
  tx.objectStore(STORE_DEVICE_STATE).put({ ...deviceState, paused: { reason, since: new Date().toISOString() } });
  await txDone(tx);
}

export async function tryRefreshClockState(): Promise<ClockStateWire | null> {
  try {
    const res = await fetchWithTimeout('/api/worker/attendance/clock-state', { method: 'GET' }, CLOCK_STATE_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as ClockStateWire;
  } catch {
    return null;
  }
}

export type SyncRunOutcome =
  | { kind: 'ALREADY_RUNNING' }
  | { kind: 'NOTHING_TO_SYNC' }
  | { kind: 'OK'; ackedCount: number; failedCount: number; retryableCount: number; ambiguousCount: number; clockState: ClockStateWire | null }
  | { kind: 'NETWORK_ERROR' }
  | { kind: 'AUTH_EXPIRED' }
  | { kind: 'DEVICE_PAUSED'; reason: DevicePausedReason }
  | { kind: 'RATE_LIMITED' }
  | { kind: 'RETRYABLE_HTTP'; status: number }
  | { kind: 'PROTOCOL_ERROR' };

let syncInFlight = false;

/** One full sync pass: build one bounded batch, POST it, apply the response. Safe to call
 * concurrently from multiple TABS (§6 "повторная конкурентная отправка допустима... сходится через
 * серверный replay ledger") — the in-flight guard only prevents two overlapping passes in the SAME
 * tab/module instance; it is not a cross-tab lock.
 *
 * `force` bypasses each PENDING record's `nextAttemptAt` backoff gate (SENDING records are always
 * eligible either way). Automatic triggers (mount, online event, visibilitychange, bounded timer,
 * post-enqueue) must NOT force, to respect the backoff ladder; the manual "Sync now" button does
 * force, since a user pressing it during a backoff window expects an immediate attempt rather than
 * a silent no-op. */
export async function runSyncOnce(force = false): Promise<SyncRunOutcome> {
  if (syncInFlight) {
    return { kind: 'ALREADY_RUNNING' };
  }
  syncInFlight = true;
  try {
    const deviceState = await getDeviceState();
    if (!deviceState || !deviceState.bootstrapped) {
      return { kind: 'NOTHING_TO_SYNC' };
    }
    if (deviceState.paused) {
      return { kind: 'DEVICE_PAUSED', reason: deviceState.paused.reason };
    }

    const eligible = await getEligibleRecords(force);
    const batch = buildBatch(eligible);
    if (batch.length === 0) {
      return { kind: 'NOTHING_TO_SYNC' };
    }

    // SENDING is a claim/observability marker, not a lease with a timeout — a crash before the
    // response is applied leaves these rows SENDING; the next `getEligibleRecords()` call (any
    // tab, any reload) treats SENDING the same as an immediately-eligible PENDING row, so nothing
    // is stuck forever (§6 "SENDING после crash не должен остаться навсегда").
    await markSending(batch);

    let response: Response;
    try {
      response = await fetchWithTimeout(
        '/api/worker/attendance/sync',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
          body: JSON.stringify({ deviceInstallationId: deviceState.deviceInstallationId, events: batch.map(toWireEvent) })
        },
        SYNC_FETCH_TIMEOUT_MS
      );
    } catch {
      await revertBatchToPending(batch, 'NETWORK_ERROR');
      return { kind: 'NETWORK_ERROR' };
    }

    if (response.status === 401) {
      await revertBatchToPending(batch, 'NOT_AUTHENTICATED');
      return { kind: 'AUTH_EXPIRED' };
    }
    if (response.status === 403) {
      const body = (await safeJson(response)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      await revertBatchToPending(batch, code ?? 'FORBIDDEN');
      if (code === 'DEVICE_NOT_OWNED' || code === 'DEVICE_REVOKED') {
        await pauseDevice(code);
        return { kind: 'DEVICE_PAUSED', reason: code };
      }
      return { kind: 'PROTOCOL_ERROR' };
    }
    if (response.status === 429) {
      await revertBatchToPending(batch, 'RATE_LIMITED');
      return { kind: 'RATE_LIMITED' };
    }
    if (response.status === 503 || response.status >= 500) {
      await revertBatchToPending(batch, `HTTP_${response.status}`);
      return { kind: 'RETRYABLE_HTTP', status: response.status };
    }
    if (response.status !== 200) {
      // Malformed whole-batch 400 or any other unexpected status — fail closed, never ACK.
      await revertBatchToPending(batch, 'SYNC_PROTOCOL_ERROR');
      return { kind: 'PROTOCOL_ERROR' };
    }

    const body = (await safeJson(response)) as { results?: unknown } | null;
    if (!body || !Array.isArray(body.results)) {
      await revertBatchToPending(batch, 'SYNC_PROTOCOL_ERROR');
      return { kind: 'PROTOCOL_ERROR' };
    }

    const results = body.results as SyncEventResultWire[];
    const resultsById = new Map(results.map((r) => [r.clientEventId, r]));

    let ackedCount = 0;
    let failedCount = 0;
    let retryableCount = 0;
    let ambiguousCount = 0;

    const standalone = batch.filter((r) => r.groupId === null);
    for (const record of standalone) {
      const outcome = await applySingleEventResult(record, resultsById.get(record.clientEventId));
      if (outcome.kind === 'ACKED') ackedCount += 1;
      else if (outcome.kind === 'FAILED_TERMINAL') failedCount += 1;
      else if (outcome.kind === 'RETRYABLE') retryableCount += 1;
      else ambiguousCount += 1;
    }

    const groupIds = new Set(batch.filter((r) => r.groupId !== null).map((r) => r.groupId as string));
    for (const groupId of groupIds) {
      const outcome = await applyGroupResult(groupId, resultsById);
      if (outcome.kind === 'ACKED') ackedCount += 2;
      else if (outcome.kind === 'FAILED_TERMINAL') failedCount += 2;
      else if (outcome.kind === 'RETRYABLE') retryableCount += 2;
      else if (outcome.kind === 'AMBIGUOUS') ambiguousCount += 2;
      // NO_OP: another tab already applied this group's result — not counted, not an error.
    }

    const clockState = await tryRefreshClockState();
    broadcastOutboxChanged();
    return { kind: 'OK', ackedCount, failedCount, retryableCount, ambiguousCount, clockState };
  } finally {
    syncInFlight = false;
  }
}
