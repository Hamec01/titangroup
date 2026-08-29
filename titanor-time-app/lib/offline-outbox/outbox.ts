// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6 — atomic enqueue (single Check In/Out) and
// the atomic Switch Site pair, plus response application (§6 "Поток" / "Switch site (offline)").
// Browser-only.

import { sha256Hex } from './sha256';
import { broadcastOutboxChanged } from './broadcast';
import {
  getDb,
  getDeviceState,
  txDone,
  requestToPromise,
  STORE_CLOCK_OUTBOX,
  STORE_LOCAL_CLOCK_STATE,
  STORE_DEVICE_STATE,
  SINGLETON_KEY,
  type OutboxEventRecord,
  type OutboxGps,
  type OutboxApproximateGps,
  type OutboxGpsUnavailableReason,
  type LocalClockStateRecord,
  type DeviceStateRecord
} from './db';

export class EnqueueError extends Error {
  code: 'DEVICE_NOT_BOOTSTRAPPED' | 'SEQUENCE_OVERFLOW';
  constructor(code: 'DEVICE_NOT_BOOTSTRAPPED' | 'SEQUENCE_OVERFLOW', message: string) {
    super(message);
    this.code = code;
  }
}

const BACKOFF_STEPS_MS = [5000, 30000, 120000, 600000];
export function backoffMs(retryCount: number): number {
  return BACKOFF_STEPS_MS[Math.min(retryCount, BACKOFF_STEPS_MS.length - 1)];
}

interface EventSpec {
  clientEventId: string;
  groupId: string | null;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  siteId: string;
  assumedSiteId: string | null;
  workAreaId: string | null;
  clientCapturedAt: string;
  gps: OutboxGps | null;
  gpsUnavailableReason: OutboxGpsUnavailableReason | null;
  gpsApproximate: OutboxApproximateGps | null;
  cachedGeofenceVersionId: string | null;
}

/** Deterministic canonical form — sorted keys, same technique as the server's canonicalizeForHash
 * (lib/attendance-clock.ts), independently reimplemented here since that module is server-only
 * (imports Prisma) and must never be imported from browser code. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function computePayloadHash(spec: EventSpec, deviceSequence: number, deviceInstallationId: string): string {
  const canonical = canonicalize({
    clientEventId: spec.clientEventId,
    deviceSequence,
    groupId: spec.groupId,
    operationType: spec.operationType,
    siteId: spec.siteId,
    assumedSiteId: spec.assumedSiteId,
    workAreaId: spec.workAreaId,
    clientCapturedAt: spec.clientCapturedAt,
    capturedOffline: true,
    gps: spec.gps,
    gpsUnavailableReason: spec.gpsUnavailableReason,
    cachedGeofenceVersionId: spec.cachedGeofenceVersionId,
    deviceInstallationId,
    payloadVersion: 1
  });
  return sha256Hex(canonical);
}

/**
 * §6 "Поток" / "Switch site (offline)" — ONE IndexedDB readwrite transaction over
 * (clockOutbox, localClockState, deviceState): reads+bumps nextDeviceSequence, writes every
 * outbox record (payloadHash computed SYNCHRONOUSLY per record — see sha256.ts's doc comment for
 * why this must never be an awaited Web Crypto call here), and updates localClockState — all
 * without a single await between `db.transaction(...)` and the final `store.put(...)` calls, so
 * there is no window where a sequence number is reserved but its event isn't durably saved.
 */
async function atomicEnqueue(specs: EventSpec[], localStateAfter: Omit<LocalClockStateRecord, 'singleton' | 'updatedAt'>): Promise<OutboxEventRecord[]> {
  if (specs.length === 0) {
    throw new Error('atomicEnqueue: at least one event spec is required.');
  }
  const preflightDeviceState = await getDeviceState();
  if (!preflightDeviceState || !preflightDeviceState.bootstrapped || preflightDeviceState.paused) {
    throw new EnqueueError('DEVICE_NOT_BOOTSTRAPPED', 'Offline setup is not ready yet.');
  }

  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX, STORE_LOCAL_CLOCK_STATE, STORE_DEVICE_STATE], 'readwrite');
  const deviceStore = tx.objectStore(STORE_DEVICE_STATE);
  const outboxStore = tx.objectStore(STORE_CLOCK_OUTBOX);
  const localStore = tx.objectStore(STORE_LOCAL_CLOCK_STATE);

  // The one unavoidable await inside this transaction is for an IDBRequest itself (chained IDB
  // requests keep the transaction alive by spec) — never a non-IDB promise.
  const deviceState = (await requestToPromise(deviceStore.get(SINGLETON_KEY))) as DeviceStateRecord | undefined;
  if (!deviceState || !deviceState.bootstrapped || deviceState.paused) {
    tx.abort();
    throw new EnqueueError('DEVICE_NOT_BOOTSTRAPPED', 'Offline setup is not ready yet.');
  }

  const base = deviceState.nextDeviceSequence;
  const newNext = base + specs.length;
  if (!Number.isSafeInteger(newNext)) {
    tx.abort();
    throw new EnqueueError('SEQUENCE_OVERFLOW', 'This device has run out of safe sequence numbers — please contact support.');
  }

  const nowIso = new Date().toISOString();
  const records: OutboxEventRecord[] = specs.map((spec, i) => {
    const deviceSequence = base + i;
    const payloadHash = computePayloadHash(spec, deviceSequence, deviceState.deviceInstallationId);
    return {
      clientEventId: spec.clientEventId,
      deviceSequence,
      groupId: spec.groupId,
      operationType: spec.operationType,
      siteId: spec.siteId,
      assumedSiteId: spec.assumedSiteId,
      workAreaId: spec.workAreaId,
      clientCapturedAt: spec.clientCapturedAt,
      capturedOffline: true,
      gps: spec.gps,
      gpsUnavailableReason: spec.gpsUnavailableReason,
      // T14 — provenance metadata, deliberately NOT in computePayloadHash above (see EventSpec / db.ts).
      gpsApproximate: spec.gpsApproximate,
      cachedGeofenceVersionId: spec.cachedGeofenceVersionId,
      deviceInstallationId: deviceState.deviceInstallationId,
      payloadVersion: 1,
      payloadHash,
      state: 'PENDING',
      retryCount: 0,
      nextAttemptAt: nowIso,
      lastErrorCode: null,
      createdAt: nowIso,
      ackedAt: null
    };
  });

  deviceStore.put({ ...deviceState, nextDeviceSequence: newNext });
  for (const record of records) {
    outboxStore.put(record);
  }
  localStore.put({ singleton: SINGLETON_KEY, ...localStateAfter, updatedAt: nowIso });

  await txDone(tx);
  broadcastOutboxChanged();
  return records;
}

export interface EnqueueCheckInInput {
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  clientCapturedAt: string;
  gps: OutboxGps | null;
  gpsUnavailableReason: OutboxGpsUnavailableReason | null;
  gpsApproximate: OutboxApproximateGps | null;
  cachedGeofenceVersionId: string | null;
}

export async function enqueueCheckIn(input: EnqueueCheckInInput): Promise<OutboxEventRecord> {
  const clientEventId = crypto.randomUUID();
  const [record] = await atomicEnqueue(
    [
      {
        clientEventId,
        groupId: null,
        operationType: 'CHECK_IN',
        siteId: input.siteId,
        assumedSiteId: null,
        workAreaId: input.workAreaId,
        clientCapturedAt: input.clientCapturedAt,
        gps: input.gps,
        gpsUnavailableReason: input.gpsUnavailableReason,
        gpsApproximate: input.gpsApproximate,
        cachedGeofenceVersionId: input.cachedGeofenceVersionId
      }
    ],
    { state: 'CLOCKED_IN', siteId: input.siteId, siteName: input.siteName, workAreaId: input.workAreaId, workAreaName: input.workAreaName, openedAt: input.clientCapturedAt }
  );
  return record;
}

export interface EnqueueCheckOutInput {
  assumedSiteId: string;
  clientCapturedAt: string;
  gps: OutboxGps | null;
  gpsUnavailableReason: OutboxGpsUnavailableReason | null;
  gpsApproximate: OutboxApproximateGps | null;
}

export async function enqueueCheckOut(input: EnqueueCheckOutInput): Promise<OutboxEventRecord> {
  const clientEventId = crypto.randomUUID();
  const [record] = await atomicEnqueue(
    [
      {
        clientEventId,
        groupId: null,
        operationType: 'CHECK_OUT',
        siteId: input.assumedSiteId,
        assumedSiteId: input.assumedSiteId,
        workAreaId: null,
        clientCapturedAt: input.clientCapturedAt,
        gps: input.gps,
        gpsUnavailableReason: input.gpsUnavailableReason,
        gpsApproximate: input.gpsApproximate,
        cachedGeofenceVersionId: null
      }
    ],
    { state: 'CLOCKED_OUT', siteId: null, siteName: null, workAreaId: null, workAreaName: null, openedAt: null }
  );
  return record;
}

export interface EnqueueSwitchSiteInput {
  oldAssumedSiteId: string;
  newSiteId: string;
  newSiteName: string;
  newWorkAreaId: string | null;
  newWorkAreaName: string | null;
  clientCapturedAt: string;
  gps: OutboxGps | null;
  gpsUnavailableReason: OutboxGpsUnavailableReason | null;
  gpsApproximate: OutboxApproximateGps | null;
  cachedGeofenceVersionId: string | null;
}

/** §6 "Switch site (offline)" — one groupId, deviceSequence N/N+1 reserved together, both records
 * written in the SAME transaction as the single-event path above (never two separate enqueues). */
export async function enqueueSwitchSite(input: EnqueueSwitchSiteInput): Promise<{ checkOut: OutboxEventRecord; checkIn: OutboxEventRecord }> {
  const groupId = crypto.randomUUID();
  const checkOutClientEventId = crypto.randomUUID();
  const checkInClientEventId = crypto.randomUUID();
  const [checkOut, checkIn] = await atomicEnqueue(
    [
      {
        clientEventId: checkOutClientEventId,
        groupId,
        operationType: 'CHECK_OUT',
        siteId: input.oldAssumedSiteId,
        assumedSiteId: input.oldAssumedSiteId,
        workAreaId: null,
        clientCapturedAt: input.clientCapturedAt,
        gps: input.gps,
        gpsUnavailableReason: input.gpsUnavailableReason,
        gpsApproximate: input.gpsApproximate,
        cachedGeofenceVersionId: null
      },
      {
        clientEventId: checkInClientEventId,
        groupId,
        operationType: 'CHECK_IN',
        siteId: input.newSiteId,
        assumedSiteId: null,
        workAreaId: input.newWorkAreaId,
        clientCapturedAt: input.clientCapturedAt,
        gps: input.gps,
        gpsUnavailableReason: input.gpsUnavailableReason,
        gpsApproximate: input.gpsApproximate,
        cachedGeofenceVersionId: input.cachedGeofenceVersionId
      }
    ],
    { state: 'CLOCKED_IN', siteId: input.newSiteId, siteName: input.newSiteName, workAreaId: input.newWorkAreaId, workAreaName: input.newWorkAreaName, openedAt: input.clientCapturedAt }
  );
  return { checkOut, checkIn };
}

// ---------------------------------------------------------------------------------------------
// §6/§7 Response application.
// ---------------------------------------------------------------------------------------------

export interface SyncEventResultWire {
  clientEventId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE_ACK' | 'REJECTED' | 'RETRYABLE';
  processingState?: 'ACCEPTED' | 'NEEDS_REVIEW';
  exceptionType?: string;
  code?: string;
  groupId?: string;
}

export type SingleApplyOutcome = { kind: 'ACKED'; needsReview: boolean } | { kind: 'FAILED_TERMINAL'; code: string } | { kind: 'RETRYABLE' } | { kind: 'AMBIGUOUS' };

/** §6 "Поток" — one IndexedDB transaction per standalone (groupId===null) record. */
export async function applySingleEventResult(record: OutboxEventRecord, result: SyncEventResultWire | undefined): Promise<SingleApplyOutcome> {
  if (!result) {
    return { kind: 'AMBIGUOUS' };
  }
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_CLOCK_OUTBOX);

  if (result.outcome === 'ACCEPTED' || result.outcome === 'DUPLICATE_ACK') {
    store.delete(record.clientEventId);
    await txDone(tx);
    return { kind: 'ACKED', needsReview: result.processingState === 'NEEDS_REVIEW' };
  }
  if (result.outcome === 'REJECTED') {
    const updated: OutboxEventRecord = { ...record, state: 'FAILED_TERMINAL', lastErrorCode: result.code ?? 'UNKNOWN' };
    store.put(updated);
    await txDone(tx);
    return { kind: 'FAILED_TERMINAL', code: updated.lastErrorCode! };
  }
  // RETRYABLE
  const updated: OutboxEventRecord = { ...record, state: 'PENDING', retryCount: record.retryCount + 1, nextAttemptAt: new Date(Date.now() + backoffMs(record.retryCount)).toISOString(), lastErrorCode: result.code ?? null };
  store.put(updated);
  await txDone(tx);
  return { kind: 'RETRYABLE' };
}

export type GroupApplyOutcome = { kind: 'ACKED' } | { kind: 'FAILED_TERMINAL' } | { kind: 'RETRYABLE' } | { kind: 'AMBIGUOUS' } | { kind: 'NO_OP' };

/**
 * §6 "applyGroupResponse" — re-reads the CURRENT rows for this groupId from the store (not the
 * caller's possibly-stale in-memory list — another tab may already have applied this group's
 * result), and applies both halves atomically in ONE transaction. Any mismatch (missing result
 * for a still-present half, or differing outcome categories) touches nothing and is reported as
 * AMBIGUOUS — the ordinary retry cycle picks both up again.
 */
export async function applyGroupResult(groupId: string, resultsByClientEventId: Map<string, SyncEventResultWire>): Promise<GroupApplyOutcome> {
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_CLOCK_OUTBOX);
  const all = (await requestToPromise(store.getAll())) as OutboxEventRecord[];
  const currentMembers = all.filter((r) => r.groupId === groupId);

  if (currentMembers.length === 0) {
    tx.abort();
    return { kind: 'NO_OP' };
  }

  const matched = currentMembers.map((m) => resultsByClientEventId.get(m.clientEventId));
  if (matched.some((r) => r === undefined)) {
    tx.abort();
    return { kind: 'AMBIGUOUS' };
  }
  const results = matched as SyncEventResultWire[];
  const categoryOf = (r: SyncEventResultWire): 'SUCCESS' | 'REJECTED' | 'RETRYABLE' => (r.outcome === 'ACCEPTED' || r.outcome === 'DUPLICATE_ACK' ? 'SUCCESS' : r.outcome === 'REJECTED' ? 'REJECTED' : 'RETRYABLE');
  const categories = new Set(results.map(categoryOf));
  if (categories.size > 1) {
    tx.abort();
    return { kind: 'AMBIGUOUS' };
  }

  const category = [...categories][0];
  if (category === 'SUCCESS') {
    for (const m of currentMembers) {
      store.delete(m.clientEventId);
    }
  } else if (category === 'REJECTED') {
    for (const m of currentMembers) {
      const r = resultsByClientEventId.get(m.clientEventId)!;
      store.put({ ...m, state: 'FAILED_TERMINAL', lastErrorCode: r.code ?? 'UNKNOWN' } as OutboxEventRecord);
    }
  } else {
    for (const m of currentMembers) {
      const r = resultsByClientEventId.get(m.clientEventId)!;
      store.put({ ...m, state: 'PENDING', retryCount: m.retryCount + 1, nextAttemptAt: new Date(Date.now() + backoffMs(m.retryCount)).toISOString(), lastErrorCode: r.code ?? null } as OutboxEventRecord);
    }
  }

  await txDone(tx);
  return category === 'SUCCESS' ? { kind: 'ACKED' } : category === 'REJECTED' ? { kind: 'FAILED_TERMINAL' } : { kind: 'RETRYABLE' };
}

/** Reverts a whole sent batch back to PENDING with incremented backoff — used for network
 * errors/timeouts/429/503/5xx/malformed-response (§6 "ничего не удалять ... увеличить
 * retryCount/nextAttemptAt ... повторить те же event ids, sequence, timestamps и GPS"). Never
 * touches immutable business fields. */
export async function revertBatchToPending(records: OutboxEventRecord[], errorCode: string | null): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_CLOCK_OUTBOX);
  for (const record of records) {
    // Re-read is unnecessary here: we own these rows exclusively between marking them SENDING and
    // this revert (no other code path mutates a SENDING row except applySingleEventResult/
    // applyGroupResult, which only run after a genuine HTTP response — this path runs instead of
    // those, never alongside).
    store.put({ ...record, state: 'PENDING', retryCount: record.retryCount + 1, nextAttemptAt: new Date(Date.now() + backoffMs(record.retryCount)).toISOString(), lastErrorCode: errorCode });
  }
  await txDone(tx);
}

export async function markSending(records: OutboxEventRecord[]): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_CLOCK_OUTBOX);
  for (const record of records) {
    store.put({ ...record, state: 'SENDING' });
  }
  await txDone(tx);
}

/**
 * T15 — the worker dismisses a permanently-failed action from the "needs attention" banner. Only
 * a FAILED_TERMINAL row can be removed this way: the server has already returned its final verdict
 * (REJECTED — outside geofence, a device conflict, a validation failure), the worker cannot retry
 * or fix it, so the row is pure leftover noise once seen. It never participates in the clock-state
 * projection (that reads PENDING/SENDING only), so deleting it changes nothing about "where am I".
 * A PENDING/SENDING/ACKED row is left untouched (returns false).
 */
export async function dismissFailedEvent(clientEventId: string): Promise<boolean> {
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_CLOCK_OUTBOX);
  const record = (await requestToPromise(store.get(clientEventId))) as OutboxEventRecord | undefined;
  if (!record || record.state !== 'FAILED_TERMINAL') {
    tx.abort();
    return false;
  }
  store.delete(clientEventId);
  await txDone(tx);
  broadcastOutboxChanged();
  return true;
}
