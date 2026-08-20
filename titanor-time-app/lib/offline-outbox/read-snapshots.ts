// docs/titanor-time/T8_PWA_DESIGN.md §F.2/§F.5/§F.6 (T8.8) — allowlisted read-only offline
// snapshots for the Worker UI. Browser-only, same rules as the rest of lib/offline-outbox/*: never
// imports Prisma/node:crypto/next server code, never reads a session token/cookie, never stores raw
// GPS/payloadHash/requestId/deviceSequence/password/email/phone or an unfiltered server DTO.

import { getDb, getDeviceState, requestToPromise, txDone, STORE_WORKER_READ_SNAPSHOTS, type WorkerReadSnapshotRecord, type SnapshotRouteKind } from './db';

export const MAX_SNAPSHOT_PAYLOAD_BYTES = 16384;
export const MAX_SNAPSHOT_RECORDS = 40;

export interface SnapshotReturnReason {
  scopeType: string;
  siteName: string | null;
  contextSiteName: string | null;
  reason: string;
  returnedAt: string | null;
}

export interface SnapshotPeriodSummary {
  id: string;
  startDate: string;
  endDate: string;
  timesheetId: string;
  timesheetStatus: string;
}

export interface PeriodsListPayload {
  periods: SnapshotPeriodSummary[];
}

export interface HistoryListPayload {
  timesheets: SnapshotPeriodSummary[];
}

export interface SnapshotAssignment {
  id: string;
  siteName: string;
  workAreaName: string | null;
  templateName: string | null;
  isPrimary: boolean;
}

export interface PeriodDetailPayload {
  periodId: string;
  startDate: string;
  endDate: string;
  timesheetStatus: string;
  editable: boolean;
  assignments: SnapshotAssignment[];
  returnReasons: SnapshotReturnReason[];
}

export interface SnapshotDaySummary {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  totalMinutes: number;
  siteNames: string[];
}

export interface HoursListPayload {
  periodId: string;
  startDate: string;
  endDate: string;
  timesheetStatus: string;
  editable: boolean;
  days: SnapshotDaySummary[];
  returnReasons: SnapshotReturnReason[];
}

export interface SnapshotBreak {
  startAt: string;
  endAt: string;
  paid: boolean;
}

export interface SnapshotSegment {
  startAt: string;
  endAt: string;
  siteName: string;
  workAreaName: string | null;
  breaks: SnapshotBreak[];
}

export interface DayDetailPayload {
  periodId: string;
  date: string;
  dayType: string;
  confirmedZero: boolean;
  timesheetStatus: string;
  segments: SnapshotSegment[];
  returnReasons: SnapshotReturnReason[];
}

export interface SubmitSummaryPayload {
  periodId: string;
  startDate: string;
  endDate: string;
  timesheetStatus: string;
  workedDaysCount: number;
  totalDaysCount: number;
  totalMinutes: number;
  returnReasons: SnapshotReturnReason[];
}

export type SnapshotPayloadFor<K extends SnapshotRouteKind> = K extends 'periods-list'
  ? PeriodsListPayload
  : K extends 'history-list'
    ? HistoryListPayload
    : K extends 'period-detail'
      ? PeriodDetailPayload
      : K extends 'hours-list'
        ? HoursListPayload
        : K extends 'day-detail'
          ? DayDetailPayload
          : K extends 'submit-summary'
            ? SubmitSummaryPayload
            : never;

export interface ParsedWorkerRoute {
  routeKind: SnapshotRouteKind;
  periodId?: string;
  date?: string;
}

// docs/titanor-time/T8_PWA_DESIGN.md §F.6 — one pattern per route. Each is fully `$`-anchored, so
// they are mutually exclusive by construction (no ordering dependency), listed most-specific-first
// anyway for readability.
const ROUTE_PATTERNS: { re: RegExp; routeKind: SnapshotRouteKind }[] = [
  { re: /^\/worker\/periods\/([^/]+)\/hours\/([^/]+)\/?$/, routeKind: 'day-detail' },
  { re: /^\/worker\/periods\/([^/]+)\/hours\/?$/, routeKind: 'hours-list' },
  { re: /^\/worker\/periods\/([^/]+)\/submit\/?$/, routeKind: 'submit-summary' },
  { re: /^\/worker\/periods\/([^/]+)\/?$/, routeKind: 'period-detail' },
  { re: /^\/worker\/periods\/?$/, routeKind: 'periods-list' },
  { re: /^\/worker\/history\/?$/, routeKind: 'history-list' }
];

/** Pure — no IndexedDB, no network. Used by both the capture side (via buildSnapshotKey directly,
 * with already-known params) and the offline shell's read side (which only has a pathname). */
export function parseWorkerRoute(pathname: string): ParsedWorkerRoute | null {
  for (const { re, routeKind } of ROUTE_PATTERNS) {
    const match = re.exec(pathname);
    if (!match) {
      continue;
    }
    if (routeKind === 'day-detail') {
      return { routeKind, periodId: match[1], date: match[2] };
    }
    if (routeKind === 'period-detail' || routeKind === 'hours-list' || routeKind === 'submit-summary') {
      return { routeKind, periodId: match[1] };
    }
    return { routeKind };
  }
  return null;
}

/** The single source of truth for key shape — both writeWorkerReadSnapshot and
 * readAccountBoundSnapshot go through this, so capture and lookup can never disagree. */
export function buildSnapshotKey(ownerUserId: string, route: ParsedWorkerRoute): string {
  switch (route.routeKind) {
    case 'periods-list':
      return `${ownerUserId}:periods-list`;
    case 'history-list':
      return `${ownerUserId}:history-list`;
    case 'period-detail':
      return `${ownerUserId}:period-detail:${route.periodId}`;
    case 'hours-list':
      return `${ownerUserId}:hours-list:${route.periodId}`;
    case 'day-detail':
      return `${ownerUserId}:day-detail:${route.periodId}:${route.date}`;
    case 'submit-summary':
      return `${ownerUserId}:submit-summary:${route.periodId}`;
  }
}

export interface WriteSnapshotInput<K extends SnapshotRouteKind> {
  routeKind: K;
  periodId?: string;
  date?: string;
  ownerUserId: string;
  payload: SnapshotPayloadFor<K>;
}

/**
 * docs/titanor-time/T8_PWA_DESIGN.md §F.5/§F.8 — bounded, atomic write. Skips silently (never
 * throws) if: no device identity exists yet, or the serialized payload exceeds
 * MAX_SNAPSHOT_PAYLOAD_BYTES. When adding a genuinely new key would push the store over
 * MAX_SNAPSHOT_RECORDS, the single oldest record (by-capturedAt index) is deleted first, in the
 * SAME read-write transaction as the put — eviction and write are atomic together. No non-IDB
 * `await` ever runs while this transaction is open (every awaited value here is an IDBRequest
 * wrapped by requestToPromise, which is safe — chained IDB requests keep a transaction alive).
 */
export async function writeWorkerReadSnapshot<K extends SnapshotRouteKind>(input: WriteSnapshotInput<K>): Promise<void> {
  const deviceState = await getDeviceState();
  if (!deviceState) {
    return;
  }
  const payloadJson = JSON.stringify(input.payload);
  if (payloadJson.length > MAX_SNAPSHOT_PAYLOAD_BYTES) {
    return;
  }
  const route: ParsedWorkerRoute = { routeKind: input.routeKind, periodId: input.periodId, date: input.date };
  const key = buildSnapshotKey(input.ownerUserId, route);
  const record: WorkerReadSnapshotRecord = {
    key,
    routeKind: input.routeKind,
    payloadVersion: 1,
    ownerUserId: input.ownerUserId,
    deviceInstallationId: deviceState.deviceInstallationId,
    capturedAt: new Date().toISOString(),
    payload: input.payload
  };

  const db = await getDb();
  const tx = db.transaction([STORE_WORKER_READ_SNAPSHOTS], 'readwrite');
  const store = tx.objectStore(STORE_WORKER_READ_SNAPSHOTS);

  const existing = await requestToPromise(store.get(key));
  if (!existing) {
    const count = await requestToPromise(store.count());
    if (count >= MAX_SNAPSHOT_RECORDS) {
      const oldestCursor = await requestToPromise(store.index('by-capturedAt').openCursor());
      if (oldestCursor) {
        oldestCursor.delete();
      }
    }
  }
  store.put(record);
  await txDone(tx);
}

export async function getWorkerReadSnapshot(key: string): Promise<WorkerReadSnapshotRecord | undefined> {
  const db = await getDb();
  const tx = db.transaction([STORE_WORKER_READ_SNAPSHOTS], 'readonly');
  return requestToPromise(tx.objectStore(STORE_WORKER_READ_SNAPSHOTS).get(key));
}

export type AccountBindingFailureReason = 'NO_DEVICE' | 'PAUSED' | 'UNBOUND' | 'USER_MISMATCH';

export type AccountBindingResult = { ok: true; ownerUserId: string; deviceInstallationId: string } | { ok: false; reason: AccountBindingFailureReason };

/** docs/titanor-time/T8_PWA_DESIGN.md §F.2 invariants (1)=(2) and (6). Does not, by itself, check
 * (3)/(4)/(5) against any particular snapshot — that happens in readAccountBoundSnapshot below,
 * which combines this with a specific key lookup. */
export async function resolveAccountBinding(): Promise<AccountBindingResult> {
  const deviceState = await getDeviceState();
  if (!deviceState) {
    return { ok: false, reason: 'NO_DEVICE' };
  }
  if (deviceState.paused) {
    return { ok: false, reason: 'PAUSED' };
  }
  const { ownerUserId, lastAuthenticatedUserId, deviceInstallationId } = deviceState;
  if (!ownerUserId || !lastAuthenticatedUserId) {
    return { ok: false, reason: 'UNBOUND' };
  }
  if (ownerUserId !== lastAuthenticatedUserId) {
    return { ok: false, reason: 'USER_MISMATCH' };
  }
  return { ok: true, ownerUserId, deviceInstallationId };
}

export type ReadSnapshotOutcome = { kind: 'ok'; record: WorkerReadSnapshotRecord } | { kind: 'unavailable'; reason: AccountBindingFailureReason | 'NOT_CAPTURED' | 'BINDING_MISMATCH' };

/** The one function offline read-only views call. Combines the account-binding gate with the
 * exact-key lookup — every one of the six §F.2 invariants is checked here, either directly or
 * structurally (the key itself is only ever resolvable for the confirmed ownerUserId). */
export async function readAccountBoundSnapshot(route: ParsedWorkerRoute): Promise<ReadSnapshotOutcome> {
  const binding = await resolveAccountBinding();
  if (!binding.ok) {
    return { kind: 'unavailable', reason: binding.reason };
  }
  const key = buildSnapshotKey(binding.ownerUserId, route);
  const record = await getWorkerReadSnapshot(key);
  if (!record) {
    return { kind: 'unavailable', reason: 'NOT_CAPTURED' };
  }
  if (record.ownerUserId !== binding.ownerUserId || record.deviceInstallationId !== binding.deviceInstallationId) {
    return { kind: 'unavailable', reason: 'BINDING_MISMATCH' };
  }
  return { kind: 'ok', record };
}
