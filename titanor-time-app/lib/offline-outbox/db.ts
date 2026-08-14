// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6 — the exact three-store IndexedDB schema.
// Browser-only: never imported by any server-only module, never imports Prisma/node:crypto/next
// server code itself. A small native IndexedDB layer, no new runtime dependency.

export const DB_NAME = 'titanor-time-outbox';
export const DB_VERSION = 1;

export const STORE_CLOCK_OUTBOX = 'clockOutbox';
export const STORE_LOCAL_CLOCK_STATE = 'localClockState';
export const STORE_DEVICE_STATE = 'deviceState';

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
