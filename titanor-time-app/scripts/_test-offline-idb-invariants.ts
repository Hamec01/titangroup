// docs/titanor-time/T8_PWA_DESIGN.md §F.4/§F.5 — permanent regression for the IndexedDB v1->v2
// upgrade and the new workerReadSnapshots store's invariants (task's Group A, scenarios 1-13).
// Pure Node, no browser, no server, no disposable Postgres — uses `fake-indexeddb` (phantom/
// ephemeral devDependency, installed via `npm install fake-indexeddb --no-save`, same convention as
// `playwright` in scripts/_test-export-ui.ts — never added to package.json, tsconfig.build.json
// already excludes scripts/ from the production build's typecheck).
//
// Each phase below needs a genuinely fresh module-cache + fresh fake global `indexedDB` (both
// lib/offline-outbox/db.ts's own `dbPromise` and fake-indexeddb's in-memory database registry are
// process-global state that cannot be reset mid-process) — this file spawns itself as a child
// process per phase via `node:child_process`, so each phase gets real isolation, and aggregates
// pass/fail counts from each child's JSON stdout.

import { spawnSync } from 'node:child_process';

const PHASE = process.argv.find((a) => a.startsWith('--phase='))?.split('=')[1];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600) : '');
  }
}

async function phaseCleanInstall() {
  // @ts-expect-error — fake-indexeddb's "./auto" export has a real .d.ts (auto.d.ts) but this
  // project's moduleResolution can't resolve it through the package's "exports" map; verified
  // working correctly at runtime (globals are set, all IDB operations below succeed).
  await import('fake-indexeddb/auto');
  const db = await import('../lib/offline-outbox/db');
  const snap = await import('../lib/offline-outbox/read-snapshots');

  // 1: clean install creates v2, all four stores.
  const conn = await db.getDb();
  check('1: clean install opens at DB_VERSION 2', conn.version === 2, conn.version);
  check('1b: clockOutbox store exists', conn.objectStoreNames.contains(db.STORE_CLOCK_OUTBOX));
  check('1c: localClockState store exists', conn.objectStoreNames.contains(db.STORE_LOCAL_CLOCK_STATE));
  check('1d: deviceState store exists', conn.objectStoreNames.contains(db.STORE_DEVICE_STATE));
  check('1e: workerReadSnapshots store exists', conn.objectStoreNames.contains(db.STORE_WORKER_READ_SNAPSHOTS));

  // Seed a device identity (writeWorkerReadSnapshot needs one to bind to).
  const deviceState = { singleton: db.SINGLETON_KEY, deviceInstallationId: 'device-1', bootstrapped: true, nextDeviceSequence: 0, contextAssignments: null, contextFetchedAt: null, paused: null, ownerUserId: 'user-a', lastAuthenticatedUserId: 'user-a' };
  {
    const tx = conn.transaction([db.STORE_DEVICE_STATE], 'readwrite');
    tx.objectStore(db.STORE_DEVICE_STATE).put(deviceState);
    await db.txDone(tx);
  }

  // 8: new store is readable/writable.
  await snap.writeWorkerReadSnapshot({ routeKind: 'periods-list', ownerUserId: 'user-a', payload: { periods: [] } });
  const key8 = snap.buildSnapshotKey('user-a', { routeKind: 'periods-list' });
  const read8 = await snap.getWorkerReadSnapshot(key8);
  check('8: workerReadSnapshots is readable/writable', !!read8 && read8.ownerUserId === 'user-a', read8);

  // 9: overwriting the SAME key is atomic — a second write to the same key replaces, doesn't duplicate.
  await snap.writeWorkerReadSnapshot({ routeKind: 'periods-list', ownerUserId: 'user-a', payload: { periods: [{ id: 'p1', startDate: '2026-01-01', endDate: '2026-01-14', timesheetId: 't1', timesheetStatus: 'DRAFT' }] } });
  const read9 = await snap.getWorkerReadSnapshot(key8);
  const countAfterOverwrite = await new Promise<number>((resolve, reject) => {
    const req = conn.transaction([db.STORE_WORKER_READ_SNAPSHOTS], 'readonly').objectStore(db.STORE_WORKER_READ_SNAPSHOTS).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  check('9: overwriting one key is atomic (still exactly 1 record, updated payload)', countAfterOverwrite === 1 && (read9?.payload as { periods: unknown[] })?.periods.length === 1, { countAfterOverwrite, read9 });

  // 10: record-count cleanup is bounded — write MAX_SNAPSHOT_RECORDS distinct keys, then one more,
  // and confirm the total never exceeds the limit (oldest evicted).
  for (let i = 0; i < snap.MAX_SNAPSHOT_RECORDS + 5; i++) {
    await snap.writeWorkerReadSnapshot({ routeKind: 'period-detail', ownerUserId: 'user-a', periodId: `p-${i}`, payload: { periodId: `p-${i}`, startDate: '2026-01-01', endDate: '2026-01-14', timesheetStatus: 'DRAFT', editable: true, assignments: [], returnReasons: [] } });
  }
  const totalCount = await new Promise<number>((resolve, reject) => {
    const req = conn.transaction([db.STORE_WORKER_READ_SNAPSHOTS], 'readonly').objectStore(db.STORE_WORKER_READ_SNAPSHOTS).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  check('10: record-count cleanup keeps the store bounded at MAX_SNAPSHOT_RECORDS', totalCount === snap.MAX_SNAPSHOT_RECORDS, { totalCount, max: snap.MAX_SNAPSHOT_RECORDS });

  // 11: an oversized payload fails closed — write is skipped, no partial record.
  const hugeString = 'x'.repeat(snap.MAX_SNAPSHOT_PAYLOAD_BYTES + 100);
  const oversizedKey = snap.buildSnapshotKey('user-a', { routeKind: 'day-detail', periodId: 'huge', date: '2026-01-01' });
  await snap.writeWorkerReadSnapshot({ routeKind: 'day-detail', ownerUserId: 'user-a', periodId: 'huge', date: '2026-01-01', payload: { periodId: 'huge', date: '2026-01-01', dayType: 'WORK', confirmedZero: false, timesheetStatus: 'DRAFT', segments: [{ startAt: '2026-01-01T08:00:00Z', endAt: '2026-01-01T16:00:00Z', siteName: hugeString, workAreaName: null, breaks: [] }], returnReasons: [] } });
  const oversizedRead = await snap.getWorkerReadSnapshot(oversizedKey);
  check('11: an oversized payload is never written (fail closed)', oversizedRead === undefined, oversizedRead);

  // 12: the eviction/cleanup performed by scenario 10 never touched the other three stores.
  const deviceStillThere = await db.getDeviceState();
  check('12: cleanup never touches deviceState', deviceStillThere?.deviceInstallationId === 'device-1', deviceStillThere);

  // 13: abrupt-close-during-write gives the OLD or the NEW record, never a partial one. Simulated by
  // starting a write, then forcibly closing the connection before its transaction would naturally
  // complete, then reopening and checking the record is either fully absent (old, pre-write state)
  // or fully present and well-formed (new state) — never a half-written object.
  const abruptKey = snap.buildSnapshotKey('user-a', { routeKind: 'history-list' });
  const preAbrupt = await snap.getWorkerReadSnapshot(abruptKey);
  check('13-setup: history-list key does not exist yet', preAbrupt === undefined);
  try {
    const tx = conn.transaction([db.STORE_WORKER_READ_SNAPSHOTS], 'readwrite');
    tx.objectStore(db.STORE_WORKER_READ_SNAPSHOTS).put({ key: abruptKey, routeKind: 'history-list', payloadVersion: 1, ownerUserId: 'user-a', deviceInstallationId: 'device-1', capturedAt: new Date().toISOString(), payload: { timesheets: [] } });
    conn.close(); // abrupt close before the transaction's own oncomplete/onerror fires
  } catch {
    // fake-indexeddb may throw synchronously on close-during-transaction in some engines; either
    // outcome is acceptable for this test, which only cares about the post-reopen record shape.
  }
  // db.getDb() caches its connection at module level and has no reset — a raw reopen (matching
  // db.ts's own indexedDB.open(DB_NAME, DB_VERSION) call exactly) is the only way to get a genuinely
  // fresh connection here, mirroring what a real app reload would do.
  const conn2 = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(db.DB_NAME, db.DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const postAbruptTx = conn2.transaction([db.STORE_WORKER_READ_SNAPSHOTS], 'readonly');
  const postAbrupt = await new Promise((resolve, reject) => {
    const req = postAbruptTx.objectStore(db.STORE_WORKER_READ_SNAPSHOTS).get(abruptKey);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const wellFormedOrAbsent = postAbrupt === undefined || (typeof postAbrupt === 'object' && postAbrupt !== null && 'key' in postAbrupt && 'payload' in postAbrupt && 'ownerUserId' in postAbrupt);
  check('13: abrupt close during write yields old (absent) or a fully well-formed new record, never partial', wellFormedOrAbsent, postAbrupt);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

async function phaseV1Upgrade() {
  // @ts-expect-error — fake-indexeddb's "./auto" export has a real .d.ts (auto.d.ts) but this
  // project's moduleResolution can't resolve it through the package's "exports" map; verified
  // working correctly at runtime (globals are set, all IDB operations below succeed).
  await import('fake-indexeddb/auto');
  const idbModule = await import('fake-indexeddb');
  const indexedDB = idbModule.default ?? (idbModule as unknown as { indexedDB: IDBFactory }).indexedDB ?? (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

  const DB_NAME = 'titanor-time-outbox';

  // Manually construct a REAL v1 database — the exact shape lib/offline-outbox/db.ts's v1 code
  // built, before any of this session's changes — with real fixture rows, entirely independent of
  // db.ts's own (v2-aware) upgrade handler, so this genuinely exercises "a real pre-existing v1
  // database meets the new v2-aware code", not a re-implementation calling itself.
  const v1Conn = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const outboxStore = d.createObjectStore('clockOutbox', { keyPath: 'clientEventId' });
      outboxStore.createIndex('by-state', 'state');
      outboxStore.createIndex('by-nextAttemptAt', 'nextAttemptAt');
      d.createObjectStore('localClockState', { keyPath: 'singleton' });
      d.createObjectStore('deviceState', { keyPath: 'singleton' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const pendingEvent = { clientEventId: 'evt-pending', deviceSequence: 1, groupId: null, operationType: 'CHECK_IN', siteId: 'site-1', assumedSiteId: null, workAreaId: null, clientCapturedAt: '2026-01-01T08:00:00.000Z', capturedOffline: true, gps: null, gpsUnavailableReason: null, cachedGeofenceVersionId: null, deviceInstallationId: 'device-v1', payloadVersion: 1, payloadHash: 'hash1', state: 'PENDING', retryCount: 0, nextAttemptAt: '2026-01-01T08:00:00.000Z', lastErrorCode: null, createdAt: '2026-01-01T08:00:00.000Z', ackedAt: null };
  const sendingEvent = { ...pendingEvent, clientEventId: 'evt-sending', deviceSequence: 2, state: 'SENDING' };
  const failedEvent = { ...pendingEvent, clientEventId: 'evt-failed', deviceSequence: 3, state: 'FAILED_TERMINAL', lastErrorCode: 'VALIDATION_ERROR' };
  const deviceStateV1 = { singleton: 'singleton', deviceInstallationId: 'device-v1', bootstrapped: true, nextDeviceSequence: 4, contextAssignments: [{ id: 'a1', siteId: 'site-1', siteName: 'Site One', workAreaId: null, workAreaName: null, isPrimary: true, geofenceVersionId: null }], contextFetchedAt: '2026-01-01T07:00:00.000Z', paused: null };
  const localClockStateV1 = { singleton: 'singleton', state: 'CLOCKED_OUT', siteId: null, siteName: null, workAreaId: null, workAreaName: null, openedAt: null, updatedAt: '2026-01-01T07:00:00.000Z' };

  await new Promise<void>((resolve, reject) => {
    const tx = v1Conn.transaction(['clockOutbox', 'localClockState', 'deviceState'], 'readwrite');
    tx.objectStore('clockOutbox').put(pendingEvent);
    tx.objectStore('clockOutbox').put(sendingEvent);
    tx.objectStore('clockOutbox').put(failedEvent);
    tx.objectStore('deviceState').put(deviceStateV1);
    tx.objectStore('localClockState').put(localClockStateV1);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  v1Conn.close();

  // Now import THIS project's real db.ts for the first time in this process — its getDb() opens
  // with DB_VERSION=2 against the SAME (fake) database name, triggering a real onupgradeneeded from
  // 1 -> 2, exercising the actual shipped upgrade code path, not a copy of it.
  const db = await import('../lib/offline-outbox/db');
  const conn = await db.getDb();

  check('2: upgrading a real v1 fixture opens at DB_VERSION 2', conn.version === 2, conn.version);
  check('2b: workerReadSnapshots store now exists', conn.objectStoreNames.contains(db.STORE_WORKER_READ_SNAPSHOTS));

  const allOutbox = await db.getAllOutboxEvents();
  check('3: pending outbox event preserved', allOutbox.some((e) => e.clientEventId === 'evt-pending' && e.state === 'PENDING'), allOutbox.map((e) => e.clientEventId));
  check('4: SENDING outbox event preserved', allOutbox.some((e) => e.clientEventId === 'evt-sending' && e.state === 'SENDING'));
  check('5: FAILED_TERMINAL outbox event preserved', allOutbox.some((e) => e.clientEventId === 'evt-failed' && e.state === 'FAILED_TERMINAL' && e.lastErrorCode === 'VALIDATION_ERROR'));
  check('3b/4b/5b: exactly 3 outbox rows total, none dropped/duplicated', allOutbox.length === 3, allOutbox.length);

  const deviceStateAfter = await db.getDeviceState();
  check('6: deviceInstallationId preserved', deviceStateAfter?.deviceInstallationId === 'device-v1', deviceStateAfter?.deviceInstallationId);
  check('6b: nextDeviceSequence preserved', deviceStateAfter?.nextDeviceSequence === 4, deviceStateAfter?.nextDeviceSequence);
  check('6c: cached assignments preserved', deviceStateAfter?.contextAssignments?.[0]?.siteName === 'Site One', deviceStateAfter?.contextAssignments);
  check('18-setup/legacy: migrated v1 row reads ownerUserId as undefined (unbound)', deviceStateAfter?.ownerUserId === undefined, deviceStateAfter?.ownerUserId);

  const localClockStateAfter = await db.getLocalClockState();
  check('7: local clock state preserved', localClockStateAfter?.state === 'CLOCKED_OUT' && localClockStateAfter?.updatedAt === '2026-01-01T07:00:00.000Z', localClockStateAfter);

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

function runChildPhase(phase: string): { pass: number; fail: number } {
  const result = spawnSync(process.execPath, [require.resolve('tsx/cli'), __filename, `--phase=${phase}`], { encoding: 'utf8' });
  const stdout = result.stdout ?? '';
  console.log(stdout.trim());
  if (result.stderr) {
    console.error(result.stderr);
  }
  const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
  try {
    return JSON.parse(lastLine);
  } catch {
    return { pass: 0, fail: 1 };
  }
}

async function main() {
  if (PHASE === 'clean-install') {
    return phaseCleanInstall();
  }
  if (PHASE === 'v1-upgrade') {
    return phaseV1Upgrade();
  }

  // Orchestrator — spawns each phase as its own isolated child process.
  console.log('=== phase: clean-install ===');
  const r1 = runChildPhase('clean-install');
  console.log('=== phase: v1-upgrade ===');
  const r2 = runChildPhase('v1-upgrade');

  const totalPass = r1.pass + r2.pass;
  const totalFail = r1.fail + r2.fail;
  console.log(`\n${totalPass} passed, ${totalFail} failed (scenarios 1-13)`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
