// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.2 (GET /attendance/context) + task brief
// §3 "Device bootstrap и sequence". Browser-only.

import { getDb, getDeviceState, getAllOutboxEvents, txDone, STORE_DEVICE_STATE, SINGLETON_KEY, type DeviceStateRecord, type CachedAssignment, type DevicePausedReason } from './db';

const CSRF_HEADER_VALUE = 'titanor-time';
const CONTEXT_FETCH_TIMEOUT_MS = 15000;

export interface ContextAssignmentWire {
  id: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  isPrimary: boolean;
  geofence: { geofenceVersionId: string; latitude: string; longitude: string; radiusMeters: number } | null;
}

interface ContextResponseWire {
  serverNow: string;
  deviceInstallationId: string;
  lastProcessedSequence: string;
  assignments: ContextAssignmentWire[];
}

export type BootstrapOutcome =
  | { kind: 'READY'; deviceState: DeviceStateRecord }
  | { kind: 'NOT_READY_OFFLINE' } // first-ever run, no network, nothing cached yet — enqueue must be refused
  | { kind: 'PAUSED'; reason: DevicePausedReason }
  | { kind: 'AUTH_EXPIRED' };

function platformString(): string | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const p = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? null;
  return p ? p.slice(0, 32) : null;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = CONTEXT_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function mapAssignments(wire: ContextAssignmentWire[]): CachedAssignment[] {
  return wire.map((a) => ({
    id: a.id,
    siteId: a.siteId,
    siteName: a.siteName,
    workAreaId: a.workAreaId,
    workAreaName: a.workAreaName,
    isPrimary: a.isPrimary,
    geofenceVersionId: a.geofence?.geofenceVersionId ?? null
  }));
}

async function persistDeviceState(record: DeviceStateRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_DEVICE_STATE], 'readwrite');
  tx.objectStore(STORE_DEVICE_STATE).put(record);
  await txDone(tx);
}

/** §3 "После context bootstrap атомарно установить max(...)" — never decreases, never resets. */
async function computeSequenceFloor(fromDeviceState: number, lastProcessedSequence: string): Promise<number> {
  const outbox = await getAllOutboxEvents();
  const maxLocalOutbox = outbox.reduce((max, e) => Math.max(max, e.deviceSequence), 0);
  const lastProcessed = Number(lastProcessedSequence);
  const candidate = Math.max(fromDeviceState, Number.isFinite(lastProcessed) ? lastProcessed + 1 : 0, maxLocalOutbox + 1);
  return candidate;
}

async function callContext(deviceInstallationId: string): Promise<{ status: number; body: unknown }> {
  const platform = platformString();
  const qs = new URLSearchParams({ deviceInstallationId, ...(platform ? { platform } : {}) });
  const res = await fetchWithTimeout(`/api/worker/attendance/context?${qs.toString()}`, {
    method: 'GET',
    headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * §3 — idempotent, safe to call on every mount/resume. First run: generates and persists a
 * deviceInstallationId BEFORE calling context (so a crash mid-bootstrap never loses the id — the
 * next call just re-attempts context with the same id, never generates a second one). On
 * DEVICE_NOT_OWNED with a genuinely empty outbox, rotates to a fresh id once (covers "different
 * user logged into the same browser") — never when the outbox has pending/terminal rows.
 */
export async function ensureDeviceBootstrapped(): Promise<BootstrapOutcome> {
  let deviceState = await getDeviceState();

  if (!deviceState) {
    deviceState = {
      singleton: SINGLETON_KEY,
      deviceInstallationId: crypto.randomUUID(),
      bootstrapped: false,
      nextDeviceSequence: 0,
      contextAssignments: null,
      contextFetchedAt: null,
      paused: null
    };
    await persistDeviceState(deviceState);
  }

  if (deviceState.paused) {
    // A paused device never silently un-pauses itself — the caller must show the actionable
    // message; a fresh bootstrap attempt is only retried explicitly (e.g. after the user
    // acknowledges/retries), not automatically on every mount, to avoid a hot loop against a
    // still-revoked/still-foreign device.
    return { kind: 'PAUSED', reason: deviceState.paused.reason };
  }

  let response: { status: number; body: unknown };
  try {
    response = await callContext(deviceState.deviceInstallationId);
  } catch {
    // Network error. If this device has EVER bootstrapped successfully before, the cached
    // deviceState (sequence floor + assignments) is still good enough to operate offline.
    return deviceState.bootstrapped ? { kind: 'READY', deviceState } : { kind: 'NOT_READY_OFFLINE' };
  }

  if (response.status === 401) {
    return deviceState.bootstrapped ? { kind: 'READY', deviceState } : { kind: 'AUTH_EXPIRED' };
  }

  if (response.status === 403) {
    const code = (response.body as { error?: { code?: string } })?.error?.code;
    if (code === 'DEVICE_NOT_OWNED') {
      const outbox = await getAllOutboxEvents();
      if (outbox.length === 0) {
        // Safe one-time rotation — nothing durable would be lost.
        const rotated: DeviceStateRecord = {
          singleton: SINGLETON_KEY,
          deviceInstallationId: crypto.randomUUID(),
          bootstrapped: false,
          nextDeviceSequence: 0,
          contextAssignments: null,
          contextFetchedAt: null,
          paused: null
        };
        await persistDeviceState(rotated);
        let retryResponse: { status: number; body: unknown };
        try {
          retryResponse = await callContext(rotated.deviceInstallationId);
        } catch {
          return { kind: 'NOT_READY_OFFLINE' };
        }
        if (retryResponse.status !== 200) {
          // Still failing after rotation — pause rather than looping rotations indefinitely.
          const pausedState: DeviceStateRecord = { ...rotated, paused: { reason: 'DEVICE_NOT_OWNED', since: new Date().toISOString() } };
          await persistDeviceState(pausedState);
          return { kind: 'PAUSED', reason: 'DEVICE_NOT_OWNED' };
        }
        return applyContextResponse(rotated, retryResponse.body as ContextResponseWire);
      }
      const pausedState: DeviceStateRecord = { ...deviceState, paused: { reason: 'DEVICE_NOT_OWNED', since: new Date().toISOString() } };
      await persistDeviceState(pausedState);
      return { kind: 'PAUSED', reason: 'DEVICE_NOT_OWNED' };
    }
    if (code === 'DEVICE_REVOKED') {
      const pausedState: DeviceStateRecord = { ...deviceState, paused: { reason: 'DEVICE_REVOKED', since: new Date().toISOString() } };
      await persistDeviceState(pausedState);
      return { kind: 'PAUSED', reason: 'DEVICE_REVOKED' };
    }
    // Generic FORBIDDEN (e.g. missing permission/no employee profile) — treat like an
    // unauthenticated-adjacent state; never silently drop the queue.
    return deviceState.bootstrapped ? { kind: 'READY', deviceState } : { kind: 'AUTH_EXPIRED' };
  }

  if (response.status !== 200) {
    return deviceState.bootstrapped ? { kind: 'READY', deviceState } : { kind: 'NOT_READY_OFFLINE' };
  }

  return applyContextResponse(deviceState, response.body as ContextResponseWire);
}

async function applyContextResponse(deviceState: DeviceStateRecord, wire: ContextResponseWire): Promise<BootstrapOutcome> {
  const nextDeviceSequence = await computeSequenceFloor(deviceState.nextDeviceSequence, wire.lastProcessedSequence);
  if (!Number.isSafeInteger(nextDeviceSequence)) {
    // Fail-closed — never persist an imprecise sequence floor.
    return { kind: 'READY', deviceState };
  }
  const updated: DeviceStateRecord = {
    ...deviceState,
    bootstrapped: true,
    nextDeviceSequence,
    contextAssignments: mapAssignments(wire.assignments),
    contextFetchedAt: new Date().toISOString(),
    paused: null
  };
  await persistDeviceState(updated);
  return { kind: 'READY', deviceState: updated };
}

/** Explicit retry after the user acknowledges a paused state (e.g. re-logs in, or an admin
 * un-revokes the device) — clears `paused` only if context now genuinely succeeds. */
export async function retryBootstrap(): Promise<BootstrapOutcome> {
  const deviceState = await getDeviceState();
  if (deviceState?.paused) {
    await persistDeviceState({ ...deviceState, paused: null });
  }
  return ensureDeviceBootstrapped();
}
