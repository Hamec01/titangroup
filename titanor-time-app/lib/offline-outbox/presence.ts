// docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §2b — the presence-sample track. Browser-only.
//
// A "still on site" GPS sample the PWA takes opportunistically while a shift is open: never at a
// Check In/Out, never on a background timer (impossible on iOS web), only when the app is
// foregrounded and enough time has passed. It is pure evidence for the admin — it does NOT touch
// the outbox, the local clock projection, or device sequencing. Queue -> POST -> done.

import { broadcastOutboxChanged } from './broadcast';
import {
  getDb,
  getDeviceState,
  txDone,
  requestToPromise,
  getAllPresenceSamples,
  STORE_PRESENCE_OUTBOX,
  type PresenceSampleRecord
} from './db';

// Owner ask: "хотя бы через 3 часа приложение должно проверить его". One sample per 3h of open
// shift, taken the next time the app is foregrounded after that window elapses.
export const PRESENCE_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Pure — "given the last presence sample's capture time (ms epoch, or null if none yet) and now,
 * is it time to take another one?". Extracted for testing. */
export function shouldCapturePresence(lastCapturedAtMs: number | null, nowMs: number): boolean {
  if (lastCapturedAtMs === null) {
    return true;
  }
  return nowMs - lastCapturedAtMs >= PRESENCE_MIN_INTERVAL_MS;
}

/** The capturedAt (ms epoch) of the most recent presence sample still in the local store, or null.
 * Used to pace captures — ACKED rows are kept until they age out so this stays accurate offline. */
export async function lastPresenceCaptureMs(): Promise<number | null> {
  const all = await getAllPresenceSamples();
  if (all.length === 0) {
    return null;
  }
  return Math.max(...all.map((r) => new Date(r.capturedAt).getTime()));
}

export interface PresenceSampleInput {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  capturedOffline: boolean;
}

/** Write one PENDING presence sample. No-op-safe: if the device isn't bootstrapped yet we simply
 * skip (a presence sample is never worth blocking on). */
export async function enqueuePresenceSample(input: PresenceSampleInput): Promise<PresenceSampleRecord | null> {
  const device = await getDeviceState();
  if (!device?.bootstrapped || !device.deviceInstallationId) {
    return null;
  }
  const record: PresenceSampleRecord = {
    clientSampleId: crypto.randomUUID(),
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyMeters: input.accuracyMeters,
    capturedAt: input.capturedAt,
    capturedOffline: input.capturedOffline,
    deviceInstallationId: device.deviceInstallationId,
    state: 'PENDING',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    ackedAt: null,
    lastErrorCode: null
  };
  const db = await getDb();
  const tx = db.transaction([STORE_PRESENCE_OUTBOX], 'readwrite');
  tx.objectStore(STORE_PRESENCE_OUTBOX).put(record);
  await txDone(tx);
  broadcastOutboxChanged();
  return record;
}

/** Drop ACKED samples older than the pacing window plus a margin — keeps lastPresenceCaptureMs()
 * cheap without losing the "when did we last sample" signal. Terminally-failed rows are kept for
 * one window too, then dropped (a presence sample is not worth retrying forever). */
export async function prunePresenceSamples(nowMs = Date.now()): Promise<void> {
  const all = await getAllPresenceSamples();
  const cutoff = nowMs - PRESENCE_MIN_INTERVAL_MS * 2;
  const doomed = all.filter((r) => (r.state === 'ACKED' || r.state === 'FAILED_TERMINAL') && new Date(r.capturedAt).getTime() < cutoff);
  if (doomed.length === 0) {
    return;
  }
  const db = await getDb();
  const tx = db.transaction([STORE_PRESENCE_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_PRESENCE_OUTBOX);
  for (const r of doomed) {
    store.delete(r.clientSampleId);
  }
  await txDone(tx);
}

export async function updatePresenceSampleState(clientSampleId: string, patch: Partial<PresenceSampleRecord>): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_PRESENCE_OUTBOX], 'readwrite');
  const store = tx.objectStore(STORE_PRESENCE_OUTBOX);
  const existing = (await requestToPromise(store.get(clientSampleId))) as PresenceSampleRecord | undefined;
  if (existing) {
    store.put({ ...existing, ...patch });
  }
  await txDone(tx);
}
