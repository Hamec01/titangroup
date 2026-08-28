// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6 — the exact three-store IndexedDB schema.
// docs/titanor-time/T8_PWA_DESIGN.md §F.4 (T8.8) — v1 -> v2 adds a fourth store, workerReadSnapshots,
// without touching the three v1 stores at all.
// docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §2b — v2 -> v3 adds a fifth store, presenceOutbox,
// again purely additive (guarded createObjectStore, no touch to any existing store or row).
// Browser-only: never imported by any server-only module, never imports Prisma/node:crypto/next
// server code itself. A small native IndexedDB layer, no new runtime dependency.

export const DB_NAME = 'titanor-time-outbox';
export const DB_VERSION = 3;

export const STORE_CLOCK_OUTBOX = 'clockOutbox';
export const STORE_LOCAL_CLOCK_STATE = 'localClockState';
export const STORE_DEVICE_STATE = 'deviceState';
export const STORE_WORKER_READ_SNAPSHOTS = 'workerReadSnapshots';
export const STORE_PRESENCE_OUTBOX = 'presenceOutbox';

export type ClientGpsUnavailableReason = 'PERMISSION_DENIED' | 'TIMEOUT' | 'POSITION_UNAVAILABLE';
export type OutboxGpsUnavailableReason = ClientGpsUnavailableReason | 'LOW_ACCURACY';

export interface OutboxGps {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

export type OutboxEventState = 'PENDING' | 'SENDING' | 'ACKED' | 'FAILED_TERMINAL';

// §6 "Запись clockOutbox" — field-for-field. `deviceSequence` is a plain number (safe integer,
// matches the /sync wire contract exactly — see lib/attendance-sync.ts's validateSyncEventBody).
export interface OutboxEventRecord {
  clientEventId: string;
  deviceSequence: number;
  groupId: string | null;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  siteId: string;
  assumedSiteId: string | null;
  workAreaId: string | null;
  clientCapturedAt: string;
  capturedOffline: true;
  gps: OutboxGps | null;
  gpsUnavailableReason: OutboxGpsUnavailableReason | null;
  cachedGeofenceVersionId: string | null;
  deviceInstallationId: string;
  payloadVersion: 1;
  payloadHash: string;
  state: OutboxEventState;
  retryCount: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  createdAt: string;
  ackedAt: string | null;
}

export interface CachedAssignment {
  id: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  isPrimary: boolean;
  geofenceVersionId: string | null;
  /** Same geofence version's center/radius, kept alongside the id so the worker screen's "in
   * zone" badge (WorkerClockPanel.tsx) can compare a GPS reading against it without a network
   * round-trip. Informational only — never sent back to the server, which always re-derives the
   * site's authoritative current geofence itself. `null` for a site with no geofence configured;
   * optional (like DeviceStateRecord's ownerUserId below) so a row cached before this field
   * existed reads as `undefined` until its next bootstrap refresh. */
  geofenceLatitude?: number | null;
  geofenceLongitude?: number | null;
  geofenceRadiusMeters?: number | null;
}

export type DevicePausedReason = 'DEVICE_NOT_OWNED' | 'DEVICE_REVOKED';

// Single row, keyPath "singleton" — device identity + sequence high-water mark + offline UX cache
// of the last successful GET /context (assignments/geofence snapshot only — never an open shift,
// §0 task brief: "Open-shift он НЕ возвращает").
export interface DeviceStateRecord {
  singleton: 'singleton';
  deviceInstallationId: string;
  bootstrapped: boolean;
  nextDeviceSequence: number;
  contextAssignments: CachedAssignment[] | null;
  contextFetchedAt: string | null;
  paused: { reason: DevicePausedReason; since: string } | null;
  /** docs/titanor-time/T8_PWA_DESIGN.md §F.2/§F.3 — set ONLY after a successful GET /attendance/
   * context (server-confirmed this deviceInstallationId belongs to this user). Optional so a
   * migrated v1 row reads as `undefined` (= unbound) until its first v2-era successful bootstrap. */
  ownerUserId?: string | null;
  /** §F.3 — set by the login page immediately after a successful login, for ANY role, before
   * navigating away. Faster-updating than ownerUserId (doesn't require a bootstrap round-trip) —
   * the two together close the "B logs in on A's device before B's first bootstrap" race. Optional
   * for the same legacy-row reason as ownerUserId. */
  lastAuthenticatedUserId?: string | null;
}

// Single row, keyPath "singleton" — UX-only projection of "where am I right now", NEVER read as
// the source of authoritative server truth (that's always GET /clock-state).
export interface LocalClockStateRecord {
  singleton: 'singleton';
  state: 'CLOCKED_OUT' | 'CLOCKED_IN';
  siteId: string | null;
  siteName: string | null;
  workAreaId: string | null;
  workAreaName: string | null;
  openedAt: string | null;
  updatedAt: string;
}

// docs/titanor-time/T8_PWA_DESIGN.md §F.5/§F.6 — one row per (owner, route, param) combination.
// `payload` is always one of the hand-picked allowlisted shapes in lib/offline-outbox/read-
// snapshots.ts — never a raw server DTO, never HTML, never GPS/session/device-sequence data.
export type SnapshotRouteKind = 'periods-list' | 'history-list' | 'period-detail' | 'hours-list' | 'day-detail' | 'submit-summary';

export interface WorkerReadSnapshotRecord {
  key: string;
  routeKind: SnapshotRouteKind;
  payloadVersion: 1;
  ownerUserId: string;
  deviceInstallationId: string;
  capturedAt: string;
  payload: unknown;
}

// T12 §2b — one opportunistic "still on site" GPS sample, taken while a shift is open. Queued
// offline exactly like a clock event, but on a separate, much simpler track: no deviceSequence, no
// grouping, no projection — a presence sample never changes "where am I", it is pure evidence.
export type PresenceSampleState = 'PENDING' | 'SENDING' | 'ACKED' | 'FAILED_TERMINAL';

export interface PresenceSampleRecord {
  clientSampleId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
  capturedOffline: boolean;
  deviceInstallationId: string;
  state: PresenceSampleState;
  retryCount: number;
  createdAt: string;
  ackedAt: string | null;
  lastErrorCode: string | null;
}

const SINGLETON_KEY = 'singleton' as const;
export { SINGLETON_KEY };

let dbPromise: Promise<IDBDatabase> | null = null;

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function getDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_CLOCK_OUTBOX)) {
          const store = db.createObjectStore(STORE_CLOCK_OUTBOX, { keyPath: 'clientEventId' });
          store.createIndex('by-state', 'state');
          store.createIndex('by-nextAttemptAt', 'nextAttemptAt');
        }
        if (!db.objectStoreNames.contains(STORE_LOCAL_CLOCK_STATE)) {
          db.createObjectStore(STORE_LOCAL_CLOCK_STATE, { keyPath: 'singleton' });
        }
        if (!db.objectStoreNames.contains(STORE_DEVICE_STATE)) {
          db.createObjectStore(STORE_DEVICE_STATE, { keyPath: 'singleton' });
        }
        // v1 -> v2 (T8.8, docs/titanor-time/T8_PWA_DESIGN.md §F.4) — additive only. The three
        // blocks above are unchanged and never touch existing rows; this block only ever creates
        // a new, empty store.
        if (!db.objectStoreNames.contains(STORE_WORKER_READ_SNAPSHOTS)) {
          const snapshotStore = db.createObjectStore(STORE_WORKER_READ_SNAPSHOTS, { keyPath: 'key' });
          snapshotStore.createIndex('by-capturedAt', 'capturedAt');
        }
        // v2 -> v3 (T12 §2b) — additive only, same as the v2 block: a new empty store, nothing
        // above is touched. onupgradeneeded runs once per version step, so a device on v1 gets
        // both the v2 and this v3 block in one open().
        if (!db.objectStoreNames.contains(STORE_PRESENCE_OUTBOX)) {
          const presenceStore = db.createObjectStore(STORE_PRESENCE_OUTBOX, { keyPath: 'clientSampleId' });
          presenceStore.createIndex('by-state', 'state');
          presenceStore.createIndex('by-capturedAt', 'capturedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection (close other tabs and retry).'));
    });
  }
  return dbPromise;
}

/** Wraps a single IDBRequest as a Promise — safe to await INSIDE an open transaction (chained IDB
 * requests keep the transaction alive; this is not the "await a non-IDB promise" hazard). */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export async function getDeviceState(): Promise<DeviceStateRecord | undefined> {
  const db = await getDb();
  const tx = db.transaction([STORE_DEVICE_STATE], 'readonly');
  return requestToPromise(tx.objectStore(STORE_DEVICE_STATE).get(SINGLETON_KEY));
}

export async function getLocalClockState(): Promise<LocalClockStateRecord | undefined> {
  const db = await getDb();
  const tx = db.transaction([STORE_LOCAL_CLOCK_STATE], 'readonly');
  return requestToPromise(tx.objectStore(STORE_LOCAL_CLOCK_STATE).get(SINGLETON_KEY));
}

export async function getAllOutboxEvents(): Promise<OutboxEventRecord[]> {
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readonly');
  return requestToPromise(tx.objectStore(STORE_CLOCK_OUTBOX).getAll());
}

export async function getOutboxEventsByState(state: OutboxEventState): Promise<OutboxEventRecord[]> {
  const db = await getDb();
  const tx = db.transaction([STORE_CLOCK_OUTBOX], 'readonly');
  return requestToPromise(tx.objectStore(STORE_CLOCK_OUTBOX).index('by-state').getAll(state));
}

export async function getAllPresenceSamples(): Promise<PresenceSampleRecord[]> {
  const db = await getDb();
  const tx = db.transaction([STORE_PRESENCE_OUTBOX], 'readonly');
  return requestToPromise(tx.objectStore(STORE_PRESENCE_OUTBOX).getAll());
}
