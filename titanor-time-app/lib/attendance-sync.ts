import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { liveAssignmentWhere } from '@/lib/assignment-lifecycle';
import { createAuditEvent } from '@/lib/audit';
import { overlapCandidates, overlapExists, resolveOverlapTransition } from '@/lib/attendance-reported-projection';
import { materializeClockShiftCore } from '@/lib/attendance-materializer';
import { resolveMissingCheckoutAtCutoffOnLateCheckOut } from '@/lib/attendance-auto-submit';
import { annotateAutoClosedShiftWithLateCheckOut } from '@/lib/attendance-abandoned-shift-annotate';
import {
  evaluateGpsReading,
  loadMaxGpsAccuracyMeters,
  validateGpsPayload,
  validateApproximateGpsPayload,
  loadCurrentGeofence,
  exceptionDetailForGps,
  resolveTimesheetForInstant,
  resolveActiveSiteAssignment,
  canonicalizeForHash,
  isValidUuid,
  parseIsoInstant,
  type ClockGpsReading,
  type ApproximateGpsReading,
  type ClockGeofence,
  type GpsEvaluation,
  type EffectiveTimeResult
} from '@/lib/attendance-clock';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §7 (batch contract) / §9.11 (normative FIFO
// algorithm, this module is a direct, literal implementation of it — not a simplification to "one
// transaction per event" or a sequential call into the online endpoints). Route files
// (app/api/worker/attendance/{context,sync}/route.ts) do only HTTP/auth/CSRF/idempotency/
// validation-mapping; every business transaction lives here, exactly like lib/attendance-clock.ts.
//
// Reused, not reimplemented: evaluateGpsReading (Haversine), loadCurrentGeofence,
// overlapCandidates/overlapExists/resolveOverlapTransition (overlap detection),
// materializeClockShiftCore (materialization) — all imported from their existing modules.
// lib/attendance-clock.ts itself, its four route files, and performCheckIn/performCheckOut/
// performSwitchSite are NOT touched by this slice beyond adding `export` to five small,
// already-tested pure/tx-safe helpers (zero behavior change, verified by online regression).

// ---------------------------------------------------------------------------------------------
// Bounded batch size (§C task requirement — "bounded batch size установить явно и
// задокументировать"). 100 events comfortably covers weeks of offline catch-up (one check-in +
// one check-out per shift => 50 shifts) while keeping one outer transaction's lock-hold time and
// SAVEPOINT count bounded.
// ---------------------------------------------------------------------------------------------
export const MAX_SYNC_BATCH_EVENTS = 100;

const MAX_INGESTION_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 20;
const CHRONOLOGY_CLAMP_MS = 1; // same adaptation/rationale as lib/attendance-clock.ts's own constant (JS Date ms floor vs design's "+1 microsecond").
const FUTURE_TOLERANCE_MS = BigInt(2 * 60000); // §5.5 rule 1, shared by online and offline.
const OFFLINE_BACKDATE_LIMIT_MS = BigInt(7 * 24 * 60 * 60000); // §5.5 rules 4/5 — 7 days.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// §5.5 rules 1 + 4 + 5 — OFFLINE_SYNC channel only. Rule 1 (excessive future skew) is shared
// verbatim with lib/attendance-clock.ts's computeOnlineEffectiveTime; rules 4/5 (backdating up to
// 7 days is expected and NOT flagged; older than that looks like a reset clock) are new to this
// slice and never apply to the ONLINE channel.
// ---------------------------------------------------------------------------------------------
export function computeOfflineEffectiveTime(clientCapturedAt: Date, serverReceivedAt: Date): EffectiveTimeResult {
  const clockSkewMs = BigInt(serverReceivedAt.getTime()) - BigInt(clientCapturedAt.getTime());
  const futureByMs = -clockSkewMs;

  if (futureByMs > FUTURE_TOLERANCE_MS) {
    return { effectiveAt: serverReceivedAt, clockSkewMs, exception: 'EXCESSIVE_CLOCK_SKEW' };
  }
  if (clockSkewMs <= OFFLINE_BACKDATE_LIMIT_MS) {
    return { effectiveAt: clientCapturedAt, clockSkewMs, exception: null };
  }
  return { effectiveAt: serverReceivedAt, clockSkewMs, exception: 'EXCESSIVE_CLOCK_SKEW' };
}

// ---------------------------------------------------------------------------------------------
// Retryable-transaction-error detection (§6 task requirement — bounded retry on 40P01/40001
// only). Defensive across how Prisma's engine surfaces a raw Postgres SQLSTATE for a query issued
// via $queryRaw/$executeRaw inside an interactive transaction — checks Prisma's own P2034
// ("write conflict or deadlock, please retry") first, then falls back to inspecting a `code`/
// `meta.code` field or the error message text for the exact SQLSTATE/phrase Postgres uses.
// ---------------------------------------------------------------------------------------------
function extractSqlState(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const anyErr = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (typeof anyErr.code === 'string' && /^[0-9A-Z]{5}$/.test(anyErr.code)) {
    return anyErr.code;
  }
  if (anyErr.meta && typeof anyErr.meta.code === 'string' && /^[0-9A-Z]{5}$/.test(anyErr.meta.code)) {
    return anyErr.meta.code;
  }
  if (typeof anyErr.message === 'string') {
    if (anyErr.message.includes('deadlock detected')) return '40P01';
    if (anyErr.message.includes('could not serialize access')) return '40001';
  }
  return undefined;
}

function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true;
  }
  const sqlState = extractSqlState(err);
  return sqlState === '40001' || sqlState === '40P01';
}

// ---------------------------------------------------------------------------------------------
// Request/event validation (§4 task requirement). clientEventId/deviceSequence are structural —
// without a valid, positive, safe-integer deviceSequence an event cannot be placed in FIFO order
// at all, so a failure there rejects the WHOLE request at the HTTP layer (400 VALIDATION_ERROR),
// unlike every other field, whose failure still consumes exactly one FIFO slot with a
// REJECTED_TERMINAL/VALIDATION_ERROR receipt inside the transaction (§9.11 "malformed event
// payload" — REJECTED_TERMINAL_WITHOUT_CLOCK_EVENT, not a batch-level rejection).
//
// deviceSequence wire contract (documented per task §C "не терять точность, но точную форму
// задокументировать"): a plain JSON number, required to be a positive safe integer
// (1..Number.MAX_SAFE_INTEGER — 2^53, millions of years of one-event-per-second device use,
// matches the design doc's own §7 example `"deviceSequence": 42`). Values needing more precision
// than a JS number can represent exactly are rejected as VALIDATION_ERROR — BigInt is used
// internally (matches the DeviceEventReceipt/ClockEvent column type) from the moment the number is
// validated onward, never a plain Number arithmetic path.
// ---------------------------------------------------------------------------------------------

export interface SyncEventInput {
  clientEventId: string;
  deviceSequence: bigint;
  groupId: string | null;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  /** false => siteId/assumedSiteId/workAreaId/clientCapturedAt/cachedGeofenceVersionId/gps below are placeholder values, never to be read for a real decision — runPreflight rejects immediately as VALIDATION_ERROR. See validateSyncEventBody's doc comment. */
  fieldsValid: boolean;
  siteId: string;
  assumedSiteId: string | null;
  workAreaId: string | null;
  clientCapturedAt: Date;
  cachedGeofenceVersionId: string | null;
  gps: ClockGpsReading;
  /** T14 — a stale/cached coordinate the device attached when it had no fresh fix. Never verified;
   *  stored as an approximate ClockEventLocation. Not part of the offline payload hash (provenance
   *  metadata — a retry / pre-send back-fill must stay hash-stable). */
  gpsApproximate: ApproximateGpsReading | null;
}

type EventFieldValidation =
  | { ok: true; value: SyncEventInput }
  | { ok: false; clientEventId: string | null; deviceSequence: bigint | null; fieldErrors: Record<string, string[]> };

const INVALID_EVENT_GPS: ClockGpsReading = { location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' };

/**
 * clientEventId/deviceSequence/groupId/operationType are STRUCTURAL — FIFO placement and group
 * detection (runPassA) read them before any per-event business decision is possible, so a failure
 * in any of the four rejects the WHOLE request at the HTTP layer (caller checks this before
 * opening a transaction). Every other field is "business": a failure there still yields `ok: true`
 * with `fieldsValid: false` and safe, structurally-typed placeholder values for the failed
 * fields — the event is still placed correctly in FIFO/group order, and
 * runPreflight's very first check (`!event.fieldsValid`) rejects it as VALIDATION_ERROR without
 * ever reading the placeholders for a real decision (§9.11 "malformed event payload" —
 * REJECTED_TERMINAL_WITHOUT_CLOCK_EVENT, consumes exactly one FIFO slot, never a whole-batch 400).
 */
function validateSyncEventBody(raw: unknown): EventFieldValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, clientEventId: null, deviceSequence: null, fieldErrors: { '': ['must be an object'] } };
  }
  const r = raw as Record<string, unknown>;
  const structuralErrors: Record<string, string[]> = {};

  let clientEventId: string | null = null;
  if (!isValidUuid(r.clientEventId)) {
    structuralErrors.clientEventId = ['required, must be a UUID'];
  } else {
    clientEventId = r.clientEventId as string;
  }

  let deviceSequence: bigint | null = null;
  if (typeof r.deviceSequence !== 'number' || !Number.isSafeInteger(r.deviceSequence) || r.deviceSequence <= 0) {
    structuralErrors.deviceSequence = ['required, must be a positive safe integer'];
  } else {
    deviceSequence = BigInt(r.deviceSequence);
  }

  let groupId: string | null = null;
  if (r.groupId !== null && r.groupId !== undefined) {
    if (!isValidUuid(r.groupId)) {
      structuralErrors.groupId = ['must be a UUID or null'];
    } else {
      groupId = r.groupId as string;
    }
  }

  let operationType: 'CHECK_IN' | 'CHECK_OUT' | null = null;
  if (r.operationType === 'CHECK_IN' || r.operationType === 'CHECK_OUT') {
    operationType = r.operationType;
  } else {
    structuralErrors.operationType = ['required, must be CHECK_IN or CHECK_OUT'];
  }

  if (clientEventId === null || deviceSequence === null || Object.keys(structuralErrors).length > 0) {
    return { ok: false, clientEventId, deviceSequence, fieldErrors: structuralErrors };
  }

  const fieldErrors: Record<string, string[]> = {};

  let siteId: string | null = null;
  if (!isValidUuid(r.siteId)) {
    fieldErrors.siteId = ['required, must be a UUID'];
  } else {
    siteId = r.siteId as string;
  }

  let assumedSiteId: string | null = null;
  if (operationType === 'CHECK_OUT') {
    if (!isValidUuid(r.assumedSiteId)) {
      fieldErrors.assumedSiteId = ['required, must be a UUID for CHECK_OUT'];
    } else {
      assumedSiteId = r.assumedSiteId as string;
    }
  } else if (r.assumedSiteId !== null && r.assumedSiteId !== undefined) {
    fieldErrors.assumedSiteId = ['must be null for CHECK_IN'];
  }

  let workAreaId: string | null = null;
  if (r.workAreaId !== null && r.workAreaId !== undefined) {
    if (!isValidUuid(r.workAreaId)) {
      fieldErrors.workAreaId = ['must be a UUID or null'];
    } else {
      workAreaId = r.workAreaId as string;
    }
  }

  const clientCapturedAt = parseIsoInstant(r.clientCapturedAt);
  if (!clientCapturedAt) {
    fieldErrors.clientCapturedAt = ['required, must be a valid ISO-8601 timestamp'];
  }

  if (r.capturedOffline !== true) {
    fieldErrors.capturedOffline = ['required, must be true'];
  }

  let cachedGeofenceVersionId: string | null = null;
  if (r.cachedGeofenceVersionId !== null && r.cachedGeofenceVersionId !== undefined) {
    if (!isValidUuid(r.cachedGeofenceVersionId)) {
      fieldErrors.cachedGeofenceVersionId = ['must be a UUID or null'];
    } else {
      cachedGeofenceVersionId = r.cachedGeofenceVersionId as string;
    }
  }

  const gps = validateGpsPayload(r.gps, r.gpsUnavailableReason, 'gps', 'gpsUnavailableReason');
  if (!gps.ok) {
    Object.assign(fieldErrors, gps.fieldErrors);
  }

  const gpsApproximate = validateApproximateGpsPayload(r.gpsApproximate, 'gpsApproximate');
  if (!gpsApproximate.ok) {
    Object.assign(fieldErrors, gpsApproximate.fieldErrors);
  }

  if (Object.keys(fieldErrors).length > 0) {
    // Business-field failure — still FIFO-placeable (all four structural fields above are valid).
    // Placeholder values are never read for a real decision: runPreflight's fieldsValid check
    // short-circuits to VALIDATION_ERROR before touching siteId/assumedSiteId/gps/etc.
    return {
      ok: true,
      value: {
        clientEventId,
        deviceSequence,
        groupId,
        operationType: operationType!, // non-null: an operationType failure would already have been in structuralErrors above.
        fieldsValid: false,
        siteId: siteId ?? '',
        assumedSiteId,
        workAreaId,
        clientCapturedAt: clientCapturedAt ?? new Date(0),
        cachedGeofenceVersionId,
        gps: gps.ok ? gps.value : INVALID_EVENT_GPS,
        gpsApproximate: null
      }
    };
  }

  return {
    ok: true,
    value: { clientEventId, deviceSequence, groupId, operationType: operationType!, fieldsValid: true, siteId: siteId!, assumedSiteId, workAreaId, clientCapturedAt: clientCapturedAt!, cachedGeofenceVersionId, gps: gps.ok ? gps.value : INVALID_EVENT_GPS, gpsApproximate: gpsApproximate.ok ? gpsApproximate.value : null }
  };
}

export type SyncRequestValidation =
  | { ok: true; deviceInstallationId: string; events: SyncEventInput[] }
  | { ok: false; fieldErrors: Record<string, string[]> };

/**
 * Envelope validation (§C "структурно валидная batch shape") — deviceInstallationId + array
 * bounds, plus each event's four STRUCTURAL fields (clientEventId/deviceSequence/groupId/
 * operationType — see validateSyncEventBody's doc comment). Any structural failure anywhere in
 * the array rejects the WHOLE request (400) — FIFO cannot place an event it can't identify or
 * order. Every other per-event field failure is business-level and does NOT reject the envelope;
 * it survives as a `fieldsValid: false` SyncEventInput that performSync's own preflight rejects
 * individually (REJECTED_TERMINAL/VALIDATION_ERROR), consuming exactly one FIFO slot.
 */
export function validateSyncRequestBody(raw: Record<string, unknown>): SyncRequestValidation {
  const fieldErrors: Record<string, string[]> = {};
  if (!isValidUuid(raw.deviceInstallationId)) {
    fieldErrors.deviceInstallationId = ['required, must be a UUID'];
  }
  if (!Array.isArray(raw.events)) {
    fieldErrors.events = ['required, must be an array'];
  } else if (raw.events.length === 0) {
    fieldErrors.events = ['must not be empty'];
  } else if (raw.events.length > MAX_SYNC_BATCH_EVENTS) {
    fieldErrors.events = [`must not exceed ${MAX_SYNC_BATCH_EVENTS} events`];
  }
  if (Object.keys(fieldErrors).length > 0 || !Array.isArray(raw.events)) {
    return { ok: false, fieldErrors };
  }

  const parsed = raw.events.map((rawEvent) => validateSyncEventBody(rawEvent));
  const structuralFailureErrors: Record<string, string[]> = {};
  parsed.forEach((e, i) => {
    if (!e.ok) {
      for (const [k, v] of Object.entries(e.fieldErrors)) {
        structuralFailureErrors[`events[${i}].${k || 'value'}`] = v;
      }
    }
  });
  if (Object.keys(structuralFailureErrors).length > 0) {
    return { ok: false, fieldErrors: structuralFailureErrors };
  }

  return { ok: true, deviceInstallationId: raw.deviceInstallationId as string, events: parsed.map((e) => (e as { ok: true; value: SyncEventInput }).value) };
}

// ---------------------------------------------------------------------------------------------
// Offline payload hashing (§D task requirement) — reuses canonicalizeForHash (the shared
// canonicalization primitive, imported from lib/attendance-clock.ts) but defines its own input
// shape, since offline events carry deviceInstallationId/deviceSequence that online events never
// do. GPS participates in the hash (moved coordinates under the same clientEventId are a real
// conflict); the hash itself and the sanitized conflict payload never carry raw coordinates —
// same "no `gps.latitude/longitude` key" shape as lib/attendance-clock.ts's own
// sanitizedConflictPayload, which independently satisfies the DB CHECK
// ck_conflict_payload_no_gps_coordinates (path `{gps,latitude}` is NULL when the key doesn't
// exist at all).
// ---------------------------------------------------------------------------------------------

interface OfflineEventHashInput {
  employeeId: string;
  deviceInstallationId: string;
  deviceSequence: string;
  clientEventId: string;
  operationType: 'CHECK_IN' | 'CHECK_OUT';
  groupId: string | null;
  siteId: string;
  assumedSiteId: string | null;
  workAreaId: string | null;
  clientCapturedAt: string;
  gps: ClockGpsReading;
}

function offlineEventHashInput(employeeId: string, deviceInstallationId: string, event: SyncEventInput): OfflineEventHashInput {
  return {
    employeeId,
    deviceInstallationId,
    deviceSequence: event.deviceSequence.toString(),
    clientEventId: event.clientEventId,
    operationType: event.operationType,
    groupId: event.groupId,
    siteId: event.siteId,
    assumedSiteId: event.assumedSiteId,
    workAreaId: event.workAreaId,
    clientCapturedAt: event.clientCapturedAt.toISOString(),
    gps: event.gps
  };
}

function computeOfflinePayloadHash(input: OfflineEventHashInput): string {
  return createHash('sha256').update(canonicalizeForHash(input as unknown as Record<string, unknown>)).digest('hex');
}

function sanitizedOfflineConflictPayload(input: OfflineEventHashInput): Prisma.InputJsonValue {
  return {
    deviceSequence: input.deviceSequence,
    operationType: input.operationType,
    groupId: input.groupId,
    siteId: input.siteId,
    assumedSiteId: input.assumedSiteId,
    workAreaId: input.workAreaId,
    clientCapturedAt: input.clientCapturedAt,
    hasLocation: input.gps.location !== null,
    gpsUnavailableReason: input.gps.gpsUnavailableReason
  };
}

async function recordOfflineConflict(
  tx: Prisma.TransactionClient,
  employeeId: string,
  deviceInstallationId: string,
  requestId: string,
  conflictType: 'CLIENT_EVENT_ID_REUSED' | 'DEVICE_SEQUENCE_REUSED',
  input: OfflineEventHashInput,
  payloadHash: string
): Promise<void> {
  await tx.clockEventIdConflict.create({
    data: {
      conflictType,
      clientEventId: input.clientEventId,
      employeeId,
      deviceInstallationId,
      sanitizedConflictingPayload: sanitizedOfflineConflictPayload(input),
      conflictingPayloadHash: payloadHash,
      requestId
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Response contract (§7 JSON shape + §9.11 additions).
// ---------------------------------------------------------------------------------------------

export interface SyncEventResult {
  clientEventId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE_ACK' | 'REJECTED' | 'RETRYABLE';
  processingState?: 'ACCEPTED' | 'NEEDS_REVIEW';
  exceptionType?: string;
  code?: string;
  groupId?: string;
}

export type SyncPerformResult =
  | { kind: 'OK'; results: SyncEventResult[] }
  | { kind: 'DEVICE_NOT_OWNED' }
  | { kind: 'DEVICE_REVOKED' }
  | { kind: 'RETRY_EXHAUSTED' };

class DeviceNotOwnedSignal extends Error {}
class DeviceRevokedSignal extends Error {}

// ---------------------------------------------------------------------------------------------
// Preflight (§9.11 runPreflight) — decidable WITHOUT mutation and WITHOUT knowing
// EmployeeOpenShift state. For CHECK_IN: site/workArea existence + GPS/geofence evaluation against
// the CURRENT geofence of event.siteId (never the client's cachedGeofenceVersionId). T17 — a
// Check In is NO LONGER geofence-terminal: a VERIFIED_OUTSIDE reading opens the shift like any
// other and creates an OUTSIDE_GEOFENCE_CHECKIN review flag (see insertAndApplyCheckIn), matching
// how Check Out already behaves. Only a structurally invalid event / unknown site is terminal.
// For CHECK_OUT: only assumedSiteId existence — Check Out is never geofence-terminal (§5.4/§9.2),
// its real GPS evaluation happens later, against the AUTHORITATIVE site from EmployeeOpenShift,
// inside insertAndApplyCheckOut — exactly mirroring online checkOutCore's own ordering.
// ---------------------------------------------------------------------------------------------

interface PreflightResult {
  terminal: boolean;
  code?: 'VALIDATION_ERROR';
  checkInGps?: { gpsResult: GpsEvaluation; geofence: ClockGeofence | null };
}

async function runPreflight(tx: Prisma.TransactionClient, event: SyncEventInput): Promise<PreflightResult> {
  if (!event.fieldsValid) {
    return { terminal: true, code: 'VALIDATION_ERROR' };
  }
  if (event.operationType === 'CHECK_IN') {
    const site = await tx.workSite.findUnique({ where: { id: event.siteId }, select: { id: true } });
    if (!site) {
      return { terminal: true, code: 'VALIDATION_ERROR' };
    }
    if (event.workAreaId) {
      const workArea = await tx.workArea.findFirst({ where: { id: event.workAreaId, siteId: event.siteId }, select: { id: true } });
      if (!workArea) {
        return { terminal: true, code: 'VALIDATION_ERROR' };
      }
    }
    const geofence = await loadCurrentGeofence(tx, event.siteId);
    const gpsResult = evaluateGpsReading(event.gps, geofence, await loadMaxGpsAccuracyMeters(tx));
    return { terminal: false, checkInGps: { gpsResult, geofence } };
  }

  const assumedSite = await tx.workSite.findUnique({ where: { id: event.assumedSiteId! }, select: { id: true } });
  if (!assumedSite) {
    return { terminal: true, code: 'VALIDATION_ERROR' };
  }
  return { terminal: false };
}

// ---------------------------------------------------------------------------------------------
// GEOFENCE_VERSION_MISMATCH (§14/§12 task security requirement — "cachedGeofenceVersionId
// проверяется как версия того же site; устаревшая cached version не становится authoritative").
// This is purely a client-cache-staleness signal, orthogonal to the accept/reject decision, which
// always uses the freshly-loaded CURRENT geofence (never the cached id) — fires whenever the
// client's cached geofence id differs from the site's actual current one, on any ACCEPTED event
// (CHECK_IN outside geofence never reaches here — no ClockEvent exists for it to attach to).
// ---------------------------------------------------------------------------------------------
function geofenceVersionMismatchDetail(event: SyncEventInput, actualGeofenceVersionId: string | null): Prisma.InputJsonValue | null {
  if (event.cachedGeofenceVersionId === null || actualGeofenceVersionId === null) {
    return null;
  }
  if (event.cachedGeofenceVersionId === actualGeofenceVersionId) {
    return null;
  }
  return { cachedGeofenceVersionId: event.cachedGeofenceVersionId, currentGeofenceVersionId: actualGeofenceVersionId };
}

// ---------------------------------------------------------------------------------------------
// Insert-skipping-duplicates — the ON CONFLICT (id) DO NOTHING primitive §9.11 requires, via
// Prisma's createMany({skipDuplicates:true}) (a real Postgres ON CONFLICT DO NOTHING under the
// hood) instead of raw SQL — critically, unlike `.create()`, this does NOT throw/poison the
// enclosing SAVEPOINT when the id already exists, so the per-event SAVEPOINT stays usable
// afterward for the CLIENT_EVENT_ID_REUSED path.
// ---------------------------------------------------------------------------------------------
async function tryInsertClockEvent(tx: Prisma.TransactionClient, data: Prisma.ClockEventCreateManyInput): Promise<boolean> {
  const result = await tx.clockEvent.createMany({ data: [data], skipDuplicates: true });
  return result.count === 1;
}

// ---------------------------------------------------------------------------------------------
// T14 (2026-08-29) — GPS offline resilience.
// ---------------------------------------------------------------------------------------------

/** A fresh in-gate fix is stored verbatim (unchanged behaviour). Otherwise, if the device attached
 * an APPROXIMATE point (its last-good / OS-cached fix), it is stored as an approximate
 * ClockEventLocation — `evaluateGpsReading` still returned `location: null`, so the event stays
 * NOT_VERIFIED; this point only ever renders as a dashed "approximate" marker on the admin map. */
async function writeEventLocation(tx: Prisma.TransactionClient, clockEventId: string, gpsResult: GpsEvaluation, approximate: ApproximateGpsReading | null): Promise<void> {
  if (gpsResult.location) {
    await tx.clockEventLocation.create({ data: { clockEventId, latitude: gpsResult.location.latitude, longitude: gpsResult.location.longitude } });
    return;
  }
  if (approximate) {
    await tx.clockEventLocation.create({
      data: {
        clockEventId,
        latitude: approximate.latitude,
        longitude: approximate.longitude,
        isApproximate: true,
        fixAgeSeconds: approximate.fixAgeSeconds,
        capturedAfterEventSeconds: approximate.capturedAfterEventSeconds
      }
    });
  }
}

/** Creates a GPS_NOT_VERIFIED exception. It is ALWAYS created OPEN and joins the review queue — the
 * exact pre-T14 behaviour, and the exact current behaviour for a site whose `gpsOftenUnavailable`
 * flag is OFF (unchanged).
 *
 * R15 fixroad F03 (owner, 2026-09-04): `WorkSite.gpsOftenUnavailable` is now INFORMATIONAL ONLY.
 *  - flag OFF  → this exception opens exactly as before (no notes, nothing special);
 *  - flag ON   → this exception STILL opens for review; the admin panel and the worker clock
 *                screen additionally show a calm explanatory note (UI-only, driven by the flag);
 *  - the flag NEVER auto-resolves an exception and NEVER touches an existing record.
 * The T14 auto-acknowledge branch (site + no-coordinate → RESOLVED) is removed. Re-enabling
 * automatic acceptance is a separate, separately-approved step gated behind a second flag — see
 * docs/titanor-time/R15_MEYER_GPS_AUTOACCEPT_PLAN_RU.md.
 *
 * This helper only handles GPS_NOT_VERIFIED. OUTSIDE_GEOFENCE_CHECKIN / OUTSIDE_GEOFENCE_CHECKOUT
 * (a good coordinate that placed the worker measurably elsewhere) are a different exception type on
 * a different code path above — the flag does not touch them and their handling is unchanged. The
 * manual, filter-scoped bulkAcknowledgeGpsNotVerified admin action is also unchanged. */
async function createGpsNotVerifiedException(
  tx: Prisma.TransactionClient,
  data: Prisma.AttendanceExceptionUncheckedCreateInput
): Promise<void> {
  await tx.attendanceException.create({ data });
}

interface CheckInEffectResult {
  processingState: 'ACCEPTED' | 'NEEDS_REVIEW';
  exceptionType?: string;
}

/** §9.1 offline — mirrors checkInCore's business effects exactly (channel=OFFLINE_SYNC, device fields, backdated effectiveAt). Returns null if the global ClockEvent.id PK conflicted with a different employee's event (CLIENT_EVENT_ID_REUSED). */
async function insertAndApplyCheckIn(
  tx: Prisma.TransactionClient,
  employeeId: string,
  actorUserId: string,
  requestId: string,
  event: SyncEventInput,
  deviceInstallationId: string,
  groupId: string | null,
  checkInGps: { gpsResult: GpsEvaluation; geofence: ClockGeofence | null }
): Promise<{ inserted: true; result: CheckInEffectResult; payloadHash: string } | { inserted: false; payloadHash: string; hashInput: OfflineEventHashInput }> {
  const hashInput = offlineEventHashInput(employeeId, deviceInstallationId, event);
  const payloadHash = computeOfflinePayloadHash(hashInput);
  const { gpsResult, geofence } = checkInGps;

  const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId }, select: { employeeId: true } });
  const serverReceivedAt = new Date();
  const timeResult = computeOfflineEffectiveTime(event.clientCapturedAt, serverReceivedAt);
  const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, employeeId, timeResult.effectiveAt);
  const processingState: 'ACCEPTED' | 'NEEDS_REVIEW' = openShift ? 'NEEDS_REVIEW' : 'ACCEPTED';
  // ClockEvent is immutable (§4.1, no UPDATE ever) — sourceAssignmentId must be resolved BEFORE
  // insert, not patched in afterward. Only meaningful for the "no existing open shift" branch
  // (mirrors online checkInCore exactly); a DOUBLE_CHECK_IN event never resolves/stores one.
  const sourceAssignmentId = openShift ? null : await resolveActiveSiteAssignment(tx, employeeId, event.siteId, event.workAreaId, timeResult.effectiveAt);

  const inserted = await tryInsertClockEvent(tx, {
    id: event.clientEventId,
    groupId,
    employeeId,
    deviceInstallationId,
    deviceSequence: event.deviceSequence,
    operationType: 'CHECK_IN',
    siteId: event.siteId,
    assumedSiteId: null,
    workAreaId: event.workAreaId,
    sourceAssignmentId,
    clientCapturedAt: event.clientCapturedAt,
    capturedOffline: true,
    serverReceivedAt,
    effectiveAt: timeResult.effectiveAt,
    clockSkewMs: timeResult.clockSkewMs,
    gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
    geofenceVersionId: gpsResult.geofenceVersionId,
    gpsVerification: gpsResult.gpsVerification,
    gpsUnavailableReason: gpsResult.gpsUnavailableReason,
    processingState,
    channel: 'OFFLINE_SYNC',
    payloadHash,
    requestId
  });
  if (!inserted) {
    return { inserted: false, payloadHash, hashInput };
  }

  await writeEventLocation(tx, event.clientEventId, gpsResult, event.gpsApproximate);

  let exceptionType: string | undefined;

  if (openShift) {
    await tx.attendanceException.create({
      data: { type: 'DOUBLE_CHECK_IN', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, status: 'OPEN' }
    });
    exceptionType = 'DOUBLE_CHECK_IN';
    if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
      await createGpsNotVerifiedException(tx, {
        type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, detail: exceptionDetailForGps(gpsResult, geofence)
      });
    }
  } else {
    // sourceAssignmentId was already resolved above, before the ClockEvent insert — reused here
    // verbatim, never recomputed (ClockEvent is immutable, §4.1: there is no second write to it).
    await tx.employeeOpenShift.create({
      data: { employeeId, openedByClockEventId: event.clientEventId, siteId: event.siteId, workAreaId: event.workAreaId, sourceAssignmentId, openedAt: timeResult.effectiveAt }
    });
    if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
      await createGpsNotVerifiedException(tx, {
        type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, detail: exceptionDetailForGps(gpsResult, geofence)
      });
      exceptionType = 'GPS_NOT_VERIFIED';
    }
    if (!sourceAssignmentId) {
      await tx.attendanceException.create({
        data: { type: 'STALE_ASSIGNMENT', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, clockShiftId: null, status: 'OPEN' }
      });
      exceptionType = exceptionType ?? 'STALE_ASSIGNMENT';
    }
  }

  // T17 — a good GPS fix that lands outside the site geofence: the shift still opens (above), this
  // is only a review flag. Mirrors OUTSIDE_GEOFENCE_CHECKOUT. Applies to a normal Check In and to a
  // DOUBLE_CHECK_IN alike.
  if (gpsResult.gpsVerification === 'VERIFIED_OUTSIDE') {
    await tx.attendanceException.create({
      data: { type: 'OUTSIDE_GEOFENCE_CHECKIN', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
    });
    exceptionType = exceptionType ?? 'OUTSIDE_GEOFENCE_CHECKIN';
  }

  if (timeResult.exception === 'EXCESSIVE_CLOCK_SKEW') {
    await tx.attendanceException.create({
      data: { type: 'EXCESSIVE_CLOCK_SKEW', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, status: 'OPEN', detail: { clockSkewMs: timeResult.clockSkewMs.toString() } }
    });
    exceptionType = exceptionType ?? 'EXCESSIVE_CLOCK_SKEW';
  }
  const mismatchDetail = geofenceVersionMismatchDetail(event, gpsResult.geofenceVersionId);
  if (mismatchDetail) {
    await tx.attendanceException.create({
      data: { type: 'GEOFENCE_VERSION_MISMATCH', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.siteId, clockEventId: event.clientEventId, status: 'OPEN', detail: mismatchDetail }
    });
    exceptionType = exceptionType ?? 'GEOFENCE_VERSION_MISMATCH';
  }

  await createAuditEvent(tx, {
    actorUserId,
    eventType: openShift ? 'CLOCK_CHECK_IN_REJECTED_DOUBLE' : 'CLOCK_CHECK_IN',
    entityType: 'CLOCK_EVENT',
    entityId: event.clientEventId,
    requestId,
    beforeValue: null,
    afterValue: { operationType: 'CHECK_IN', processingState, siteId: event.siteId, workAreaId: event.workAreaId, channel: 'OFFLINE_SYNC' }
  });

  return { inserted: true, result: { processingState, exceptionType }, payloadHash };
}

interface CheckOutEffectResult {
  processingState: 'ACCEPTED' | 'NEEDS_REVIEW';
  exceptionType?: string;
  clockShiftId: string | null;
}

/** §9.2 offline — mirrors checkOutCore's business effects exactly, including inline materialization via the shared materializeClockShiftCore (same SAVEPOINT, not a nested transaction). */
async function insertAndApplyCheckOut(
  tx: Prisma.TransactionClient,
  employeeId: string,
  actorUserId: string,
  requestId: string,
  event: SyncEventInput,
  deviceInstallationId: string,
  groupId: string | null
): Promise<{ inserted: true; result: CheckOutEffectResult; payloadHash: string } | { inserted: false; payloadHash: string; hashInput: OfflineEventHashInput }> {
  const hashInput = offlineEventHashInput(employeeId, deviceInstallationId, event);
  const payloadHash = computeOfflinePayloadHash(hashInput);
  const serverReceivedAt = new Date();

  await tx.$queryRaw`SELECT "employeeId" FROM "EmployeeOpenShift" WHERE "employeeId" = ${employeeId}::uuid FOR UPDATE`;
  const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId } });

  if (!openShift) {
    const timeResult = computeOfflineEffectiveTime(event.clientCapturedAt, serverReceivedAt);
    const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, employeeId, timeResult.effectiveAt);
    const geofence = await loadCurrentGeofence(tx, event.assumedSiteId!);
    const gpsResult = evaluateGpsReading(event.gps, geofence, await loadMaxGpsAccuracyMeters(tx));

    const inserted = await tryInsertClockEvent(tx, {
      id: event.clientEventId,
      groupId,
      employeeId,
      deviceInstallationId,
      deviceSequence: event.deviceSequence,
      operationType: 'CHECK_OUT',
      siteId: event.assumedSiteId!,
      assumedSiteId: event.assumedSiteId,
      workAreaId: null,
      sourceAssignmentId: null,
      clientCapturedAt: event.clientCapturedAt,
      capturedOffline: true,
      serverReceivedAt,
      effectiveAt: timeResult.effectiveAt,
      clockSkewMs: timeResult.clockSkewMs,
      gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
      geofenceVersionId: gpsResult.geofenceVersionId,
      gpsVerification: gpsResult.gpsVerification,
      gpsUnavailableReason: gpsResult.gpsUnavailableReason,
      processingState: 'NEEDS_REVIEW',
      channel: 'OFFLINE_SYNC',
      payloadHash,
      requestId
    });
    if (!inserted) {
      return { inserted: false, payloadHash, hashInput };
    }
    await writeEventLocation(tx, event.clientEventId, gpsResult, event.gpsApproximate);
    await tx.attendanceException.create({
      data: { type: 'CHECKOUT_WITHOUT_OPEN_SHIFT', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.assumedSiteId!, clockEventId: event.clientEventId, status: 'OPEN' }
    });
    // A real Check Out that arrives after the scheduler already auto-closed this shift: stamp the
    // true time onto the still-open SHIFT_AUTO_CLOSED_MAX_DURATION so the admin reconciles the
    // provisional (template) end against it. The ClockShift itself is immutable.
    await annotateAutoClosedShiftWithLateCheckOut(tx, employeeId, timeResult.effectiveAt, event.clientEventId);
    let exceptionType = 'CHECKOUT_WITHOUT_OPEN_SHIFT';
    if (gpsResult.gpsVerification === 'VERIFIED_OUTSIDE') {
      await tx.attendanceException.create({
        data: { type: 'OUTSIDE_GEOFENCE_CHECKOUT', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.assumedSiteId!, clockEventId: event.clientEventId, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
      });
    } else if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
      await createGpsNotVerifiedException(tx, {
        type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.assumedSiteId!, clockEventId: event.clientEventId, detail: exceptionDetailForGps(gpsResult, geofence)
      });
    }
    if (timeResult.exception === 'EXCESSIVE_CLOCK_SKEW') {
      await tx.attendanceException.create({
        data: { type: 'EXCESSIVE_CLOCK_SKEW', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.assumedSiteId!, clockEventId: event.clientEventId, status: 'OPEN', detail: { clockSkewMs: timeResult.clockSkewMs.toString() } }
      });
    }
    const mismatchDetail = geofenceVersionMismatchDetail(event, gpsResult.geofenceVersionId);
    if (mismatchDetail) {
      await tx.attendanceException.create({
        data: { type: 'GEOFENCE_VERSION_MISMATCH', employeeId, timesheetId, payrollPeriodId, occurredAt: timeResult.effectiveAt, siteId: event.assumedSiteId!, clockEventId: event.clientEventId, status: 'OPEN', detail: mismatchDetail }
      });
    }
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CLOCK_CHECK_OUT_ORPHAN',
      entityType: 'CLOCK_EVENT',
      entityId: event.clientEventId,
      requestId,
      beforeValue: null,
      afterValue: { operationType: 'CHECK_OUT', processingState: 'NEEDS_REVIEW', assumedSiteId: event.assumedSiteId, channel: 'OFFLINE_SYNC' }
    });
    return { inserted: true, result: { processingState: 'NEEDS_REVIEW', exceptionType, clockShiftId: null }, payloadHash };
  }

  // (a) authoritative values — EmployeeOpenShift, never the request (§14 threat model).
  const authoritativeSiteId = openShift.siteId;
  const authoritativeWorkAreaId = openShift.workAreaId;
  const authoritativeSourceAssignmentId = openShift.sourceAssignmentId;
  const openedAt = openShift.openedAt;

  const geofence = await loadCurrentGeofence(tx, authoritativeSiteId);
  const gpsResult = evaluateGpsReading(event.gps, geofence, await loadMaxGpsAccuracyMeters(tx));
  const timeResult = computeOfflineEffectiveTime(event.clientCapturedAt, serverReceivedAt);
  const effectiveAt = timeResult.effectiveAt;

  let recordedEndAtForShift: Date;
  let chronologyAnomaly: boolean;
  if (effectiveAt.getTime() <= openedAt.getTime()) {
    recordedEndAtForShift = new Date(openedAt.getTime() + CHRONOLOGY_CLAMP_MS);
    chronologyAnomaly = true;
  } else {
    recordedEndAtForShift = effectiveAt;
    chronologyAnomaly = false;
  }

  const inserted = await tryInsertClockEvent(tx, {
    id: event.clientEventId,
    groupId,
    employeeId,
    deviceInstallationId,
    deviceSequence: event.deviceSequence,
    operationType: 'CHECK_OUT',
    siteId: authoritativeSiteId,
    assumedSiteId: event.assumedSiteId,
    workAreaId: authoritativeWorkAreaId,
    sourceAssignmentId: authoritativeSourceAssignmentId,
    clientCapturedAt: event.clientCapturedAt,
    capturedOffline: true,
    serverReceivedAt,
    effectiveAt,
    clockSkewMs: timeResult.clockSkewMs,
    gpsAccuracyMeters: gpsResult.gpsAccuracyMeters,
    geofenceVersionId: gpsResult.geofenceVersionId,
    gpsVerification: gpsResult.gpsVerification,
    gpsUnavailableReason: gpsResult.gpsUnavailableReason,
    processingState: 'ACCEPTED',
    channel: 'OFFLINE_SYNC',
    payloadHash,
    requestId
  });
  if (!inserted) {
    return { inserted: false, payloadHash, hashInput };
  }
  await writeEventLocation(tx, event.clientEventId, gpsResult, event.gpsApproximate);

  const clockShift = await tx.clockShift.create({
    data: {
      employeeId,
      checkInEventId: openShift.openedByClockEventId,
      checkOutEventId: event.clientEventId,
      siteId: authoritativeSiteId,
      workAreaId: authoritativeWorkAreaId,
      sourceAssignmentId: authoritativeSourceAssignmentId,
      recordedStartAt: openedAt,
      recordedEndAt: recordedEndAtForShift,
      endAtProvisional: chronologyAnomaly,
      materializationState: 'PENDING'
    }
  });

  await tx.employeeOpenShift.delete({ where: { employeeId } });

  // §9.6 "Автоматическое разрешение при позднем реальном Check Out" — resolves every period-scoped
  // OPEN MISSING_CHECKOUT_AT_CUTOFF tied to this same opening ClockEvent, if any (T7A.10A). Never
  // reached on a replay/duplicate delivery of the same event (this whole insert path is only
  // reached after tryInsertClockEvent's own ON CONFLICT DO NOTHING succeeds).
  await resolveMissingCheckoutAtCutoffOnLateCheckOut(tx, openShift.openedByClockEventId);

  const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, employeeId, effectiveAt);
  let exceptionType: string | undefined;

  if (event.assumedSiteId !== authoritativeSiteId) {
    await tx.attendanceException.create({
      data: { type: 'SITE_MISMATCH_CHECKOUT', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: event.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: { assumedSiteId: event.assumedSiteId, authoritativeSiteId } }
    });
    exceptionType = 'SITE_MISMATCH_CHECKOUT';
  }
  if (gpsResult.gpsVerification === 'VERIFIED_OUTSIDE') {
    await tx.attendanceException.create({
      data: { type: 'OUTSIDE_GEOFENCE_CHECKOUT', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: event.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: exceptionDetailForGps(gpsResult, geofence) }
    });
    exceptionType = exceptionType ?? 'OUTSIDE_GEOFENCE_CHECKOUT';
  } else if (gpsResult.gpsVerification === 'NOT_VERIFIED') {
    await createGpsNotVerifiedException(tx, {
      type: 'GPS_NOT_VERIFIED', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: event.clientEventId, clockShiftId: clockShift.id, detail: exceptionDetailForGps(gpsResult, geofence)
    });
    exceptionType = exceptionType ?? 'GPS_NOT_VERIFIED';
  }
  let chronologyExceptionId: string | null = null;
  if (chronologyAnomaly) {
    const chronologyException = await tx.attendanceException.create({
      data: {
        type: 'CHECKOUT_CHRONOLOGY_ANOMALY',
        employeeId,
        timesheetId,
        payrollPeriodId,
        occurredAt: effectiveAt,
        siteId: authoritativeSiteId,
        clockEventId: event.clientEventId,
        clockShiftId: clockShift.id,
        clockShiftFragmentId: null,
        status: 'OPEN',
        detail: { claimedEffectiveAt: effectiveAt.toISOString(), openedAt: openedAt.toISOString(), clampedTo: recordedEndAtForShift.toISOString() }
      }
    });
    chronologyExceptionId = chronologyException.id;
    exceptionType = exceptionType ?? 'CHECKOUT_CHRONOLOGY_ANOMALY';
  }
  if (timeResult.exception === 'EXCESSIVE_CLOCK_SKEW') {
    await tx.attendanceException.create({
      data: { type: 'EXCESSIVE_CLOCK_SKEW', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: event.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: { clockSkewMs: timeResult.clockSkewMs.toString() } }
    });
    exceptionType = exceptionType ?? 'EXCESSIVE_CLOCK_SKEW';
  }
  const mismatchDetail = geofenceVersionMismatchDetail(event, gpsResult.geofenceVersionId);
  if (mismatchDetail) {
    await tx.attendanceException.create({
      data: { type: 'GEOFENCE_VERSION_MISMATCH', employeeId, timesheetId, payrollPeriodId, occurredAt: effectiveAt, siteId: authoritativeSiteId, clockEventId: event.clientEventId, clockShiftId: clockShift.id, status: 'OPEN', detail: mismatchDetail }
    });
    exceptionType = exceptionType ?? 'GEOFENCE_VERSION_MISMATCH';
  }

  // Overlap detection — shared helper, no reimplementation (§9.1a).
  const candidates = await overlapCandidates(tx, clockShift.id);
  for (const candidateShiftId of candidates) {
    const afterOverlaps = await overlapExists(tx, clockShift.id, candidateShiftId);
    await resolveOverlapTransition(tx, clockShift.id, candidateShiftId, false, afterOverlaps, clockShift.id, requestId);
  }

  const policy = await tx.companyAttendancePolicy.findFirst({ select: { maxShiftDurationHours: true } });
  const maxDurationMs = (policy?.maxShiftDurationHours ?? 16) * 3600000;
  if (recordedEndAtForShift.getTime() - openedAt.getTime() > maxDurationMs) {
    await tx.attendanceException.create({
      data: {
        type: 'EXCESSIVE_SHIFT_DURATION',
        employeeId,
        timesheetId,
        payrollPeriodId,
        occurredAt: effectiveAt,
        siteId: authoritativeSiteId,
        clockEventId: event.clientEventId,
        clockShiftId: clockShift.id,
        status: 'OPEN',
        detail: { durationHours: (recordedEndAtForShift.getTime() - openedAt.getTime()) / 3600000, thresholdHours: policy?.maxShiftDurationHours ?? 16 }
      }
    });
    exceptionType = exceptionType ?? 'EXCESSIVE_SHIFT_DURATION';
  }

  await createAuditEvent(tx, {
    actorUserId,
    eventType: 'CLOCK_CHECK_OUT',
    entityType: 'CLOCK_EVENT',
    entityId: event.clientEventId,
    requestId,
    beforeValue: { siteId: authoritativeSiteId, openedAt: openedAt.toISOString() },
    afterValue: { operationType: 'CHECK_OUT', processingState: 'ACCEPTED', clockShiftId: clockShift.id, channel: 'OFFLINE_SYNC' }
  });

  const overlapBlocking =
    (await tx.attendanceException.count({ where: { type: 'OVERLAPPING_SHIFT', status: 'OPEN', OR: [{ clockShiftId: clockShift.id }, { relatedClockShiftId: clockShift.id }] } })) > 0;
  if (authoritativeSourceAssignmentId !== null && !overlapBlocking) {
    await materializeClockShiftCore(tx, clockShift.id, requestId);
  }
  if (chronologyExceptionId) {
    const fragment = await tx.clockShiftFragment.findFirst({ where: { clockShiftId: clockShift.id }, orderBy: { fragmentIndex: 'desc' }, select: { id: true } });
    if (fragment) {
      await tx.attendanceException.update({ where: { id: chronologyExceptionId }, data: { clockShiftFragmentId: fragment.id } });
    }
  }

  return { inserted: true, result: { processingState: 'ACCEPTED', exceptionType, clockShiftId: clockShift.id }, payloadHash };
}

// ---------------------------------------------------------------------------------------------
// Receipts.
// ---------------------------------------------------------------------------------------------

async function insertAcceptedReceipt(tx: Prisma.TransactionClient, deviceInstallationId: string, employeeId: string, event: SyncEventInput, clockEventId: string, payloadHash: string): Promise<void> {
  await tx.deviceEventReceipt.create({
    data: { deviceInstallationId, employeeId, deviceSequence: event.deviceSequence, clientEventId: event.clientEventId, outcome: 'ACCEPTED', clockEventId, rejectionCode: null, payloadHash }
  });
}

async function insertRejectedReceipt(tx: Prisma.TransactionClient, deviceInstallationId: string, employeeId: string, event: SyncEventInput, rejectionCode: string, payloadHash: string): Promise<void> {
  await tx.deviceEventReceipt.create({
    data: { deviceInstallationId, employeeId, deviceSequence: event.deviceSequence, clientEventId: event.clientEventId, outcome: 'REJECTED_TERMINAL', clockEventId: null, rejectionCode, payloadHash }
  });
}

// ---------------------------------------------------------------------------------------------
// Single (non-grouped) event processing — one SAVEPOINT, §9.11 "Одиночная обработка".
// ---------------------------------------------------------------------------------------------

async function processSingleEvent(tx: Prisma.TransactionClient, employeeId: string, actorUserId: string, requestId: string, deviceInstallationId: string, event: SyncEventInput): Promise<SyncEventResult> {
  await tx.$executeRawUnsafe('SAVEPOINT event_sp');
  const preflight = await runPreflight(tx, event);

  if (preflight.terminal) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT event_sp');
    const hashInput = offlineEventHashInput(employeeId, deviceInstallationId, event);
    const payloadHash = computeOfflinePayloadHash(hashInput);
    await insertRejectedReceipt(tx, deviceInstallationId, employeeId, event, preflight.code!, payloadHash);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT event_sp');
    return { clientEventId: event.clientEventId, outcome: 'REJECTED', code: preflight.code };
  }

  const outcome =
    event.operationType === 'CHECK_IN'
      ? await insertAndApplyCheckIn(tx, employeeId, actorUserId, requestId, event, deviceInstallationId, event.groupId, preflight.checkInGps!)
      : await insertAndApplyCheckOut(tx, employeeId, actorUserId, requestId, event, deviceInstallationId, event.groupId);

  if (!outcome.inserted) {
    await recordOfflineConflict(tx, employeeId, deviceInstallationId, requestId, 'CLIENT_EVENT_ID_REUSED', outcome.hashInput, outcome.payloadHash);
    await insertRejectedReceipt(tx, deviceInstallationId, employeeId, event, 'CLIENT_EVENT_ID_REUSED', outcome.payloadHash);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT event_sp');
    return { clientEventId: event.clientEventId, outcome: 'REJECTED', code: 'CLIENT_EVENT_ID_REUSED' };
  }

  await insertAcceptedReceipt(tx, deviceInstallationId, employeeId, event, event.clientEventId, outcome.payloadHash);
  await tx.$executeRawUnsafe('RELEASE SAVEPOINT event_sp');
  return { clientEventId: event.clientEventId, outcome: 'ACCEPTED', processingState: outcome.result.processingState, exceptionType: outcome.result.exceptionType };
}

// ---------------------------------------------------------------------------------------------
// INVALID (structurally-broken group) — §9.11, no SAVEPOINT needed (nothing attempted yet).
// ---------------------------------------------------------------------------------------------

async function writeInvalidHalf(tx: Prisma.TransactionClient, employeeId: string, deviceInstallationId: string, event: SyncEventInput): Promise<void> {
  const hashInput = offlineEventHashInput(employeeId, deviceInstallationId, event);
  const payloadHash = computeOfflinePayloadHash(hashInput);
  await insertRejectedReceipt(tx, deviceInstallationId, employeeId, event, 'SWITCH_SITE_GROUP_INVALID', payloadHash);
}

async function auditInvalidGroup(tx: Prisma.TransactionClient, requestId: string, groupId: string, sequences: bigint[]): Promise<void> {
  await createAuditEvent(tx, {
    actorUserId: null,
    eventType: 'SWITCH_SITE_GROUP_INVALID',
    entityType: 'CLOCK_EVENT_GROUP',
    entityId: groupId,
    requestId,
    beforeValue: { invalidHalves: sequences.map((s) => s.toString()) },
    afterValue: null
  });
}

// ---------------------------------------------------------------------------------------------
// Group processing — one group_sp, §9.11 "Групповая обработка" + "GROUP_TERMINAL".
// ---------------------------------------------------------------------------------------------

async function processGroup(
  tx: Prisma.TransactionClient,
  employeeId: string,
  actorUserId: string,
  requestId: string,
  deviceInstallationId: string,
  checkOutEvent: SyncEventInput,
  checkInEvent: SyncEventInput
): Promise<[SyncEventResult, SyncEventResult]> {
  await tx.$executeRawUnsafe('SAVEPOINT group_sp');
  const groupId = checkOutEvent.groupId!;

  async function groupTerminal(failedHalf: 'CHECK_OUT' | 'CHECK_IN', code: string, conflictFor?: { event: SyncEventInput; hashInput: OfflineEventHashInput; payloadHash: string }): Promise<[SyncEventResult, SyncEventResult]> {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT group_sp');
    if (conflictFor) {
      await recordOfflineConflict(tx, employeeId, deviceInstallationId, requestId, 'CLIENT_EVENT_ID_REUSED', conflictFor.hashInput, conflictFor.payloadHash);
    }
    await createAuditEvent(tx, {
      actorUserId: null,
      eventType: 'SWITCH_SITE_GROUP_FAILED',
      entityType: 'CLOCK_EVENT_GROUP',
      entityId: groupId,
      requestId,
      beforeValue: { failedHalf, failureCode: code },
      afterValue: null
    });
    const outHash = computeOfflinePayloadHash(offlineEventHashInput(employeeId, deviceInstallationId, checkOutEvent));
    const inHash = computeOfflinePayloadHash(offlineEventHashInput(employeeId, deviceInstallationId, checkInEvent));
    await insertRejectedReceipt(tx, deviceInstallationId, employeeId, checkOutEvent, 'SWITCH_SITE_GROUP_FAILED', outHash);
    await insertRejectedReceipt(tx, deviceInstallationId, employeeId, checkInEvent, 'SWITCH_SITE_GROUP_FAILED', inHash);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT group_sp');
    return [
      { clientEventId: checkOutEvent.clientEventId, outcome: 'REJECTED', code: 'SWITCH_SITE_GROUP_FAILED', groupId },
      { clientEventId: checkInEvent.clientEventId, outcome: 'REJECTED', code: 'SWITCH_SITE_GROUP_FAILED', groupId }
    ];
  }

  const preflightOut = await runPreflight(tx, checkOutEvent);
  const preflightIn = await runPreflight(tx, checkInEvent);
  if (preflightOut.terminal || preflightIn.terminal) {
    return groupTerminal(preflightOut.terminal ? 'CHECK_OUT' : 'CHECK_IN', preflightOut.terminal ? preflightOut.code! : preflightIn.code!);
  }

  const outOutcome = await insertAndApplyCheckOut(tx, employeeId, actorUserId, requestId, checkOutEvent, deviceInstallationId, groupId);
  if (!outOutcome.inserted) {
    return groupTerminal('CHECK_OUT', 'CLIENT_EVENT_ID_REUSED', { event: checkOutEvent, hashInput: outOutcome.hashInput, payloadHash: outOutcome.payloadHash });
  }

  const inOutcome = await insertAndApplyCheckIn(tx, employeeId, actorUserId, requestId, checkInEvent, deviceInstallationId, groupId, preflightIn.checkInGps!);
  if (!inOutcome.inserted) {
    return groupTerminal('CHECK_IN', 'CLIENT_EVENT_ID_REUSED', { event: checkInEvent, hashInput: inOutcome.hashInput, payloadHash: inOutcome.payloadHash });
  }

  await insertAcceptedReceipt(tx, deviceInstallationId, employeeId, checkOutEvent, checkOutEvent.clientEventId, outOutcome.payloadHash);
  await insertAcceptedReceipt(tx, deviceInstallationId, employeeId, checkInEvent, checkInEvent.clientEventId, inOutcome.payloadHash);
  await tx.$executeRawUnsafe('RELEASE SAVEPOINT group_sp');

  return [
    { clientEventId: checkOutEvent.clientEventId, outcome: 'ACCEPTED', processingState: outOutcome.result.processingState, exceptionType: outOutcome.result.exceptionType, groupId },
    { clientEventId: checkInEvent.clientEventId, outcome: 'ACCEPTED', processingState: inOutcome.result.processingState, exceptionType: inOutcome.result.exceptionType, groupId }
  ];
}

// ---------------------------------------------------------------------------------------------
// Pass A — §9.11 main WHILE loop, literal translation of the pseudocode's branches.
// ---------------------------------------------------------------------------------------------

function bigintCompare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// BigInt literal syntax (`1n`) requires an ES2020+ target; this project's tsconfig targets
// ES2017, so every increment goes through these two constants instead.
const ONE = BigInt(1);
const TWO = BigInt(2);

async function runPassA(
  tx: Prisma.TransactionClient,
  employeeId: string,
  actorUserId: string,
  requestId: string,
  deviceInstallationId: string,
  newEvents: SyncEventInput[],
  startCurrent: bigint
): Promise<{ results: SyncEventResult[]; newCurrent: bigint }> {
  const results: SyncEventResult[] = [];
  let current = startCurrent;
  let i = 0;

  while (i < newEvents.length) {
    const event = newEvents[i];
    const nextEvent: SyncEventInput | undefined = newEvents[i + 1];

    if (event.deviceSequence !== current + ONE) {
      for (let j = i; j < newEvents.length; j += 1) {
        results.push({ clientEventId: newEvents[j].clientEventId, outcome: 'RETRYABLE', code: 'SEQUENCE_GAP' });
      }
      break;
    }

    if (event.groupId !== null) {
      if (event.operationType !== 'CHECK_OUT') {
        await writeInvalidHalf(tx, employeeId, deviceInstallationId, event);
        await auditInvalidGroup(tx, requestId, event.groupId, [event.deviceSequence]);
        results.push({ clientEventId: event.clientEventId, outcome: 'REJECTED', code: 'SWITCH_SITE_GROUP_INVALID', groupId: event.groupId });
        current += ONE;
        i += 1;
        continue;
      }
      if (!nextEvent) {
        for (let j = i; j < newEvents.length; j += 1) {
          results.push({ clientEventId: newEvents[j].clientEventId, outcome: 'RETRYABLE', code: 'SWITCH_SITE_GROUP_INCOMPLETE', groupId: newEvents[j].groupId ?? undefined });
        }
        break;
      }
      if (nextEvent.groupId === event.groupId) {
        if (nextEvent.deviceSequence === event.deviceSequence + ONE && nextEvent.operationType === 'CHECK_IN') {
          const [outResult, inResult] = await processGroup(tx, employeeId, actorUserId, requestId, deviceInstallationId, event, nextEvent);
          results.push(outResult, inResult);
          current += TWO;
          i += 2;
          continue;
        }
        await writeInvalidHalf(tx, employeeId, deviceInstallationId, event);
        await writeInvalidHalf(tx, employeeId, deviceInstallationId, nextEvent);
        await auditInvalidGroup(tx, requestId, event.groupId, [event.deviceSequence, nextEvent.deviceSequence]);
        results.push({ clientEventId: event.clientEventId, outcome: 'REJECTED', code: 'SWITCH_SITE_GROUP_INVALID', groupId: event.groupId });
        results.push({ clientEventId: nextEvent.clientEventId, outcome: 'REJECTED', code: 'SWITCH_SITE_GROUP_INVALID', groupId: nextEvent.groupId ?? undefined });
        current += TWO;
        i += 2;
        continue;
      }
      if (nextEvent.deviceSequence === event.deviceSequence + ONE) {
        await writeInvalidHalf(tx, employeeId, deviceInstallationId, event);
        await auditInvalidGroup(tx, requestId, event.groupId, [event.deviceSequence]);
        results.push({ clientEventId: event.clientEventId, outcome: 'REJECTED', code: 'SWITCH_SITE_GROUP_INVALID', groupId: event.groupId });
        current += ONE;
        i += 1;
        continue;
      }
      for (let j = i; j < newEvents.length; j += 1) {
        results.push({ clientEventId: newEvents[j].clientEventId, outcome: 'RETRYABLE', code: 'SWITCH_SITE_GROUP_INCOMPLETE', groupId: newEvents[j].groupId ?? undefined });
      }
      break;
    }

    const singleResult = await processSingleEvent(tx, employeeId, actorUserId, requestId, deviceInstallationId, event);
    results.push(singleResult);
    current += ONE;
    i += 1;
  }

  return { results, newCurrent: current };
}

// ---------------------------------------------------------------------------------------------
// Pass B — §9.11 stale/replay resolution. Never advances `current`, never repeats a business
// effect — reads DeviceEventReceipt only.
// ---------------------------------------------------------------------------------------------

async function runPassB(tx: Prisma.TransactionClient, employeeId: string, deviceInstallationId: string, requestId: string, current: bigint, staleEvents: SyncEventInput[]): Promise<SyncEventResult[]> {
  const results: SyncEventResult[] = [];
  for (const event of staleEvents) {
    await tx.$executeRawUnsafe('SAVEPOINT event_sp');
    const hashInput = offlineEventHashInput(employeeId, deviceInstallationId, event);
    const payloadHash = computeOfflinePayloadHash(hashInput);
    const receipt = await tx.deviceEventReceipt.findUnique({ where: { deviceInstallationId_deviceSequence: { deviceInstallationId, deviceSequence: event.deviceSequence } } });

    if (receipt && receipt.payloadHash === payloadHash) {
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT event_sp');
      if (receipt.outcome === 'ACCEPTED') {
        const clockEvent = await tx.clockEvent.findUnique({ where: { id: receipt.clockEventId! }, select: { processingState: true } });
        results.push({ clientEventId: event.clientEventId, outcome: 'DUPLICATE_ACK', processingState: clockEvent?.processingState, groupId: event.groupId ?? undefined });
      } else {
        results.push({ clientEventId: event.clientEventId, outcome: 'REJECTED', code: receipt.rejectionCode!, groupId: event.groupId ?? undefined });
      }
      continue;
    }

    if (receipt && receipt.payloadHash !== payloadHash) {
      await recordOfflineConflict(tx, employeeId, deviceInstallationId, requestId, 'DEVICE_SEQUENCE_REUSED', hashInput, payloadHash);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT event_sp');
      results.push({ clientEventId: event.clientEventId, outcome: 'REJECTED', code: 'DEVICE_SEQUENCE_REUSED' });
      continue;
    }

    // No receipt at all, yet deviceSequence <= current — ledger inconsistency (§9.11, issue 6).
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT event_sp');
    await createAuditEvent(tx, {
      actorUserId: null,
      eventType: 'FIFO_LEDGER_INCONSISTENT',
      entityType: 'WORKER_DEVICE_INSTALLATION',
      entityId: deviceInstallationId,
      requestId,
      beforeValue: { lastProcessedSequence: current.toString(), missingReceiptForSequence: event.deviceSequence.toString() },
      afterValue: null
    });
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT event_sp');
    results.push({ clientEventId: event.clientEventId, outcome: 'RETRYABLE', code: 'FIFO_LEDGER_INCONSISTENT' });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Top-level entry point — bounded retry on 40P01/40001 only (§6 task requirement). Device
// ownership/revocation is checked ONCE per whole request (deviceInstallationId is a request-level
// field, §7 — not per-event), immediately after the canonical Employee -> WorkerDeviceInstallation
// locks, before Pass A/B ever run.
// ---------------------------------------------------------------------------------------------

export async function performSync(employeeId: string, actorUserId: string, requestId: string, deviceInstallationId: string, events: SyncEventInput[]): Promise<SyncPerformResult> {
  for (let attempt = 1; attempt <= MAX_INGESTION_ATTEMPTS; attempt += 1) {
    try {
      const results = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "WorkerDeviceInstallation" WHERE id = ${deviceInstallationId}::uuid FOR UPDATE`;
          const device = await tx.workerDeviceInstallation.findUnique({ where: { id: deviceInstallationId } });
          if (!device || device.employeeId !== employeeId) {
            throw new DeviceNotOwnedSignal();
          }
          if (device.revokedAt !== null) {
            throw new DeviceRevokedSignal();
          }

          const current = device.lastProcessedSequence;
          const newEvents = events.filter((e) => e.deviceSequence > current).sort((a, b) => bigintCompare(a.deviceSequence, b.deviceSequence));
          const staleEvents = events.filter((e) => e.deviceSequence <= current);

          const passA = await runPassA(tx, employeeId, actorUserId, requestId, deviceInstallationId, newEvents, current);
          if (passA.newCurrent !== current) {
            await tx.workerDeviceInstallation.update({ where: { id: deviceInstallationId }, data: { lastProcessedSequence: passA.newCurrent } });
          }
          const passBResults = await runPassB(tx, employeeId, deviceInstallationId, requestId, passA.newCurrent, staleEvents);

          // Preserve caller's original event order in the response, not FIFO processing order.
          const byId = new Map<string, SyncEventResult>();
          for (const r of [...passA.results, ...passBResults]) {
            byId.set(r.clientEventId, r);
          }
          return events.map((e) => byId.get(e.clientEventId)!);
        },
        { timeout: 60000, maxWait: 10000 }
      );
      return { kind: 'OK', results };
    } catch (err) {
      if (err instanceof DeviceNotOwnedSignal) {
        return { kind: 'DEVICE_NOT_OWNED' };
      }
      if (err instanceof DeviceRevokedSignal) {
        return { kind: 'DEVICE_REVOKED' };
      }
      if (isRetryableTransactionError(err)) {
        if (attempt >= MAX_INGESTION_ATTEMPTS) {
          return { kind: 'RETRY_EXHAUSTED' };
        }
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 10);
        continue;
      }
      throw err;
    }
  }
  return { kind: 'RETRY_EXHAUSTED' };
}

// ---------------------------------------------------------------------------------------------
// Device bootstrap / context (§2 task requirement) — GET /api/worker/attendance/context.
// ---------------------------------------------------------------------------------------------

export type DeviceBootstrapOutcome =
  | { kind: 'OK'; installation: { id: string; lastProcessedSequence: bigint } }
  | { kind: 'FORBIDDEN' }
  | { kind: 'REVOKED' };

/**
 * Race-safe single-row creation for a fresh id: attempts INSERT first (createMany+skipDuplicates,
 * same ON CONFLICT DO NOTHING primitive as the sync ingestion path); a losing concurrent racer
 * falls through to the lock-and-inspect branch below and finds the winner's row already there —
 * "конкурентный первый bootstrap одного id должен создать ровно одну строку" (§2 task requirement).
 */
export async function bootstrapDeviceInstallation(employeeId: string, deviceInstallationId: string, platform: string | null, userAgent: string | null): Promise<DeviceBootstrapOutcome> {
  return prisma.$transaction(async (tx) => {
    const created = await tx.workerDeviceInstallation.createMany({
      data: [{ id: deviceInstallationId, employeeId, platform, userAgent, lastSeenAt: new Date() }],
      skipDuplicates: true
    });
    if (created.count === 1) {
      const row = await tx.workerDeviceInstallation.findUniqueOrThrow({ where: { id: deviceInstallationId } });
      return { kind: 'OK', installation: { id: row.id, lastProcessedSequence: row.lastProcessedSequence } };
    }

    await tx.$queryRaw`SELECT id FROM "WorkerDeviceInstallation" WHERE id = ${deviceInstallationId}::uuid FOR UPDATE`;
    const existing = await tx.workerDeviceInstallation.findUniqueOrThrow({ where: { id: deviceInstallationId } });
    if (existing.employeeId !== employeeId) {
      return { kind: 'FORBIDDEN' };
    }
    if (existing.revokedAt !== null) {
      return { kind: 'REVOKED' };
    }
    // §2 task requirement — "upsert не должен сбрасывать lastProcessedSequence": update touches
    // only lastSeenAt/platform/userAgent, never lastProcessedSequence. A client that omits
    // `platform` this call leaves the previously stored value untouched (Prisma `undefined` means
    // "don't touch this column", unlike an explicit `null`).
    const updated = await tx.workerDeviceInstallation.update({
      where: { id: deviceInstallationId },
      data: { lastSeenAt: new Date(), platform: platform ?? undefined, userAgent: userAgent ?? undefined }
    });
    return { kind: 'OK', installation: { id: updated.id, lastProcessedSequence: updated.lastProcessedSequence } };
  });
}

export interface AttendanceContextAssignment {
  id: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  isPrimary: boolean;
  geofence: { geofenceVersionId: string; latitude: string; longitude: string; radiusMeters: number } | null;
  /** R15 fixroad F03 — site is flagged "GPS often unavailable here" (informational; shown to the
   *  worker so a missing coordinate at this site reads as expected, not an error). Additive. */
  siteGpsOftenUnavailable?: boolean;
}

export interface AttendanceContextView {
  serverNow: string;
  deviceInstallationId: string;
  lastProcessedSequence: string;
  assignments: AttendanceContextAssignment[];
  /** docs/titanor-time/T8_PWA_DESIGN.md §F.3 (T8.8) — additive field. The caller's own User.id,
   * always resolved from the session server-side (never from a query/body param) — lets the
   * client confirm/record deviceState.ownerUserId. Not a new permission, discloses nothing the
   * session didn't already establish. */
  userId: string;
}

/** Only the site's CURRENT geofence snapshot — never historical versions (§2 task requirement). */
export async function buildAttendanceContext(employeeId: string, today: Date, deviceInstallationId: string, lastProcessedSequence: bigint, userId: string): Promise<AttendanceContextView> {
  const assignments = await prisma.siteAssignment.findMany({
    // R15-D7 — operationally-live only (clockInDisabledAt-aware), same gate as every consumer.
    where: { employeeId, ...liveAssignmentWhere(new Date(), today) },
    orderBy: [{ isPrimary: 'desc' }, { validFrom: 'asc' }],
    select: {
      id: true,
      siteId: true,
      site: { select: { name: true, gpsOftenUnavailable: true, currentGeofenceVersionId: true, currentGeofenceVersion: { select: { id: true, latitude: true, longitude: true, radiusMeters: true } } } },
      workAreaId: true,
      workArea: { select: { name: true } },
      isPrimary: true
    }
  });

  return {
    serverNow: new Date().toISOString(),
    deviceInstallationId,
    lastProcessedSequence: lastProcessedSequence.toString(),
    userId,
    assignments: assignments.map((a) => ({
      id: a.id,
      siteId: a.siteId,
      siteName: a.site.name,
      workAreaId: a.workAreaId,
      workAreaName: a.workArea?.name ?? null,
      isPrimary: a.isPrimary,
      siteGpsOftenUnavailable: a.site.gpsOftenUnavailable,
      geofence: a.site.currentGeofenceVersion
        ? { geofenceVersionId: a.site.currentGeofenceVersion.id, latitude: a.site.currentGeofenceVersion.latitude.toFixed(6), longitude: a.site.currentGeofenceVersion.longitude.toFixed(6), radiusMeters: a.site.currentGeofenceVersion.radiusMeters }
        : null
    }))
  };
}
